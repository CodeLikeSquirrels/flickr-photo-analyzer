'use strict';
// Turns the synced photo list into analytics. Pure functions, no I/O.

const DAY = 86400;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const LICENSES = {
  0: 'All Rights Reserved', 1: 'CC BY-NC-SA 2.0', 2: 'CC BY-NC 2.0', 3: 'CC BY-NC-ND 2.0', 4: 'CC BY 2.0',
  5: 'CC BY-SA 2.0', 6: 'CC BY-ND 2.0', 7: 'No known copyright restrictions', 8: 'United States Government Work',
  9: 'Public Domain Dedication (CC0)', 10: 'Public Domain Mark', 11: 'CC BY 4.0', 12: 'CC BY-SA 4.0',
  13: 'CC BY-ND 4.0', 14: 'CC BY-NC 4.0', 15: 'CC BY-NC-SA 4.0', 16: 'CC BY-NC-ND 4.0',
};
const DEFAULT_TITLE = /^(?:(?:img|dsc|dscn|dscf|_dsc|p|pxl|_mg|_img|gopr|gp|dji|mvi|vid|image|photo|scan|sam|wp|cimg|imgp|pict|hpim|dcp|snapshot|screenshot|untitled)[\s_\-.]*\d[\d_\-.\s]*(?:[_\-\s.]?(?:dxo|edit(?:ed)?|hdr|pano|copy|final|v\d+|\d+))*(?:\.(?:jpe?g|png|heic|tiff?|dng|raw|cr2|nef|arw|mp4|mov))?|untitled|no title)$/i;

const sum = a => a.reduce((s, x) => s + x, 0);
const mean = a => (a.length ? sum(a) / a.length : 0);
function quantile(sorted, q) {
  if (!sorted.length) return 0;
  const pos = (sorted.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}
const median = a => quantile([...a].sort((x, y) => x - y), 0.5);
const round = (x, d = 1) => Math.round(x * 10 ** d) / 10 ** d;

function takenDate(p) {
  if (!p.taken || p.takenUnknown) return null;
  const m = p.taken.match(/^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}):(\d{2}))?/);
  if (!m || m[1] === '0000') return null;
  return { y: +m[1], mo: +m[2] - 1, d: +m[3], h: m[4] != null ? +m[4] : null, wd: new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay() };
}

function isUntitled(p) { const t = (p.title || '').trim(); return !t || DEFAULT_TITLE.test(t); }

function orientation(p) {
  if (!p.w || !p.h) return 'Unknown';
  const r = p.w / p.h;
  if (r >= 2) return 'Panorama';
  if (r > 1.05) return 'Landscape';
  if (r < 0.95) return 'Portrait';
  return 'Square';
}

function slim(p, extra = {}) {
  return { id: p.id, title: p.title, thumb: p.thumb, img: p.img, views: p.views, faves: p.faves, comments: p.comments, uploaded: p.uploaded, ...extra };
}

function groupStats(groups, order) {
  const keys = order || Object.keys(groups);
  return keys.map(k => {
    const g = groups[k] || [];
    const v = g.map(p => p.views);
    return { key: k, count: g.length, views: sum(v), avgViews: round(mean(v)), medianViews: round(median(v)), faves: sum(g.map(p => p.faves)) };
  });
}

function bucketize(photos, fn) {
  const g = {};
  for (const p of photos) { const k = fn(p); if (k == null) continue; (g[k] = g[k] || []).push(p); }
  return g;
}

