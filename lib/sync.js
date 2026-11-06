'use strict';
// Background jobs that pull data from Flickr into the local store.
const { store } = require('./store');
const { recordSync } = require('./changes');

const EXTRAS = [
  'description', 'license', 'date_upload', 'date_taken', 'last_update', 'geo', 'tags', 'machine_tags',
  'o_dims', 'views', 'media', 'path_alias', 'url_q', 'url_m', 'url_z', 'url_l', 'count_faves', 'count_comments',
].join(',');

const jobs = new Map(); // nsid -> job

function newJob(nsid, kind) {
  const job = {
    nsid, kind, running: true, cancelled: false, phase: 'Starting', done: 0, total: 0,
    message: '', error: null, warnings: [], startedAt: Date.now(), finishedAt: null,
  };
  jobs.set(nsid + ':' + kind, job);
  return job;
}

function getJobs(nsid) {
  const out = {};
  for (const [k, j] of jobs) if (j.nsid === nsid) out[j.kind] = publicJob(j);
  return out;
}
function publicJob(j) { return Object.fromEntries(Object.entries(j).filter(([k]) => k !== 'cancelled' && !k.startsWith('_'))); }

function isRunning(nsid, kind) { const j = jobs.get(nsid + ':' + kind); return !!(j && j.running); }
function cancel(nsid, kind) { const j = jobs.get(nsid + ':' + kind); if (j && j.running) { j.cancelled = true; j.message = 'Stopping…'; } }

async function pool(items, size, fn, job) {
  let i = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) {
      if (job && job.cancelled) return;
      const idx = i++;
      await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
}

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

function normalizePhoto(p) {
  const w = num(p.o_width) || num(p.width_l) || num(p.width_z) || num(p.width_m);
  const h = num(p.o_height) || num(p.height_l) || num(p.height_z) || num(p.height_m);
  const lat = num(p.latitude), lon = num(p.longitude);
  return {
    id: p.id,
    title: p.title || '',
    desc: (p.description && p.description._content) || '',
    tags: p.tags ? p.tags.split(' ').filter(Boolean) : [],
    mtags: p.machine_tags ? p.machine_tags.split(' ').filter(Boolean) : [],
    views: num(p.views),
    faves: num(p.count_faves),
    comments: num(p.count_comments),
    uploaded: num(p.dateupload),
    updated: num(p.lastupdate),
    taken: p.datetaken || null,
    takenUnknown: String(p.datetakenunknown) === '1',
    lat: lat || lon ? lat : null,
    lon: lat || lon ? lon : null,
    geoAcc: num(p.accuracy),
    woeid: p.woeid || null,
    media: p.media || 'photo',
    w, h,
    ispublic: num(p.ispublic), isfriend: num(p.isfriend), isfamily: num(p.isfamily),
    license: String(p.license ?? ''),
    thumb: p.url_q || null,
    img: p.url_z || p.url_m || null,
    big: p.url_l || p.url_z || null,
    albums: 0,
  };
}

async function fetchAllPages(flickr, method, params, listKey, itemKey, job, label, perPage = 500) {
  const first = await flickr.call(method, { ...params, per_page: perPage, page: 1 });
  const pages = num(first[listKey].pages) || 1;
  const total = num(first[listKey].total) || first[listKey][itemKey].length;
  const results = [first[listKey][itemKey]];
  if (job) { job.phase = label; job.total = total; job.done = first[listKey][itemKey].length; }
  const rest = Array.from({ length: pages - 1 }, (_, i) => i + 2);
  await pool(rest, 3, async page => {
    const r = await flickr.call(method, { ...params, per_page: perPage, page });
    results[page - 1] = r[listKey][itemKey];
    if (job) job.done += r[listKey][itemKey].length;
  }, job);
  return { items: results.flat().filter(Boolean), total };
}

function ymd(d) { return d.toISOString().slice(0, 10); }

