/* Jalankan: node test/workflow.test.js */
'use strict';
const assert = require('assert');
const { bangun } = require('./gas-mock');

const E = bangun();
const { ctx, post, sheets } = E;
let lulus = 0, gagalBil = 0;
const ujian = (nama, fn) => {
  try { fn(); lulus++; console.log('  ok   ' + nama); }
  catch (e) { gagalBil++; console.log('  GAGAL ' + nama + '\n        ' + (e.stack || e).split('\n').slice(0, 3).join('\n        ')); }
};
const ok = (r) => { assert.ok(r.ok, 'dijangka berjaya tetapi: ' + r.mesej); return r.data; };
const tolak = (r, kod) => { assert.strictEqual(r.ok, false, 'dijangka ditolak'); if (kod) assert.strictEqual(r.kod, kod, 'kod ' + r.kod + ' (' + r.mesej + ')'); return r; };

const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n').toString('base64');
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.alloc(20)]).toString('base64');
const EXE = Buffer.from('MZ\x90\x00\x03\x00\x00\x00').toString('base64');
const borang = (o) => Object.assign({ jenis: 'Bantuan Kewangan', jumlah: 1500, noIC: '900101-14-5678', telefon: '012-3456789',
  butiran: 'Memerlukan bantuan kerana kehilangan pekerjaan.', persetujuan: true, fail: [{ nama: 'slip gaji.pdf', data: PDF }] }, o || {});

const KATA = 'Sementara123';
const BARU = 'RahsiaBaru12345';
function masuk(emel) {
  const l = ok(post({ tindakan: 'LOGIN', email: emel, katalaluan: KATA }));
  assert.strictEqual(l.pengguna.perluTukar, true);
  const t = ok(post({ tindakan: 'TUKAR_KATA', token: l.token, lama: KATA, baru: BARU }));
  return t.token;
}
const api = (token, tindakan, d) => post(Object.assign({ tindakan, token }, d || {}));

console.log('Setup');
ctx.setup();
ujian('setup() cipta 4 lembaran dan folder', () => {
  ['Pengguna', 'Permohonan', 'Dokumen', 'Audit'].forEach((n) => assert.ok(sheets[n], n));
  assert.strictEqual(E.props.FOLDER_ID, 'FOLDER1');
});
const U = { adm: 'admin@agensi.gov.my', s1: 'semak1@agensi.gov.my', s2: 'semak2@agensi.gov.my', pl: 'lulus@agensi.gov.my', p1: 'pemohon1@agensi.gov.my', p2: 'pemohon2@agensi.gov.my' };
ctx.tambahPengguna(U.adm, 'Admin', 'admin', KATA);
ctx.tambahPengguna(U.s1, 'Penyemak Satu', 'penyemak', KATA);
ctx.tambahPengguna(U.s2, 'Penyemak Dua', 'penyemak', KATA);
ctx.tambahPengguna(U.pl, 'Pelulus', 'pelulus', KATA);
ctx.tambahPengguna(U.p1, 'Pemohon Satu', 'pemohon', KATA);
ctx.tambahPengguna(U.p2, 'Pemohon Dua', 'pemohon', KATA);

console.log('Auth');
ujian('kata laluan lemah ditolak semasa tambah pengguna', () => assert.throws(() => ctx.tambahPengguna('x@y.my', 'X', 'pemohon', 'abc')));
ujian('tiada Hash/Salt bocor dalam respons login', () => {
  const l = ok(post({ tindakan: 'LOGIN', email: U.p1, katalaluan: KATA }));
  assert.ok(!JSON.stringify(l).match(/Hash|Salt/));
});
ujian('pengguna perlu tukar kata laluan dahulu', () => {
  const l = ok(post({ tindakan: 'LOGIN', email: U.p2, katalaluan: KATA }));
  tolak(api(l.token, 'SENARAI'), 403);
});
ujian('mesej login sama untuk e-mel tiada dan kata laluan salah', () => {
  const a = tolak(post({ tindakan: 'LOGIN', email: 'tiada@x.my', katalaluan: 'x' }), 401);
  const b = tolak(post({ tindakan: 'LOGIN', email: U.p1, katalaluan: 'salah' }), 401);
  assert.strictEqual(a.mesej, b.mesej);
});
ujian('rate limit login: selepas 8 gagal, kata laluan betul pun disekat', () => {
  for (let i = 0; i < 8; i++) post({ tindakan: 'LOGIN', email: U.s2, katalaluan: 'salah' + i });
  tolak(post({ tindakan: 'LOGIN', email: U.s2, katalaluan: KATA }), 429);
  E.cache.delete('L_' + U.s2); E.cache.delete('LG');
});
ujian('token palsu / tiada token ditolak', () => {
  tolak(api('palsu', 'SENARAI'), 401);
  tolak(api('', 'SENARAI'), 401);
  tolak(post({ tindakan: 'SENARAI' }), 401);
});

