/**
 * Sistem Permohonan Bantuan: backend (Google Apps Script, container-bound pada Google Sheet).
 *
 * Aliran: Pemohon hantar -> Penyemak ambil & semak -> (Kembalikan | Tolak | Hantar ke Pelulus)
 *         -> Pelulus (Lulus | Tolak). Satu peringkat pelulus. Penyemak dan pelulus boleh tolak terus.
 *
 * Semua baca/tulis lalu doPost() dengan session token. Jangan "Publish to Web" mana-mana tab.
 * Setup: lihat README.md. Jalankan setup() sekali, kemudian tambahPengguna().
 */

/* ===================== Konfigurasi ===================== */
var CFG = {
  TTL_SESI: 6 * 60 * 60,        // saat. Had maksimum CacheService ialah 6 jam
  LOGIN_MAX: 8,                 // percubaan gagal setiap e-mel
  LOGIN_MAX_GLOBAL: 80,         // percubaan gagal keseluruhan
  LOGIN_TETINGKAP: 300,         // saat
  HASH_ITER: 1000,
  HARI_PEMBETULAN: 14,          // tempoh pemohon betulkan permohonan yang dikembalikan
  MAX_FAIL: 3,
  MAX_BYTES: 2 * 1024 * 1024,   // setiap fail
  JUMLAH_MAX: 100000,           // RM. Ubah ikut skim bantuan sebenar
  JENIS_BANTUAN: ['Bantuan Kewangan', 'Bantuan Pendidikan', 'Bantuan Perubatan', 'Bantuan Lain'],
  PERANAN: ['pemohon', 'penyemak', 'pelulus', 'admin']
};

var ST = {
  HANTAR: 'Dihantar', SEMAK: 'Dalam Semakan', KEMBALI: 'Dikembalikan',
  TUNGGU: 'Menunggu Kelulusan', LULUS: 'Lulus', TOLAK: 'Ditolak',
  BATAL: 'Dibatalkan', LUPUT: 'Luput'
};

var SKEMA = {
  Pengguna: ['Email', 'Nama', 'Peranan', 'Salt', 'Hash', 'PerluTukarKata', 'Aktif', 'Dicipta'],
  Permohonan: ['Rujukan', 'EmailPemohon', 'NamaPemohon', 'NoIC', 'Telefon', 'Jenis', 'Jumlah', 'Butiran',
               'Status', 'Penyemak', 'Pelulus', 'Sebab', 'TarikhHantar', 'TarikhKemaskini', 'TarikhLuput',
               'BilPembetulan', 'PersetujuanPada'],
  Dokumen: ['Rujukan', 'DriveId', 'NamaFail', 'Mime', 'Versi', 'Oleh', 'Masa'],
  Audit: ['Masa', 'Pengguna', 'Peranan', 'Rujukan', 'Tindakan', 'StatusLama', 'StatusBaru', 'Catatan', 'Hash']
};

/* Jadual transisi: satu-satunya tempat status boleh berubah (selain BETULKAN dan tutupLuput). */
var TRANSISI = {
  AMBIL:          { dari: [ST.HANTAR], ke: ST.SEMAK, peranan: ['penyemak'] },
  LEPAS:          { dari: [ST.SEMAK], ke: ST.HANTAR, peranan: ['penyemak', 'admin'] },
  KEMBALIKAN:     { dari: [ST.SEMAK], ke: ST.KEMBALI, peranan: ['penyemak'], sebab: true },
  HANTAR_PELULUS: { dari: [ST.SEMAK], ke: ST.TUNGGU, peranan: ['penyemak'] },
  TOLAK_SEMAK:    { dari: [ST.SEMAK], ke: ST.TOLAK, peranan: ['penyemak'], sebab: true },
  LULUS:          { dari: [ST.TUNGGU], ke: ST.LULUS, peranan: ['pelulus'] },
  TOLAK_LULUS:    { dari: [ST.TUNGGU], ke: ST.TOLAK, peranan: ['pelulus'], sebab: true },
  BATAL:          { dari: [ST.HANTAR, ST.KEMBALI, ST.SEMAK], ke: ST.BATAL, peranan: ['pemohon'] }
};

/* ===================== Ralat & utiliti ===================== */
function Ralat(mesej, kod) { this.message = mesej; this.kod = kod || 400; }
Ralat.prototype = Object.create(Error.prototype);

function sekarang() { return new Date().toISOString(); }

function keluar(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function toHex(bytes) {
  return bytes.map(function (b) { return ((b + 256) % 256).toString(16).padStart(2, '0'); }).join('');
}

function sha256(teks) {
  return toHex(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, teks));
}

