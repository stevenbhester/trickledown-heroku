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
const pricelog = require('./pricelog');

// A freeze more than this long after the 24-hour mark is "late": the price
// to use is the one logged nearest the mark, not the one on the screen now.
const LATE_MS = Number(process.env.MATURE_LATE_MS || 10 * 60e3);

// Freeze any of the given open positions that are past matures_at and not yet
// frozen. With no argument, scans the whole table. Returns how many froze.
async function settleMatured(rows) {
  if (!rows) {
    ({ rows } = await query(
      `SELECT * FROM positions WHERE status = 'open' AND matured_at IS NULL AND matures_at <= now()
       ORDER BY matures_at LIMIT 500`,
    ));
  }
  const now = Date.now();
  const due = rows.filter((p) => p.status === 'open' && !p.matured_at && p.matures_at && new Date(p.matures_at).getTime() <= now);
  if (!due.length) return 0;

  const quotes = await prices.getQuotes(due.map((p) => assets.find(p.symbol)).filter(Boolean));
  pricelog.record(quotes).catch((e) => console.warn('pricelog:', e.message));
  let n = 0;
  for (const p of due) {
    const maturesAt = new Date(p.matures_at).getTime();
    const listed = !!assets.find(p.symbol);
    let price = null, late = false;
    if (!listed) {
      // Taken out of the game since it was bought: freeze at what went in, so
      // the player can collect it instead of staring at it forever.
      price = p.entry_price;
    } else if (now - maturesAt > LATE_MS) {
      // Nobody froze it on time. Use the price we logged nearest the mark;
      // failing that, today's price, and say so on the position.
      const logged = await pricelog.nearest(p.symbol, maturesAt).catch(() => null);
      if (logged) price = logged.price;
      else if (quotes[p.symbol]) { price = quotes[p.symbol].price; late = true; }
    } else if (quotes[p.symbol]) {
      price = quotes[p.symbol].price;
    }
    if (price == null) continue; // try again next pass
    // Frozen at the full multiplier, as of the moment it matured.
    const live = game.valueOf(p, price, maturesAt);
    const { rowCount } = await query(
      `UPDATE positions SET matured_at = now(), matured_price = $1, matured_value = $2, matured_late = $4
        WHERE id = $3 AND status = 'open' AND matured_at IS NULL`,
      [price, live.value, p.id, late],
    );
    if (rowCount) { n++; p.matured_at = new Date(); p.matured_price = price; p.matured_value = live.value; p.matured_late = late; }
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