const T = {};
['adm', 's1', 's2', 'pl', 'p1', 'p2'].forEach((k) => { T[k] = masuk(U[k]); });
ujian('login lama ditolak selepas tukar kata laluan (token lama dibatalkan)', () => {
  const l = ok(post({ tindakan: 'LOGIN', email: U.p1, katalaluan: BARU }));
  ok(api(l.token, 'SENARAI'));
});

console.log('Hantar permohonan');
let R1;
ujian('pemohon hantar permohonan sah, dapat nombor rujukan', () => {
  R1 = ok(api(T.p1, 'HANTAR', borang())).rujukan;
  assert.match(R1, /^BTN-\d{4}-[A-Z2-9]{6}$/);
  assert.ok(E.mails.some((m) => m.to === U.p1 && m.body.includes(R1)));
});
ujian('emel tidak mengandungi IC/butiran', () => {
  E.mails.forEach((m) => { assert.ok(!m.body.includes('900101')); assert.ok(!m.body.includes('kehilangan pekerjaan')); });
});
ujian('validasi: tiada persetujuan / IC salah / jumlah / jenis / tiada fail', () => {
  tolak(api(T.p1, 'HANTAR', borang({ persetujuan: false })));
  tolak(api(T.p1, 'HANTAR', borang({ noIC: '12345' })));
  tolak(api(T.p1, 'HANTAR', borang({ jumlah: -5 })));
  tolak(api(T.p1, 'HANTAR', borang({ jumlah: 99999999 })));
  tolak(api(T.p1, 'HANTAR', borang({ jenis: 'Palsu' })));
  tolak(api(T.p1, 'HANTAR', borang({ fail: [] })));
  tolak(api(T.p1, 'HANTAR', borang({ butiran: 'pendek' })));
});
ujian('fail EXE menyamar sebagai PDF ditolak (semak magic bytes)', () => {
  const r = tolak(api(T.p1, 'HANTAR', borang({ fail: [{ nama: 'a.pdf', data: EXE }] })));
  assert.match(r.mesej, /PDF, JPG atau PNG/);
});
ujian('fail lebih 2MB dan lebih 3 fail ditolak', () => {
  tolak(api(T.p1, 'HANTAR', borang({ fail: [{ nama: 'a.pdf', data: Buffer.alloc(3 * 1024 * 1024, 0x41).toString('base64') }] })));
  const f = { nama: 'a.pdf', data: PDF };
  tolak(api(T.p1, 'HANTAR', borang({ fail: [f, f, f, f] })));
});
ujian('hanya pemohon boleh hantar', () => {
  tolak(api(T.s1, 'HANTAR', borang()), 403);
  tolak(api(T.pl, 'HANTAR', borang()), 403);
});
ujian('formula injection dineutralkan dalam Sheet dan pulih semasa baca', () => {
  const r = ok(api(T.p2, 'HANTAR', borang({ butiran: '=HYPERLINK("http://jahat.example","klik")' }))).rujukan;
  const baris = sheets.Permohonan.rows.find((x) => x[0] === r);
  const idx = ctx.SKEMA.Permohonan.indexOf('Butiran');
  assert.ok(String(baris[idx]).startsWith("'="), 'sel mesti berawalan apostrof: ' + baris[idx]);
  const b = ok(api(T.p2, 'BUTIRAN', { rujukan: r }));
  assert.strictEqual(b.butiran, '=HYPERLINK("http://jahat.example","klik")');
});
ujian('IC disimpan sebagai teks dengan sifar di depan kekal', () => {
  const r = ok(api(T.p1, 'HANTAR', borang({ noIC: '010203-04-0506' }))).rujukan;
  const baris = sheets.Permohonan.rows.find((x) => x[0] === r);
  assert.strictEqual(baris[ctx.SKEMA.Permohonan.indexOf('NoIC')], '010203040506');
});

