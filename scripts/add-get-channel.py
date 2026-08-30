#!/usr/bin/env python3
"""
Lengkapi pelaporan status wireless uwe5622: .get_channel dan station info
yang lebih kaya.

Setelah .dump_station diimplementasikan (patch 060), halaman Wi-Fi LuCI sudah
terisi, tapi beberapa kolom masih kosong karena driver tidak pernah
melaporkannya:

  Channel: 0 (unknown GHz)   <- .get_channel tidak ada
  signal_avg: 0
  connected_time: 0
  authorized/authenticated: false

Firmware sebenarnya sudah memberi tahu kanal saat asosiasi berhasil
(conn_info->channel), dan cfg80211 memberi chandef lengkap saat AP dinyalakan
(settings->chandef). Keduanya cuma tidak pernah disimpan.

Catatan jujur soal lebar kanal: firmware hanya melaporkan nomor kanal primer,
bukan lebar. Jadi chandef mode station dibuat sebagai 20 MHz NO_HT -- itu
membuat kolom Channel/Frequency benar tanpa mengarang lebar kanal yang tidak
kita ketahui. Mode AP memakai chandef asli dari cfg80211, yang lengkap.

Dijalankan terhadap source armbian/uwe5622 yang sudah dipatch 060.
"""
import sys
from pathlib import Path

ROOT = Path(sys.argv[1] if len(sys.argv) > 1 else ".")


def guard():
    if "sprdwl_cfg80211_get_channel" in (ROOT / "unisocwifi/cfg80211.c").read_text():
        sys.exit("GAGAL: source sudah memuat get_channel")


def edit(rel, old, new, count=1):
    p = ROOT / rel
    s = p.read_text()
    if s.count(old) != count:
        sys.exit(f"GAGAL: anchor di {rel} ditemukan {s.count(old)}x, harusnya {count}x")
    p.write_text(s.replace(old, new, count))
    print(f"  patched  {rel}")


guard()

# ------------------------------------------------------------------ sprdwl.h
edit(
    "unisocwifi/sprdwl.h",
    """	/* stations associated in AP/GO mode, for cfg80211 dump_station */
	spinlock_t sta_lock;""",
    """	/* kanal operasi saat ini, untuk cfg80211 get_channel */
	struct cfg80211_chan_def chandef;
	/* jiffies saat asosiasi berhasil, untuk NL80211_STA_INFO_CONNECTED_TIME */
	unsigned long connect_jiffies;

	/* stations associated in AP/GO mode, for cfg80211 dump_station */
	spinlock_t sta_lock;""",
)

# ----------------------------------------------------------------- cfg80211.c
HELPER = """/* Simpan kanal operasi supaya cfg80211 bisa menanyakannya kembali.
 *
 * Firmware hanya melaporkan nomor kanal primer lewat conn_info->channel; lebar
 * kanal tidak diketahui di sini. chandef dibuat 20 MHz NO_HT: kolom
 * Channel/Frequency jadi benar tanpa mengarang lebar yang tidak kita punya.
 */
static void sprdwl_save_sta_channel(struct sprdwl_vif *vif, u8 chan)
{
	struct ieee80211_channel *ch;
	int freq;

	if (!chan || !vif->priv || !vif->priv->wiphy)
		return;

#if LINUX_VERSION_CODE >= KERNEL_VERSION(4, 7, 0)
	freq = ieee80211_channel_to_frequency(chan,
					      chan <= CH_MAX_2G_CHANNEL ?
					      NL80211_BAND_2GHZ : NL80211_BAND_5GHZ);
#else
	freq = ieee80211_channel_to_frequency(chan,
					      chan <= CH_MAX_2G_CHANNEL ?
					      IEEE80211_BAND_2GHZ : IEEE80211_BAND_5GHZ);
#endif
	ch = ieee80211_get_channel(vif->priv->wiphy, freq);
	if (ch)
		cfg80211_chandef_create(&vif->chandef, ch, NL80211_CHAN_NO_HT);
}

#if LINUX_VERSION_CODE >= KERNEL_VERSION(5, 19, 0)
static int sprdwl_cfg80211_get_channel(struct wiphy *wiphy,
				       struct wireless_dev *wdev,
				       unsigned int link_id,
				       struct cfg80211_chan_def *chandef)
#else
static int sprdwl_cfg80211_get_channel(struct wiphy *wiphy,
				       struct wireless_dev *wdev,
				       struct cfg80211_chan_def *chandef)
#endif
{
	struct sprdwl_vif *vif;

	if (!wdev->netdev)
		return -ENODEV;

	vif = netdev_priv(wdev->netdev);
	if (!vif->chandef.chan)
		return -ENODATA;

	*chandef = vif->chandef;
	return 0;
}

"""

