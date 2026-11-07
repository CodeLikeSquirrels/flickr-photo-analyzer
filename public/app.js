'use strict';
/* Flickr Photo Analyzer — front end (vanilla JS, Chart.js, Leaflet) */

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const view = $('#view');
const state = { status: null, nsid: null, data: null, charts: [], map: null, page: 'overview', params: {}, poll: null, wasRunning: false };

// ---------- utils ----------
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = n => (n == null || Number.isNaN(n) ? '–' : Math.round(Number(n)).toLocaleString());
const fmt1 = n => (n == null ? '–' : Number(n).toLocaleString(undefined, { maximumFractionDigits: 1 }));
function compact(n) {
  if (n == null) return '–';
  const a = Math.abs(n);
  if (a >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
  if (a >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (a >= 1e4) return (n / 1e3).toFixed(0) + 'k';
  if (a >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(Math.round(n));
}
const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);
const date = ts => (ts ? new Date(ts * 1000).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '–');
const ago = ms => { const s = (Date.now() - ms) / 1000; return s < 90 ? 'just now' : s < 5400 ? Math.round(s / 60) + ' min ago' : s < 129600 ? Math.round(s / 3600) + ' h ago' : Math.round(s / 86400) + ' days ago'; };
const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) }, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || 'Request failed (' + res.status + ')');
  return j;
}
function toast(msg, err = false) {
  const t = $('#toast'); t.textContent = msg; t.className = 'toast' + (err ? ' err' : ''); t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, err ? 7000 : 3500);
}
const isOwn = () => !!(state.status?.auth && state.status.auth.nsid === state.nsid);

// ---------- theme ----------
function applyTheme() {
  let t = 'system'; try { t = localStorage.getItem('theme') || 'system'; } catch {}
  if (t === 'system') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t;
  if (window.Chart) { Chart.defaults.color = css('--muted'); Chart.defaults.borderColor = css('--line'); Chart.defaults.font.family = getComputedStyle(document.body).fontFamily; }
}

