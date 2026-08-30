'use strict';
'require baseclass';
'require uci';
'require rpc';

/* Peta VLAN di halaman Overview.
 *
 * LuCI sebenarnya sudah menyiratkan sebagian informasi ini di bagian "Port
 * status", tetapi terkubur dua lapis: daftar jaringan baru muncul saat kursor
 * menyentuh badge zona, dan nama perangkat VLAN hanya ada di atribut title
 * sebuah ikon 12x12 di dalamnya. Di ponsel tidak ada kursor untuk menyentuh
 * apa pun, jadi di sana informasinya tidak terjangkau sama sekali. Nomor VLAN,
 * subnet, zona, dan rentang DHCP tidak pernah ditulis sebagai teks.
 *
 * Yang membuatnya berguna bukan kelengkapannya melainkan dua kolom yang
 * bersanding:
 *
 *   VLAN vs Subnet -- nomor VLAN dan subnet yang dibawanya tidak harus sama,
 *   dan pasangan yang bersilang mudah terbaca terbalik saat menandai port di
 *   switch.
 *
 *   Zone -- beberapa VLAN bisa berada di zona firewall yang sama, yang
 *   berarti mereka TIDAK saling terisolasi meski nomornya berbeda. Itu
 *   keputusan yang sah, tapi pantas terlihat tanpa membuka halaman firewall.
 *
 * Bagian ini tidak menampilkan apa pun bila tidak ada bridge-vlan yang
 * terdefinisi, jadi aman pada konfigurasi LAN tunggal.
 */

var callDHCPLeases = rpc.declare({
	object: 'luci-rpc',
	method: 'getDHCPLeases',
	expect: { '': {} }
});

var callHostHints = rpc.declare({
	object: 'luci-rpc',
	method: 'getHostHints',
	expect: { '': {} }
});

var callInterfaceDump = rpc.declare({
	object: 'network.interface',
	method: 'dump',
	expect: { interface: [] }
});

var callDeviceStatus = rpc.declare({
	object: 'network.device',
	method: 'status',
	/* params WAJIB disebut. Tanpanya nama perangkat tidak pernah ikut
	   terkirim, ubus menjawab dengan seluruh perangkat sekaligus, dan kolom
	   Traffic diam-diam kosong untuk semua baris -- tanpa galat apa pun. */
	params: [ 'name' ],
	expect: { '': {} }
});

/* UCI mengembalikan opsi bertipe list sebagai larik, dan ipaddr termasuk --
   sebuah antarmuka boleh memikul lebih dari satu alamat. Nilainya karena itu
   bisa datang sebagai string maupun larik. Versi pertama modul ini
   menganggapnya selalu string; larik lolos dari penjaga '!ipaddr' lalu meledak
   di .split(), dan karena semua bagian Overview dirender dari satu tempat yang
   sama, itu MENGHAPUS seluruh halaman -- bukan hanya bagian ini. */
function pertamaDari(nilai) {
	if (Array.isArray(nilai))
		nilai = nilai[0];
	return (typeof nilai === 'string' && nilai !== '') ? nilai : null;
}

function keAngka(ip) {
	var o = String(ip).split('.').map(Number);
	if (o.length !== 4 || o.some(function(x) { return isNaN(x) || x < 0 || x > 255; }))
		return null;
	return ((o[0] << 24) >>> 0) + (o[1] << 16) + (o[2] << 8) + o[3];
}

/* Hanya IPv4: VLAN di sini semuanya IPv4, dan mencocokkan IPv6 butuh
   penanganan awalan yang berbeda sama sekali. */
function jaringanDari(ipaddr, netmask) {
	ipaddr = pertamaDari(ipaddr);
	netmask = pertamaDari(netmask);

	if (!ipaddr)
		return null;

	var alamat = ipaddr, bit = null, garis = ipaddr.indexOf('/');

	if (garis >= 0) {
		alamat = ipaddr.substring(0, garis);
		bit = parseInt(ipaddr.substring(garis + 1), 10);
	}
	else if (netmask) {
		var m = keAngka(netmask);
		if (m !== null) {
			bit = 0;
			for (var b = 31; b >= 0; b--)
				if (m & (1 << b)) bit++;
		}
	}

	var nilai = keAngka(alamat);
	if (nilai === null || bit === null || isNaN(bit) || bit < 0 || bit > 32)
		return null;

	var topeng = bit === 0 ? 0 : (0xFFFFFFFF << (32 - bit)) >>> 0;
	return { basis: (nilai & topeng) >>> 0, topeng: topeng, bit: bit, alamat: alamat };
}