console.log('Kawalan akses');
ujian('pemohon lain tak boleh lihat butiran/dokumen (404, bukan 403)', () => {
  tolak(api(T.p2, 'BUTIRAN', { rujukan: R1 }), 404);
  const d = ok(api(T.p1, 'BUTIRAN', { rujukan: R1 })).dokumen[0];
  tolak(api(T.p2, 'DOKUMEN', { rujukan: R1, id: d.id }), 404);
});
ujian('penyemak belum ambil: tak boleh lihat butiran; barisan tiada nama/IC', () => {
  tolak(api(T.s1, 'BUTIRAN', { rujukan: R1 }), 404);
  const s = ok(api(T.s1, 'SENARAI'));
  const item = s.barisan.find((x) => x.rujukan === R1);
  assert.ok(item); assert.ok(!('nama' in item)); assert.ok(!JSON.stringify(item).includes('9001'));
});
ujian('pemohon tak boleh AMBIL / LULUS; penyemak tak boleh LULUS', () => {
  tolak(api(T.p1, 'AMBIL', { rujukan: R1 }), 403);
  tolak(api(T.p1, 'LULUS', { rujukan: R1 }), 403);
  tolak(api(T.s1, 'LULUS', { rujukan: R1 }), 403);
});
ujian('status tidak boleh dilangkau: LULUS terus dari Dihantar ditolak', () => {
  tolak(api(T.pl, 'LULUS', { rujukan: R1 }), 409);
});

console.log('Aliran semakan');
ujian('penyemak1 ambil; penyemak2 tak boleh ambil lagi (sudah diambil)', () => {
  assert.strictEqual(ok(api(T.s1, 'AMBIL', { rujukan: R1 })).status, 'Dalam Semakan');
  tolak(api(T.s2, 'AMBIL', { rujukan: R1 }), 409);
});
ujian('penyemak2 tak boleh kembalikan/hantar/tolak tugasan penyemak1', () => {
  tolak(api(T.s2, 'KEMBALIKAN', { rujukan: R1, sebab: 'tidak lengkap' }), 409);
  tolak(api(T.s2, 'HANTAR_PELULUS', { rujukan: R1 }), 409);
  tolak(api(T.s2, 'TOLAK_SEMAK', { rujukan: R1, sebab: 'tidak layak' }), 409);
  tolak(api(T.s2, 'BUTIRAN', { rujukan: R1 }), 404);
});
ujian('penyemak1 nampak IC penuh dan boleh muat turun dokumen (diaudit)', () => {
  const b = ok(api(T.s1, 'BUTIRAN', { rujukan: R1 }));
  assert.strictEqual(b.noIC, '900101145678');
  const d = ok(api(T.s1, 'DOKUMEN', { rujukan: R1, id: b.dokumen[0].id }));
  assert.strictEqual(Buffer.from(d.data, 'base64').toString().slice(0, 4), '%PDF');
  assert.ok(ok(api(T.adm, 'AUDIT', { rujukan: R1 })).some((a) => a.tindakan === 'DOKUMEN_LIHAT' && a.pengguna === U.s1));
});
ujian('kembalikan wajib sebab', () => {
  tolak(api(T.s1, 'KEMBALIKAN', { rujukan: R1 }));
  tolak(api(T.s1, 'KEMBALIKAN', { rujukan: R1, sebab: 'x' }));
});
ujian('kembalikan -> pemohon nampak sebab dan tarikh luput 14 hari', () => {
  ok(api(T.s1, 'KEMBALIKAN', { rujukan: R1, sebab: 'Slip gaji tidak jelas, sila muat naik semula' }));
  const b = ok(api(T.p1, 'BUTIRAN', { rujukan: R1 }));
  assert.strictEqual(b.status, 'Dikembalikan');
  assert.ok(b.tindakan.includes('BETULKAN'));
  const hari = (new Date(b.tarikhLuput) - Date.now()) / 86400000;
  assert.ok(hari > 13.9 && hari <= 14.01, 'hari=' + hari);
  assert.ok(b.sejarah.some((h) => h.tindakan === 'KEMBALIKAN' && /Slip gaji/.test(h.catatan)));
});
ujian('pemohon tak nampak e-mel pegawai dalam sejarah', () => {
  const b = ok(api(T.p1, 'BUTIRAN', { rujukan: R1 }));
  assert.ok(!JSON.stringify(b).includes(U.s1));
});
ujian('pemohon betulkan -> kembali ke penyemak sama; dokumen versi 2 (versi 1 kekal)', () => {
  tolak(api(T.p2, 'BETULKAN', Object.assign({ rujukan: R1 }, borang())), 404);
  ok(api(T.p1, 'BETULKAN', Object.assign({ rujukan: R1 }, borang({ fail: [{ nama: 'slip baru.png', data: PNG }], jumlah: 1600 }))));
  const b = ok(api(T.s1, 'BUTIRAN', { rujukan: R1 }));
  assert.strictEqual(b.status, 'Dalam Semakan');
  assert.strictEqual(b.jumlah, 1600);
  assert.deepStrictEqual(b.dokumen.map((d) => d.versi).sort(), [1, 2]);
  assert.strictEqual(b.bilPembetulan, 1);
});
ujian('betulkan ditolak jika status bukan Dikembalikan', () => {
  tolak(api(T.p1, 'BETULKAN', Object.assign({ rujukan: R1 }, borang())), 409);
});
ujian('hantar ke pelulus -> pelulus dimaklumkan (rujukan sahaja)', () => {
  E.mails.length = 0;
  ok(api(T.s1, 'HANTAR_PELULUS', { rujukan: R1, catatan: 'Dokumen lengkap' }));
  assert.ok(E.mails.some((m) => m.to === U.pl && m.body.includes(R1)));
});
ujian('penyemak tak boleh lagi ubah selepas hantar ke pelulus', () => {
  tolak(api(T.s1, 'KEMBALIKAN', { rujukan: R1, sebab: 'cuba lagi' }), 409);
  tolak(api(T.s1, 'LEPAS', { rujukan: R1 }), 409);
});

