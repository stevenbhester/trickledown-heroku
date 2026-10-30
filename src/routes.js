const express = require('express');
const cfg = require('./config');
const { query, withTx } = require('./db');
const game = require('./game');
const prices = require('./prices');
const assets = require('./assets');
const auth = require('./auth');
const maturer = require('./maturer');
const Town = require('./town');
const pricelog = require('./pricelog');
const achievements = require('./achievements');
const google = require('./google');
const { limit } = require('./ratelimit');

// Rate limits. Per IP unless noted; the login limiter also keys on username.
const RL = {
  guest: limit({ name: 'guest', max: 10, windowMs: 60 * 60e3, message: 'Too many new accounts from here. Try again in an hour.' }),
  login: limit({ name: 'login', max: 20, windowMs: 15 * 60e3 }),
  loginUser: limit({ name: 'login-user', max: 10, windowMs: 15 * 60e3, key: (req) => String((req.body || {}).username || '').toLowerCase() || null, message: 'Too many attempts on that account. Try again in 15 minutes.' }),
  register: limit({ name: 'register', max: 10, windowMs: 60 * 60e3 }),
  sensitive: limit({ name: 'sensitive', max: 10, windowMs: 15 * 60e3 }),
  trade: limit({ name: 'trade', max: 60, windowMs: 60e3 }),
  // Reads that cost a query or a price lookup: generous, but not unlimited.
  read: limit({ name: 'read', max: 120, windowMs: 60e3, message: 'Slow down. Try again in a minute.' }),
  // The live ticker polls every few seconds right after a buy.
  quote: limit({ name: 'quote', max: 240, windowMs: 60e3, message: 'Slow down. Try again in a minute.' }),
  social: limit({ name: 'social', max: 30, windowMs: 15 * 60e3, message: 'That is a lot of friends in a short time. Try again in 15 minutes.' }),
  // Wall posts, per account (not per IP): a conversation, not a firehose.
  wall: limit({ name: 'wall', max: 12, windowMs: 10 * 60e3, key: (req) => (req.user ? `u${req.user.id}` : req.ip), message: 'That is a lot of wall posts. Give it ten minutes.' }),
  // Admin testing tools: their own bucket, so a burst of grants and resets
  // doesn't use up the one that guards password changes. Only admins reach it.
  admin: limit({ name: 'admin', max: 120, windowMs: 15 * 60e3, message: 'Slow down. Try again in a few minutes.' }),
  // Charity requests and bug reports, per account: plenty for real use, not a spam channel.
  request: limit({ name: 'charity-request', max: 10, windowMs: 24 * 60 * 60e3, key: (req) => (req.user ? `u${req.user.id}` : req.ip), message: "That's ten charity requests today. They'll all get read; try again tomorrow." }),
  bug: limit({ name: 'bug', max: 10, windowMs: 60 * 60e3, key: (req) => (req.user ? `u${req.user.id}` : req.ip), message: "That's a lot of bug reports in an hour. Thank you; try again a bit later." }),
  // ...and per IP, so a pile of fresh guest accounts can't bury the real ones.
  requestIp: limit({ name: 'charity-request-ip', max: 30, windowMs: 24 * 60 * 60e3, message: "That's a lot of charity requests from here today. Try again tomorrow." }),
  bugIp: limit({ name: 'bug-ip', max: 30, windowMs: 60 * 60e3, message: "That's a lot of bug reports from here in an hour. Try again a bit later." }),
};

// A database id from the outside world: a positive integer that fits the
// column (int4), else null. Anything bigger would be a database error, not a 400.
const intId = (raw) => { const n = Number(raw); return Number.isInteger(n) && n > 0 && n <= 2147483647 ? n : null; };

// Admin is a username allow-list (ADMIN_USERNAMES), so those names are
// reserved: nobody can register, claim or rename into one, and an admin
// account can't rename away from its name (which would free it for someone
// else). To add an admin: create the account first, then add its name.
const adminName = (name) => cfg.adminUsernames.includes(String(name || '').toLowerCase());

// What the town rules need to know about the player.
const townCtx = (u, extra = {}) => ({ uid: u.id, cash: u.cash, lobbyists: u.total_donated, streak: u.streak, friends: u.friend_count || 0, unlocked: Town.isUnlocked(u.total_donated), ...extra });

// One line in the admin's transaction feed, for money (or lobbyists) that
// moves outside a position. Positions record buys, sales, rides and gifts.
async function ledgerAdd(db, userId, kind, amount, detail, lobbyists = 0, { always = false, charityId = null } = {}) {
  if (!amount && !lobbyists && !always) return;
  await db.query('INSERT INTO ledger (user_id, kind, amount, lobbyists, detail, charity_id) VALUES ($1, $2, $3, $4, $5, $6)',
    [userId, kind, game.round2(Number(amount) || 0), game.round2(Number(lobbyists) || 0), String(detail || '').slice(0, 200), charityId]);
}

// The charity a player actually chose, as opposed to the provisional one a
// cash-out falls back on before they have. Only a real choice becomes the
// default; the first-lobbyist chooser (POST /charity/choose) asks for it.
const explicitPick = (charity, charityId) => (charity && Number.isInteger(charityId) && charity.id === charityId ? charity.id : null);

// A web address from a player: http(s) only, no credentials in it, a real
// host. "example.org" becomes "https://example.org/". null if it isn't one.
function cleanUrl(raw, max, { needDot = true } = {}) {
  let s = cleanWallBody(raw).replace(/\s+/g, '');
  if (!s) return '';
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = `https://${s}`;
  let u;
  try { u = new URL(s); } catch (e) { return null; }
  if (!/^https?:$/.test(u.protocol) || u.username || u.password || (needDot && !u.hostname.includes('.'))) return null;
  const out = u.toString();
  return out.length <= max ? out : null;
}
const oneLine = (raw, max) => cleanWallBody(raw).replace(/\s+/g, ' ').slice(0, max).trim();

async function friendCount(userId, db = { query }) {
  const { rows: [r] } = await db.query('SELECT COUNT(*)::int AS n FROM friends WHERE user_id = $1', [userId]);
  return r.n;
}
const townView = (u) => ({ ...Town.view(u.town || Town.fresh(), townCtx(u, { day: game.dayKey() })), unlocked: Town.isUnlocked(u.total_donated) });

const router = express.Router();

// Wrap async handlers so thrown errors reach the error middleware.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function publicUser(u) {
  return {
    id: u.id,
    username: u.username,
    is_guest: u.is_guest,
    cash: u.cash,
    total_donated: u.total_donated,
    realized_pnl: u.realized_pnl,
    streak: u.streak,
    charity_id: u.charity_id,
    badges: game.badgesFor(u.total_donated),
    has_password: !!u.password_hash,
    google: !!u.google_sub,
    email: u.email || null,
    is_admin: auth.isAdmin(u),
    // How many days the account has been going, the first one being Day 1
    // (game time zone). The share card leads with it.
    account_day: u.created_at ? accountDay(u.created_at) : null,
  };
}
function accountDay(createdAt, now = new Date()) {
  const a = Date.parse(`${game.dayKey(new Date(createdAt))}T00:00:00Z`), b = Date.parse(`${game.dayKey(now)}T00:00:00Z`);
  return Math.max(1, Math.round((b - a) / 86400000) + 1);
}

// The charity new lobbyists go to. users.charity_id is the player's default:
// picked once, at their first cash-out, and changed only from TrickleTown
// (POST /lobbyists/assign). With a default set, it always wins. Without one,
// the client's pick (the first-cash-out picker), else the charity they've
// hired the most for, else the first on the list. Never refuses to close a
// position over a missing pick. Only an explicit pick becomes the default
// (explicitPick); a provisional one is spread across the list per player
// (md5 of slug + user id), so nobody's list order decides where unchosen
// lobbyists wait. Choosing (POST /charity/choose) moves them.
async function pickCharity(user, charityId, db = { query }) {
  const { rows } = await db.query(
    `SELECT c.* FROM charities c
      LEFT JOIN (SELECT charity_id, SUM(amount) AS total FROM donations WHERE user_id = $2 GROUP BY charity_id) d ON d.charity_id = c.id
     WHERE c.active
     ORDER BY (c.id = $3) DESC, (c.id = $1) DESC, d.total DESC NULLS LAST, md5(c.slug || $2::text)
     LIMIT 1`,
    [intId(charityId) || -1, user.id, user.charity_id || -1],
  );
  return rows[0] || null;
}

// This quarter's lobbyists by charity (the ones headed to Lobbyfest), plus
// the all-time picture. Shared by /me and /lobbyists/assign.
async function charitySplit(userId, quarter, db = { query }) {
  const { rows } = await db.query(
    `SELECT c.id, c.name, c.slug, c.active,
            GREATEST(0, COALESCE(SUM(d.amount) FILTER (WHERE d.quarter = $2), 0))::float8 AS amount,
            COUNT(*) FILTER (WHERE d.quarter = $2 AND d.amount > 0 AND d.position_id IS NOT NULL)::int AS times,
            SUM(d.amount)::float8 AS all_time
       FROM donations d JOIN charities c ON c.id = d.charity_id
      WHERE d.user_id = $1 GROUP BY c.id ORDER BY amount DESC, all_time DESC`,
    [userId, quarter],
  );
  return rows.map((r) => ({ ...r, amount: game.round2(r.amount) }));
}

// A position as the client sees it. Matured ones use their frozen price;
// live ones use the quote passed in (null when the lookup failed).
function shapePosition(p, quote) {
  const now = Date.now();
  const matured = !!p.matured_at;
  const price = matured ? p.matured_price : quote ? quote.price : null;
  const live = price != null ? game.valueOf(p, price, matured ? new Date(p.matures_at).getTime() : now) : null;
  if (matured && live) live.value = p.matured_value; // the stored number is the truth
  return {
    id: p.id,
    symbol: p.symbol,
    name: p.name,
    asset_type: p.asset_type,
    multiplier: p.multiplier,
    mult_floor: p.mult_floor != null ? p.mult_floor : cfg.multFloor,
    invested: p.invested,
    entry_price: p.entry_price,
    opened_at: p.opened_at,
    opened_day: p.opened_day,
    matures_at: p.matures_at,
    matured,
    matured_at: p.matured_at || null,
    matured_late: !!p.matured_late,
    ride_count: p.ride_count || 0,
    origin_invested: p.origin_invested != null ? p.origin_invested : p.invested,
    deferred_tax: p.deferred_tax || 0,
    seconds_left: matured ? 0 : Math.max(0, Math.round((new Date(p.matures_at) - now) / 1000)),
    price,
    quote_error: price == null,
    ...(live || { value: null, real_pct: null, swing_pct: null, busted: false }),
    // What collecting (matured) or selling now (live) would settle to. A live
    // ride still owes its deferred half; a matured one has earned it back.
    preview: live ? game.settle({ invested: p.invested, value: live.value, deferred: matured ? 0 : (p.deferred_tax || 0) }) : null,
  };
}

function dayInfo(now = new Date()) {
  const key = game.dayKey(now);
  return {
    key,
    number: game.dayNumber(key),
    quarter: game.quarterKey(key),
    resets_at: game.nextReset(now).toISOString(),
    quarter_ends_at: game.quarterEnd(now).toISOString(),
    tz: cfg.gameTz,
  };
}

// --- Meta ----------------------------------------------------------------------

// The page checks this so a half-finished deploy (new page, old server) is
// caught on sight instead of showing up as missing features. Bump it with any
// release the page depends on; js/app.js API_WANTS must match.
const API_VERSION = 11;

router.get('/health', (req, res) => res.json({ ok: true, api: API_VERSION, provider: cfg.priceProvider, google: google.enabled(), demo: cfg.demoMode }));

router.get('/config', (req, res) => {
  res.json({
    demo: cfg.demoMode,
    daily_base: cfg.dailyBase,
    streak_bonus: cfg.streakBonus,
    daily_cap: cfg.dailyCap,
    tax_rate: cfg.taxRate,
    hold_hours: cfg.holdHours,
    mult_floor: cfg.multFloor,
    multipliers: cfg.multipliers,
    tz: cfg.gameTz,
    badges: game.BADGES,
    day: dayInfo(),
  });
});

// The picker's starting list (the curated set), plus how big the whole
// universe is. Everything else is found through /assets/search.
router.get('/assets', (req, res) => {
  res.json({ assets: assets.CURATED.map(({ cg, ...a }) => a), count: assets.size(), search: true, source: assets.source() });
});

router.get('/assets/search', RL.read, (req, res) => {
  const q = String(req.query.q || '').slice(0, 40);
  res.json({ q, assets: assets.search(q, 25).map(({ cg, ...a }) => a) });
});

// Live prices for a handful of symbols at once: the ticker after a buy.
// ?fresh=1 asks for quotes no older than FRESH_QUOTE_MS (4s); the provider
// budget decides whether it actually gets them.
router.get('/quotes', RL.quote, wrap(async (req, res) => {
  const symbols = String(req.query.symbols || '').split(',').map((x) => x.trim().toUpperCase()).filter(Boolean).slice(0, 12);
  const list = symbols.map((x) => assets.find(x)).filter(Boolean);
  const fresh = req.query.fresh === '1';
  const quotes = await prices.getQuotes(list, fresh ? { maxAgeMs: cfg.freshQuoteMs } : {});
  res.json({ quotes, at: new Date().toISOString() });
}));

router.get('/quote/:symbol', RL.quote, wrap(async (req, res) => {
  const asset = assets.find(req.params.symbol);
  if (!asset) return res.status(404).json({ error: 'Not in the game. Pick something from the list.' });
  try {
    const q = req.query.fresh === '1' ? (await prices.getQuotes([asset], { maxAgeMs: cfg.freshQuoteMs }))[asset.symbol] : await prices.getQuote(asset);
    if (!q) throw new Error('no price');
    res.json({ symbol: asset.symbol, ...q });
  } catch (e) {
    res.status(503).json({ error: `Couldn't get a price for ${asset.symbol} right now. Try again in a minute.` });
  }
}));

router.get('/charities', wrap(async (req, res) => {
  const { rows } = await query('SELECT id, slug, name, blurb, url, category, ein, rating FROM charities WHERE active ORDER BY sort, name');
  res.json({ charities: rows });
}));

// --- Auth ----------------------------------------------------------------------
//
// Guest accounts need nothing. A guest can be claimed with a password or a
// Google account; either way the history stays. Passwords are bcrypt (cost 12);
// login takes the same time whether or not the username exists. Tokens carry a
// version, so changing your password or "sign out everywhere" invalidates the
// old ones. Google sign-in verifies the ID token against Google's keys and
// keys the account on the stable `sub`, never on the email.

const USERNAME_HELP = 'Usernames are 3–20 letters, numbers or underscores.';

async function usernameTaken(username, exceptId = null) {
  const { rows } = await query('SELECT id FROM users WHERE lower(username) = lower($1)', [username]);
  return rows.some((r) => r.id !== exceptId);
}

function authResponse(res, user, extra = {}) {
  res.json({ token: auth.sign(user), user: publicUser(user), ...extra });
}

router.get('/auth/options', (req, res) => {
  res.json({ google: google.enabled(), google_client_id: cfg.googleClientId || null, password_min: auth.PASSWORD_MIN });
});

