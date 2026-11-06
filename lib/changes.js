'use strict';
// Tracks what changed between syncs: per-photo count snapshots, a totals history, and diffs.

const DAY_MS = 86400000;
const KEEP_DAYS = 120;
const pad = n => String(n).padStart(2, '0');
const localDate = ms => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

// id -> [views, faves, comments, lastupdate]
function countsOf(photos) {
  const c = {};
  for (const p of photos) c[p.id] = [p.views, p.faves, p.comments, p.updated];
  return c;
}

function totals(photos) {
  let views = 0, faves = 0, comments = 0;
  for (const p of photos) { views += p.views; faves += p.faves; comments += p.comments; }
  return { items: photos.length, views, faves, comments };
}

// Called by a sync once it has the new photo list, before it overwrites photos.json.
const MIN_BASELINE_AGE = 30 * 60 * 1000;
function recordSync(u, prevPhotos, prevSyncAt, photos, now = Date.now()) {
  let base = prevPhotos ? { t: prevSyncAt || null, counts: countsOf(prevPhotos) } : null;
  // If the previous check was only minutes ago (e.g. the app was restarted), keep comparing
  // against the older baseline so "since last check" doesn't collapse to zero.
  const kept = u.get('last');
  if (base && kept && kept.t && prevSyncAt && now - prevSyncAt < MIN_BASELINE_AGE) base = kept;
  if (base) u.set('last', base);
  const date = localDate(now);
  u.setSnapshot(date, { t: now, counts: countsOf(photos) });
  const history = (u.get('history') || []).filter(h => h.date !== date);
  history.push({ date, t: now, ...totals(photos) });
  history.sort((a, b) => a.date.localeCompare(b.date));
  u.set('history', history.slice(-400));
  u.pruneSnapshots(localDate(now - KEEP_DAYS * DAY_MS));
  return diff(photos, base);
}

// since: 'last' (previous sync) or a number of days.
function baseline(u, since, now = Date.now()) {
  if (since === 'last' || !since) {
    const b = u.get('last');
    return b ? { ...b, label: 'last' } : null;
  }
  const days = Number(since);
  const target = localDate(now - days * DAY_MS);
  const today = localDate(now);
  const dates = u.listSnapshots().filter(d => d < today);
  if (!dates.length) return null;
  let pick = null;
  for (const d of dates) if (d <= target) pick = d;
  const approx = !pick;
  if (!pick) pick = dates[0]; // nothing that old yet: use the oldest we have
  const snap = u.getSnapshot(pick);
  return snap ? { ...snap, date: pick, approx } : null;
}

function slim(p, extra) {
  return { id: p.id, title: p.title, thumb: p.thumb, views: p.views, faves: p.faves, comments: p.comments, uploaded: p.uploaded, ...extra };
}

function diff(photos, base) {
  if (!base || !base.counts) return null;
  const out = { since: base.t || null, date: base.date || null, approx: !!base.approx, views: 0, faves: 0, comments: 0, newCount: 0, removed: 0, edited: 0, photosGained: 0 };
  const gains = [], newItems = [];
  const seen = new Set();
  for (const p of photos) {
    seen.add(p.id);
    const b = base.counts[p.id];
    if (!b) {
      out.newCount++; newItems.push(p);
      out.views += p.views; out.faves += p.faves; out.comments += p.comments;
      continue;
    }
    const gv = p.views - b[0], gf = p.faves - b[1], gc = p.comments - b[2];
    out.views += gv; out.faves += gf; out.comments += gc;
    if (gv > 0) out.photosGained++;
    if (b[3] && p.updated && p.updated !== b[3]) out.edited++;
    if (gv > 0 || gf > 0 || gc > 0) gains.push({ p, gv, gf, gc });
  }
  for (const id of Object.keys(base.counts)) if (!seen.has(id)) out.removed++;
  out.gainers = gains.filter(g => g.gv > 0).sort((a, b) => b.gv - a.gv).slice(0, 24).map(g => slim(g.p, { gain: g.gv, faveGain: g.gf, commentGain: g.gc }));
  out.faveGainers = gains.filter(g => g.gf > 0).sort((a, b) => b.gf - a.gf || b.gv - a.gv).slice(0, 12).map(g => slim(g.p, { gain: g.gv, faveGain: g.gf, commentGain: g.gc }));
  out.commentGainers = gains.filter(g => g.gc > 0).sort((a, b) => b.gc - a.gc).slice(0, 12).map(g => slim(g.p, { gain: g.gv, faveGain: g.gf, commentGain: g.gc }));
  out.newItems = newItems.sort((a, b) => b.uploaded - a.uploaded).slice(0, 24).map(p => slim(p));
  return out;
}

module.exports = { recordSync, baseline, diff, countsOf, localDate };
