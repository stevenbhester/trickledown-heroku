// Verifies Google ID tokens (from Google Identity Services on the front end)
// against Google's published signing keys. No dependency: Node's crypto does
// RSA-SHA256, and the JWKS endpoint tells us which key signed the token.
//
//   verifyIdToken(token) -> { sub, email, email_verified, name, picture }
//   throws on anything that doesn't check out.
//
// What's checked, per Google's docs: signature (RS256, key by kid), issuer,
// audience (your client id), expiry, not-before/issued-at sanity. The caller
// decides what to do with email_verified.

const crypto = require('crypto');
const cfg = require('./config');

// Overridable for local testing only; leave unset in production.
const CERTS_URL = process.env.GOOGLE_CERTS_URL || 'https://www.googleapis.com/oauth2/v3/certs';
const ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);
const SKEW_S = 300;

let certCache = { keys: null, expires: 0 };

// Injectable for tests: returns { keys: [jwk, ...], maxAge: seconds }.
let fetchCerts = async () => {
  const res = await fetch(CERTS_URL, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`Google certs: ${res.status}`);
  const m = /max-age=(\d+)/.exec(res.headers.get('cache-control') || '');
  return { keys: (await res.json()).keys || [], maxAge: m ? Number(m[1]) : 3600 };
};

async function keys(force = false) {
  if (!force && certCache.keys && certCache.expires > Date.now()) return certCache.keys;
  const { keys: k, maxAge } = await fetchCerts();
  certCache = { keys: k, expires: Date.now() + Math.min(maxAge, 24 * 3600) * 1000 };
  return k;
}

const b64u = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

async function verifyIdToken(token, { clientId = cfg.googleClientId, now = Date.now() } = {}) {
  if (!clientId) throw new Error('Google sign-in is not configured on this server.');
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new Error('Malformed token.');
  let header, payload;
  try { header = JSON.parse(b64u(parts[0]).toString('utf8')); payload = JSON.parse(b64u(parts[1]).toString('utf8')); }
  catch (e) { throw new Error('Malformed token.'); }
  if (header.alg !== 'RS256' || !header.kid) throw new Error('Unexpected token algorithm.');

  // Find the key; refetch once if Google has rotated since we cached.
  let jwk = (await keys()).find((k) => k.kid === header.kid);
  if (!jwk) jwk = (await keys(true)).find((k) => k.kid === header.kid);
  if (!jwk) throw new Error('Unknown signing key.');

  const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  const ok = crypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, b64u(parts[2]));
  if (!ok) throw new Error('Bad token signature.');

  const nowS = Math.floor(now / 1000);
  if (!ISSUERS.has(payload.iss)) throw new Error('Wrong issuer.');
  if (payload.aud !== clientId) throw new Error('Token is for a different app.');
  if (typeof payload.exp !== 'number' || payload.exp + SKEW_S < nowS) throw new Error('Token expired.');
  if (typeof payload.iat === 'number' && payload.iat - SKEW_S > nowS) throw new Error('Token not valid yet.');
  if (typeof payload.sub !== 'string' || !payload.sub) throw new Error('Token has no subject.');

  return { sub: payload.sub, email: payload.email || null, email_verified: payload.email_verified === true, name: payload.name || null, picture: payload.picture || null };
}

module.exports = {
  verifyIdToken,
  enabled: () => !!cfg.googleClientId,
  _setFetchCerts: (fn) => { fetchCerts = fn; certCache = { keys: null, expires: 0 }; },
};