router.post('/auth/guest', RL.guest, wrap(async (req, res) => {
  for (let attempt = 0; attempt < 5; attempt++) {
    const username = auth.guestName();
    try {
      const { rows } = await query('INSERT INTO users (username, is_guest) VALUES ($1, true) RETURNING *', [username]);
      return authResponse(res, rows[0]);
    } catch (e) {
      if (e.code !== '23505') throw e; // unique violation: try another name
    }
  }
  res.status(500).json({ error: 'Could not create a guest account. Try again.' });
}));

router.post('/auth/register', RL.register, wrap(async (req, res) => {
  const { username, password } = req.body || {};
  if (!auth.validUsername(username)) return res.status(400).json({ error: USERNAME_HELP });
  const bad = auth.passwordProblem(password, username);
  if (bad) return res.status(400).json({ error: bad });
  if (adminName(username) || await usernameTaken(username)) return res.status(409).json({ error: 'That username is taken.' });
  const password_hash = await auth.hashPassword(password);
  try {
    const { rows } = await query('INSERT INTO users (username, password_hash, password_changed_at) VALUES ($1, $2, now()) RETURNING *', [username, password_hash]);
    authResponse(res, rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'That username is taken.' });
    throw e;
  }
}));

router.post('/auth/login', RL.login, RL.loginUser, wrap(async (req, res) => {
  const { username, password } = req.body || {};
  const { rows } = await query('SELECT * FROM users WHERE lower(username) = lower($1)', [String(username || '')]);
  const user = rows[0];
  // Always run the comparison, so timing doesn't reveal whether the username exists.
  const ok = await auth.checkPassword(String(password || ''), user ? user.password_hash : null);
  if (!user || !ok) return res.status(401).json({ error: 'Wrong username or password.' });
  authResponse(res, user);
}));

// Turn a guest into a password account, keeping everything they've done.
router.post('/auth/claim', auth.requireUser, RL.sensitive, wrap(async (req, res) => {
  if (!req.user.is_guest) return res.status(400).json({ error: 'This account already has a username.' });
  const { username, password } = req.body || {};
  if (!auth.validUsername(username)) return res.status(400).json({ error: USERNAME_HELP });
  const bad = auth.passwordProblem(password, username);
  if (bad) return res.status(400).json({ error: bad });
  if (adminName(username) || await usernameTaken(username, req.user.id)) return res.status(409).json({ error: 'That username is taken.' });
  const password_hash = await auth.hashPassword(password);
  try {
    const { rows } = await query(
      'UPDATE users SET username = $1, password_hash = $2, password_changed_at = now(), is_guest = false WHERE id = $3 RETURNING *',
      [username, password_hash, req.user.id],
    );
    authResponse(res, rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'That username is taken.' });
    throw e;
  }
}));

// Sign in (or up) with a Google ID token from the front end.
router.post('/auth/google', RL.login, wrap(async (req, res) => {
  if (!google.enabled()) return res.status(404).json({ error: 'Google sign-in is not set up on this server.' });
  let g;
  try { g = await google.verifyIdToken((req.body || {}).credential); } catch (e) {
    return res.status(401).json({ error: `Google sign-in failed: ${e.message}` });
  }
  const email = g.email_verified ? g.email : null;
  const { rows: existing } = await query('SELECT * FROM users WHERE google_sub = $1', [g.sub]);
  if (existing[0]) {
    if (email && existing[0].email !== email) await query('UPDATE users SET email = $1 WHERE id = $2', [email, existing[0].id]);
    return authResponse(res, { ...existing[0], email: email || existing[0].email });
  }
  for (let attempt = 0; attempt < 5; attempt++) {
    const username = auth.suggestUsername(g.name, g.email);
    try {
      const { rows } = await query(
        'INSERT INTO users (username, is_guest, google_sub, email) VALUES ($1, false, $2, $3) RETURNING *', [username, g.sub, email],
      );
      return authResponse(res, rows[0], { created: true });
    } catch (e) {
      if (e.code !== '23505') throw e;
      // A race on google_sub (double submit) means the account now exists: sign them in.
      const { rows: again } = await query('SELECT * FROM users WHERE google_sub = $1', [g.sub]);
      if (again[0]) return authResponse(res, again[0]);
    }
  }
  res.status(500).json({ error: 'Could not create your account. Try again.' });
}));

// Attach a Google account to the signed-in account (claims a guest, or adds
// Google to a password account). Never links by email, only by the token.
router.post('/auth/link-google', auth.requireUser, RL.sensitive, wrap(async (req, res) => {
  if (!google.enabled()) return res.status(404).json({ error: 'Google sign-in is not set up on this server.' });
  if (req.user.google_sub) return res.status(400).json({ error: 'This account already has a Google account linked.' });
  let g;
  try { g = await google.verifyIdToken((req.body || {}).credential); } catch (e) {
    return res.status(401).json({ error: `Google sign-in failed: ${e.message}` });
  }
  const { rows: taken } = await query('SELECT id FROM users WHERE google_sub = $1', [g.sub]);
  if (taken[0]) return res.status(409).json({ error: 'That Google account is already linked to another player. Sign in with Google instead.' });
  let username = req.user.username;
  if (req.user.is_guest) {
    // Give the ex-guest a real handle; they can change it later.
    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = auth.suggestUsername(g.name, g.email);
      if (!(await usernameTaken(candidate))) { username = candidate; break; }
    }
  }
  const { rows } = await query(
    'UPDATE users SET google_sub = $1, email = $2, is_guest = false, username = $3 WHERE id = $4 RETURNING *',
    [g.sub, g.email_verified ? g.email : null, username, req.user.id],
  );
  authResponse(res, rows[0]);
}));

// Set or change the password. A Google-only account sets one without a
// current password; anyone else must prove the current one. Bumps the token
// version, so every other device is signed out, and returns a fresh token.
router.post('/auth/password', auth.requireUser, RL.sensitive, wrap(async (req, res) => {
  const { current, password } = req.body || {};
  const u = req.user;
  if (u.is_guest) return res.status(400).json({ error: 'Claim the account with a username first.' });
  if (u.password_hash) {
    if (!(await auth.checkPassword(String(current || ''), u.password_hash))) return res.status(401).json({ error: 'That current password is wrong.' });
  }
  const bad = auth.passwordProblem(password, u.username);
  if (bad) return res.status(400).json({ error: bad });
  const password_hash = await auth.hashPassword(password);
  const { rows } = await query(
    'UPDATE users SET password_hash = $1, password_changed_at = now(), token_version = token_version + 1 WHERE id = $2 RETURNING *',
    [password_hash, u.id],
  );
  authResponse(res, rows[0]);
}));

router.post('/auth/username', auth.requireUser, RL.sensitive, wrap(async (req, res) => {
  const { username } = req.body || {};
  if (req.user.is_guest) return res.status(400).json({ error: 'Claim the account first.' });
  if (!auth.validUsername(username)) return res.status(400).json({ error: USERNAME_HELP });
  const same = String(username).toLowerCase() === String(req.user.username).toLowerCase();
  if (auth.isAdmin(req.user) && !same) return res.status(400).json({ error: "Admin accounts keep their username: it's what makes them admin. Change ADMIN_USERNAMES first." });
  if ((adminName(username) && !same) || await usernameTaken(username, req.user.id)) return res.status(409).json({ error: 'That username is taken.' });
  try {
    const { rows } = await query('UPDATE users SET username = $1 WHERE id = $2 RETURNING *', [username, req.user.id]);
    res.json({ user: publicUser(rows[0]) });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'That username is taken.' });
    throw e;
  }
}));

// Invalidate every token for this account, including this one.
// "Use on another device": the signed-in device asks for a code, the other
// device redeems it and gets its own token for the same account. Works for
// guests too, which is the point: it's the cross-device path that needs no
// password. 15 minutes, single use, hashed at rest.
router.post('/auth/device-code', auth.requireUser, RL.sensitive, wrap(async (req, res) => {
  const code = auth.deviceCode();
  const expiresAt = new Date(Date.now() + auth.CODE_TTL_MS);
  await query('DELETE FROM link_codes WHERE user_id = $1 OR expires_at < now()', [req.user.id]);
  await query('INSERT INTO link_codes (code_hash, user_id, expires_at) VALUES ($1, $2, $3)', [auth.hashCode(code), req.user.id, expiresAt]);
  res.json({ code, expires_at: expiresAt.toISOString(), ttl_minutes: Math.round(auth.CODE_TTL_MS / 60e3) });
}));

router.post('/auth/redeem-code', RL.login, wrap(async (req, res) => {
  const raw = (req.body || {}).code;
  if (!raw || auth.normalizeCode(raw).length !== 8) return res.status(400).json({ error: 'Codes look like ABCD-EFGH.' });
  const { rows: [row] } = await query(
    `UPDATE link_codes SET used_at = now()
      WHERE code_hash = $1 AND used_at IS NULL AND expires_at > now() RETURNING user_id`,
    [auth.hashCode(raw)],
  );
  if (!row) return res.status(400).json({ error: "That code isn't valid. They last 15 minutes and work once; get a fresh one from the other device." });
  const { rows: [user] } = await query('UPDATE users SET last_seen_at = now() WHERE id = $1 RETURNING *', [row.user_id]);
  if (!user) return res.status(400).json({ error: 'That account no longer exists.' });
  res.json({ token: auth.sign(user), user: publicUser(user) });
}));

// --- Admin: testing conveniences, only for ADMIN_USERNAMES ---------------------

function requireAdmin(req, res, next) {
  if (!auth.isAdmin(req.user)) return res.status(403).json({ error: 'Not for you.' });
  next();
}
// What an admin tool sends back about the player it acted on: everything the
// client needs, minus another player's email.
const adminView = (req, u) => (u.id === req.user.id ? publicUser(u) : { ...publicUser(u), email: null });

// Grant yourself (or a named player) cash and/or lobbyists. Lobbyists are a
// real donation row so the boards and the town see them.
router.post('/admin/grant', auth.requireUser, requireAdmin, RL.admin, wrap(async (req, res) => {
  const body = req.body || {};
  const cash = Math.max(0, Math.min(100000, Number(body.cash) || 0));
  const lobbyists = Math.max(0, Math.min(100000, Number(body.lobbyists) || 0));
  const target = body.username ? await findPlayer(body.username) : req.user;
  if (!target) return res.status(404).json({ error: 'No player by that name.' });
  if (!cash && !lobbyists) return res.status(400).json({ error: 'Grant something: cash, lobbyists, or both.' });
  const day = dayInfo();
  let charity = null;
  const user = await withTx(async (tx) => {
    const { rows: [locked] } = await tx.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [target.id]);
    if (lobbyists) {
      charity = await pickCharity(locked, Number(body.charity_id), tx);
      if (!charity) throw new Error('No charities are set up yet.');
      await tx.query('INSERT INTO donations (user_id, charity_id, amount, quarter) VALUES ($1, $2, $3, $4)', [target.id, charity.id, lobbyists, day.quarter]);
    }
    const { rows: [u] } = await tx.query(
      'UPDATE users SET cash = cash + $1, total_donated = total_donated + $2, charity_id = COALESCE(charity_id, $3) WHERE id = $4 RETURNING *',
      [cash, lobbyists, explicitPick(charity, Number(body.charity_id)), target.id],
    );
    await ledgerAdd(tx, target.id, 'admin grant', cash, `from ${req.user.username}${charity ? ` · lobbyists for ${charity.name}` : ''}`, lobbyists, { charityId: charity ? charity.id : null });
    return u;
  });
  console.log(`[admin] ${req.user.username} granted ${target.username}: $${cash}, ${lobbyists} lobbyists`);
  res.json({ ok: true, user: adminView(req, user), town: townView(user) });
}));

// Start over as a brand-new account: no positions, no lobbyists, no town, no
// friends on their list, shares unvested, streak zero, $100 at the next /me.
// The username, password and sign-ins stay. Other players who added this one
// as a friend keep them (that's their list, not this one's).
router.post('/admin/reset', auth.requireUser, requireAdmin, RL.admin, wrap(async (req, res) => {
  const target = (req.body || {}).username ? await findPlayer(req.body.username) : req.user;
  if (!target) return res.status(404).json({ error: 'No player by that name.' });
  await withTx(async (tx) => {
    await tx.query('DELETE FROM donations WHERE user_id = $1', [target.id]);
    await tx.query('DELETE FROM achievements WHERE user_id = $1', [target.id]);
    await tx.query('DELETE FROM positions WHERE user_id = $1', [target.id]);
    await tx.query('DELETE FROM friends WHERE user_id = $1', [target.id]);
    await tx.query('DELETE FROM link_codes WHERE user_id = $1', [target.id]);
    await tx.query('DELETE FROM wall_posts WHERE owner_id = $1 OR author_id = $1', [target.id]);
    await tx.query('DELETE FROM ledger WHERE user_id = $1', [target.id]);
    await tx.query(
      `UPDATE users SET cash = 0, total_donated = 0, realized_pnl = 0, streak = 0, last_allowance_day = NULL,
              town = NULL, charity_id = NULL, vested_at = NULL, wall_seen_at = NULL, followers_seen_at = NULL, created_at = now() WHERE id = $1`,
      [target.id],
    );
  });
  console.log(`[admin] ${req.user.username} reset ${target.username}`);
  res.json({ ok: true, self: target.id === req.user.id });
}));

// Cards: open some (or all) of the deck early, or put one on today's agenda.
// Both act on today's town, so the player's game has to have been opened
// today (the /me that ticks the town). Self by default, or { username }.
async function adminTown(req, res, act) {
  const body = req.body || {};
  const target = body.username ? await findPlayer(body.username) : req.user;
  // On an error this answers and returns null, so callers stop at `if (!out) return`.
  if (!target) { res.status(404).json({ error: 'No player by that name.' }); return null; }
  const today = game.dayKey();
  const result = await withTx(async (tx) => {
    const { rows: [u] } = await tx.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [target.id]);
    u.friend_count = await friendCount(u.id, tx);
    const town = u.town || Town.fresh();
    const r = act(town, u, today);
    if (r.error) return r;
    const { rows: [u2] } = await tx.query('UPDATE users SET town = $1 WHERE id = $2 RETURNING *', [town, u.id]);
    return { user: u2, r };
  });
  if (result.error) { res.status(400).json({ error: result.error }); return null; }
  result.user.friend_count = await friendCount(result.user.id);
  return { target, user: result.user, r: result.r };
}

const cardIds = (raw) => [].concat(raw || []).map(String).filter((id) => /^[a-z_0-9]{1,40}$/.test(id)).slice(0, 200);

router.post('/admin/unlock', auth.requireUser, requireAdmin, RL.admin, wrap(async (req, res) => {
  const body = req.body || {};
  const ids = body.all === true ? '*' : cardIds(body.issue_ids || body.issue_id);
  if (ids !== '*' && !ids.length) return res.status(400).json({ error: 'Pick a card, or send all: true.' });
  const out = await adminTown(req, res, (town) => {
    const r = Town.adminUnlock(town, ids);
    return r.unlocked ? r : { error: 'No such card.' };
  });
  if (!out) return;
  console.log(`[admin] ${req.user.username} unlocked ${ids === '*' ? 'every card' : ids.join(', ')} for ${out.target.username}`);
  res.json({ ok: true, unlocked: out.r.unlocked, user: adminView(req, out.user), town: townView(out.user) });
}));

