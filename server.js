'use strict';
// Flickr Photo Analyzer: local web app. Run: node server.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { Flickr } = require('./lib/flickr');
const { store, readJSON, writeJSON } = require('./lib/store');
const sync = require('./lib/sync');
const { analyze, isUntitled, takenDate, LICENSES } = require('./lib/analyze');
const changes = require('./lib/changes');
const social = require('./lib/social');

const ROOT = __dirname;
const CONFIG_FILE = path.join(ROOT, 'config.json');
const PUBLIC = path.join(ROOT, 'public');

let config = readJSON(CONFIG_FILE, {}) || {};
config.apiKey = process.env.FLICKR_API_KEY || config.apiKey || '';
config.apiSecret = process.env.FLICKR_API_SECRET || config.apiSecret || '';
const PORT = Number(process.env.PORT || config.port || 5177);
const HOST = '127.0.0.1';
const BASE = `http://127.0.0.1:${PORT}`;

const pendingTokens = new Map(); // request token -> secret

// ---------- checking for changes ----------
// On startup (and every few hours while running) re-sync each cached account. The cached data is
// shown straight away; the check runs in the background and the page updates when it finishes.
const RECHECK_MIN_AGE = 10 * 60 * 1000; // skip accounts synced in the last 10 minutes
const RECHECK_EVERY = 3 * 60 * 60 * 1000;
let checking = false;
async function checkForChanges(reason) {
  if (checking || config.autoRefresh === false || !config.apiKey) return;
  checking = true;
  try {
    const auth = store.auth.get();
    const users = store.listUsers().sort((a, b) => (b.nsid === auth?.nsid) - (a.nsid === auth?.nsid));
    for (const m of users) {
      const own = !!(auth && auth.nsid === m.nsid);
      if (m.own && !own) continue; // signed out: don't overwrite private data with public-only data
      if (Date.now() - (m.lastSync || 0) < RECHECK_MIN_AGE || sync.isRunning(m.nsid, 'sync')) continue;
      try {
        await sync.fullSync(client(true), m.nsid, { own, reason });
        await sync.waitFor(m.nsid, 'sync');
        const j = sync.getJobs(m.nsid).sync;
        console.log(`  ${m.realname || m.username}: ${j?.error ? 'check failed: ' + j.error : j?.message}`);
      } catch (e) { console.error('  Check failed for', m.nsid, e.message); }
    }
  } finally { checking = false; }
}

function client(withAuth = true) {
  const auth = withAuth ? store.auth.get() : null;
  return new Flickr({ apiKey: config.apiKey, apiSecret: config.apiSecret, token: auth?.token, tokenSecret: auth?.tokenSecret });
}

