'use strict';
// Minimal Flickr API client with OAuth 1.0a (HMAC-SHA1) signing. No dependencies.
const crypto = require('crypto');

const REST = 'https://www.flickr.com/services/rest';
const OAUTH = 'https://www.flickr.com/services/oauth';

// RFC 3986 percent-encoding, as OAuth 1.0a requires.
function enc(s) {
  return encodeURIComponent(String(s)).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

function signatureBase(method, url, params) {
  const pairs = Object.keys(params).map(k => [enc(k), enc(params[k])]);
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  const paramStr = pairs.map(([k, v]) => k + '=' + v).join('&');
  return [method.toUpperCase(), enc(url), enc(paramStr)].join('&');
}

function sign(method, url, params, consumerSecret, tokenSecret = '') {
  const key = enc(consumerSecret) + '&' + enc(tokenSecret || '');
  return crypto.createHmac('sha1', key).update(signatureBase(method, url, params)).digest('base64');
}

class FlickrError extends Error {
  constructor(message, code, method) {
    super(message);
    this.code = code;
    this.method = method;
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

class Flickr {
  constructor({ apiKey, apiSecret, token = null, tokenSecret = null }) {
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.token = token;
    this.tokenSecret = tokenSecret;
    this.calls = 0;
  }

  get authed() { return !!(this.token && this.tokenSecret); }

  oauthBase() {
    return {
      oauth_nonce: crypto.randomBytes(16).toString('hex'),
      oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
      oauth_consumer_key: this.apiKey,
      oauth_signature_method: 'HMAC-SHA1',
      oauth_version: '1.0',
    };
  }

  signedUrl(url, params, tokenSecret) {
    const all = { ...params };
    all.oauth_signature = sign('GET', url, params, this.apiSecret, tokenSecret);
    return url + '?' + Object.keys(all).map(k => enc(k) + '=' + enc(all[k])).join('&');
  }

  async fetchText(url) {
    let lastErr;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 30000);
        const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'FlickrPhotoAnalyzer/1.0 (local app)' } });
        clearTimeout(t);
        const text = await res.text();
        if (res.status >= 500 || res.status === 429) {
          lastErr = new Error('HTTP ' + res.status + ': ' + text.slice(0, 200));
          await sleep(1000 * Math.pow(2, attempt));
          continue;
        }
        return { status: res.status, text };
      } catch (e) {
        lastErr = e;
        await sleep(1000 * Math.pow(2, attempt));
      }
    }
    throw lastErr;
  }

  // ---- OAuth flow ----
  async requestToken(callback) {
    const url = OAUTH + '/request_token';
    const params = { ...this.oauthBase(), oauth_callback: callback };
    const { status, text } = await this.fetchText(this.signedUrl(url, params, ''));
    const out = Object.fromEntries(new URLSearchParams(text));
    if (status !== 200 || !out.oauth_token) throw new FlickrError('Request token failed: ' + text.slice(0, 300), status, 'request_token');
    return { token: out.oauth_token, tokenSecret: out.oauth_token_secret };
  }

  authorizeUrl(token, perms = 'read') {
    return OAUTH + '/authorize?oauth_token=' + enc(token) + '&perms=' + enc(perms);
  }

  async accessToken(token, verifier, tokenSecret) {
    const url = OAUTH + '/access_token';
    const params = { ...this.oauthBase(), oauth_token: token, oauth_verifier: verifier };
    const { status, text } = await this.fetchText(this.signedUrl(url, params, tokenSecret));
    const out = Object.fromEntries(new URLSearchParams(text));
    if (status !== 200 || !out.oauth_token) throw new FlickrError('Access token failed: ' + text.slice(0, 300), status, 'access_token');
    return {
      token: out.oauth_token,
      tokenSecret: out.oauth_token_secret,
      nsid: out.user_nsid,
      username: out.username,
      fullname: out.fullname,
    };
  }

  // ---- REST ----
  async call(method, params = {}, { auth = true } = {}) {
    const base = { method, format: 'json', nojsoncallback: '1', api_key: this.apiKey };
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') base[k] = String(v);
    let url;
    if (auth && this.authed) {
      const p = { ...base, ...this.oauthBase(), oauth_token: this.token };
      url = this.signedUrl(REST, p, this.tokenSecret);
    } else {
      url = REST + '?' + new URLSearchParams(base).toString();
    }
    this.calls++;
    const { text } = await this.fetchText(url);
    let json;
    try { json = JSON.parse(text); } catch {
      throw new FlickrError('Bad response from Flickr: ' + text.slice(0, 200), -1, method);
    }
    if (json.stat !== 'ok') throw new FlickrError(json.message || 'Flickr error', json.code, method);
    return json;
  }
}

module.exports = { Flickr, FlickrError, sign, signatureBase, enc };