// The two reversible switches: every card unlocked; every unlocked card dealt
// daily. GET reads them for the admin panel; POST flips either or both.
router.get('/admin/switches', auth.requireUser, requireAdmin, RL.admin, wrap(async (req, res) => {
  const target = req.query.username ? await findPlayer(req.query.username) : req.user;
  if (!target) return res.status(404).json({ error: 'No player by that name.' });
  const town = target.town ? Town.migrate(target.town) : Town.fresh();
  res.json({ username: target.username, unlock_all: !!town.admin_all_open, deal_all: !!town.admin_deal_all });
}));
router.post('/admin/switches', auth.requireUser, requireAdmin, RL.admin, wrap(async (req, res) => {
  const body = req.body || {};
  const want = {};
  if (typeof body.unlock_all === 'boolean') want.unlockAll = body.unlock_all;
  if (typeof body.deal_all === 'boolean') want.dealAll = body.deal_all;
  if (!Object.keys(want).length) return res.status(400).json({ error: 'Send unlock_all and/or deal_all as true or false.' });
  const out = await adminTown(req, res, (town, u, today) => {
    const ctxNow = townCtx(u, { day: today });
    if (town.day === today && Town.isUnlocked(u.total_donated)) Town.ensureIssues(town, ctxNow);
    return Town.adminSwitch(town, ctxNow, want);
  });
  if (!out) return;
  console.log(`[admin] ${req.user.username} set ${JSON.stringify(out.r)} for ${out.target.username}`);
  res.json({ ok: true, ...out.r, user: adminView(req, out.user), town: townView(out.user) });
}));

router.post('/admin/deal', auth.requireUser, requireAdmin, RL.admin, wrap(async (req, res) => {
  const all = (req.body || {}).all === true;
  const [id] = cardIds((req.body || {}).issue_id);
  if (!all && !id) return res.status(400).json({ error: 'Pick a card, or send all: true.' });
  const out = await adminTown(req, res, (town, u, today) => {
    if (!Town.isUnlocked(u.total_donated)) return { error: "TrickleTown isn't open for this player yet: they need a lobbyist first (grant one)." };
    if (town.day !== today) return { error: "This player's town hasn't started today yet. Open the game as them first." };
    const ctxNow = townCtx(u, { day: today });
    Town.ensureIssues(town, ctxNow); // today's own cards first, if the town only just opened
    if (all) { const ids = Town.dealAllUnlocked(town, ctxNow); return ids.length ? { dealt: ids } : { error: 'Every unlocked card is already on the agenda.' }; }
    return Town.deal(town, id);
  });
  if (!out) return;
  console.log(`[admin] ${req.user.username} dealt ${all ? `${out.r.dealt.length} cards` : id} to ${out.target.username}`);
  res.json({ ok: true, dealt: out.r.dealt, user: adminView(req, out.user), town: townView(out.user) });
}));

router.post('/auth/logout-all', auth.requireUser, wrap(async (req, res) => {
  await query('UPDATE users SET token_version = token_version + 1 WHERE id = $1', [req.user.id]);
  res.json({ ok: true });
}));

// --- The daily screen ------------------------------------------------------------

