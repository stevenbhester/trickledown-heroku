const express = require('express');
const cfg = require('./config');
const { query, withTx } = require('./db');
const game = require('./game');
const prices = require('./prices');
const assets = require('./assets');
const auth = require('./auth');
const maturer = require('./maturer');

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
  };
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
    invested: p.invested,
    entry_price: p.entry_price,
    opened_at: p.opened_at,
    opened_day: p.opened_day,
    matures_at: p.matures_at,
    matured,
    matured_at: p.matured_at || null,
    ride_count: p.ride_count || 0,
    origin_invested: p.origin_invested != null ? p.origin_invested : p.invested,
    seconds_left: matured ? 0 : Math.max(0, Math.round((new Date(p.matures_at) - now) / 1000)),
    price,
    quote_error: price == null,
    ...(live || { value: null, real_pct: null, swing_pct: null, busted: false }),
    preview: live ? game.settle({ invested: p.invested, value: live.value }) : null,
  };
}

function dayInfo(now = new Date()) {
  const key = game.dayKey(now);
  return {
    key,
    number: game.dayNumber(key),
    quarter: game.quarterKey(key),
    resets_at: game.nextReset(now).toISOString(),
    tz: cfg.gameTz,
  };
}

// --- Meta ----------------------------------------------------------------------

router.get('/health', (req, res) => res.json({ ok: true, provider: cfg.priceProvider }));

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

router.get('/quote/:symbol', wrap(async (req, res) => {
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

router.post('/auth/guest', wrap(async (req, res) => {
  for (let attempt = 0; attempt < 5; attempt++) {
    const username = auth.guestName();
    try {
      const { rows } = await query(
        'INSERT INTO users (username, is_guest) VALUES ($1, true) RETURNING *', [username],
      );
      return res.json({ token: auth.sign(rows[0]), user: publicUser(rows[0]) });
    } catch (e) {
      if (e.code !== '23505') throw e; // unique violation: try another name
    }
  }
  res.status(500).json({ error: 'Could not create a guest account. Try again.' });
}));

router.post('/auth/register', wrap(async (req, res) => {
  const { username, password } = req.body || {};
  if (!auth.validUsername(username)) return res.status(400).json({ error: 'Usernames are 3–20 letters, numbers or underscores.' });
  if (!auth.validPassword(password)) return res.status(400).json({ error: 'Passwords need at least 6 characters.' });
  const password_hash = await auth.hashPassword(password);
  try {
    const { rows } = await query(
      'INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING *', [username, password_hash],
    );
    res.json({ token: auth.sign(rows[0]), user: publicUser(rows[0]) });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'That username is taken.' });
    throw e;
  }
}));

router.post('/auth/login', wrap(async (req, res) => {
  const { username, password } = req.body || {};
  const { rows } = await query('SELECT * FROM users WHERE lower(username) = lower($1)', [String(username || '')]);
  const user = rows[0];
  if (!user || !(await auth.checkPassword(String(password || ''), user.password_hash))) {
    return res.status(401).json({ error: 'Wrong username or password.' });
  }
  res.json({ token: auth.sign(user), user: publicUser(user) });
}));

// Turn a guest into a real account, keeping everything they've done.
router.post('/auth/claim', auth.requireUser, wrap(async (req, res) => {
  if (!req.user.is_guest) return res.status(400).json({ error: 'This account already has a username.' });
  const { username, password } = req.body || {};
  if (!auth.validUsername(username)) return res.status(400).json({ error: 'Usernames are 3–20 letters, numbers or underscores.' });
  if (!auth.validPassword(password)) return res.status(400).json({ error: 'Passwords need at least 6 characters.' });
  const password_hash = await auth.hashPassword(password);
  try {
    const { rows } = await query(
      'UPDATE users SET username = $1, password_hash = $2, is_guest = false WHERE id = $3 RETURNING *',
      [username, password_hash, req.user.id],
    );
    res.json({ token: auth.sign(rows[0]), user: publicUser(rows[0]) });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'That username is taken.' });
    throw e;
  }
}));

// --- The daily screen ------------------------------------------------------------

