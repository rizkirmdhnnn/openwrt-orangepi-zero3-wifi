'use strict';
'require view';
'require ui';
'require fs';

/* Dashboard AdGuard Home di dalam LuCI.
 *
 * AdGuard menyajikan UI-nya sendiri di port terpisah, dan tidak mengirim
 * X-Frame-Options maupun Content-Security-Policy -- diperiksa langsung pada
 * responsnya -- sehingga boleh disematkan. Yang ditampilkan di sini adalah
 * dashboard aslinya, bukan tiruan: statistik, daftar kueri, dan pengaturan
 * AdGuard berubah mengikuti versinya, dan menulis ulang tampilannya berarti
 * berjanji mengejar setiap perubahan itu.
 *
 * Alamatnya dibaca dari konfigurasi AdGuard, bukan dari host yang sedang
 * dibuka.
 *
 * Versi pertama memakai window.location.hostname, dengan alasan router ini
 * punya banyak alamat dan memaku salah satunya akan menyesatkan. Alasannya
 * benar, kesimpulannya salah: yang menentukan bukan alamat mana yang dipakai
 * pengunjung, melainkan alamat mana yang DIDENGARKAN AdGuard -- dan ia hanya
 * mengikat satu.
 *
 * Kombinasinya berakibat nyata bila dnsmasq memakai localise_queries:
 * nama host dijawab dengan alamat router pada subnet penanya, sehingga
 * klien di subnet berbeda mendapat alamat berbeda -- dan hanya satu di
 * antaranya yang kebetulan cocok dengan ikatan AdGuard.
 *
 * Menunjuk alamat ikatannya aman lintas VLAN: zona firewall 'lan' mencakup
 * lan, mgmt, dan server dengan input ACCEPT, jadi klien dari ketiganya bisa
 * menjangkaunya selama zona firewall mengizinkan.
 */

var BERKAS_KONFIG = '/etc/adguardhome/adguardhome.yaml';
var PORT_BAWAAN = 3000;

/* Mengembalikan URL dashboard dari isi yaml AdGuard.
 *
 * Bila ikatannya 0.0.0.0 atau [::] -- AdGuard mendengarkan di semua alamat --
 * host yang sedang dibuka justru pilihan yang benar, karena pasti terjangkau
 * oleh pengunjung. Hanya ikatan ke satu alamat tertentu yang perlu ditunjuk
 * secara eksplisit. */
function urlDariKonfig(isi) {
	var m = (isi || '').match(/^\s{2}address:\s*(\S+)\s*$/m);
	var host = null, port = PORT_BAWAAN;

	if (m) {
		var v = m[1].trim();
		var mv = v.match(/^\[?([^\]]*?)\]?:(\d+)$/);
		if (mv) { host = mv[1]; port = mv[2]; }
	}

	if (!host || host === '0.0.0.0' || host === '::' || host === '')
		host = window.location.hostname;

	return window.location.protocol + '//' + host + ':' + port + '/';
}

/* Gaya dititipkan di sini, bukan di cascade.css, supaya fitur ini utuh dalam
   satu berkas dan tema -- yang repo-nya terpisah dan dipakai orang lain --
   tidak perlu ikut memuat aturan bagi halaman yang hanya ada di image ini.
   Token var() dipakai bila temanya menyediakan, dengan nilai cadangan supaya
   tetap tampil wajar pada tema LuCI mana pun. */
var GAYA = '' +
	'.opz-embed { display: flex; flex-direction: column; gap: .625rem; }' +
	'.opz-embed-bar { display: flex; flex-wrap: wrap; align-items: center;' +
	'  justify-content: space-between; gap: .5rem; }' +
	'.opz-embed-note { font-size: .8125rem; color: var(--text-3, #6b7280); }' +
	'.opz-embed-frame {' +
	/* Tinggi dihitung dari tinggi layar, bukan dipaku dalam piksel: dashboard
	   AdGuard punya isi yang panjang, dan bingkai pendek memaksa dua batang
	   gulir bersarang -- yang paling melelahkan justru di ponsel. */
	'  width: 100%; height: calc(100vh - 15rem); min-height: 30rem;' +
	'  border: 1px solid var(--line, #d8dbe0);' +
	'  border-radius: var(--r-md, 9px);' +
	'  background: var(--surface-solid, #fff);' +
	'  display: block;' +
	'}' +
	'@media (max-width: 768px) {' +
	/* Di ponsel bilah tab bawah menutupi sebagian layar, jadi bingkainya
	   dipendekkan seukuran itu agar tepi bawahnya tidak tersembunyi. */
	'  .opz-embed-frame { height: calc(100vh - 17rem); min-height: 24rem; }' +
	'}';