// Grants today's allowance exactly once per day (atomic on last_allowance_day),
// then returns everything the Today screen needs.
router.get('/me', auth.requireUser, wrap(async (req, res) => {
  const now = new Date();
  const day = dayInfo(now);
  let user = req.user;
  let allowance = null;

  user.friend_count = await friendCount(user.id);
  if (user.last_allowance_day !== day.key) {
    // The grant and the town's new day happen on a locked row, so a build or
    // a card played in the same second can't be overwritten by a stale copy.
    const fc = user.friend_count;
    const granted = await withTx(async (tx) => {
      const { rows: [u] } = await tx.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [user.id]);
      u.friend_count = fc;
      if (u.last_allowance_day === day.key) return { user: u, allowance: null };
      const yesterday = game.addDays(day.key, -1);
      const streak = u.last_allowance_day === yesterday ? u.streak + 1 : 1;
      // A new day in the village: buildings push the meters, today's issues are
      // dealt, and the town's income joins the allowance (it can subtract).
      const town = u.town || Town.fresh();
      const base = game.allowanceFor(streak);
      // Cash at dawn, for cards that need "$X on the coin": base stipend plus whatever the town pays.
      const { report } = Town.tick(town, townCtx(u, { day: day.key, streak, cash: u.cash + base + Town.income(town) }));
      const amount = game.round2(Math.min(cfg.dailyCap + cfg.townIncomeCap, Math.max(10, base + report.income)));
      const { rows: [updated] } = await tx.query(
        `UPDATE users SET cash = cash + $1, streak = $2, last_allowance_day = $3, last_seen_at = now(), town = $5
          WHERE id = $4 RETURNING *`,
        [amount, streak, day.key, u.id, { ...town, report }],
      );
      updated.friend_count = fc;
      await ledgerAdd(tx, u.id, 'allowance', amount, `stipend ${base}${report.income ? `, town ${report.income > 0 ? '+' : ''}${report.income}` : ''} · streak ${streak}`);
      return { user: updated, allowance: { amount, streak, base, town_income: report.income } };
    });
    user = granted.user;
    allowance = granted.allowance;
  } else {
    await query('UPDATE users SET last_seen_at = now() WHERE id = $1', [user.id]);
  }

  // Unlocked mid-day (first full lobbyist just hired)? Deal today's issues now.
  // And a card unlocked since the last look (a hire, a friend) joins today.
  let freshCards = [];
  if (user.town) {
    const ctxNow = townCtx(user, { day: day.key });
    const opened = Town.ensureIssues(user.town, ctxNow);
    freshCards = Town.dealNewUnlocks(user.town, ctxNow);
    if (opened || freshCards.length || !Array.isArray(user.town.unlock_seen)) {
      await query('UPDATE users SET town = $1 WHERE id = $2', [user.town, user.id]);
    }
  }

  // Sliding sessions: a token past half its life is replaced, so a guest who
  // keeps playing never finds their village gone at day 181.
  let renewedToken = null;
  if (req.tokenExp && req.tokenExp - Date.now() < auth.TOKEN_TTL_MS / 2) renewedToken = auth.sign(user);

  const { rows: open } = await query(
    'SELECT * FROM positions WHERE user_id = $1 AND status = $2 ORDER BY opened_at ASC', [user.id, 'open'],
  );
  // Freeze anything that matured since the last pass, then quote only what is still live.
  await maturer.settleMatured(open).catch((e) => console.error('maturer:', e.message));
  const stillLive = open.filter((p) => !p.matured_at);
  const quotes = await prices.getQuotes(stillLive.map((p) => assets.find(p.symbol)).filter(Boolean));
  pricelog.record(quotes).catch((e) => console.warn('pricelog:', e.message));

  const positions = open.map((p) => shapePosition(p, quotes[p.symbol]));

  const { rows: history } = await query(
    `SELECT p.id, p.symbol, p.name, p.invested, p.proceeds, p.profit, p.tax, p.tier, p.closed_at, p.closed_day,
            (p.matured_at IS NOT NULL) AS collected, (p.status = 'rolled') AS rode, (p.status = 'vested') AS vested, (p.status = 'gift') AS gift, c.name AS charity_name,
            (SELECT SUM(d.amount) FROM donations d WHERE d.position_id = p.id)::float8 AS lobbyists
       FROM positions p LEFT JOIN charities c ON c.id = p.charity_id
      WHERE p.user_id = $1 AND p.status IN ('closed', 'rolled', 'vested', 'gift')
      ORDER BY p.closed_at DESC LIMIT 12`,
    [user.id],
  );

  const { rows: crowd } = await query(
    `SELECT symbol, name, COUNT(*)::int AS buys, SUM(invested)::float8 AS invested
       FROM positions WHERE opened_day = $1 AND rolled_from IS NULL AND status NOT IN ('vested', 'gift')
      GROUP BY symbol, name ORDER BY buys DESC, invested DESC LIMIT 5`,
    [day.key],
  );
  const { rows: [crowdTotal] } = await query(
    "SELECT COUNT(*)::int AS buys, COUNT(DISTINCT user_id)::int AS players FROM positions WHERE opened_day = $1 AND rolled_from IS NULL AND status NOT IN ('vested', 'gift')",
    [day.key],
  );

  // What your friends bought today, for the crowd line.
  const { rows: friendsToday } = await query(
    `SELECT u.username, array_agg(DISTINCT p.symbol ORDER BY p.symbol) AS symbols
       FROM friends f JOIN users u ON u.id = f.friend_id
       JOIN positions p ON p.user_id = u.id AND p.opened_day = $2 AND p.rolled_from IS NULL AND p.status NOT IN ('vested', 'gift')
      WHERE f.user_id = $1 GROUP BY u.username ORDER BY u.username LIMIT 8`,
    [user.id, day.key],
  );

  // Achievements: anything newly earned is recorded here. `vesting` is the
  // first one in the shape older clients expect.
  const ach = await achievements.sync(user);
  const firstBuy = ach.list.find((a) => a.key === 'first_buy');
  const vesting = firstBuy && !firstBuy.claimed_at ? { available: !!firstBuy.earned_at, amount: firstBuy.gift } : null;

  const { rows: [todayGiven] } = await query(
    `SELECT COALESCE(SUM(d.amount), 0)::float8 AS amount FROM donations d
       JOIN positions p ON p.id = d.position_id
      WHERE d.user_id = $1 AND p.closed_day = $2`,
    [user.id, day.key],
  );

  // The back of the coin: this quarter's lobbyists by charity.
  const byCharity = await charitySplit(user.id, day.quarter);
  const quarterDonated = byCharity.reduce((s, c) => s + c.amount, 0);
  const { rows: [defaultRow] } = user.charity_id ? await query('SELECT active FROM charities WHERE id = $1', [user.charity_id]) : { rows: [] };
  const hasRealDefault = !!(defaultRow && defaultRow.active);

  res.json({
    api: API_VERSION,
    user: { ...publicUser(user), quarter_donated: game.round2(quarterDonated) },
    day,
    allowance,
    rules: { tax_rate: cfg.taxRate, ride_tax_factor: cfg.rideTaxFactor, ride_max_steps: cfg.rideMaxSteps, vest_amount: cfg.vestAmount, daily_base: cfg.dailyBase, streak_bonus: cfg.streakBonus, daily_cap: cfg.dailyCap, hold_hours: cfg.holdHours, mult_floor: cfg.multFloor, demo: cfg.demoMode },
    positions,
    history,
    town: townView(user),
    donations_by_charity: byCharity,
    // Lobbyists but no charity chosen yet (new, or theirs was retired): the
    // client asks, loudly, until they choose.
    needs_charity: !hasRealDefault && Number(user.total_donated) > 0,
    crowd: { picks: crowd, ...crowdTotal, friends: friendsToday.map((r) => ({ username: r.username, symbols: Array.isArray(r.symbols) ? r.symbols : String(r.symbols).replace(/[{}"]/g, '').split(',').filter(Boolean) })) },
    friend_count: user.friend_count,
    today_donated: todayGiven.amount,
    vesting,
    achievements: ach,
    fresh_cards: freshCards.map((id) => (Town.ISSUES.find((i) => i.id === id) || {}).title).filter(Boolean),
    ...(await wallUnread(user).then((w) => ({ wall_unread: w.n, wall_unread_from: w.from, wall_latest: w.latest }))),
    // "erin added you": new since you last waved it off, not yet added back.
    new_followers: await addedYou(user.id, user.followers_seen_at || null),
    token: renewedToken,
  });
}));

// More open positions than anyone plays with, few enough that every page
// that lists them stays quick.
const MAX_OPEN = 100;

router.post('/buy', auth.requireUser, RL.trade, wrap(async (req, res) => {
  const asset = assets.find((req.body || {}).symbol);
  const amount = game.round2(Number((req.body || {}).amount));
  if (!asset) return res.status(400).json({ error: 'Pick something from the list.' });
  if (!(amount >= 0.01)) return res.status(400).json({ error: 'Invest at least a penny.' });
  const { rows: [held] } = await query("SELECT COUNT(*)::int AS n FROM positions WHERE user_id = $1 AND status = 'open'", [req.user.id]);
  if (held.n >= MAX_OPEN) return res.status(400).json({ error: `That's ${MAX_OPEN} positions on the coin. Collect some first.` });

  let quote;
  try { quote = await prices.getQuote(asset); } catch (e) {
    return res.status(503).json({ error: `Couldn't get a price for ${asset.symbol} right now. Try again in a minute.` });
  }
  // Never open a position on a price we know is old: during a provider
  // outage that's buying at yesterday's number. Collecting still works.
  if (quote.stale) return res.status(503).json({ error: `The price feed for ${asset.symbol} is behind right now. Try again in a minute.` });

  const result = await withTx(async (tx) => {
    const { rows: [u] } = await tx.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [req.user.id]);
    if (u.cash < amount) return { error: `You only have $${u.cash.toFixed(2)} to invest.` };
    await tx.query('UPDATE users SET cash = cash - $1 WHERE id = $2', [amount, u.id]);
    const { rows: [p] } = await tx.query(
      `INSERT INTO positions (user_id, symbol, name, asset_type, multiplier, invested, entry_price, opened_day, matures_at, origin_invested)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now() + ($9 || ' hours')::interval, $6) RETURNING *`,
      [u.id, asset.symbol, asset.name, asset.type, asset.multiplier, amount, quote.price, game.dayKey(), String(cfg.holdHours)],
    );
    return { position: p, cash: u.cash - amount };
  });

  if (result.error) return res.status(400).json({ error: result.error });
  res.json({ ok: true, position: shapePosition(result.position, quote), cash: game.round2(result.cash), quote });
}));

// Let it ride: realize a matured position's profit at half the tax rate
// (lobbyists get hired as usual), then roll what's left into a fresh position
// in the same asset at today's price. The clock and the multiplier start over.
router.post('/ride', auth.requireUser, RL.trade, wrap(async (req, res) => {
  const positionId = intId((req.body || {}).position_id);
  const charityId = Number((req.body || {}).charity_id);
  if (!positionId) return res.status(400).json({ error: 'Which position?' });
  const { rows: [p] } = await query('SELECT * FROM positions WHERE id = $1 AND user_id = $2', [positionId, req.user.id]);
  if (!p) return res.status(404).json({ error: 'No such position.' });
  if (p.status !== 'open') return res.status(400).json({ error: 'Already collected.' });
  await maturer.settleMatured([p]).catch((e) => console.error('maturer:', e.message));
  if (!p.matured_at) return res.status(400).json({ error: "It hasn't matured yet. You can only let a matured position ride." });
  if (!(p.matured_value >= 0.01)) return res.status(400).json({ error: "There's nothing left to ride." });

  const asset = assets.find(p.symbol);
  if (!asset) return res.status(400).json({ error: `${p.symbol} is no longer in the game. Collect it instead.` });
  let quote;
  try { quote = await prices.getQuote(asset); } catch (e) {
    return res.status(503).json({ error: `Couldn't get a price for ${p.symbol} right now. Try again in a minute.` });
  }
  if (quote.stale) return res.status(503).json({ error: `The price feed for ${p.symbol} is behind. Try again in a minute, or collect.` });
  const now = new Date();
  const day = game.dayKey(now);
  // Riding is a cash-out you immediately reinvest: the profit is taxed at the
  // ride rate (half the usual), the tax hires lobbyists, and what's left rides.
  // The other half is deferred onto the new position: due if it's sold
  // early, forgiven when it matures. (Without that, ride-then-sell-early
  // realized the gain at half rate with no risk taken.)
  const rate = cfg.taxRate * cfg.rideTaxFactor;
  const s = game.settle({ invested: p.invested, value: p.matured_value }, rate);
  const full = game.settle({ invested: p.invested, value: p.matured_value });
  const deferred = game.round2(Math.max(0, full.tax - s.tax));
  // The multiplier keeps climbing: the new day starts where the old one ended.
  const mults = game.rideMultipliers(p, asset.multiplier);
  const hireCost = Town.hireCost(req.user.town || Town.fresh());
  const lobbyists = s.tax > 0 ? game.round2(s.tax / hireCost) : 0;
  let charity = null;
  if (s.tax > 0) {
    charity = await pickCharity(req.user, charityId);
    if (!charity) return res.status(500).json({ error: 'No charities are set up yet.' });
  }
  if (!(s.net >= 0.01)) return res.status(400).json({ error: "There's nothing left to ride after the tax." });

  const result = await withTx(async (tx) => {
    const { rows: [locked] } = await tx.query('SELECT status FROM positions WHERE id = $1 FOR UPDATE', [p.id]);
    if (locked.status !== 'open') return { error: 'Already collected.' };
    // The charity is settled under the player's row lock, so a charity choice
    // made at the same moment can't leave these lobbyists on the old pick.
    const { rows: [owner] } = await tx.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [p.user_id]);
    if (charity) charity = (await pickCharity(owner, charityId, tx)) || charity;
    await tx.query(
      `UPDATE positions SET status = 'rolled', closed_at = $1, closed_day = $2, exit_price = $3,
              proceeds = $4, profit = $5, tax = $6, charity_id = $7, tier = $8 WHERE id = $9`,
      [now, day, p.matured_price, p.matured_value, s.profit, s.tax, charity ? charity.id : null, s.tier, p.id],
    );
    const { rows: [u] } = await tx.query(
      `UPDATE users SET total_donated = total_donated + $1, realized_pnl = realized_pnl + $2, charity_id = COALESCE(charity_id, $3)
       WHERE id = $4 RETURNING *`,
      [lobbyists, s.profit, explicitPick(charity, charityId), p.user_id],
    );
    if (lobbyists > 0) {
      await tx.query(
        'INSERT INTO donations (user_id, charity_id, position_id, amount, quarter) VALUES ($1, $2, $3, $4, $5)',
        [u.id, charity.id, p.id, lobbyists, game.quarterKey(day)],
      );
    }
    const { rows: [n] } = await tx.query(
      `INSERT INTO positions (user_id, symbol, name, asset_type, multiplier, mult_floor, invested, entry_price, opened_day, matures_at,
                              rolled_from, ride_count, origin_invested, deferred_tax)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now() + ($10 || ' hours')::interval, $11, $12, $13, $14) RETURNING *`,
      [p.user_id, p.symbol, p.name, p.asset_type, mults.ceiling, mults.floor, s.net, quote.price, day, String(cfg.holdHours),
        p.id, (p.ride_count || 0) + 1, p.origin_invested != null ? p.origin_invested : p.invested, deferred],
    );
    return { position: n, user: u };
  });
  if (result.error) return res.status(400).json({ error: result.error });
  res.json({
    ok: true,
    position: shapePosition(result.position, quote),
    user: publicUser(result.user),
    rolled: { from: p.id, value: p.matured_value, profit: s.profit, tax: s.tax, rate, deferred, lobbyists, hire_cost: hireCost, net: s.net, tier: s.tier, mult_floor: mults.floor, multiplier: mults.ceiling, charity: charity ? { id: charity.id, name: charity.name } : null },
    quote,
  });
}));

// --- Achievements: rare milestones, each with a gift from Mommy & Daddy -------------
//
// Earned automatically (achievements.sync, run by /me and GET /achievements).
// Claiming one is when the money moves: the gift is pure profit, taxed like
// any win, so it hires lobbyists for the default charity (or, on a first
// cash-out, the one picked). Recorded as a closed 'gift' position so it shows
// in Records and the donation links to it.

router.get('/achievements', auth.requireUser, RL.read, wrap(async (req, res) => {
  res.json(await achievements.sync(req.user));
}));

async function claimGift(req, res, key) {
  const a = achievements.BY_KEY.get(key);
  if (!a) return res.status(404).json({ error: 'No such achievement.' });
  await achievements.sync(req.user); // in case it was earned since the last look
  const charityId = Number((req.body || {}).charity_id);
  const now = new Date();
  const day = game.dayKey(now);
  const hireCost = Town.hireCost(req.user.town || Town.fresh());
  let charity = await pickCharity(req.user, charityId);
  if (!charity) return res.status(500).json({ error: 'No charities are set up yet.' });

  const result = await withTx(async (tx) => {
    const { rows: [u] } = await tx.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [req.user.id]);
    charity = (await pickCharity(u, charityId, tx)) || charity;
    const { rows: [row] } = await tx.query('SELECT * FROM achievements WHERE user_id = $1 AND key = $2 FOR UPDATE', [u.id, key]);
    if (!row) return { error: `Not yet: ${a.how}` };
    if (row.claimed_at) return { error: 'Already in your pocket. Mommy and Daddy only pay once.' };
    const amount = game.round2(row.gift != null ? Number(row.gift) : a.gift());
    const s = game.settle({ invested: 0, value: amount });
    const lobbyists = s.tax > 0 ? game.round2(s.tax / hireCost) : 0;
    const { rows: [p] } = await tx.query(
      `INSERT INTO positions (user_id, symbol, name, asset_type, multiplier, mult_floor, invested, entry_price, opened_day, matures_at,
                              matured_at, matured_price, matured_value, origin_invested,
                              status, closed_at, closed_day, exit_price, proceeds, profit, tax, charity_id, tier)
       VALUES ($1, 'GIFT', $2, 'stock', 1, 1, 0, 0, $3, now(), now(), 0, $4, 0,
               'gift', now(), $3, 0, $4, $5, $6, $7, 'Gift') RETURNING *`,
      [u.id, a.title, day, amount, s.profit, s.tax, lobbyists > 0 ? charity.id : null],
    );
    const { rows: [u2] } = await tx.query(
      `UPDATE users SET cash = cash + $1, total_donated = total_donated + $2, realized_pnl = realized_pnl + $3,
              charity_id = COALESCE(charity_id, $4), vested_at = CASE WHEN $6 THEN COALESCE(vested_at, now()) ELSE vested_at END
        WHERE id = $5 RETURNING *`,
      [s.net, lobbyists, s.profit, lobbyists > 0 ? explicitPick(charity, charityId) : null, u.id, key === 'first_buy'],
    );
    if (lobbyists > 0) {
      await tx.query(
        'INSERT INTO donations (user_id, charity_id, position_id, amount, quarter) VALUES ($1, $2, $3, $4, $5)',
        [u.id, charity.id, p.id, lobbyists, game.quarterKey(day)],
      );
    }
    await tx.query(
      `UPDATE achievements SET claimed_at = now(), gift = $3, tax = $4, lobbyists = $5, charity_id = $6, position_id = $7
        WHERE user_id = $1 AND key = $2`,
      [u.id, key, amount, s.tax, lobbyists, lobbyists > 0 ? charity.id : null, p.id],
    );
    return { user: u2, position: p, s, amount, lobbyists };
  });
  if (result.error) return res.status(400).json({ error: result.error });
  const user = result.user;
  user.friend_count = await friendCount(user.id);
  // If this hire opened the town, deal today's cards so there's something behind the flip.
  if (Town.isUnlocked(user.total_donated)) {
    user.town = user.town || Town.fresh();
    Town.tick(user.town, townCtx(user, { day }));
    Town.ensureIssues(user.town, townCtx(user, { day }));
    await query('UPDATE users SET town = $1 WHERE id = $2', [user.town, user.id]);
  }
  const { s, amount, lobbyists } = result;
  res.json({
    ok: true,
    user: publicUser(user),
    town: townView(user),
    achievements: await achievements.sync(user),
    receipt: {
      position_id: result.position.id, symbol: 'GIFT', name: a.title, invested: 0, value: amount,
      real_pct: null, swing_pct: null, busted: false, collected: true, gift: true, achievement: { key, title: a.title, from: a.from }, exit_price: 0,
      ...s, tier: 'Gift', lobbyists, hire_cost: hireCost,
      charity: lobbyists > 0 ? { id: charity.id, name: charity.name, slug: charity.slug } : null,
    },
  });
}

router.post('/achievements/claim', auth.requireUser, RL.trade, wrap(async (req, res) => claimGift(req, res, String((req.body || {}).key || ''))));
// Older clients: the day-one windfall used to be "your shares vested".
router.post('/vest', auth.requireUser, RL.trade, wrap(async (req, res) => claimGift(req, res, 'first_buy')));

router.post('/sell', auth.requireUser, RL.trade, wrap(async (req, res) => {
  const positionId = intId((req.body || {}).position_id);
  const charityId = Number((req.body || {}).charity_id);
  if (!positionId) return res.status(400).json({ error: 'Which position?' });

  const { rows: [p] } = await query(
    'SELECT * FROM positions WHERE id = $1 AND user_id = $2', [positionId, req.user.id],
  );
  if (!p) return res.status(404).json({ error: 'No such position.' });
  if (p.status !== 'open') return res.status(400).json({ error: 'Already collected.' });

  // Past maturity: freeze it now if the timer hasn't yet, then settle at the
  // frozen price ("collect"). Before maturity: settle at the live price ("sell").
  await maturer.settleMatured([p]).catch((e) => console.error('maturer:', e.message));
  let exitPrice;
  const asset = assets.find(p.symbol);
  if (p.matured_at) {
    exitPrice = p.matured_price;
  } else if (!asset) {
    // Taken out of the game since it was bought: hand the money back.
    exitPrice = p.entry_price;
  } else {
    try { exitPrice = (await prices.getQuote(asset)).price; } catch (e) {
      return res.status(503).json({ error: `Couldn't get a price for ${p.symbol} right now. Try again in a minute.` });
    }
  }

  const live = game.valueOf(p, exitPrice, p.matured_at ? new Date(p.matures_at).getTime() : Date.now());
  if (p.matured_at) live.value = p.matured_value;
  if (!asset && !p.matured_at) live.value = p.invested;
  // A ride sold before it matures owes the half of the tax it skipped; a ride
  // that went the distance has earned the discount. A delisting isn't the
  // player's doing, so it owes nothing.
  const deferred = !p.matured_at && asset ? (p.deferred_tax || 0) : 0;
  const s = game.settle({ invested: p.invested, value: live.value, deferred });
  if (!asset && !p.matured_at) s.tier = 'Delisted';

  // A profit needs a charity for its tax; a loss doesn't.
  let charity = null;
  if (s.tax > 0) {
    charity = await pickCharity(req.user, charityId);
    if (!charity) return res.status(500).json({ error: 'No charities are set up yet.' });
  }

  const now = new Date();
  const day = game.dayKey(now);
  // The recruiter's rate depends on how happy your village is.
  const hireCost = Town.hireCost(req.user.town || Town.fresh());
  const lobbyists = s.tax > 0 ? game.round2(s.tax / hireCost) : 0;

  const result = await withTx(async (tx) => {
    const { rows: [locked] } = await tx.query(
      'SELECT status FROM positions WHERE id = $1 FOR UPDATE', [p.id],
    );
    if (locked.status !== 'open') return { error: 'Already collected.' };
    const { rows: [owner] } = await tx.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [p.user_id]);
    if (charity) charity = (await pickCharity(owner, charityId, tx)) || charity;

    await tx.query(
      `UPDATE positions SET status = 'closed', closed_at = $1, closed_day = $2, exit_price = $3,
              proceeds = $4, profit = $5, tax = $6, charity_id = $7, tier = $8 WHERE id = $9`,
      [now, day, exitPrice, live.value, s.profit, s.tax, charity ? charity.id : null, s.tier, p.id],
    );
    const { rows: [u] } = await tx.query(
      `UPDATE users SET cash = cash + $1, total_donated = total_donated + $2, realized_pnl = realized_pnl + $3,
              charity_id = COALESCE(charity_id, $4)
       WHERE id = $5 RETURNING *`,
      [s.net, lobbyists, s.profit, explicitPick(charity, charityId), p.user_id],
    );
    if (lobbyists > 0) {
      // donations.amount is a headcount of lobbyists, not dollars.
      await tx.query(
        'INSERT INTO donations (user_id, charity_id, position_id, amount, quarter) VALUES ($1, $2, $3, $4, $5)',
        [u.id, charity.id, p.id, lobbyists, game.quarterKey(day)],
      );
    }
    return { user: u };
  });

  if (result.error) return res.status(400).json({ error: result.error });
  res.json({
    ok: true,
    user: publicUser(result.user),
    receipt: {
      position_id: p.id,
      symbol: p.symbol,
      name: p.name,
      invested: p.invested,
      value: live.value,
      real_pct: live.real_pct,
      swing_pct: live.swing_pct,
      busted: live.busted,
      collected: !!p.matured_at,   // true = matured and collected in full; false = sold early
      exit_price: exitPrice,
      ...s,
      lobbyists,
      hire_cost: hireCost,
      charity: charity ? { id: charity.id, name: charity.name, slug: charity.slug } : null,
    },
  });
}));

// --- The village -------------------------------------------------------------------

// Pick Preston's or Dolores's answer to one of today's issues.
router.post('/town/decide', auth.requireUser, wrap(async (req, res) => {
  const { issue_id: issueId, side } = req.body || {};
  const result = await withTx(async (tx) => {
    const { rows: [u] } = await tx.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [req.user.id]);
    if (!Town.isUnlocked(u.total_donated)) return { error: 'TrickleTown opens when you hire your first full lobbyist.' };
    const town = u.town || Town.fresh();
    const r = Town.decide(town, String(issueId || ''), side, u.cash);
    if (r.error) return r;
    const { rows: [u2] } = await tx.query(
      'UPDATE users SET cash = GREATEST(0, cash + $1), town = $2 WHERE id = $3 RETURNING *', [r.cash, town, u.id],
    );
    await ledgerAdd(tx, u.id, 'card', game.round2(Number(u2.cash) - Number(u.cash)), `${String(issueId || '').slice(0, 40)} · sided with ${r.side === 'preston' ? 'Preston' : 'Dolores'}`);
    return { user: u2, cash: r.cash, fx: r.fx, noted: r.noted, side: r.side };
  });
  if (result.error) return res.status(400).json({ error: result.error });
  result.user.friend_count = await friendCount(result.user.id);
  // How the rest of the town's landlords answered this card today, for the
  // "61% sided with Preston" line. Decisions live in each user's town JSON.
  const { rows: split } = await query(
    `SELECT i.chosen AS side, COUNT(*)::int AS n
       FROM users u, jsonb_to_recordset(u.town->'issues') AS i(id text, chosen text)
      WHERE u.town->>'day' = $1 AND i.id = $2 AND i.chosen IS NOT NULL
      GROUP BY i.chosen`,
    [game.dayKey(), String(issueId || '')],
  );
  const crowd = { preston: 0, dolores: 0 };
  for (const r of split) if (r.side in crowd) crowd[r.side] = r.n;
  res.json({ ok: true, cash_change: result.cash, fx: result.fx, noted: result.noted, side: result.side, crowd, user: publicUser(result.user), town: townView(result.user) });
}));