// Grants today's allowance exactly once per day (atomic on last_allowance_day),
// then returns everything the Today screen needs.
router.get('/me', auth.requireUser, wrap(async (req, res) => {
  const now = new Date();
  const day = dayInfo(now);
  let user = req.user;
  let allowance = null;

  if (user.last_allowance_day !== day.key) {
    const yesterday = game.addDays(day.key, -1);
    const streak = user.last_allowance_day === yesterday ? user.streak + 1 : 1;
    const amount = game.allowanceFor(streak);
    const { rows } = await query(
      `UPDATE users
         SET cash = cash + $1, streak = $2, last_allowance_day = $3, last_seen_at = now()
       WHERE id = $4 AND last_allowance_day IS DISTINCT FROM $3
       RETURNING *`,
      [amount, streak, day.key, user.id],
    );
    if (rows[0]) { user = rows[0]; allowance = { amount, streak }; }
    else { ({ rows: [user] } = await query('SELECT * FROM users WHERE id = $1', [user.id])); }
  } else {
    await query('UPDATE users SET last_seen_at = now() WHERE id = $1', [user.id]);
  }

  const { rows: open } = await query(
    'SELECT * FROM positions WHERE user_id = $1 AND status = $2 ORDER BY opened_at ASC', [user.id, 'open'],
  );
  // Freeze anything that matured since the last pass, then quote only what is still live.
  await maturer.settleMatured(open).catch((e) => console.error('maturer:', e.message));
  const stillLive = open.filter((p) => !p.matured_at);
  const quotes = await prices.getQuotes(stillLive.map((p) => assets.find(p.symbol)).filter(Boolean));

  const positions = open.map((p) => shapePosition(p, quotes[p.symbol]));

  const { rows: history } = await query(
    `SELECT p.id, p.symbol, p.name, p.invested, p.proceeds, p.profit, p.tax, p.tier, p.closed_at, p.closed_day,
            (p.matured_at IS NOT NULL) AS collected, c.name AS charity_name
       FROM positions p LEFT JOIN charities c ON c.id = p.charity_id
      WHERE p.user_id = $1 AND p.status = 'closed'
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

  const { rows: [todayGiven] } = await query(
    `SELECT COALESCE(SUM(d.amount), 0)::float8 AS amount FROM donations d
       JOIN positions p ON p.id = d.position_id
      WHERE d.user_id = $1 AND p.closed_day = $2`,
    [user.id, day.key],
  );

  // The back of the coin: where this player's tax has gone, by charity.
  const { rows: byCharity } = await query(
    `SELECT c.id, c.name, c.slug, SUM(d.amount)::float8 AS amount, COUNT(*)::int AS times
       FROM donations d JOIN charities c ON c.id = d.charity_id
      WHERE d.user_id = $1 GROUP BY c.id ORDER BY amount DESC`,
    [user.id],
  );

  res.json({
    user: publicUser(user),
    day,
    allowance,
    rules: { tax_rate: cfg.taxRate, daily_base: cfg.dailyBase, streak_bonus: cfg.streakBonus, daily_cap: cfg.dailyCap, hold_hours: cfg.holdHours, mult_floor: cfg.multFloor, demo: cfg.demoMode },
    positions,
    history,
    donations_by_charity: byCharity,
    crowd: { picks: crowd, ...crowdTotal },
    today_donated: todayGiven.amount,
  });
}));

router.post('/buy', auth.requireUser, wrap(async (req, res) => {
  const asset = assets.find((req.body || {}).symbol);
  const amount = game.round2(Number((req.body || {}).amount));
  if (!asset) return res.status(400).json({ error: 'Pick something from the list.' });
  if (!(amount >= 0.01)) return res.status(400).json({ error: 'Invest at least a penny.' });

  let quote;
  try { quote = await prices.getQuote(asset); } catch (e) {
    return res.status(503).json({ error: `Couldn't get a price for ${asset.symbol} right now. Try again in a minute.` });
  }

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

// Let it ride: roll a matured position's frozen value into a fresh one in the
// same asset at today's price. No tax, no lobbyists, the clock and the
// multiplier start over.
router.post('/ride', auth.requireUser, wrap(async (req, res) => {
  const positionId = Number((req.body || {}).position_id);
  if (!positionId) return res.status(400).json({ error: 'Which position?' });
  const { rows: [p] } = await query('SELECT * FROM positions WHERE id = $1 AND user_id = $2', [positionId, req.user.id]);
  if (!p) return res.status(404).json({ error: 'No such position.' });
  if (p.status !== 'open') return res.status(400).json({ error: 'Already collected.' });
  await maturer.settleMatured([p]).catch((e) => console.error('maturer:', e.message));
  if (!p.matured_at) return res.status(400).json({ error: "It hasn't matured yet. You can only let a matured position ride." });
  if (!(p.matured_value >= 0.01)) return res.status(400).json({ error: "There's nothing left to ride." });

  const asset = assets.find(p.symbol);
  let quote;
  try { quote = await prices.getQuote(asset); } catch (e) {
    return res.status(503).json({ error: `Couldn't get a price for ${p.symbol} right now. Try again in a minute.` });
  }
  const now = new Date();
  const day = game.dayKey(now);
  const profit = game.round2(p.matured_value - p.invested);

  const result = await withTx(async (tx) => {
    const { rows: [locked] } = await tx.query('SELECT status FROM positions WHERE id = $1 FOR UPDATE', [p.id]);
    if (locked.status !== 'open') return { error: 'Already collected.' };
    await tx.query(
      `UPDATE positions SET status = 'rolled', closed_at = $1, closed_day = $2, exit_price = $3,
              proceeds = $4, profit = $5, tax = 0, tier = 'Let it ride' WHERE id = $6`,
      [now, day, p.matured_price, p.matured_value, profit, p.id],
    );
    const { rows: [n] } = await tx.query(
      `INSERT INTO positions (user_id, symbol, name, asset_type, multiplier, invested, entry_price, opened_day, matures_at,
                              rolled_from, ride_count, origin_invested)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now() + ($9 || ' hours')::interval, $10, $11, $12) RETURNING *`,
      [p.user_id, p.symbol, p.name, p.asset_type, p.multiplier, p.matured_value, quote.price, day, String(cfg.holdHours),
        p.id, (p.ride_count || 0) + 1, p.origin_invested != null ? p.origin_invested : p.invested],
    );
    return { position: n };
  });
  if (result.error) return res.status(400).json({ error: result.error });
  res.json({ ok: true, position: shapePosition(result.position, quote), rolled: { from: p.id, value: p.matured_value, profit }, quote });
}));

router.post('/sell', auth.requireUser, wrap(async (req, res) => {
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
  if (p.matured_at) {
    exitPrice = p.matured_price;
  } else {
    const asset = assets.find(p.symbol);
    try { exitPrice = (await prices.getQuote(asset)).price; } catch (e) {
      return res.status(503).json({ error: `Couldn't get a price for ${p.symbol} right now. Try again in a minute.` });
    }
  }

  const live = game.valueOf(p, exitPrice, p.matured_at ? new Date(p.matures_at).getTime() : Date.now());
  if (p.matured_at) live.value = p.matured_value;
  const s = game.settle({ invested: p.invested, value: live.value });

  // A profit needs a charity for its tax; a loss doesn't. If the client sent
  // none (it previewed a loss and the price moved), fall back to the one the
  // player has hired the most for, then their last pick, then the first on
  // the list, rather than refusing to close the position.
  let charity = null;
  if (s.tax > 0) {
    const { rows } = await query(
      `SELECT c.* FROM charities c
        LEFT JOIN (SELECT charity_id, SUM(amount) AS total FROM donations WHERE user_id = $2 GROUP BY charity_id) d ON d.charity_id = c.id
       WHERE c.active
       ORDER BY (c.id = $1) DESC, (c.id = $3) DESC, d.total DESC NULLS LAST, c.sort
       LIMIT 1`,
      [Number.isInteger(charityId) ? charityId : -1, req.user.id, req.user.charity_id || -1],
    );
    charity = rows[0];
    if (!charity) return res.status(500).json({ error: 'No charities are set up yet.' });
  }

  const now = new Date();
  const day = game.dayKey(now);

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
      [s.net, s.tax, s.profit, charity ? charity.id : null, p.user_id],
    );
    if (s.tax > 0) {
      await tx.query(
        'INSERT INTO donations (user_id, charity_id, position_id, amount, quarter) VALUES ($1, $2, $3, $4, $5)',
        [u.id, charity.id, p.id, s.tax, game.quarterKey(day)],
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
      charity: charity ? { id: charity.id, name: charity.name, slug: charity.slug } : null,
    },
  });
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

router.get('/leaderboard', wrap(async (req, res) => {
  const { rows: allTime } = await query(
    `SELECT username, total_donated::float8 AS donated, realized_pnl::float8 AS realized_pnl, streak
       FROM users WHERE total_donated > 0 ORDER BY total_donated DESC, username LIMIT 25`,
  );
  // Best single lock-in in the last 24 hours, by % gain on what was invested.
  const { rows: day } = await query(
    `SELECT u.username, p.symbol, p.invested::float8 AS invested, p.proceeds::float8 AS proceeds,
            ((p.proceeds - p.invested) / p.invested)::float8 AS gain_pct, p.tier, p.closed_at
       FROM positions p JOIN users u ON u.id = p.user_id
      WHERE p.status = 'closed' AND p.closed_at > now() - interval '24 hours' AND p.invested > 0
      ORDER BY gain_pct DESC LIMIT 25`,
  );
  res.json({ all_time: allTime, last_24h: day });
}));

module.exports = router;