function didalamJaringan(ip, jar) {
	ip = pertamaDari(ip);
	if (!jar || !ip)
		return false;
	var nilai = keAngka(ip);
	return nilai !== null && ((nilai & jar.topeng) >>> 0) === jar.basis;
}

/* Mengubah basis jaringan + oktet awal/limit DHCP menjadi rentang terbaca.
   dnsmasq menyatakan kolam sebagai 'start' dan 'limit' relatif terhadap basis
   subnet, bukan sebagai dua alamat utuh. */
function rentangDHCP(jar, start, limit) {
	if (!jar || start == null || limit == null)
		return null;
	var s = parseInt(start, 10), l = parseInt(limit, 10);
	if (isNaN(s) || isNaN(l) || l < 1)
		return null;

	var awal = (jar.basis + s) >>> 0;
	var akhir = (jar.basis + s + l - 1) >>> 0;
	var keTeks = function(n) {
		return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
	};
	/* Oktet terakhir saja untuk ujung kanan: awalannya sudah sama dengan
	   kolom Subnet di sebelahnya, dan mengulangnya hanya menambah lebar. */
	return keTeks(awal) + '–' + (akhir & 255);
}

function ukuran(byte) {
	var n = Number(byte);
	if (!isFinite(n) || n < 0)
		return '-';
	return '%1024.2mB'.format(n);
}

/* Kartu, bukan tabel.
 *
 * Versi pertama menyusun sepuluh kolom dalam satu baris tabel. Datanya benar
 * tetapi tidak terbaca: sepuluh kolom memaksa tiap nilai jadi sempit, dan
 * mata harus melompat mendatar jauh untuk menghubungkan nomor VLAN dengan
 * subnetnya -- padahal justru pasangan itu yang perlu dilihat bersamaan.
 *
 * Data ini sebenarnya tidak berbentuk tabel. Yang dibandingkan orang bukan
 * kolom demi kolom melainkan VLAN demi VLAN, dan tiap VLAN punya beberapa
 * fakta yang saling menjelaskan. Bentuk kartu mengikuti cara membacanya.
 *
 * .ifacebox dipakai karena bagian lain Overview -- Network dan Port status --
 * sudah memakainya, jadi bagian ini menyatu alih-alih tampak ditempel. */
function kartu(judul, subjudul, naik, isi, redup) {
	var kelasKepala = 'ifacebox-head' + (naik ? ' active' : '');

	return E('div', {
		'class': 'ifacebox',
		'style': 'min-width:0;margin:0' + (redup ? ';opacity:.55' : '')
	}, [
		E('div', { 'class': kelasKepala }, [
			E('strong', {}, [ judul ]),
			subjudul ? E('div', { 'style': 'font-weight:400;font-size:.8125rem' }, [ subjudul ]) : ''
		]),
		E('div', { 'class': 'ifacebox-body', 'style': 'text-align:left' }, isi)
	]);
}

/* Baris fakta sekunder: label kiri, nilai kanan, keduanya kecil. Dipakai untuk
   hal yang perlu ada tetapi tidak perlu menarik perhatian -- nama perangkat,
   port, zona. */
function fakta(label, nilai) {
	return E('div', {
		'style': 'display:flex;justify-content:space-between;gap:.75rem;' +
		         'font-size:.75rem;line-height:1.7'
	}, [
		E('span', { 'style': 'opacity:.65' }, [ label ]),
		E('span', { 'style': 'text-align:right;overflow-wrap:anywhere' }, [ nilai ])
	]);
}

