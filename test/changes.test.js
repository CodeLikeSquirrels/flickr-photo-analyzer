const test = require('node:test');
const assert = require('node:assert');
const { recordSync, baseline, diff, localDate } = require('../lib/changes');

// In-memory stand-in for store.user(nsid)
function memUser() {
  const files = {}, snaps = {};
  return {
    files, snaps,
    get: n => files[n] ?? null, set: (n, v) => { files[n] = JSON.parse(JSON.stringify(v)); },
    setSnapshot: (d, v) => { snaps[d] = JSON.parse(JSON.stringify(v)); }, getSnapshot: d => snaps[d] ?? null,
    listSnapshots: () => Object.keys(snaps).sort(), pruneSnapshots: after => { for (const d of Object.keys(snaps)) if (d < after) delete snaps[d]; },
  };
}
const ph = (id, views, faves = 0, comments = 0, updated = 1) => ({ id, title: 'p' + id, thumb: null, views, faves, comments, updated, uploaded: Number(id) });

test('first sync records a snapshot but no diff', () => {
  const u = memUser();
  const d = recordSync(u, null, null, [ph('1', 10)], Date.UTC(2026, 0, 10, 12));
  assert.strictEqual(d, null);
  assert.strictEqual(u.listSnapshots().length, 1);
  assert.strictEqual(u.get('history').length, 1);
});

test('second sync diffs against the previous one', () => {
  const u = memUser();
  const t1 = Date.UTC(2026, 0, 10, 12), t2 = Date.UTC(2026, 0, 11, 12);
  const before = [ph('1', 10, 1), ph('2', 5), ph('3', 7)];
  recordSync(u, null, null, before, t1);
  const after = [ph('1', 25, 3, 1, 2), ph('2', 5), ph('4', 2)]; // 1 gained, 3 removed, 4 new
  const d = recordSync(u, before, t1, after, t2);
  assert.strictEqual(d.views, 15 + 2);
  assert.strictEqual(d.faves, 2);
  assert.strictEqual(d.comments, 1);
  assert.strictEqual(d.newCount, 1);
  assert.strictEqual(d.removed, 1);
  assert.strictEqual(d.edited, 1);
  assert.strictEqual(d.gainers[0].id, '1');
  assert.strictEqual(d.gainers[0].gain, 15);
  assert.strictEqual(u.get('history').length, 2);
  // 'last' baseline is the previous sync
  const again = diff(after, baseline(u, 'last', t2));
  assert.strictEqual(again.views, 17);
});

test('day baselines pick the latest snapshot on or before the target date', () => {
  const u = memUser();
  const day = d => Date.UTC(2026, 0, d, 12);
  recordSync(u, null, null, [ph('1', 100)], day(1));
  recordSync(u, [ph('1', 100)], day(1), [ph('1', 150)], day(5));
  recordSync(u, [ph('1', 150)], day(5), [ph('1', 190)], day(9));
  const now = day(10);
  const b7 = baseline(u, 7, now); // target Jan 3 -> Jan 1 snapshot
  assert.strictEqual(b7.date, localDate(day(1)));
  assert.strictEqual(diff([ph('1', 200)], b7).views, 100);
  const b2 = baseline(u, 2, now); // target Jan 8 -> Jan 5 snapshot
  assert.strictEqual(diff([ph('1', 200)], b2).views, 50);
  const b90 = baseline(u, 90, now); // older than anything -> oldest, flagged approx
  assert.ok(b90.approx);
});

test('same-day resync replaces that day in history', () => {
  const u = memUser();
  const t = Date.UTC(2026, 0, 10, 9);
  recordSync(u, null, null, [ph('1', 1)], t);
  recordSync(u, [ph('1', 1)], t, [ph('1', 3)], t + 3600000);
  assert.strictEqual(u.get('history').length, 1);
  assert.strictEqual(u.get('history')[0].views, 3);
});

test('a quick re-check keeps the older baseline', () => {
  const u = memUser();
  const t0 = Date.UTC(2026, 0, 10, 8), t1 = t0 + 3 * 3600000, t2 = t1 + 5 * 60000;
  recordSync(u, null, null, [ph('1', 10)], t0);
  recordSync(u, [ph('1', 10)], t0, [ph('1', 40)], t1);       // 3h later: baseline = t0
  const d = recordSync(u, [ph('1', 40)], t1, [ph('1', 41)], t2); // 5 min later: keep t0 baseline
  assert.strictEqual(d.views, 31);
  assert.strictEqual(u.get('last').t, t0);
});
