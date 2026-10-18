/* Ujian asap UI: Chromium sebenar + backend mock + CSP sama seperti netlify.toml.
   Jalankan: NODE_PATH=$(npm root -g) node test/ui-smoke.js  [folder-tangkapan-skrin] */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { chromium } = require('playwright');
const { bangun } = require('./gas-mock');

const SKRIN = process.argv[2] || null;
const WEB = path.join(__dirname, '..', 'web');
const toml = fs.readFileSync(path.join(__dirname, '..', 'netlify.toml'), 'utf8');
const CSP = toml.match(/Content-Security-Policy = "([^"]+)"/)[1];

const E = bangun();
E.ctx.setup();
const SEMENTARA = 'Sementara123', BARU = 'RahsiaBaru12345';
const U = { p: 'ali@agensi.gov.my', s: 'siti@agensi.gov.my', l: 'dato@agensi.gov.my', a: 'admin@agensi.gov.my' };
E.ctx.tambahPengguna(U.p, 'Ali bin Abu', 'pemohon', SEMENTARA);
E.ctx.tambahPengguna(U.s, 'Siti Penyemak', 'penyemak', SEMENTARA);
E.ctx.tambahPengguna(U.l, 'Dato Pelulus', 'pelulus', SEMENTARA);
E.ctx.tambahPengguna(U.a, 'Admin Sistem', 'admin', SEMENTARA);

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };
const pelayan = http.createServer((req, res) => {
  const hdr = { 'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' };
  if (req.method === 'POST' && req.url === '/api') {
    let b = ''; req.on('data', (c) => { b += c; });
    req.on('end', () => { res.writeHead(200, Object.assign({ 'Content-Type': 'application/json' }, hdr)); res.end(E.ctx.doPost({ postData: { contents: b } }).s); });
    return;
  }
  if (req.url === '/config.js') {
    const asal = fs.readFileSync(path.join(WEB, 'config.js'), 'utf8').replace('GANTI_DENGAN_URL_WEB_APP', '/api');
    res.writeHead(200, Object.assign({ 'Content-Type': 'text/javascript' }, hdr)); return res.end(asal);
  }
  const f = path.join(WEB, req.url === '/' ? 'index.html' : req.url.split('?')[0]);
  if (!f.startsWith(WEB) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, Object.assign({ 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }, hdr));
  res.end(fs.readFileSync(f));
});