function samaSelamat(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  var d = 0;
  for (var i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

function dalamKunci(fn) {
  var kunci = LockService.getScriptLock();
  if (!kunci.tryLock(20000)) throw new Ralat('Sistem sibuk. Cuba lagi sebentar.', 503);
  try { return fn(); } finally { kunci.releaseLock(); }
}

/* Formula injection: awalan ' untuk nilai yang bermula =,+,-,@ (juga tab/CR). Dibuang semula semasa baca. */
function sanitasi(v) {
  if (v === null || v === undefined) return '';
  var t = String(v);
  return /^[=+\-@\t\r]/.test(t) ? "'" + t : t;
}
function nyahSanitasi(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'string' && /^'[=+\-@\t\r]/.test(v)) return v.slice(1);
  return typeof v === 'number' ? String(v) : v;
}

/* ===================== Akses lembaran ===================== */
function lembaran(nama) {
  var s = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(nama);
  if (!s) throw new Error('Lembaran ' + nama + ' tiada. Jalankan setup().');
  return s;
}

function bacaSemua(nama) {
  var s = lembaran(nama), n = s.getLastRow(), h = SKEMA[nama];
  if (n < 2) return [];
  return s.getRange(2, 1, n - 1, h.length).getValues().map(function (r, i) {
    var o = { _r: i + 2 };
    h.forEach(function (k, j) { o[k] = nyahSanitasi(r[j]); });
    return o;
  });
}

function kemasKiniBaris(nama, baris, obj) {
  var s = lembaran(nama), h = SKEMA[nama];
  var cur = s.getRange(baris, 1, 1, h.length).getValues()[0];
  h.forEach(function (k, j) { if (Object.prototype.hasOwnProperty.call(obj, k)) cur[j] = sanitasi(obj[k]); });
  s.getRange(baris, 1, 1, h.length).setValues([cur]);
}

function tambahBaris(nama, obj) {
  lembaran(nama).appendRow(SKEMA[nama].map(function (k) { return sanitasi(obj[k]); }));
}

function cariPengguna(email) {
  email = normEmel(email);
  var semua = bacaSemua('Pengguna');
  for (var i = 0; i < semua.length; i++) if (semua[i].Email === email) return semua[i];
  return null;
}

function cariPermohonan(ruj) {
  ruj = String(ruj || '');
  var semua = bacaSemua('Permohonan');
  for (var i = 0; i < semua.length; i++) if (semua[i].Rujukan === ruj) return semua[i];
  return null;
}

function normEmel(e) { return String(e || '').trim().toLowerCase(); }

/* ===================== Audit (append-only, hash chain) ===================== */
/* WAJIB dipanggil dalam dalamKunci(). */
function tulisAudit(s, ruj, tindakan, lama, baru, catatan) {
  var sh = lembaran('Audit'), n = sh.getLastRow();
  var prev = n >= 2 ? String(sh.getRange(n, SKEMA.Audit.length).getValue()) : 'GENESIS';
  var f = [sekarang(), s.email, s.peranan, ruj || '', tindakan, lama || '', baru || '', String(catatan || '').slice(0, 1000)];
  var hash = sha256(prev + '|' + JSON.stringify(f));
  tambahBaris('Audit', {
    Masa: f[0], Pengguna: f[1], Peranan: f[2], Rujukan: f[3], Tindakan: f[4],
    StatusLama: f[5], StatusBaru: f[6], Catatan: f[7], Hash: hash
  });
  var bil = (n >= 2 ? n - 1 : 0) + 1;
  PropertiesService.getScriptProperties().setProperty('AUDIT_HEAD', hash + '#' + bil);
}

function sahkanAudit() {
  var baris = bacaSemua('Audit'), prev = 'GENESIS';
  for (var i = 0; i < baris.length; i++) {
    var a = baris[i];
    var f = [a.Masa, a.Pengguna, a.Peranan, a.Rujukan, a.Tindakan, a.StatusLama, a.StatusBaru, a.Catatan];
    if (sha256(prev + '|' + JSON.stringify(f)) !== a.Hash) {
      return { ok: false, baris: baris.length, masalah: 'Rantai rosak pada baris ' + a._r + ' lembaran Audit' };
    }
    prev = a.Hash;
  }
  var head = PropertiesService.getScriptProperties().getProperty('AUDIT_HEAD');
  var jangka = baris.length ? prev + '#' + baris.length : null;
  if ((head || null) !== jangka) {
    return { ok: false, baris: baris.length, masalah: 'Rekod terakhir tidak sepadan dengan jejak simpanan (baris dipadam atau ditokok tambah)' };
  }
  return { ok: true, baris: baris.length, masalah: null };
}

/* ===================== Kata laluan & sesi ===================== */
function hashPassword(pw, salt) {
  var h = pw + ':' + salt;
  for (var i = 0; i < CFG.HASH_ITER; i++) h = sha256(h + salt);
  return h;
}

function janaSalt() { return Utilities.getUuid() + Utilities.getUuid(); }

function semakKekuatan(pw) {
  pw = String(pw || '');
  if (pw.length < 10 || pw.length > 200 || !/[A-Za-z]/.test(pw) || !/\d/.test(pw)) {
    throw new Ralat('Kata laluan mesti sekurang-kurangnya 10 aksara dan mengandungi huruf serta nombor.');
  }
}

function ciptaSesi(email) {
  var t = Utilities.getUuid() + Utilities.getUuid();
  CacheService.getScriptCache().put('S_' + t, email, CFG.TTL_SESI);
  return t;
}

function sahSesi(token) {
  if (!token || typeof token !== 'string' || token.length > 100) return null;
  var email = CacheService.getScriptCache().get('S_' + token);
  if (!email) return null;
  var u = cariPengguna(email);              // baca peranan terkini setiap request
  if (!u || u.Aktif !== 'YA') return null;
  return { email: u.Email, nama: u.Nama, peranan: u.Peranan, perluTukar: u.PerluTukarKata === 'YA' };
}

function semakHad(kunci, had) {
  var c = CacheService.getScriptCache();
  if (Number(c.get(kunci) || 0) >= had) throw new Ralat('Terlalu banyak percubaan. Cuba lagi selepas 5 minit.', 429);
}
function tokokGagal(kunci) {
  var c = CacheService.getScriptCache();
  c.put(kunci, String(Number(c.get(kunci) || 0) + 1), CFG.LOGIN_TETINGKAP);
}

/* ===================== Pintu masuk ===================== */
function doGet() { return keluar({ ok: true, sistem: 'Sistem Permohonan Bantuan' }); }

function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) throw new Ralat('Permintaan tidak sah');
    if (e.postData.contents.length > 9500000) throw new Ralat('Permintaan terlalu besar', 413);
    var b;
    try { b = JSON.parse(e.postData.contents); } catch (x) { throw new Ralat('Format permintaan tidak sah'); }
    if (!b || typeof b !== 'object') throw new Ralat('Format permintaan tidak sah');
    var a = String(b.tindakan || '');
    if (a === 'LOGIN') return keluar({ ok: true, data: aLogin(b) });

    var s = sahSesi(b.token);
    if (!s) throw new Ralat('Sesi tamat. Sila log masuk semula.', 401);
    if (s.perluTukar && ['TUKAR_KATA', 'LOGOUT', 'ME'].indexOf(a) < 0) throw new Ralat('Sila tukar kata laluan dahulu.', 403);
    var t = TINDAKAN[a];
    if (!t) throw new Ralat('Tindakan tidak dikenali');
    if (t.peranan && t.peranan.indexOf(s.peranan) < 0) throw new Ralat('Tiada kebenaran', 403);
    return keluar({ ok: true, data: t.fn(b, s) });
  } catch (err) {
    if (err instanceof Ralat) return keluar({ ok: false, mesej: err.message, kod: err.kod });
    console.error(err && err.stack ? err.stack : String(err));
    return keluar({ ok: false, mesej: 'Ralat dalaman. Cuba lagi.', kod: 500 });
  }
}

