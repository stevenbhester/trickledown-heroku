// Keeps the price log dense enough to draw. /me and the maturer only log the
// prices they happen to look up, so overnight, with nobody playing, a held
// stock could go hours without a row. Every couple of minutes this logs the
// price of whatever someone is holding (live, not yet matured), stalest
// first, a few stocks per pass so most of the provider budget stays with
// players. The welcome-back performance review draws from these rows.
const { query } = require('./db');
const cfg = require('./config');
const prices = require('./prices');
const assets = require('./assets');
const pricelog = require('./pricelog');

const EVERY_MS = Number(process.env.SAMPLE_EVERY_MS || 10 * 60e3); // target spacing per symbol
const POLL_MS = Number(process.env.SAMPLE_POLL_MS || 2 * 60e3);
const BATCH = Number(process.env.SAMPLE_BATCH || 8); // stock lookups per pass
const COINS = 60; // coins are one CoinGecko call, so more fit per pass
const RESERVE = 25; // Finnhub calls per minute always left for players

// One pass. `batch` caps the stock lookups. Returns how many rows it logged.
async function sampleOnce({ batch = BATCH } = {}) {
  const { rows } = await query(
    `SELECT h.symbol, h.name, h.asset_type,
            (SELECT max(l.at) FROM price_log l WHERE l.symbol = h.symbol) AS last
       FROM (SELECT DISTINCT ON (symbol) symbol, name, asset_type FROM positions
              WHERE status = 'open' AND matured_at IS NULL ORDER BY symbol) h
      ORDER BY last NULLS FIRST, h.symbol`,
  );
  const now = Date.now();
  const due = rows
    .filter((r) => !r.last || now - new Date(r.last).getTime() >= EVERY_MS - 30e3)
    .map((r) => assets.forPosition(r))
    .filter(Boolean);
  if (!due.length) return 0;
  const room = cfg.priceProvider === 'live' ? Math.max(0, Math.min(batch, prices.budgetLeft() - RESERVE)) : batch;
  const pick = [
    ...due.filter((a) => a.type === 'crypto').slice(0, COINS),
    ...due.filter((a) => a.type !== 'crypto').slice(0, room),
  ];
  if (!pick.length) return 0;
  const quotes = await prices.getQuotes(pick);
  return pricelog.record(quotes);
}

function start(intervalMs = POLL_MS) {
  const tick = () => sampleOnce().catch((e) => console.warn('sampler:', e.message));
  setTimeout(tick, 15_000);
  const t = setInterval(tick, intervalMs);
  if (t.unref) t.unref();
}

module.exports = { sampleOnce, start, EVERY_MS };
