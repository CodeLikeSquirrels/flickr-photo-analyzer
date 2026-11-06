'use strict';
// Tiny JSON file store under ./data
const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, '..', 'data');

function ensure(dir) { fs.mkdirSync(dir, { recursive: true }); return dir; }

function readJSON(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJSON(file, data) {
  ensure(path.dirname(file));
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}

function safeId(id) { return String(id).replace(/[^A-Za-z0-9@_-]/g, '_'); }

const userDir = nsid => path.join(DATA, 'users', safeId(nsid));

const store = {
  DATA,
  auth: {
    get: () => readJSON(path.join(DATA, 'auth.json')),
    set: v => writeJSON(path.join(DATA, 'auth.json'), v),
    clear: () => { try { fs.unlinkSync(path.join(DATA, 'auth.json')); } catch {} },
  },
  user(nsid) {
    const dir = userDir(nsid);
    return {
      dir,
      get: name => readJSON(path.join(dir, name + '.json')),
      set: (name, v) => writeJSON(path.join(dir, name + '.json'), v),
      exists: () => fs.existsSync(path.join(dir, 'photos.json')),
      // Daily per-photo count snapshots, one file per local date (YYYY-MM-DD).
      setSnapshot: (date, v) => writeJSON(path.join(dir, 'snapshots', date + '.json'), v),
      getSnapshot: date => readJSON(path.join(dir, 'snapshots', date + '.json')),
      listSnapshots: () => {
        try { return fs.readdirSync(path.join(dir, 'snapshots')).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).map(f => f.slice(0, 10)).sort(); } catch { return []; }
      },
      pruneSnapshots: keepAfter => {
        for (const d of store.user(nsid).listSnapshots()) if (d < keepAfter) { try { fs.unlinkSync(path.join(dir, 'snapshots', d + '.json')); } catch {} }
      },
    };
  },
  listUsers() {
    const root = path.join(DATA, 'users');
    if (!fs.existsSync(root)) return [];
    return fs.readdirSync(root)
      .map(d => readJSON(path.join(root, d, 'meta.json')))
      .filter(Boolean);
  },
  removeUser(nsid) {
    fs.rmSync(userDir(nsid), { recursive: true, force: true });
  },
};

module.exports = { store, readJSON, writeJSON };
