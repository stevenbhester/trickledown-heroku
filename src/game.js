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

// Today's allowance given the streak length *including* today.
function allowanceFor(streak) {
  const bonus = cfg.streakBonus * Math.max(0, streak - 1);
  return Math.min(cfg.dailyCap, cfg.dailyBase + bonus);
}

// The multiplier ramps with age: MULT_FLOOR (×1) the moment you buy, rising
// linearly to the position's full multiplier at maturity, where it stays.
// Selling early means selling at a smaller multiplier.
function effectiveMultiplier(p, at = Date.now()) {
  const opened = new Date(p.opened_at).getTime();
  const matures = p.matures_at ? new Date(p.matures_at).getTime() : opened + cfg.holdHours * 3600e3;
  const k = Math.max(0, Math.min(1, (at - opened) / Math.max(1, matures - opened)));
  const floor = Math.min(cfg.multFloor, p.multiplier);
  return floor + (p.multiplier - floor) * k;
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
  if (pct < 0) return 'Paper cut';
  if (pct < 0.10) return 'Pocket change';
  if (pct < 0.25) return 'Respectable';
  if (pct < 0.50) return 'Nice';
  if (pct < 1.00) return 'Heater';
  return 'Legend';
}

// Closing a position: profit is taxed, loss is not. The tax is the donation.
function settle({ invested, value }) {
  const profit = round2(value - invested);
  const tax = profit > 0 ? round2(profit * cfg.taxRate) : 0;
  return {
    profit,
    tax,
    net: round2(value - tax),
    tier: tierFor({ invested, value }),
  };
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
  round2, dayKey, addDays, nextReset, dayNumber, quarterKey,
  allowanceFor, effectiveMultiplier, valueOf, tierFor, settle, badgesFor, BADGES,
};