console.log('Keputusan pelulus');
ujian('pelulus nampak permohonan dan boleh baca dokumen', () => {
  assert.ok(ok(api(T.pl, 'SENARAI')).barisan.some((x) => x.rujukan === R1));
  const b = ok(api(T.pl, 'BUTIRAN', { rujukan: R1 }));
  ok(api(T.pl, 'DOKUMEN', { rujukan: R1, id: b.dokumen[0].id }));
  assert.deepStrictEqual(b.tindakan.sort(), ['LULUS', 'TOLAK_LULUS']);
});
ujian('pemohon / penyemak lain tak boleh putuskan', () => {
  tolak(api(T.p1, 'LULUS', { rujukan: R1 }), 403);
  tolak(api(T.s2, 'LULUS', { rujukan: R1 }), 403);
});
ujian('tolak oleh pelulus wajib sebab; lulus berjaya; keputusan muktamad', () => {
  tolak(api(T.pl, 'TOLAK_LULUS', { rujukan: R1 }));
  assert.strictEqual(ok(api(T.pl, 'LULUS', { rujukan: R1, sebab: 'Layak' })).status, 'Lulus');
  tolak(api(T.pl, 'TOLAK_LULUS', { rujukan: R1, sebab: 'tukar fikiran' }), 409);
  tolak(api(T.pl, 'LULUS', { rujukan: R1 }), 409);
  tolak(api(T.p1, 'BATAL', { rujukan: R1 }), 409);
  assert.strictEqual(ok(api(T.p1, 'BUTIRAN', { rujukan: R1 })).status, 'Lulus');
});
ujian('tolak terus oleh penyemak (tanpa pelulus)', () => {
  const r = ok(api(T.p1, 'HANTAR', borang())).rujukan;
  ok(api(T.s2, 'AMBIL', { rujukan: r }));
  assert.strictEqual(ok(api(T.s2, 'TOLAK_SEMAK', { rujukan: r, sebab: 'Tidak memenuhi syarat kelayakan' })).status, 'Ditolak');
  const b = ok(api(T.p1, 'BUTIRAN', { rujukan: r }));
  assert.match(b.sejarah.find((h) => h.tindakan === 'TOLAK_SEMAK').catatan, /syarat/);
});
ujian('tolak terus oleh pelulus', () => {
  const r = ok(api(T.p1, 'HANTAR', borang())).rujukan;
  ok(api(T.s1, 'AMBIL', { rujukan: r }));
  ok(api(T.s1, 'HANTAR_PELULUS', { rujukan: r }));
  assert.strictEqual(ok(api(T.pl, 'TOLAK_LULUS', { rujukan: r, sebab: 'Melebihi had bantuan' })).status, 'Ditolak');
});
ujian('pemohon boleh batal sebelum menunggu kelulusan', () => {
  const r = ok(api(T.p1, 'HANTAR', borang())).rujukan;
  assert.strictEqual(ok(api(T.p1, 'BATAL', { rujukan: r })).status, 'Dibatalkan');
  tolak(api(T.s1, 'AMBIL', { rujukan: r }), 409);
});
ujian('pengasingan tugas: pelulus tak boleh putuskan jika dia penyemak permohonan itu', () => {
  const r = ok(api(T.p1, 'HANTAR', borang())).rujukan;
  ok(api(T.s1, 'AMBIL', { rujukan: r }));
  ok(api(T.s1, 'HANTAR_PELULUS', { rujukan: r }));
  const p = ctx.cariPermohonan(r);
  assert.strictEqual(ctx.boleh({ email: U.s1, peranan: 'pelulus' }, p, 'LULUS'), false);
  assert.strictEqual(ctx.boleh({ email: U.p1, peranan: 'pelulus' }, p, 'LULUS'), false);
});

