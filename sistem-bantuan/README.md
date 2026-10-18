# Sistem Permohonan Bantuan

Sistem semakan dan kelulusan permohonan bantuan untuk agensi. Kos persekitaran: RM0 (Google Sheets + Apps Script + Drive untuk backend, Netlify untuk frontend, GitHub untuk kod).

## Aliran

```
Pemohon hantar ──► Dihantar ──(penyemak ambil)──► Dalam Semakan ──┬─ Lengkap ──► Menunggu Kelulusan ──┬─ Lulus
  (dapat no. rujukan)                                              ├─ Tidak lengkap ► Dikembalikan     └─ Tolak
                                                                   └─ Tolak terus        │
                                                                        pemohon betulkan (14 hari) ──► Dalam Semakan
                                                                        lepas 14 hari ──► Luput
```

- Satu peringkat pelulus. Penyemak dan pelulus boleh **tolak terus** dengan sebab wajib.
- Penyemak ambil tugasan dari barisan (tiada tugasan tersangkut pada pegawai yang cuti; pentadbir boleh lepaskan ke barisan).
- Pemohon, penyemak dan pelulus mesti orang berbeza. Pelulus tidak boleh memutuskan permohonan yang dia semak sendiri.
- Pemohon boleh batal sebelum permohonan sampai ke pelulus.
- Setiap tindakan direkod dalam tab `Audit` (rantaian hash, boleh disahkan oleh pentadbir).

| Peranan | Boleh |
|---|---|
| pemohon | hantar, lihat permohonan sendiri, betulkan, batal |
| penyemak | ambil dari barisan, semak maklumat dan dokumen, kembalikan, tolak, hantar ke pelulus |
| pelulus | lihat yang menunggu, luluskan atau tolak |
| admin | lihat ringkasan (IC bertopeng, tiada dokumen), lepaskan tugasan tersangkut, baca dan sahkan audit. **Tidak boleh lulus/tolak.** |

## Struktur

```
apps-script/Code.gs, appsscript.json   backend (tampal ke Apps Script)
web/                                   frontend statik (Netlify)
netlify.toml                           publish dir, pengepala keselamatan, CSP
test/                                  ujian logik (52) dan ujian browser (18)
```

## Setup (kira-kira 20 minit)

1. **Google Sheet.** Cipta Sheet baharu (guna akaun yang agensi kawal, bukan akaun peribadi). `Extensions > Apps Script`.
2. **Backend.** Tampal `apps-script/Code.gs`. Di `Project Settings`, hidupkan "Show appsscript.json" dan tampal `appsscript.json`. Jalankan `setup()` dan beri kebenaran. Ia mencipta tab `Pengguna`, `Permohonan`, `Dokumen`, `Audit` serta folder Drive persendirian untuk dokumen.
3. **Pengguna.** Jalankan dari editor (satu demi satu):
   ```js
   tambahPengguna('admin@agensi.gov.my', 'Nama Admin', 'admin');
   tambahPengguna('siti@agensi.gov.my', 'Siti', 'penyemak');
   tambahPengguna('dato@agensi.gov.my', 'Dato', 'pelulus');
   tambahPengguna('ali@agensi.gov.my', 'Ali', 'pemohon');
   ```
   Kata laluan sementara keluar di Execution log. Beritahu secara terus kepada pengguna, kemudian kosongkan log. Mereka wajib tukar pada log masuk pertama. Fungsi lain: `resetKataLaluan(email)`, `nyahaktif(email)`, `aktifkan(email)`. Jalankan juga `pasangTrigger()` sekali (tutup permohonan yang melepasi tempoh pembetulan setiap hari).
4. **Deploy backend.** `Deploy > New deployment > Web app`. Execute as: **Me**. Who has access: **Anyone**. Semua tindakan tetap perlukan token sesi. Salin URL yang berakhir `/exec`. Setiap kali `Code.gs` diubah, buat deployment versi baharu.
5. **Frontend di Netlify.** `Add new site > Import from Git`, pilih repo. **Base directory: `sistem-bantuan`**. Di `Site settings > Environment variables` tambah `API_URL` = URL `/exec` tadi (netlify.toml memasukkannya ke `config.js` semasa build, jadi URL tak perlu masuk repo). Deploy.
6. Kembali ke Apps Script > `Project Settings > Script properties`, tambah `PORTAL_URL` = URL Netlify (untuk pautan dalam e-mel notifikasi).
7. Edit `NOTIS_PRIVASI` dalam `web/config.js`: lengkapkan perkataan dalam `[ ]` (tempoh simpanan, unit untuk dihubungi). Jenis bantuan dan had jumlah ada di `CFG` dalam `Code.gs`: ubah ikut skim sebenar.

