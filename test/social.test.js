const test = require('node:test');
const assert = require('node:assert');
const s = require('../lib/social');

const DAY = 86400000;
const item = (id, events) => ({ type: 'photo', id, title: { _content: 'P' + id }, server: '1', secret: 'x', activity: { event: events } });
const ev = (type, user, secs, extra = {}) => ({ type, user, username: user, dateadded: String(secs), iconserver: '0', iconfarm: 0, ...extra });

test('parseActivity flattens events and keeps comment text', () => {
  const out = s.parseActivity([item('1', [ev('fave', 'a', 100), ev('comment', 'b', 200, { _content: 'Nice!' })]), { type: 'photoset', id: 'x' }]);
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[0].photo, '1');
  assert.strictEqual(out[0].t, 100000);
  assert.strictEqual(out[1].text, 'Nice!');
  assert.ok(out[0].thumb.includes('1_x_q.jpg'));
});

test('mergeActivity de-duplicates, sorts newest first and drops old events', () => {
  const now = Date.UTC(2026, 10, 6);
  const a = s.parseActivity([item('1', [ev('fave', 'a', (now - DAY) / 1000)])]);
  const b = s.parseActivity([item('1', [ev('fave', 'a', (now - DAY) / 1000), ev('fave', 'c', (now - 3600000) / 1000)])]);
  const old = s.parseActivity([item('2', [ev('fave', 'z', (now - 500 * DAY) / 1000)])]);
  const m = s.mergeActivity([...a, ...old], b, now);
  assert.deepStrictEqual(m.map(e => e.user), ['c', 'a']);
});

test('activityWindow counts by window and ranks people and photos', () => {
  const now = Date.UTC(2026, 10, 6, 12);
  const events = s.parseActivity([
    item('1', [ev('fave', 'a', (now - 2 * 3600000) / 1000), ev('comment', 'a', (now - 3 * 3600000) / 1000)]),
    item('2', [ev('fave', 'b', (now - 3 * DAY) / 1000)]),
  ]);
  const day = s.activityWindow(events, 24, now);
  assert.strictEqual(day.faves, 1);
  assert.strictEqual(day.comments, 1);
  assert.strictEqual(day.people, 1);
  assert.ok(day.hourly);
  assert.strictEqual(day.buckets.length, 24);
  assert.strictEqual(day.buckets.reduce((x, b) => x + b.faves + b.comments, 0), 2);
  const week = s.activityWindow(events, 168, now);
  assert.strictEqual(week.faves, 2);
  assert.strictEqual(week.buckets.length, 7);
  assert.strictEqual(week.topPhotos[0].id, '1');
});

test('exploreDays covers the day before to three days after public uploads, skipping checked days', () => {
  const now = Date.UTC(2026, 10, 6, 12);
  const up = Date.UTC(2026, 9, 10, 15) / 1000;
  const photos = [{ ispublic: 1, uploaded: up }, { ispublic: 0, uploaded: Date.UTC(2020, 0, 1) / 1000 }];
  const { all, todo } = s.exploreDays(photos, null, now);
  assert.deepStrictEqual(all, ['2026-10-13', '2026-10-12', '2026-10-11', '2026-10-10', '2026-10-09']);
  assert.strictEqual(todo.length, 5);
  // checked long after the date: final. Checked the same day: needs another look.
  const cache = { days: { '2026-10-13': { t: Date.UTC(2026, 10, 1), hits: [] }, '2026-10-12': { t: Date.UTC(2026, 9, 12, 20), hits: [] } } };
  assert.strictEqual(s.exploreDays(photos, cache, now).todo.length, 4);
  // never includes today or later
  const recent = s.exploreDays([{ ispublic: 1, uploaded: now / 1000 }], null, now);
  assert.ok(recent.all.every(d => d < '2026-11-06'));
});

test('exploreHits lists every photo found with its date and position', () => {
  const hits = s.exploreHits({ days: { '2020-01-02': { t: 1, hits: [['9', 42]] }, '2020-01-03': { t: 1, hits: [] } } });
  assert.deepStrictEqual(hits, [{ id: '9', date: '2020-01-02', rank: 42 }]);
});

test('normGroup reads counts, roles and posting limits', () => {
  const g = s.normGroup({ nsid: '1@N25', name: 'G', members: '37998', pool_count: '724907', is_admin: 0, is_moderator: 1, iconserver: '0', throttle: { count: '1', mode: 'day', remaining: 0 } });
  assert.strictEqual(g.members, 37998);
  assert.strictEqual(g.pool, 724907);
  assert.ok(g.moderator && !g.admin);
  assert.deepStrictEqual(g.throttle, { count: 1, mode: 'day', remaining: 0 });
  assert.strictEqual(s.normGroup({ nsid: '2', throttle: { mode: 'none' } }).throttle, null);
});
