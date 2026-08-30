# OpenWrt + Wi-Fi untuk Orange Pi Zero 3

OpenWrt mendukung Orange Pi Zero 3 (`sunxi/cortexa53`) sejak 24.10, tapi
**tanpa Wi-Fi**. Repo ini menambahkan driver Unisoc UWE5622 (modul AW859A),
firmware-nya, patch device tree yang mengaktifkan `mmc1`, dan implementasi
`.dump_station` yang membuat halaman Wi-Fi LuCI akhirnya terisi.

Isu resmi [openwrt#18494](https://github.com/openwrt/openwrt/issues/18494)
ditutup `not planned`.

## Kenapa Wi-Fi tidak ada di image resmi

- **Driver di luar mainline.** `sprdwl_ng` dan `uwe5622_bsp_sdio` adalah driver
  vendor *out-of-tree*, tidak pernah ikut terbawa OpenWrt.
- **Device tree tidak lengkap.** `sun50i-h616-orangepi-zero.dtsi` mainline
  tidak punya `&mmc1`, regulator Wi-Fi, maupun `mmc-pwrseq`. Tanpa itu chip
  tidak pernah di-probe meski drivernya terpasang.

## Perbaikan `.dump_station`

`iwinfo` mengisi halaman Wi-Fi LuCI hanya lewat `NL80211_CMD_GET_STATION +
NLM_F_DUMP`. Kernel melayaninya dengan `.dump_station`, yang tidak
diimplementasikan uwe5622 — hanya ada `.get_station`. Satu callback hilang,
dua gejala: daftar client kosong di mode AP, signal dan bitrate kosong di mode
client.

Patch `060` menyediakannya, memakai MAC peer yang sudah diterima
`sprdwl_report_softap()`.

**Batasnya jujur:** `sprdwl_cfg80211_get_station()` mengabaikan MAC yang
diminta dan mengembalikan penghitung tingkat interface. Di mode AP daftar
client muncul tetapi signal per client belum akurat. Di mode client angkanya
benar karena hanya ada satu peer.

## Isi repo

**Patch driver** — `package/kernel/uwe5622/patches/`

| Patch | Asal | Isi |
|---|---|---|
| `010`–`030` | [immortalwrt#2457](https://github.com/immortalwrt/immortalwrt/pull/2457) | API backports, simbol kbuild, recursive netdev lock |
| `040` | [armbian#17](https://github.com/armbian/uwe5622/pull/17) | `sm_state` nyangkut setelah 802.11v BSS transition |
| `050` | [armbian#18](https://github.com/armbian/uwe5622/pull/18) | Power save membuang multicast, mDNS mati |
| `060` | repo ini | **Implementasi `.dump_station`** |
| `070`, `080` | repo ini | Hapus VLA (`-Werror=vla`) dan prototipe `set_wiphy_params` |
| `090` | repo ini | `.get_channel` dan detail station |

Source driver dari [`armbian/uwe5622`](https://github.com/armbian/uwe5622),
commit dipin di `package/kernel/uwe5622/Makefile`.

**Patch target** — `target/linux/sunxi/`: regulator 3.3V/1.8V, `mmc-pwrseq`
(reset PG18, clock 32k dari RTC), `&mmc1` sebagai SDIO 4-bit non-removable.
Berasal dari Armbian (Gunjan Gupta).

## Membangun

Lewat tab **Actions**.

| Workflow | Hasil | Lama |
|---|---|---|
| `build-packages.yml` | `.apk` driver saja | ±10 menit |
| `build-image.yml` | image siap tulis ke microSD | ±1–1,5 jam |

Untuk sekadar mengubah patch driver, pakai yang pertama.

## Konfigurasi bawaan image

Board hanya punya satu port ethernet, dan chipnya tidak bisa jadi client dan
AP sekaligus. Image ini karena itu memakai ethernet sebagai **WAN** — colok ke
router yang ada, Wi-Fi menyalurkan jaringannya.

| | |
|---|---|
| Ethernet | WAN (DHCP client) |
| Wi-Fi | AP, SSID `Opizwrt`, 2,4 GHz |
| LAN | `192.168.8.1/24`, DHCP `.100`–`.249` |

`192.168.8.1`, bukan `192.168.1.1` bawaan OpenWrt: perangkat ini hampir selalu
berada di belakang router yang memakai alamat itu, dan subnet kembar membuat
perutean bertabrakan sejak boot pertama.

Terpasang: LuCI (tema [opizwrt](https://github.com/rizkirmdhnnn/luci-theme-opizwrt)),
AdGuard Home, Tailscale, ttyd, vnstat, nlbwmon, PBR, watchcat.

### Kredensial bawaan — ganti semuanya

| Layanan | Alamat | Masuk |
|---|---|---|
| Wi-Fi | SSID `Opizwrt` | `opizwrt123` |
| LuCI | `http://192.168.8.1` | `root` / *(kosong)* |
| AdGuard | `:3000` | `admin` / `password` |
| ttyd | `:7681` | `root` / `opizwrt` |

Semuanya diketahui siapa pun yang membaca repo ini.

Wi-Fi sengaja menyala dengan kunci alih-alih dimatikan: ethernet dipakai WAN
dan papan tidak punya layar, jadi radio yang mati berarti tidak ada jalan
masuk setelah flash.

AdGuard dikirim dengan akun lemah alih-alih tanpa akun — wizard pemasangannya
tertutup begitu konfigurasi terisi, jadi tanpa akun bawaan panelnya berjalan
terbuka sampai disunting lewat SSH. Ganti di **Settings → General**.

CI memverifikasi ini: setiap nilai rahasia di `files/` harus persis sama
dengan tabel di atas, sehingga kunci sungguhan yang tidak sengaja tersalin
menggagalkan build.

## Batas yang tidak bisa diperbaiki

**Client dan AP bersamaan tidak mungkin.** Firmware melaporkan
`fw_capa:0x120f7f` — bit 25 (`SPRDWL_CAPA_AP_STA`) mati. Kernel setuju:
`#{ managed, AP } <= 1`. Board ini punya satu radio dua band, bukan dua radio,
jadi memisah 2,4 dan 5 GHz tidak membantu. Perlu dongle USB.

**`Tx-Power` selalu 0 dBm.** Bit 28 (`SPRDWL_CAPA_TX_POWER`) juga mati.

**Mode AP: maksimum 10 klien**, antena 1×1 (2,4 GHz HT20 mentok ~72 Mbps).

**Mode AP belum diuji di perangkat nyata.** Chip melaporkan dukungannya dan
`hostapd` terpasang, tetapi papan rujukan proyek ini dipakai sebagai client.
Laporkan lewat issue bila bermasalah.

## Setelah flash

```sh
iw dev wlan0 station dump    # HARUS ada isinya — inti perbaikan .dump_station
iwinfo wlan0 info            # Signal dan Bit Rate harus terbaca
```

**Kalau internet mati:** dnsmasq meneruskan seluruh DNS ke AdGuard tanpa
upstream cadangan, jadi AdGuard yang gagal start berarti tidak ada resolusi
nama sama sekali.

```sh
/etc/init.d/adguardhome status
uci del dhcp.@dnsmasq[0].noresolv && uci commit && /etc/init.d/dnsmasq restart
```

Perintah kedua mengembalikan DNS dari WAN — internet hidup, penyaringan
berhenti sampai AdGuard diperbaiki.

## Lisensi

GPL-2.0, mengikuti driver dan OpenWrt di hulu. Firmware Unisoc tidak
disertakan; paket firmware mengunduhnya dari
[`armbian/firmware`](https://github.com/armbian/firmware) saat build.