var TINDAKAN = {
  ME:             { fn: aMe },
  LOGOUT:         { fn: aLogout },
  TUKAR_KATA:     { fn: aTukarKata },
  HANTAR:         { fn: aHantar, peranan: ['pemohon'] },
  BETULKAN:       { fn: aBetulkan, peranan: ['pemohon'] },
  SENARAI:        { fn: aSenarai },
  BUTIRAN:        { fn: aButiran },
  DOKUMEN:        { fn: aDokumen },
  AMBIL:          { fn: buatTransit('AMBIL'), peranan: ['penyemak'] },
  LEPAS:          { fn: buatTransit('LEPAS'), peranan: ['penyemak', 'admin'] },
  KEMBALIKAN:     { fn: buatTransit('KEMBALIKAN'), peranan: ['penyemak'] },
  HANTAR_PELULUS: { fn: buatTransit('HANTAR_PELULUS'), peranan: ['penyemak'] },
  TOLAK_SEMAK:    { fn: buatTransit('TOLAK_SEMAK'), peranan: ['penyemak'] },
  LULUS:          { fn: buatTransit('LULUS'), peranan: ['pelulus'] },
  TOLAK_LULUS:    { fn: buatTransit('TOLAK_LULUS'), peranan: ['pelulus'] },
  BATAL:          { fn: buatTransit('BATAL'), peranan: ['pemohon'] },
  AUDIT:          { fn: aAudit, peranan: ['admin'] },
  SAHKAN_AUDIT:   { fn: function () { return sahkanAudit(); }, peranan: ['admin'] }
};

/* ===================== Auth ===================== */
function aLogin(b) {
  var email = normEmel(b.email), pw = String(b.katalaluan || '');
  var salah = new Ralat('E-mel atau kata laluan salah', 401);
  if (!email || !pw || pw.length > 200) throw salah;
  semakHad('LG', CFG.LOGIN_MAX_GLOBAL);
  semakHad('L_' + email, CFG.LOGIN_MAX);
  var u = cariPengguna(email), ok = false;
  if (u && u.Aktif === 'YA') ok = samaSelamat(hashPassword(pw, u.Salt), u.Hash);
  else hashPassword(pw, 'garam-palsu');     // samakan masa tindak balas
  if (!ok) { tokokGagal('L_' + email); tokokGagal('LG'); throw salah; }
  CacheService.getScriptCache().remove('L_' + email);
  var token = ciptaSesi(u.Email);
  dalamKunci(function () { tulisAudit({ email: u.Email, peranan: u.Peranan }, '', 'LOGIN', '', '', ''); });
  return { token: token, pengguna: infoPengguna(u), cfg: cfgAwam() };
}