function analyze({ photos = [], albums = [], exif = {}, stats = null, profile = null, now = Date.now() / 1000 } = {}) {
  const items = photos;
  const onlyPhotos = items.filter(p => p.media === 'photo');
  const views = items.map(p => p.views);
  const sortedViews = [...views].sort((a, b) => a - b);
  const totalViews = sum(views), totalFaves = sum(items.map(p => p.faves)), totalComments = sum(items.map(p => p.comments));
  const medViews = quantile(sortedViews, 0.5);

  for (const p of items) {
    const ageDays = Math.max(1, (now - p.uploaded) / DAY);
    p._age = ageDays;
    p._velocity = p.views / ageDays;
    p._faveRate = p.views ? p.faves / p.views : 0;
  }

  // ---------- overview ----------
  const uploads = items.map(p => p.uploaded).filter(Boolean);
  const firstUp = uploads.length ? Math.min(...uploads) : null, lastUp = uploads.length ? Math.max(...uploads) : null;
  const geotagged = items.filter(p => p.lat != null);
  const overview = {
    items: items.length,
    photos: onlyPhotos.length,
    videos: items.filter(p => p.media === 'video').length,
    totalViews, totalFaves, totalComments,
    avgViews: round(mean(views)), medianViews: round(medViews),
    p90Views: round(quantile(sortedViews, 0.9)), maxViews: sortedViews[sortedViews.length - 1] || 0,
    faveRate: totalViews ? round((totalFaves / totalViews) * 1000, 2) : 0, // faves per 1,000 views
    commentRate: totalViews ? round((totalComments / totalViews) * 1000, 2) : 0,
    public: items.filter(p => p.ispublic).length,
    friendsFamily: items.filter(p => !p.ispublic && (p.isfriend || p.isfamily)).length,
    private: items.filter(p => !p.ispublic && !p.isfriend && !p.isfamily).length,
    geotagged: geotagged.length,
    tagged: items.filter(p => p.tags.length).length,
    inAlbums: items.filter(p => p.albums > 0).length,
    albums: albums.length,
    uniqueTags: new Set(items.flatMap(p => p.tags)).size,
    zeroViews: items.filter(p => p.views === 0).length,
    firstUpload: firstUp, lastUpload: lastUp,
    uploadsPerMonth: firstUp ? round(items.length / Math.max(1, (lastUp - firstUp) / (DAY * 30.44))) : 0,
    avgVelocity: round(totalViews / Math.max(1, sum(items.map(p => p._age))) , 3),
  };

  // Concentration: share of views from the top 1% / 10% / 20%
  const desc = [...items].sort((a, b) => b.views - a.views);
  const share = f => (totalViews ? round((sum(desc.slice(0, Math.max(1, Math.round(items.length * f))).map(p => p.views)) / totalViews) * 100) : 0);
  overview.concentration = { top1: share(0.01), top10: share(0.1), top20: share(0.2) };

  // ---------- top lists ----------
  const N = 24;
  const rateFloor = Math.max(30, medViews);
  const top = {
    views: desc.slice(0, N).map(p => slim(p)),
    faves: [...items].sort((a, b) => b.faves - a.faves || b.views - a.views).slice(0, N).map(p => slim(p)),
    comments: [...items].sort((a, b) => b.comments - a.comments || b.views - a.views).slice(0, N).map(p => slim(p)),
    faveRate: items.filter(p => p.views >= rateFloor && p.faves > 0).sort((a, b) => b._faveRate - a._faveRate).slice(0, N)
      .map(p => slim(p, { faveRate: round(p._faveRate * 100, 2) })),
    velocity: [...items].sort((a, b) => b._velocity - a._velocity).slice(0, N).map(p => slim(p, { velocity: round(p._velocity, 2) })),
    recent: items.filter(p => now - p.uploaded < 90 * DAY).sort((a, b) => b._velocity - a._velocity).slice(0, N)
      .map(p => slim(p, { velocity: round(p._velocity, 2) })),
    // Loved by the people who saw them, but few people saw them.
    hiddenGems: items.filter(p => p.views >= 10 && p.views <= Math.max(rateFloor * 2, 50) && p.faves >= 2)
      .sort((a, b) => b._faveRate - a._faveRate).slice(0, N).map(p => slim(p, { faveRate: round(p._faveRate * 100, 2) })),
    rateFloor,
  };

  // ---------- distribution ----------
  const edges = [0, 1, 10, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 50000, 100000, Infinity];
  const label = (a, b) => (b === Infinity ? `${fmtK(a)}+` : a === b - 1 ? `${fmtK(a)}` : `${fmtK(a)}–${fmtK(b - 1)}`);
  const distribution = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const c = items.filter(p => p.views >= edges[i] && p.views < edges[i + 1]).length;
    distribution.push({ label: label(edges[i], edges[i + 1]), count: c });
  }
  while (distribution.length && distribution[distribution.length - 1].count === 0) distribution.pop();

  // ---------- timeline ----------
  const monthKey = ts => { const d = new Date(ts * 1000); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); };
  const byMonth = bucketize(items.filter(p => p.uploaded), p => monthKey(p.uploaded));
  const months = [];
  if (firstUp) {
    const d = new Date(firstUp * 1000); d.setDate(1);
    const end = new Date(lastUp * 1000);
    while (d <= end) {
      const k = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
      const g = byMonth[k] || [];
      months.push({ month: k, count: g.length, views: sum(g.map(p => p.views)), faves: sum(g.map(p => p.faves)) });
      d.setMonth(d.getMonth() + 1);
    }
  }
  const upYear = bucketize(items.filter(p => p.uploaded), p => new Date(p.uploaded * 1000).getFullYear());
  const takenYear = bucketize(items, p => { const t = takenDate(p); return t ? t.y : null; });
  const timeline = {
    months,
    uploadYears: groupStats(upYear, Object.keys(upYear).sort()),
    takenYears: groupStats(takenYear, Object.keys(takenYear).sort()),
    takenUnknown: items.filter(p => !takenDate(p)).length,
  };

  // ---------- timing ----------
  const up = items.filter(p => p.uploaded).map(p => ({ p, d: new Date(p.uploaded * 1000) }));
  const heat = Array.from({ length: 7 }, () => Array(24).fill(0));
  for (const { d } of up) heat[d.getDay()][d.getHours()]++;
  const upWd = bucketize(up, x => x.d.getDay());
  const upHr = bucketize(up, x => x.d.getHours());
  const unwrap = g => Object.fromEntries(Object.entries(g).map(([k, v]) => [k, v.map(x => x.p)]));
  const tk = items.map(p => ({ p, t: takenDate(p) })).filter(x => x.t);
  const takenHeat = Array.from({ length: 7 }, () => Array(24).fill(0));
  for (const { t } of tk) if (t.h != null) takenHeat[t.wd][t.h]++;
  const timing = {
    uploadHeat: heat,
    uploadWeekday: groupStats(unwrap(upWd), [0, 1, 2, 3, 4, 5, 6].map(String)).map((r, i) => ({ ...r, key: WEEKDAYS[i] })),
    uploadHour: groupStats(unwrap(upHr), Array.from({ length: 24 }, (_, i) => String(i))),
    takenHeat,
    takenHour: groupStats(unwrap(bucketize(tk.filter(x => x.t.h != null), x => x.t.h)), Array.from({ length: 24 }, (_, i) => String(i))),
    takenWeekday: groupStats(unwrap(bucketize(tk, x => x.t.wd)), [0, 1, 2, 3, 4, 5, 6].map(String)).map((r, i) => ({ ...r, key: WEEKDAYS[i] })),
    takenMonth: groupStats(unwrap(bucketize(tk, x => x.t.mo)), Array.from({ length: 12 }, (_, i) => String(i))).map((r, i) => ({ ...r, key: MONTHS[i] })),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    // How long after taking does the photo get uploaded?
    uploadLag: (() => {
      const lags = tk.filter(x => x.p.uploaded).map(x => (x.p.uploaded - Date.UTC(x.t.y, x.t.mo, x.t.d) / 1000) / DAY).filter(d => d >= -1);
      const b = [['Same day', 1], ['Within a week', 7], ['Within a month', 31], ['Within a year', 366], ['1–5 years', 366 * 5], ['5+ years', Infinity]];
      let prev = -Infinity;
      return b.map(([name, max]) => { const c = lags.filter(l => l > prev && l <= max).length; prev = max; return { label: name, count: c }; });
    })(),
  };

  // ---------- tags ----------
  const tagMap = new Map();
  for (const p of items) for (const t of new Set(p.tags)) {
    let e = tagMap.get(t); if (!e) { e = { tag: t, count: 0, views: [], faves: 0 }; tagMap.set(t, e); }
    e.count++; e.views.push(p.views); e.faves += p.faves;
  }
  const tagRows = [...tagMap.values()].map(e => ({
    tag: e.tag, count: e.count, views: sum(e.views), avgViews: round(mean(e.views)), medianViews: round(median(e.views)), faves: e.faves,
  }));
  const minTag = Math.max(3, Math.round(items.length * 0.005));
  const tagCountBuckets = { '0': [], '1–3': [], '4–9': [], '10–19': [], '20+': [] };
  for (const p of items) {
    const n = p.tags.length;
    tagCountBuckets[n === 0 ? '0' : n <= 3 ? '1–3' : n <= 9 ? '4–9' : n <= 19 ? '10–19' : '20+'].push(p);
  }
  const tags = {
    total: tagRows.length,
    minForRanking: minTag,
    top: [...tagRows].sort((a, b) => b.count - a.count).slice(0, 80),
    best: tagRows.filter(t => t.count >= minTag).sort((a, b) => b.medianViews - a.medianViews).slice(0, 30),
    worst: tagRows.filter(t => t.count >= minTag).sort((a, b) => a.medianViews - b.medianViews).slice(0, 15),
    byTagCount: groupStats(tagCountBuckets, Object.keys(tagCountBuckets)),
  };

  // ---------- shape ----------
  const shape = groupStats(bucketize(items, orientation), ['Landscape', 'Portrait', 'Square', 'Panorama', 'Unknown']).filter(r => r.count);
  const media = groupStats(bucketize(items, p => p.media), ['photo', 'video']).filter(r => r.count);
  const megapixels = groupStats(bucketize(onlyPhotos.filter(p => p.w && p.h), p => {
    const mp = (p.w * p.h) / 1e6;
    return mp < 2 ? '< 2 MP' : mp < 6 ? '2–6 MP' : mp < 12 ? '6–12 MP' : mp < 24 ? '12–24 MP' : mp < 40 ? '24–40 MP' : '40+ MP';
  }), ['< 2 MP', '2–6 MP', '6–12 MP', '12–24 MP', '24–40 MP', '40+ MP']).filter(r => r.count);

  // ---------- geo ----------
  const geo = {
    count: geotagged.length,
    points: geotagged.map(p => [p.id, round(p.lat, 5), round(p.lon, 5), p.views, p.title.slice(0, 80), p.thumb]),
    compare: groupStats({ Geotagged: geotagged, 'Not geotagged': items.filter(p => p.lat == null) }, ['Geotagged', 'Not geotagged']),
  };

  // ---------- albums ----------
  const byId = new Map(items.map(p => [p.id, p]));
  const albumRows = albums.map(a => {
    const m = (a.members || []).map(id => byId.get(id)).filter(Boolean);
    const v = m.map(p => p.views);
    return {
      id: a.id, title: a.title, thumb: a.thumb, photos: a.photos + a.videos, albumViews: a.views,
      photoViews: sum(v), avgPhotoViews: round(mean(v)), medianPhotoViews: round(median(v)), faves: sum(m.map(p => p.faves)),
      created: a.created, updated: a.updated,
    };
  }).sort((a, b) => b.photoViews - a.photoViews);
  const albumCountBuckets = groupStats(bucketize(items, p => (p.albums === 0 ? 'None' : p.albums === 1 ? '1' : p.albums <= 3 ? '2–3' : '4+')), ['None', '1', '2–3', '4+']);

  // ---------- library health ----------
  const titleCounts = new Map();
  for (const p of items) { const t = (p.title || '').trim().toLowerCase(); if (t && !isUntitled(p)) titleCounts.set(t, (titleCounts.get(t) || 0) + 1); }
  const checks = {
    untitled: { label: 'Untitled or camera filename', why: 'A real title helps search and makes people click.', test: p => isUntitled(p) },
    noTags: { label: 'No tags', why: 'Tags are how Flickr search and groups find your work.', test: p => p.tags.length === 0 },
    fewTags: { label: 'Fewer than 4 tags', why: 'Photos with more tags tend to be found more often.', test: p => p.tags.length > 0 && p.tags.length < 4 },
    noDesc: { label: 'No description', why: 'A sentence of context adds searchable words.', test: p => !p.desc.trim() },
    noAlbum: { label: 'Not in any album', why: 'Albums are a second way in to every photo.', test: p => p.albums === 0 },
    noGeo: { label: 'Not geotagged', why: 'Location puts photos on the map and in place searches.', test: p => p.lat == null },
    noDate: { label: 'Date taken unknown', why: 'Flickr guessed the date; timelines will be off.', test: p => !takenDate(p) },
    private: { label: 'Private (only you)', why: 'Nobody else can see these.', test: p => !p.ispublic && !p.isfriend && !p.isfamily },
    allRights: { label: 'All rights reserved', why: 'Fine if intended; a CC license allows reuse with credit.', test: p => p.license === '0' },
    dupTitle: { label: 'Shares its title with another photo', why: 'Possible duplicates, or titles worth making unique.', test: p => titleCounts.get((p.title || '').trim().toLowerCase()) > 1 },
    zeroViews: { label: 'Never viewed', why: 'Usually private, very new, or hard to find.', test: p => p.views === 0 },
  };
  const health = Object.entries(checks).map(([key, c]) => {
    const hit = items.filter(c.test);
    return { key, label: c.label, why: c.why, count: hit.length, pct: items.length ? round((hit.length / items.length) * 100) : 0, sample: hit.sort((a, b) => b.views - a.views).slice(0, 12).map(p => slim(p)) };
  });
  // A 0–100 score weighted towards the things that affect discoverability.
  const weights = { untitled: 20, noTags: 25, noDesc: 10, noAlbum: 15, noGeo: 10, noDate: 5, fewTags: 15 };
  const score = Math.round(Object.entries(weights).reduce((s, [k, w]) => s + w * (1 - (health.find(h => h.key === k).pct / 100)), 0));
  const licenses = Object.entries(bucketize(items, p => p.license)).map(([k, v]) => ({ key: LICENSES[k] || 'License ' + k, count: v.length })).sort((a, b) => b.count - a.count);

  // ---------- EXIF ----------
  const ex = items.map(p => ({ p, e: exif[p.id] })).filter(x => x.e);
  const exGroup = (fn, order, limit = 25) => {
    const g = {};
    for (const { p, e } of ex) { const k = fn(e); if (k == null || k === '') continue; (g[k] = g[k] || []).push(p); }
    const rows = groupStats(g, order ? order.filter(k => g[k]) : undefined);
    return order ? rows : rows.sort((a, b) => b.count - a.count).slice(0, limit);
  };
  const fBucket = f => (f == null ? null : f < 15 ? '< 15mm' : f < 24 ? '15–23mm' : f < 35 ? '24–34mm' : f < 50 ? '35–49mm' : f < 85 ? '50–84mm' : f < 135 ? '85–134mm' : f < 300 ? '135–299mm' : '300mm+');
  const isoBucket = i => (i == null ? null : i <= 100 ? '≤100' : i <= 200 ? '101–200' : i <= 400 ? '201–400' : i <= 800 ? '401–800' : i <= 1600 ? '801–1600' : i <= 3200 ? '1601–3200' : i <= 6400 ? '3201–6400' : '6400+');
  const apBucket = a => (a == null ? null : a < 2 ? 'f/<2' : a < 2.8 ? 'f/2–2.7' : a < 4 ? 'f/2.8–3.9' : a < 5.6 ? 'f/4–5.5' : a < 8 ? 'f/5.6–7.9' : a < 11 ? 'f/8–10' : 'f/11+');
  const shBucket = s => (s == null ? null : s >= 1 ? '1s+' : s >= 1 / 15 ? '1/15–1s' : s >= 1 / 60 ? '1/60–1/15' : s >= 1 / 250 ? '1/250–1/60' : s >= 1 / 1000 ? '1/1000–1/250' : '< 1/1000');
  const exifOut = {
    scanned: Object.keys(exif).length,
    withData: ex.length,
    eligible: onlyPhotos.length,
    cameras: exGroup(e => e.camera),
    lenses: exGroup(e => e.lens),
    focal: exGroup(e => fBucket(e.focal35 || e.focal), ['< 15mm', '15–23mm', '24–34mm', '35–49mm', '50–84mm', '85–134mm', '135–299mm', '300mm+']),
    aperture: exGroup(e => apBucket(e.aperture), ['f/<2', 'f/2–2.7', 'f/2.8–3.9', 'f/4–5.5', 'f/5.6–7.9', 'f/8–10', 'f/11+']),
    iso: exGroup(e => isoBucket(e.iso), ['≤100', '101–200', '201–400', '401–800', '801–1600', '1601–3200', '3201–6400', '6400+']),
    shutter: exGroup(e => shBucket(e.shutter), ['< 1/1000', '1/1000–1/250', '1/250–1/60', '1/60–1/15', '1/15–1s', '1s+']),
    software: exGroup(e => e.software && e.software.replace(/\s*\(.*\)$/, '').replace(/\s+[\d.]+$/, ''), null, 12),
    cameraYears: (() => {
      // Which camera did you use most each year?
      const g = {};
      for (const { p, e } of ex) {
        const t = takenDate(p); if (!t || !e.camera) continue;
        (g[t.y] = g[t.y] || {})[e.camera] = (g[t.y][e.camera] || 0) + 1;
      }
      return Object.keys(g).sort().map(y => {
        const [cam, n] = Object.entries(g[y]).sort((a, b) => b[1] - a[1])[0];
        return { year: y, camera: cam, count: n, total: sum(Object.values(g[y])) };
      });
    })(),
  };

  // ---------- Pro stats ----------
  let recent = null;
  if (stats) {
    const days = stats.days || [];
    const last7 = sum(days.slice(-7).map(d => d.total)), prev7 = sum(days.slice(-14, -7).map(d => d.total));
    recent = {
      error: stats.error, fetchedAt: stats.fetchedAt, totals: stats.totals, days,
      total28: sum(days.map(d => d.total)), last7, prev7,
      change7: prev7 ? round(((last7 - prev7) / prev7) * 100) : null,
      bestDay: days.reduce((b, d) => (!b || d.total > b.total ? d : b), null),
      trending: (stats.trending || []).slice(0, 30).map(t => {
        const p = byId.get(t.id);
        return { ...t, title: t.title || p?.title || '', thumb: t.thumb || p?.thumb, allTime: p?.views ?? null, share: p?.views ? round((t.views / p.views) * 100) : null };
      }),
      domains: stats.domains || [],
    };
  }

  // ---------- insights ----------
  const insights = buildInsights({ items, overview, timing, tags, geo, health, shape, albumCountBuckets, top, recent, exifOut, timeline });

  return {
    generatedAt: Date.now(), profile, overview, top, distribution, timeline, timing, tags, shape, media, megapixels,
    geo, albums: albumRows, albumCountBuckets, health: { score, checks: health, licenses }, exif: exifOut, recent, insights,
  };
}