console.log('Admin');
ujian('admin nampak ringkasan sahaja: IC bertopeng, tiada butiran/nama/dokumen', () => {
  const b = ok(api(T.adm, 'BUTIRAN', { rujukan: R1 }));
  assert.strictEqual(b.noIC, '********5678');
  assert.ok(!('butiran' in b) && !('nama' in b) && !('telefon' in b));
  assert.deepStrictEqual(b.dokumen, []);
  tolak(api(T.adm, 'DOKUMEN', { rujukan: R1, id: 'F0' }), 404);
});
ujian('admin tak boleh lulus/tolak/ambil/hantar', () => {
  ['AMBIL', 'LULUS', 'TOLAK_LULUS', 'KEMBALIKAN', 'HANTAR_PELULUS'].forEach((a) => tolak(api(T.adm, a, { rujukan: R1, sebab: 'cuba cuba' }), 403));
  tolak(api(T.adm, 'HANTAR', borang()), 403);
});
ujian('admin boleh lepaskan tugasan tersangkut ke barisan', () => {
  const r = ok(api(T.p1, 'HANTAR', borang())).rujukan;
  ok(api(T.s1, 'AMBIL', { rujukan: r }));
  assert.strictEqual(ok(api(T.adm, 'LEPAS', { rujukan: r })).status, 'Dihantar');
  assert.ok(ok(api(T.s2, 'SENARAI')).barisan.some((x) => x.rujukan === r));
});
ujian('hanya admin boleh baca audit', () => {
  ['p1', 's1', 'pl'].forEach((k) => tolak(api(T[k], 'AUDIT'), 403));
  tolak(api(T.p1, 'SAHKAN_AUDIT'), 403);
});
ujian('semua akaun bukan admin tak boleh baca senarai orang lain', () => {
  const s = ok(api(T.p2, 'SENARAI'));
  assert.ok(s.saya.every((x) => !x.rujukan || x.rujukan !== R1));
  assert.ok(!('semua' in s) && !('barisan' in s));
});

console.log('Audit');
ujian('rantai audit sah', () => {
  const v = ok(api(T.adm, 'SAHKAN_AUDIT'));
  assert.strictEqual(v.ok, true, v.masalah);
  assert.ok(v.baris > 30);
});
ujian('ubah satu sel Audit dikesan', () => {
  const baris = sheets.Audit.rows, asal = baris[5][7];
  baris[5][7] = 'diubah secara sulit';
  const v = ok(api(T.adm, 'SAHKAN_AUDIT'));
  assert.strictEqual(v.ok, false); assert.match(v.masalah, /baris 6/);
  baris[5][7] = asal;
  assert.strictEqual(ok(api(T.adm, 'SAHKAN_AUDIT')).ok, true);
});
ujian('padam baris akhir Audit dikesan (jejak simpanan)', () => {
  const buang = sheets.Audit.rows.pop();
  const v = ok(api(T.adm, 'SAHKAN_AUDIT'));
  assert.strictEqual(v.ok, false);
  sheets.Audit.rows.push(buang);
  assert.strictEqual(ok(api(T.adm, 'SAHKAN_AUDIT')).ok, true);
});
ujian('kira semula seluruh rantai selepas ubah dikesan (head tersimpan dalam Properties)', () => {
  const rows = sheets.Audit.rows, asal = rows.map((r) => r.slice());
  rows[3][7] = 'ubah';
  let prev = 'GENESIS';
  for (let i = 0; i < rows.length; i++) {
    const f = rows.slice(i, i + 1)[0].slice(0, 8).map((x) => (typeof x === 'string' && x.startsWith("'") ? x.slice(1) : x));
    rows[i][8] = ctx.sha256(prev + '|' + JSON.stringify(f)); prev = rows[i][8];
  }
  assert.strictEqual(ok(api(T.adm, 'SAHKAN_AUDIT')).ok, false);
  sheets.Audit.rows = asal;
  assert.strictEqual(ok(api(T.adm, 'SAHKAN_AUDIT')).ok, true);
});

