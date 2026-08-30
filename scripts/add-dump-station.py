#!/usr/bin/env python3
"""
Tambahkan callback .dump_station ke driver uwe5622.

Tanpa callback ini, NL80211_CMD_GET_STATION + NLM_F_DUMP tidak mengembalikan
apa pun. Itulah satu-satunya sumber data yang dipakai iwinfo untuk mengisi
halaman WiFi LuCI (nl80211_get_assoclist dan nl80211_fill_signal), sehingga
baik client yang terhubung ke AP maupun AP yang kita ikuti sebagai station
sama sekali tidak tampil.

Driver sebenarnya sudah tahu peserta asosiasinya: sprdwl_report_softap()
menerima MAC setiap kali ada yang join/leave. Yang kurang hanya menyimpannya
dan menyediakan jalan bagi cfg80211 untuk membacanya.

Dijalankan terhadap source armbian/uwe5622 yang bersih.
"""
import sys
from pathlib import Path

ROOT = Path(sys.argv[1] if len(sys.argv) > 1 else ".")


def guard_not_patched():
    """Berhenti kalau source sudah pernah dipatch, supaya tidak menumpuk."""
    for rel, marker in (
        ("unisocwifi/sprdwl.h", "SPRDWL_MAX_ASSOC_STA"),
        ("unisocwifi/cfg80211.c", "sprdwl_cfg80211_dump_station"),
        ("unisocwifi/main.c", "spin_lock_init(&vif->sta_lock)"),
    ):
        if marker in (ROOT / rel).read_text():
            sys.exit(f"GAGAL: {rel} sudah memuat '{marker}' - source sudah dipatch")


def edit(relpath, old, new, count=1):
    p = ROOT / relpath
    text = p.read_text()
    if text.count(old) != count:
        sys.exit(
            f"GAGAL: anchor di {relpath} ditemukan {text.count(old)}x, harusnya {count}x"
        )
    p.write_text(text.replace(old, new, count))
    print(f"  patched  {relpath}")


guard_not_patched()

# ---------------------------------------------------------------- sprdwl.h
edit(
    "unisocwifi/sprdwl.h",
    """struct sprdwl_vif {
	struct net_device *ndev;	/* Linux net device */""",
    """/* Jumlah station yang dilacak untuk keperluan dump_station. Firmware
 * membatasi tabel station-nya jauh di bawah angka ini.
 */
#define SPRDWL_MAX_ASSOC_STA	16

struct sprdwl_vif {
	struct net_device *ndev;	/* Linux net device */""",
)

edit(
    "unisocwifi/sprdwl.h",
    """	bool has_rand_mac;
	u8 random_mac[ETH_ALEN];
};""",
    """	bool has_rand_mac;
	u8 random_mac[ETH_ALEN];

	/* stations associated in AP/GO mode, for cfg80211 dump_station */
	spinlock_t sta_lock;
	u8 sta_num;
	u8 sta_addr[SPRDWL_MAX_ASSOC_STA][ETH_ALEN];
};""",
)

# ----------------------------------------------------------------- main.c
edit(
    "unisocwifi/main.c",
    """	vif->priv = priv;
	vif->sm_state = SPRDWL_DISCONNECTED;""",
    """	vif->priv = priv;
	vif->sm_state = SPRDWL_DISCONNECTED;
	spin_lock_init(&vif->sta_lock);
	vif->sta_num = 0;""",
)

# ------------------------------------------------------------- cfg80211.c
HELPERS = """/* Associated station bookkeeping.
 *
 * The firmware announces every join and leave through sprdwl_report_softap(),
 * which is the only place that sees the peer MAC address. Record them here so
 * that cfg80211 can enumerate the stations through dump_station.
 */
static void sprdwl_add_assoc_sta(struct sprdwl_vif *vif, const u8 *addr)
{
	unsigned long flags;
	int i;

	spin_lock_irqsave(&vif->sta_lock, flags);
	for (i = 0; i < vif->sta_num; i++)
		if (ether_addr_equal(vif->sta_addr[i], addr))
			goto out;

	if (vif->sta_num < SPRDWL_MAX_ASSOC_STA) {
		ether_addr_copy(vif->sta_addr[vif->sta_num], addr);
		vif->sta_num++;
	}
out:
	spin_unlock_irqrestore(&vif->sta_lock, flags);
}

static void sprdwl_del_assoc_sta(struct sprdwl_vif *vif, const u8 *addr)
{
	unsigned long flags;
	int i;

	spin_lock_irqsave(&vif->sta_lock, flags);
	for (i = 0; i < vif->sta_num; i++) {
		if (!ether_addr_equal(vif->sta_addr[i], addr))
			continue;
		/* keep the array dense: move the last entry into the hole */
		vif->sta_num--;
		if (i != vif->sta_num)
			ether_addr_copy(vif->sta_addr[i],
					vif->sta_addr[vif->sta_num]);
		break;
	}
	spin_unlock_irqrestore(&vif->sta_lock, flags);
}

static void sprdwl_clear_assoc_sta(struct sprdwl_vif *vif)
{
	unsigned long flags;

	spin_lock_irqsave(&vif->sta_lock, flags);
	vif->sta_num = 0;
	spin_unlock_irqrestore(&vif->sta_lock, flags);
}

/* Resolve the peer MAC address for dump index @idx.
 *
 * In AP and GO mode this walks the associated stations. In managed mode the
 * only peer cfg80211 knows about is the AP the interface is connected to, so
 * index 0 reports the current BSSID and there is nothing beyond it.
 */
static int sprdwl_dump_station_addr(struct sprdwl_vif *vif, int idx, u8 *mac)
{
	unsigned long flags;
	int ret = -ENOENT;

	if (vif->mode == SPRDWL_MODE_AP || vif->mode == SPRDWL_MODE_P2P_GO) {
		spin_lock_irqsave(&vif->sta_lock, flags);
		if (idx < vif->sta_num) {
			ether_addr_copy(mac, vif->sta_addr[idx]);
			ret = 0;
		}
		spin_unlock_irqrestore(&vif->sta_lock, flags);
	} else if (!idx && vif->sm_state == SPRDWL_CONNECTED &&
		   !is_zero_ether_addr(vif->bssid)) {
		ether_addr_copy(mac, vif->bssid);
		ret = 0;
	}

	return ret;
}

"""