// Put up (or replace) a building on a plot.
router.post('/town/build', auth.requireUser, wrap(async (req, res) => {
  const { slot, key } = req.body || {};
  const result = await withTx(async (tx) => {
    const { rows: [u] } = await tx.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [req.user.id]);
    if (!Town.isUnlocked(u.total_donated)) return { error: 'TrickleTown opens when you hire your first full lobbyist.' };
    const town = u.town || Town.fresh();
    const r = Town.build(town, String(slot || ''), String(key || ''), u.cash, game.dayKey());
    if (r.error) return r;
    u.friend_count = await friendCount(u.id, tx);
    const dealt = Town.dealNewUnlocks(town, townCtx(u, { day: game.dayKey() }));
    const { rows: [u2] } = await tx.query(
      'UPDATE users SET cash = cash + $1, town = $2 WHERE id = $3 RETURNING *', [r.cash, town, u.id],
    );
    await ledgerAdd(tx, u.id, 'build', r.cash, `${String(key).slice(0, 30)} on the ${String(slot).slice(0, 20)} lot`);
    return { user: u2, dealt };
  });
  if (result.error) return res.status(400).json({ error: result.error });
  result.user.friend_count = await friendCount(result.user.id);
  res.json({ ok: true, user: publicUser(result.user), town: townView(result.user), fresh_cards: result.dealt.map((id) => (Town.ISSUES.find((i) => i.id === id) || {}).title).filter(Boolean) });
}));

// Buy an upgrade for the building on a plot.
router.post('/town/upgrade', auth.requireUser, wrap(async (req, res) => {
  const { slot, key } = req.body || {};
  const result = await withTx(async (tx) => {
    const { rows: [u] } = await tx.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [req.user.id]);
    if (!Town.isUnlocked(u.total_donated)) return { error: 'TrickleTown opens when you hire your first full lobbyist.' };
    const town = u.town || Town.fresh();
    const r = Town.upgrade(town, String(slot || ''), String(key || ''), u.cash, townCtx(u, { day: game.dayKey() }));
    if (r.error) return r;
    u.friend_count = await friendCount(u.id, tx);
    const dealt = Town.dealNewUnlocks(town, townCtx(u, { day: game.dayKey() }));
    const { rows: [u2] } = await tx.query(
      'UPDATE users SET cash = cash + $1, town = $2 WHERE id = $3 RETURNING *', [r.cash, town, u.id],
    );
    await ledgerAdd(tx, u.id, 'upgrade', r.cash, `${String(key).slice(0, 30)} on the ${String(slot).slice(0, 20)} lot`);
    return { user: u2, dealt };
  });
  if (result.error) return res.status(400).json({ error: result.error });
  result.user.friend_count = await friendCount(result.user.id);
  res.json({ ok: true, user: publicUser(result.user), town: townView(result.user), fresh_cards: result.dealt.map((id) => (Town.ISSUES.find((i) => i.id === id) || {}).title).filter(Boolean) });
}));

// --- Lobbyists: where this quarter's go, and where new ones go ---------------------
//
// { allocation?: [{ charity_id, amount }], default_charity_id? }
// allocation must account for exactly this quarter's lobbyists (they can be
// moved, not created or destroyed). The move is recorded as +/- donation rows
// with no position, so every total stays a SUM.
// Past quarters already marched; only the current one can be rearranged.
// --- The cat ---------------------------------------------------------------
// Name her (or him), and dress her. Outfits are pure vanity, priced to match.
async function catAction(req, res, act, what = '') {
  const result = await withTx(async (tx) => {
    const { rows: [u] } = await tx.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [req.user.id]);
    if (!u.town) return { error: 'There is no cat yet.' };
    const town = u.town;
    const r = act(town, u);
    if (r.error) return r;
    const { rows: [u2] } = await tx.query(
      'UPDATE users SET cash = cash + $1, town = $2 WHERE id = $3 RETURNING *', [r.cash || 0, town, u.id],
    );
    await ledgerAdd(tx, u.id, 'cat', r.cash || 0, what);
    return { user: u2 };
  });
  if (result.error) return res.status(400).json({ error: result.error });
  result.user.friend_count = await friendCount(result.user.id);
  res.json({ ok: true, user: publicUser(result.user), town: townView(result.user) });
}
router.post('/town/cat/name', auth.requireUser, RL.trade, wrap(async (req, res) => {
  const b = req.body || {};
  return catAction(req, res, (town) => Town.nameCat(town, { name: b.name, pronoun: b.pronoun, coat: b.coat }));
}));
router.post('/town/cat/buy', auth.requireUser, RL.trade, wrap(async (req, res) => {
  const item = String((req.body || {}).item || '');
  return catAction(req, res, (town, u) => Town.buyCatItem(town, item, u.cash), `${item.slice(0, 30)} for the cat`);
}));
router.post('/town/cat/wear', auth.requireUser, RL.trade, wrap(async (req, res) => {
  const b = req.body || {};
  return catAction(req, res, (town) => Town.wearCatItem(town, String(b.item || ''), b.on !== false));
}));

router.post('/lobbyists/assign', auth.requireUser, RL.trade, wrap(async (req, res) => {
  const body = req.body || {};
  const day = dayInfo();
  const { rows: activeRows } = await query('SELECT id FROM charities WHERE active');
  const active = new Set(activeRows.map((r) => r.id));
  const defaultId = body.default_charity_id == null ? null : intId(body.default_charity_id);
  if (defaultId != null && !active.has(defaultId)) return res.status(400).json({ error: "That charity isn't on the list." });
  let want = null;
  if (body.allocation != null) {
    if (!Array.isArray(body.allocation) || body.allocation.length > 100) return res.status(400).json({ error: 'Send the allocation as a list.' });
    want = new Map();
    for (const a of body.allocation) {
      const id = intId(a && a.charity_id), n = Number(a && a.amount);
      if (!id || !Number.isFinite(n) || n < 0 || n > 1e7) return res.status(400).json({ error: 'Each charity needs a lobbyist count of zero or more.' });
      want.set(id, game.round2((want.get(id) || 0) + n));
    }
  }
  if (!want && defaultId == null) return res.status(400).json({ error: 'Nothing to change.' });

  const result = await withTx(async (tx) => {
    const { rows: [u] } = await tx.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [req.user.id]);
    let moved = 0;
    if (want) {
      const now = await charitySplit(u.id, day.quarter, tx);
      const have = new Map(now.filter((c) => c.amount > 0).map((c) => [c.id, c.amount]));
      const total = game.round2([...have.values()].reduce((x, n) => x + n, 0));
      const asked = game.round2([...want.values()].reduce((x, n) => x + n, 0));
      if (Math.abs(asked - total) > 0.011) return { error: `That's ${asked} lobbyists; you have ${total} this quarter. Every one needs a charity.` };
      for (const [id, n] of want) {
        if (n > (have.get(id) || 0) + 0.001 && !active.has(id)) return { error: "That charity isn't taking new lobbyists." };
      }
      // Rounding: let the biggest pile absorb the last cent so nothing is created or lost.
      const residual = game.round2(total - asked);
      if (residual !== 0 && want.size) {
        const [bigId] = [...want.entries()].sort((a, b) => b[1] - a[1])[0];
        want.set(bigId, game.round2(want.get(bigId) + residual));
      }
      for (const id of new Set([...have.keys(), ...want.keys()])) {
        const diff = game.round2((want.get(id) || 0) - (have.get(id) || 0));
        if (Math.abs(diff) < 0.01) continue;
        await tx.query('INSERT INTO donations (user_id, charity_id, amount, quarter) VALUES ($1, $2, $3, $4)', [u.id, id, diff, day.quarter]);
        if (diff > 0) moved = game.round2(moved + diff);
      }
    }
    const { rows: [u2] } = defaultId != null
      ? await tx.query('UPDATE users SET charity_id = $1 WHERE id = $2 RETURNING *', [defaultId, u.id])
      : { rows: [u] };
    await ledgerAdd(tx, u.id, 'assign', 0, defaultId != null && defaultId !== u.charity_id ? 'changed default charity' : 'moved lobbyists between charities', moved);
    return { user: u2, moved };
  });
  if (result.error) return res.status(400).json({ error: result.error });
  const split = await charitySplit(result.user.id, day.quarter);
  res.json({
    ok: true,
    moved: result.moved,
    user: { ...publicUser(result.user), quarter_donated: game.round2(split.reduce((x, c) => x + c.amount, 0)) },
    donations_by_charity: split,
  });
}));

// --- Choosing a charity ------------------------------------------------------------

// The first-lobbyist moment (and anyone whose charity was retired): choose
// where your lobbyists lobby. Sets the default, and moves this quarter's
// lobbyists onto it: all of them if there was no default before (they were
// parked on a provisional pick), otherwise only the ones on retired charities.
router.post('/charity/choose', auth.requireUser, RL.trade, wrap(async (req, res) => {
  const charityId = intId((req.body || {}).charity_id);
  const day = dayInfo();
  const { rows: [c] } = await query('SELECT id, name, active FROM charities WHERE id = $1', [charityId || -1]);
  if (!c || !c.active) return res.status(400).json({ error: "That charity isn't on the list." });
  const result = await withTx(async (tx) => {
    const { rows: [u] } = await tx.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [req.user.id]);
    // No default yet: every lobbyist was parked provisionally, so they all
    // follow the choice. A default already set (even a retired one): only
    // lobbyists on retired charities move; ones placed on a real charity stay.
    const moveAll = !u.charity_id;
    const split = await charitySplit(u.id, day.quarter, tx);
    let moved = 0;
    for (const row of split) {
      if (row.id === c.id || !(row.amount > 0)) continue;
      if (!moveAll && row.active) continue;
      await tx.query('INSERT INTO donations (user_id, charity_id, amount, quarter) VALUES ($1, $2, $3, $4)', [u.id, row.id, -row.amount, day.quarter]);
      await tx.query('INSERT INTO donations (user_id, charity_id, amount, quarter) VALUES ($1, $2, $3, $4)', [u.id, c.id, row.amount, day.quarter]);
      moved = game.round2(moved + row.amount);
    }
    const { rows: [u2] } = await tx.query('UPDATE users SET charity_id = $1 WHERE id = $2 RETURNING *', [c.id, u.id]);
    await ledgerAdd(tx, u.id, 'assign', 0, `chose ${c.name}`, moved, { always: u.charity_id !== c.id });
    return { user: u2, moved };
  });
  const split = await charitySplit(result.user.id, day.quarter);
  res.json({ ok: true, moved: result.moved, charity: { id: c.id, name: c.name }, user: publicUser(result.user), donations_by_charity: split });
}));

// "Don't see yours?" A request for a charity that isn't on the list. Read by a
// person (the admin page) before anything is added; nothing here is automatic.
// Past this many unread, new ones wait: a flood can't grow the tables forever.
const INBOX_MAX = 2000;
async function inboxFull(table) {
  const { rows: [r] } = await query(`SELECT COUNT(*)::int AS n FROM ${table} WHERE status = 'new'`);
  return r.n >= INBOX_MAX;
}

router.post('/charity-requests', RL.requestIp, auth.requireUser, RL.request, wrap(async (req, res) => {
  const b = req.body || {};
  const name = oneLine(b.name, 100);
  const url = cleanUrl(b.url, 300);
  const reason = cleanWallBody(b.reason).slice(0, 600).trim();
  if (name.length < 2) return res.status(400).json({ error: "What's the charity called?" });
  if (url === null || !url) return res.status(400).json({ error: "That doesn't look like a web address. Something like example.org works." });
  if (await inboxFull('charity_requests')) return res.status(503).json({ error: 'The request box is full right now. Try again in a few days.' });
  await query('INSERT INTO charity_requests (user_id, name, url, reason) VALUES ($1, $2, $3, $4)', [req.user.id, name, url, reason]);
  res.json({ ok: true });
}));

// ☰ → Report a bug. The page they were on comes along unless they took it off.
router.post('/bugs', RL.bugIp, auth.requireUser, RL.bug, wrap(async (req, res) => {
  const b = req.body || {};
  const description = cleanWallBody(b.description).slice(0, 2000).trim();
  const url = cleanUrl(b.url, 500, { needDot: false }) || '';
  const client = oneLine(b.client, 300);
  if (description.length < 4) return res.status(400).json({ error: 'Say a few words about what went wrong.' });
  if (await inboxFull('bug_reports')) return res.status(503).json({ error: 'The bug box is full right now. Try again in a few days.' });
  await query('INSERT INTO bug_reports (user_id, description, url, client) VALUES ($1, $2, $3, $4)', [req.user.id, description, url, client]);
  res.json({ ok: true });
}));

// --- Admin: the whole picture ----------------------------------------------------------
// Read-only views of everything, plus marking requests handled. Usernames and
// game numbers only: no password hashes, Google ids or tokens ever leave here.

router.get('/admin/overview', auth.requireUser, requireAdmin, RL.admin, wrap(async (req, res) => {
  const { rows: [o] } = await query(
    `SELECT (SELECT COUNT(*) FROM users)::int AS users,
            (SELECT COUNT(*) FROM users WHERE is_guest)::int AS guests,
            (SELECT COUNT(*) FROM users WHERE last_seen_at > now() - interval '1 day')::int AS active_today,
            (SELECT COUNT(*) FROM positions WHERE status = 'open')::int AS open_positions,
            (SELECT COALESCE(SUM(amount), 0) FROM donations WHERE quarter = $1)::float8 AS quarter_lobbyists,
            (SELECT COUNT(*) FROM charity_requests WHERE status = 'new')::int AS new_requests,
            (SELECT COUNT(*) FROM bug_reports WHERE status = 'new')::int AS new_bugs`,
    [dayInfo().quarter],
  );
  res.json(o);
}));

