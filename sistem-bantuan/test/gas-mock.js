/* Mock ringkas persekitaran Apps Script supaya Code.gs boleh dijalankan dan diuji di Node. */
'use strict';
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function bangun() {
  const sheets = {}, props = {}, cache = new Map(), files = {}, mails = [], logs = [];
  const bytesKeSigned = (buf) => Array.from(buf, (b) => (b > 127 ? b - 256 : b));
  const signedKeBuf = (arr) => Buffer.from(arr.map((b) => (b + 256) % 256));

  function Sheet(nama) { this.name = nama; this.rows = []; }
  Sheet.prototype.getLastRow = function () { return this.rows.length; };
  Sheet.prototype.getMaxRows = function () { return 1000; };
  Sheet.prototype.setFrozenRows = function () {};
  Sheet.prototype.protect = function () {
    return { setDescription() {}, addEditor() {}, removeEditors() {}, getEditors() { return []; } };
  };
  Sheet.prototype.appendRow = function (a) { this.rows.push(a.slice()); };
  Sheet.prototype.getRange = function (r, c, nr, nc) {
    const self = this; nr = nr || 1; nc = nc || 1;
    return {
      getValues() {
        const out = [];
        for (let i = 0; i < nr; i++) {
          const row = self.rows[r - 1 + i] || [];
          out.push(Array.from({ length: nc }, (_, j) => (row[c - 1 + j] === undefined ? '' : row[c - 1 + j])));
        }
        return out;
      },
      getValue() { return this.getValues()[0][0]; },
      setValues(v) {
        v.forEach((row, i) => {
          const rr = (self.rows[r - 1 + i] = self.rows[r - 1 + i] || []);
          row.forEach((x, j) => { rr[c - 1 + j] = x; });
        });
      },
      setNumberFormat() { return this; }
    };
  };

  const ctx = vm.createContext({
    console, Buffer, Date, Math, JSON, Object, Array, String, Number, isFinite, Error, Promise,
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ({
        getSheetByName: (n) => sheets[n] || null,
        insertSheet: (n) => (sheets[n] = new Sheet(n))
      })
    },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'SHA256' },
      getUuid: () => crypto.randomUUID(),
      computeDigest: (alg, s) => bytesKeSigned(crypto.createHash('sha256').update(s, 'utf8').digest()),
      base64Decode: (s) => {
        if (!/^[A-Za-z0-9+/=]*$/.test(s)) throw new Error('base64 tidak sah');
        return bytesKeSigned(Buffer.from(s, 'base64'));
      },
      base64Encode: (a) => signedKeBuf(a).toString('base64'),
      newBlob: (bytes, mime, name) => ({ bytes, mime, name, getBytes: () => bytes })
    },
    CacheService: {
      getScriptCache: () => ({
        get: (k) => (cache.has(k) ? cache.get(k) : null),
        put: (k, v) => { cache.set(k, String(v)); },
        remove: (k) => { cache.delete(k); }
      })
    },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    PropertiesService: {
      getScriptProperties: () => ({ getProperty: (k) => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = String(v); } })
    },
    DriveApp: {
      createFolder: () => ({ getId: () => 'FOLDER1' }),
      getFolderById: () => ({
        createFile: (blob) => {
          const id = 'F' + Object.keys(files).length;
          files[id] = { blob, trashed: false };
          return { getId: () => id };
        }
      }),
      getFileById: (id) => {
        if (!files[id]) throw new Error('fail tiada');
        return { setTrashed: (v) => { files[id].trashed = v; }, getBlob: () => ({ getBytes: () => files[id].blob.bytes }) };
      }
    },
    MailApp: { sendEmail: (o) => mails.push(o), getRemainingDailyQuota: () => 100 },
    ContentService: {
      MimeType: { JSON: 'JSON' },
      createTextOutput: (s) => ({ s, setMimeType() { return this; } })
    },
    ScriptApp: { getProjectTriggers: () => [], deleteTrigger() {}, newTrigger: () => ({ timeBased: () => ({ everyDays: () => ({ atHour: () => ({ create() {} }) }) }) }) },
    Session: { getEffectiveUser: () => ({ getEmail: () => 'pemilik@test' }) },
    Logger: { log: (m) => logs.push(String(m)) }
  });

  const kod = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8');
  vm.runInContext(kod, ctx, { filename: 'Code.gs' });

  const post = (obj) => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(obj) } }).s);
  return { ctx, sheets, props, cache, files, mails, logs, post };
}

module.exports = { bangun };