console.log('Tamat tempoh & sesi');
ujian('tutupLuput menutup permohonan Dikembalikan yang melepasi tarikh', () => {
  const r = ok(api(T.p1, 'HANTAR', borang())).rujukan;
  ok(api(T.s1, 'AMBIL', { rujukan: r }));
  ok(api(T.s1, 'KEMBALIKAN', { rujukan: r, sebab: 'Maklumat tidak lengkap' }));
  const row = sheets.Permohonan.rows.find((x) => x[0] === r);
  row[ctx.SKEMA.Permohonan.indexOf('TarikhLuput')] = new Date(Date.now() - 86400000).toISOString();
  tolak(api(T.p1, 'BETULKAN', Object.assign({ rujukan: r }, borang())), 409);   // sudah lepas tarikh
  ctx.tutupLuput();
  assert.strictEqual(ok(api(T.p1, 'BUTIRAN', { rujukan: r })).status, 'Luput');
  tolak(api(T.p1, 'BETULKAN', Object.assign({ rujukan: r }, borang())), 409);
});
ujian('logout membatalkan token di server', () => {
  const l = ok(post({ tindakan: 'LOGIN', email: U.p1, katalaluan: BARU }));
  ok(api(l.token, 'SENARAI'));
  ok(api(l.token, 'LOGOUT'));
  tolak(api(l.token, 'SENARAI'), 401);
});
ujian('pengguna dinyahaktifkan: token sedia ada serta-merta tidak sah', () => {
  const l = ok(post({ tindakan: 'LOGIN', email: U.p2, katalaluan: BARU }));
  ok(api(l.token, 'SENARAI'));
  ctx.nyahaktif(U.p2);
  tolak(api(l.token, 'SENARAI'), 401);
  tolak(post({ tindakan: 'LOGIN', email: U.p2, katalaluan: BARU }), 401);
  ctx.aktifkan(U.p2);
});
ujian('peranan dibaca semula setiap request (tukar peranan serta-merta berkesan)', () => {
  const l = ok(post({ tindakan: 'LOGIN', email: U.s2, katalaluan: BARU }));
  ok(api(l.token, 'SENARAI'));
  const u = ctx.cariPengguna(U.s2);
  ctx.kemasKiniBaris('Pengguna', u._r, { Peranan: 'pemohon' });
  tolak(api(l.token, 'AMBIL', { rujukan: R1 }), 403);
  ctx.kemasKiniBaris('Pengguna', u._r, { Peranan: 'penyemak' });
});
ujian('ralat dalaman tidak membocorkan stack trace', () => {
  const o = JSON.parse(ctx.doPost({ postData: { contents: '{"tindakan":"SENARAI","token":' + JSON.stringify(T.p1) + '}' } }).s);
  assert.ok(o.ok);
  const orig = ctx.bacaSemua; ctx.bacaSemua = () => { throw new Error('rahsia: ' + 'SHEET_ID_123'); };
  const r = api(T.p1, 'SENARAI'); ctx.bacaSemua = orig;
  assert.strictEqual(r.ok, false); assert.ok(!JSON.stringify(r).includes('SHEET_ID_123')); assert.strictEqual(r.kod, 500);
});
ujian('permintaan rosak / terlalu besar ditolak dengan kemas', () => {
  const r1 = JSON.parse(ctx.doPost({ postData: { contents: 'bukan json' } }).s);
  assert.strictEqual(r1.ok, false);
  const r2 = JSON.parse(ctx.doPost({ postData: { contents: 'x'.repeat(10000000) } }).s);
  assert.strictEqual(r2.kod, 413);
  const r3 = JSON.parse(ctx.doPost({}).s);
  assert.strictEqual(r3.ok, false);
});

console.log('\n' + lulus + ' lulus, ' + gagalBil + ' gagal');
process.exit(gagalBil ? 1 : 0);
