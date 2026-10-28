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
  social: limit({ name: 'social', max: 30, windowMs: 15 * 60e3, message: 'That is a lot of friends in a short time. Try again in 15 minutes.' }),
};

// What the town rules need to know about the player.
const townCtx = (u, extra = {}) => ({ uid: u.id, cash: u.cash, lobbyists: u.total_donated, streak: u.streak, friends: u.friend_count || 0, unlocked: Town.isUnlocked(u.total_donated), ...extra });

async function friendCount(userId) {
  const { rows: [r] } = await query('SELECT COUNT(*)::int AS n FROM friends WHERE user_id = $1', [userId]);
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
  };
}

// The charity for a tax: what the client asked for, else the one the player
// has hired the most for, then their last pick, then the first on the list.
// Never refuses to close a position over a missing pick.
async function pickCharity(user, charityId) {
  const { rows } = await query(
    `SELECT c.* FROM charities c
      LEFT JOIN (SELECT charity_id, SUM(amount) AS total FROM donations WHERE user_id = $2 GROUP BY charity_id) d ON d.charity_id = c.id
     WHERE c.active
     ORDER BY (c.id = $1) DESC, (c.id = $3) DESC, d.total DESC NULLS LAST, c.sort
     LIMIT 1`,
    [Number.isInteger(charityId) ? charityId : -1, user.id, user.charity_id || -1],
  );
  return rows[0] || null;
}