(async () => {
  await new Promise((r) => pelayan.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + pelayan.address().port + '/';
  const pelayar = await chromium.launch({ executablePath: process.env.CHROME_BIN || undefined });
  const ralatKonsol = [];
  let bil = 0;
  const langkah = (n) => { bil++; console.log('  ok   ' + n); };

  async function sesi(emel, katalaluan, tukar) {
    const ctx = await pelayar.newContext({ viewport: { width: 1100, height: 800 }, acceptDownloads: true });
    const page = await ctx.newPage();
    page.on('console', (m) => { if (m.type() === 'error') ralatKonsol.push(emel + ': ' + m.text()); });
    page.on('pageerror', (e) => ralatKonsol.push(emel + ' pageerror: ' + e.message));
    await page.goto(base);
    await page.fill('#emel', emel); await page.fill('#kata', katalaluan);
    await page.click('button[type=submit]');
    if (tukar) {
      await page.waitForSelector('#baru');
      await page.fill('#lama', katalaluan); await page.fill('#baru', BARU); await page.fill('#ulang', BARU);
      await page.click('button[type=submit]');
    }
    await page.waitForSelector('header .pengguna');
    return { ctx, page };
  }
  const skrin = async (page, nama) => { if (SKRIN) await page.screenshot({ path: path.join(SKRIN, nama + '.png'), fullPage: true }); };

  try {
    console.log('Pemohon');
    let { ctx: cp, page: p } = await sesi(U.p, SEMENTARA, true);
    assert.ok(await p.locator('text=Anda belum menghantar sebarang permohonan').isVisible()); langkah('log masuk pertama, tukar kata laluan, senarai kosong');
    await skrin(p, '01-pemohon-kosong');

    await p.click('text=Permohonan baharu');
    await p.selectOption('#jenis', 'Bantuan Perubatan');
    await p.fill('#jumlah', '2500.50'); await p.fill('#tel', '012-3456789'); await p.fill('#ic', '900101-14-5678');
    await p.fill('#butiran', 'Memerlukan bantuan kos rawatan susulan di hospital.');
    await p.setInputFiles('#fail', { name: 'laporan perubatan.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n%test\n') });
    await skrin(p, '02-borang');
    await p.click('button[type=submit]');
    await p.waitForSelector('text=Sila tanda persetujuan');
    langkah('borang disekat tanpa persetujuan notis privasi');
    await p.check('#setuju'); await p.click('button[type=submit]');
    await p.waitForSelector('.notis.ok');
    const mesej = await p.textContent('.notis.ok');
    const ruj = mesej.match(/BTN-\d{4}-[A-Z2-9]{6}/)[0];
    assert.ok(await p.locator('tbody tr', { hasText: ruj }).locator('.s-dihantar').isVisible()); langkah('permohonan dihantar: ' + ruj);
    await skrin(p, '03-pemohon-senarai');
    await p.click('text=Log keluar'); await p.waitForSelector('#emel'); langkah('log keluar');
    await cp.close();

    console.log('Penyemak');
    ({ ctx: cp, page: p } = await sesi(U.s, SEMENTARA, true));
    const barisan = p.locator('section', { has: p.locator('h2', { hasText: 'Barisan menunggu' }) });
    assert.ok(await barisan.locator('text=' + ruj).isVisible());
    assert.ok(!(await barisan.textContent()).includes('Ali bin Abu')); langkah('nampak barisan; nama pemohon tersembunyi sebelum ambil');
    await skrin(p, '04-penyemak-barisan');
    await barisan.locator('button', { hasText: 'Ambil' }).click();
    await p.waitForSelector('dl.butir');
    const teks = await p.textContent('main');
    assert.ok(teks.includes('900101145678') && teks.includes('Ali bin Abu') && teks.includes('Dalam Semakan')); langkah('ambil tugasan; IC dan nama kini kelihatan');
    await skrin(p, '05-penyemak-butiran');
    const [dl] = await Promise.all([p.waitForEvent('download'), p.click('text=Muat turun')]);
    assert.match(dl.suggestedFilename(), /^laporan_perubatan\.pdf$/); langkah('muat turun dokumen berfungsi di bawah CSP (' + dl.suggestedFilename() + ')');
    await p.click('button:has-text("Kembalikan untuk pembetulan")');
    await p.click('button:has-text("Sahkan: Kembalikan")');
    await p.waitForSelector('text=sekurang-kurangnya 5 aksara'); langkah('kembalikan tanpa sebab ditolak');
    await p.fill('#sebab', 'Laporan perubatan tidak mengandungi tarikh. Sila muat naik versi lengkap.');
    await p.click('button:has-text("Sahkan: Kembalikan")');
    await p.waitForSelector('.notis.ok'); langkah('dikembalikan dengan sebab');
    await cp.close();

    console.log('Pemohon betulkan');
    ({ ctx: cp, page: p } = await sesi(U.p, BARU, false));
    await p.locator('tbody tr', { hasText: ruj }).locator('.s-dikembalikan').waitFor();
    await p.click('text=' + ruj);
    await p.waitForSelector('text=Laporan perubatan tidak mengandungi tarikh');
    await skrin(p, '06-pemohon-dikembalikan');
    await p.click('button:has-text("Betulkan permohonan")');
    await p.setInputFiles('#fail', { name: 'laporan lengkap.png', mimeType: 'image/png', buffer: Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.alloc(30)]) });
    await p.click('button[type=submit]');
    await p.waitForSelector('.notis.ok');
    assert.ok(await p.locator('tbody tr', { hasText: ruj }).locator('.s-dalam-semakan').isVisible()); langkah('pembetulan dihantar; kembali Dalam Semakan');
    await cp.close();

    console.log('Penyemak hantar, pelulus putuskan');
    ({ ctx: cp, page: p } = await sesi(U.s, BARU, false));
    await p.click('text=' + ruj);
    await p.waitForSelector('text=Versi 2');
    assert.equal(await p.locator('ul.dok li').count(), 2); langkah('dokumen lama (v1) dan baharu (v2) kedua-duanya ada');
    await p.click('button:has-text("Lengkap, hantar ke pelulus")');
    await p.fill('#sebab', 'Dokumen lengkap, layak.');
    await p.click('button:has-text("Sahkan: Lengkap")');
    await p.waitForSelector('.notis.ok'); langkah('dihantar ke pelulus');
    await cp.close();

    ({ ctx: cp, page: p } = await sesi(U.l, SEMENTARA, true));
    await p.click('text=' + ruj);
    await p.waitForSelector('dl.butir');
    assert.equal(await p.locator('button:has-text("Luluskan")').count(), 1);
    assert.equal(await p.locator('button:has-text("Tolak permohonan")').count(), 1); langkah('pelulus nampak butang Luluskan dan Tolak terus');
    await skrin(p, '07-pelulus-butiran');
    await p.click('button:has-text("Luluskan")');
    await p.click('button:has-text("Sahkan: Luluskan")');
    await p.waitForSelector('.notis.ok'); langkah('diluluskan');
    await cp.close();

    console.log('Pemohon lihat keputusan, admin audit');
    ({ ctx: cp, page: p } = await sesi(U.p, BARU, false));
    await p.click('text=' + ruj);
    await p.waitForSelector('ol.garis');
    const sej = await p.textContent('ol.garis');
    assert.ok(sej.includes('Diluluskan') && sej.includes('Dikembalikan untuk pembetulan'));
    assert.ok(!sej.includes(U.s) && !sej.includes(U.l)); langkah('pemohon nampak sejarah penuh tanpa e-mel pegawai');
    await skrin(p, '08-pemohon-lulus');
    await cp.close();

    ({ ctx: cp, page: p } = await sesi(U.a, SEMENTARA, true));
    await p.waitForSelector('text=Semua permohonan');
    assert.ok(await p.locator('tbody tr', { hasText: ruj }).locator('.s-lulus').isVisible());
    await p.click('text=Jejak audit');
    await p.waitForSelector('text=Rekod audit');
    await p.click('text=Sahkan integriti audit');
    await p.waitForSelector('text=Rantai audit sah');
    langkah('admin: jejak audit dan pengesahan integriti');
    await skrin(p, '09-admin-audit');
    await p.setViewportSize({ width: 390, height: 800 });
    await p.getByRole('button', { name: 'Permohonan', exact: true }).click();
    await p.waitForSelector('text=Semua permohonan');
    const lebihan = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(lebihan <= 1, 'skrol mendatar halaman pada 390px: ' + lebihan); langkah('paparan 390px tanpa skrol mendatar halaman');
    await skrin(p, '10-admin-mobil');
    await cp.close();

    const csp = ralatKonsol.filter((x) => /Content Security Policy|Refused/i.test(x));
    assert.equal(csp.length, 0, 'pelanggaran CSP: ' + csp.join(' | '));
    assert.equal(ralatKonsol.length, 0, 'ralat konsol: ' + ralatKonsol.join(' | ')); langkah('tiada ralat konsol / pelanggaran CSP');
    console.log('\n' + bil + ' langkah lulus');
  } catch (e) {
    console.log('\nGAGAL: ' + (e.stack || e)); if (ralatKonsol.length) console.log('Konsol:\n' + ralatKonsol.join('\n'));
    process.exitCode = 1;
  } finally { await pelayar.close(); pelayan.close(); }
})();
