'use strict';
// Groups, contacts, activity (faves/comments on your photos), video details and Explore history.

const DAY = 86400000;
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const buddyIcon = (nsid, farm, server) => num(server) > 0
  ? `https://farm${farm}.staticflickr.com/${server}/buddyicons/${nsid}.jpg`
  : 'https://www.flickr.com/images/buddyicon.gif';
const ymd = ms => new Date(ms).toISOString().slice(0, 10);

// ---------- groups ----------
function normGroup(g) {
  const nsid = g.nsid || g.id;
  const th = g.throttle || null;
  return {
    nsid,
    name: g.name || g.title || '',
    pathAlias: g.path_alias || g.pathalias || null,
    icon: num(g.iconserver) > 0 ? `https://farm${g.iconfarm}.staticflickr.com/${g.iconserver}/buddyicons/${nsid}.jpg` : 'https://www.flickr.com/images/buddyicon.gif',
    members: num(g.members),
    pool: num(g.pool_count),
    topics: num(g.topic_count),
    privacy: num(g.privacy) || null, // 1 private, 2 invite-only public, 3 public
    admin: !!(num(g.is_admin) || g.admin === true || num(g.admin)),
    moderator: !!num(g.is_moderator),
    adult: !!num(g.eighteenplus),
    inviteOnly: !!num(g.invitation_only),
    lastActivity: num(g.dateactivity) || null,
    created: g.datecreate || null,
    throttle: th && th.mode && th.mode !== 'none' ? { count: num(th.count), mode: th.mode, remaining: th.remaining == null ? null : num(th.remaining) } : null,
  };
}
async function fetchGroups(flickr, nsid, own) {
  const r = own
    ? await flickr.call('flickr.people.getGroups', { user_id: nsid })
    : await flickr.call('flickr.people.getPublicGroups', { user_id: nsid, invitation_only: 1 }, { auth: false });
  return (r.groups.group || []).map(normGroup);
}

// ---------- contacts ----------
function normContact(c) {
  return {
    nsid: c.nsid, username: c.username || '', realname: c.realname || '',
    icon: buddyIcon(c.nsid, c.iconfarm, c.iconserver),
    pathAlias: c.path_alias || null, location: c.location || '',
    friend: !!num(c.friend), family: !!num(c.family),
  };
}
async function fetchContacts(flickr, nsid, own) {
  const out = [];
  let page = 1, pages = 1;
  do {
    const r = own
      ? await flickr.call('flickr.contacts.getList', { per_page: 1000, page, sort: 'name' })
      : await flickr.call('flickr.contacts.getPublicList', { user_id: nsid, per_page: 1000, page }, { auth: false });
    pages = num(r.contacts.pages) || 1;
    out.push(...(r.contacts.contact || []).map(normContact));
    page++;
  } while (page <= pages && page <= 20);
  return out;
}
// Live: newest photos from your contacts, and which contacts uploaded this week. Own account only.
async function fetchContactsRecent(flickr) {
  const r = await flickr.call('flickr.photos.getContactsPhotos', { count: 50, extras: 'date_upload,owner_name,url_q,url_z,views,media,path_alias' });
  const photos = (r.photos.photo || []).map(p => ({
    id: p.id, owner: p.owner, ownerName: p.ownername || p.username || '', title: p.title || '',
    thumb: p.url_q || null, img: p.url_z || null, views: num(p.views), uploaded: num(p.dateupload), media: p.media || 'photo',
    url: `https://www.flickr.com/photos/${p.pathalias || p.owner}/${p.id}/`,
  })).sort((a, b) => b.uploaded - a.uploaded);
  return { fetchedAt: Date.now(), photos, uploaders: recentUploaders(photos) };
}
// Who posted the recent photos: count and newest upload per contact.
function recentUploaders(photos) {
  const m = new Map();
  for (const p of photos) {
    const u = m.get(p.owner) || { nsid: p.owner, name: p.ownerName, count: 0, latest: 0 };
    u.count++; u.latest = Math.max(u.latest, p.uploaded);
    m.set(p.owner, u);
  }
  return [...m.values()].sort((a, b) => b.latest - a.latest);
}