function infoPengguna(u) {
  return { emel: u.Email, nama: u.Nama, peranan: u.Peranan, perluTukar: u.PerluTukarKata === 'YA' };
}
function cfgAwam() {
  return { jenisBantuan: CFG.JENIS_BANTUAN, maxFail: CFG.MAX_FAIL, maxMB: CFG.MAX_BYTES / 1048576, hariPembetulan: CFG.HARI_PEMBETULAN };
}

function aMe(b, s) {
  return { pengguna: { emel: s.email, nama: s.nama, peranan: s.peranan, perluTukar: s.perluTukar }, cfg: cfgAwam() };
}

function aLogout(b) {
  if (b.token) CacheService.getScriptCache().remove('S_' + b.token);
  return {};
}

function aTukarKata(b, s) {
  semakHad('TK_' + s.email, CFG.LOGIN_MAX);
  var u = cariPengguna(s.email);
  if (!samaSelamat(hashPassword(String(b.lama || ''), u.Salt), u.Hash)) {
    tokokGagal('TK_' + s.email);
    throw new Ralat('Kata laluan semasa salah', 401);
  }
  semakKekuatan(b.baru);
  if (b.baru === b.lama) throw new Ralat('Kata laluan baharu mesti berbeza daripada yang lama.');
  var salt = janaSalt();
  dalamKunci(function () {
    kemasKiniBaris('Pengguna', u._r, { Salt: salt, Hash: hashPassword(b.baru, salt), PerluTukarKata: 'TIDAK' });
    tulisAudit(s, '', 'TUKAR_KATA', '', '', '');
  });
  CacheService.getScriptCache().remove('S_' + b.token);
  return { token: ciptaSesi(s.email) };
}

/* ===================== Pengesahan input ===================== */
function sahkanBorang(b) {
  var jenis = String(b.jenis || '');
  if (CFG.JENIS_BANTUAN.indexOf(jenis) < 0) throw new Ralat('Jenis bantuan tidak sah');
  var jumlah = Number(b.jumlah);
  if (!isFinite(jumlah) || jumlah <= 0 || jumlah > CFG.JUMLAH_MAX) throw new Ralat('Jumlah mesti antara RM0.01 dan RM' + CFG.JUMLAH_MAX);
  var ic = String(b.noIC || '').replace(/[\s-]/g, '');
  if (!/^\d{12}$/.test(ic)) throw new Ralat('No. kad pengenalan mesti 12 digit');
  var tel = String(b.telefon || '').replace(/[\s-]/g, '').replace(/^\+/, '');
  if (!/^\d{9,12}$/.test(tel)) throw new Ralat('No. telefon tidak sah');
  var butiran = String(b.butiran || '').trim();
  if (butiran.length < 10 || butiran.length > 2000) throw new Ralat('Butiran permohonan mesti 10 hingga 2000 aksara');
  return { jenis: jenis, jumlah: Math.round(jumlah * 100) / 100, noIC: ic, telefon: tel, butiran: butiran };
}

function jenisFail(by) {
  var u = function (i) { return (by[i] + 256) % 256; };
  if (by.length > 4 && u(0) === 0x25 && u(1) === 0x50 && u(2) === 0x44 && u(3) === 0x46) return { mime: 'application/pdf', ext: 'pdf' };
  if (by.length > 3 && u(0) === 0xFF && u(1) === 0xD8 && u(2) === 0xFF) return { mime: 'image/jpeg', ext: 'jpg' };
  if (by.length > 8 && u(0) === 0x89 && u(1) === 0x50 && u(2) === 0x4E && u(3) === 0x47) return { mime: 'image/png', ext: 'png' };
  return null;
}

function sahkanFail(arr, min) {
  arr = arr || [];
  if (!Array.isArray(arr) || arr.length < min || arr.length > CFG.MAX_FAIL) {
    throw new Ralat('Muat naik ' + (min ? min + ' hingga ' : 'sehingga ') + CFG.MAX_FAIL + ' dokumen (PDF, JPG atau PNG)');
  }
  return arr.map(function (f, i) {
    if (!f || typeof f.data !== 'string' || f.data.length > Math.ceil(CFG.MAX_BYTES * 4 / 3) + 8) {
      throw new Ralat('Dokumen ' + (i + 1) + ' terlalu besar (maksimum ' + CFG.MAX_BYTES / 1048576 + ' MB)');
    }
    var by;
    try { by = Utilities.base64Decode(f.data); } catch (x) { throw new Ralat('Dokumen ' + (i + 1) + ' rosak'); }
    if (!by.length || by.length > CFG.MAX_BYTES) throw new Ralat('Dokumen ' + (i + 1) + ' terlalu besar atau kosong');
    var jenis = jenisFail(by);
    if (!jenis) throw new Ralat('Dokumen ' + (i + 1) + ' mesti PDF, JPG atau PNG');
    var asas = String(f.nama || 'dokumen').replace(/\.[^.]*$/, '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 50) || 'dokumen';
    return { nama: asas + '.' + jenis.ext, mime: jenis.mime, bytes: by };
  });
}

function janaRujukan(ada) {
  var abjad = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789', tahun = new Date().getFullYear();
  for (var cuba = 0; cuba < 20; cuba++) {
    var by = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, Utilities.getUuid()), r = '';
    for (var i = 0; i < 6; i++) r += abjad.charAt(((by[i] + 256) % 256) % abjad.length);
    var ruj = 'BTN-' + tahun + '-' + r;
    if (!ada[ruj]) return ruj;
  }
  throw new Error('Gagal menjana nombor rujukan');
}