function pasangGaya() {
	if (document.getElementById('opz-embed-style'))
		return;
	document.head.appendChild(
		E('style', { 'id': 'opz-embed-style', 'type': 'text/css' }, [ GAYA ]));
}

return view.extend({
	/* Halaman ini tidak menyunting apa pun; tanpa ini LuCI menampilkan
	   Save/Apply yang tidak punya kegunaan di sini. */
	handleSave: null,
	handleSaveApply: null,
	handleReset: null,

	/* Berkasnya dibaca di sini, bukan di render(), supaya LuCI sudah memegang
	   isinya saat halaman digambar -- tanpa kedipan bingkai yang sempat
	   menunjuk alamat keliru lalu diperbaiki. Gagal baca bukan alasan
	   menggagalkan halaman: urlDariKonfig() jatuh ke host yang sedang dibuka,
	   yang tetap benar bila AdGuard mengikat semua alamat. */
	load: function() {
		return fs.read(BERKAS_KONFIG).catch(function() { return ''; });
	},

	render: function(isiKonfig) {
		pasangGaya();

		var url = urlDariKonfig(isiKonfig);

		var bingkai = E('iframe', {
			'id': 'opz-adguard-frame',
			'src': url,
			'class': 'opz-embed-frame',
			'title': _('AdGuard Home'),
			/* Dibiarkan tanpa sandbox: AdGuard butuh skrip, formulir, dan
			   penyimpanan miliknya sendiri untuk berfungsi, dan ia berjalan
			   di perangkat ini juga -- bukan pihak ketiga. */
			'referrerpolicy': 'no-referrer'
		});

		/* Bila AdGuard tidak terjangkau dari alamat yang sedang dipakai,
		   iframe akan diam saja tanpa pesan apa pun. Pemberitahuan ini
		   disiapkan lebih dulu dan baru ditampilkan bila pemeriksaan gagal,
		   supaya halaman tidak pernah tampak sekadar kosong. */
		var pesan = E('div', { 'class': 'alert-message warning', 'style': 'display:none' }, [
			E('h4', {}, [ _('AdGuard Home tidak terjangkau') ]),
			E('p', {}, [
				_('Tidak ada jawaban dari'), ' ', E('strong', {}, [ url ]), '. ',
				_('AdGuard hanya mendengarkan pada alamat yang disetel di berkas konfigurasinya. Bila Anda membuka LuCI lewat alamat lain, buka dashboard-nya langsung:')
			]),
			E('p', {}, [ E('a', { 'href': url, 'target': '_blank', 'rel': 'noopener' }, [ url ]) ])
		]);

		var kepala = E('div', { 'class': 'opz-embed-bar' }, [
			E('span', { 'class': 'opz-embed-note' }, [ _('Dashboard AdGuard Home') ]),
			E('a', {
				'class': 'btn',
				'href': url,
				'target': '_blank',
				'rel': 'noopener'
			}, [ _('Buka di tab baru') ])
		]);

		var wadah = E('div', { 'class': 'opz-embed' }, [ kepala, pesan, bingkai ]);

		/* Pemeriksaan keterjangkauan, dengan mode 'no-cors' -- dan itu wajib,
		   bukan pilihan.
		 *
		 * LuCI dilayani di port 80 sementara AdGuard di port 3000. Port yang
		 * berbeda berarti origin yang berbeda, dan AdGuard tidak mengirim
		 * header CORS satu pun. Permintaan biasa karena itu SELALU ditolak
		 * peramban, hidup atau matinya AdGuard, sehingga pemeriksaannya hanya
		 * akan menghasilkan galat palsu setiap kali.
		 *
		 * Dengan 'no-cors' jawabannya menjadi buram -- isinya tidak bisa
		 * dibaca, dan itu tidak masalah: yang ditanyakan di sini hanya apakah
		 * sambungannya sampai. Yang gagal menyambung tetap ditolak, dan hanya
		 * itu yang perlu dibedakan. */
		fetch(url + 'control/status', { method: 'GET', mode: 'no-cors', cache: 'no-store' })
			.catch(function() {
				pesan.style.display = '';
				bingkai.style.display = 'none';
			});

		return wadah;
	}
});
