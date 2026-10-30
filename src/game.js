// Pure game rules. No I/O here, so it is easy to test and to reason about.
const cfg = require('./config');

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

// 'YYYY-MM-DD' for a Date in the game's time zone.
function dayKey(date = new Date(), tz = cfg.gameTz) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}

function addDays(key, n) {
  const [y, m, d] = key.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}

// Minutes the zone is ahead of UTC at the given instant.
function tzOffsetMinutes(date, tz) {
  const local = new Date(date.toLocaleString('en-US', { timeZone: tz }));
  const utc = new Date(date.toLocaleString('en-US', { timeZone: 'UTC' }));
  return (local - utc) / 60000;
}

// The next local midnight in the game zone, as a UTC instant.
function nextReset(now = new Date(), tz = cfg.gameTz) {
  const tomorrow = addDays(dayKey(now, tz), 1);
  const [y, m, d] = tomorrow.split('-').map(Number);
  const guess = new Date(Date.UTC(y, m - 1, d, 0, 0, 0));
  return new Date(guess.getTime() - tzOffsetMinutes(guess, tz) * 60000);
}

function dayNumber(key = dayKey()) {
  const a = new Date(`${cfg.launchDate}T00:00:00Z`);
  const b = new Date(`${key}T00:00:00Z`);
  return Math.max(1, Math.round((b - a) / 86400000) + 1);
}

function quarterKey(key = dayKey()) {
  const [y, m] = key.split('-').map(Number);
  return `${y}-Q${Math.floor((m - 1) / 3) + 1}`;
}

// Lobbyfest: local midnight at the start of the next quarter, as a UTC instant.
function quarterEnd(now = new Date(), tz = cfg.gameTz) {
  const [y, m] = dayKey(now, tz).split('-').map(Number);
  const nextQuarterMonth = Math.floor((m - 1) / 3) * 3 + 3; // 0-based month index of next quarter's first month
  const yy = y + Math.floor(nextQuarterMonth / 12), mm = nextQuarterMonth % 12;
  const guess = new Date(Date.UTC(yy, mm, 1, 0, 0, 0));
  return new Date(guess.getTime() - tzOffsetMinutes(guess, tz) * 60000);
}

// Today's allowance given the streak length *including* today.
function allowanceFor(streak) {
  const bonus = cfg.streakBonus * Math.max(0, streak - 1);
  return Math.min(cfg.dailyCap, cfg.dailyBase + bonus);
}

// The multiplier ramps with age: MULT_FLOOR (×1) the moment you buy, rising
// linearly to the position's full multiplier at maturity, where it stays.
// Selling early means selling at a smaller multiplier. A ride (see
// rideMultipliers) starts where the last day ended instead of at ×1.
function effectiveMultiplier(p, at = Date.now()) {
  const opened = new Date(p.opened_at).getTime();
  const matures = p.matures_at ? new Date(p.matures_at).getTime() : opened + cfg.holdHours * 3600e3;
  const k = Math.max(0, Math.min(1, (at - opened) / Math.max(1, matures - opened)));
  const floor = Math.min(p.mult_floor != null ? p.mult_floor : cfg.multFloor, p.multiplier);
  return floor + (p.multiplier - floor) * k;
}

// The multipliers for a ride off a matured position: the new day starts at
// the old ceiling and climbs by the asset's base multiplier again (stocks
// ×10 → ×20, crypto ×5 → ×10), up to RIDE_MAX_STEPS rides past the first
// day; after that it rides flat at the cap.
function rideMultipliers(prev, base) {
  const cap = base * (1 + cfg.rideMaxSteps);
  const floor = Math.min(prev.multiplier, cap);
  const ceiling = Math.min(floor + base, cap);
  return { floor, ceiling };
}

// What a position is worth at a given instant. The real move is amplified by
// the multiplier in force at that moment and floored at zero: a position can
// die, it can't go negative.
function valueOf(p, price, at = Date.now()) {
  const mult = effectiveMultiplier(p, at);
  const realPct = (price - p.entry_price) / p.entry_price;
  const swingPct = mult * realPct;
  const raw = p.invested * (1 + swingPct);
  return {
    real_pct: realPct,
    swing_pct: Math.max(-1, swingPct),
    multiplier_now: Math.round(mult * 100) / 100,
    value: round2(Math.max(0, raw)),
    busted: raw <= 0,
  };
}