// ---------- helpers ----------
function send(res, status, body, headers = {}) {
  const isBuf = Buffer.isBuffer(body) || typeof body === 'string';
  res.writeHead(status, { 'Content-Type': isBuf ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(isBuf ? body : JSON.stringify(body));
}
const json = (res, body, status = 200) => send(res, status, body);
const fail = (res, status, message) => send(res, status, { error: message });
function redirect(res, to) { res.writeHead(302, { Location: to }); res.end(); }

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };
function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC)) return fail(res, 403, 'Forbidden');
  fs.readFile(file, (err, buf) => {
    if (err) return fail(res, 404, 'Not found');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}

function htmlPage(title, body) {
  return `<!doctype html><meta charset="utf-8"><title>${title}</title><style>body{font:15px system-ui;background:#0f1117;color:#e6e8ef;display:grid;place-items:center;height:100vh;margin:0}div{max-width:520px;padding:24px;border:1px solid #2a2f3d;border-radius:12px;background:#161a23}a{color:#8b9cff}</style><div>${body}</div>`;
}
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Cache analysis per user, keyed on the files' modification times.
const analysisCache = new Map();
function mtime(f) { try { return fs.statSync(f).mtimeMs; } catch { return 0; } }
function getAnalysis(nsid) {
  const u = store.user(nsid);
  const key = ['photos', 'albums', 'exif', 'stats', 'profile'].map(n => mtime(path.join(u.dir, n + '.json'))).join('|');
  const hit = analysisCache.get(nsid);
  if (hit && hit.key === key) return hit.value;
  const value = analyze({
    photos: u.get('photos') || [], albums: u.get('albums') || [], exif: u.get('exif') || {},
    stats: u.get('stats'), profile: u.get('profile'),
  });
  value.meta = u.get('meta');
  analysisCache.set(nsid, { key, value });
  return value;
}

function photoUrl(profile, id) { return `https://www.flickr.com/photos/${profile?.pathAlias || profile?.nsid}/${id}/`; }

// ---------- movies, Explore, activity ----------
const contactsRecentCache = new Map();
const median = a => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const DAY_MS = 86400000;

function getMovies(nsid) {
  const u = store.user(nsid);
  const photos = u.get('photos') || [];
  const info = u.get('videos') || {};
  const profile = u.get('profile');
  const now = Date.now() / 1000;
  const vids = photos.filter(p => p.media === 'video').map(p => ({
    ...p, duration: info[p.id]?.duration || null, url: photoUrl(profile, p.id),
    perDay: p.views / Math.max(1, (now - p.uploaded) / 86400),
  }));
  const stills = photos.filter(p => p.media !== 'video');
  const byYear = {};
  for (const v of vids) { const y = new Date(v.uploaded * 1000).getFullYear(); (byYear[y] ||= { key: String(y), count: 0, views: 0 }); byYear[y].count++; byYear[y].views += v.views; }
  const lengths = [[0, 15, 'Under 15s'], [15, 60, '15–60s'], [60, 180, '1–3 min'], [180, 600, '3–10 min'], [600, 1e9, '10 min+']]
    .map(([a, b, key]) => { const g = vids.filter(v => v.duration != null && v.duration >= a && v.duration < b); return { key, count: g.length, medianViews: median(g.map(v => v.views)) }; });
  return {
    count: vids.length,
    views: vids.reduce((s, v) => s + v.views, 0), faves: vids.reduce((s, v) => s + v.faves, 0), comments: vids.reduce((s, v) => s + v.comments, 0),
    runtime: vids.reduce((s, v) => s + (v.duration || 0), 0), withDuration: vids.filter(v => v.duration != null).length,
    medianViews: median(vids.map(v => v.views)), photoMedianViews: median(stills.map(p => p.views)),
    faveRate: (() => { const v = vids.reduce((s, x) => s + x.views, 0); return v ? vids.reduce((s, x) => s + x.faves, 0) / v : 0; })(),
    photoFaveRate: (() => { const v = stills.reduce((s, x) => s + x.views, 0); return v ? stills.reduce((s, x) => s + x.faves, 0) / v : 0; })(),
    byYear: Object.values(byYear).sort((a, b) => a.key.localeCompare(b.key)),
    lengths,
    items: vids.sort((a, b) => b.views - a.views).map(({ desc, mtags, ...v }) => v),
  };
}

function getExplored(nsid) {
  const u = store.user(nsid);
  const photos = u.get('photos') || [];
  const cache = u.get('explore');
  const { all, todo } = social.exploreDays(photos, cache);
  const profile = u.get('profile');
  const byId = new Map(photos.map(p => [p.id, p]));
  const first = new Map();
  for (const h of social.exploreHits(cache)) { const f = first.get(h.id); if (!f || h.date < f.date) first.set(h.id, h); }
  const items = [...first.values()].map(h => {
    const p = byId.get(h.id);
    if (!p) return null;
    const { desc, mtags, ...rest } = p;
    return { ...rest, exploreDate: h.date, rank: h.rank, daysAfter: Math.round((Date.parse(h.date + 'T12:00:00Z') / 1000 - p.uploaded) / 86400), url: photoUrl(profile, p.id) };
  }).filter(Boolean).sort((a, b) => b.exploreDate.localeCompare(a.exploreDate));
  const ids = new Set(items.map(i => i.id));
  const others = photos.filter(p => p.ispublic && !ids.has(p.id));
  const byYear = {};
  for (const i of items) { const y = i.exploreDate.slice(0, 4); byYear[y] = (byYear[y] || 0) + 1; }
  return {
    scanned: !!cache, lastScan: cache?.lastScan || null,
    daysTotal: all.length, daysChecked: all.length - todo.length, daysLeft: todo.length,
    minutesLeft: Math.ceil((todo.length * 1.2) / 60),
    count: items.length,
    medianViews: median(items.map(i => i.views)), otherMedianViews: median(others.map(p => p.views)),
    medianFaves: median(items.map(i => i.faves)), otherMedianFaves: median(others.map(p => p.faves)),
    bestRank: items.length ? Math.min(...items.map(i => i.rank)) : null,
    byYear: Object.entries(byYear).sort().map(([key, count]) => ({ key, count })),
    items,
  };
}

// Fave/comment totals gained over the window, from the daily snapshots. Works for any account,
// but only as far back as snapshots go.
function activityFromSnapshots(u, hours) {
  const base = changes.baseline(u, Math.max(1, Math.round(hours / 24)));
  const d = changes.diff(u.get('photos') || [], base);
  return d ? { faves: d.faves, comments: d.comments, views: d.views, date: d.date, approx: d.approx } : null;
}

// ---------- explorer query ----------
function queryPhotos(nsid, q) {
  const u = store.user(nsid);
  let photos = u.get('photos') || [];
  const exif = u.get('exif') || {};
  const now = Date.now() / 1000;
  const text = (q.q || '').toLowerCase().trim();
  if (text) photos = photos.filter(p => p.title.toLowerCase().includes(text) || p.desc.toLowerCase().includes(text) || p.tags.some(t => t.includes(text)));
  if (q.tag) photos = photos.filter(p => p.tags.includes(q.tag.toLowerCase()));
  if (q.year) photos = photos.filter(p => { const t = takenDate(p); return t && String(t.y) === q.year; });
  if (q.uyear) photos = photos.filter(p => p.uploaded && String(new Date(p.uploaded * 1000).getFullYear()) === q.uyear);
  if (q.album) {
    const a = (u.get('albums') || []).find(x => x.id === q.album);
    const set = new Set(a ? a.members : []);
    photos = photos.filter(p => set.has(p.id));
  }
  if (q.camera) photos = photos.filter(p => exif[p.id] && exif[p.id].camera === q.camera);
  if (q.media) photos = photos.filter(p => p.media === q.media);
  if (q.privacy === 'public') photos = photos.filter(p => p.ispublic);
  if (q.privacy === 'private') photos = photos.filter(p => !p.ispublic);
  if (q.minViews) photos = photos.filter(p => p.views >= Number(q.minViews));
  const issue = {
    untitled: p => isUntitled(p), noTags: p => !p.tags.length, fewTags: p => p.tags.length > 0 && p.tags.length < 4,
    noDesc: p => !p.desc.trim(), noAlbum: p => p.albums === 0, noGeo: p => p.lat == null, noDate: p => !takenDate(p),
    private: p => !p.ispublic && !p.isfriend && !p.isfamily, allRights: p => p.license === '0', zeroViews: p => p.views === 0,
    geo: p => p.lat != null,
  }[q.issue];
  if (issue) photos = photos.filter(issue);
  if (q.issue === 'dupTitle') {
    const c = new Map();
    for (const p of u.get('photos') || []) { const t = p.title.trim().toLowerCase(); if (t && !isUntitled(p)) c.set(t, (c.get(t) || 0) + 1); }
    photos = photos.filter(p => c.get(p.title.trim().toLowerCase()) > 1);
  }
  const keyFn = {
    views: p => p.views, faves: p => p.faves, comments: p => p.comments, uploaded: p => p.uploaded,
    taken: p => p.taken || '', title: p => p.title.toLowerCase(), tags: p => p.tags.length,
    velocity: p => p.views / Math.max(1, (now - p.uploaded) / 86400), faveRate: p => (p.views >= 20 ? p.faves / p.views : -1),
  }[q.sort || 'views'] || (p => p.views);
  const dir = q.dir === 'asc' ? 1 : -1;
  photos = [...photos].sort((a, b) => { const x = keyFn(a), y = keyFn(b); return (x < y ? -1 : x > y ? 1 : 0) * dir || (b.views - a.views); });
  const per = Math.min(500, Math.max(10, Number(q.per) || 100));
  const page = Math.max(1, Number(q.page) || 1);
  const items = photos.slice((page - 1) * per, page * per).map(p => ({
    id: p.id, title: p.title, thumb: p.thumb, img: p.img, views: p.views, faves: p.faves, comments: p.comments,
    uploaded: p.uploaded, taken: p.taken, tags: p.tags.length, albums: p.albums, ispublic: p.ispublic, media: p.media,
    geo: p.lat != null, velocity: Math.round((p.views / Math.max(1, (now - p.uploaded) / 86400)) * 100) / 100,
  }));
  return { total: photos.length, page, per, pages: Math.ceil(photos.length / per), items };
}

function csvCell(v) { const s = String(v ?? ''); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
function exportCsv(nsid) {
  const u = store.user(nsid);
  const photos = u.get('photos') || [], exif = u.get('exif') || {}, profile = u.get('profile');
  const cols = ['id', 'title', 'url', 'media', 'views', 'faves', 'comments', 'uploaded', 'taken', 'tags', 'tag_count', 'albums', 'public', 'license', 'latitude', 'longitude', 'width', 'height', 'camera', 'lens', 'focal_mm', 'aperture', 'iso', 'shutter_s'];
  const rows = [cols.join(',')];
  for (const p of photos) {
    const e = exif[p.id] || {};
    rows.push([p.id, p.title, photoUrl(profile, p.id), p.media, p.views, p.faves, p.comments,
      p.uploaded ? new Date(p.uploaded * 1000).toISOString() : '', p.taken, p.tags.join(' '), p.tags.length, p.albums,
      p.ispublic ? 'yes' : 'no', LICENSES[p.license] || p.license, p.lat ?? '', p.lon ?? '', p.w || '', p.h || '',
      e.camera, e.lens, e.focal, e.aperture, e.iso, e.shutter].map(csvCell).join(','));
  }
  return '﻿' + rows.join('\r\n');
}

async function lookupUser(f, query) {
  const q = String(query || '').trim();
  if (!q) throw new Error('Enter a Flickr username, profile URL or NSID');
  if (/^\d+@N\d+$/.test(q)) return q;
  if (/flickr\.com|flic\.kr/i.test(q)) {
    const r = await f.call('flickr.urls.lookupUser', { url: q.startsWith('http') ? q : 'https://' + q }, { auth: false });
    return r.user.id;
  }
  try { return (await f.call('flickr.people.findByUsername', { username: q }, { auth: false })).user.nsid; } catch {}
  const r = await f.call('flickr.urls.lookupUser', { url: `https://www.flickr.com/photos/${encodeURIComponent(q)}/` }, { auth: false });
  return r.user.id;
}

// ---------- routes ----------
async function handle(req, res) {
  const url = new URL(req.url, BASE);
  const p = url.pathname;
  const q = Object.fromEntries(url.searchParams);
  const auth = store.auth.get();
  const isOwn = nsid => !!(auth && auth.nsid === nsid);

  // OAuth: browser redirect flow
  if (p === '/auth/login') {
    if (!config.apiKey || !config.apiSecret) return redirect(res, '/#/setup');
    const f = client(false);
    let rt;
    try { rt = await f.requestToken(`${BASE}/auth/callback`); }
    catch (e) {
      return send(res, 502, htmlPage('Sign-in failed', `<h2>Couldn't start the Flickr sign-in</h2><p>${esc(e.message)}</p><p>Check your internet connection and your API key, then <a href="/#/setup">try again</a>.</p>`), { 'Content-Type': 'text/html; charset=utf-8' });
    }
    pendingTokens.set(rt.token, rt.tokenSecret);
    return redirect(res, f.authorizeUrl(rt.token, 'read'));
  }
  if (p === '/auth/callback') {
    const secret = pendingTokens.get(q.oauth_token);
    if (!secret || !q.oauth_verifier) {
      return send(res, 400, htmlPage('Login failed', `<h2>Sign-in didn't complete</h2><p>The sign-in link expired, was already used, or access wasn't approved. <a href="/auth/login">Try again</a> or go <a href="/#/setup">back to the app</a>.</p>`), { 'Content-Type': 'text/html; charset=utf-8' });
    }
    pendingTokens.delete(q.oauth_token);
    let at;
    try { at = await client(false).accessToken(q.oauth_token, q.oauth_verifier, secret); }
    catch (e) {
      return send(res, 502, htmlPage('Login failed', `<h2>Sign-in didn't complete</h2><p>${esc(e.message)}</p><p><a href="/auth/login">Try again</a> or go <a href="/#/setup">back to the app</a>.</p>`), { 'Content-Type': 'text/html; charset=utf-8' });
    }
    store.auth.set({ ...at, at: Date.now() });
    // Start the first sync straight away.
    try { await sync.fullSync(client(true), at.nsid, { own: true }); } catch {}
    return redirect(res, '/#/overview');
  }

  if (!p.startsWith('/api/')) return serveStatic(req, res, p);

  // OAuth: paste-the-code flow (for apps whose callback URL Flickr rejects)
  if (p === '/api/auth/code-start' && req.method === 'POST') {
    const f = client(false);
    const rt = await f.requestToken('oob');
    pendingTokens.set(rt.token, rt.tokenSecret);
    return json(res, { url: f.authorizeUrl(rt.token, 'read'), token: rt.token });
  }
  if (p === '/api/auth/code-finish' && req.method === 'POST') {
    const b = await readBody(req);
    const secret = pendingTokens.get(b.token);
    if (!secret) return fail(res, 400, 'That sign-in attempt expired. Start again.');
    const verifier = String(b.code || '').trim();
    const at = await client(false).accessToken(b.token, verifier, secret);
    pendingTokens.delete(b.token);
    store.auth.set({ ...at, at: Date.now() });
    try { await sync.fullSync(client(true), at.nsid, { own: true }); } catch {}
    return json(res, { ok: true, nsid: at.nsid });
  }
  if (p === '/api/logout' && req.method === 'POST') { store.auth.clear(); return json(res, { ok: true }); }

  if (p === '/api/status') {
    const users = store.listUsers();
    return json(res, {
      configured: !!(config.apiKey && config.apiSecret),
      keyFromEnv: !!process.env.FLICKR_API_KEY,
      callbackUrl: `${BASE}/auth/callback`,
      keyHint: config.apiKey ? config.apiKey.slice(0, 4) + '…' + config.apiKey.slice(-4) : null,
      auth: auth ? { nsid: auth.nsid, username: auth.username, fullname: auth.fullname } : null,
      users,
      autoRefresh: config.autoRefresh !== false,
      checking,
      jobs: Object.fromEntries(users.concat(auth ? [{ nsid: auth.nsid }] : []).map(x => [x.nsid, sync.getJobs(x.nsid)])),
    });
  }
  if (p === '/api/config' && req.method === 'POST') {
    const b = await readBody(req);
    const next = { ...readJSON(CONFIG_FILE, {}), apiKey: String(b.apiKey || '').trim(), apiSecret: String(b.apiSecret || '').trim(), port: PORT };
    if (!/^[0-9a-f]{32}$/i.test(next.apiKey)) return fail(res, 400, 'The key should be 32 characters (letters a–f and digits). Copy it from your Flickr app page.');
    if (!/^[0-9a-f]{16}$/i.test(next.apiSecret)) return fail(res, 400, 'The secret should be 16 characters (letters a–f and digits). Copy it from your Flickr app page.');
    const test = new Flickr(next);
    try { await test.requestToken('oob'); }
    catch (e) {
      const bad = /consumer_key_unknown|signature_invalid|invalid/i.test(e.message);
      return fail(res, 400, bad ? 'Flickr didn’t accept that key and secret. Check you copied both from the same app, with no extra characters.' : 'Couldn’t reach Flickr to check the key: ' + e.message);
    }
    const changed = next.apiKey !== config.apiKey;
    writeJSON(CONFIG_FILE, next);
    config = { ...config, ...next };
    if (changed) store.auth.clear(); // tokens belong to the old key
    return json(res, { ok: true });
  }

  if (p === '/api/prefs' && req.method === 'POST') {
    const b = await readBody(req);
    const next = { ...readJSON(CONFIG_FILE, {}) };
    if ('autoRefresh' in b) next.autoRefresh = config.autoRefresh = !!b.autoRefresh;
    writeJSON(CONFIG_FILE, next);
    return json(res, { ok: true });
  }
  if (p === '/api/check' && req.method === 'POST') {
    checkForChanges('opened');
    return json(res, { ok: true });
  }
  if (p === '/api/changes') {
    if (!q.nsid || !store.user(q.nsid).exists()) return fail(res, 404, 'No data for this account yet.');
    const u = store.user(q.nsid);
    const base = changes.baseline(u, q.since || 'last');
    const d = changes.diff(u.get('photos') || [], base);
    return json(res, { since: q.since || 'last', changes: d, history: u.get('history') || [], snapshots: u.listSnapshots(), lastSync: u.get('meta')?.lastSync });
  }
  if (p === '/api/lookup' && req.method === 'POST') {
    const b = await readBody(req);
    const f = client(true);
    const nsid = await lookupUser(f, b.query);
    const job = await sync.fullSync(f, nsid, { own: isOwn(nsid) });
    return json(res, { nsid, job });
  }
  if (p === '/api/sync' && req.method === 'POST') {
    const b = await readBody(req);
    const nsid = b.nsid || auth?.nsid;
    if (!nsid) return fail(res, 400, 'Sign in first');
    return json(res, await sync.fullSync(client(true), nsid, { own: isOwn(nsid), includeStats: b.stats !== false }));
  }
  if (p === '/api/exif' && req.method === 'POST') {
    const b = await readBody(req);
    if (!store.user(b.nsid).exists()) return fail(res, 400, 'Sync first');
    return json(res, await sync.exifScan(client(true), b.nsid, { own: isOwn(b.nsid), limit: Number(b.limit) || 0 }));
  }
  if (p === '/api/explore-scan' && req.method === 'POST') {
    const b = await readBody(req);
    if (!store.user(b.nsid).exists()) return fail(res, 400, 'Sync first');
    return json(res, await sync.exploreScan(client(true), b.nsid));
  }
  if (p === '/api/cancel' && req.method === 'POST') {
    const b = await readBody(req); sync.cancel(b.nsid, b.kind); return json(res, { ok: true });
  }
  if (p === '/api/jobs') return json(res, sync.getJobs(q.nsid));
  if (p === '/api/users' && req.method === 'DELETE') {
    if (!q.nsid) return fail(res, 400, 'nsid required');
    store.removeUser(q.nsid); analysisCache.delete(q.nsid); return json(res, { ok: true });
  }

  // Data endpoints
  const nsid = q.nsid;
  if (['/api/analysis', '/api/photos', '/api/photo', '/api/export.csv', '/api/albums', '/api/movies', '/api/groups', '/api/contacts', '/api/explored', '/api/activity'].includes(p)) {
    if (!nsid || !store.user(nsid).exists()) return fail(res, 404, 'No data for this account yet. Run a sync.');
  }
  if (p === '/api/movies') return json(res, getMovies(nsid));
  if (p === '/api/groups') {
    const g = store.user(nsid).get('groups');
    return json(res, { fetchedAt: g?.fetchedAt || null, own: isOwn(nsid), list: g?.list || null, profile: store.user(nsid).get('profile') });
  }
  if (p === '/api/contacts') {
    const u = store.user(nsid), c = u.get('contacts');
    const out = { fetchedAt: c?.fetchedAt || null, own: isOwn(nsid), list: c?.list || null, recent: null, recentError: null };
    if (isOwn(nsid)) {
      const hit = contactsRecentCache.get(nsid);
      if (hit && Date.now() - hit.fetchedAt < 10 * 60000 && !q.refresh) out.recent = hit;
      else {
        try { out.recent = await social.fetchContactsRecent(client(true)); contactsRecentCache.set(nsid, out.recent); }
        catch (e) { out.recentError = e.message; if (hit) out.recent = hit; }
      }
    }
    return json(res, out);
  }
  if (p === '/api/explored') return json(res, getExplored(nsid));
  if (p === '/api/activity') {
    const u = store.user(nsid);
    let a = u.get('activity');
    const own = isOwn(nsid);
    let error = null;
    if (own && (!a || Date.now() - a.fetchedAt > 15 * 60000 || q.refresh)) {
      try { a = await social.fetchActivity(client(true), a); u.set('activity', a); } catch (e) { error = e.message; }
    }
    const hours = Math.max(1, Math.min(24 * 400, Number(q.hours) || 24));
    const photosById = new Map((u.get('photos') || []).map(x => [x.id, x]));
    const w = a ? social.activityWindow(a.events, hours) : null;
    if (w) for (const ph of w.topPhotos) { const x = photosById.get(ph.id); if (x) Object.assign(ph, { thumb: x.thumb || ph.thumb, title: x.title, views: x.views, totalFaves: x.faves, totalComments: x.comments }); }
    const counts = a ? Object.fromEntries([24, 168, 336, 720].map(h => { const s = social.activityWindow(a.events, h); return [h, { faves: s.faves, comments: s.comments, people: s.people }]; })) : null;
    return json(res, { own, error, fetchedAt: a?.fetchedAt || null, since: a?.since || null, window: w, counts, changes: activityFromSnapshots(u, hours) });
  }
  if (p === '/api/analysis') return json(res, getAnalysis(nsid));
  if (p === '/api/photos') return json(res, queryPhotos(nsid, q));
  if (p === '/api/albums') return json(res, (store.user(nsid).get('albums') || []).map(({ members, ...a }) => a));
  if (p === '/api/export.csv') {
    return send(res, 200, exportCsv(nsid), { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="flickr-${nsid.replace('@', '_')}.csv"` });
  }
  if (p === '/api/photo') {
    const u = store.user(nsid);
    const photo = (u.get('photos') || []).find(x => x.id === q.id);
    if (!photo) return fail(res, 404, 'Photo not found');
    const profile = u.get('profile');
    const exifAll = u.get('exif') || {};
    const f = client(true);
    const own = isOwn(nsid);
    const out = { photo, url: photoUrl(profile, photo.id), exif: exifAll[photo.id] || null, favorites: null, albums: [], context: null };
    out.albums = (u.get('albums') || []).filter(a => a.members.includes(photo.id)).map(a => ({ id: a.id, title: a.title }));
    const tasks = [
      f.call('flickr.photos.getFavorites', { photo_id: photo.id, per_page: 50 }, { auth: own }).then(r => {
        out.favorites = { total: Number(r.photo.total), people: (r.photo.person || []).map(x => ({ nsid: x.nsid, username: x.username, realname: x.realname, date: Number(x.favedate), icon: Number(x.iconserver) > 0 ? `https://farm${x.iconfarm}.staticflickr.com/${x.iconserver}/buddyicons/${x.nsid}.jpg` : 'https://www.flickr.com/images/buddyicon.gif' })) };
      }).catch(() => {}),
      f.call('flickr.photos.getAllContexts', { photo_id: photo.id }, { auth: own }).then(r => {
        out.context = { groups: (r.pool || []).map(g => ({ id: g.id, title: g.title, url: g.url })), sets: (r.set || []).length };
      }).catch(() => {}),
    ];
    if (!out.exif && photo.media === 'photo') {
      tasks.push(f.call('flickr.photos.getExif', { photo_id: photo.id }, { auth: own }).then(r => {
        out.exif = sync.parseExif(r); exifAll[photo.id] = out.exif; u.set('exif', exifAll);
      }).catch(() => {}));
    }
    await Promise.all(tasks);
    return json(res, out);
  }
  return fail(res, 404, 'Unknown endpoint');
}

// Only answer requests for this app's own address, and only accept changes from its own pages.
// Stops other websites open in your browser from talking to the app (DNS rebinding / CSRF).
const OK_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`]);
function allowed(req) {
  if (!OK_HOSTS.has(String(req.headers.host || '').toLowerCase())) return false;
  if (req.method === 'GET' || req.method === 'HEAD') return true;
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser clients
  try { return OK_HOSTS.has(new URL(origin).host.toLowerCase()); } catch { return false; }
}

const server = http.createServer((req, res) => {
  if (!allowed(req)) return fail(res, 403, 'Requests from other sites are not allowed.');
  handle(req, res).catch(err => {
    console.error(err);
    if (!res.headersSent) fail(res, 500, err.message || 'Server error');
  });
});

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`\n  Flickr Photo Analyzer is running at ${BASE}\n  Press Ctrl+C to stop.\n`);
    const cached = store.listUsers();
    if (cached.length && config.autoRefresh !== false) {
      console.log(`  Showing cached data for ${cached.length} account(s); checking Flickr for changes…`);
      checkForChanges('startup');
    }
    setInterval(() => checkForChanges('scheduled'), RECHECK_EVERY).unref();
    if (!process.argv.includes('--no-open')) {
      const cmd = process.platform === 'win32' ? `start "" "${BASE}"` : process.platform === 'darwin' ? `open "${BASE}"` : `xdg-open "${BASE}"`;
      exec(cmd);
    }
  });
  server.on('error', e => {
    if (e.code === 'EADDRINUSE') { console.error(`Port ${PORT} is in use. Is the analyzer already running? Open ${BASE}`); process.exit(1); }
    throw e;
  });
}

module.exports = { server, queryPhotos, exportCsv, getAnalysis };