## Ciri keselamatan

- Tiada tab dipublish ke web. Semua baca/tulis lalu `doPost` dengan token sesi (UUID rawak, tamat 6 jam, dibatalkan semasa logout). Peranan dan status aktif pengguna dibaca semula setiap request.
- Authorization di server. Permohonan yang tiada akses dijawab 404 (bukan 403) supaya kewujudannya tidak bocor.
- Kata laluan: salt per pengguna + SHA-256 berulang 1000 kali, minimum 10 aksara. Mesej login sama untuk e-mel tiada dan kata laluan salah. Had percubaan: 8 gagal setiap e-mel dalam 5 minit, ditambah had global.
- Muat naik: PDF/JPG/PNG sahaja (semak magic bytes, bukan nama fail), maksimum 3 fail dan 2 MB setiap satu. Fail disimpan berversi dalam Drive persendirian dan tidak pernah ditimpa. Setiap muat turun direkod.
- Input ditulis ke Sheet dengan neutralisasi formula (`=+-@`). Semua lajur teks supaya IC kekal `0` di depan. Frontend tidak guna `innerHTML`; CSP melarang skrip luar.
- E-mel notifikasi hanya mengandungi no. rujukan dan status, tiada data peribadi.
- Audit: setiap baris mengandungi hash rantaian, dan hash terakhir disimpan di Script Properties. Pentadbir boleh tekan "Sahkan integriti audit". Ia mengesan sel diubah, baris dipadam, dan rantaian dikira semula oleh orang yang hanya ada akses Sheet.

## Had dan perkara yang perlu anda tahu

- **Belum diuji pada Apps Script dan Google Sheets sebenar.** Ujian di sini guna mock (`test/gas-mock.js`) dan Chromium dengan backend mock. Semak sendiri sebelum guna: (a) tindak balas CORS Apps Script ke Netlify, (b) masa log masuk (1000 pusingan hash, jangkaan di bawah 2 saat tetapi tidak disahkan), (c) tulisan `appendRow` pada lajur format teks.
- **Pemilik Sheet dan folder Drive nampak semua data.** Lindungi akaun itu dengan 2FA dan jangan kongsi Sheet atau folder dengan sesiapa. Audit tidak boleh menghalang pemilik skrip daripada mengubah rekod dengan sengaja.
- Tiada imbasan malware pada fail muat naik. Pegawai perlu berhati-hati membuka dokumen.
- Setiap request membaca keseluruhan tab berkenaan. Untuk beberapa ribu permohonan setahun ia masih okay. Arkibkan ke Sheet baharu setiap tahun supaya ia kekal laju.
- Kuota e-mel Apps Script (akaun Google biasa) kecil. Lebih daripada itu, notifikasi senyap dilangkau (permohonan tetap berjalan).
- URL Web App boleh dihubungi sesiapa. Had percubaan hanya ada pada log masuk. Pertimbangkan had tambahan jika sistem terdedah kepada internet awam.
- **Dasar agensi.** Data disimpan di pelayan Google, Netlify dan GitHub di luar negara. Agensi kerajaan biasanya ada dasar keselamatan ICT dan pengkomputeran awan sektor awam. Setahu saya PDPA 2010 tidak terpakai kepada Kerajaan Persekutuan dan Negeri, tetapi tidak semua agensi (contoh badan berkanun) berada dalam pengecualian itu dan saya tidak pasti kes anda. Sahkan dengan unit ICT dan perundangan **sebelum** guna dengan data sebenar. Tempoh simpanan mengikut jadual pelupusan agensi.

## Ujian

```bash
node test/workflow.test.js                      # 52 ujian logik: status, akses, audit, sesi
NODE_PATH=$(npm root -g) node test/ui-smoke.js  # 18 langkah browser (perlu Playwright + Chromium)
```