function simpanFail(ruj, versi, fail, s) {
  var folder = DriveApp.getFolderById(PropertiesService.getScriptProperties().getProperty('FOLDER_ID'));
  var dibuat = [];
  var buang = function () { dibuat.forEach(function (d) { try { DriveApp.getFileById(d.id).setTrashed(true); } catch (x) { } }); };
  try {
    fail.forEach(function (f, i) {
      var fl = folder.createFile(Utilities.newBlob(f.bytes, f.mime, ruj + '_v' + versi + '_' + (i + 1) + '_' + f.nama));
      dibuat.push({ id: fl.getId(), nama: f.nama, mime: f.mime });
    });
  } catch (e) { buang(); throw e; }
  return {
    buang: buang,
    catat: function () {
      dibuat.forEach(function (d) {
        tambahBaris('Dokumen', { Rujukan: ruj, DriveId: d.id, NamaFail: d.nama, Mime: d.mime, Versi: versi, Oleh: s.email, Masa: sekarang() });
      });
    }
  };
}

/* ===================== Permohonan ===================== */
function aHantar(b, s) {
  var d = sahkanBorang(b);
  if (b.persetujuan !== true) throw new Ralat('Persetujuan terhadap notis privasi diperlukan');
  var fail = sahkanFail(b.fail, 1), rujukan;
  var u = cariPengguna(s.email);
  dalamKunci(function () {
    var ada = {};
    bacaSemua('Permohonan').forEach(function (p) { ada[p.Rujukan] = 1; });
    rujukan = janaRujukan(ada);
    var simpan = simpanFail(rujukan, 1, fail, s);
    try {
      var now = sekarang();
      tambahBaris('Permohonan', {
        Rujukan: rujukan, EmailPemohon: s.email, NamaPemohon: u.Nama, NoIC: d.noIC, Telefon: d.telefon,
        Jenis: d.jenis, Jumlah: d.jumlah, Butiran: d.butiran, Status: ST.HANTAR, Penyemak: '', Pelulus: '',
        Sebab: '', TarikhHantar: now, TarikhKemaskini: now, TarikhLuput: '', BilPembetulan: 0, PersetujuanPada: now
      });
      simpan.catat();
      tulisAudit(s, rujukan, 'HANTAR', '', ST.HANTAR, 'Persetujuan notis privasi: ya. Dokumen: ' + fail.length);
    } catch (e) { simpan.buang(); throw e; }
  });
  hebahan(s.email, 'Permohonan diterima', 'Permohonan anda telah diterima. No. rujukan: ' + rujukan);
  return { rujukan: rujukan };
}

function aBetulkan(b, s) {
  var d = sahkanBorang(b);
  var fail = sahkanFail(b.fail, 0);
  dalamKunci(function () {
    var p = cariPermohonan(b.rujukan);
    if (!p || p.EmailPemohon !== s.email) throw new Ralat('Permohonan tidak dijumpai', 404);
    if (p.Status !== ST.KEMBALI) throw new Ralat('Permohonan ini tidak dikembalikan untuk pembetulan', 409);
    if (p.TarikhLuput && p.TarikhLuput < sekarang()) throw new Ralat('Tempoh pembetulan telah tamat', 409);
    var bil = Number(p.BilPembetulan) + 1, simpan = simpanFail(p.Rujukan, bil + 1, fail, s);
    try {
      var baru = p.Penyemak ? ST.SEMAK : ST.HANTAR;
      kemasKiniBaris('Permohonan', p._r, {
        NoIC: d.noIC, Telefon: d.telefon, Jenis: d.jenis, Jumlah: d.jumlah, Butiran: d.butiran,
        Status: baru, Sebab: '', TarikhLuput: '', TarikhKemaskini: sekarang(), BilPembetulan: bil
      });
      simpan.catat();
      tulisAudit(s, p.Rujukan, 'BETULKAN', p.Status, baru, 'Pembetulan ke-' + bil + '. Dokumen baharu: ' + fail.length);
    } catch (e) { simpan.buang(); throw e; }
  });
  return { status: 'ok' };
}