// Every transaction, newest first: buys, rides, sales and collections, gifts,
// plus the ledger (allowance, town, cat, grants, lobbyist moves). Paged by
// time: pass the last row's "at" as ?before= for the next page.
router.get('/admin/transactions', auth.requireUser, requireAdmin, RL.admin, wrap(async (req, res) => {
  const limit = Math.max(10, Math.min(300, Number(req.query.limit) || 150));
  // Exact paging: the cursor is the last row's time to the microsecond plus
  // its ref, so rows sharing a timestamp are neither skipped nor repeated.
  const cur = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z)~([pcl]\d{1,10})$/.exec(String(req.query.cursor || ''));
  const before = cur ? cur[1] : new Date(Date.now() + 60e3).toISOString();
  const beforeRef = cur ? cur[2] : '~';
  const who = req.query.username ? await findPlayer(String(req.query.username)) : null;
  if (req.query.username && !who) return res.status(404).json({ error: 'No player by that name.' });
  const { rows } = await query(
    `SELECT t.*, u.username, to_char(t.at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at_key FROM (
       SELECT p.opened_at AS at, p.user_id, CASE WHEN p.rolled_from IS NOT NULL THEN 'ride' ELSE 'buy' END AS kind,
              p.symbol AS what, CASE WHEN p.rolled_from IS NOT NULL THEN NULL ELSE -p.invested END AS cash,
              p.invested AS amount, NULL::numeric AS profit, NULL::numeric AS tax, NULL::numeric AS lobbyists, NULL::text AS charity,
              ('×' || p.multiplier::float8::text) AS note, 'p' || p.id AS ref
         FROM positions p WHERE p.status NOT IN ('gift', 'vested')
       UNION ALL
       SELECT p.closed_at, p.user_id,
              CASE WHEN p.status = 'gift' THEN 'gift' WHEN p.status = 'vested' THEN 'vested' WHEN p.status = 'rolled' THEN 'rolled'
                   WHEN COALESCE(p.proceeds, 0) <= 0 THEN 'bust' WHEN p.matured_at IS NOT NULL THEN 'collect' ELSE 'sell' END,
              CASE WHEN p.status IN ('gift', 'vested') THEN p.name ELSE p.symbol END,
              CASE WHEN p.status = 'rolled' THEN NULL ELSE COALESCE(p.proceeds, 0) - COALESCE(p.tax, 0) END,
              p.proceeds, p.profit, p.tax, d.lob, c.name, COALESCE(p.tier, ''), 'c' || p.id
         FROM positions p
         LEFT JOIN (SELECT position_id, SUM(amount) AS lob FROM donations WHERE position_id IS NOT NULL GROUP BY position_id) d ON d.position_id = p.id
         LEFT JOIN charities c ON c.id = p.charity_id
        WHERE p.closed_at IS NOT NULL
       UNION ALL
       SELECT l.created_at, l.user_id, l.kind, '', l.amount, ABS(l.amount), NULL, NULL, NULLIF(l.lobbyists, 0), NULL, l.detail, 'l' || l.id
         FROM ledger l
     ) t JOIN users u ON u.id = t.user_id
     WHERE t.at <= $1::timestamptz AND (t.at, t.ref) < ($1::timestamptz, $4::text) AND ($2::int IS NULL OR t.user_id = $2)
     ORDER BY t.at DESC, t.ref DESC LIMIT $3`,
    [before, who ? who.id : null, limit, beforeRef],
  );
  const num = (v) => (v == null ? null : game.round2(Number(v)));
  res.json({
    transactions: rows.map((r) => ({ ref: r.ref, undoable: r.ref[0] !== 'l' || Object.hasOwn(LEDGER_UNDO, r.kind), at: r.at, username: r.username, kind: r.kind, what: r.what, cash: num(r.cash), amount: num(r.amount), profit: num(r.profit), tax: num(r.tax), lobbyists: num(r.lobbyists), charity: r.charity, note: r.note })),
    more: rows.length === limit,
    cursor: rows.length ? `${rows[rows.length - 1].at_key}~${rows[rows.length - 1].ref}` : null,
  });
}));

// Every open position, with what it's worth at the last price this server
// saw (no fresh lookups: the price budget is for players).
router.get('/admin/positions', auth.requireUser, requireAdmin, RL.admin, wrap(async (req, res) => {
  const { rows } = await query(
    `SELECT p.*, u.username FROM positions p JOIN users u ON u.id = p.user_id WHERE p.status = 'open' ORDER BY p.opened_at DESC LIMIT 1000`,
  );
  const out = rows.map((p) => {
    const q = p.matured_at ? null : prices.peek(p.symbol);
    const s = shapePosition(p, q);
    const status = p.matured_at ? 'matured' : s.quote_error ? 'live (no recent price)' : s.busted ? 'busted' : 'live';
    return { id: p.id, username: p.username, symbol: p.symbol, invested: Number(p.invested), value: s.value == null ? null : game.round2(s.value), swing_pct: s.swing_pct,
      multiplier: Number(p.multiplier), ride_count: p.ride_count || 0, opened_at: p.opened_at, matures_at: p.matures_at, status };
  });
  res.json({ positions: out });
}));

// Every player, with the numbers that say how they're playing.
router.get('/admin/users', auth.requireUser, requireAdmin, RL.admin, wrap(async (req, res) => {
  const quarter = dayInfo().quarter;
  const { rows } = await query(
    `SELECT u.id, u.username, u.is_guest, u.created_at, u.last_seen_at, u.cash::float8 AS cash, u.total_donated::float8 AS lobbyists,
            u.realized_pnl::float8 AS realized_pnl, u.streak, u.town, c.name AS charity, c.active AS charity_active,
            COALESCE(pp.open, 0)::int AS open_positions, COALESCE(pp.total, 0)::int AS total_positions, COALESCE(pp.in_open, 0)::float8 AS invested_open,
            COALESCE(dq.n, 0)::float8 AS quarter_lobbyists, COALESCE(ac.n, 0)::int AS achievements, COALESCE(fr.n, 0)::int AS friends
       FROM users u
       LEFT JOIN charities c ON c.id = u.charity_id
       LEFT JOIN (SELECT user_id, COUNT(*) FILTER (WHERE status = 'open') AS open, COUNT(*) FILTER (WHERE status NOT IN ('gift', 'vested')) AS total,
                         SUM(invested) FILTER (WHERE status = 'open') AS in_open FROM positions GROUP BY user_id) pp ON pp.user_id = u.id
       LEFT JOIN (SELECT user_id, SUM(amount) AS n FROM donations WHERE quarter = $1 GROUP BY user_id) dq ON dq.user_id = u.id
       LEFT JOIN (SELECT user_id, COUNT(*) AS n FROM achievements GROUP BY user_id) ac ON ac.user_id = u.id
       LEFT JOIN (SELECT user_id, COUNT(*) AS n FROM friends GROUP BY user_id) fr ON fr.user_id = u.id
      ORDER BY u.last_seen_at DESC LIMIT 2000`,
    [quarter],
  );
  res.json({
    users: rows.map((r) => {
      const t = r.town || {};
      const sides = t.sides || {};
      return {
        username: r.username, is_guest: r.is_guest, is_admin: auth.isAdmin(r), created_at: r.created_at, last_seen_at: r.last_seen_at,
        cash: game.round2(r.cash), lobbyists: game.round2(r.lobbyists), quarter_lobbyists: game.round2(r.quarter_lobbyists),
        realized_pnl: game.round2(r.realized_pnl), streak: r.streak, open_positions: r.open_positions, total_positions: r.total_positions,
        invested_open: game.round2(r.invested_open), cards_played: (sides.preston || 0) + (sides.dolores || 0),
        buildings: Object.values(t.plots || {}).filter(Boolean).length, cat: t.cat && t.cat.name ? t.cat.name : null,
        achievements: r.achievements, friends: r.friends, charity: r.charity ? `${r.charity}${r.charity_active ? '' : ' (retired)'}` : null,
      };
    }),
  });
}));

// Charity requests and bug reports, newest first; new ones on top.
router.get('/admin/requests', auth.requireUser, requireAdmin, RL.admin, wrap(async (req, res) => {
  const { rows: requests } = await query(
    `SELECT r.id, r.name, r.url, r.reason, r.status, r.created_at, u.username
       FROM charity_requests r LEFT JOIN users u ON u.id = r.user_id ORDER BY (r.status = 'new') DESC, r.created_at DESC LIMIT 300`,
  );
  const { rows: bugs } = await query(
    `SELECT b.id, b.description, b.url, b.client, b.status, b.created_at, u.username
       FROM bug_reports b LEFT JOIN users u ON u.id = b.user_id ORDER BY (b.status = 'new') DESC, b.created_at DESC LIMIT 300`,
  );
  res.json({ requests, bugs });
}));

router.post('/admin/requests/:kind/:id', auth.requireUser, requireAdmin, RL.admin, wrap(async (req, res) => {
  const tables = { charity: 'charity_requests', bug: 'bug_reports' };
  const table = Object.hasOwn(tables, req.params.kind) ? tables[req.params.kind] : null;
  const id = intId(req.params.id);
  const status = String((req.body || {}).status || '');
  if (!table || !id || !['new', 'done', 'dismissed'].includes(status)) return res.status(400).json({ error: 'Bad request.' });
  const { rowCount } = await query(`UPDATE ${table} SET status = $1, handled_at = CASE WHEN $1 = 'new' THEN NULL ELSE now() END WHERE id = $2`, [status, id]);
  if (!rowCount) return res.status(404).json({ error: 'Not found.' });
  res.json({ ok: true });
}));

// --- Admin: cleaning up --------------------------------------------------------------
// Undo a transaction, take lobbyists away, remove accounts. Every one takes
// dry_run: true first, which does the whole thing inside a transaction and
// rolls it back, so the confirmation shows exactly what will happen.

class DryRun extends Error { constructor(result) { super('dry run'); this.result = result; } }
async function txMaybeDry(dry, fn) {
  try {
    return await withTx(async (tx) => {
      const r = await fn(tx);
      if (dry && !r.error) throw new DryRun(r);
      return r;
    });
  } catch (e) {
    if (e instanceof DryRun) return { ...e.result, dry_run: true };
    throw e;
  }
}

// Take up to `amount` of a player's lobbyists out of one quarter: from
// `preferId` first (where they were hired), then the biggest. Negative rows
// with no position, like a move, so every total stays a SUM and no charity
// goes below zero (they may have been moved since). Returns how many.
async function takeLobbyists(tx, userId, quarter, amount, preferId = null) {
  const { rows } = await tx.query(
    `SELECT charity_id, SUM(amount)::float8 AS have FROM donations
      WHERE user_id = $1 AND quarter = $2 GROUP BY charity_id HAVING SUM(amount) > 0.004`, [userId, quarter],
  );
  rows.sort((a, b) => (b.charity_id === preferId) - (a.charity_id === preferId) || b.have - a.have);
  let left = game.round2(amount), taken = 0;
  for (const r of rows) {
    if (left <= 0) break;
    const n = game.round2(Math.min(left, r.have));
    if (n <= 0) continue;
    await tx.query('INSERT INTO donations (user_id, charity_id, amount, quarter) VALUES ($1, $2, $3, $4)', [userId, r.charity_id, -n, quarter]);
    left = game.round2(left - n); taken = game.round2(taken + n);
  }
  return taken;
}

// Put a player's numbers back. Cash never goes below $0 (they may have spent
// it); the admin undo row records what actually changed, and who did it.
async function applyUndo(tx, u, admin, { cash = 0, lobbyists = 0, pnl = 0 }, detail) {
  const before = Number(u.cash), after = game.round2(Math.max(0, before + cash));
  await tx.query(
    'UPDATE users SET cash = $1, total_donated = GREATEST(0, total_donated - $2), realized_pnl = realized_pnl + $3 WHERE id = $4',
    [after, lobbyists, game.round2(pnl), u.id],
  );
  await ledgerAdd(tx, u.id, 'admin undo', game.round2(after - before), `${detail} · by ${admin.username}`.slice(0, 200), -lobbyists, { always: true });
  return { cash: game.round2(after - before), cash_wanted: game.round2(cash), cash_before: before, lobbyists: -lobbyists, pnl: game.round2(pnl) };
}

// Ledger kinds that can be undone, and what undoing one means. The rest (moves
// between charities, admin removals and undos) are records, not money.
const LEDGER_UNDO = {
  allowance: 'Takes the allowance back.',
  'admin grant': 'Takes the grant back: the cash, and the lobbyists from the charity they went to.',
  card: "Moves the card's money back. What the card did to the town stays.",
  build: 'Gives the money back. The building stays.',
  upgrade: 'Gives the money back. The upgrade stays.',
  cat: 'Gives the money back. The outfit stays.',
};

// A position goes with its whole ride chain: a ride only exists on top of the
// one before it. Undoing it refunds the buy, takes back what it paid out,
// takes back its lobbyists and P&L, and re-opens a gift for claiming.
async function undoChain(tx, posId, admin) {
  const { rows: chain } = await tx.query(
    `WITH RECURSIVE up AS (
       SELECT id, rolled_from FROM positions WHERE id = $1
       UNION ALL SELECT p.id, p.rolled_from FROM positions p JOIN up ON p.id = up.rolled_from
     ), down AS (
       SELECT id FROM up WHERE rolled_from IS NULL
       UNION ALL SELECT p.id FROM positions p JOIN down ON p.rolled_from = down.id
     )
     SELECT * FROM positions WHERE id IN (SELECT id FROM down) ORDER BY id FOR UPDATE`, [posId],
  );
  if (!chain.length) return { error: 'That one is already gone.', status: 404 };
  const { rows: [u] } = await tx.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [chain[0].user_id]);
  let cash = 0, pnl = 0;
  for (const p of chain) {
    if (p.rolled_from == null) cash += Number(p.invested);                                   // the buy comes back
    if (['closed', 'gift', 'vested'].includes(p.status)) cash -= Number(p.proceeds || 0) - Number(p.tax || 0); // what it paid out goes
    if (p.status !== 'open') pnl -= Number(p.profit || 0);
  }
  const ids = chain.map((p) => p.id);
  const { rows: dons } = await tx.query(
    'SELECT charity_id, quarter, SUM(amount)::float8 AS n FROM donations WHERE position_id = ANY($1) GROUP BY charity_id, quarter', [ids],
  );
  // Their hire rows stay (unlinked); matching negative rows take the lobbyists back.
  await tx.query('UPDATE donations SET position_id = NULL WHERE position_id = ANY($1)', [ids]);
  let lob = 0;
  for (const d of dons) if (d.n > 0) lob = game.round2(lob + await takeLobbyists(tx, u.id, d.quarter, d.n, d.charity_id));
  const gifts = chain.filter((p) => p.status === 'gift' || p.status === 'vested').map((p) => p.id);
  let reopened = [];
  if (gifts.length) {
    const { rows } = await tx.query(
      `UPDATE achievements SET claimed_at = NULL, tax = NULL, lobbyists = NULL, charity_id = NULL, position_id = NULL
        WHERE position_id = ANY($1) RETURNING key`, [gifts],
    );
    reopened = rows.map((r) => r.key);
    if (reopened.includes('first_buy')) await tx.query('UPDATE users SET vested_at = NULL WHERE id = $1', [u.id]);
  }
  await tx.query('DELETE FROM positions WHERE id = ANY($1)', [ids]);
  const root = chain[0];
  const label = root.status === 'gift' || root.status === 'vested' ? `gift “${root.name}”` : `${root.symbol} ${chain.length > 1 ? `buy + ${chain.length - 1} ride${chain.length > 2 ? 's' : ''}` : 'position'}`;
  const effect = await applyUndo(tx, u, admin, { cash, lobbyists: lob, pnl }, `undid ${label}`);
  return {
    username: u.username, label, ...effect, reopened,
    items: chain.map((p) => ({
      kind: p.status === 'gift' || p.status === 'vested' ? p.status : p.rolled_from ? 'ride' : 'buy',
      what: p.status === 'gift' || p.status === 'vested' ? p.name : p.symbol, invested: Number(p.invested), multiplier: Number(p.multiplier),
      status: p.status, proceeds: p.proceeds == null ? null : Number(p.proceeds), tax: p.tax == null ? null : Number(p.tax), opened_at: p.opened_at, closed_at: p.closed_at,
    })),
  };
}