// ---------- charts ----------
function destroyCharts() { state.charts.forEach(c => c.destroy()); state.charts = []; if (state.map) { state.map.remove(); state.map = null; } }
const PALETTE = ['#6d78ff', '#ff4f9a', '#3ecf8e', '#f5a524', '#4aa3ff', '#b67cff', '#ff7a45', '#2dd4bf', '#e879f9', '#a3e635'];
function chart(id, cfg) {
  const el = document.getElementById(id);
  if (!el || !window.Chart) return;
  cfg.options = Object.assign({ responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false }, plugins: {} }, cfg.options || {});
  cfg.options.plugins = Object.assign({ legend: { display: (cfg.data.datasets || []).length > 1, labels: { boxWidth: 10, boxHeight: 10 } } }, cfg.options.plugins);
  state.charts.push(new Chart(el, cfg));
}
function barChart(id, labels, data, { label = '', color = PALETTE[0], horizontal = false, fmtY = compact, extra = [] } = {}) {
  chart(id, {
    type: 'bar',
    data: { labels, datasets: [{ label, data, backgroundColor: color, borderRadius: 4, maxBarThickness: 46 }, ...extra] },
    options: {
      indexAxis: horizontal ? 'y' : 'x',
      scales: { [horizontal ? 'x' : 'y']: { ticks: { callback: v => fmtY(v) }, grid: { color: css('--line') } }, [horizontal ? 'y' : 'x']: { grid: { display: false } } },
      plugins: { tooltip: { callbacks: { label: c => `${c.dataset.label ? c.dataset.label + ': ' : ''}${fmt1(c.parsed[horizontal ? 'x' : 'y'])}` } } },
    },
  });
}
// count bars + median-views line on a second axis
function comboChart(id, rows, { countLabel = 'Photos', metric = 'medianViews', metricLabel = 'Median views' } = {}) {
  chart(id, {
    data: {
      labels: rows.map(r => r.key),
      datasets: [
        { type: 'line', label: metricLabel, data: rows.map(r => r[metric]), borderColor: PALETTE[1], backgroundColor: PALETTE[1], yAxisID: 'y1', tension: .3, pointRadius: 3 },
        { type: 'bar', label: countLabel, data: rows.map(r => r.count), backgroundColor: color(PALETTE[0], .55), borderRadius: 4, yAxisID: 'y', maxBarThickness: 46 },
      ],
    },
    options: {
      scales: {
        y: { position: 'left', ticks: { callback: compact }, title: { display: true, text: countLabel }, grid: { color: css('--line') } },
        y1: { position: 'right', ticks: { callback: compact }, title: { display: true, text: metricLabel }, grid: { display: false } },
        x: { grid: { display: false } },
      },
    },
  });
}
function color(hex, a) { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`; }

// ---------- photo tiles ----------
function tile(p, { rank, badge } = {}) {
  return `<div class="ph" data-id="${esc(p.id)}" title="${esc(p.title)}">
    ${p.thumb ? `<img loading="lazy" src="${esc(p.thumb)}" alt="">` : ''}
    ${rank ? `<span class="rank">#${rank}</span>` : ''}${badge ? `<span class="badge">${esc(badge)}</span>` : ''}
    <div class="meta"><div class="t">${esc(p.title || 'Untitled')}</div>👁 ${compact(p.views)} · ★ ${compact(p.faves)} · 💬 ${compact(p.comments)}</div></div>`;
}
document.addEventListener('click', e => {
  const ph = e.target.closest('[data-id]');
  if (ph && !e.target.closest('a')) openPhoto(ph.dataset.id);
});

// ---------- modal ----------
async function openPhoto(id) {
  const m = $('#modal');
  m.hidden = false;
  m.innerHTML = `<div class="mbox"><div class="pic"><span class="spin"></span></div><div class="info"><button class="close">×</button><span class="spin"></span> Loading…</div></div>`;
  m.querySelector('.close').onclick = closeModal;
  try {
    const r = await api(`/api/photo?nsid=${encodeURIComponent(state.nsid)}&id=${encodeURIComponent(id)}`);
    const p = r.photo, e = r.exif;
    const age = Math.max(1, (Date.now() / 1000 - p.uploaded) / 86400);
    const shutter = e?.shutter ? (e.shutter >= 1 ? e.shutter + 's' : '1/' + Math.round(1 / e.shutter) + 's') : null;
    m.innerHTML = `<div class="mbox">
      <div class="pic">${p.big || p.img ? `<img src="${esc(p.big || p.img)}" alt="">` : ''}</div>
      <div class="info"><button class="close" aria-label="Close">×</button>
        <h2 style="padding-right:30px">${esc(p.title || 'Untitled')}</h2>
        <div class="muted small">Uploaded ${date(p.uploaded)}${p.taken && !p.takenUnknown ? ' · Taken ' + esc(p.taken.slice(0, 10)) : ''} · ${p.ispublic ? 'Public' : 'Not public'}${p.media === 'video' ? ' · Video' : ''}</div>
        <div class="statrow">
          <div><b>${fmt(p.views)}</b><span>views</span></div>
          <div><b>${fmt(p.faves)}</b><span>faves</span></div>
          <div><b>${fmt(p.comments)}</b><span>comments</span></div>
          <div><b>${fmt1(p.views / age)}</b><span>views / day</span></div>
          <div><b>${p.views ? fmt1((p.faves / p.views) * 100) + '%' : '–'}</b><span>fave rate</span></div>
          <div><b>${p.albums}</b><span>albums</span></div>
        </div>
        <p><a class="btn sm primary" href="${esc(r.url)}" target="_blank" rel="noopener">Open on Flickr ↗</a></p>
        ${p.desc ? `<h3>Description</h3><p class="small muted" style="white-space:pre-wrap;max-height:120px;overflow:auto">${esc(p.desc.replace(/<[^>]+>/g, ''))}</p>` : ''}
        <h3>Tags (${p.tags.length})</h3>
        <div class="chips mb">${p.tags.map(t => `<a class="chip" href="#/explore?tag=${encodeURIComponent(t)}">${esc(t)}</a>`).join('') || '<span class="muted small">No tags</span>'}</div>
        ${r.albums.length ? `<h3>Albums</h3><div class="chips mb">${r.albums.map(a => `<a class="chip" href="#/explore?album=${a.id}">${esc(a.title)}</a>`).join('')}</div>` : ''}
        ${r.context?.groups?.length ? `<h3>In ${r.context.groups.length} groups</h3><div class="chips mb">${r.context.groups.map(g => `<a class="chip" target="_blank" rel="noopener" href="https://www.flickr.com${esc(g.url || '/groups/' + g.id)}">${esc(g.title)}</a>`).join('')}</div>` : ''}
        ${e ? `<h3>Camera</h3><dl class="kv mb">
          ${e.camera ? `<dt>Camera</dt><dd>${esc(e.camera)}</dd>` : ''}${e.lens ? `<dt>Lens</dt><dd>${esc(e.lens)}</dd>` : ''}
          ${e.focal ? `<dt>Focal length</dt><dd>${e.focal}mm${e.focal35 && e.focal35 !== e.focal ? ` (${e.focal35}mm equiv.)` : ''}</dd>` : ''}
          ${e.aperture ? `<dt>Aperture</dt><dd>f/${e.aperture}</dd>` : ''}${shutter ? `<dt>Shutter</dt><dd>${shutter}</dd>` : ''}${e.iso ? `<dt>ISO</dt><dd>${e.iso}</dd>` : ''}
          ${e.software ? `<dt>Software</dt><dd>${esc(e.software)}</dd>` : ''}</dl>` : ''}
        ${p.lat != null ? `<h3>Location</h3><p class="small"><a target="_blank" rel="noopener" href="https://www.openstreetmap.org/?mlat=${p.lat}&mlon=${p.lon}#map=13/${p.lat}/${p.lon}">${p.lat.toFixed(4)}, ${p.lon.toFixed(4)} ↗</a></p>` : ''}
        ${r.favorites ? `<h3>Faved by ${fmt(r.favorites.total)}${r.favorites.total > r.favorites.people.length ? ` (latest ${r.favorites.people.length})` : ''}</h3>
          <div class="faves">${r.favorites.people.map(f => `<a href="https://www.flickr.com/photos/${esc(f.nsid)}/" target="_blank" rel="noopener" title="${esc(f.realname || f.username)} · ${date(f.date)}"><img loading="lazy" src="${esc(f.icon)}" alt=""></a>`).join('')}</div>` : ''}
      </div></div>`;
    m.querySelector('.close').onclick = closeModal;
  } catch (err) {
    m.querySelector('.info').innerHTML = `<button class="close">×</button><p>${esc(err.message)}</p>`;
    m.querySelector('.close').onclick = closeModal;
  }
}
function closeModal() { const m = $('#modal'); m.hidden = true; m.innerHTML = ''; }
$('#modal').addEventListener('click', e => { if (e.target.id === 'modal') closeModal(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });
document.addEventListener('click', e => { if (e.target.closest('#modal a[href^="#"]')) closeModal(); });

// ---------- status, accounts, jobs ----------
async function loadStatus() {
  state.status = await api('/api/status');
  const users = state.status.users;
  let saved = null; try { saved = localStorage.getItem('nsid'); } catch {}
  const has = n => users.some(u => u.nsid === n);
  if (state.nsid && (has(state.nsid) || state.status.auth?.nsid === state.nsid)) {} // keep
  else if (saved && has(saved)) state.nsid = saved;
  else if (state.status.auth) state.nsid = state.status.auth.nsid;
  else state.nsid = users[0]?.nsid || null;
  renderAccount();
  renderJobs();
}
function selectAccount(nsid) {
  state.nsid = nsid; state.data = null;
  try { localStorage.setItem('nsid', nsid); } catch {}
  renderAccount(); renderJobs(); route();
}
function renderAccount() {
  const s = state.status, el = $('#acct');
  const users = [...s.users];
  if (s.auth && !users.some(u => u.nsid === s.auth.nsid)) users.unshift({ nsid: s.auth.nsid, username: s.auth.username, own: true });
  const cur = users.find(u => u.nsid === state.nsid);
  if (!users.length) { el.innerHTML = `<a class="btn primary" style="display:block;text-align:center" href="/auth/login">Sign in with Flickr</a>`; return; }
  el.innerHTML = `<div class="acctcard">${cur?.icon ? `<img src="${esc(cur.icon)}" alt="">` : ''}<div style="min-width:0"><b>${esc(cur?.realname || cur?.username || state.nsid)}</b>
    <span>${cur?.nsid === s.auth?.nsid ? 'Your account' : 'Public photos only'}${cur?.photoCount ? ' · ' + fmt(cur.photoCount) + ' items' : ''}</span></div></div>
    ${users.length > 1 ? `<select id="acctSel" style="margin-top:6px">${users.map(u => `<option value="${esc(u.nsid)}" ${u.nsid === state.nsid ? 'selected' : ''}>${esc(u.realname || u.username)}${u.nsid === s.auth?.nsid ? ' (you)' : ''}</option>`).join('')}</select>` : ''}`;
  const sel = $('#acctSel'); if (sel) sel.onchange = () => selectAccount(sel.value);
}
function jobsFor(nsid) { return (state.status?.jobs || {})[nsid] || {}; }
function anyRunning() { return Object.values(jobsFor(state.nsid)).some(j => j.running); }
function renderJobs() {
  const jobs = jobsFor(state.nsid);
  const parts = [];
  for (const j of Object.values(jobs)) {
    if (j.running) {
      const w = j.total ? Math.min(100, (j.done / j.total) * 100) : 5;
      const what = j.kind === 'exif' ? 'Camera scan' : j.kind === 'explore' ? 'Explore check' : j.incremental ? 'Checking for changes' : 'Syncing';
      parts.push(`<span><span class="spin"></span> ${what}${j.phase && j.phase !== what ? ': ' + esc(j.phase) : ''} ${j.total ? fmt(j.done) + ' / ' + fmt(j.total) : ''}</span><span class="progress"><i style="width:${w}%"></i></span>
        <button class="btn sm" data-cancel="${j.kind}">Stop</button>`);
    } else if (j.error && Date.now() - j.finishedAt < 600000) {
      parts.push(`<span class="down">${j.kind === 'exif' ? 'Camera scan' : j.kind === 'explore' ? 'Explore check' : 'Sync'} failed: ${esc(j.error)}</span>`);
    }
  }
  const meta = state.status?.users.find(u => u.nsid === state.nsid);
  if (!parts.length && meta) parts.push(`<span>Synced ${ago(meta.lastSync)}</span><button class="btn sm" id="syncBtn">Sync now</button>`);
  $('#jobbar').innerHTML = parts.join('');
  $$('[data-cancel]').forEach(b => b.onclick = () => api('/api/cancel', { method: 'POST', body: { nsid: state.nsid, kind: b.dataset.cancel } }));
  const sb = $('#syncBtn'); if (sb) sb.onclick = startSync;
  ensurePolling();
}
function ensurePolling() {
  const running = Object.values(state.status?.jobs || {}).some(js => Object.values(js).some(j => j.running));
  if (running && !state.poll) state.poll = setInterval(pollJobs, 1500);
  if (!running && state.poll) { clearInterval(state.poll); state.poll = null; }
}
async function pollJobs() {
  const before = anyRunning();
  const prevExif = jobsFor(state.nsid).exif?.done || 0;
  try { state.status = await api('/api/status'); } catch { return; }
  const after = anyRunning();
  renderJobs();
  if (before && !after) {
    renderAccount();
    const j = jobsFor(state.nsid);
    if (j.sync && !j.sync.error && j.sync.finishedAt > Date.now() - 5000) toast(j.sync.message || 'Sync finished');
    state.data = null; route();
  } else if (after && state.page === 'explored' && Date.now() - (state.lastExRefresh || 0) > 15000) {
    state.lastExRefresh = Date.now(); pageExplored();
  } else if (after && state.page === 'cameras' && (jobsFor(state.nsid).exif?.done || 0) - prevExif > 0 && Date.now() - (state.lastCamRefresh || 0) > 15000) {
    state.lastCamRefresh = Date.now(); state.data = null; route(true);
  } else if (!state.data && after && !state.status.users.some(u => u.nsid === state.nsid)) {
    if (['overview'].includes(state.page)) route(true);
  }
}
async function startSync() {
  try { await api('/api/sync', { method: 'POST', body: { nsid: state.nsid } }); state.status = await api('/api/status'); renderJobs(); toast('Sync started'); }
  catch (e) { toast(e.message, true); }
}

// ---------- routing ----------
const PAGES = { movies: () => pageMovies(), explored: () => pageExplored(), groups: () => pageGroups(), contacts: () => pageContacts(), activity: () => pageActivity(), overview: pageOverview, top: pageTop, recent: pageRecent, timing: pageTiming, tags: pageTags, map: pageMap, albums: pageAlbums, cameras: pageCameras, health: pageHealth, explore: pageExplore, settings: pageSettings };
async function route(keepScroll = false) {
  const h = location.hash.replace(/^#\/?/, '') || 'overview';
  const [page, qs] = h.split('?');
  state.page = PAGES[page] ? page : 'overview';
  state.params = Object.fromEntries(new URLSearchParams(qs || ''));
  $$('#nav a').forEach(a => a.classList.toggle('on', a.dataset.page === state.page));
  $('#side').classList.remove('open');
  const y = window.scrollY;
  const s = state.status;
  document.body.classList.toggle('setup-mode', !s.configured);
  if (h.startsWith('setup')) { destroyCharts(); state.page = 'setup'; return pageSetup(); }
  if (state.page === 'settings') { destroyCharts(); return pageSettings(); }
  if (!s.configured || !state.nsid) { location.replace('#/setup'); return; }
  const hasData = s.users.some(u => u.nsid === state.nsid);
  if (!hasData) { destroyCharts(); return pageWaiting(); }
  if (!state.data || state.data.meta?.nsid !== state.nsid || state.data._nsid !== state.nsid) {
    if (!keepScroll) view.innerHTML = `<div class="empty"><span class="spin"></span> Crunching numbers…</div>`;
    try { state.data = await api('/api/analysis?nsid=' + encodeURIComponent(state.nsid)); state.data._nsid = state.nsid; }
    catch (e) { view.innerHTML = `<div class="empty"><p>${esc(e.message)}</p></div>`; return; }
  }
  destroyCharts();
  try { PAGES[state.page](state.data); } catch (e) { console.error(e); view.innerHTML = `<div class="empty"><p>Something went wrong drawing this page: ${esc(e.message)}</p></div>`; }
  if (keepScroll) window.scrollTo(0, y); else window.scrollTo(0, 0);
}
window.addEventListener('hashchange', () => route());
$('#menuBtn').onclick = () => $('#side').classList.toggle('open');

// ---------- pages ----------
function header(title, sub, right = '') {
  return `<div class="spread"><div><h1>${title}</h1>${sub ? `<p class="sub" style="margin:0">${sub}</p>` : ''}</div><div class="row">${right}</div></div>`;
}
function kpi(label, value, sub = '', cls = '') { return `<div class="card kpi"><div class="l">${label}</div><div class="v ${cls}">${value}</div>${sub ? `<div class="d">${sub}</div>` : ''}</div>`; }

// ---------- first-run setup: API key, then sign in ----------
const KEY_RE = /\b[0-9a-f]{32}\b/i, SECRET_RE = /\b[0-9a-f]{16}\b/i;
const APP_DESC = 'Personal, non-commercial tool that runs on my own computer and shows statistics about my own Flickr photos (views, faves, tags, upload timing). Read-only.';
function setupStep() {
  const s = state.status;
  const want = Number(state.params.step) || 0;
  if (!s.configured) return want === 2 ? 2 : 1;
  if ((want === 1 || want === 2) && !s.keyFromEnv) return want;
  return 3;
}
function pageSetup() {
  const s = state.status;
  const step = setupStep();
  const names = ['Get an API key', 'Enter your key', 'Sign in to Flickr'];
  const stepper = `<ol class="stepper">${names.map((n, i) => {
    const k = i + 1, done = k < step || (k < 3 && s.configured && step !== k);
    return `<li class="${k === step ? 'on' : ''} ${done ? 'done' : ''}"><span class="num">${done ? '✓' : k}</span><span>${n}</span></li>`;
  }).join('')}</ol>`;
  let body = '';
  if (step === 1) body = `
    <div class="card setup">
      <h2>Step 1: Get a free Flickr API key</h2>
      <p>Flickr asks every app to use its own key. It's free, takes about two minutes, and you only do it once. The key stays on this computer.</p>
      <ol class="howto">
        <li><b>Open Flickr's “Create an app” page</b> and sign in with your Flickr account if asked.
          <div><a class="btn primary" href="https://www.flickr.com/services/apps/create/apply/" target="_blank" rel="noopener">Open Flickr ↗</a></div></li>
        <li>Click <b>Apply for a non-commercial key</b>.</li>
        <li>Fill in the form. Anything sensible works, for example:
          <div class="copyrow"><span class="small muted">Name</span><code>My Photo Analyzer</code><button class="btn sm" data-copy="My Photo Analyzer">Copy</button></div>
          <div class="copyrow"><span class="small muted">Description</span><code>${esc(APP_DESC)}</code><button class="btn sm" data-copy="${esc(APP_DESC)}">Copy</button></div></li>
        <li>Tick the two boxes to agree to Flickr's terms, then click <b>Submit</b>.</li>
        <li>Flickr shows your <b>Key</b> and <b>Secret</b>. Keep that page open: you'll paste both in the next step.</li>
      </ol>
      <p class="small muted">Already made one? Find it under <a href="https://www.flickr.com/services/apps/by/me" target="_blank" rel="noopener">Your apps ↗</a> on Flickr and open it to see its key and secret.</p>
      <div class="row" style="justify-content:flex-end"><a class="btn primary" href="#/setup?step=2">I have my key and secret →</a></div>
    </div>`;
  else if (step === 2) body = `
    <div class="card setup">
      <h2>Step 2: Enter your key and secret</h2>
      <p>Copy them from the Flickr page that appeared after you submitted the form. Tip: you can select the whole Flickr page, copy it, and paste it into either box. The app picks out both values.</p>
      <form id="keyForm" class="grid" style="gap:12px">
        <label class="f">Key <span class="small muted">(32 characters)</span><input name="apiKey" id="kKey" autocomplete="off" spellcheck="false" placeholder="e.g. 1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d"><span class="hint" id="kKeyHint"></span></label>
        <label class="f">Secret <span class="small muted">(16 characters)</span><input name="apiSecret" id="kSecret" autocomplete="off" spellcheck="false" placeholder="e.g. 1a2b3c4d5e6f7a8b"><span class="hint" id="kSecretHint"></span></label>
        <p class="small muted" style="margin:0">Saved only on this computer, in <code>config.json</code> next to the app. Never share your secret or commit it to Git.</p>
        <div class="row" style="justify-content:space-between"><a class="btn" href="#/setup?step=1">← Back</a><button class="btn primary" id="kSave" disabled>Save and test</button></div>
      </form>
    </div>`;
  else body = `
    <div class="card setup">
      <h2>Step 3: Sign in to Flickr</h2>
      ${s.auth ? `<p>You're signed in as <b>${esc(s.auth.fullname || s.auth.username)}</b>.</p><div class="row"><a class="btn primary" href="#/overview" id="toOverview">Go to my photos →</a></div>` : `
      <p>Sign in so the app can read your photos, including private ones, and your daily stats.</p>
      <ul class="small muted plain">
        <li>✓ Flickr will ask you to allow <b>read</b> access. The app can't change, upload or delete anything.</li>
        <li>✓ After you click <b>OK, I'll authorize it</b>, Flickr sends you straight back here and the first sync starts.</li>
        <li>✓ You can revoke access any time on Flickr's <a href="https://www.flickr.com/services/auth/list.gne" target="_blank" rel="noopener">authorized apps page ↗</a>.</li>
      </ul>
      <div class="row"><a class="btn primary big" href="/auth/login">Sign in with Flickr</a></div>
      <details style="margin-top:16px"><summary class="small muted" style="cursor:pointer">Flickr showed a code instead of coming back here?</summary>
        <ol class="small muted"><li><button class="btn sm" id="codeStart" type="button">Open Flickr sign-in in a new tab</button></li><li>Approve access, copy the 9-digit code Flickr shows, and paste it here:</li></ol>
        <form id="codeForm" class="row"><input id="code" placeholder="123-456-789" style="flex:1"><button class="btn">Finish sign-in</button></form></details>`}
      ${s.keyFromEnv ? '' : `<p class="small muted" style="margin-top:14px">Using API key ${esc(s.keyHint)}. <a href="#/setup?step=2">Change key</a></p>`}
    </div>
    <div class="card setup">
      <h2>Just looking?</h2>
      <p class="small muted">Analyze any public Flickr account without signing in. Only public photos and counts are available.</p>
      <form id="pubForm" class="row"><input id="pubQ" placeholder="Username, profile URL or NSID" style="flex:1;min-width:200px"><button class="btn">Analyze</button></form>
    </div>`;
  view.innerHTML = `<div class="setupwrap">
    <div class="setuphead"><div class="dots" style="transform:scale(1.8);margin:10px"><i></i><i></i></div>
      <div><h1>Flickr Photo Analyzer</h1><p class="sub" style="margin:0">See which photos people love, when to post, which tags work, and how your views are trending.</p></div></div>
    ${stepper}${body}</div>`;

  $$('[data-copy]').forEach(b => b.onclick = async () => {
    try { await navigator.clipboard.writeText(b.dataset.copy); b.textContent = 'Copied'; setTimeout(() => b.textContent = 'Copy', 1500); } catch { toast('Copy failed: select the text instead', true); }
  });
  const kf = $('#keyForm');
  if (kf) {
    const key = $('#kKey'), sec = $('#kSecret');
    const check = () => {
      key.value = key.value.trim(); sec.value = sec.value.trim();
      const ok = (v, n) => new RegExp(`^[0-9a-f]{${n}}$`, 'i').test(v);
      const hint = (el, v, n) => { el.textContent = !v ? '' : ok(v, n) ? '✓ Looks right' : `${v.length} of ${n} characters${/[^0-9a-f]/i.test(v) ? ', and it has characters a key can\'t contain' : ''}`; el.className = 'hint ' + (!v ? '' : ok(v, n) ? 'good' : 'bad'); };
      hint($('#kKeyHint'), key.value, 32); hint($('#kSecretHint'), sec.value, 16);
      $('#kSave').disabled = !(ok(key.value, 32) && ok(sec.value, 16));
    };
    const smartPaste = e => {
      const t = (e.clipboardData || window.clipboardData)?.getData('text') || '';
      const lk = t.match(/key[^0-9a-f]{0,20}([0-9a-f]{32})/i), ls = t.match(/secret[^0-9a-f]{0,20}([0-9a-f]{16})\b/i);
      const k = lk?.[1] || t.match(KEY_RE)?.[0], sc = ls?.[1] || t.replace(KEY_RE, ' ').match(SECRET_RE)?.[0];
      if (t.trim().length > 40 && (k || sc)) { e.preventDefault(); if (k) key.value = k; if (sc) sec.value = sc; check(); toast(k && sc ? 'Found your key and secret' : k ? 'Found your key' : 'Found your secret'); }
    };
    key.oninput = sec.oninput = check; key.onpaste = sec.onpaste = smartPaste;
    key.focus();
    kf.onsubmit = async e => {
      e.preventDefault(); check(); if ($('#kSave').disabled) return;
      $('#kSave').disabled = true; $('#kSave').innerHTML = '<span class="spin"></span> Checking with Flickr…';
      try { await api('/api/config', { method: 'POST', body: { apiKey: key.value, apiSecret: sec.value } }); await loadStatus(); toast('Key saved and verified'); location.hash = '#/setup?step=3'; }
      catch (err) { toast(err.message, true); $('#kSave').textContent = 'Save and test'; check(); }
    };
  }
  let codeToken = null;
  const cs = $('#codeStart');
  if (cs) cs.onclick = async () => { try { const r = await api('/api/auth/code-start', { method: 'POST' }); codeToken = r.token; window.open(r.url, '_blank'); } catch (e) { toast(e.message, true); } };
  const cf = $('#codeForm');
  if (cf) cf.onsubmit = async e => {
    e.preventDefault();
    if (!codeToken) return toast('Click “Open Flickr sign-in” first', true);
    try { const r = await api('/api/auth/code-finish', { method: 'POST', body: { token: codeToken, code: $('#code').value } }); await loadStatus(); selectAccount(r.nsid); location.hash = '#/overview'; }
    catch (err) { toast(err.message, true); }
  };
  const to = $('#toOverview');
  if (to) to.onclick = () => selectAccount(s.auth.nsid);
  const pf = $('#pubForm'); if (pf) pf.onsubmit = addPublic;
}
async function addPublic(e) {
  e.preventDefault();
  const q = $('#pubQ').value.trim(); if (!q) return;
  const btn = e.target.querySelector('button'); btn.disabled = true;
  try {
    const r = await api('/api/lookup', { method: 'POST', body: { query: q } });
    state.status = await api('/api/status');
    selectAccount(r.nsid);
    location.hash = '#/overview';
  } catch (err) { toast(err.message, true); } finally { btn.disabled = false; }
}
function pageWaiting() {
  const j = jobsFor(state.nsid).sync;
  view.innerHTML = `<div class="empty"><div class="big">📷</div>
    ${j && j.running ? `<h2>Pulling your photos from Flickr…</h2><p class="muted">${esc(j.phase)} ${j.total ? fmt(j.done) + ' of ' + fmt(j.total) : ''}</p><p class="small muted">Large libraries take a minute or two. This page fills in when it's done.</p>`
    : j && j.error ? `<h2>Sync failed</h2><p class="down">${esc(j.error)}</p><button class="btn primary" id="retry">Try again</button>`
    : `<h2>No data yet</h2><p class="muted">Sync this account to start.</p><button class="btn primary" id="retry">Sync now</button>`}</div>`;
  const r = $('#retry'); if (r) r.onclick = startSync;
  if (j && j.running) setTimeout(() => { if (state.page !== 'settings' && !state.status.users.some(u => u.nsid === state.nsid)) pageWaiting(); }, 1500);
}

function pageOverview(d) {
  const o = d.overview, p = d.profile || {};
  view.innerHTML = `
    ${header(`${esc(p.realname || p.username || 'Overview')}`, `${fmt(o.items)} items · uploading since ${date(o.firstUpload)} · about ${fmt1(o.uploadsPerMonth)} uploads a month`,
      `<a class="btn" href="/api/export.csv?nsid=${encodeURIComponent(state.nsid)}">Export CSV</a>${p.photosurl ? `<a class="btn" target="_blank" rel="noopener" href="${esc(p.photosurl)}">Photostream ↗</a>` : ''}`)}
    <div class="kpis">
      ${kpi('Total views', compact(o.totalViews), fmt(o.totalViews))}
      ${kpi('Faves', compact(o.totalFaves), `${fmt1(o.faveRate)} per 1,000 views`)}
      ${kpi('Comments', compact(o.totalComments), `${fmt1(o.commentRate)} per 1,000 views`)}
      ${kpi('Median views', compact(o.medianViews), `average ${compact(o.avgViews)} · top 10% above ${compact(o.p90Views)}`)}
      ${kpi('Photos / videos', `${compact(o.photos)} / ${compact(o.videos)}`, `${fmt(o.public)} public · ${fmt(o.private + o.friendsFamily)} restricted`)}
      ${kpi('Albums', fmt(o.albums), `${pct(o.inAlbums, o.items)}% of items in one`)}
      ${kpi('Geotagged', pct(o.geotagged, o.items) + '%', `${fmt(o.geotagged)} items`)}
      ${kpi('Library health', d.health.score + '/100', `<a href="#/health">See what to fix →</a>`)}
    </div>
    <div class="card mb" id="chg"><h2>What changed</h2><span class="spin"></span></div>
    ${d.insights.length ? `<h2>What stands out</h2><div class="insights">${d.insights.map(i => `<div class="card insight ${i.tone}"><b>${esc(i.title)}</b><p>${esc(i.text)}</p></div>`).join('')}</div>` : ''}
    <div class="card mb"><div class="spread"><h2 style="margin:0">Uploads per month</h2><div class="tabs" id="tlTabs" style="margin:0"><button class="on" data-m="count">Uploads</button><button data-m="views">Views earned</button><button data-m="faves">Faves earned</button></div></div><div class="chart"><canvas id="cMonths"></canvas></div>
      <p class="small muted" style="margin:8px 0 0">“Views earned” is the all-time views of the photos uploaded in that month.</p></div>
    <div class="grid g2 mb">
      <div class="card"><h2>How many views do photos get?</h2><div class="chart"><canvas id="cDist"></canvas></div></div>
      <div class="card"><h2>Median views by upload year</h2><div class="chart"><canvas id="cYears"></canvas></div></div>
    </div>
    <div class="grid g3 mb">
      <div class="card"><h2>Views concentration</h2><div class="chart short"><canvas id="cConc"></canvas></div><p class="small muted">Share of all views earned by your top photos.</p></div>
      <div class="card"><h2>Shape</h2><div class="chart short"><canvas id="cShape"></canvas></div></div>
      <div class="card"><h2>Visibility</h2><div class="chart short"><canvas id="cVis"></canvas></div></div>
    </div>
    <div class="card"><div class="spread"><h2 style="margin:0">Most viewed</h2><a href="#/top">All top lists →</a></div><div class="photos">${d.top.views.slice(0, 12).map((x, i) => tile(x, { rank: i + 1 })).join('')}</div></div>`;

  let since = 'last'; try { since = localStorage.getItem('chgSince') || 'last'; } catch {}
  loadChanges(since);

  const months = d.timeline.months;
  const drawMonths = m => {
    const old = state.charts.findIndex(c => c.canvas.id === 'cMonths'); if (old >= 0) { state.charts[old].destroy(); state.charts.splice(old, 1); }
    barChart('cMonths', months.map(x => x.month), months.map(x => x[m]), { label: { count: 'Uploads', views: 'Views', faves: 'Faves' }[m], color: { count: PALETTE[0], views: PALETTE[4], faves: PALETTE[1] }[m] });
  };
  drawMonths('count');
  $$('#tlTabs button').forEach(b => b.onclick = () => { $$('#tlTabs button').forEach(x => x.classList.remove('on')); b.classList.add('on'); drawMonths(b.dataset.m); });
  barChart('cDist', d.distribution.map(x => x.label), d.distribution.map(x => x.count), { label: 'Photos', color: PALETTE[2] });
  comboChart('cYears', d.timeline.uploadYears);
  barChart('cConc', ['Top 1%', 'Top 10%', 'Top 20%'], [o.concentration.top1, o.concentration.top10, o.concentration.top20], { label: '% of views', color: PALETTE[3], fmtY: v => v + '%' });
  chart('cShape', { type: 'doughnut', data: { labels: d.shape.map(s => s.key), datasets: [{ data: d.shape.map(s => s.count), backgroundColor: PALETTE, borderWidth: 0 }] }, options: { plugins: { legend: { display: true, position: 'right' } }, cutout: '62%' } });
  chart('cVis', { type: 'doughnut', data: { labels: ['Public', 'Friends/family', 'Private'], datasets: [{ data: [o.public, o.friendsFamily, o.private], backgroundColor: [PALETTE[2], PALETTE[3], PALETTE[1]], borderWidth: 0 }] }, options: { plugins: { legend: { display: true, position: 'right' } }, cutout: '62%' } });
}

const signed = n => (n > 0 ? '+' : n < 0 ? '−' : '') + fmt(Math.abs(n));
function miniStrip(list, badge) {
  return `<div class="strip">${list.map(x => x.thumb ? `<img loading="lazy" data-id="${esc(x.id)}" src="${esc(x.thumb)}" title="${esc(x.title || 'Untitled')} · ${esc(badge(x))}">` : '').join('')}</div>`;
}
async function loadChanges(since) {
  if (!$('#chg')) return;
  try { localStorage.setItem('chgSince', since); } catch {}
  let r;
  try { r = await api(`/api/changes?nsid=${encodeURIComponent(state.nsid)}&since=${since}`); }
  catch (e) { $('#chg').innerHTML = `<h2>What changed</h2><p class="muted">${esc(e.message)}</p>`; return; }
  const el = $('#chg');
  if (!el || state.page !== 'overview') return;
  const c = r.changes;
  const tabs = [['last', 'Since last check'], ['1', '24 hours'], ['7', '7 days'], ['30', '30 days'], ['90', '90 days']];
  let body;
  if (!c) {
    body = since === 'last'
      ? '<p class="muted">Changes show up here after the next sync. The app checks Flickr for changes each time it starts.</p>'
      : `<p class="muted">No saved snapshot from before today yet. The app saves one each day it syncs, so this fills in from tomorrow${r.snapshots.length ? ` (first snapshot: ${esc(r.snapshots[0])})` : ''}.</p>`;
  } else {
    const from = since === 'last'
      ? (c.since ? `Since the check on ${new Date(c.since).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}` : 'Since the previous check')
      : `Since ${esc(c.date)}${c.approx ? ' (the oldest snapshot so far)' : ''}`;
    const cls = n => (n > 0 ? 'up' : n < 0 ? 'down' : '');
    body = `<p class="small muted" style="margin-top:0">${from}. Last checked ${ago(r.lastSync)}.</p>
      <div class="kpis">
        ${kpi('Views', signed(c.views), `${fmt(c.photosGained)} items gained views`, cls(c.views))}
        ${kpi('Faves', signed(c.faves), '', cls(c.faves))}
        ${kpi('Comments', signed(c.comments), '', cls(c.comments))}
        ${kpi('New uploads', fmt(c.newCount), c.removed ? `${fmt(c.removed)} removed` : 'none removed')}
        ${kpi('Updated', fmt(c.edited), 'edits, new tags or comments')}
      </div>
      ${c.gainers.length ? `<h3>Biggest gainers</h3><div class="photos">${c.gainers.slice(0, 12).map((x, i) => tile(x, { rank: i + 1, badge: '+' + compact(x.gain) })).join('')}</div>` : '<p class="muted">No new views in this period.</p>'}
      ${c.faveGainers.length ? `<h3 style="margin-top:14px">New faves on</h3>${miniStrip(c.faveGainers, x => '+' + x.faveGain + ' faves')}` : ''}
      ${c.commentGainers.length ? `<h3 style="margin-top:14px">New comments on</h3>${miniStrip(c.commentGainers, x => '+' + x.commentGain + ' comments')}` : ''}
      ${c.newItems.length ? `<h3 style="margin-top:14px">New uploads</h3>${miniStrip(c.newItems, x => fmt(x.views) + ' views')}` : ''}`;
  }
  const h = r.history;
  const growth = h.length >= 2 ? `<h3 style="margin-top:16px">Growth (one point per day synced)</h3><div class="chart short"><canvas id="cGrowth"></canvas></div>` : '';
  el.innerHTML = `<div class="spread"><h2 style="margin:0">What changed</h2><div class="tabs" style="margin:0">${tabs.map(([k, l]) => `<button class="${k === since ? 'on' : ''}" data-since="${k}">${l}</button>`).join('')}</div></div>${body}${growth}`;
  $$('[data-since]', el).forEach(b => b.onclick = () => loadChanges(b.dataset.since));
  const old = state.charts.findIndex(x => x.canvas.id === 'cGrowth'); if (old >= 0) { state.charts[old].destroy(); state.charts.splice(old, 1); }
  if (growth) {
    chart('cGrowth', {
      type: 'line',
      data: { labels: h.map(x => x.date), datasets: [
        { label: 'Total views', data: h.map(x => x.views), borderColor: PALETTE[0], backgroundColor: color(PALETTE[0], .15), fill: true, tension: .25, pointRadius: 2, yAxisID: 'y' },
        { label: 'Total faves', data: h.map(x => x.faves), borderColor: PALETTE[1], tension: .25, pointRadius: 2, yAxisID: 'y1' },
      ] },
      options: { scales: { y: { ticks: { callback: compact } }, y1: { position: 'right', ticks: { callback: compact }, grid: { display: false } }, x: { grid: { display: false } } } },
    });
  }
}

function pageTop(d) {
  const lists = [
    ['views', 'Most viewed', 'All-time views.', x => compact(x.views) + ' views'],
    ['faves', 'Most faved', 'All-time faves.', x => compact(x.faves) + ' ★'],
    ['comments', 'Most discussed', 'All-time comments.', x => compact(x.comments) + ' 💬'],
    ['faveRate', 'Best fave rate', `Faves per view, among photos with at least ${fmt(d.top.rateFloor)} views. The ones people love most when they see them.`, x => x.faveRate + '%'],
    ['velocity', 'Fastest earners', 'Views per day since upload, so new photos can compete with old ones.', x => fmt1(x.velocity) + '/day'],
    ['recent', 'Recent hits', 'Uploaded in the last 90 days, ranked by views per day.', x => fmt1(x.velocity) + '/day'],
    ['hiddenGems', 'Hidden gems', 'High fave rate but few views. Good candidates to share in groups or feature again.', x => x.faveRate + '%'],
  ];
  const cur = state.params.list && lists.some(l => l[0] === state.params.list) ? state.params.list : 'views';
  const l = lists.find(x => x[0] === cur);
  const items = d.top[cur] || [];
  view.innerHTML = `${header('Top photos', 'Your best work, ranked several ways.')}
    <div class="tabs">${lists.map(x => `<button class="${x[0] === cur ? 'on' : ''}" data-l="${x[0]}">${x[1]}</button>`).join('')}</div>
    <p class="sub">${l[2]}</p>
    ${items.length ? `<div class="photos">${items.map((x, i) => tile(x, { rank: i + 1, badge: l[3](x) })).join('')}</div>` : `<div class="empty muted">Nothing qualifies for this list yet.</div>`}`;
  $$('.tabs button').forEach(b => b.onclick = () => { location.hash = '#/top?list=' + b.dataset.l; });
}

function pageRecent(d) {
  const r = d.recent;
  if (!r) {
    view.innerHTML = `${header('Last 28 days', '')}<div class="card empty"><div class="big">📈</div>
      <p>${isOwn() ? 'Run a sync to load your daily stats.' : 'Daily stats come from Flickr Stats, which only shows them to the account owner. Sign in as this account to see them.'}</p>
      ${isOwn() ? '<button class="btn primary" id="go">Sync now</button>' : ''}</div>`;
    const g = $('#go'); if (g) g.onclick = startSync;
    return;
  }
  if (r.error) {
    view.innerHTML = `${header('Last 28 days', '')}<div class="card empty"><div class="big">🔒</div><p>Flickr didn't return stats for this account.</p><p class="muted small">${esc(r.error)}</p><p class="muted small">Flickr Stats needs a Pro account. Everything else in this app works without it.</p></div>`;
    return;
  }
  const t = r.totals || {};
  view.innerHTML = `${header('Last 28 days', `From Flickr Stats, by GMT day. Fetched ${ago(r.fetchedAt)}.`)}
    <div class="kpis">
      ${kpi('Views, 28 days', fmt(r.total28), `${fmt(Math.round(r.total28 / Math.max(1, r.days.length)))} a day on average`)}
      ${kpi('Last 7 days', fmt(r.last7), r.change7 == null ? '' : `<span class="${r.change7 >= 0 ? 'up' : 'down'}">${r.change7 >= 0 ? '▲' : '▼'} ${Math.abs(r.change7)}%</span> vs. the 7 days before`)}
      ${kpi('Best day', r.bestDay ? fmt(r.bestDay.total) : '–', r.bestDay ? new Date(r.bestDay.date + 'T00:00:00Z').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }) : '')}
      ${kpi('All-time views', compact(t.total), `${compact(t.photos)} photo · ${compact(t.photostream)} photostream`)}
      ${kpi('All-time album views', compact(t.sets), `${compact(t.collections)} collection · ${compact(t.galleries)} gallery`)}
    </div>
    <div class="card mb"><h2>Views per day</h2><div class="chart tall"><canvas id="cDays"></canvas></div></div>
    <div class="grid g2">
      <div class="card"><h2>Trending: most views in the last 28 days</h2><p class="small muted">Badge: views in the period. Share of the photo's all-time views shows which old photos have been rediscovered.</p>
        <div class="photos">${r.trending.slice(0, 24).map((x, i) => tile({ ...x }, { rank: i + 1, badge: compact(x.views) + (x.share != null ? ` · ${x.share}%` : '') })).join('')}</div></div>
      <div class="card"><h2>Where visitors came from</h2><p class="small muted">Referring sites, summed over the 28 days.</p>
        ${r.domains.length ? `<table><thead><tr><th>Site</th><th class="n">Views</th><th style="width:40%"></th></tr></thead><tbody>${r.domains.map(x => `<tr><td>${esc(x.name)}</td><td class="n">${fmt(x.views)}</td><td><div class="bar" style="width:${(x.views / r.domains[0].views) * 100}%"></div></td></tr>`).join('')}</tbody></table>` : '<p class="muted">No referrer data.</p>'}</div>
    </div>`;
  const lab = r.days.map(x => new Date(x.date + 'T00:00:00Z').toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' }));
  chart('cDays', {
    type: 'bar',
    data: { labels: lab, datasets: [
      { label: 'Photo pages', data: r.days.map(x => x.photos), backgroundColor: PALETTE[0], stack: 's', borderRadius: 2 },
      { label: 'Photostream', data: r.days.map(x => x.photostream), backgroundColor: PALETTE[1], stack: 's', borderRadius: 2 },
      { label: 'Albums', data: r.days.map(x => x.sets), backgroundColor: PALETTE[2], stack: 's', borderRadius: 2 },
      { label: 'Collections', data: r.days.map(x => x.collections), backgroundColor: PALETTE[3], stack: 's', borderRadius: 2 },
    ] },
    options: { scales: { x: { stacked: true, grid: { display: false } }, y: { stacked: true, ticks: { callback: compact } } } },
  });
}