function fmtK(n) {
  if (n >= 1e6) return round(n / 1e6) + 'M';
  if (n >= 1e3) return round(n / 1e3) + 'k';
  return String(n);
}

function compare(groupA, groupB) {
  if (!groupA || !groupB || groupA.count < 5 || groupB.count < 5 || !groupB.medianViews) return null;
  return groupA.medianViews / groupB.medianViews;
}

function buildInsights(c) {
  const n = x => Math.round(x).toLocaleString('en-US');
  const out = [];
  const add = (tone, title, text) => out.push({ tone, title, text });
  const o = c.overview;
  if (!o.items) return out;

  add('info', 'Where your views come from',
    `Your top 10% of photos earn ${o.concentration.top10}% of all views; the top 1% alone earn ${o.concentration.top1}%. ` +
    (o.concentration.top10 > 60 ? 'A few hits carry the library, so the long tail has room to grow.' : 'Views are spread fairly evenly across the library.'));

  const [geoA, geoB] = c.geo.compare;
  const g = compare(geoA, geoB);
  if (g && Math.abs(g - 1) > 0.15) add(g > 1 ? 'good' : 'info', 'Geotagging',
    `Geotagged photos get a median of ${n(geoA.medianViews)} views against ${n(geoB.medianViews)} for the rest (${g > 1 ? round(g, 1) + '×' : round(1 / g, 1) + '× fewer'}). ${geoB.count.toLocaleString()} photos have no location.`);

  const tb = c.tags.byTagCount.filter(r => r.count >= 5);
  if (tb.length >= 2) {
    const best = tb.reduce((a, b) => (b.medianViews > a.medianViews ? b : a));
    const zero = tb.find(r => r.key === '0');
    if (zero && best.key !== '0' && best.medianViews > zero.medianViews * 1.15)
      add('good', 'Tags pay off', `Photos with ${best.key} tags get a median of ${n(best.medianViews)} views; photos with no tags get ${n(zero.medianViews)}. ${zero.count.toLocaleString()} photos have no tags.`);
  }
  if (c.tags.best.length) {
    const t = c.tags.best.slice(0, 3).map(x => `“${x.tag}” (${n(x.medianViews)})`).join(', ');
    add('info', 'Your strongest subjects', `Among tags used on at least ${c.tags.minForRanking} photos, the highest median views are ${t}.`);
  }

  const wd = c.timing.uploadWeekday.filter(r => r.count >= 5);
  if (wd.length >= 4) {
    const best = wd.reduce((a, b) => (b.medianViews > a.medianViews ? b : a));
    const worst = wd.reduce((a, b) => (b.medianViews < a.medianViews ? b : a));
    if (best.medianViews > worst.medianViews * 1.2)
      add('info', 'Best day to upload', `Photos uploaded on ${best.key} get a median of ${n(best.medianViews)} views, against ${worst.medianViews} on ${worst.key}. Upload timing is a weak signal, so treat it as a hint.`);
  }
  const hrs = c.timing.uploadHour.filter(r => r.count >= 5);
  if (hrs.length >= 6) {
    const best = hrs.reduce((a, b) => (b.medianViews > a.medianViews ? b : a));
    add('info', 'Best hour to upload', `Uploads around ${String(best.key).padStart(2, '0')}:00 (${c.timing.timezone}) have the highest median views: ${n(best.medianViews)}.`);
  }

  const sh = c.shape.filter(r => r.count >= 5 && r.key !== 'Unknown');
  if (sh.length >= 2) {
    const best = sh.reduce((a, b) => (b.medianViews > a.medianViews ? b : a));
    const most = sh.reduce((a, b) => (b.count > a.count ? b : a));
    if (best.key !== most.key && best.medianViews > most.medianViews * 1.15)
      add('good', 'Shape matters', `${best.key} shots get a median of ${n(best.medianViews)} views, against ${n(most.medianViews)} for ${most.key.toLowerCase()} shots, which you post most.`);
  }

  const al = c.albumCountBuckets.filter(r => r.count >= 5);
  const none = al.find(r => r.key === 'None'), inOne = al.filter(r => r.key !== 'None');
  if (none && inOne.length) {
    const avg = inOne.reduce((s, r) => s + r.medianViews * r.count, 0) / inOne.reduce((s, r) => s + r.count, 0);
    if (avg > none.medianViews * 1.15) add('good', 'Albums help', `Photos in at least one album get a median of ${n(avg)} views; photos in none get ${n(none.medianViews)}. ${none.count.toLocaleString()} photos are in no album.`);
  }

  if (c.top.hiddenGems.length) {
    const h = c.top.hiddenGems[0];
    add('good', 'Hidden gems', `${c.top.hiddenGems.length} photos are faved often by the few people who see them. “${h.title || 'Untitled'}” has ${n(h.faves)} faves from ${n(h.views)} views (${h.faveRate}%). Share them in groups.`);
  }

  const h = Object.fromEntries(c.health.map(x => [x.key, x]));
  const fix = ['untitled', 'noTags', 'noAlbum'].filter(k => h[k].pct >= 20).map(k => `${h[k].count.toLocaleString()} ${h[k].label.toLowerCase()}`);
  if (fix.length) add('warn', 'Quick wins', `Biggest gaps in your library: ${fix.join('; ')}. See Library health.`);

  const ty = c.timeline.uploadYears.filter(r => r.count >= 10);
  if (ty.length >= 3) {
    const best = ty.reduce((a, b) => (b.medianViews > a.medianViews ? b : a));
    add('info', 'Your best year', `Photos uploaded in ${best.key} have the highest median views (${n(best.medianViews)}). Older photos have had longer to collect views, so recent years read low.`);
  }

  if (c.recent && !c.recent.error && c.recent.change7 != null) {
    const up = c.recent.change7 >= 0;
    add(up ? 'good' : 'warn', 'Last 7 days', `${c.recent.last7.toLocaleString()} views in the last 7 full days, ${up ? 'up' : 'down'} ${Math.abs(c.recent.change7)}% on the week before.`);
  }

  if (c.exifOut.cameras.length >= 2) {
    const cams = c.exifOut.cameras.filter(r => r.count >= 10);
    if (cams.length >= 2) {
      const best = cams.reduce((a, b) => (b.medianViews > a.medianViews ? b : a));
      add('info', 'Camera', `Your most-used camera is ${c.exifOut.cameras[0].key} (${c.exifOut.cameras[0].count} photos). Photos from the ${best.key} get the highest median views (${n(best.medianViews)}).`);
    }
  }
  return out;
}

module.exports = { analyze, isUntitled, takenDate, orientation, LICENSES };