// ---------- activity: faves and comments on your photos ----------
// Flickr returns up to 30 days of activity. Events are merged into a local log so history
// builds up beyond that.
const KEEP_ACTIVITY_DAYS = 400;
function eventKey(e) { return `${e.type}|${e.user}|${e.photo}|${e.t}`; }
function parseActivity(items) {
  const events = [];
  for (const it of items || []) {
    if (it.type !== 'photo') continue;
    const title = it.title?._content ?? it.title ?? '';
    const thumb = it.server && it.secret ? `https://live.staticflickr.com/${it.server}/${it.id}_${it.secret}_q.jpg` : null;
    for (const e of it.activity?.event || []) {
      const ev = {
        type: e.type, t: num(e.dateadded) * 1000,
        user: e.user, username: e.username || '', realname: e.realname || '',
        icon: buddyIcon(e.user, e.iconfarm, e.iconserver),
        photo: it.id, title, thumb,
      };
      if (e._content) ev.text = String(e._content).slice(0, 500);
      events.push(ev);
    }
  }
  return events;
}
function mergeActivity(prevEvents, fresh, now = Date.now()) {
  const map = new Map();
  for (const e of prevEvents || []) map.set(eventKey(e), e);
  for (const e of fresh) map.set(eventKey(e), e);
  return [...map.values()].filter(e => now - e.t < KEEP_ACTIVITY_DAYS * DAY).sort((a, b) => b.t - a.t);
}
async function fetchActivity(flickr, prev) {
  const now = Date.now();
  const days = prev?.fetchedAt ? Math.min(30, Math.ceil((now - prev.fetchedAt) / DAY) + 1) : 30;
  const items = [];
  let page = 1, pages = 1;
  do {
    const r = await flickr.call('flickr.activity.userPhotos', { timeframe: days + 'd', per_page: 50, page });
    pages = num(r.items.pages) || 1;
    items.push(...(r.items.item || []));
    page++;
  } while (page <= pages && page <= 20);
  return {
    fetchedAt: now,
    since: prev?.since || now - 30 * DAY, // how far back the log is complete
    events: mergeActivity(prev?.events, parseActivity(items), now),
  };
}
// Summaries for a window of `hours`.
function activityWindow(events, hours, now = Date.now()) {
  const from = now - hours * 3600000;
  const list = events.filter(e => e.t >= from && e.t <= now);
  const faves = list.filter(e => e.type === 'fave'), comments = list.filter(e => e.type === 'comment');
  const people = new Map(), photos = new Map();
  for (const e of list) {
    const p = people.get(e.user) || { nsid: e.user, username: e.username, realname: e.realname, icon: e.icon, faves: 0, comments: 0 };
    if (e.type === 'fave') p.faves++; else if (e.type === 'comment') p.comments++;
    people.set(e.user, p);
    const ph = photos.get(e.photo) || { id: e.photo, title: e.title, thumb: e.thumb, faves: 0, comments: 0 };
    if (e.type === 'fave') ph.faves++; else if (e.type === 'comment') ph.comments++;
    photos.set(e.photo, ph);
  }
  // buckets: hourly for a day, daily otherwise
  const hourly = hours <= 48;
  const step = hourly ? 3600000 : DAY;
  const n = Math.ceil((hours * 3600000) / step);
  const start = hourly ? Math.floor(now / step) * step - (n - 1) * step : startOfDay(now) - (n - 1) * DAY;
  const buckets = Array.from({ length: n }, (_, i) => ({ t: start + i * step, faves: 0, comments: 0 }));
  for (const e of list) {
    const i = Math.floor(((hourly ? e.t : startOfDay(e.t)) - start) / step);
    if (buckets[i]) { if (e.type === 'fave') buckets[i].faves++; else if (e.type === 'comment') buckets[i].comments++; }
  }
  const score = x => x.faves + x.comments * 2;
  return {
    hours, from, faves: faves.length, comments: comments.length, people: people.size, photos: photos.size,
    hourly, buckets,
    topPeople: [...people.values()].sort((a, b) => score(b) - score(a)).slice(0, 24),
    topPhotos: [...photos.values()].sort((a, b) => score(b) - score(a)).slice(0, 24),
    feed: list.slice(0, 200),
  };
}
function startOfDay(ms) { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); }

// ---------- videos ----------
async function fetchVideoInfo(flickr, photos, prev, own) {
  const out = { ...(prev || {}) };
  const todo = photos.filter(p => p.media === 'video' && !(p.id in out)).slice(0, 200); // the rest on later syncs
  for (const p of todo) {
    try {
      const r = await flickr.call('flickr.photos.getInfo', { photo_id: p.id }, { auth: own });
      const v = r.photo.video || {};
      out[p.id] = { duration: num(v.duration), w: num(v.width), h: num(v.height), ready: !!num(v.ready) };
    } catch { out[p.id] = null; }
  }
  const ids = new Set(photos.map(p => p.id));
  for (const id of Object.keys(out)) if (!ids.has(id)) delete out[id];
  return { videos: out, fetched: todo.length };
}

// ---------- Explore ----------
// Flickr has no "was this photo explored" call, but interestingness.getList returns a day's
// Explore list (up to 500 photos). Photos are picked within a few days of upload, so check
// each day from the day before an upload to three days after. Days are cached; a day is
// rechecked only if it was last checked before it was final.
const EXPLORE_START = '2004-08-01';
function exploreDays(photos, cache, now = Date.now()) {
  const last = ymd(now - DAY); // today's list isn't complete yet
  const want = new Set();
  for (const p of photos) {
    if (!p.ispublic || !p.uploaded) continue;
    for (let k = -1; k <= 3; k++) {
      const d = ymd(p.uploaded * 1000 + k * DAY);
      if (d >= EXPLORE_START && d <= last) want.add(d);
    }
  }
  const all = [...want].sort().reverse();
  const todo = all.filter(d => !isFinal(cache?.days?.[d], d));
  return { all, todo };
}
function isFinal(rec, d) { return !!rec && rec.t >= Date.parse(d + 'T00:00:00Z') + 3 * DAY; }
function exploreHits(cache) {
  const hits = [];
  for (const [d, rec] of Object.entries(cache?.days || {})) for (const [id, rank] of rec.hits || []) hits.push({ id, date: d, rank });
  return hits;
}

module.exports = {
  normGroup, fetchGroups, normContact, fetchContacts, fetchContactsRecent,
  parseActivity, mergeActivity, fetchActivity, activityWindow,
  fetchVideoInfo, exploreDays, exploreHits, isFinal, buddyIcon,
};