async function fetchStatsDay(flickr, date) {
  const day = { v: 2, date, total: 0, photos: 0, photostream: 0, sets: 0, collections: 0, popular: [], domains: [] };
  try {
    const t = await flickr.call('flickr.stats.getTotalViews', { date });
    day.total = num(t.stats.total.views); day.photos = num(t.stats.photos.views);
    day.photostream = num(t.stats.photostream.views); day.sets = num(t.stats.sets.views);
    day.collections = num(t.stats.collections.views);
  } catch (e) { day.error = e.message; return day; }
  try {
    const pp = await flickr.call('flickr.stats.getPopularPhotos', { date, per_page: 100, extras: 'url_q' });
    day.popular = (pp.photos.photo || []).map(p => ({
      id: p.id, title: p.title, thumb: p.url_q,
      views: num(p.stats && p.stats.views), faves: num(p.stats && p.stats.favorites), comments: num(p.stats && p.stats.comments),
    }));
  } catch {}
  const dom = {};
  for (const m of ['flickr.stats.getPhotoDomains', 'flickr.stats.getPhotostreamDomains']) {
    try {
      const dd = await flickr.call(m, { date, per_page: 25 });
      for (const d of dd.domains.domain || []) dom[d.name] = (dom[d.name] || 0) + num(d.views);
    } catch {}
  }
  day.domains = Object.entries(dom).map(([name, views]) => ({ name, views }));
  return day;
}

// Flickr keeps daily stats for 28 days. Past days don't change, so only fetch days not already
// cached, plus the two most recent days, which can still be filling in on Flickr's side.
async function syncStats(flickr, job, prev) {
  job.phase = 'Stats (last 28 days)'; job.done = 0; job.total = 0;
  const stats = { fetchedAt: Date.now(), days: [], trending: [], domains: [], totals: null, error: null, fetchedDays: 0 };
  try {
    const t = await flickr.call('flickr.stats.getTotalViews', {});
    stats.totals = {
      total: num(t.stats.total.views), photos: num(t.stats.photos.views), photostream: num(t.stats.photostream.views),
      sets: num(t.stats.sets.views), collections: num(t.stats.collections.views), galleries: num(t.stats.galleries?.views),
    };
  } catch (e) {
    stats.error = e.message + (e.code ? ' (code ' + e.code + ')' : '');
    job.warnings.push('Stats unavailable: ' + stats.error);
    return stats;
  }
  const wanted = [];
  for (let i = 1; i <= 28; i++) wanted.push(ymd(new Date(Date.now() - i * 86400000)));
  const cached = new Map(((prev && prev.days) || []).filter(d => d.v === 2 && !d.error).map(d => [d.date, d]));
  const todo = wanted.filter((d, i) => i < 2 || !cached.has(d));
  const fetched = new Map();
  job.total = todo.length;
  await pool(todo, 3, async date => { fetched.set(date, await fetchStatsDay(flickr, date)); job.done++; }, job);
  stats.fetchedDays = todo.length;
  stats.days = wanted.map(d => fetched.get(d) || cached.get(d)).filter(Boolean).sort((a, b) => a.date.localeCompare(b.date));
  const trending = {}, domains = {};
  for (const day of stats.days) {
    for (const p of day.popular || []) {
      const cur = trending[p.id] || (trending[p.id] = { id: p.id, title: p.title, thumb: p.thumb, views: 0, faves: 0, comments: 0, days: 0 });
      cur.views += p.views; cur.faves += p.faves; cur.comments += p.comments; cur.days++;
    }
    for (const d of day.domains || []) domains[d.name] = (domains[d.name] || 0) + d.views;
  }
  stats.trending = Object.values(trending).sort((a, b) => b.views - a.views).slice(0, 100);
  stats.domains = Object.entries(domains).map(([name, views]) => ({ name, views })).sort((a, b) => b.views - a.views).slice(0, 30);
  return stats;
}

function sameAlbum(a, b) {
  return !!b && !b.error && Array.isArray(b.members) && b.updated === a.updated && b.photos === a.photos && b.videos === a.videos;
}

