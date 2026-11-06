const test = require('node:test');
const assert = require('node:assert');
const { sign, signatureBase, enc } = require('../lib/flickr');

test('RFC 3986 encoding', () => {
  assert.strictEqual(enc("a b!*'()"), 'a%20b%21%2A%27%28%29');
});

// Known-good vector from the OAuth 1.0a spec example (RFC 5849 section 3.4.1.1 / Twitter docs).
test('HMAC-SHA1 signature matches reference vector', () => {
  const params = {
    status: 'Hello Ladies + Gentlemen, a signed OAuth request!', include_entities: 'true',
    oauth_consumer_key: 'xvz1evFS4wEEPTGEFPHBog', oauth_nonce: 'kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg',
    oauth_signature_method: 'HMAC-SHA1', oauth_timestamp: '1318622958',
    oauth_token: '370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb', oauth_version: '1.0',
  };
  const s = sign('POST', 'https://api.twitter.com/1.1/statuses/update.json', params,
    'kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw', 'LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE');
  assert.strictEqual(s, 'hCtSmYh+iHYCEqBWrE7C7hYmtUk=');
  assert.ok(signatureBase('GET', 'https://x.test/a', { b: '1', a: '2' }).endsWith('a%3D2%26b%3D1'));
});