return baseclass.extend({
	title: _('VLAN'),

	load: function() {
		/* Trafik diminta per perangkat, jadi daftar perangkatnya harus
		   diketahui lebih dulu -- karena itu dua tahap, bukan satu Promise.all
		   yang rata. */
		return Promise.all([
			uci.load('network'),
			uci.load('dhcp'),
			uci.load('firewall'),
			L.resolveDefault(callDHCPLeases(), {}),
			L.resolveDefault(callHostHints(), {}),
			L.resolveDefault(callInterfaceDump(), [])
		]).then(function(awal) {
			var vlans = uci.sections('network', 'bridge-vlan');
			var perangkat = vlans.map(function(v) {
				return (v.device || '') + '.' + (v.vlan || '');
			});

			return Promise.all(perangkat.map(function(nama) {
				/* Argumen diberikan POSISIONAL, bukan sebagai objek.
				   rpc.declare memetakan params:['name'] ke argumen ke-nol;
				   memanggilnya dengan { name: ... } membuat nama tidak pernah
				   terkirim, ubus menjawab dengan seluruh perangkat sekaligus,
				   dan kolom Traffic diam-diam kosong -- tanpa galat apa pun,
				   karena jawabannya tetap objek yang sah. */
				return L.resolveDefault(callDeviceStatus(nama), {});
			})).then(function(status) {
				var peta = {};
				perangkat.forEach(function(n, i) { peta[n] = status[i]; });
				return awal.concat([ peta ]);
			});
		});
	},

	render: function(data) {
		/* Bagian-bagian halaman Overview dirender dari satu tempat yang sama,
		   sehingga satu pengecualian di sini menghapus SELURUH halaman --
		   System, Memory, Network, semuanya. Itu sudah terjadi sekali karena
		   satu nilai UCI yang bentuknya tak terduga. Bagian tambahan tidak
		   pantas memikul risiko sebesar itu: kalau gagal, ia menghilang
		   sendiri dan sisanya tetap utuh. */
		try {
			return this.gambar(data);
		}
		catch (e) {
			return null;
		}
	},

	gambar: function(data) {
		var leases = (data[3] && data[3].dhcp_leases) || [],
		    hints  = data[4] || {},
		    ifaces = data[5] || [],
		    statPerangkat = data[6] || {};

		var vlans = uci.sections('network', 'bridge-vlan');
		if (!vlans.length)
			return null;

		var antarmuka = uci.sections('network', 'interface'),
		    dhcpPools = uci.sections('dhcp', 'dhcp'),
		    zona      = uci.sections('firewall', 'zone');

		/* Alamat milik router sendiri dikeluarkan dari hitungan klien: ia
		   muncul di getHostHints seperti host lain, dan menghitungnya membuat
		   setiap VLAN tampak punya satu penghuni lebih banyak. */
		var alamatRouter = {};
		antarmuka.forEach(function(s) {
			var a = pertamaDari(s.ipaddr);
			if (a) alamatRouter[a.split('/')[0]] = true;
		});

		var baris = vlans.map(function(v) {
			var perangkat = (v.device || '') + '.' + (v.vlan || '');

			var iface = antarmuka.filter(function(s) {
				return s.device === perangkat;
			})[0];

			var nama = iface ? iface['.name'] : null;
			var jar = iface ? jaringanDari(iface.ipaddr, iface.netmask) : null;

			/* Klien dihitung dari getHostHints, bukan dari lease DHCP.
			   Lease hanya mencatat yang meminta alamat; perangkat ber-IP
			   statis -- mesin virtual, server, printer -- tidak pernah muncul
			   di sana. Terukur di board ini: VLAN 30 punya satu lease tetapi
			   tiga penghuni. */
			var aktif = 0, denganLease = 0;
			if (jar) {
				Object.keys(hints).forEach(function(mac) {
					var ips = (hints[mac] && hints[mac].ipaddrs) || [];
					var cocok = ips.some(function(ip) {
						return didalamJaringan(ip, jar) && !alamatRouter[ip];
					});
					if (cocok) aktif++;
				});
				denganLease = leases.filter(function(l) {
					return didalamJaringan(l.ipaddr, jar);
				}).length;
			}

			var st = ifaces.filter(function(s) { return s.interface === nama; })[0];

			var kolam = dhcpPools.filter(function(s) { return s.interface === nama; })[0];
			var dhcp = null;
			if (kolam) {
				dhcp = (kolam.ignore === '1')
					? _('off')
					: rentangDHCP(jar, kolam.start, kolam.limit);
			}

			var z = zona.filter(function(s) {
				var n = s.network;
				if (!Array.isArray(n)) n = n ? [ n ] : [];
				return nama && n.indexOf(nama) >= 0;
			})[0];

			var stat = statPerangkat[perangkat] && statPerangkat[perangkat].statistics;

			return {
				vlan: v.vlan,
				port: v.ports || '-',
				nama: nama,
				perangkat: perangkat,
				zona: z ? z.name : null,
				subnet: jar ? (jar.alamat + '/' + jar.bit) : null,
				dhcp: dhcp,
				aktif: jar ? aktif : null,
				lease: jar ? denganLease : null,
				rx: stat ? stat.rx_bytes : null,
				tx: stat ? stat.tx_bytes : null,
				naik: st ? !!st.up : null,
				uptime: st ? st.uptime : null
			};
		}).sort(function(a, b) {
			return (parseInt(a.vlan, 10) || 0) - (parseInt(b.vlan, 10) || 0);
		});

		var kartuVLAN = baris.map(function(b) {
			var terpakai = (b.nama != null);

			if (!terpakai) {
				/* VLAN yang terdefinisi tapi tak dipakai tetap ditampilkan --
				   ia sudah di-tag di port, jadi keberadaannya nyata di sisi
				   switch. Tapi diredupkan dan diringkas: tidak ada yang perlu
				   dibaca selain bahwa ia ada dan kosong. */
				return kartu('VLAN ' + b.vlan, null, false, [
					E('div', { 'style': 'opacity:.7;font-size:.8125rem' }, [ _('unused') ]),
					fakta(_('Port'), b.port)
				], true);
			}

			var isi = [];

			/* Subnet ditulis paling menonjol. Bersama nomor VLAN di kepala
			   kartu, pasangan itulah yang paling sering dicari -- dan di
			   perangkat ini keduanya bersilang, sehingga harus terbaca
			   berdampingan tanpa usaha. */
			isi.push(E('div', {
				'style': 'font-size:.9375rem;font-weight:600;margin-bottom:.375rem;' +
				         'overflow-wrap:anywhere'
			}, [ b.subnet || '-' ]));

			/* Klien dan trafik: dua angka yang menjawab "seberapa ramai".
			   Sengaja berdampingan supaya bisa dibaca sekali lihat. */
			isi.push(E('div', {
				'style': 'display:flex;justify-content:space-between;gap:.5rem;' +
				         'align-items:flex-start;margin-bottom:.5rem'
			}, [
				E('div', {}, [
					E('div', { 'style': 'font-size:1.25rem;line-height:1.2' }, [ String(b.aktif) ]),
					E('div', { 'style': 'font-size:.6875rem;opacity:.65' }, [
						(b.lease != null && b.lease !== b.aktif)
							? _('devices, %d via DHCP').format(b.lease)
							: _('devices')
					])
				]),
				b.rx != null
					? E('div', { 'style': 'text-align:right;font-size:.75rem;line-height:1.6' }, [
						E('div', {}, [ '▼ ' + ukuran(b.rx) ]),
						E('div', {}, [ '▲ ' + ukuran(b.tx) ])
					  ])
					: ''
			]));

			/* Sisanya fakta rujukan: jarang dibaca, tetapi harus ada saat
			   dibutuhkan -- terutama Port, yang dicocokkan dengan tag di
			   switch. Dipisah garis supaya tidak bersaing dengan angka di
			   atasnya. */
			isi.push(E('div', {
				'style': 'border-top:1px solid var(--line-soft, rgba(128,128,128,.2));' +
				         'padding-top:.375rem'
			}, [
				fakta(_('Device'), b.perangkat),
				fakta(_('Port'), b.port),
				fakta(_('Zone'), b.zona || '-'),
				fakta(_('DHCP'), b.dhcp || '-'),
				fakta(_('Uptime'), b.uptime ? '%t'.format(b.uptime) : '-')
			]));

			return kartu('VLAN ' + b.vlan, b.nama, b.naik, isi, false);
		});

		/* auto-fit dengan minmax: satu kolom di ponsel, sebanyak yang muat di
		   layar lebar, tanpa breakpoint yang harus dirawat sendiri. */
		/* align-items:start WAJIB.
		   Tanpanya grid meregangkan setiap kartu setinggi yang tertinggi,
		   sehingga kartu VLAN tak terpakai -- yang isinya hanya dua baris --
		   menjadi kotak menjulang berisi ruang kosong. Diredupkan lalu
		   diregangkan justru terbaca rusak, bukan sengaja ditenangkan. */
		return E('div', {
			'style': 'display:grid;gap:.625rem;align-items:start;' +
			         'grid-template-columns:repeat(auto-fit, minmax(210px, 1fr))'
		}, kartuVLAN);
	}
});