async function undoLedger(tx, id, admin) {
  const { rows: [l] } = await tx.query('SELECT * FROM ledger WHERE id = $1', [id]);
  if (!l) return { error: 'That one is already gone.', status: 404 };
  if (!Object.hasOwn(LEDGER_UNDO, l.kind)) return { error: "That's a record of a move, not money, so there's nothing to undo." };
  const { rows: [u] } = await tx.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [l.user_id]);
  const { rowCount } = await tx.query('DELETE FROM ledger WHERE id = $1', [id]);
  if (!rowCount) return { error: 'That one is already gone.', status: 404 };
  let lob = 0;
  if (l.kind === 'admin grant' && Number(l.lobbyists) > 0) {
    lob = await takeLobbyists(tx, u.id, game.quarterKey(game.dayKey(new Date(l.created_at))), Number(l.lobbyists), l.charity_id);
  }
  const label = `${l.kind}${l.detail ? ` (${l.detail})` : ''}`.slice(0, 120);
  const effect = await applyUndo(tx, u, admin, { cash: -Number(l.amount), lobbyists: lob }, `undid ${label}`);
  return { username: u.username, label, note: LEDGER_UNDO[l.kind], ...effect, items: [] };
}

router.post('/admin/transactions/undo', auth.requireUser, requireAdmin, RL.admin, wrap(async (req, res) => {
  const body = req.body || {};
  const m = /^([pcl])(\d{1,10})$/.exec(String(body.ref || ''));
  const id = m && intId(m[2]);
  if (!id) return res.status(400).json({ error: 'Which transaction?' });
  const dry = body.dry_run === true;
  const r = await txMaybeDry(dry, (tx) => (m[1] === 'l' ? undoLedger(tx, id, req.user) : undoChain(tx, id, req.user)));
  if (r.error) return res.status(r.status || 400).json({ error: r.error });
  if (!dry) console.log(`[admin] ${req.user.username} undid ${body.ref} for ${r.username}: cash ${r.cash}, lobbyists ${r.lobbyists}`);
  res.json({ ok: true, dry_run: dry, ...r });
}));

// A player's lobbyists this quarter, by charity, for the remove sheet.
router.get('/admin/lobbyists', auth.requireUser, requireAdmin, RL.admin, wrap(async (req, res) => {
  const target = await findPlayer(String(req.query.username || ''));
  if (!target) return res.status(404).json({ error: 'No player by that name.' });
  const day = dayInfo();
  const split = (await charitySplit(target.id, day.quarter)).filter((c) => c.amount > 0);
  res.json({ username: target.username, quarter: day.quarter, total_donated: game.round2(Number(target.total_donated)), donations_by_charity: split });
}));

// Take some (or all) of a player's lobbyists away, this quarter. They're
// gone, not moved: off the payroll and off the all-time count.
router.post('/admin/lobbyists/remove', auth.requireUser, requireAdmin, RL.admin, wrap(async (req, res) => {
  const body = req.body || {};
  const target = await findPlayer(String(body.username || ''));
  if (!target) return res.status(404).json({ error: 'No player by that name.' });
  if (!Array.isArray(body.take) || !body.take.length || body.take.length > 100) return res.status(400).json({ error: 'Say how many to take from which charity.' });
  const take = new Map();
  for (const t of body.take) {
    const id = intId(t && t.charity_id), n = Number(t && t.amount);
    if (!id || !Number.isFinite(n) || n < 0 || n > 1e7) return res.status(400).json({ error: 'Each charity needs a count of zero or more.' });
    if (n > 0) take.set(id, game.round2((take.get(id) || 0) + n));
  }
  if (!take.size) return res.status(400).json({ error: 'Nothing to remove.' });
  const day = dayInfo();
  const dry = body.dry_run === true;
  const r = await txMaybeDry(dry, async (tx) => {
    const { rows: [u] } = await tx.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [target.id]);
    const have = new Map((await charitySplit(u.id, day.quarter, tx)).map((c) => [c.id, c.amount]));
    let removed = 0;
    for (const [id, n] of take) {
      const k = game.round2(Math.min(n, have.get(id) || 0));
      if (k <= 0) continue;
      await tx.query('INSERT INTO donations (user_id, charity_id, amount, quarter) VALUES ($1, $2, $3, $4)', [u.id, id, -k, day.quarter]);
      removed = game.round2(removed + k);
    }
    if (!removed) return { error: "They don't have those lobbyists this quarter." };
    await tx.query('UPDATE users SET total_donated = GREATEST(0, total_donated - $1) WHERE id = $2', [removed, u.id]);
    await ledgerAdd(tx, u.id, 'admin remove', 0, `removed by ${req.user.username}`, -removed);
    return { username: u.username, removed, donations_by_charity: (await charitySplit(u.id, day.quarter, tx)).filter((c) => c.amount > 0) };
  });
  if (r.error) return res.status(400).json({ error: r.error });
  if (!dry) console.log(`[admin] ${req.user.username} removed ${r.removed} lobbyists from ${r.username}`);
  res.json({ ok: true, dry_run: dry, ...r });
}));

// Remove accounts for good: positions, lobbyists, town, friends both ways,
// wall posts, everything (the foreign keys cascade; their charity requests
// and bug reports stay, unsigned). Admin accounts can't be removed here.
// Confirm with the username (one) or the count (several), checked here too.
router.post('/admin/users/remove', auth.requireUser, requireAdmin, RL.admin, wrap(async (req, res) => {
  const body = req.body || {};
  const names = [...new Set([].concat(body.usernames || []).map((n) => String(n).toLowerCase().slice(0, 40)))];
  if (!names.length || names.length > 500) return res.status(400).json({ error: 'Pick between 1 and 500 players.' });
  const quarter = dayInfo().quarter;
  const { rows } = await query(
    `SELECT u.id, u.username, u.is_guest, u.cash::float8 AS cash, u.total_donated::float8 AS lobbyists,
            (SELECT COUNT(*) FROM positions p WHERE p.user_id = u.id)::int AS positions,
            (SELECT COALESCE(SUM(amount), 0) FROM donations d WHERE d.user_id = u.id AND d.quarter = $2)::float8 AS quarter_lobbyists,
            (SELECT COUNT(*) FROM friends f WHERE f.friend_id = u.id)::int AS followers
       FROM users u WHERE lower(u.username) = ANY($1) ORDER BY u.username`, [names, quarter],
  );
  const missing = names.filter((n) => !rows.some((r) => r.username.toLowerCase() === n));
  if (missing.length) return res.status(404).json({ error: `No player by ${missing.length === 1 ? 'that name' : 'these names'}: ${missing.slice(0, 10).join(', ')}` });
  const admins = rows.filter((r) => auth.isAdmin(r));
  if (admins.length) return res.status(400).json({ error: `Admin accounts can't be removed here (${admins.map((r) => r.username).join(', ')}).` });
  const summary = rows.map((r) => ({ username: r.username, is_guest: r.is_guest, cash: game.round2(r.cash), lobbyists: game.round2(r.lobbyists), quarter_lobbyists: game.round2(r.quarter_lobbyists), positions: r.positions, followers: r.followers }));
  const word = rows.length === 1 ? rows[0].username : String(rows.length);
  if (body.dry_run === true) return res.json({ ok: true, dry_run: true, confirm_with: word, users: summary });
  if (String(body.confirm || '').trim().toLowerCase() !== word.toLowerCase()) return res.status(400).json({ error: `To confirm, type ${rows.length === 1 ? 'the username' : 'the number of players'}: ${word}` });
  const { rowCount } = await query('DELETE FROM users WHERE id = ANY($1)', [rows.map((r) => r.id)]);
  console.log(`[admin] ${req.user.username} removed ${rowCount} account(s): ${rows.map((r) => r.username).join(', ').slice(0, 500)}`);
  res.json({ ok: true, removed: rowCount, users: summary });
}));

// --- Public boards ---------------------------------------------------------------

// Where the trickle is going: per-charity shares for the quarter plus all time.
router.get('/trickle', wrap(async (req, res) => {
  const day = dayInfo();
  const { rows } = await query(
    `SELECT c.id, c.slug, c.name, c.blurb, c.url, c.category, c.rating,
            GREATEST(0, COALESCE(q.total, 0))::float8 AS quarter_total,
            COALESCE(a.total, 0)::float8 AS all_time,
            COALESCE(q.donors, 0)::int AS quarter_donors
       FROM charities c
       LEFT JOIN (SELECT charity_id, SUM(n) AS total, COUNT(*) FILTER (WHERE n > 0.005) AS donors
                    FROM (SELECT charity_id, user_id, SUM(amount) AS n FROM donations WHERE quarter = $1 GROUP BY charity_id, user_id) x
                   GROUP BY charity_id) q ON q.charity_id = c.id
       LEFT JOIN (SELECT charity_id, SUM(amount) AS total FROM donations GROUP BY charity_id) a ON a.charity_id = c.id
      WHERE c.active
      ORDER BY quarter_total DESC, all_time DESC, c.sort`,
    [day.quarter],
  );
  const quarterTotal = rows.reduce((s, r) => s + r.quarter_total, 0);
  const allTime = rows.reduce((s, r) => s + r.all_time, 0);
  const { rows: [players] } = await query(
    `SELECT COUNT(*)::int AS donors FROM (SELECT user_id FROM donations WHERE quarter = $1 GROUP BY user_id HAVING SUM(amount) > 0.005) x`, [day.quarter],
  );
  res.json({
    quarter: day.quarter,
    quarter_ends_at: day.quarter_ends_at,
    demo: cfg.demoMode,
    pool_usd: cfg.poolUsd,
    quarter_total: quarterTotal,
    all_time: allTime,
    quarter_donors: players.donors,
    charities: rows.map((r) => ({
      ...r,
      share: quarterTotal > 0 ? r.quarter_total / quarterTotal : 0,
      est_usd: quarterTotal > 0 ? game.round2(cfg.poolUsd * (r.quarter_total / quarterTotal)) : 0,
    })),
  });
}));

// Optional auth: loads req.user when a valid token is present, else continues.
// Public pages that get a little better when you're signed in. A missing,
// expired or revoked token just means "anonymous" here, never a 401.
function optionalUser(req, res, next) {
  if (!req.get('authorization')) return next();
  const quiet = { status: () => ({ json: () => next() }) };
  // A database error still goes to the error handler; a bad token does not.
  return auth.requireUser(req, quiet, (err) => (err ? next(err) : next()));
}

router.get('/leaderboard', optionalUser, wrap(async (req, res) => {
  const day = dayInfo();
  const friendsOnly = req.query.friends === '1' && req.user;
  const scope = friendsOnly
    ? `u.id IN (SELECT friend_id FROM friends WHERE user_id = ${Number(req.user.id)} UNION SELECT ${Number(req.user.id)})`
    : 'true';
  // Lobbyfest standings: this quarter's hires, with the career total alongside.
  const { rows: allTime } = await query(
    `SELECT u.username, u.total_donated::float8 AS donated, COALESCE(q.total, 0)::float8 AS quarter,
            u.realized_pnl::float8 AS realized_pnl, u.streak
       FROM users u
       LEFT JOIN (SELECT user_id, SUM(amount) AS total FROM donations WHERE quarter = $1 GROUP BY user_id) q ON q.user_id = u.id
      WHERE u.total_donated > 0 AND ${scope}
      ORDER BY quarter DESC, u.total_donated DESC, u.username LIMIT 25`,
    [day.quarter],
  );
  // Best single lock-in in the last 24 hours, by % gain on what was invested.
  const { rows: day24 } = await query(
    `SELECT u.username, p.symbol, p.invested::float8 AS invested, p.proceeds::float8 AS proceeds,
            ((p.proceeds - p.invested) / p.invested)::float8 AS gain_pct, p.tier, p.closed_at
       FROM positions p JOIN users u ON u.id = p.user_id
      WHERE p.status IN ('closed', 'rolled') AND p.closed_at > now() - interval '24 hours' AND p.invested > 0 AND ${scope}
      ORDER BY gain_pct DESC LIMIT 25`,
  );
  // Biggest positions held right now, by what they're worth. Priced from
  // quotes the game already has (this process's last good quote, else the
  // price log), never a fresh provider call per board view.
  const { rows: open } = await query(
    `SELECT p.*, u.username FROM positions p JOIN users u ON u.id = p.user_id
      WHERE p.status = 'open' AND ${scope}
      ORDER BY COALESCE(p.matured_value, p.invested) DESC LIMIT 400`,
  );
  const live = open.filter((p) => !p.matured_at);
  const logged = await pricelog.latest(live.filter((p) => !prices.peek(p.symbol)).map((p) => p.symbol));
  const biggest = open.map((p) => {
    const q = p.matured_at ? null : (prices.peek(p.symbol) || logged[p.symbol] || null);
    const sp = shapePosition(p, q);
    return {
      username: p.username, symbol: p.symbol, name: p.name, asset_type: p.asset_type,
      invested: sp.invested, value: sp.value != null ? sp.value : sp.invested, swing_pct: sp.swing_pct,
      multiplier_now: sp.multiplier_now, matured: sp.matured, busted: !!sp.busted, ride_count: sp.ride_count, priced: sp.value != null,
    };
  }).sort((a, b) => b.value - a.value || b.invested - a.invested).slice(0, 25);
  res.json({ quarter: day.quarter, quarter_ends_at: day.quarter_ends_at, friends_only: !!friendsOnly, all_time: allTime, last_24h: day24, biggest });
}));

// --- Friends --------------------------------------------------------------------
//
// One-directional: adding someone puts them on your friends board and lets
// them write on your wall. They're told ("erin added you", with an Add back
// button) until they add you back or wave it off; they don't see you on their
// board unless they add you back. Everything shown is already public on the
// leaderboards or is play-money game state; never email, never anything from
// Account. Removing someone is silent.

const MAX_FRIENDS = 50;

// How a player's trading has gone: profit from positions only, by the day
// it was realized, as a running total. Achievement gifts (and the old vest)
// aren't trading, and TrickleTown spending never touches positions, so
// neither moves the line. A ride counts when it rolls (its profit is
// realized then) and again when the ride closes, on its own stake; summed,
// that's the whole chain's gain before tax. Open positions are added at
// the end as "now", at today's value.
async function performanceFor(userId, openShaped, day) {
  const { rows } = await query(
    `SELECT closed_day AS d, SUM(profit)::float8 AS pnl, COUNT(*)::int AS n,
            COUNT(*) FILTER (WHERE profit > 0)::int AS wins
       FROM positions
      WHERE user_id = $1 AND status IN ('closed', 'rolled') AND closed_day IS NOT NULL
      GROUP BY closed_day ORDER BY closed_day`,
    [userId],
  );
  const { rows: [first] } = await query(
    "SELECT MIN(opened_day) AS d FROM positions WHERE user_id = $1 AND status NOT IN ('vested', 'gift')", [userId],
  );
  const { rows: extremes } = await query(
    `(SELECT 'best' AS k, symbol, profit::float8 AS profit, invested::float8 AS invested, closed_day AS d, tier FROM positions
       WHERE user_id = $1 AND status IN ('closed', 'rolled') AND profit > 0 ORDER BY profit DESC LIMIT 1)
     UNION ALL
     (SELECT 'worst', symbol, profit::float8, invested::float8, closed_day, tier FROM positions
       WHERE user_id = $1 AND status IN ('closed', 'rolled') AND profit < 0 ORDER BY profit ASC LIMIT 1)`,
    [userId],
  );
  const byDay = new Map(rows.map((r) => [r.d, r]));
  const series = [];
  let total = 0, closed = 0, wins = 0;
  if (first && first.d) {
    // One point per day from the first buy to today, so a quiet stretch reads
    // as flat rather than vanishing. Capped at a year.
    let d = game.addDays(first.d, -1);
    const start = game.addDays(day.key, -365);
    if (d < start) d = start;
    for (const r of rows) if (r.d <= d) { total += r.pnl; closed += r.n; wins += r.wins; }
    series.push({ d, v: game.round2(total) });
    while (d < day.key) {
      d = game.addDays(d, 1);
      const r = byDay.get(d);
      if (r) { total += r.pnl; closed += r.n; wins += r.wins; }
      series.push({ d, v: game.round2(total) });
    }
  }
  const openPnl = game.round2(openShaped.reduce((sum, p) => sum + (p.quote_error || p.value == null ? 0 : p.value - p.invested), 0));
  const pick = (k) => { const r = extremes.find((x) => x.k === k); return r ? { symbol: r.symbol, profit: game.round2(r.profit), pct: r.invested > 0 ? r.profit / r.invested : null, day: r.d, tier: r.tier } : null; };
  return {
    series,
    realized: game.round2(total),
    open_pnl: openPnl,
    total: game.round2(total + openPnl),
    closed,
    wins,
    best: pick('best'),
    worst: pick('worst'),
    since: first && first.d ? first.d : null,
  };
}