function heatmap(grid, title) {
  const max = Math.max(1, ...grid.flat());
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  let h = `<div class="heat"><div></div>${Array.from({ length: 24 }, (_, i) => `<div class="hl">${i % 3 === 0 ? i : ''}</div>`).join('')}`;
  grid.forEach((row, d) => {
    h += `<div class="lbl">${days[d]}</div>` + row.map((v, hr) => `<div title="${days[d]} ${String(hr).padStart(2, '0')}:00 · ${v} ${title}" style="background:${v ? color(PALETTE[0], 0.12 + 0.88 * Math.sqrt(v / max)) : 'var(--panel2)'}"></div>`).join('');
  });
  return h + '</div>';
}
function pageTiming(d) {
  const t = d.timing;
  view.innerHTML = `${header('Timing', `When you shoot, when you upload, and when uploads do best. Upload times are in ${esc(t.timezone)}.`)}
    <div class="grid g2 mb">
      <div class="card"><h2>When you upload</h2>${heatmap(t.uploadHeat, 'uploads')}</div>
      <div class="card"><h2>When you shoot</h2>${heatmap(t.takenHeat, 'photos taken')}<p class="small muted">From the camera clock in each photo's “date taken”.</p></div>
    </div>
    <div class="grid g2 mb">
      <div class="card"><h2>Upload day vs. views</h2><div class="chart"><canvas id="cUpWd"></canvas></div></div>
      <div class="card"><h2>Upload hour vs. views</h2><div class="chart"><canvas id="cUpHr"></canvas></div></div>
    </div>
    <p class="small muted mb">Older photos have had longer to collect views, so these comparisons are rough hints, not rules.</p>
    <div class="grid g3 mb">
      <div class="card"><h2>Seasons: month taken</h2><div class="chart"><canvas id="cTkMo"></canvas></div></div>
      <div class="card"><h2>Hour taken</h2><div class="chart"><canvas id="cTkHr"></canvas></div></div>
      <div class="card"><h2>Time from shot to upload</h2><div class="chart"><canvas id="cLag"></canvas></div></div>
    </div>
    <div class="card"><h2>Photos by year taken</h2><div class="chart"><canvas id="cTkYr"></canvas></div><p class="small muted">${fmt(d.timeline.takenUnknown)} items have no reliable date taken.</p></div>`;
  comboChart('cUpWd', t.uploadWeekday, { countLabel: 'Uploads' });
  comboChart('cUpHr', t.uploadHour, { countLabel: 'Uploads' });
  comboChart('cTkMo', t.takenMonth);
  barChart('cTkHr', t.takenHour.map(x => x.key), t.takenHour.map(x => x.count), { label: 'Photos', color: PALETTE[4] });
  barChart('cLag', t.uploadLag.map(x => x.label), t.uploadLag.map(x => x.count), { label: 'Photos', color: PALETTE[3], horizontal: true });
  comboChart('cTkYr', d.timeline.takenYears);
}