// Sync a user. The first run downloads everything; later runs reuse cached album contents and
// stats days that haven't changed, and record what changed since the previous sync.
// own=true means the signed-in account (private photos + stats).
async function fullSync(flickr, nsid, { own = false, includeStats = true, reason = 'manual' } = {}) {
  if (isRunning(nsid, 'sync')) throw new Error('A sync is already running for this account');
  const job = newJob(nsid, 'sync');
  job.reason = reason;
  const u = store.user(nsid);
  const prevPhotos = u.get('photos');
  const prevMeta = u.get('meta');
  job.incremental = !!prevPhotos;
  let newIds = [];
  job._promise = (async () => {
    try {
      job.phase = prevPhotos ? 'Checking for changes' : 'Profile';
      const info = await flickr.call('flickr.people.getInfo', { user_id: nsid }, { auth: own });
      const person = info.person;
      const profile = {
        nsid,
        username: person.username?._content,
        realname: person.realname?._content || '',
        location: person.location?._content || '',
        description: person.description?._content || '',
        photosurl: person.photosurl?._content,
        pathAlias: person.path_alias || null,
        ispro: num(person.ispro),
        iconserver: person.iconserver, iconfarm: person.iconfarm,
        icon: num(person.iconserver) > 0
          ? `https://farm${person.iconfarm}.staticflickr.com/${person.iconserver}/buddyicons/${nsid}.jpg`
          : 'https://www.flickr.com/images/buddyicon.gif',
        firstUpload: num(person.photos?.firstdate?._content),
        firstTaken: person.photos?.firstdatetaken?._content || null,
        count: num(person.photos?.count?._content),
      };

      // The photo list is always re-read: view/fave/comment counts change constantly and the
      // list is cheap (one call per 500 photos).
      const { items } = await fetchAllPages(
        flickr, 'flickr.people.getPhotos',
        { user_id: own ? 'me' : nsid, extras: EXTRAS },
        'photos', 'photo', job, prevPhotos ? 'Checking photos' : 'Photos',
      );
      if (job.cancelled) throw new Error('Cancelled');
      const seen = new Set();
      const photos = [];
      for (const p of items) { if (!seen.has(p.id)) { seen.add(p.id); photos.push(normalizePhoto(p)); } }
      const byId = new Map(photos.map(p => [p.id, p]));

      // Albums: the list is one call; only re-read the contents of albums that changed.
      job.phase = 'Albums'; job.done = 0; job.total = 0;
      let albums = [];
      const prevAlbums = new Map((u.get('albums') || []).map(a => [a.id, a]));
      let albumsFetched = 0;
      try {
        const res = await fetchAllPages(flickr, 'flickr.photosets.getList',
          { user_id: nsid, primary_photo_extras: 'url_q' }, 'photosets', 'photoset', null, 'Albums');
        albums = res.items.map(a => ({
          id: a.id, title: a.title?._content || '', desc: a.description?._content || '',
          photos: num(a.photos) || num(a.count_photos), videos: num(a.videos) || num(a.count_videos),
          views: num(a.count_views), comments: num(a.count_comments),
          created: num(a.date_create), updated: num(a.date_update),
          thumb: a.primary_photo_extras?.url_q || null, members: [],
        }));
        const stale = [];
        for (const a of albums) {
          const old = prevAlbums.get(a.id);
          if (sameAlbum(a, old)) a.members = old.members; else stale.push(a);
        }
        job.phase = 'Album contents'; job.total = stale.length; job.done = 0;
        await pool(stale, 3, async a => {
          try {
            const r = await fetchAllPages(flickr, 'flickr.photosets.getPhotos',
              { photoset_id: a.id, user_id: nsid }, 'photoset', 'photo', null, '');
            a.members = r.items.map(p => p.id);
          } catch (e) { a.error = e.message; }
          albumsFetched++; job.done++;
        }, job);
      } catch (e) {
        job.warnings.push('Albums: ' + e.message);
        albums = [...prevAlbums.values()];
      }
      for (const a of albums) for (const id of a.members || []) { const p = byId.get(id); if (p) p.albums++; }
      if (job.cancelled) throw new Error('Cancelled');

      let stats = u.get('stats');
      if (own && includeStats) stats = await syncStats(flickr, job, stats);
      if (job.cancelled) throw new Error('Cancelled');

      const changes = recordSync(u, prevPhotos, prevMeta?.lastSync, photos);
      const prevIds = new Set((prevPhotos || []).map(p => p.id));
      newIds = prevPhotos ? photos.filter(p => !prevIds.has(p.id)).map(p => p.id) : [];

      u.set('profile', profile);
      u.set('photos', photos);
      u.set('albums', albums);
      if (stats) u.set('stats', stats);
      const meta = {
        nsid, username: profile.username, realname: profile.realname, icon: profile.icon, own,
        lastSync: Date.now(), firstSync: prevMeta?.firstSync || prevMeta?.lastSync || Date.now(),
        photoCount: photos.length, apiCalls: flickr.calls, albumsFetched, albumsReused: albums.length - albumsFetched,
        statsDaysFetched: stats?.fetchedDays ?? null,
        lastChanges: changes ? { views: changes.views, faves: changes.faves, comments: changes.comments, newCount: changes.newCount, removed: changes.removed } : null,
      };
      u.set('meta', meta);
      job.phase = 'Done';
      job.changes = meta.lastChanges;
      job.apiCalls = flickr.calls;
      if (changes) {
        const sign = n => (n >= 0 ? '+' : '') + n.toLocaleString();
        const bits = [];
        if (changes.newCount) bits.push(`${changes.newCount.toLocaleString()} new`);
        if (changes.removed) bits.push(`${changes.removed.toLocaleString()} removed`);
        bits.push(`${sign(changes.views)} views`, `${sign(changes.faves)} faves`);
        job.message = `Up to date. Since last sync: ${bits.join(', ')}`;
      } else {
        job.message = `Synced ${photos.length.toLocaleString()} items and ${albums.length} albums`;
      }
    } catch (e) {
      job.error = e.message;
      job.phase = 'Failed';
    } finally {
      job.running = false;
      job.finishedAt = Date.now();
    }
    // If the camera scan has been used before, read camera data for new uploads too.
    const exif = u.get('exif');
    if (!job.error && newIds.length && exif && Object.keys(exif).length) {
      try { await exifScan(flickr, nsid, { own, onlyIds: newIds }); } catch {}
    }
  })();
  return publicJob(job);
}