function boleh(s, p, kod) {
  var t = TRANSISI[kod], e = s.email;
  if (!t || t.peranan.indexOf(s.peranan) < 0 || t.dari.indexOf(p.Status) < 0) return false;
  switch (kod) {
    case 'AMBIL': return e !== p.EmailPemohon;
    case 'LEPAS': return s.peranan === 'admin' || p.Penyemak === e;
    case 'KEMBALIKAN': case 'HANTAR_PELULUS': case 'TOLAK_SEMAK': return p.Penyemak === e;
    case 'LULUS': case 'TOLAK_LULUS': return e !== p.Penyemak && e !== p.EmailPemohon;
    case 'BATAL': return p.EmailPemohon === e;
  }
  return false;
}

function bolehBetulkan(s, p) {
  return s.peranan === 'pemohon' && p.EmailPemohon === s.email && p.Status === ST.KEMBALI &&
    (!p.TarikhLuput || p.TarikhLuput >= sekarang());
}

function tindakanBoleh(s, p) {
  var r = Object.keys(TRANSISI).filter(function (k) { return boleh(s, p, k); });
  if (bolehBetulkan(s, p)) r.push('BETULKAN');
  return r;
}

function buatTransit(kod) {
  return function (b, s) {
    var t = TRANSISI[kod], hebah = [], ke = t.ke;
    var sebab = String(b.sebab || '').trim().slice(0, 1000);
    if (t.sebab && sebab.length < 5) throw new Ralat('Sebab diperlukan (sekurang-kurangnya 5 aksara)');
    dalamKunci(function () {
      var p = cariPermohonan(b.rujukan);
      if (!p) throw new Ralat('Permohonan tidak dijumpai', 404);
      if (!boleh(s, p, kod)) throw new Ralat('Tindakan tidak dibenarkan untuk status semasa permohonan ini', 409);
      var upd = { Status: ke, TarikhKemaskini: sekarang() };
      if (kod === 'AMBIL') upd.Penyemak = s.email;
      if (kod === 'LEPAS') upd.Penyemak = '';
      if (kod === 'KEMBALIKAN') { upd.Sebab = sebab; upd.TarikhLuput = new Date(Date.now() + CFG.HARI_PEMBETULAN * 86400000).toISOString(); }
      if (kod === 'TOLAK_SEMAK') upd.Sebab = sebab;
      if (kod === 'LULUS' || kod === 'TOLAK_LULUS') { upd.Pelulus = s.email; upd.Sebab = sebab; }
      kemasKiniBaris('Permohonan', p._r, upd);
      tulisAudit(s, p.Rujukan, kod, p.Status, ke, sebab);
      if (kod !== 'LEPAS') hebah.push([p.EmailPemohon, 'Status permohonan dikemas kini', 'Permohonan ' + p.Rujukan + ' kini berstatus: ' + ke + '.']);
      if (kod === 'HANTAR_PELULUS') {
        bacaSemua('Pengguna').forEach(function (u) {
          if (u.Peranan === 'pelulus' && u.Aktif === 'YA') hebah.push([u.Email, 'Permohonan menunggu kelulusan', 'Permohonan ' + p.Rujukan + ' menunggu keputusan anda.']);
        });
      }
    });
    hebah.forEach(function (h) { hebahan(h[0], h[1], h[2]); });
    return { status: ke };
  };
}

/* ===================== Paparan & akses ===================== */
function tahapAkses(s, p) {
  switch (s.peranan) {
    case 'pemohon': return p.EmailPemohon === s.email ? 'penuh' : null;
    case 'penyemak': return p.Penyemak === s.email ? 'penuh' : null;
    case 'pelulus': return (p.Status === ST.TUNGGU || p.Pelulus === s.email) && p.Penyemak !== s.email ? 'penuh' : null;
    case 'admin': return 'ringkas';
  }
  return null;
}

function topengIC(ic) { return ic ? '********' + String(ic).slice(-4) : ''; }

function ringkas(p, ops) {
  var o = {
    rujukan: p.Rujukan, jenis: p.Jenis, jumlah: Number(p.Jumlah), status: p.Status,
    tarikhHantar: p.TarikhHantar, tarikhKemaskini: p.TarikhKemaskini, tarikhLuput: p.TarikhLuput || ''
  };
  if (ops.nama) o.nama = p.NamaPemohon;
  if (ops.pegawai) { o.penyemak = p.Penyemak; o.pelulus = p.Pelulus; }
  return o;
}

