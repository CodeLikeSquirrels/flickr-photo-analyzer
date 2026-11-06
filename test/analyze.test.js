const test = require('node:test');
const assert = require('node:assert');
const { analyze, isUntitled, takenDate } = require('../lib/analyze');
const { parseExif, normalizePhoto } = require('../lib/sync');

const now = Date.UTC(2026, 10, 6) / 1000;
function mk(i, o = {}) {
  return {
    id: String(i), title: 'Sunset no. ' + i, desc: '', tags: [], mtags: [], views: i * 10, faves: i % 5, comments: i % 3,
    uploaded: now - i * 86400 * 7, updated: 0, taken: '2020-06-0' + ((i % 9) + 1) + ' 14:30:00', takenUnknown: false,
    lat: null, lon: null, media: 'photo', w: 6000, h: 4000, ispublic: 1, isfriend: 0, isfamily: 0, license: '0',
    thumb: null, img: null, albums: 0, ...o,
  };
}

test('untitled detection', () => {
  for (const t of ['', 'IMG_1234', 'DSC_0001', 'DSCF1234.JPG', 'PXL_20230101_123456', 'P1010001', 'GOPR0001', 'DSC_7633_DxO', 'Screenshot 2024-01-01 10.00.00', 'IMG_1234 (edited)'.replace(' (edited)','-edited')])
    assert.ok(isUntitled({ title: t }), t);
  for (const t of ['Sunset over Barbados', 'Engine 1630', 'Japanese Garden', 'Photo of my dog', 'Sam at the beach', 'Image of the week']) assert.ok(!isUntitled({ title: t }), t);
});

test('takenDate ignores unknown dates', () => {
  assert.strictEqual(takenDate({ taken: '2020-01-02 03:04:05', takenUnknown: true }), null);
  assert.deepStrictEqual(takenDate({ taken: '2020-01-02 03:04:05' }).y, 2020);
});

test('analyze produces consistent aggregates', () => {
  const photos = Array.from({ length: 100 }, (_, i) => mk(i + 1, {
    tags: i % 2 ? ['beach', 'sun', 'sea', 'blue'] : [], lat: i % 4 === 0 ? 40 : null, lon: i % 4 === 0 ? -88 : null,
    albums: i % 3 === 0 ? 1 : 0, title: i % 10 === 0 ? 'IMG_' + i : 'Sunset no. ' + i,
  }));
  const albums = [{ id: 'a1', title: 'A', photos: 34, videos: 0, views: 5, members: photos.filter(p => p.albums).map(p => p.id) }];
  const a = analyze({ photos, albums, now });
  assert.strictEqual(a.overview.items, 100);
  assert.strictEqual(a.overview.totalViews, photos.reduce((s, p) => s + p.views, 0));
  assert.strictEqual(a.overview.geotagged, 25);
  assert.strictEqual(a.distribution.reduce((s, d) => s + d.count, 0), 100);
  assert.strictEqual(a.top.views[0].id, '100');
  assert.strictEqual(a.health.checks.find(c => c.key === 'untitled').count, 10);
  assert.strictEqual(a.health.checks.find(c => c.key === 'noTags').count, 50);
  assert.strictEqual(a.tags.top.find(t => t.tag === 'beach').count, 50);
  assert.strictEqual(a.albums[0].photos, 34);
  assert.ok(a.health.score >= 0 && a.health.score <= 100);
  assert.strictEqual(a.timing.uploadHeat.flat().reduce((s, x) => s + x, 0), 100);
  assert.ok(Array.isArray(a.insights) && a.insights.length > 0);
});

test('analyze handles an empty library and Pro stats', () => {
  const a = analyze({ photos: [], now });
  assert.strictEqual(a.overview.items, 0);
  const b = analyze({ photos: [mk(1)], now, stats: { days: [{ date: '2026-11-01', total: 5 }, { date: '2026-11-02', total: 7 }], trending: [{ id: '1', views: 3 }], domains: [] } });
  assert.strictEqual(b.recent.total28, 12);
  assert.strictEqual(b.recent.bestDay.date, '2026-11-02');
  assert.strictEqual(b.recent.trending[0].share, 30);
});

test('exif parsing', () => {
  const r = { photo: { camera: 'Nikon D750', exif: [
    { tag: 'Make', raw: { _content: 'NIKON CORPORATION' } }, { tag: 'Model', raw: { _content: 'NIKON D750' } },
    { tag: 'ExposureTime', raw: { _content: '1/250' } }, { tag: 'FNumber', raw: { _content: '8.0' }, clean: { _content: 'f/8.0' } },
    { tag: 'ISO', raw: { _content: '200' } }, { tag: 'FocalLength', raw: { _content: '35 mm' }, clean: { _content: '35 mm' } },
    { tag: 'LensModel', raw: { _content: '24-70mm f/2.8' } },
  ] } };
  const e = parseExif(r);
  assert.strictEqual(e.camera, 'Nikon D750');
  assert.strictEqual(e.shutter, 1 / 250);
  assert.strictEqual(e.aperture, 8);
  assert.strictEqual(e.iso, 200);
  assert.strictEqual(e.focal, 35);
  assert.strictEqual(parseExif({ photo: { exif: [] } }), null);
});

test('normalizePhoto maps Flickr fields', () => {
  const p = normalizePhoto({ id: '1', title: 't', description: { _content: 'd' }, tags: 'a b', views: '12', count_faves: '3', count_comments: '1',
    dateupload: '100', datetaken: '2020-01-01 00:00:00', datetakenunknown: '1', latitude: 0, longitude: 0, ispublic: 1, license: '4', o_width: '10', o_height: '5', url_q: 'q' });
  assert.deepStrictEqual([p.views, p.faves, p.comments, p.tags.length, p.lat, p.takenUnknown, p.w], [12, 3, 1, 2, null, true, 10]);
});
