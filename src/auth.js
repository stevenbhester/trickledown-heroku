const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const cfg = require('./config');
const { query } = require('./db');

const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 200;
const TOKEN_TTL_DAYS = 180;
const TOKEN_TTL = `${TOKEN_TTL_DAYS}d`;
const TOKEN_TTL_MS = TOKEN_TTL_DAYS * 86400e3;

// A real bcrypt hash of a random string, compared against when the username
// doesn't exist, so a login attempt takes the same time either way and the
// response can't be used to tell which usernames are taken.
const DUMMY_HASH = bcrypt.hashSync(crypto.randomBytes(24).toString('hex'), cfg.bcryptRounds);

// Tokens carry the user's token_version; bumping it (password change, "sign
// out everywhere") makes every older token invalid.
function sign(user) {
  return jwt.sign({ sub: user.id, v: user.token_version || 0 }, cfg.jwtSecret, { expiresIn: TOKEN_TTL });
}

async function hashPassword(pw) { return bcrypt.hash(pw, cfg.bcryptRounds); }
// Always runs a real comparison (against a dummy hash when the account has no
// password), and only ever returns true for a real hash that matches.
async function checkPassword(pw, hash) {
  const ok = await bcrypt.compare(String(pw), hash || DUMMY_HASH);
  return ok === true && !!hash;
}

function validUsername(u) {
  return typeof u === 'string' && USERNAME_RE.test(u) && !/^guest_/i.test(u);
}

// Returns null if fine, otherwise a message for the player.
function passwordProblem(p, username) {
  if (typeof p !== 'string') return 'Pick a password.';
  if (p.length < PASSWORD_MIN) return `Passwords need at least ${PASSWORD_MIN} characters.`;
  if (p.length > PASSWORD_MAX) return 'That password is too long.';
  if (username && p.toLowerCase() === String(username).toLowerCase()) return "Your password can't be your username.";
  if (/^(.)\1+$/.test(p)) return 'A password made of one repeated character is not a password.';
  if (COMMON.has(p.toLowerCase())) return 'That password is on every list of common passwords. Pick another.';
  return null;
}
const COMMON = new Set(['password', 'password1', 'password123', '12345678', '123456789', '1234567890', 'qwerty123', 'qwertyuiop', 'iloveyou', 'letmein1', 'trickledown', 'lobbyist', 'sunshine', 'princess', 'football', 'baseball', 'welcome1', 'abc12345', 'monkey123', 'dragon123']);

// Guest handles look like guest_a7k2qz. They can be claimed later.
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
function randomTag(n = 6) {
  let s = '';
  const bytes = crypto.randomBytes(n);
  for (let i = 0; i < n; i++) s += ALPHABET[bytes[i] % ALPHABET.length];
  return s;
}
const guestName = () => `guest_${randomTag()}`;

// Device link codes: 8 characters from an unambiguous alphabet (40 bits),
// shown as XXXX-XXXX, hashed at rest, 15 minutes, single use.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_TTL_MS = 15 * 60e3;
function deviceCode() {
  const bytes = crypto.randomBytes(8);
  let out = '';
  for (let i = 0; i < 8; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return `${out.slice(0, 4)}-${out.slice(4)}`;
}
const normalizeCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/O/g, '0').replace(/I/g, '1');
const hashCode = (c) => crypto.createHash('sha256').update(normalizeCode(c)).digest('hex');
const isAdmin = (user) => !!user && cfg.adminUsernames.includes(String(user.username || '').toLowerCase());

// A username for a Google account: the name or email's local part, cleaned,
// with a short tag so it's unlikely to collide. The player can change it.
function suggestUsername(name, email) {
  const base = String(name || (email || '').split('@')[0] || 'player').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 14) || 'player';
  return `${base}_${randomTag(4)}`;
}

// Express middleware: requires a Bearer token and loads req.user.
// Express 4 ignores the promise an async middleware returns, so a database
// error here must be routed to next() by hand or it becomes an unhandled
// rejection, which on Node 22 is a crash.
function requireUser(req, res, next) {
  const m = /^Bearer (.+)$/.exec(req.get('authorization') || '');
  if (!m) return res.status(401).json({ error: 'Sign in to do that.' });
  let payload;
  try { payload = jwt.verify(m[1], cfg.jwtSecret, { algorithms: ['HS256'] }); } catch (e) {
    return res.status(401).json({ error: 'Your session expired. Sign in again.' });
  }
  return query('SELECT * FROM users WHERE id = $1', [payload.sub]).then(({ rows }) => {
    const user = rows[0];
    if (!user) return res.status(401).json({ error: 'That account no longer exists.' });
    if ((payload.v || 0) !== (user.token_version || 0)) return res.status(401).json({ error: 'You signed out of this session. Sign in again.' });
    req.user = user;
    // So /me can hand out a fresh token before this one runs out.
    req.tokenExp = payload.exp ? payload.exp * 1000 : null;
    next();
  }, next);
}

// A few headers that cost nothing on a JSON API.
function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Frame-Options', 'DENY');
  if (cfg.isProduction) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
}

module.exports = {
  sign, hashPassword, checkPassword, validUsername, passwordProblem, guestName, suggestUsername, requireUser, securityHeaders,
  deviceCode, hashCode, normalizeCode, isAdmin,
  PASSWORD_MIN, TOKEN_TTL_MS, CODE_TTL_MS,
};