edit(
    "unisocwifi/cfg80211.c",
    """/* Associated station bookkeeping.""",
    HELPER + """/* Associated station bookkeeping.""",
)

# AP: cfg80211 memberi chandef lengkap, pakai apa adanya
edit(
    "unisocwifi/cfg80211.c",
    """	struct cfg80211_beacon_data *beacon = &settings->beacon;""",
    """	struct cfg80211_beacon_data *beacon = &settings->beacon;

	/* cfg80211 tahu lebar kanal untuk mode AP, jadi simpan chandef aslinya */
	vif->chandef = settings->chandef;""",
)

# Station: simpan kanal + waktu asosiasi saat connect berhasil
edit(
    "unisocwifi/cfg80211.c",
    """	vif->sm_state = SPRDWL_CONNECTED;
	memcpy(vif->bssid, conn_info->bssid, sizeof(vif->bssid));""",
    """	vif->sm_state = SPRDWL_CONNECTED;
	memcpy(vif->bssid, conn_info->bssid, sizeof(vif->bssid));
	sprdwl_save_sta_channel(vif, conn_info->channel);
	vif->connect_jiffies = jiffies;""",
)

# Isi kolom yang selama ini nol di station info (varian kernel 4.4.83+)
edit(
    "unisocwifi/cfg80211.c",
    """	sinfo->signal = sta.signal;
	sinfo->filled |= BIT(NL80211_STA_INFO_SIGNAL);

	sinfo->tx_failed = sta.txfailed;
	sinfo->filled |= BIT(NL80211_STA_INFO_TX_BITRATE) |
		BIT(NL80211_STA_INFO_TX_FAILED);""",
    """	sinfo->signal = sta.signal;
	sinfo->filled |= BIT(NL80211_STA_INFO_SIGNAL);

	/* Firmware tidak memberi nilai rata-rata terpisah; laporkan pembacaan
	 * terakhir supaya kolom signal_avg tidak tampil sebagai 0.
	 */
	sinfo->signal_avg = sta.signal;
	sinfo->filled |= BIT(NL80211_STA_INFO_SIGNAL_AVG);

	if (vif->connect_jiffies) {
		sinfo->connected_time =
			(u32)((jiffies - vif->connect_jiffies) / HZ);
		sinfo->filled |= BIT(NL80211_STA_INFO_CONNECTED_TIME);
	}

	/* Peer yang terlihat di sini sudah lewat asosiasi dan 4-way handshake:
	 * tanpa ini LuCI menampilkannya sebagai belum terautentikasi.
	 */
	sinfo->sta_flags.mask = BIT(NL80211_STA_FLAG_AUTHENTICATED) |
				BIT(NL80211_STA_FLAG_AUTHORIZED);
	sinfo->sta_flags.set = sinfo->sta_flags.mask;
	sinfo->filled |= BIT(NL80211_STA_INFO_STA_FLAGS);

	sinfo->tx_failed = sta.txfailed;
	sinfo->filled |= BIT(NL80211_STA_INFO_TX_BITRATE) |
		BIT(NL80211_STA_INFO_TX_FAILED);""",
    count=2,
)

edit(
    "unisocwifi/cfg80211.c",
    """	.get_station = sprdwl_cfg80211_get_station,
	.dump_station = sprdwl_cfg80211_dump_station,""",
    """	.get_station = sprdwl_cfg80211_get_station,
	.dump_station = sprdwl_cfg80211_dump_station,
	.get_channel = sprdwl_cfg80211_get_channel,""",
)

print("selesai.")