edit(
    "unisocwifi/cfg80211.c",
    """#if (LINUX_VERSION_CODE >= KERNEL_VERSION(5,19, 2))
static int sprdwl_cfg80211_stop_ap(struct wiphy *wiphy, struct net_device *ndev, unsigned int link_id)""",
    HELPERS
    + """#if (LINUX_VERSION_CODE >= KERNEL_VERSION(5,19, 2))
static int sprdwl_cfg80211_stop_ap(struct wiphy *wiphy, struct net_device *ndev, unsigned int link_id)""",
)

edit(
    "unisocwifi/cfg80211.c",
    """{
#ifdef DFS_MASTER
	struct sprdwl_vif *vif = netdev_priv(ndev);
#endif
	wl_ndev_log(L_DBG, ndev, "%s\\n", __func__);
#ifdef DFS_MASTER
	sprdwl_abort_cac(vif);
#endif

	netif_carrier_off(ndev);
	return 0;
}""",
    """{
	struct sprdwl_vif *vif = netdev_priv(ndev);

	wl_ndev_log(L_DBG, ndev, "%s\\n", __func__);
#ifdef DFS_MASTER
	sprdwl_abort_cac(vif);
#endif
	sprdwl_clear_assoc_sta(vif);

	netif_carrier_off(ndev);
	return 0;
}""",
)

DUMP_STATION = """#if LINUX_VERSION_CODE >= KERNEL_VERSION(7, 1, 0)
static int sprdwl_cfg80211_dump_station(struct wiphy *wiphy,
					struct wireless_dev *wdev, int idx,
					u8 *mac, struct station_info *sinfo)
{
	struct sprdwl_vif *vif = netdev_priv(wdev->netdev);
	int ret;

	ret = sprdwl_dump_station_addr(vif, idx, mac);
	if (ret)
		return ret;

	return sprdwl_cfg80211_get_station(wiphy, wdev, mac, sinfo);
}
#else
static int sprdwl_cfg80211_dump_station(struct wiphy *wiphy,
					struct net_device *ndev, int idx,
					u8 *mac, struct station_info *sinfo)
{
	struct sprdwl_vif *vif = netdev_priv(ndev);
	int ret;

	ret = sprdwl_dump_station_addr(vif, idx, mac);
	if (ret)
		return ret;

	return sprdwl_cfg80211_get_station(wiphy, ndev, mac, sinfo);
}
#endif

"""

edit(
    "unisocwifi/cfg80211.c",
    """void sprdwl_report_softap(struct sprdwl_vif *vif, u8 is_connect, u8 *addr,""",
    DUMP_STATION
    + """void sprdwl_report_softap(struct sprdwl_vif *vif, u8 is_connect, u8 *addr,""",
)

edit(
    "unisocwifi/cfg80211.c",
    """	if (is_connect) {
		if (!netif_carrier_ok(vif->ndev)) {""",
    """	if (is_connect) {
		sprdwl_add_assoc_sta(vif, addr);
		if (!netif_carrier_ok(vif->ndev)) {""",
)

edit(
    "unisocwifi/cfg80211.c",
    """	} else {
#if LINUX_VERSION_CODE >= KERNEL_VERSION(7, 1, 0)
		cfg80211_del_sta(&vif->wdev, addr, GFP_KERNEL);""",
    """	} else {
		sprdwl_del_assoc_sta(vif, addr);
#if LINUX_VERSION_CODE >= KERNEL_VERSION(7, 1, 0)
		cfg80211_del_sta(&vif->wdev, addr, GFP_KERNEL);""",
)

edit(
    "unisocwifi/cfg80211.c",
    """	.get_station = sprdwl_cfg80211_get_station,""",
    """	.get_station = sprdwl_cfg80211_get_station,
	.dump_station = sprdwl_cfg80211_dump_station,""",
)

print("selesai.")