// The wall: readable and writable by the owner and by anyone the owner has
// added. Adding someone is the owner's say-so, so a stranger can't post.
async function wallAccess(viewer, owner) {
  if (!viewer) return false;
  if (viewer.id === owner.id) return true;
  const { rows } = await query('SELECT 1 FROM friends WHERE user_id = $1 AND friend_id = $2', [owner.id, viewer.id]);
  return rows.length > 0;
}

const WALL_MAX = 280;
const PROFILE_POSITIONS = 60;
async function wallPosts(owner, viewer) {
  const { rows } = await query(
    `SELECT w.id, w.body, w.created_at, a.username AS author, w.author_id
       FROM wall_posts w JOIN users a ON a.id = w.author_id
      WHERE w.owner_id = $1 ORDER BY w.created_at DESC, w.id DESC LIMIT 40`,
    [owner.id],
  );
  return rows.map((r) => ({
    id: r.id, body: r.body, at: r.created_at, author: r.author,
    mine: !!viewer && r.author_id === viewer.id,
    can_delete: !!viewer && (r.author_id === viewer.id || owner.id === viewer.id),
  }));
}

// New posts by other people since you last opened your profile: how many,
// who (latest first, up to three names) and the newest post's id, so the
// page can tell "something new" from "the same thing again".
// People who added you and you haven't added back. `since`: only those who
// did it after you last dismissed the notice (null = all of them).
async function addedYou(userId, since = null, limit = 6) {
  const { rows } = await query(
    `SELECT u.username, f.created_at AS at FROM friends f JOIN users u ON u.id = f.user_id
      WHERE f.friend_id = $1
        AND NOT EXISTS (SELECT 1 FROM friends b WHERE b.user_id = $1 AND b.friend_id = f.user_id)
        AND f.created_at > COALESCE($2, '-infinity'::timestamptz)
      ORDER BY f.created_at DESC LIMIT $3`,
    [userId, since, limit],
  );
  return rows.map((r) => ({ username: r.username, at: r.at }));
}

async function wallUnread(user) {
  const { rows } = await query(
    `SELECT w.id, a.username FROM wall_posts w JOIN users a ON a.id = w.author_id
      WHERE w.owner_id = $1 AND w.author_id <> $1 AND w.created_at > COALESCE($2, '-infinity'::timestamptz)
      ORDER BY w.created_at DESC, w.id DESC LIMIT 50`,
    [user.id, user.wall_seen_at || null],
  );
  return { n: rows.length, from: [...new Set(rows.map((r) => r.username))].slice(0, 3), latest: rows.length ? rows[0].id : null };
}

// Plain text only: no control characters, at most two newlines in a row,
// trimmed. Rendered escaped by the client; never as HTML.
function cleanWallBody(raw) {
  return String(raw == null ? '' : raw)
    .normalize('NFC')
    .replace(/\r\n?|[\u2028\u2029\u0085]/g, '\n')
    .replace(/(?!\n|\u200D)[\p{Cc}\p{Cf}]/gu, '') // controls, bidi, zero-width; keep newlines and the emoji joiner
    .replace(/[\u115F\u1160\u3164\uFFA0\u2800]/g, '') // blank-looking "letters"
    .replace(/(\p{M}{2})\p{M}+/gu, '$1') // no towers of combining marks
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function playerProfile(viewer, u, day) {
  const { rows: open } = await query(
    `SELECT * FROM positions WHERE user_id = $1 AND status = 'open'
      ORDER BY COALESCE(matured_value, invested) DESC, opened_at ASC LIMIT ${PROFILE_POSITIONS}`, [u.id],
  );
  const { rows: [openCount] } = await query("SELECT COUNT(*)::int AS n FROM positions WHERE user_id = $1 AND status = 'open'", [u.id]);
  await maturer.settleMatured(open).catch(() => {});
  const live = open.filter((p) => !p.matured_at);
  const quotes = await prices.getQuotes(live.map((p) => assets.find(p.symbol)).filter(Boolean));
  const own = !!viewer && viewer.id === u.id;
  // Someone else sees "matures in about 5h", not the minute you bought.
  const positions = open.map((p) => shapePosition(p, quotes[p.symbol])).map((p) => ({
    id: p.id, symbol: p.symbol, name: p.name, invested: p.invested, value: p.value, swing_pct: p.swing_pct,
    multiplier_now: p.multiplier_now, multiplier: p.multiplier, matured: p.matured, busted: p.busted, quote_error: p.quote_error,
    ride_count: p.ride_count,
    ...(own ? { matures_at: p.matures_at } : { hours_left: p.matured ? 0 : Math.max(1, Math.round((new Date(p.matures_at) - Date.now()) / 3600e3)) }),
  }));
  const { rows: [q] } = await query(
    'SELECT COALESCE(SUM(amount), 0)::float8 AS n FROM donations WHERE user_id = $1 AND quarter = $2', [u.id, day.quarter],
  );
  const split = (await charitySplit(u.id, day.quarter)).filter((c) => c.amount > 0).map((c) => ({ name: c.name, slug: c.slug, amount: c.amount }));
  const unlocked = Town.isUnlocked(u.total_donated);
  if (u.town) Town.migrate(u.town);
  const town = u.town && unlocked ? Town.view(u.town, townCtx(u, { day: day.key })) : null;
  const { rows: earned } = await query('SELECT key, earned_at FROM achievements WHERE user_id = $1 ORDER BY earned_at', [u.id]);
  const isFriend = viewer ? (await query('SELECT 1 FROM friends WHERE user_id = $1 AND friend_id = $2', [viewer.id, u.id])).rows.length > 0 : false;
  const addedYou = viewer ? (await query('SELECT 1 FROM friends WHERE user_id = $1 AND friend_id = $2', [u.id, viewer.id])).rows.length > 0 : false;
  const isYou = !!viewer && viewer.id === u.id;
  const wallOk = await wallAccess(viewer, u);
  const performance = await performanceFor(u.id, positions, day);
  return {
    username: u.username,
    is_guest: u.is_guest,
    joined: u.created_at ? new Date(u.created_at).toISOString().slice(0, 7) : null, // the month, not the moment
    streak: u.streak,
    total_donated: u.total_donated,
    quarter_donated: game.round2(Math.max(0, q.n)),
    lobbyists_by_charity: split,
    badges: game.badgesFor(u.total_donated),
    cash: u.cash,
    in_play: game.round2(u.cash + positions.reduce((s, p) => s + (p.quote_error ? p.invested : p.value), 0)),
    positions,
    positions_total: openCount.n,
    performance,
    top_charity: split.length ? split[0].name : null,
    achievements: {
      earned: earned.map((r) => { const a = achievements.BY_KEY.get(r.key); return a ? { key: a.key, title: a.title, how: a.how, day: game.dayKey(new Date(r.earned_at)) } : null; }).filter(Boolean),
      total: achievements.LIST.length,
    },
    last_seen: lastSeen(u.last_seen_at),
    town: town ? {
      happiness: town.happiness, income: town.income, hire_cost: town.hire_cost, motto: town.motto,
      sides: { preston: u.town.sides.preston || 0, dolores: u.town.sides.dolores || 0 },
      pet: town.cat && town.cat.name ? { name: town.cat.name, pronoun: town.cat.pronoun, coat: town.cat.coat, wearing: town.cat.wearing, owned: town.cat.owned.length, spent: town.cat.spent } : null,
      buildings: town.plots.map((p) => (p.building
        ? { slot: p.slot, label: p.label, key: p.key, name: p.building.name, tier: p.building.tier, days: p.days, upgrades: p.building.upgrades.filter((x) => x.owned).map((x) => ({ name: x.name, tier: x.tier })) }
        : { slot: p.slot, label: p.label, key: null })),
    } : null,
    is_friend: isFriend,
    added_you: addedYou,
    is_you: isYou,
    wall: wallOk ? { open: true, max: WALL_MAX, posts: await wallPosts(u, viewer) } : { open: false },
  };
}

// "today" / "this week" / "this month" / "a while ago": enough to know a
// friend is still playing, not enough to know when they're at their desk.
function lastSeen(at) {
  const days = (Date.now() - new Date(at).getTime()) / 86400e3;
  return days < 1 ? 'today' : days < 7 ? 'this week' : days < 30 ? 'this month' : 'a while ago';
}

async function findPlayer(username) {
  const { rows } = await query('SELECT * FROM users WHERE lower(username) = lower($1)', [String(username || '')]);
  return rows[0] || null;
}

router.get('/friends', auth.requireUser, wrap(async (req, res) => {
  const day = dayInfo();
  const { rows } = await query(
    `SELECT u.*, COALESCE(q.total, 0)::float8 AS quarter_total
       FROM friends f JOIN users u ON u.id = f.friend_id
       LEFT JOIN (SELECT user_id, SUM(amount) AS total FROM donations WHERE quarter = $2 GROUP BY user_id) q ON q.user_id = u.id
      WHERE f.user_id = $1 ORDER BY quarter_total DESC, u.username`,
    [req.user.id, day.quarter],
  );
  const { rows: [followers] } = await query('SELECT COUNT(*)::int AS n FROM friends WHERE friend_id = $1', [req.user.id]);
  const friends = rows.map((u) => ({
    username: u.username, streak: u.streak, total_donated: u.total_donated, quarter_donated: game.round2(Math.max(0, u.quarter_total)),
    badges: game.badgesFor(u.total_donated), cash: u.cash, last_seen: lastSeen(u.last_seen_at),
    town: u.town && Town.isUnlocked(u.total_donated) ? { happiness: u.town.happiness, motto: Town.view(u.town, townCtx(u, { day: day.key })).motto } : null,
  }));
  res.json({ friends, added_you: followers.n, waiting: await addedYou(req.user.id, null, 50), max: MAX_FRIENDS, your_username: req.user.username, is_guest: req.user.is_guest });
}));

router.post('/friends/add', auth.requireUser, RL.social, wrap(async (req, res) => {
  const target = await findPlayer((req.body || {}).username);
  if (!target) return res.status(404).json({ error: 'No player by that name. Usernames are case-insensitive; check the spelling.' });
  if (target.id === req.user.id) return res.status(400).json({ error: "That's you. You're already on your own side." });
  const n = await friendCount(req.user.id);
  if (n >= MAX_FRIENDS) return res.status(400).json({ error: `That's ${MAX_FRIENDS} friends. Preston says that's plenty.` });
  await query('INSERT INTO friends (user_id, friend_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [req.user.id, target.id]);
  res.json({ ok: true, username: target.username, friend_count: await friendCount(req.user.id) });
}));

// "Not now" on the added-you notice: stop showing the ones there are now.
router.post('/friends/seen', auth.requireUser, wrap(async (req, res) => {
  await query('UPDATE users SET followers_seen_at = now() WHERE id = $1', [req.user.id]);
  res.json({ ok: true });
}));

router.post('/friends/remove', auth.requireUser, wrap(async (req, res) => {
  const target = await findPlayer((req.body || {}).username);
  if (target) await query('DELETE FROM friends WHERE user_id = $1 AND friend_id = $2', [req.user.id, target.id]);
  res.json({ ok: true, friend_count: await friendCount(req.user.id) });
}));

// A player's profile: their trading, their coin, their town, their standing.
// Public, like the boards it's linked from; the wall alone is friends-only.
router.get('/players/:username', optionalUser, RL.read, wrap(async (req, res) => {
  const u = await findPlayer(req.params.username);
  if (!u) return res.status(404).json({ error: 'No player by that name.' });
  const player = await playerProfile(req.user || null, u, dayInfo());
  // Looking at your own profile catches you up on your wall.
  if (player.is_you) await query('UPDATE users SET wall_seen_at = now() WHERE id = $1', [u.id]);
  res.json({ player });
}));

router.get('/players/:username/wall', auth.requireUser, RL.read, wrap(async (req, res) => {
  const owner = await findPlayer(req.params.username);
  if (!owner) return res.status(404).json({ error: 'No player by that name.' });
  if (!(await wallAccess(req.user, owner))) return res.status(403).json({ error: `Only people ${owner.username} has added can see this wall.` });
  res.json({ posts: await wallPosts(owner, req.user), max: WALL_MAX });
}));

router.post('/players/:username/wall', auth.requireUser, RL.wall, wrap(async (req, res) => {
  const owner = await findPlayer(req.params.username);
  if (!owner) return res.status(404).json({ error: 'No player by that name.' });
  if (!(await wallAccess(req.user, owner))) return res.status(403).json({ error: `Only people ${owner.username} has added can write here.` });
  const body = cleanWallBody((req.body || {}).body);
  if (!body) return res.status(400).json({ error: 'Write something first.' });
  if ([...body].length > WALL_MAX) return res.status(400).json({ error: `Keep it to ${WALL_MAX} characters.` });
  // A wall holds the latest 200; older posts fall off.
  await withTx(async (tx) => {
    await tx.query('INSERT INTO wall_posts (owner_id, author_id, body) VALUES ($1, $2, $3)', [owner.id, req.user.id, body]);
    await tx.query(
      `DELETE FROM wall_posts WHERE owner_id = $1 AND id NOT IN
         (SELECT id FROM wall_posts WHERE owner_id = $1 ORDER BY created_at DESC, id DESC LIMIT 200)`,
      [owner.id],
    );
  });
  if (owner.id === req.user.id) await query('UPDATE users SET wall_seen_at = now() WHERE id = $1', [owner.id]);
  res.json({ ok: true, posts: await wallPosts(owner, req.user) });
}));

// The owner can delete anything on their wall; an author, their own post.
router.post('/wall/:id/delete', auth.requireUser, RL.wall, wrap(async (req, res) => {
  const id = intId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Which post?' });
  const { rows: [w] } = await query('SELECT * FROM wall_posts WHERE id = $1', [id]);
  if (!w || (w.owner_id !== req.user.id && w.author_id !== req.user.id)) return res.status(404).json({ error: 'No such post.' });
  await query('DELETE FROM wall_posts WHERE id = $1', [id]);
  const { rows: [owner] } = await query('SELECT * FROM users WHERE id = $1', [w.owner_id]);
  // An author who's since been unfriended can still delete their own post,
  // but doesn't get to read the wall in return.
  res.json({ ok: true, posts: owner && (await wallAccess(req.user, owner)) ? await wallPosts(owner, req.user) : [] });
}));


module.exports = router;
