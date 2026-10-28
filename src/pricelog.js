// A week of the prices the game has already fetched, one row per symbol per
// minute. Nothing here calls a provider; it only remembers what the maturer
// and /me looked up anyway. The point is a late freeze: a position whose
// 24-hour mark passed while nobody was looking gets the price nearest that
// mark, not the price when someone finally showed up.
const { query } = require('./db');

const KEEP_DAYS = Number(process.env.PRICE_LOG_DAYS || 7);

// quotes: a map symbol -> quote (as prices.getQuotes returns). Stale quotes
// and failures are skipped. Fire-and-forget safe.
async function record(quotes) {
  const rows = Object.entries(quotes || {}).filter(([, q]) => q && !q.stale && q.price > 0);
  if (!rows.length) return 0;
  const values = [], params = [];
  rows.forEach(([symbol, q], i) => {
    const n = i * 3;
    values.push(`($${n + 1}, date_trunc('minute', $${n + 2}::timestamptz), $${n + 3})`);
    params.push(symbol, q.at || new Date().toISOString(), q.price);
  });
  const { rowCount } = await query(`INSERT INTO price_log (symbol, at, price) VALUES ${values.join(', ')} ON CONFLICT DO NOTHING`, params);
  return rowCount;
}

// The logged price nearest `at`, within windowMs either side, or null.
async function nearest(symbol, at, windowMs = 30 * 60e3) {
  const { rows } = await query(
    `SELECT price, at FROM price_log
      WHERE symbol = $1 AND at BETWEEN $2::timestamptz - ($3 || ' ms')::interval AND $2::timestamptz + ($3 || ' ms')::interval
      ORDER BY abs(extract(epoch FROM (at - $2::timestamptz))) LIMIT 1`,
    [symbol, new Date(at).toISOString(), String(windowMs)],
  );
  return rows[0] ? { price: rows[0].price, at: rows[0].at } : null;
}

async function prune() {
  const { rowCount } = await query(`DELETE FROM price_log WHERE at < now() - ($1 || ' days')::interval`, [String(KEEP_DAYS)]);
  return rowCount;
}

module.exports = { record, nearest, prune, KEEP_DAYS };