function waitFor(nsid, kind) {
  const j = jobs.get(nsid + ':' + kind);
  return j && j._promise ? j._promise : Promise.resolve();
}

function parseExif(r) {
  const tags = {};
  for (const t of r.photo.exif || []) {
    const val = (t.clean && t.clean._content) || (t.raw && t.raw._content);
    if (!(t.tag in tags)) tags[t.tag] = val;
  }
  const model = tags.Model || r.photo.camera || null;
  const make = tags.Make || null;
  let camera = r.photo.camera || model;
  if (camera && make && !camera.toLowerCase().includes(make.split(' ')[0].toLowerCase())) camera = make + ' ' + camera;
  const n = s => { const m = String(s || '').match(/[\d.]+/); return m ? Number(m[0]) : null; };
  let shutter = null;
  if (tags.ExposureTime) {
    const s = String(tags.ExposureTime);
    const frac = s.match(/(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/);
    shutter = frac ? Number(frac[1]) / Number(frac[2]) : n(s);
  }
  const out = {
    camera: camera ? String(camera).trim() : null,
    lens: tags.LensModel || tags.Lens || tags.LensInfo || null,
    focal: n(tags.FocalLength),
    focal35: n(tags.FocalLengthIn35mmFormat),
    aperture: n(tags.FNumber || tags.ApertureValue),
    iso: n(tags.ISO || tags.ISOSpeed || tags.ISOSpeedRatings),
    shutter,
    flash: tags.Flash ? !/no flash|off|did not fire/i.test(tags.Flash) : null,
    software: tags.Software || null,
  };
  // Graphics and scans often carry no camera fields at all; treat those as "no data".
  return Object.values(out).some(v => v != null) ? out : null;
}

// EXIF scan: one call per photo, throttled to stay under Flickr's 3600 calls/hour.
async function exifScan(flickr, nsid, { own = false, limit = 0, onlyIds = null } = {}) {
  if (isRunning(nsid, 'exif')) throw new Error('EXIF scan already running');
  const u = store.user(nsid);
  const photos = u.get('photos') || [];
  const exif = u.get('exif') || {};
  const only = onlyIds ? new Set(onlyIds) : null;
  const todo = photos.filter(p => p.media === 'photo' && !(p.id in exif) && (!only || only.has(p.id))).sort((a, b) => b.views - a.views);
  const list = limit > 0 ? todo.slice(0, limit) : todo;
  const job = newJob(nsid, 'exif');
  job.phase = 'Reading camera data'; job.total = list.length;
  (async () => {
    let lastSave = Date.now();
    let next = Date.now();
    try {
      await pool(list, 2, async p => {
        const wait = next - Date.now();
        next = Math.max(next, Date.now()) + 1100;
        if (wait > 0) await new Promise(r => setTimeout(r, wait));
        if (job.cancelled) return;
        try {
          const r = await flickr.call('flickr.photos.getExif', { photo_id: p.id }, { auth: own });
          exif[p.id] = parseExif(r);
        } catch (e) {
          exif[p.id] = null; // hidden or unavailable; don't retry
        }
        job.done++;
        if (Date.now() - lastSave > 10000) { u.set('exif', exif); lastSave = Date.now(); }
      }, job);
      job.phase = job.cancelled ? 'Stopped' : 'Done';
      job.message = `Camera data for ${Object.values(exif).filter(Boolean).length.toLocaleString()} photos`;
    } catch (e) {
      job.error = e.message; job.phase = 'Failed';
    } finally {
      u.set('exif', exif);
      job.running = false; job.finishedAt = Date.now();
    }
  })();
  return publicJob(job);
}

module.exports = { fullSync, waitFor, syncStats, sameAlbum, exifScan, getJobs, cancel, isRunning, normalizePhoto, parseExif, EXTRAS };
