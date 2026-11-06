const test = require('node:test');
const assert = require('node:assert');
const { syncStats, sameAlbum } = require('../lib/sync');

function mockFlickr() {
  const calls = [];
  const v = n => ({ views: n });
  return {
    calls,
    async call(method, params) {
      calls.push([method, params.date || null]);
      if (method === 'flickr.stats.getTotalViews') return { stats: { total: v(10), photos: v(6), photostream: v(2), sets: v(1), collections: v(1), galleries: v(0) } };
      if (method === 'flickr.stats.getPopularPhotos') return { photos: { photo: [{ id: 'a', title: 'A', stats: { views: 4, favorites: 1, comments: 0 } }] } };
      return { domains: { domain: [{ name: 'flickr.com', views: 3 }] } };
    },
  };
}
const job = () => ({ warnings: [], cancelled: false });

test('stats: first run fetches all 28 days, next run only the 2 newest', async () => {
  const f1 = mockFlickr();
  const s1 = await syncStats(f1, job(), null);
  assert.strictEqual(s1.days.length, 28);
  assert.strictEqual(s1.fetchedDays, 28);
  assert.strictEqual(s1.trending[0].views, 4 * 28);
  assert.strictEqual(s1.domains[0].views, 6 * 28);
  const f2 = mockFlickr();
  const s2 = await syncStats(f2, job(), s1);
  assert.strictEqual(s2.fetchedDays, 2);
  assert.strictEqual(s2.days.length, 28);
  assert.strictEqual(f2.calls.filter(c => c[1]).length, 2 * 4); // 4 calls per fetched day
  assert.strictEqual(s2.trending[0].views, 4 * 28);
});

test('albums are reused only when unchanged', () => {
  const a = { id: '1', updated: 5, photos: 10, videos: 0 };
  assert.ok(sameAlbum(a, { ...a, members: ['x'] }));
  assert.ok(!sameAlbum(a, { ...a, updated: 4, members: [] }));
  assert.ok(!sameAlbum(a, { ...a, photos: 9, members: [] }));
  assert.ok(!sameAlbum(a, { ...a, members: [], error: 'x' }));
  assert.ok(!sameAlbum(a, undefined));
});