function aSenarai(b, s) {
  var semua = bacaSemua('Permohonan'), e = s.email, r = {};
  var lama = function (x, y) { return x.TarikhHantar < y.TarikhHantar ? -1 : 1; };
  var baru = function (x, y) { return x.TarikhKemaskini < y.TarikhKemaskini ? 1 : -1; };
  if (s.peranan === 'pemohon') {
    r.saya = semua.filter(function (p) { return p.EmailPemohon === e; }).sort(baru).map(function (p) { return ringkas(p, {}); });
  } else if (s.peranan === 'penyemak') {
    r.barisan = semua.filter(function (p) { return p.Status === ST.HANTAR && p.EmailPemohon !== e; }).sort(lama).map(function (p) { return ringkas(p, {}); });
    r.saya = semua.filter(function (p) { return p.Penyemak === e && p.Status === ST.SEMAK; }).sort(lama).map(function (p) { return ringkas(p, { nama: 1 }); });
    r.selesai = semua.filter(function (p) { return p.Penyemak === e && p.Status !== ST.SEMAK; }).sort(baru).slice(0, 50).map(function (p) { return ringkas(p, { nama: 1 }); });
  } else if (s.peranan === 'pelulus') {
    r.barisan = semua.filter(function (p) { return p.Status === ST.TUNGGU && p.Penyemak !== e; }).sort(lama).map(function (p) { return ringkas(p, { nama: 1 }); });
    r.selesai = semua.filter(function (p) { return p.Pelulus === e; }).sort(baru).slice(0, 50).map(function (p) { return ringkas(p, { nama: 1 }); });
  } else if (s.peranan === 'admin') {
    r.semua = semua.sort(baru).slice(0, 300).map(function (p) { return ringkas(p, { pegawai: 1 }); });
  }
  return r;
}

function sejarah(p, s) {
  var awam = ['KEMBALIKAN', 'TOLAK_SEMAK', 'TOLAK_LULUS', 'LULUS'];
  return bacaSemua('Audit').filter(function (a) {
    return a.Rujukan === p.Rujukan && (s.peranan !== 'pemohon' || a.Tindakan !== 'DOKUMEN_LIHAT');
  }).map(function (a) {
    if (s.peranan === 'pemohon') {
      return { masa: a.Masa, tindakan: a.Tindakan, statusBaru: a.StatusBaru, catatan: awam.indexOf(a.Tindakan) >= 0 ? a.Catatan : '' };
    }
    return { masa: a.Masa, tindakan: a.Tindakan, statusLama: a.StatusLama, statusBaru: a.StatusBaru, oleh: a.Pengguna, peranan: a.Peranan, catatan: a.Catatan };
  });
}

function aButiran(b, s) {
  var p = cariPermohonan(b.rujukan), tahap = p ? tahapAkses(s, p) : null;
  if (!p || !tahap) throw new Ralat('Permohonan tidak dijumpai', 404);
  var o = ringkas(p, { pegawai: s.peranan !== 'pemohon', nama: tahap === 'penuh' });
  o.sebab = p.Sebab;
  o.bilPembetulan = Number(p.BilPembetulan);
  o.tindakan = tindakanBoleh(s, p);
  o.sejarah = sejarah(p, s);
  if (tahap === 'penuh') {
    o.noIC = p.NoIC; o.telefon = p.Telefon; o.butiran = p.Butiran; o.emel = p.EmailPemohon;
    o.dokumen = bacaSemua('Dokumen').filter(function (d) { return d.Rujukan === p.Rujukan; })
      .map(function (d) { return { id: d.DriveId, nama: d.NamaFail, mime: d.Mime, versi: Number(d.Versi), masa: d.Masa }; });
  } else {
    o.noIC = topengIC(p.NoIC);
    o.dokumen = [];
  }
  return o;
}

function aDokumen(b, s) {
  var p = cariPermohonan(b.rujukan);
  if (!p || tahapAkses(s, p) !== 'penuh') throw new Ralat('Dokumen tidak dijumpai', 404);
  var d = bacaSemua('Dokumen').filter(function (x) { return x.Rujukan === p.Rujukan && x.DriveId === String(b.id); })[0];
  if (!d) throw new Ralat('Dokumen tidak dijumpai', 404);
  var data = Utilities.base64Encode(DriveApp.getFileById(d.DriveId).getBlob().getBytes());
  dalamKunci(function () { tulisAudit(s, p.Rujukan, 'DOKUMEN_LIHAT', p.Status, p.Status, d.NamaFail); });
  return { nama: d.NamaFail, mime: d.Mime, data: data };
}

function aAudit(b) {
  var rows = bacaSemua('Audit');
  if (b.rujukan) rows = rows.filter(function (a) { return a.Rujukan === String(b.rujukan); });
  return rows.slice(-200).reverse().map(function (a) {
    return { masa: a.Masa, pengguna: a.Pengguna, peranan: a.Peranan, rujukan: a.Rujukan, tindakan: a.Tindakan, statusLama: a.StatusLama, statusBaru: a.StatusBaru, catatan: a.Catatan };
  });
}

/* ===================== Emel (percuma, tanpa data peribadi) ===================== */
function hebahan(kepada, subjek, isi) {
  try {
    if (!kepada || MailApp.getRemainingDailyQuota() < 1) return;
    var url = PropertiesService.getScriptProperties().getProperty('PORTAL_URL') || '';
    MailApp.sendEmail({ to: kepada, subject: '[Sistem Bantuan] ' + subjek, body: isi + '\n\nLog masuk untuk butiran: ' + url + '\n\nEmel ini dijana automatik. Jangan balas.', noReply: true });
  } catch (e) { console.warn('Emel gagal: ' + e); }
}