// Deadpan names for what just happened, Krillion-style.
function tierFor({ invested, value }) {
  if (value <= 0) return 'Rest in peace';
  const pct = (value - invested) / invested;
  // Losses get the same ladder as gains, in the other direction.
  if (pct <= -0.5) return 'Comically disastrous';
  if (pct <= -0.25) return 'Taking on water';
  if (pct <= -0.1) return 'Flesh wound';
  if (pct < 0) return 'Paper cut';
  if (pct < 0.10) return 'Pocket change';
  if (pct < 0.25) return 'Respectable';
  if (pct < 0.50) return 'Nice';
  if (pct < 1.00) return 'Heater';
  return 'Legend';
}

// Closing a position: profit is taxed, loss is not. The tax is the donation.
// `deferred` is tax carried over from a ride (the half it skipped): charged
// here when a ride is sold early, never more than what's left.
function settle({ invested, value, deferred = 0 }, rate = cfg.taxRate) {
  const profit = round2(value - invested);
  const own = profit > 0 ? round2(profit * rate) : 0;
  const due = round2(Math.min(Math.max(0, deferred), Math.max(0, value - own)));
  const tax = round2(own + due);
  return {
    profit,
    tax,
    deferred_tax: due,
    net: round2(value - tax),
    tier: tierFor({ invested, value }),
  };
}

// --- Lobbyfest: how the ad money is split ------------------------------------
// These numbers are public promises (the Mission & promises page): change the
// page with them, never one without the other.
//   - At least $100 goes out: if the ads earned less, the owners top it up.
//   - Each charity's share is proportional to its lobbyists. A charity whose
//     share would be under $5 gets nothing this time, and the split is rerun
//     without its lobbyists, until every charity left gets at least $5.
//     ("If a charity would receive less than $5, it does not receive a
//     donation": every charity under $5 in a round is left out together.)
//   - Left-out charities' lobbyists roll over to the next Lobbyfest: pass
//     them in `n` (this code has no record of past Lobbyfests).
const LOBBYFEST = { minimum: 100, floor: 5 };

// lobbyists: [{ id, n }]. Returns { pot, rows: [{ id, usd, left_out }] },
// dollars to the cent (rounding leftovers go to the biggest share).
function lobbyfestSplit(pool, lobbyists, { minimum = LOBBYFEST.minimum, floor = LOBBYFEST.floor } = {}) {
  const pot = round2(Math.max(Number(pool) || 0, minimum));
  let inn = lobbyists.filter((c) => c.n > 0);
  for (;;) {
    const total = inn.reduce((s, c) => s + c.n, 0);
    if (!total) break;
    const under = inn.filter((c) => (pot * c.n) / total < floor);
    if (!under.length) break;
    // If every charity is under $5 (more charities than the pot can pay $5
    // each), leaving them all out would pay nobody: drop just the smallest.
    const drop = under.length < inn.length ? new Set(under.map((c) => c.id))
      : new Set([inn.slice().sort((a, b) => a.n - b.n || a.id - b.id)[0].id]);
    inn = inn.filter((c) => !drop.has(c.id));
  }
  const total = inn.reduce((s, c) => s + c.n, 0);
  const paid = new Map(inn.map((c) => [c.id, Math.floor(((pot * c.n) / total) * 100) / 100]));
  if (inn.length) {
    const rest = round2(pot - [...paid.values()].reduce((s, v) => s + v, 0));
    const big = inn.slice().sort((a, b) => b.n - a.n || a.id - b.id)[0].id;
    paid.set(big, round2(paid.get(big) + rest));
  }
  return { pot, rows: lobbyists.map((c) => ({ id: c.id, usd: paid.get(c.id) || 0, left_out: c.n > 0 && !paid.has(c.id) })) };
}

// Ranks for lobbyists hired (one per play-money dollar of tax), computed on
// the fly from total_donated.
const BADGES = [
  { at: 1, name: 'Intern' },
  { at: 10, name: 'Staffer' },
  { at: 50, name: 'Consultant' },
  { at: 250, name: 'Lobbyist' },
  { at: 1000, name: 'Fixer' },
  { at: 5000, name: 'Kingmaker' },
  { at: 25000, name: 'Shadow Cabinet' },
];

function badgesFor(totalDonated) {
  const earned = BADGES.filter((b) => totalDonated >= b.at);
  const next = BADGES.find((b) => totalDonated < b.at) || null;
  return { earned, next };
}

module.exports = {
  round2, dayKey, addDays, nextReset, dayNumber, quarterKey, quarterEnd, LOBBYFEST, lobbyfestSplit,
  allowanceFor, effectiveMultiplier, rideMultipliers, valueOf, tierFor, settle, badgesFor, BADGES,
};
