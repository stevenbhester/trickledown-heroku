// Freezes positions that have reached maturity: looks up the price once and
// stores it, so the position stops moving until the player collects it.
//
// Runs on a timer from server.js, and is also called from /me and /sell for the
// rows at hand, so a player never sees a matured position still swinging even
// if the timer is late (a dyno restart, say).
const { query } = require('./db');
const game = require('./game');
const prices = require('./prices');
const assets = require('./assets');

// Freeze any of the given open positions that are past matures_at and not yet
// frozen. With no argument, scans the whole table. Returns how many froze.
async function settleMatured(rows) {
  if (!rows) {
    ({ rows } = await query(
      `SELECT * FROM positions WHERE status = 'open' AND matured_at IS NULL AND matures_at <= now()
       ORDER BY matures_at LIMIT 500`,
    ));
  }
  const due = rows.filter((p) => p.status === 'open' && !p.matured_at && p.matures_at && new Date(p.matures_at) <= new Date());
  if (!due.length) return 0;

  const quotes = await prices.getQuotes(due.map((p) => assets.find(p.symbol)).filter(Boolean));
  let n = 0;
  for (const p of due) {
    const q = quotes[p.symbol];
    if (!q) continue; // try again next pass
    // Frozen at the full multiplier, as of the moment it matured.
    const live = game.valueOf(p, q.price, new Date(p.matures_at).getTime());
    const { rowCount } = await query(
      `UPDATE positions SET matured_at = now(), matured_price = $1, matured_value = $2
        WHERE id = $3 AND status = 'open' AND matured_at IS NULL`,
      [q.price, live.value, p.id],
    );
    if (rowCount) { n++; p.matured_at = new Date(); p.matured_price = q.price; p.matured_value = live.value; }
  }
  return n;
}

function start(intervalMs) {
  const tick = () => settleMatured().catch((e) => console.error('maturer:', e.message));
  tick();
  const t = setInterval(tick, intervalMs);
  if (t.unref) t.unref();
}

module.exports = { settleMatured, start };