function sortableTable(id, cols, rows, initial) {
  let key = initial, dir = -1;
  const el = document.getElementById(id);
  const draw = () => {
    const sorted = [...rows].sort((a, b) => { const x = a[key], y = b[key]; return (typeof x === 'string' ? x.localeCompare(y) : x - y) * dir; });
    el.innerHTML = `<table><thead><tr>${cols.map(c => `<th class="${c.n ? 'n' : ''}" data-k="${c.k || ''}">${c.label}${key === c.k ? (dir < 0 ? ' ▾' : ' ▴') : ''}</th>`).join('')}</tr></thead>
      <tbody>${sorted.map(r => `<tr>${cols.map(c => `<td class="${c.n ? 'n' : ''} ${c.cls || ''}">${c.render ? c.render(r) : esc(r[c.k])}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
    $$('th', el).forEach(th => th.onclick = () => { if (!th.dataset.k) return; if (key === th.dataset.k) dir = -dir; else { key = th.dataset.k; dir = -1; } draw(); });
  };
  draw();
}
function pageTags(d) {
  const t = d.tags;
  const maxC = Math.max(1, ...t.top.map(x => x.count));
  const cloud = [...t.top].sort((a, b) => a.tag.localeCompare(b.tag)).map(x => {
    const s = 12 + 20 * Math.sqrt(x.count / maxC);
    return `<a href="#/explore?tag=${encodeURIComponent(x.tag)}" style="font-size:${s.toFixed(1)}px" title="${x.count} photos · median ${fmt(x.medianViews)} views">${esc(x.tag)}</a>`;
  }).join('');
  const tagLink = r => `<a href="#/explore?tag=${encodeURIComponent(r.tag)}">${esc(r.tag)}</a>`;
  view.innerHTML = `${header('Tags', `${fmt(t.total)} different tags. Click any tag to see its photos.`)}
    <div class="card mb"><h2>Your 80 most-used tags</h2><div class="cloud">${cloud || '<span class="muted">No tags yet.</span>'}</div></div>
    <div class="grid g2 mb">
      <div class="card"><h2>Does tagging help?</h2><div class="chart"><canvas id="cTagN"></canvas></div><p class="small muted">Median views for photos with that many tags.</p></div>
      <div class="card"><h2>Strongest tags</h2><p class="small muted">Highest median views, among tags on at least ${t.minForRanking} photos.</p><div class="tablewrap" id="tBest" style="max-height:300px"></div></div>
    </div>
    <div class="card"><h2>All top tags</h2><div class="tablewrap" id="tAll"></div></div>`;
  comboChart('cTagN', t.byTagCount);
  const cols = [
    { label: 'Tag', k: 'tag', render: tagLink }, { label: 'Photos', k: 'count', n: 1, render: r => fmt(r.count) },
    { label: 'Median views', k: 'medianViews', n: 1, render: r => fmt(r.medianViews) }, { label: 'Avg views', k: 'avgViews', n: 1, render: r => fmt(r.avgViews) },
    { label: 'Total views', k: 'views', n: 1, render: r => fmt(r.views) }, { label: 'Faves', k: 'faves', n: 1, render: r => fmt(r.faves) },
  ];
  sortableTable('tBest', cols.slice(0, 3), t.best, 'medianViews');
  sortableTable('tAll', cols, t.top, 'count');
}

function pageMap(d) {
  const g = d.geo;
  const [a, b] = g.compare;
  view.innerHTML = `${header('Map', `${fmt(g.count)} geotagged items. Geotagged median ${fmt(a.medianViews)} views vs. ${fmt(b.medianViews)} without.`,
    `<label class="row small muted"><input type="checkbox" id="heatSize"> Size by views</label>`)}
    ${g.count ? '<div id="map"></div>' : '<div class="card empty"><div class="big">🗺️</div><p>None of these photos have a location yet.</p></div>'}`;
  if (!g.count || !window.L) { if (g.count) $('#map').innerHTML = '<p class="empty">The map library could not load. Check your internet connection.</p>'; return; }
  const map = L.map('map', { worldCopyJump: true });
  state.map = map;
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap contributors' }).addTo(map);
  const maxV = Math.max(1, ...g.points.map(p => p[3]));
  let layer;
  const draw = sized => {
    if (layer) map.removeLayer(layer);
    if (sized) {
      layer = L.layerGroup(g.points.map(([id, lat, lon, v, title, thumb]) => L.circleMarker([lat, lon], { radius: 4 + 18 * Math.sqrt(v / maxV), color: PALETTE[1], weight: 1, fillOpacity: .45 }).bindPopup(popup(id, title, thumb, v))));
    } else {
      layer = L.markerClusterGroup ? L.markerClusterGroup({ chunkedLoading: true }) : L.layerGroup();
      g.points.forEach(([id, lat, lon, v, title, thumb]) => layer.addLayer(L.marker([lat, lon]).bindPopup(popup(id, title, thumb, v))));
    }
    layer.addTo(map);
  };
  const popup = (id, title, thumb, v) => `<div data-id="${esc(id)}" style="cursor:pointer">${thumb ? `<img src="${esc(thumb)}">` : ''}<b>${esc(title || 'Untitled')}</b><br>${fmt(v)} views · click for details</div>`;
  draw(false);
  map.fitBounds(L.latLngBounds(g.points.map(p => [p[1], p[2]])), { padding: [30, 30], maxZoom: 12 });
  $('#heatSize').onchange = e => draw(e.target.checked);
}

function pageAlbums(d) {
  const rows = d.albums;
  view.innerHTML = `${header('Albums', `${fmt(rows.length)} albums. Click one to browse its photos.`)}
    <div class="grid g2 mb">
      <div class="card"><h2>Albums by total photo views</h2><div class="chart tall"><canvas id="cAlb"></canvas></div></div>
      <div class="card"><h2>Photos by number of albums they're in</h2><div class="chart tall"><canvas id="cAlbN"></canvas></div></div>
    </div>
    <div class="card"><div class="tablewrap" id="tAlb"></div></div>`;
  const top = rows.slice(0, 15);
  barChart('cAlb', top.map(a => a.title.length > 28 ? a.title.slice(0, 27) + '…' : a.title), top.map(a => a.photoViews), { label: 'Views of photos in album', horizontal: true, color: PALETTE[4] });
  comboChart('cAlbN', d.albumCountBuckets);
  sortableTable('tAlb', [
    { label: '', cls: 'thumbcell', render: r => r.thumb ? `<img loading="lazy" src="${esc(r.thumb)}" alt="">` : '' },
    { label: 'Album', k: 'title', render: r => `<a href="#/explore?album=${r.id}">${esc(r.title)}</a>` },
    { label: 'Items', k: 'photos', n: 1, render: r => fmt(r.photos) },
    { label: 'Album page views', k: 'albumViews', n: 1, render: r => fmt(r.albumViews) },
    { label: 'Photo views (sum)', k: 'photoViews', n: 1, render: r => fmt(r.photoViews) },
    { label: 'Median photo views', k: 'medianPhotoViews', n: 1, render: r => fmt(r.medianPhotoViews) },
    { label: 'Faves', k: 'faves', n: 1, render: r => fmt(r.faves) },
    { label: 'Updated', k: 'updated', n: 1, render: r => date(r.updated) },
  ], rows, 'photoViews');
}

function pageCameras(d) {
  const e = d.exif;
  const job = jobsFor(state.nsid).exif;
  const remaining = e.eligible - e.scanned;
  const scanBtns = `<button class="btn primary" data-scan="500" ${job?.running ? 'disabled' : ''}>Scan top 500</button><button class="btn" data-scan="0" ${job?.running ? 'disabled' : ''}>Scan all ${fmt(remaining)}</button>`;
  const hours = n => { const h = (n * 1.2) / 3600; return h < 1 ? Math.max(1, Math.round(h * 60)) + ' min' : h.toFixed(1) + ' h'; };
  if (!e.scanned) {
    view.innerHTML = `${header('Cameras', '')}<div class="card empty"><div class="big">📸</div>
      <h2>Camera data needs a separate scan</h2>
      <p class="muted">Flickr only gives camera, lens and settings one photo at a time, and limits apps to 3,600 requests an hour. The scan starts with your most-viewed photos, runs in the background, and can be stopped and resumed.</p>
      <p class="muted small">Top 500 takes about ${hours(Math.min(500, remaining))}; all ${fmt(remaining)} photos takes about ${hours(remaining)}.</p>
      <div class="row" style="justify-content:center">${job?.running ? `<span><span class="spin"></span> Scanning… ${fmt(job.done)} / ${fmt(job.total)}</span>` : scanBtns}</div></div>`;
  } else {
    view.innerHTML = `${header('Cameras', `Camera data for ${fmt(e.withData)} of ${fmt(e.eligible)} photos (${fmt(e.scanned - e.withData)} hide it or have none).`,
      job?.running ? `<span class="small muted"><span class="spin"></span> Scanning ${fmt(job.done)} / ${fmt(job.total)}</span>` : remaining > 0 ? scanBtns.replace('Scan top 500', 'Scan 500 more') : '')}
      <div class="grid g2 mb">
        <div class="card"><h2>Cameras</h2><div class="tablewrap" id="tCam" style="max-height:330px"></div></div>
        <div class="card"><h2>Lenses</h2><div class="tablewrap" id="tLens" style="max-height:330px"></div></div>
      </div>
      <div class="grid g2 mb">
        <div class="card"><h2>Focal length (35mm equivalent where known)</h2><div class="chart"><canvas id="cFocal"></canvas></div></div>
        <div class="card"><h2>Aperture</h2><div class="chart"><canvas id="cAp"></canvas></div></div>
        <div class="card"><h2>ISO</h2><div class="chart"><canvas id="cIso"></canvas></div></div>
        <div class="card"><h2>Shutter speed</h2><div class="chart"><canvas id="cSh"></canvas></div></div>
      </div>
      <div class="grid g2">
        <div class="card"><h2>Main camera each year</h2><div class="tablewrap" id="tCamYr"></div></div>
        <div class="card"><h2>Editing software</h2><div class="chart"><canvas id="cSw"></canvas></div></div>
      </div>`;
    const cols = (lbl, link) => [
      { label: lbl, k: 'key', render: r => link ? `<a href="#/explore?camera=${encodeURIComponent(r.key)}">${esc(r.key)}</a>` : esc(r.key) },
      { label: 'Photos', k: 'count', n: 1, render: r => fmt(r.count) }, { label: 'Median views', k: 'medianViews', n: 1, render: r => fmt(r.medianViews) },
      { label: 'Faves', k: 'faves', n: 1, render: r => fmt(r.faves) },
    ];
    sortableTable('tCam', cols('Camera', true), e.cameras, 'count');
    sortableTable('tLens', cols('Lens'), e.lenses, 'count');
    comboChart('cFocal', e.focal); comboChart('cAp', e.aperture); comboChart('cIso', e.iso); comboChart('cSh', e.shutter);
    sortableTable('tCamYr', [{ label: 'Year', k: 'year' }, { label: 'Camera', k: 'camera' }, { label: 'Photos', k: 'count', n: 1, render: r => `${fmt(r.count)} of ${fmt(r.total)}` }], e.cameraYears, 'year');
    barChart('cSw', e.software.map(s => s.key), e.software.map(s => s.count), { label: 'Photos', horizontal: true, color: PALETTE[5] });
  }
  $$('[data-scan]').forEach(b => b.onclick = async () => {
    try { await api('/api/exif', { method: 'POST', body: { nsid: state.nsid, limit: Number(b.dataset.scan) } }); state.status = await api('/api/status'); renderJobs(); route(true); toast('Camera scan started'); }
    catch (err) { toast(err.message, true); }
  });
}

// ---------- movies ----------
const dur = s => s == null ? '' : s >= 3600 ? `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
const loading = () => { view.innerHTML = `<div class="empty"><span class="spin"></span> Loading…</div>`; };
const nsidQ = () => 'nsid=' + encodeURIComponent(state.nsid);
const pageGuard = (fn) => async (...a) => { try { await fn(...a); } catch (e) { view.innerHTML = `<div class="empty"><p>${esc(e.message)}</p></div>`; } };
const needsSync = (what) => `<div class="card empty"><div class="big">🔄</div><h2>${what} load on the next sync</h2><p class="muted">This was added after your last sync.</p><button class="btn primary" id="syncNow">Sync now</button></div>`;
function bindSyncNow() { const b = $('#syncNow'); if (b) b.onclick = startSync; }

const pageMovies = pageGuard(async () => {
  loading();
  const m = await api('/api/movies?' + nsidQ());
  if (!m.count) { view.innerHTML = `${header('Movies', '')}<div class="card empty"><div class="big">🎬</div><h2>No videos yet</h2><p class="muted">Videos you upload to Flickr show up here.</p></div>`; return; }
  const vsP = m.photoMedianViews ? m.medianViews / m.photoMedianViews : null;
  view.innerHTML = `${header('Movies', `${fmt(m.count)} videos${m.withDuration ? ` · ${dur(m.runtime)} total running time` : ''}`)}
    <div class="kpis mb">
      ${kpi('Videos', fmt(m.count))}
      ${kpi('Total views', compact(m.views), `${fmt(m.faves)} faves · ${fmt(m.comments)} comments`)}
      ${kpi('Median views', fmt(m.medianViews), vsP ? `${vsP >= 1 ? fmt1(vsP) + '× ' : fmt1(100 - vsP * 100) + '% below '}your photos (${fmt(m.photoMedianViews)})` : '', vsP >= 1 ? 'up' : 'down')}
      ${kpi('Faves per 1,000 views', fmt1(m.faveRate * 1000), `Photos: ${fmt1(m.photoFaveRate * 1000)}`, m.faveRate >= m.photoFaveRate ? 'up' : 'down')}
    </div>
    <div class="grid g2 mb">
      <div class="card"><h2>Videos by upload year</h2><div class="chart"><canvas id="cMovYr"></canvas></div></div>
      <div class="card"><h2>Median views by length</h2><div class="chart"><canvas id="cMovLen"></canvas></div></div>
    </div>
    <div class="spread mb"><h2 style="margin:0">All videos</h2><div class="tabs" id="movTabs"><button data-l="grid" class="on">Grid</button><button data-l="table">Table</button></div></div>
    <div id="movList"></div>`;
  comboChart('cMovYr', m.byYear.map(y => ({ key: y.key, count: y.count, views: y.views })), { countLabel: 'Videos', metric: 'views', metricLabel: 'Views' });
  comboChart('cMovLen', m.lengths, { countLabel: 'Videos' });
  const draw = layout => {
    $$('#movTabs button').forEach(b => b.classList.toggle('on', b.dataset.l === layout));
    if (layout === 'grid') $('#movList').innerHTML = `<div class="photos">${m.items.map((v, i) => tile(v, { rank: i + 1, badge: v.duration != null ? '▶ ' + dur(v.duration) : '▶' })).join('')}</div>`;
    else {
      $('#movList').innerHTML = '<div class="card"><div class="tablewrap" id="tMov"></div></div>';
      sortableTable('tMov', [
        { label: '', cls: 'thumbcell', render: r => r.thumb ? `<img loading="lazy" src="${esc(r.thumb)}" alt="" data-id="${esc(r.id)}">` : '' },
        { label: 'Title', k: 'title', render: r => `<a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.title || 'Untitled')} ↗</a>` },
        { label: 'Length', k: 'duration', n: 1, render: r => dur(r.duration) || '–' },
        { label: 'Views', k: 'views', n: 1, render: r => fmt(r.views) },
        { label: 'Views/day', k: 'perDay', n: 1, render: r => fmt1(r.perDay) },
        { label: 'Faves', k: 'faves', n: 1, render: r => fmt(r.faves) },
        { label: 'Comments', k: 'comments', n: 1, render: r => fmt(r.comments) },
        { label: 'Uploaded', k: 'uploaded', n: 1, render: r => date(r.uploaded) },
      ], m.items, 'views');
    }
  };
  $$('#movTabs button').forEach(b => b.onclick = () => draw(b.dataset.l));
  draw('grid');
});

// ---------- Explore ----------
const pageExplored = pageGuard(async () => {
  loading();
  const x = await api('/api/explored?' + nsidQ());
  const job = jobsFor(state.nsid).explore;
  const mins = n => n < 60 ? Math.max(1, n) + ' min' : fmt1(n / 60) + ' h';
  const scanBtn = label => job?.running
    ? `<span class="small muted"><span class="spin"></span> Checking Explore… ${fmt(job.done)} / ${fmt(job.total)} days</span> <button class="btn sm" data-cancel-explore>Stop</button>`
    : `<button class="btn primary" id="exScan">${label}</button>`;
  if (!x.scanned && !job?.running) {
    view.innerHTML = `${header('Explored', '')}<div class="card empty"><div class="big">🌟</div>
      <h2>Find your photos that made Explore</h2>
      <p class="muted">Flickr doesn't say which photos were in Explore, so the app checks each day's Explore list (500 photos) from the day before each of your uploads to three days after.</p>
      <p class="muted small">That's ${fmt(x.daysLeft)} days to check, about ${mins(x.minutesLeft)} in the background. You can keep using the app, stop it, and resume later. After that, new days are checked automatically.</p>
      <div class="row" style="justify-content:center">${scanBtn('Check Explore history')}</div></div>`;
  } else {
    view.innerHTML = `${header('Explored', `${fmt(x.daysChecked)} of ${fmt(x.daysTotal)} days checked${x.lastScan ? ' · last checked ' + ago(x.lastScan) : ''}`,
      job?.running ? scanBtn('') : x.daysLeft ? scanBtn(`Check ${fmt(x.daysLeft)} more days (~${mins(x.minutesLeft)})`) : '')}
      <div class="kpis mb">
        ${kpi('Photos in Explore', fmt(x.count), x.daysLeft ? 'so far' : '')}
        ${kpi('Best position', x.bestRank ? '#' + x.bestRank : '–', 'of 500 that day')}
        ${kpi('Median views', x.count ? fmt(x.medianViews) : '–', `Your other public photos: ${fmt(x.otherMedianViews)}`, x.count ? 'up' : '')}
        ${kpi('Median faves', x.count ? fmt(x.medianFaves) : '–', `Others: ${fmt(x.otherMedianFaves)}`, x.count ? 'up' : '')}
      </div>
      ${x.count ? `<div class="card mb"><h2>Explore picks by year</h2><div class="chart short"><canvas id="cExYr"></canvas></div></div>
      <div class="photos">${x.items.map(i => tile(i, { badge: `#${i.rank} · ${new Date(i.exploreDate + 'T12:00:00Z').toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}` })).join('')}</div>`
      : `<div class="card empty"><p class="muted">${job?.running || x.daysLeft ? 'None found yet. Results appear here as days are checked.' : 'None of your photos were found in Explore.'}</p></div>`}`;
    if (x.count) barChart('cExYr', x.byYear.map(y => y.key), x.byYear.map(y => y.count), { label: 'Photos in Explore', color: PALETTE[1], fmtY: v => Number.isInteger(v) ? v : '' });
  }
  const b = $('#exScan');
  if (b) b.onclick = async () => {
    try { await api('/api/explore-scan', { method: 'POST', body: { nsid: state.nsid } }); state.status = await api('/api/status'); renderJobs(); toast('Checking Explore in the background'); pageExplored(); }
    catch (e) { toast(e.message, true); }
  };
  const c = $('[data-cancel-explore]');
  if (c) c.onclick = async () => { await api('/api/cancel', { method: 'POST', body: { nsid: state.nsid, kind: 'explore' } }); toast('Stopping. Progress is saved.'); };
});

// ---------- groups ----------
const pageGroups = pageGuard(async () => {
  loading();
  const g = await api('/api/groups?' + nsidQ());
  if (!g.list) { view.innerHTML = header('Groups', '') + needsSync('Groups'); bindSyncNow(); return; }
  const me = g.profile?.pathAlias || state.nsid;
  const gurl = x => `https://www.flickr.com/groups/${encodeURIComponent(x.pathAlias || x.nsid)}/`;
  const list = g.list;
  const limited = list.filter(x => x.throttle);
  const canPost = limited.filter(x => x.throttle.remaining > 0).length;
  view.innerHTML = `${header('Groups', `${fmt(list.length)} groups${g.own ? '' : ' (public groups only)'}`)}
    <div class="kpis mb">
      ${kpi('Groups', fmt(list.length))}
      ${kpi('Combined members', compact(list.reduce((s, x) => s + x.members, 0)), 'Reach if you post to all of them')}
      ${kpi('Admin or moderator', fmt(list.filter(x => x.admin || x.moderator).length))}
      ${g.own ? kpi('Posting limits', fmt(limited.length), `${fmt(canPost)} still open today`) : ''}
    </div>
    <div class="card"><div class="filters" style="margin-bottom:10px">
      <input id="gq" placeholder="Search groups" style="flex:1;min-width:200px">
      ${g.own ? `<label class="row small"><input type="checkbox" id="gOpen"> Only groups I can post to now</label>` : ''}
    </div><div class="tablewrap" id="tGroups" style="max-height:none"></div></div>`;
  const draw = () => {
    const q = $('#gq').value.trim().toLowerCase(), open = $('#gOpen')?.checked;
    const rows = list.filter(x => (!q || x.name.toLowerCase().includes(q)) && (!open || !x.throttle || x.throttle.remaining > 0));
    sortableTable('tGroups', [
      { label: '', cls: 'thumbcell', render: r => `<img loading="lazy" src="${esc(r.icon)}" alt="" style="border-radius:50%">` },
      { label: 'Group', k: 'name', render: r => `<a href="${gurl(r)}" target="_blank" rel="noopener">${esc(r.name)} ↗</a>
          ${r.admin ? '<span class="chip">Admin</span>' : r.moderator ? '<span class="chip">Moderator</span>' : ''}${r.inviteOnly ? ' <span class="chip">Invite only</span>' : ''}${r.adult ? ' <span class="chip">18+</span>' : ''}` },
      { label: 'Members', k: 'members', n: 1, render: r => fmt(r.members) },
      { label: 'Photos in pool', k: 'pool', n: 1, render: r => fmt(r.pool) },
      { label: 'Last active', k: 'lastActivity', n: 1, render: r => r.lastActivity ? ago(r.lastActivity * 1000) : '–' },
      ...(g.own ? [{ label: 'Posting limit', k: 'limitLeft', n: 1, render: r => r.throttle ? `<span class="nowrap">${r.throttle.count} ${r.throttle.mode === 'ever' ? 'total' : 'per ' + esc(r.throttle.mode)}</span>${r.throttle.remaining != null ? `<br><b class="nowrap ${r.throttle.remaining > 0 ? 'up' : 'down'}">${r.throttle.remaining} left</b>` : ''}` : '<span class="muted">None</span>' }] : []),
      { label: '', render: r => `<a class="small nowrap" href="${gurl(r)}pool/${encodeURIComponent(me)}/" target="_blank" rel="noopener">${g.own ? 'My' : 'Their'} photos ↗</a>` },
    ], rows.map(r => ({ ...r, limitLeft: r.throttle ? r.throttle.remaining ?? -1 : 1e9 })), 'members');
  };
  $('#gq').oninput = draw; const o = $('#gOpen'); if (o) o.onchange = draw;
  draw();
});

// ---------- contacts ----------
const pageContacts = pageGuard(async (refresh) => {
  if (!refresh) loading();
  const c = await api('/api/contacts?' + nsidQ() + (refresh ? '&refresh=1' : ''));
  if (!c.list) { view.innerHTML = header('Contacts', '') + needsSync('Contacts'); bindSyncNow(); return; }
  const purl = x => `https://www.flickr.com/photos/${encodeURIComponent(x.pathAlias || x.nsid)}/`;
  const r = c.recent;
  const byNsid = new Map(c.list.map(x => [x.nsid, x]));
  const recentHtml = !c.own ? '' : r ? `
    <div class="spread"><h2 style="margin:0">New from your contacts</h2><button class="btn sm" id="cRefresh">Refresh</button></div>
    <p class="small muted">The latest ${fmt(r.photos.length)} uploads from people you follow · updated ${ago(r.fetchedAt)}</p>
    ${r.uploaders.length ? `<div class="chips mb">${r.uploaders.map(u => { const k = byNsid.get(u.nsid) || {}; return `<a class="chip contactchip" href="${purl({ ...k, nsid: u.nsid })}" target="_blank" rel="noopener" title="Latest ${ago(u.latest * 1000)}"><img src="${esc(k.icon || 'https://www.flickr.com/images/buddyicon.gif')}" alt="">${esc(k.realname || u.name)} <b>${fmt(u.count)}</b></a>`; }).join('')}</div>` : ''}
    <div class="photos mb">${r.photos.map(p => `<a class="ph" href="${esc(p.url)}" target="_blank" rel="noopener" title="${esc(p.title)}">
      ${p.thumb ? `<img loading="lazy" src="${esc(p.thumb)}" alt="">` : ''}${p.media === 'video' ? '<span class="badge">▶</span>' : ''}
      <div class="meta"><div class="t">${esc(p.title || 'Untitled')}</div>${esc(p.ownerName)} · ${ago(p.uploaded * 1000)}</div></a>`).join('')}</div>`
    : `<div class="card mb"><p class="muted">Couldn't load your contacts' recent uploads${c.recentError ? ': ' + esc(c.recentError) : ''}.</p></div>`;
  view.innerHTML = `${header('Contacts', `${fmt(c.list.length)} people ${c.own ? 'you follow' : 'this account follows publicly'}`)}
    ${recentHtml}
    <div class="card"><div class="filters" style="margin-bottom:10px">
      <input id="cq" placeholder="Search contacts" style="flex:1;min-width:200px">
      ${c.own ? `<select id="cf"><option value="">Everyone</option><option value="friend">Friends</option><option value="family">Family</option></select>` : ''}
      <span class="small muted" id="cCount"></span>
    </div><div class="people" id="cList"></div></div>`;
  const draw = () => {
    const q = $('#cq').value.trim().toLowerCase(), f = $('#cf')?.value;
    const rows = c.list.filter(x => (!q || (x.username + ' ' + x.realname + ' ' + x.location).toLowerCase().includes(q)) && (!f || x[f]));
    $('#cCount').textContent = `${fmt(rows.length)} shown`;
    $('#cList').innerHTML = rows.map(x => `<a class="person" href="${purl(x)}" target="_blank" rel="noopener"><img loading="lazy" src="${esc(x.icon)}" alt="">
      <div><b>${esc(x.realname || x.username)}</b><span>${esc(x.realname ? x.username : '')}${x.location ? (x.realname ? ' · ' : '') + esc(x.location) : ''}</span>
      ${x.friend || x.family ? `<span>${x.friend ? '<span class="chip">Friend</span>' : ''}${x.family ? ' <span class="chip">Family</span>' : ''}</span>` : ''}</div></a>`).join('') || '<p class="muted">No matches.</p>';
  };
  $('#cq').oninput = draw; const f = $('#cf'); if (f) f.onchange = draw;
  draw();
  const rb = $('#cRefresh'); if (rb) rb.onclick = () => pageContacts(true);
});

// ---------- activity ----------
const ACT_WINDOWS = [[24, '24 hours'], [168, '7 days'], [336, '14 days'], [720, '30 days']];
const pageActivity = pageGuard(async () => {
  const hours = Number(state.params.h) || 24;
  loading();
  const a = await api(`/api/activity?${nsidQ()}&hours=${hours}`);
  const w = a.window, s = a.changes;
  const tabs = `<div class="tabs mb">${ACT_WINDOWS.map(([h, l]) => `<button data-h="${h}" class="${h === hours ? 'on' : ''}">${l}${a.counts ? ` <span class="muted">${fmt(a.counts[h].faves + a.counts[h].comments)}</span>` : ''}</button>`).join('')}</div>`;
  const label = ACT_WINDOWS.find(x => x[0] === hours)?.[1] || hours + ' hours';
  if (!a.own) {
    view.innerHTML = `${header('Activity', 'Faves and comments on these photos')}${tabs}
      ${s ? `<div class="kpis mb">${kpi('Faves gained', fmt(s.faves), s.approx ? `Since ${s.date} (oldest snapshot)` : `Since ${s.date}`)}${kpi('Comments gained', fmt(s.comments))}${kpi('Views gained', compact(s.views))}</div>` : ''}
      <div class="card empty"><p class="muted">Who faved and commented is only available for your own account. ${s ? 'These totals come from the app\'s daily snapshots.' : 'Totals appear once the app has snapshots from earlier days.'}</p></div>`;
  } else if (!w) {
    view.innerHTML = `${header('Activity', '')}<div class="card empty"><p class="muted">Couldn't load activity${a.error ? ': ' + esc(a.error) : ''}.</p></div>`;
  } else {
    const since = a.since && Date.now() - a.since < hours * 3600000;
    view.innerHTML = `${header('Activity', `Faves and comments on your photos · updated ${ago(a.fetchedAt)}`)}${tabs}
      ${since ? `<p class="small muted">The app's activity log starts ${date(a.since / 1000)}, so this window is partly covered. It fills in as the app keeps checking.</p>` : ''}
      <div class="kpis mb">
        ${kpi('Faves', fmt(w.faves), `in the last ${label}`)}
        ${kpi('Comments', fmt(w.comments), `in the last ${label}`)}
        ${kpi('People', fmt(w.people), 'faved or commented')}
        ${kpi('Photos', fmt(w.photos), 'got attention')}
      </div>
      <div class="card mb"><h2>${w.hourly ? 'By hour' : 'By day'}</h2><div class="chart short"><canvas id="cAct"></canvas></div></div>
      ${w.feed.length ? `<div class="grid g2 mb">
        <div class="card"><h2>Photos with the most activity</h2><div class="photos">${w.topPhotos.slice(0, 12).map(p => tile({ ...p, views: p.views ?? 0, faves: p.totalFaves ?? p.faves, comments: p.totalComments ?? p.comments }, { badge: [p.faves ? '★ +' + p.faves : '', p.comments ? '💬 +' + p.comments : ''].filter(Boolean).join(' ') })).join('')}</div></div>
        <div class="card"><h2>Most active people</h2><div class="people">${w.topPeople.slice(0, 16).map(p => `<a class="person" href="https://www.flickr.com/photos/${esc(p.nsid)}/" target="_blank" rel="noopener"><img loading="lazy" src="${esc(p.icon)}" alt=""><div><b>${esc(p.realname || p.username)}</b><span>${p.faves ? '★ ' + p.faves + ' fave' + (p.faves > 1 ? 's' : '') : ''}${p.faves && p.comments ? ' · ' : ''}${p.comments ? '💬 ' + p.comments + ' comment' + (p.comments > 1 ? 's' : '') : ''}</span></div></a>`).join('')}</div></div>
      </div>
      <div class="card"><h2>Everything, newest first</h2><div class="feed">${w.feed.map(e => `<div class="ev">
        <a href="https://www.flickr.com/photos/${esc(e.user)}/" target="_blank" rel="noopener"><img loading="lazy" class="av" src="${esc(e.icon)}" alt=""></a>
        <div class="txt"><b>${esc(e.realname || e.username)}</b> ${e.type === 'fave' ? 'faved' : e.type === 'comment' ? 'commented on' : esc(e.type) + ' on'} <span class="lnk" data-id="${esc(e.photo)}">${esc(e.title || 'Untitled')}</span>
          ${e.text ? `<div class="small muted">“${esc(e.text.replace(/<[^>]+>/g, '').slice(0, 200))}”</div>` : ''}<div class="small muted">${ago(e.t)}</div></div>
        ${e.thumb ? `<img loading="lazy" class="th" src="${esc(e.thumb)}" alt="" data-id="${esc(e.photo)}">` : ''}</div>`).join('')}</div></div>`
      : `<div class="card empty"><p class="muted">No faves or comments in the last ${label}.</p></div>`}`;
    chart('cAct', {
      type: 'bar',
      data: {
        labels: w.buckets.map(b => w.hourly ? new Date(b.t).toLocaleTimeString(undefined, { hour: 'numeric' }) : new Date(b.t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })),
        datasets: [
          { label: 'Faves', data: w.buckets.map(b => b.faves), backgroundColor: PALETTE[1], borderRadius: 3, stack: 's' },
          { label: 'Comments', data: w.buckets.map(b => b.comments), backgroundColor: PALETTE[0], borderRadius: 3, stack: 's' },
        ],
      },
      options: { scales: { y: { stacked: true, ticks: { precision: 0 }, grid: { color: css('--line') } }, x: { stacked: true, grid: { display: false } } } },
    });
  }
  $$('[data-h]').forEach(b => b.onclick = () => { location.hash = '#/activity?h=' + b.dataset.h; });
});

function pageHealth(d) {
  const h = d.health, s = h.score;
  const col = s >= 75 ? css('--good') : s >= 50 ? css('--warn') : css('--bad');
  const C = 2 * Math.PI * 52;
  view.innerHTML = `${header('Library health', 'Gaps that make photos harder to find. Click a row to see and fix those photos on Flickr.')}
    <div class="grid g2 mb">
      <div class="card healthscore">
        <svg class="ring" viewBox="0 0 120 120"><circle cx="60" cy="60" r="52" fill="none" stroke="var(--panel2)" stroke-width="12"/>
          <circle cx="60" cy="60" r="52" fill="none" stroke="${col}" stroke-width="12" stroke-linecap="round" stroke-dasharray="${(C * s) / 100} ${C}" transform="rotate(-90 60 60)"/>
          <text x="60" y="68" text-anchor="middle" font-size="28" font-weight="700" fill="var(--text)">${s}</text></svg>
        <div><h2>Discoverability score</h2><p class="muted small" style="margin:0">Weighted towards titles, tags and albums, which drive search and browsing on Flickr. 100 means every photo has a real title, 4+ tags, a description, an album, a location and a date.</p></div>
      </div>
      <div class="card"><h2>Licenses</h2><div class="chart short"><canvas id="cLic"></canvas></div></div>
    </div>
    <div class="card">${h.checks.map(c => `<div class="check">
        <div><b><a href="#/explore?issue=${c.key}">${esc(c.label)}</a></b> <span class="muted small">— ${esc(c.why)}</span></div>
        <div class="n"><b>${fmt(c.count)}</b> <span class="muted small">${c.pct}%</span></div>
        <div class="pbar"><i style="width:${c.pct}%;${c.key === 'private' || c.key === 'allRights' ? 'background:var(--blue)' : ''}"></i></div>
        ${c.sample.length ? `<div class="strip">${c.sample.map(p => p.thumb ? `<img loading="lazy" data-id="${esc(p.id)}" src="${esc(p.thumb)}" title="${esc(p.title || 'Untitled')} · ${fmt(p.views)} views">` : '').join('')}${c.count > c.sample.length ? `<a class="btn sm" style="align-self:center" href="#/explore?issue=${c.key}">All ${fmt(c.count)} →</a>` : ''}</div>` : ''}
      </div>`).join('')}</div>`;
  chart('cLic', { type: 'doughnut', data: { labels: h.licenses.map(l => l.key), datasets: [{ data: h.licenses.map(l => l.count), backgroundColor: PALETTE, borderWidth: 0 }] }, options: { plugins: { legend: { display: true, position: 'right' } }, cutout: '60%' } });
}

async function pageExplore(d) {
  const p = { sort: 'views', dir: 'desc', per: '60', page: '1', ...state.params };
  const issues = d.health.checks.map(c => [c.key, c.label]);
  const years = d.timeline.takenYears.map(y => y.key).reverse();
  const albums = d.albums.map(a => [a.id, a.title]).sort((a, b) => a[1].localeCompare(b[1]));
  const opt = (v, l, cur) => `<option value="${esc(v)}" ${String(cur ?? '') === String(v) ? 'selected' : ''}>${esc(l)}</option>`;
  const layout = (() => { try { return localStorage.getItem('exploreLayout') || 'grid'; } catch { return 'grid'; } })();
  view.innerHTML = `${header('Explore all photos', '', `<a class="btn" href="/api/export.csv?nsid=${encodeURIComponent(state.nsid)}">Export all as CSV</a>`)}
    <form class="filters card" id="ef">
      <label class="f">Search<input name="q" value="${esc(p.q || '')}" placeholder="Title, description, tag"></label>
      <label class="f">Sort<select name="sort">${[['views', 'Views'], ['faves', 'Faves'], ['comments', 'Comments'], ['faveRate', 'Fave rate'], ['velocity', 'Views per day'], ['uploaded', 'Upload date'], ['taken', 'Date taken'], ['tags', 'Number of tags'], ['title', 'Title']].map(([v, l]) => opt(v, l, p.sort)).join('')}</select></label>
      <label class="f">Order<select name="dir">${opt('desc', 'High → low', p.dir)}${opt('asc', 'Low → high', p.dir)}</select></label>
      <label class="f">Needs attention<select name="issue">${opt('', 'Any', p.issue)}${opt('geo', 'Geotagged', p.issue)}${issues.map(([k, l]) => opt(k, l, p.issue)).join('')}</select></label>
      <label class="f">Year taken<select name="year">${opt('', 'Any', p.year)}${years.map(y => opt(y, y, p.year)).join('')}</select></label>
      <label class="f">Album<select name="album" style="max-width:200px">${opt('', 'Any', p.album)}${albums.map(([id, t]) => opt(id, t, p.album)).join('')}</select></label>
      <label class="f">Type<select name="media">${opt('', 'All', p.media)}${opt('photo', 'Photos', p.media)}${opt('video', 'Videos', p.media)}</select></label>
      <label class="f">Visibility<select name="privacy">${opt('', 'All', p.privacy)}${opt('public', 'Public', p.privacy)}${opt('private', 'Not public', p.privacy)}</select></label>
      <label class="f">Min views<input name="minViews" type="number" min="0" style="width:100px" value="${esc(p.minViews || '')}"></label>
      ${p.tag ? `<label class="f">Tag<span class="chip" style="padding:6px 10px">${esc(p.tag)} <a href="#" id="clrTag">×</a></span></label>` : ''}
      ${p.camera ? `<label class="f">Camera<span class="chip" style="padding:6px 10px">${esc(p.camera)} <a href="#" id="clrCam">×</a></span></label>` : ''}
      <button class="btn primary">Apply</button><a class="btn" href="#/explore">Reset</a>
      <div class="tabs" style="margin:0 0 0 auto"><button type="button" data-lay="grid" class="${layout === 'grid' ? 'on' : ''}">Grid</button><button type="button" data-lay="table" class="${layout === 'table' ? 'on' : ''}">Table</button></div>
    </form>
    <div id="eres"><div class="empty"><span class="spin"></span></div></div>`;
  const go = extra => {
    const fd = Object.fromEntries(new FormData($('#ef')));
    const next = { ...fd, tag: p.tag, camera: p.camera, ...extra };
    const qs = new URLSearchParams(Object.entries(next).filter(([k, v]) => v && !(k === 'page' && v === '1') && !(k === 'sort' && v === 'views') && !(k === 'dir' && v === 'desc')));
    location.hash = '#/explore' + (qs.toString() ? '?' + qs : '');
  };
  $('#ef').onsubmit = e => { e.preventDefault(); go({ page: '1' }); };
  $$('#ef select').forEach(s => s.onchange = () => go({ page: '1' }));
  const ct = $('#clrTag'); if (ct) ct.onclick = e => { e.preventDefault(); go({ tag: '' }); };
  const cc = $('#clrCam'); if (cc) cc.onclick = e => { e.preventDefault(); go({ camera: '' }); };
  $$('[data-lay]').forEach(b => b.onclick = () => { try { localStorage.setItem('exploreLayout', b.dataset.lay); } catch {} route(true); });

  const qs = new URLSearchParams({ nsid: state.nsid, ...p });
  let r;
  try { r = await api('/api/photos?' + qs); } catch (e) { $('#eres').innerHTML = `<p>${esc(e.message)}</p>`; return; }
  const pager = r.pages > 1 ? `<div class="pager">
      <button class="btn sm" data-pg="1" ${r.page <= 1 ? 'disabled' : ''}>First</button><button class="btn sm" data-pg="${r.page - 1}" ${r.page <= 1 ? 'disabled' : ''}>‹ Prev</button>
      <span class="muted small">Page ${r.page} of ${r.pages}</span>
      <button class="btn sm" data-pg="${r.page + 1}" ${r.page >= r.pages ? 'disabled' : ''}>Next ›</button><button class="btn sm" data-pg="${r.pages}" ${r.page >= r.pages ? 'disabled' : ''}>Last</button></div>` : '';
  const badgeFor = x => ({ faves: '★ ' + compact(x.faves), comments: '💬 ' + compact(x.comments), velocity: fmt1(x.velocity) + '/day', faveRate: x.views ? fmt1((x.faves / x.views) * 100) + '%' : '', uploaded: date(x.uploaded), taken: (x.taken || '').slice(0, 10), tags: x.tags + ' tags' }[p.sort] || compact(x.views) + ' views');
  const start = (r.page - 1) * r.per;
  $('#eres').innerHTML = `<p class="muted small">${fmt(r.total)} matching items</p>` + (r.items.length ? (layout === 'table'
    ? `<div class="card tablewrap" style="max-height:none"><table><thead><tr><th></th><th>Title</th><th class="n">Views</th><th class="n">Faves</th><th class="n">Comments</th><th class="n">Views/day</th><th class="n">Tags</th><th class="n">Albums</th><th>Uploaded</th><th>Taken</th><th>Geo</th></tr></thead><tbody>
      ${r.items.map(x => `<tr data-id="${esc(x.id)}" style="cursor:pointer"><td class="thumbcell">${x.thumb ? `<img loading="lazy" src="${esc(x.thumb)}" alt="">` : ''}</td><td>${esc(x.title || 'Untitled')}${x.ispublic ? '' : ' 🔒'}${x.media === 'video' ? ' 🎬' : ''}</td>
        <td class="n">${fmt(x.views)}</td><td class="n">${fmt(x.faves)}</td><td class="n">${fmt(x.comments)}</td><td class="n">${fmt1(x.velocity)}</td><td class="n">${x.tags}</td><td class="n">${x.albums}</td><td>${date(x.uploaded)}</td><td>${esc((x.taken || '').slice(0, 10))}</td><td>${x.geo ? '📍' : ''}</td></tr>`).join('')}</tbody></table></div>`
    : `<div class="photos">${r.items.map((x, i) => tile(x, { rank: start + i + 1, badge: badgeFor(x) })).join('')}</div>`) : '<div class="empty muted">No photos match.</div>') + pager;
  $$('[data-pg]').forEach(b => b.onclick = () => go({ page: b.dataset.pg }));
}

function pageSettings() {
  const s = state.status;
  let theme = 'system'; try { theme = localStorage.getItem('theme') || 'system'; } catch {}
  view.innerHTML = `${header('Accounts & settings', '')}
    <div class="grid g2">
      <div class="card"><h2>Your Flickr account</h2>
        ${s.auth ? `<p>Signed in as <b>${esc(s.auth.fullname || s.auth.username)}</b> (${esc(s.auth.username)}). Read-only access.</p>
          <div class="row"><button class="btn primary" id="syncMe">Sync my photos</button><button class="btn danger" id="logout">Sign out</button></div>`
        : s.configured ? `<p class="muted">Sign in to analyze your own photos, including private ones, and to get daily stats.</p>
          <div class="row"><a class="btn primary" href="/auth/login">Sign in with Flickr</a></div>
          <details style="margin-top:14px"><summary class="small muted" style="cursor:pointer">Sign in with a code instead</summary>
            <p class="small muted">Use this if Flickr shows a code instead of returning to this app.</p>
            <ol class="small muted"><li><button class="btn sm" id="codeStart">Open Flickr sign-in</button></li><li>Approve access, copy the code Flickr shows, and paste it here:</li></ol>
            <form id="codeForm" class="row"><input id="code" placeholder="123-456-789" style="flex:1"><button class="btn">Finish sign-in</button></form></details>`
        : '<p class="muted">You need a Flickr API key first.</p><a class="btn primary" href="#/setup">Start setup</a>'}
      </div>
      <div class="card"><h2>Analyze another public account</h2>
        <p class="muted small">Compare with friends or photographers you follow. Only public photos and counts are available.</p>
        <form id="pubForm" class="row"><input id="pubQ" placeholder="Username, profile URL or NSID" style="flex:1;min-width:180px"><button class="btn">Analyze</button></form>
      </div>
      <div class="card" style="grid-column:1/-1"><h2>Synced accounts</h2>
        ${s.users.length ? `<table><thead><tr><th>Account</th><th class="n">Items</th><th>Last sync</th><th></th></tr></thead><tbody>
          ${s.users.map(u => `<tr><td><a href="#/overview" data-sel="${esc(u.nsid)}">${esc(u.realname || u.username)}</a> <span class="muted small">${esc(u.username)}${u.nsid === s.auth?.nsid ? ' · you' : ''}</span></td>
            <td class="n">${fmt(u.photoCount)}</td><td>${ago(u.lastSync)}</td>
            <td class="row" style="justify-content:flex-end"><button class="btn sm" data-resync="${esc(u.nsid)}">Sync</button><button class="btn sm danger" data-del="${esc(u.nsid)}">Remove</button></td></tr>`).join('')}</tbody></table>`
        : '<p class="muted">Nothing synced yet.</p>'}
      </div>
      <div class="card"><h2>Flickr API key</h2>
        <p class="small muted">${s.configured ? `Using key ${esc(s.keyHint)}.` : 'No key set.'} Need one? <a href="#/setup?step=1">Step-by-step help</a>. Changing to a different key signs you out.</p>
        <form id="keyForm" class="grid" style="gap:8px"><label class="f">Key<input name="apiKey" autocomplete="off" spellcheck="false"></label><label class="f">Secret<input name="apiSecret" autocomplete="off" spellcheck="false"></label><div><button class="btn">Save and test</button></div></form>
      </div>
      <div class="card"><h2>Appearance</h2>
        <label class="f">Theme<select id="theme">${['system', 'dark', 'light'].map(t => `<option ${t === theme ? 'selected' : ''} value="${t}">${t[0].toUpperCase() + t.slice(1)}</option>`).join('')}</select></label>
        <h2 style="margin-top:18px">Updates</h2>
        <label class="row"><input type="checkbox" id="autoRefresh" ${s.autoRefresh ? 'checked' : ''}> Check Flickr for changes when the app starts (and every 3 hours while it runs)</label>
        <p class="small muted">Downloaded data is cached on this PC and shown straight away. A check re-reads the photo list for fresh counts, and only re-reads albums and stats days that changed.</p>
        <h2 style="margin-top:18px">About</h2>
        <p class="small muted">Data is saved in the app's <code>data</code> folder. Flickr allows 3,600 API calls an hour per key: a sync of 10,000 photos uses about 20 calls plus a few per album; the camera scan uses one per photo.</p>
      </div>
    </div>`;
  const on = (sel, ev, fn) => { const el = $(sel); if (el) el[ev] = fn; };
  on('#syncMe', 'onclick', async () => { state.nsid = s.auth.nsid; try { localStorage.setItem('nsid', s.auth.nsid); } catch {} await startSync(); location.hash = '#/overview'; });
  on('#logout', 'onclick', async () => { await api('/api/logout', { method: 'POST' }); await loadStatus(); pageSettings(); toast('Signed out'); });
  let codeToken = null;
  on('#codeStart', 'onclick', async () => { try { const r = await api('/api/auth/code-start', { method: 'POST' }); codeToken = r.token; window.open(r.url, '_blank'); } catch (e) { toast(e.message, true); } });
  on('#codeForm', 'onsubmit', async e => {
    e.preventDefault();
    if (!codeToken) return toast('Click “Open Flickr sign-in” first', true);
    try { const r = await api('/api/auth/code-finish', { method: 'POST', body: { token: codeToken, code: $('#code').value } }); await loadStatus(); selectAccount(r.nsid); location.hash = '#/overview'; }
    catch (err) { toast(err.message, true); }
  });
  on('#pubForm', 'onsubmit', addPublic);
  on('#keyForm', 'onsubmit', async e => {
    e.preventDefault();
    try { await api('/api/config', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) }); toast('Key saved and verified'); await loadStatus(); pageSettings(); }
    catch (err) { toast(err.message, true); }
  });
  on('#autoRefresh', 'onchange', async e => { try { await api('/api/prefs', { method: 'POST', body: { autoRefresh: e.target.checked } }); s.autoRefresh = e.target.checked; toast(e.target.checked ? 'Will check for changes on startup' : 'Automatic checks off'); } catch (err) { toast(err.message, true); } });
  on('#theme', 'onchange', e => { try { localStorage.setItem('theme', e.target.value); } catch {} applyTheme(); });
  $$('[data-sel]').forEach(a => a.onclick = () => selectAccount(a.dataset.sel));
  $$('[data-resync]').forEach(b => b.onclick = async () => { try { await api('/api/sync', { method: 'POST', body: { nsid: b.dataset.resync } }); state.status = await api('/api/status'); renderJobs(); toast('Sync started'); } catch (e) { toast(e.message, true); } });
  $$('[data-del]').forEach(b => b.onclick = async () => {
    if (!confirm('Remove the saved data for this account from this PC? (Nothing on Flickr is changed.)')) return;
    await api('/api/users?nsid=' + encodeURIComponent(b.dataset.del), { method: 'DELETE' });
    if (state.nsid === b.dataset.del) { state.nsid = null; state.data = null; try { localStorage.removeItem('nsid'); } catch {} }
    await loadStatus(); pageSettings();
  });
}

// ---------- boot ----------
(async function boot() {
  applyTheme();
  matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => { applyTheme(); route(true); });
  try { await loadStatus(); } catch (e) { view.innerHTML = `<div class="empty"><p>Can't reach the analyzer server. Is it running?</p><p class="muted">${esc(e.message)}</p></div>`; return; }
  route();
  // Pick up jobs the server starts on its own (startup checks, automatic Explore/camera scans).
  setInterval(async () => {
    if (state.poll || document.hidden) return;
    try { state.status = await api('/api/status'); renderJobs(); } catch {}
  }, 30000);
  // Opening the app also checks for changes if the cached data is over an hour old
  // (covers a server that has been left running). The server skips anything checked recently.
  const meta = state.status.users.find(u => u.nsid === state.nsid);
  if (state.status.autoRefresh && meta && Date.now() - meta.lastSync > 3600000 && !anyRunning()) {
    try { await api('/api/check', { method: 'POST' }); setTimeout(async () => { state.status = await api('/api/status'); renderJobs(); }, 600); } catch {}
  }
})();
