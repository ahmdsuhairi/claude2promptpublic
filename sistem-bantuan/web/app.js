'use strict';
(function () {
  const CONF = window.SB_CONFIG || {};
  const akar = document.getElementById('app');
  const S = {
    token: null, user: null,
    cfg: { jenisBantuan: [], maxFail: 3, maxMB: 2, hariPembetulan: 14 },
    view: { n: 'senarai' }, tertunda: null
  };
  try { S.token = sessionStorage.getItem('sb_token'); } catch (e) { /* sessionStorage tidak tersedia */ }

  const PERANAN = { pemohon: 'Pemohon', penyemak: 'Pegawai penyemak', pelulus: 'Pegawai pelulus', admin: 'Pentadbir' };
  const LABEL_TINDAKAN = {
    LOGIN: 'Log masuk', HANTAR: 'Permohonan dihantar', AMBIL: 'Diambil oleh penyemak', LEPAS: 'Dilepaskan ke barisan',
    KEMBALIKAN: 'Dikembalikan untuk pembetulan', BETULKAN: 'Pembetulan dihantar', HANTAR_PELULUS: 'Dihantar kepada pelulus',
    TOLAK_SEMAK: 'Ditolak oleh penyemak', LULUS: 'Diluluskan', TOLAK_LULUS: 'Ditolak oleh pelulus',
    BATAL: 'Dibatalkan oleh pemohon', LUPUT: 'Tempoh pembetulan tamat', DOKUMEN_LIHAT: 'Dokumen dilihat',
    TUKAR_KATA: 'Kata laluan ditukar', PENGGUNA_TAMBAH: 'Pengguna ditambah', KATA_RESET: 'Kata laluan direset',
    PENGGUNA_AKTIF: 'Pengguna diaktifkan', PENGGUNA_NYAHAKTIF: 'Pengguna dinyahaktifkan'
  };

  /* ---------- utiliti DOM (tiada innerHTML: semua data dimasukkan sebagai teks) ---------- */
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    kids.flat(Infinity).forEach((c) => {
      if (c == null || c === false) return;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    });
    Object.entries(attrs || {}).forEach(([k, v]) => {
      if (v === false || v == null) return;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'for') el.htmlFor = v;
      else if (k === 'value') el.value = v;
      else el.setAttribute(k, v === true ? '' : v);
    });
    return el;
  }

  const slug = (s) => String(s).toLowerCase().replace(/\s+/g, '-');
  const lencana = (st) => h('span', { class: 'lencana s-' + slug(st) }, st);
  const rm = (n) => 'RM ' + Number(n).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  function fmtTarikh(iso, denganMasa) {
    if (!iso) return '-';
    const d = new Date(iso);
    if (isNaN(d)) return String(iso);
    const p = {};
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Kuala_Lumpur', day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: false
    }).formatToParts(d).forEach((x) => { p[x.type] = x.value; });
    return p.day + '/' + p.month + '/' + p.year + (denganMasa ? ' ' + p.hour + ':' + p.minute : '');
  }
  const umur = (iso) => { const n = Math.floor((Date.now() - new Date(iso)) / 86400000); return n <= 0 ? 'Hari ini' : n + ' hari'; };

  function papar(kandungan) {
    akar.replaceChildren(kandungan);
    const t = akar.querySelector('h1, h2');
    if (t) { t.setAttribute('tabindex', '-1'); t.focus(); }
    window.scrollTo(0, 0);
    if (S.tertunda) { tunjuk(S.tertunda.jenis, S.tertunda.teks); S.tertunda = null; }
  }

  function tunjuk(jenis, teks) {
    const n = document.getElementById('notis');
    if (!n) return;
    n.replaceChildren();
    if (!teks) return;
    n.append(h('div', { class: 'notis ' + jenis, role: jenis === 'ralat' ? 'alert' : 'status' }, teks));
    n.scrollIntoView({ block: 'nearest' });
  }

  async function jalankan(btn, fn) {
    if (btn) { btn.disabled = true; btn.setAttribute('aria-busy', 'true'); }
    tunjuk('', '');
    try { return await fn(); }
    catch (e) { tunjuk('ralat', e.message || 'Ralat tidak dijangka'); }
    finally { if (btn && btn.isConnected) { btn.disabled = false; btn.removeAttribute('aria-busy'); } }
  }

  /* ---------- API ---------- */
  function simpanToken(t) {
    S.token = t;
    try { if (t) sessionStorage.setItem('sb_token', t); else sessionStorage.removeItem('sb_token'); } catch (e) { /* abaikan */ }
  }

  async function api(tindakan, data, opsyen) {
    if (!CONF.API_URL || /^GANTI/.test(CONF.API_URL)) throw new Error('API_URL belum ditetapkan dalam config.js');
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), (opsyen && opsyen.masa) || 60000);
    try {
      const r = await fetch(CONF.API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },   // elak preflight CORS pada Apps Script
        body: JSON.stringify(Object.assign({}, data, { tindakan: tindakan, token: S.token })),
        signal: ac.signal
      });
      const j = await r.json();
      if (!j.ok) {
        if (j.kod === 401 && tindakan !== 'LOGIN' && tindakan !== 'TUKAR_KATA') keluarLokal('Sesi tamat. Sila log masuk semula.');
        const e = new Error(j.mesej || 'Ralat'); e.kod = j.kod; throw e;
      }
      return j.data;
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('Permintaan mengambil masa terlalu lama. Cuba lagi.');
      if (e instanceof TypeError) throw new Error('Tidak dapat berhubung dengan pelayan. Semak sambungan internet.');
      throw e;
    } finally { clearTimeout(t); }
  }

  /* ---------- rangka halaman ---------- */
  function shell(kandungan) {
    return h('div', { class: 'rangka' },
      h('header', { class: 'atas' },
        h('div', { class: 'jenama' }, 'Sistem Permohonan Bantuan'),
        S.user && h('div', { class: 'pengguna' },
          h('span', {}, S.user.nama),
          h('span', { class: 'peranan' }, PERANAN[S.user.peranan] || S.user.peranan),
          h('button', { class: 'btn sekunder kecil', type: 'button', onclick: () => paparTukarKata(false) }, 'Tukar kata laluan'),
          h('button', { class: 'btn sekunder kecil', type: 'button', onclick: keluar }, 'Log keluar'))),
      h('main', {}, h('div', { id: 'notis' }), kandungan));
  }

  function medan(label, input, bantuan) {
    return h('div', { class: 'medan' }, h('label', { for: input.id }, label), input, bantuan && h('div', { class: 'bantuan' }, bantuan));
  }

  /* ---------- log masuk / tukar kata laluan ---------- */
  function paparLogin() {
    const emel = h('input', { id: 'emel', type: 'email', autocomplete: 'username', required: true });
    const kata = h('input', { id: 'kata', type: 'password', autocomplete: 'current-password', required: true });
    const btn = h('button', { class: 'btn utama', type: 'submit' }, 'Log masuk');
    papar(h('form', {
      class: 'kad',
      onsubmit: (e) => {
        e.preventDefault();
        jalankan(btn, async () => {
          const r = await api('LOGIN', { email: emel.value, katalaluan: kata.value });
          kata.value = '';
          simpanToken(r.token); S.user = r.pengguna; S.cfg = r.cfg;
          if (S.user.perluTukar) paparTukarKata(true); else { S.view = { n: 'senarai' }; muat(); }
        });
      }
    },
      h('h1', {}, 'Log masuk'),
      h('p', { class: 'senyap' }, 'Sistem Permohonan Bantuan'),
      h('div', { id: 'notis' }),
      medan('E-mel', emel), medan('Kata laluan', kata), btn));
  }

  function paparTukarKata(wajib) {
    const lama = h('input', { id: 'lama', type: 'password', autocomplete: 'current-password', required: true });
    const baru = h('input', { id: 'baru', type: 'password', autocomplete: 'new-password', required: true, minlength: 10 });
    const ulang = h('input', { id: 'ulang', type: 'password', autocomplete: 'new-password', required: true });
    const btn = h('button', { class: 'btn utama', type: 'submit' }, 'Simpan kata laluan');
    const bentuk = h('form', {
      class: 'kad',
      onsubmit: (e) => {
        e.preventDefault();
        jalankan(btn, async () => {
          if (baru.value !== ulang.value) throw new Error('Kata laluan baharu tidak sepadan.');
          const r = await api('TUKAR_KATA', { lama: lama.value, baru: baru.value });
          simpanToken(r.token); S.user.perluTukar = false;
          S.tertunda = { jenis: 'ok', teks: 'Kata laluan telah ditukar.' };
          S.view = { n: 'senarai' }; muat();
        });
      }
    },
      h('h1', {}, wajib ? 'Tetapkan kata laluan baharu' : 'Tukar kata laluan'),
      wajib && h('p', {}, 'Ini log masuk pertama anda. Tukar kata laluan sementara sebelum meneruskan.'),
      h('div', { id: 'notis' }),
      medan(wajib ? 'Kata laluan sementara' : 'Kata laluan semasa', lama),
      medan('Kata laluan baharu', baru, 'Sekurang-kurangnya 10 aksara, mengandungi huruf dan nombor.'),
      medan('Ulang kata laluan baharu', ulang),
      h('div', { class: 'baris' }, btn,
        !wajib && h('button', { class: 'btn sekunder', type: 'button', onclick: () => muat() }, 'Batal')),
      wajib && h('p', {}, h('button', { class: 'pautan', type: 'button', onclick: keluar }, 'Log keluar')));
    papar(bentuk);
  }

  async function keluar() {
    try { await api('LOGOUT', {}); } catch (e) { /* sesi mungkin sudah tamat */ }
    keluarLokal();
  }
  function keluarLokal(pesan) {
    simpanToken(null); S.user = null; S.view = { n: 'senarai' };
    if (pesan) S.tertunda = { jenis: 'ralat', teks: pesan };
    paparLogin();
  }

  /* ---------- navigasi & muat data ---------- */
  const pergi = (v) => { S.view = v; muat(); };

  async function muat() {
    if (!S.user) return paparLogin();
    akar.replaceChildren(shell(h('p', { class: 'muat' }, 'Memuatkan…')));   // bukan papar(): jangan habiskan S.tertunda
    try {
      const v = S.view;
      if (v.n === 'baharu') return papar(shell(paparBorang(null)));
      if (v.n === 'betulkan') return papar(shell(paparBorang(v.data)));
      if (v.n === 'butiran') return papar(shell(paparButiran(await api('BUTIRAN', { rujukan: v.rujukan }))));
      if (v.n === 'audit') return papar(shell(paparAudit(await api('AUDIT', { rujukan: v.rujukan || '' }), v.rujukan || '')));
      papar(shell(paparSenarai(await api('SENARAI', {}))));
    } catch (e) {
      if (!S.user) return;
      papar(shell(h('div', {},
        h('h1', {}, 'Tidak dapat memuatkan halaman'),
        h('button', { class: 'btn', type: 'button', onclick: () => pergi({ n: 'senarai' }) }, 'Cuba lagi'))));
      tunjuk('ralat', e.message);
    }
  }

  /* ---------- jadual ---------- */
  function jadual(tajuk, item, lajur, kosong) {
    if (!item || !item.length) return h('section', { class: 'seksyen' }, h('h2', {}, tajuk), h('p', { class: 'senyap' }, kosong || 'Tiada rekod.'));
    return h('section', { class: 'seksyen' },
      h('h2', {}, tajuk + ' (' + item.length + ')'),
      h('div', { class: 'bungkus' }, h('table', {},
        h('thead', {}, h('tr', {}, lajur.map((l) => h('th', { scope: 'col', class: l.num ? 'num' : '' }, l.t)))),
        h('tbody', {}, item.map((x) => h('tr', {}, lajur.map((l) => h('td', { class: l.num ? 'num' : '' }, l.r(x)))))))));
  }

  const bukaRuj = (x) => h('button', { class: 'pautan', type: 'button', onclick: () => pergi({ n: 'butiran', rujukan: x.rujukan }) }, x.rujukan);
  const L = {
    ruj: { t: 'Rujukan', r: bukaRuj },
    rujTeks: { t: 'Rujukan', r: (x) => x.rujukan },
    jenis: { t: 'Jenis', r: (x) => x.jenis },
    jumlah: { t: 'Jumlah', num: true, r: (x) => rm(x.jumlah) },
    status: { t: 'Status', r: (x) => lencana(x.status) },
    hantar: { t: 'Dihantar', r: (x) => fmtTarikh(x.tarikhHantar) },
    kemaskini: { t: 'Dikemas kini', r: (x) => fmtTarikh(x.tarikhKemaskini, true) },
    umur: { t: 'Menunggu', r: (x) => umur(x.tarikhHantar) },
    nama: { t: 'Pemohon', r: (x) => x.nama || '-' },
    penyemak: { t: 'Penyemak', r: (x) => x.penyemak || '-' },
    pelulus: { t: 'Pelulus', r: (x) => x.pelulus || '-' },
    ambil: {
      t: 'Tindakan', r: (x) => h('button', {
        class: 'btn kecil utama', type: 'button',
        onclick: (e) => jalankan(e.currentTarget, async () => {
          await api('AMBIL', { rujukan: x.rujukan });
          S.tertunda = { jenis: 'ok', teks: 'Tugasan ' + x.rujukan + ' diambil. Semak maklumat dan dokumen di bawah.' };
          pergi({ n: 'butiran', rujukan: x.rujukan });
        })
      }, 'Ambil')
    },
    lepas: {
      t: 'Tindakan', r: (x) => x.status === 'Dalam Semakan' ? h('button', {
        class: 'btn kecil sekunder', type: 'button',
        onclick: (e) => jalankan(e.currentTarget, async () => {
          await api('LEPAS', { rujukan: x.rujukan });
          S.tertunda = { jenis: 'ok', teks: x.rujukan + ' dilepaskan ke barisan.' };
          muat();
        })
      }, 'Lepaskan ke barisan') : ''
    }
  };

  function paparSenarai(d) {
    const p = S.user.peranan;
    if (p === 'pemohon') {
      return h('div', {},
        h('div', { class: 'bar' }, h('h1', {}, 'Permohonan saya'),
          h('button', { class: 'btn utama', type: 'button', onclick: () => pergi({ n: 'baharu' }) }, 'Permohonan baharu')),
        jadual('Senarai permohonan', d.saya, [L.ruj, L.jenis, L.jumlah, L.status, L.hantar, L.kemaskini], 'Anda belum menghantar sebarang permohonan.'));
    }
    if (p === 'penyemak') {
      return h('div', {},
        h('h1', {}, 'Tugasan semakan'),
        jadual('Tugasan saya', d.saya, [L.ruj, L.nama, L.jenis, L.jumlah, L.umur], 'Tiada tugasan. Ambil dari barisan di bawah.'),
        jadual('Barisan menunggu', d.barisan, [L.rujTeks, L.jenis, L.jumlah, L.umur, L.ambil], 'Tiada permohonan menunggu.'),
        jadual('Selesai saya kendalikan (50 terkini)', d.selesai, [L.ruj, L.nama, L.status, L.kemaskini]));
    }
    if (p === 'pelulus') {
      return h('div', {},
        h('h1', {}, 'Menunggu keputusan'),
        jadual('Menunggu kelulusan', d.barisan, [L.ruj, L.nama, L.jenis, L.jumlah, L.kemaskini], 'Tiada permohonan menunggu keputusan.'),
        jadual('Telah saya putuskan (50 terkini)', d.selesai, [L.ruj, L.nama, L.jumlah, L.status, L.kemaskini]));
    }
    return h('div', {},
      h('h1', {}, 'Pentadbir'),
      tabAdmin('permohonan'),
      jadual('Semua permohonan', d.semua, [L.ruj, L.jenis, L.jumlah, L.status, L.penyemak, L.pelulus, L.umur, L.lepas]));
  }

  function tabAdmin(aktif) {
    return h('div', { class: 'tab' },
      h('button', { class: 'btn sekunder', type: 'button', 'aria-pressed': String(aktif === 'permohonan'), onclick: () => pergi({ n: 'senarai' }) }, 'Permohonan'),
      h('button', { class: 'btn sekunder', type: 'button', 'aria-pressed': String(aktif === 'audit'), onclick: () => pergi({ n: 'audit' }) }, 'Jejak audit'));
  }

  function paparAudit(baris, rujukan) {
    const hasil = h('span', { class: 'hasil-audit', role: 'status' });
    const sahkan = h('button', {
      class: 'btn sekunder', type: 'button',
      onclick: (e) => jalankan(e.currentTarget, async () => {
        const r = await api('SAHKAN_AUDIT', {});
        hasil.textContent = r.ok ? 'Rantai audit sah (' + r.baris + ' rekod).' : 'TIDAK SAH: ' + r.masalah;
        hasil.style.color = r.ok ? 'var(--ok)' : 'var(--bahaya)';
      })
    }, 'Sahkan integriti audit');
    const cari = h('input', { id: 'cari', type: 'text', value: rujukan, placeholder: 'BTN-2026-XXXXXX', autocomplete: 'off' });
    return h('div', {},
      h('h1', {}, 'Pentadbir'),
      tabAdmin('audit'),
      h('section', { class: 'seksyen' },
        h('form', { class: 'baris', onsubmit: (e) => { e.preventDefault(); pergi({ n: 'audit', rujukan: cari.value.trim() }); } },
          h('label', { for: 'cari', class: 'label' }, 'Tapis mengikut rujukan'), cari,
          h('button', { class: 'btn sekunder', type: 'submit' }, 'Cari')),
        h('p', {}, sahkan, hasil)),
      jadual('Rekod audit (200 terkini)', baris, [
        { t: 'Masa', r: (x) => fmtTarikh(x.masa, true) },
        { t: 'Pengguna', r: (x) => x.pengguna + (x.peranan ? ' (' + x.peranan + ')' : '') },
        { t: 'Rujukan', r: (x) => x.rujukan || '-' },
        { t: 'Tindakan', r: (x) => LABEL_TINDAKAN[x.tindakan] || x.tindakan },
        { t: 'Status', r: (x) => x.statusBaru ? (x.statusLama ? x.statusLama + ' → ' : '') + x.statusBaru : '-' },
        { t: 'Catatan', r: (x) => x.catatan || '' }
      ]));
  }

  /* ---------- butiran permohonan ---------- */
  function muatTurun(d) {
    const bin = atob(d.data), u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    const url = URL.createObjectURL(new Blob([u], { type: d.mime }));
    const a = h('a', { href: url, download: d.nama });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  const TIND = {
    AMBIL: { t: 'Ambil tugasan', gaya: 'utama' },
    BETULKAN: { t: 'Betulkan permohonan', gaya: 'utama' },
    HANTAR_PELULUS: { t: 'Lengkap, hantar ke pelulus', gaya: 'utama', teks: { label: 'Catatan untuk pelulus (pilihan)', wajib: false } },
    LULUS: { t: 'Luluskan', gaya: 'utama', teks: { label: 'Catatan (pilihan)', wajib: false } },
    KEMBALIKAN: { t: 'Kembalikan untuk pembetulan', gaya: 'sekunder', teks: { label: 'Apa yang perlu dibetulkan oleh pemohon (wajib)', wajib: true } },
    TOLAK_SEMAK: { t: 'Tolak permohonan', gaya: 'bahaya', teks: { label: 'Sebab penolakan (wajib)', wajib: true } },
    TOLAK_LULUS: { t: 'Tolak permohonan', gaya: 'bahaya', teks: { label: 'Sebab penolakan (wajib)', wajib: true } },
    LEPAS: { t: 'Lepaskan ke barisan', gaya: 'sekunder', sahkan: 'Lepaskan tugasan ini ke barisan?' },
    BATAL: { t: 'Batalkan permohonan', gaya: 'bahaya', sahkan: 'Batalkan permohonan ini? Tindakan ini tidak boleh diundur.' }
  };

  function panelTindakan(b) {
    const ada = Object.keys(TIND).filter((k) => b.tindakan.indexOf(k) >= 0);
    if (!ada.length) return null;
    const ruang = h('div', {});
    const butang = h('div', { class: 'baris' });
    ada.forEach((k) => butang.append(h('button', {
      class: 'btn ' + TIND[k].gaya, type: 'button',
      onclick: () => (k === 'BETULKAN' ? pergi({ n: 'betulkan', data: b }) : buka(k))
    }, TIND[k].t)));

    function buka(k) {
      const c = TIND[k];
      const ta = c.teks ? h('textarea', { id: 'sebab', maxlength: 1000 }) : null;   // disahkan dalam JS supaya mesej dalam BM
      const sah = h('button', { class: 'btn ' + (c.gaya === 'bahaya' ? 'bahaya' : 'utama'), type: 'submit' }, 'Sahkan: ' + c.t);
      ruang.replaceChildren(h('form', {
        class: 'seksyen',
        onsubmit: (e) => {
          e.preventDefault();
          jalankan(sah, async () => {
            if (c.teks && c.teks.wajib && ta.value.trim().length < 5) throw new Error('Sila isi sebab (sekurang-kurangnya 5 aksara).');
            const r = await api(k, { rujukan: b.rujukan, sebab: ta ? ta.value : '' });
            S.tertunda = { jenis: 'ok', teks: 'Berjaya. Status ' + b.rujukan + ' kini: ' + r.status + '.' };
            pergi({ n: 'senarai' });
          });
        }
      },
        c.sahkan && h('p', {}, c.sahkan),
        ta && medan(c.teks.label, ta),
        h('div', { class: 'baris' }, sah,
          h('button', { class: 'btn sekunder', type: 'button', onclick: () => ruang.replaceChildren() }, 'Batal'))));
      if (ta) ta.focus(); else sah.focus();
    }
    return h('section', { class: 'seksyen' }, h('h2', {}, 'Tindakan'), butang, ruang);
  }

  function paparButiran(b) {
    const pegawai = S.user.peranan !== 'pemohon';
    const baris = [['No. rujukan', b.rujukan], ['Status', lencana(b.status)], ['Jenis bantuan', b.jenis], ['Jumlah dipohon', rm(b.jumlah)]];
    if (b.nama) baris.push(['Pemohon', b.nama]);
    baris.push(['No. kad pengenalan', b.noIC]);
    if (b.telefon) baris.push(['No. telefon', b.telefon]);
    if (b.emel) baris.push(['E-mel', b.emel]);
    baris.push(['Dihantar', fmtTarikh(b.tarikhHantar, true)], ['Dikemas kini', fmtTarikh(b.tarikhKemaskini, true)]);
    if (b.bilPembetulan) baris.push(['Bil. pembetulan', b.bilPembetulan]);
    if (pegawai && b.penyemak) baris.push(['Penyemak', b.penyemak]);
    if (pegawai && b.pelulus) baris.push(['Pelulus', b.pelulus]);
    if (b.status === 'Dikembalikan' && b.tarikhLuput) baris.push(['Pembetulan sebelum', fmtTarikh(b.tarikhLuput, true)]);
    if (b.sebab) {
      const lbl = { Dikembalikan: 'Sebab dikembalikan', Ditolak: 'Sebab penolakan', Lulus: 'Catatan pelulus' }[b.status] || 'Catatan';
      baris.push([lbl, h('span', { class: 'pra' }, b.sebab)]);
    }

    return h('div', {},
      h('div', { class: 'bar' }, h('h1', {}, b.rujukan),
        h('button', { class: 'btn sekunder', type: 'button', onclick: () => pergi({ n: 'senarai' }) }, 'Kembali ke senarai')),
      panelTindakan(b),
      h('section', { class: 'seksyen' }, h('h2', {}, 'Maklumat permohonan'),
        h('dl', { class: 'butir' }, baris.map(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])),
        b.butiran && h('div', {}, h('h2', {}, 'Butiran'), h('p', { class: 'pra' }, b.butiran))),
      b.dokumen && b.dokumen.length ? h('section', { class: 'seksyen' }, h('h2', {}, 'Dokumen sokongan'),
        h('ul', { class: 'dok' }, b.dokumen.map((d) => h('li', {},
          h('span', {}, d.nama), h('span', { class: 'senyap' }, 'Versi ' + d.versi + ', ' + fmtTarikh(d.masa, true)),
          h('button', {
            class: 'btn kecil sekunder', type: 'button',
            onclick: (e) => jalankan(e.currentTarget, async () => muatTurun(await api('DOKUMEN', { rujukan: b.rujukan, id: d.id })))
          }, 'Muat turun'))))) : null,
      h('section', { class: 'seksyen' }, h('h2', {}, 'Sejarah'),
        h('ol', { class: 'garis' }, (b.sejarah || []).map((s) => h('li', {},
          h('div', { class: 'masa' }, fmtTarikh(s.masa, true) + (s.oleh ? ' oleh ' + s.oleh : '')),
          h('div', {}, LABEL_TINDAKAN[s.tindakan] || s.tindakan),
          s.catatan && h('div', { class: 'pra senyap' }, s.catatan))))));
  }

  /* ---------- borang permohonan / pembetulan ---------- */
  const bacaFail = (f) => new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res({ nama: f.name, data: String(r.result).split(',')[1] || '' });
    r.onerror = () => rej(new Error('Gagal membaca fail ' + f.name));
    r.readAsDataURL(f);
  });

  function paparBorang(awal) {
    const betulkan = !!awal;
    const jenis = h('select', { id: 'jenis', required: true }, S.cfg.jenisBantuan.map((j) => h('option', { value: j }, j)));
    if (betulkan) jenis.value = awal.jenis;
    const jumlah = h('input', { id: 'jumlah', type: 'number', min: '0.01', step: '0.01', required: true, value: betulkan ? awal.jumlah : '' });
    const ic = h('input', { id: 'ic', type: 'text', inputmode: 'numeric', autocomplete: 'off', required: true, maxlength: 14, placeholder: '900101-14-5678', value: betulkan ? awal.noIC : '' });
    const tel = h('input', { id: 'tel', type: 'tel', autocomplete: 'tel', required: true, maxlength: 15, value: betulkan ? awal.telefon : '' });
    const butiran = h('textarea', { id: 'butiran', required: true, minlength: 10, maxlength: 2000 });
    if (betulkan) butiran.value = awal.butiran || '';
    const fail = h('input', { id: 'fail', type: 'file', multiple: true, accept: '.pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png', required: !betulkan });
    const setuju = h('input', { id: 'setuju', type: 'checkbox' });
    const btn = h('button', { class: 'btn utama', type: 'submit' }, betulkan ? 'Hantar pembetulan' : 'Hantar permohonan');

    return h('form', {
      onsubmit: (e) => {
        e.preventDefault();
        jalankan(btn, async () => {
          const fs = Array.from(fail.files);
          if (fs.length > S.cfg.maxFail) throw new Error('Maksimum ' + S.cfg.maxFail + ' dokumen.');
          fs.forEach((f) => { if (f.size > S.cfg.maxMB * 1048576) throw new Error('Fail "' + f.name + '" melebihi ' + S.cfg.maxMB + ' MB.'); });
          if (!betulkan && !setuju.checked) throw new Error('Sila tanda persetujuan terhadap notis privasi.');
          const data = {
            jenis: jenis.value, jumlah: jumlah.value, noIC: ic.value, telefon: tel.value,
            butiran: butiran.value, fail: await Promise.all(fs.map(bacaFail))
          };
          if (betulkan) {
            await api('BETULKAN', Object.assign(data, { rujukan: awal.rujukan }), { masa: 120000 });
            S.tertunda = { jenis: 'ok', teks: 'Pembetulan dihantar. Permohonan kembali kepada penyemak.' };
          } else {
            data.persetujuan = true;
            const r = await api('HANTAR', data, { masa: 120000 });
            S.tertunda = { jenis: 'ok', teks: 'Permohonan dihantar. No. rujukan anda: ' + r.rujukan + '. Simpan nombor ini.' };
          }
          pergi({ n: 'senarai' });
        });
      }
    },
      h('div', { class: 'bar' }, h('h1', {}, betulkan ? 'Betulkan ' + awal.rujukan : 'Permohonan baharu'),
        h('button', { class: 'btn sekunder', type: 'button', onclick: () => pergi(betulkan ? { n: 'butiran', rujukan: awal.rujukan } : { n: 'senarai' }) }, 'Batal')),
      betulkan && awal.sebab && h('div', { class: 'notis info' }, h('strong', {}, 'Sebab dikembalikan: '), h('span', { class: 'pra' }, awal.sebab)),
      h('section', { class: 'seksyen' },
        medan('Jenis bantuan', jenis),
        h('div', { class: 'grid2' },
          medan('Jumlah dipohon (RM)', jumlah),
          medan('No. telefon', tel)),
        medan('No. kad pengenalan', ic, '12 digit. Tanda sengkang boleh diabaikan.'),
        medan('Butiran permohonan', butiran, 'Terangkan keperluan anda (10 hingga 2000 aksara).'),
        medan(betulkan ? 'Dokumen baharu (pilihan)' : 'Dokumen sokongan', fail,
          'PDF, JPG atau PNG. Sehingga ' + S.cfg.maxFail + ' fail, setiap satu maksimum ' + S.cfg.maxMB + ' MB.' +
          (betulkan ? ' Dokumen lama kekal disimpan.' : ''))),
      !betulkan && h('section', { class: 'seksyen' },
        h('h2', {}, 'Notis privasi'),
        h('div', { class: 'notisprivasi' }, CONF.NOTIS_PRIVASI || ''),
        h('div', { class: 'semak' }, setuju, h('label', { for: 'setuju' }, 'Saya telah membaca dan bersetuju dengan notis privasi di atas.'))),
      btn);
  }

  /* ---------- mula ---------- */
  async function mula() {
    if (!S.token) return paparLogin();
    try {
      const r = await api('ME', {});
      S.user = r.pengguna; S.cfg = r.cfg;
      if (S.user.perluTukar) paparTukarKata(true); else muat();
    } catch (e) { if (S.user === null && !document.getElementById('emel')) paparLogin(); }
  }
  mula();
})();