/* ===================== Tugas berjadual ===================== */
function tutupLuput() {
  var sys = { email: 'sistem', peranan: 'sistem' }, hebah = [];
  dalamKunci(function () {
    var now = sekarang();
    bacaSemua('Permohonan').forEach(function (p) {
      if (p.Status === ST.KEMBALI && p.TarikhLuput && p.TarikhLuput < now) {
        kemasKiniBaris('Permohonan', p._r, { Status: ST.LUPUT, TarikhKemaskini: now });
        tulisAudit(sys, p.Rujukan, 'LUPUT', ST.KEMBALI, ST.LUPUT, 'Tempoh pembetulan tamat');
        hebah.push([p.EmailPemohon, 'Permohonan luput', 'Permohonan ' + p.Rujukan + ' ditutup kerana tempoh pembetulan telah tamat.']);
      }
    });
  });
  hebah.forEach(function (h) { hebahan(h[0], h[1], h[2]); });
}

function pasangTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'tutupLuput') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('tutupLuput').timeBased().everyDays(1).atHour(2).create();
}

/* ===================== Setup & pengurusan pengguna (jalankan dari editor) ===================== */
function setup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  Object.keys(SKEMA).forEach(function (nama) {
    var sh = ss.getSheetByName(nama) || ss.insertSheet(nama), k = SKEMA[nama].length;
    sh.getRange(1, 1, 1, k).setValues([SKEMA[nama]]);
    sh.getRange(1, 1, sh.getMaxRows(), k).setNumberFormat('@');   // teks sahaja: IC kekal 0 di depan, tiada formula
    sh.setFrozenRows(1);
  });
  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty('FOLDER_ID')) {
    props.setProperty('FOLDER_ID', DriveApp.createFolder('Dokumen Permohonan Bantuan (PERSENDIRIAN)').getId());
  }
  try {
    var audit = ss.getSheetByName('Audit'), lindung = audit.protect();
    lindung.setDescription('Audit: ditulis oleh skrip sahaja');
    var me = Session.getEffectiveUser();
    lindung.addEditor(me);
    lindung.removeEditors(lindung.getEditors().filter(function (u) { return u.getEmail() !== me.getEmail(); }));
  } catch (e) { Logger.log('Perlindungan lembaran Audit tidak lengkap: ' + e); }
  Logger.log('Setup siap. Tetapkan Script Property PORTAL_URL (URL Netlify), kemudian jalankan tambahPengguna().');
}

function tambahPengguna(email, nama, peranan, katalaluanSementara) {
  email = normEmel(email); peranan = String(peranan || '').toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('E-mel tidak sah');
  if (CFG.PERANAN.indexOf(peranan) < 0) throw new Error('Peranan mesti salah satu: ' + CFG.PERANAN.join(', '));
  if (!nama) throw new Error('Nama diperlukan');
  var pw = katalaluanSementara || janaKataSementara();
  semakKekuatan(pw);
  dalamKunci(function () {
    if (cariPengguna(email)) throw new Error('Pengguna sudah wujud');
    var salt = janaSalt();
    tambahBaris('Pengguna', { Email: email, Nama: nama, Peranan: peranan, Salt: salt, Hash: hashPassword(pw, salt), PerluTukarKata: 'YA', Aktif: 'YA', Dicipta: sekarang() });
    tulisAudit({ email: 'editor', peranan: 'admin' }, '', 'PENGGUNA_TAMBAH', '', '', email + ' (' + peranan + ')');
  });
  Logger.log('Pengguna ' + email + ' dicipta. Kata laluan sementara: ' + pw + '  (beritahu secara terus, kemudian padam log)');
  return { emel: email, katalaluanSementara: pw };
}

function resetKataLaluan(email) {
  var u = cariPengguna(email); if (!u) throw new Error('Pengguna tiada');
  var pw = janaKataSementara(), salt = janaSalt();
  dalamKunci(function () {
    kemasKiniBaris('Pengguna', u._r, { Salt: salt, Hash: hashPassword(pw, salt), PerluTukarKata: 'YA' });
    tulisAudit({ email: 'editor', peranan: 'admin' }, '', 'KATA_RESET', '', '', u.Email);
  });
  Logger.log('Kata laluan sementara ' + u.Email + ': ' + pw);
  return { emel: u.Email, katalaluanSementara: pw };
}

function tetapAktif(email, aktif) {
  var u = cariPengguna(email); if (!u) throw new Error('Pengguna tiada');
  dalamKunci(function () {
    kemasKiniBaris('Pengguna', u._r, { Aktif: aktif ? 'YA' : 'TIDAK' });
    tulisAudit({ email: 'editor', peranan: 'admin' }, '', aktif ? 'PENGGUNA_AKTIF' : 'PENGGUNA_NYAHAKTIF', '', '', u.Email);
  });
}
function nyahaktif(email) { tetapAktif(email, false); }
function aktifkan(email) { tetapAktif(email, true); }

function janaKataSementara() {
  var abjad = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789', by = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, Utilities.getUuid()), r = '';
  for (var i = 0; i < 12; i++) r += abjad.charAt(((by[i] + 256) % 256) % abjad.length);
  return r + 'a7';   // pastikan ada huruf dan nombor
}
