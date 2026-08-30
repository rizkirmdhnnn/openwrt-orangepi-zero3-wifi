#!/bin/bash
# Tulis image OpenWrt ke kartu microSD di macOS, dengan pengaman.
#
#   ./flash-sdcard.sh disk4                      # pakai image final bawaan
#   ./flash-sdcard.sh disk4 /path/image.img.gz   # image lain
#   ./flash-sdcard.sh disk4 --zero               # nol-kan 2100 MB lebih dulu
#
# Kenapa skrip ini ada, bukan sekadar dd:
#
#   1. `gunzip -c | dd` GAGAL DIAM-DIAM di macOS. Image OpenWrt tidak
#      berakhir di batas sektor (contoh: 51.082.050 byte, sisa 322), dan
#      /dev/rdisk menolak blok terakhir yang tidak utuh dengan "Invalid
#      argument" — setelah sebagian besar data terlanjur tertulis. Rootfs
#      jadi terpotong tanpa tanda yang jelas. Skrip ini mengekstrak ke
#      berkas dulu lalu memakai conv=sync (padding nol, jatuh di area
#      overlay yang toh diformat ulang saat boot pertama).
#
#   2. Menolak menulis ke disk internal atau non-removable.
#
#   3. Memverifikasi hasil tulis dengan membaca balik — hal yang dilakukan
#      balenaEtcher tapi tidak dilakukan dd.
set -euo pipefail

DEFAULT_IMG="$HOME/opizero3-image/final/openwrt-v25.12.5-opizero3-wifi/openwrt-sunxi-cortexa53-xunlong_orangepi-zero3-squashfs-sdcard.img.gz"
ZERO_MB=2100

die() { printf '\n\033[31mGAGAL:\033[0m %s\n' "$*" >&2; exit 1; }
info() { printf '\033[36m==>\033[0m %s\n' "$*"; }
ok()   { printf '    \033[32mOK\033[0m  %s\n' "$*"; }

DISK=""; IMG="$DEFAULT_IMG"; DO_ZERO=0; VERIFY_ONLY=0
for a in "$@"; do
	case "$a" in
		--zero) DO_ZERO=1 ;;
		--verify-only) VERIFY_ONLY=1 ;;
		-h|--help) sed -n '2,8p' "$0" | sed 's/^# \?//'; exit 0 ;;
		disk*|/dev/disk*) DISK="${a#/dev/}" ;;
		*) IMG="$a" ;;
	esac
done
[ -n "$DISK" ] || die "sebutkan disk tujuan, mis. $0 disk4  (cek dengan: diskutil list external)"
[ -f "$IMG" ] || die "image tidak ditemukan: $IMG"

# ---------------------------------------------------------------- pengaman
info "Memeriksa /dev/$DISK"
INFO=$(diskutil info "$DISK" 2>/dev/null) || die "/dev/$DISK tidak ada"

grep -q "Whole: *Yes"            <<<"$INFO" || die "/dev/$DISK bukan disk utuh (jangan tunjuk partisi seperti disk4s1)"
grep -q "Removable Media: *Removable" <<<"$INFO" || die "/dev/$DISK bukan media removable — MENOLAK menulis"
grep -qE "Device Location: *External|Internal: *No" <<<"$INFO" || die "/dev/$DISK bukan disk eksternal — MENOLAK menulis"
grep -q "Media Read-Only: *No"   <<<"$INFO" || die "/dev/$DISK read-only"

SIZE=$(sed -n 's/.*Disk Size: *\([0-9.]* [KMGT]B\).*/\1/p' <<<"$INFO" | head -1)
ok "disk eksternal removable, ukuran $SIZE"

# ------------------------------------------------------- konfirmasi manusia
if [ "$VERIFY_ONLY" = 1 ]; then
	info "Mode verifikasi saja — kartu tidak ditulis"
else
echo
printf '\033[33mSELURUH ISI /dev/%s AKAN DIHAPUS.\033[0m Isinya sekarang:\n\n' "$DISK"
diskutil list "$DISK" | sed 's/^/    /'
echo
printf '    image  : %s\n' "$(basename "$IMG")"
[ "$DO_ZERO" = 1 ] && printf '    nol-kan: %s MB lebih dulu\n' "$ZERO_MB"
echo
read -r -p 'Ketik FLASH untuk melanjutkan: ' CONFIRM
[ "$CONFIRM" = "FLASH" ] || die "dibatalkan"
fi

# ------------------------------------------------------------------- siapkan
TMP=""
case "$IMG" in
	*.gz)
		TMP="${TMPDIR:-/tmp}/flash-$$.img"
		info "Mengekstrak image (conv=sync butuh berkas, bukan pipe)"
		gunzip -c "$IMG" > "$TMP"
		RAW="$TMP" ;;
	*) RAW="$IMG" ;;
esac
trap '[ -n "$TMP" ] && rm -f "$TMP"' EXIT

BYTES=$(stat -f%z "$RAW")
SHA=$(shasum -a 256 "$RAW" | cut -d' ' -f1)
ok "image $BYTES byte, sha256 ${SHA:0:16}…"

info "Melepas mount"
diskutil unmountDisk "/dev/$DISK" >/dev/null || die "gagal unmount"

# --------------------------------------------------------------------- tulis
if [ "$VERIFY_ONLY" = 1 ]; then
	:
else
if [ "$DO_ZERO" = 1 ]; then
	info "Menol-kan $ZERO_MB MB (menghapus sisa filesystem lama)"
	sudo dd if=/dev/zero "of=/dev/r$DISK" bs=4m count=$((ZERO_MB / 4)) 2>&1 | tail -1 | sed 's/^/    /'
fi

info "Menulis image"
sudo dd "if=$RAW" "of=/dev/r$DISK" bs=4m conv=sync 2>&1 | tail -1 | sed 's/^/    /'
sync
fi

# ------------------------------------------------------------------ verifikasi
info "Verifikasi baca-ulang"
BLOCKS=$(( (BYTES + 4194303) / 4194304 ))
# Lewat berkas sementara, bukan pipe: `dd | head -c` membuat dd kena SIGPIPE
# saat head berhenti membaca, dan pipefail menerjemahkannya sebagai kegagalan
# sehingga skrip mati tanpa pesan — padahal tulisannya sendiri baik-baik saja.
RB="${TMPDIR:-/tmp}/verify-$$.bin"
sudo dd "if=/dev/r$DISK" bs=4m count="$BLOCKS" of="$RB" 2>/dev/null
READBACK=$(head -c "$BYTES" "$RB" | shasum -a 256 | cut -d' ' -f1)
rm -f "$RB"
if [ "$READBACK" = "$SHA" ]; then
	ok "sha256 cocok — tulisan utuh bit-per-bit"
else
	die "sha256 BEDA (kartu: ${READBACK:0:16}… vs image: ${SHA:0:16}…) — jangan dipakai, ulangi"
fi

info "Eject"
sudo diskutil eject "/dev/$DISK" >/dev/null && ok "kartu aman dicabut"

cat <<'SELESAI'

Selesai. Langkah berikutnya:

  1. Pasang kartu ke Orange Pi Zero 3
  2. Colok ethernet ke port trunk switch (Port 8), beri daya
  3. Tunggu 2-3 menit, LED merah harus menyala
  4. ping 192.168.8.1
  5. Kalau gagal: sh scripts/collect-debug.sh
SELESAI