// Unhealthy lobbyists quit overnight. They leave this quarter's payroll in
// proportion to where they were hired, recorded as negative donations so
// every total stays a plain SUM. Returns how many quit.
async function applyQuitting(user, quarter, rate, db = { query }) {
  const { rows } = await db.query(
    `SELECT charity_id, SUM(amount)::float8 AS n FROM donations
      WHERE user_id = $1 AND quarter = $2 GROUP BY charity_id HAVING SUM(amount) > 0`,
    [user.id, quarter],
  );
  let quit = 0;
  for (const r of rows) {
    const lost = game.round2(r.n * rate);
    if (lost <= 0) continue;
    await db.query('INSERT INTO donations (user_id, charity_id, amount, quarter) VALUES ($1, $2, $3, $4)', [user.id, r.charity_id, -lost, quarter]);
    quit = game.round2(quit + lost);
  }
  // Career totals (users.total_donated, ranks) keep counting everyone you ever hired.
  return quit;
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

router.get('/health', (req, res) => res.json({ ok: true, provider: cfg.priceProvider, google: google.enabled(), demo: cfg.demoMode }));

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

router.get('/assets', (req, res) => {
  res.json({ assets: assets.ASSETS.map(({ cg, ...a }) => a) });
});

router.get('/quote/:symbol', RL.read, wrap(async (req, res) => {
  const asset = assets.find(req.params.symbol);
  if (!asset) return res.status(404).json({ error: 'Not in the game. Pick something from the list.' });
  try {
    const q = await prices.getQuote(asset);
    res.json({ symbol: asset.symbol, ...q });
  } catch (e) {
    res.status(503).json({ error: `Couldn't get a price for ${asset.symbol} right now. Try again in a minute.` });
  }
}));

router.get('/charities', wrap(async (req, res) => {
  const { rows } = await query('SELECT id, slug, name, blurb, url, category FROM charities WHERE active ORDER BY sort, name');
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
  if (await usernameTaken(username)) return res.status(409).json({ error: 'That username is taken.' });
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
  if (await usernameTaken(username, req.user.id)) return res.status(409).json({ error: 'That username is taken.' });
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
  if (await usernameTaken(username, req.user.id)) return res.status(409).json({ error: 'That username is taken.' });
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

// Grant yourself (or a named player) cash and/or lobbyists. Lobbyists are a
// real donation row so the boards and the town see them.
router.post('/admin/grant', auth.requireUser, requireAdmin, RL.sensitive, wrap(async (req, res) => {
  const body = req.body || {};
  const cash = Math.max(0, Math.min(100000, Number(body.cash) || 0));
  const lobbyists = Math.max(0, Math.min(100000, Number(body.lobbyists) || 0));
  const target = body.username ? await findPlayer(body.username) : req.user;
  if (!target) return res.status(404).json({ error: 'No player by that name.' });
  if (!cash && !lobbyists) return res.status(400).json({ error: 'Grant something: cash, lobbyists, or both.' });
  const day = dayInfo();
  const user = await withTx(async (tx) => {
    let charity = null;
    if (lobbyists) {
      charity = await pickCharity(target, Number(body.charity_id));
      if (!charity) throw new Error('No charities are set up yet.');
      await tx.query('INSERT INTO donations (user_id, charity_id, amount, quarter) VALUES ($1, $2, $3, $4)', [target.id, charity.id, lobbyists, day.quarter]);
    }
    const { rows: [u] } = await tx.query(
      'UPDATE users SET cash = cash + $1, total_donated = total_donated + $2, charity_id = COALESCE($3, charity_id) WHERE id = $4 RETURNING *',
      [cash, lobbyists, charity ? charity.id : null, target.id],
    );
    return u;
  });
  console.log(`[admin] ${req.user.username} granted ${target.username}: $${cash}, ${lobbyists} lobbyists`);
  res.json({ ok: true, user: publicUser(user), town: townView(user) });
}));

// Start over: no positions, no lobbyists, no town, $100 at the next /me.
router.post('/admin/reset', auth.requireUser, requireAdmin, RL.sensitive, wrap(async (req, res) => {
  const target = (req.body || {}).username ? await findPlayer(req.body.username) : req.user;
  if (!target) return res.status(404).json({ error: 'No player by that name.' });
  await withTx(async (tx) => {
    await tx.query('DELETE FROM donations WHERE user_id = $1', [target.id]);
    await tx.query('DELETE FROM positions WHERE user_id = $1', [target.id]);
    await tx.query(
      `UPDATE users SET cash = 0, total_donated = 0, realized_pnl = 0, streak = 0, last_allowance_day = NULL, town = NULL, charity_id = NULL WHERE id = $1`,
      [target.id],
    );
  });
  console.log(`[admin] ${req.user.username} reset ${target.username}`);
  res.json({ ok: true });
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
      if (report.quit_rate > 0) report.quit = await applyQuitting(u, day.quarter, report.quit_rate, tx);
      const { rows: [updated] } = await tx.query(
        `UPDATE users SET cash = cash + $1, streak = $2, last_allowance_day = $3, last_seen_at = now(), town = $5
          WHERE id = $4 RETURNING *`,
        [amount, streak, day.key, u.id, { ...town, report }],
      );
      updated.friend_count = fc;
      return { user: updated, allowance: { amount, streak, base, town_income: report.income } };
    });
    user = granted.user;
    allowance = granted.allowance;
  } else {
    await query('UPDATE users SET last_seen_at = now() WHERE id = $1', [user.id]);
  }

  // Unlocked mid-day (first full lobbyist just hired)? Deal today's issues now.
  if (user.town && Town.ensureIssues(user.town, townCtx(user, { day: day.key }))) {
    await query('UPDATE users SET town = $1 WHERE id = $2', [user.town, user.id]);
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
            (p.matured_at IS NOT NULL) AS collected, (p.status = 'rolled') AS rode, c.name AS charity_name,
            (SELECT SUM(d.amount) FROM donations d WHERE d.position_id = p.id)::float8 AS lobbyists
       FROM positions p LEFT JOIN charities c ON c.id = p.charity_id
      WHERE p.user_id = $1 AND p.status IN ('closed', 'rolled')
      ORDER BY p.closed_at DESC LIMIT 12`,
    [user.id],
  );

  const { rows: crowd } = await query(
    `SELECT symbol, name, COUNT(*)::int AS buys, SUM(invested)::float8 AS invested
       FROM positions WHERE opened_day = $1 AND rolled_from IS NULL
      GROUP BY symbol, name ORDER BY buys DESC, invested DESC LIMIT 5`,
    [day.key],
  );
  const { rows: [crowdTotal] } = await query(
    'SELECT COUNT(*)::int AS buys, COUNT(DISTINCT user_id)::int AS players FROM positions WHERE opened_day = $1 AND rolled_from IS NULL',
    [day.key],
  );

  // What your friends bought today, for the crowd line.
  const { rows: friendsToday } = await query(
    `SELECT u.username, array_agg(DISTINCT p.symbol ORDER BY p.symbol) AS symbols
       FROM friends f JOIN users u ON u.id = f.friend_id
       JOIN positions p ON p.user_id = u.id AND p.opened_day = $2 AND p.rolled_from IS NULL
      WHERE f.user_id = $1 GROUP BY u.username ORDER BY u.username LIMIT 8`,
    [user.id, day.key],
  );

  const { rows: [todayGiven] } = await query(
    `SELECT COALESCE(SUM(d.amount), 0)::float8 AS amount FROM donations d
       JOIN positions p ON p.id = d.position_id
      WHERE d.user_id = $1 AND p.closed_day = $2`,
    [user.id, day.key],
  );

  // The back of the coin: this quarter's lobbyists by charity (the ones headed
  // to Lobbyfest), plus the all-time picture for prefills and context.
  const { rows: byCharity } = await query(
    `SELECT c.id, c.name, c.slug,
            COALESCE(SUM(d.amount) FILTER (WHERE d.quarter = $2), 0)::float8 AS amount,
            COUNT(*) FILTER (WHERE d.quarter = $2 AND d.amount > 0)::int AS times,
            SUM(d.amount)::float8 AS all_time
       FROM donations d JOIN charities c ON c.id = d.charity_id
      WHERE d.user_id = $1 GROUP BY c.id ORDER BY amount DESC, all_time DESC`,
    [user.id, day.quarter],
  );
  const quarterDonated = byCharity.reduce((s, c) => s + c.amount, 0);

  res.json({
    user: { ...publicUser(user), quarter_donated: game.round2(quarterDonated) },
    day,
    allowance,
    rules: { tax_rate: cfg.taxRate, ride_tax_factor: cfg.rideTaxFactor, ride_max_steps: cfg.rideMaxSteps, daily_base: cfg.dailyBase, streak_bonus: cfg.streakBonus, daily_cap: cfg.dailyCap, hold_hours: cfg.holdHours, mult_floor: cfg.multFloor, demo: cfg.demoMode },
    positions,
    history,
    town: townView(user),
    donations_by_charity: byCharity,
    crowd: { picks: crowd, ...crowdTotal, friends: friendsToday.map((r) => ({ username: r.username, symbols: Array.isArray(r.symbols) ? r.symbols : String(r.symbols).replace(/[{}"]/g, '').split(',').filter(Boolean) })) },
    friend_count: user.friend_count,
    today_donated: todayGiven.amount,
    token: renewedToken,
  });
}));

router.post('/buy', auth.requireUser, RL.trade, wrap(async (req, res) => {
  const asset = assets.find((req.body || {}).symbol);
  const amount = game.round2(Number((req.body || {}).amount));
  if (!asset) return res.status(400).json({ error: 'Pick something from the list.' });
  if (!(amount >= 0.01)) return res.status(400).json({ error: 'Invest at least a penny.' });

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
  const positionId = Number((req.body || {}).position_id);
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
    await tx.query(
      `UPDATE positions SET status = 'rolled', closed_at = $1, closed_day = $2, exit_price = $3,
              proceeds = $4, profit = $5, tax = $6, charity_id = $7, tier = $8 WHERE id = $9`,
      [now, day, p.matured_price, p.matured_value, s.profit, s.tax, charity ? charity.id : null, s.tier, p.id],
    );
    const { rows: [u] } = await tx.query(
      `UPDATE users SET total_donated = total_donated + $1, realized_pnl = realized_pnl + $2, charity_id = COALESCE($3, charity_id)
       WHERE id = $4 RETURNING *`,
      [lobbyists, s.profit, charity ? charity.id : null, p.user_id],
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

router.post('/sell', auth.requireUser, RL.trade, wrap(async (req, res) => {
  const positionId = Number((req.body || {}).position_id);
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

    await tx.query(
      `UPDATE positions SET status = 'closed', closed_at = $1, closed_day = $2, exit_price = $3,
              proceeds = $4, profit = $5, tax = $6, charity_id = $7, tier = $8 WHERE id = $9`,
      [now, day, exitPrice, live.value, s.profit, s.tax, charity ? charity.id : null, s.tier, p.id],
    );
    const { rows: [u] } = await tx.query(
      `UPDATE users SET cash = cash + $1, total_donated = total_donated + $2, realized_pnl = realized_pnl + $3,
              charity_id = COALESCE($4, charity_id)
       WHERE id = $5 RETURNING *`,
      [s.net, lobbyists, s.profit, charity ? charity.id : null, p.user_id],
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
    const { rows: [u2] } = await tx.query(
      'UPDATE users SET cash = cash + $1, town = $2 WHERE id = $3 RETURNING *', [r.cash, town, u.id],
    );
    return { user: u2 };
  });
  if (result.error) return res.status(400).json({ error: result.error });
  result.user.friend_count = await friendCount(result.user.id);
  res.json({ ok: true, user: publicUser(result.user), town: townView(result.user) });
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
    const { rows: [u2] } = await tx.query(
      'UPDATE users SET cash = cash + $1, town = $2 WHERE id = $3 RETURNING *', [r.cash, town, u.id],
    );
    return { user: u2 };
  });
  if (result.error) return res.status(400).json({ error: result.error });
  result.user.friend_count = await friendCount(result.user.id);
  res.json({ ok: true, user: publicUser(result.user), town: townView(result.user) });
}));

// --- Public boards ---------------------------------------------------------------

// Where the trickle is going: per-charity shares for the quarter plus all time.
router.get('/trickle', wrap(async (req, res) => {
  const day = dayInfo();
  const { rows } = await query(
    `SELECT c.id, c.slug, c.name, c.blurb, c.url, c.category,
            COALESCE(SUM(d.amount) FILTER (WHERE d.quarter = $1), 0)::float8 AS quarter_total,
            COALESCE(SUM(d.amount), 0)::float8 AS all_time,
            COUNT(DISTINCT d.user_id) FILTER (WHERE d.quarter = $1)::int AS quarter_donors
       FROM charities c LEFT JOIN donations d ON d.charity_id = c.id
      WHERE c.active
      GROUP BY c.id ORDER BY quarter_total DESC, all_time DESC, c.sort`,
    [day.quarter],
  );
  const quarterTotal = rows.reduce((s, r) => s + r.quarter_total, 0);
  const allTime = rows.reduce((s, r) => s + r.all_time, 0);
  const { rows: [players] } = await query(
    'SELECT COUNT(DISTINCT user_id)::int AS donors FROM donations WHERE quarter = $1', [day.quarter],
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
  res.json({ quarter: day.quarter, quarter_ends_at: day.quarter_ends_at, friends_only: !!friendsOnly, all_time: allTime, last_24h: day24 });
}));

// --- Friends --------------------------------------------------------------------
//
// One-directional: adding someone lets you see their coin and town and puts
// them on your friends board. They aren't told, and they don't see you unless
// they add you back. Everything shown is already public on the leaderboards or
// is play-money game state; never email, never anything from Account.

const MAX_FRIENDS = 50;

async function playerProfile(viewer, u, day) {
  const { rows: open } = await query(
    "SELECT * FROM positions WHERE user_id = $1 AND status = 'open' ORDER BY opened_at ASC", [u.id],
  );
  await maturer.settleMatured(open).catch(() => {});
  const live = open.filter((p) => !p.matured_at);
  const quotes = await prices.getQuotes(live.map((p) => assets.find(p.symbol)).filter(Boolean));
  const positions = open.map((p) => shapePosition(p, quotes[p.symbol])).map((p) => ({
    id: p.id, symbol: p.symbol, name: p.name, invested: p.invested, value: p.value, swing_pct: p.swing_pct,
    multiplier_now: p.multiplier_now, matured: p.matured, busted: p.busted, quote_error: p.quote_error, ride_count: p.ride_count,
  }));
  const { rows: [q] } = await query(
    'SELECT COALESCE(SUM(amount), 0)::float8 AS n FROM donations WHERE user_id = $1 AND quarter = $2', [u.id, day.quarter],
  );
  const { rows: [top] } = await query(
    `SELECT c.name, SUM(d.amount)::float8 AS n FROM donations d JOIN charities c ON c.id = d.charity_id
      WHERE d.user_id = $1 AND d.quarter = $2 GROUP BY c.name HAVING SUM(d.amount) > 0 ORDER BY n DESC LIMIT 1`, [u.id, day.quarter],
  );
  const unlocked = Town.isUnlocked(u.total_donated);
  const town = u.town && unlocked ? Town.view(u.town, townCtx(u, { day: day.key })) : null;
  const isFriend = viewer ? (await query('SELECT 1 FROM friends WHERE user_id = $1 AND friend_id = $2', [viewer.id, u.id])).rows.length > 0 : false;
  const addedYou = viewer ? (await query('SELECT 1 FROM friends WHERE user_id = $1 AND friend_id = $2', [u.id, viewer.id])).rows.length > 0 : false;
  return {
    username: u.username,
    is_guest: u.is_guest,
    streak: u.streak,
    total_donated: u.total_donated,
    quarter_donated: game.round2(Math.max(0, q.n)),
    badges: game.badgesFor(u.total_donated),
    cash: u.cash,
    in_play: game.round2(u.cash + positions.reduce((s, p) => s + (p.quote_error ? p.invested : p.value), 0)),
    positions,
    top_charity: top ? top.name : null,
    last_seen: lastSeen(u.last_seen_at),
    town: town ? {
      happiness: town.happiness, health: town.health, income: town.income, motto: town.motto,
      buildings: town.plots.map((p) => (p.building ? { slot: p.slot, key: p.key, name: p.building.name, tier: p.building.tier } : { slot: p.slot, key: null })),
    } : null,
    is_friend: isFriend,
    added_you: addedYou,
    is_you: !!viewer && viewer.id === u.id,
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
    town: u.town && Town.isUnlocked(u.total_donated) ? { happiness: u.town.happiness, health: u.town.health, motto: Town.view(u.town, townCtx(u, { day: day.key })).motto } : null,
  }));
  res.json({ friends, added_you: followers.n, max: MAX_FRIENDS, your_username: req.user.username, is_guest: req.user.is_guest });
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

router.post('/friends/remove', auth.requireUser, wrap(async (req, res) => {
  const target = await findPlayer((req.body || {}).username);
  if (target) await query('DELETE FROM friends WHERE user_id = $1 AND friend_id = $2', [req.user.id, target.id]);
  res.json({ ok: true, friend_count: await friendCount(req.user.id) });
}));

// A player's public page: their coin, their town, their standing.
router.get('/players/:username', optionalUser, RL.read, wrap(async (req, res) => {
  const u = await findPlayer(req.params.username);
  if (!u) return res.status(404).json({ error: 'No player by that name.' });
  res.json({ player: await playerProfile(req.user || null, u, dayInfo()) });
}));


module.exports = router;
