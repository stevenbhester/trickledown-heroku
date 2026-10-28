// Nightly tidy-up. Guest accounts that never hired anyone and haven't been
// seen in GUEST_TTL_DAYS are deleted (positions and friendships go with them,
// via ON DELETE CASCADE). Real accounts are never touched.
const { query } = require('./db');
const pricelog = require('./pricelog');

const GUEST_TTL_DAYS = Number(process.env.GUEST_TTL_DAYS || 45);

async function sweepGuests() {
  const { rowCount } = await query(
    `DELETE FROM users WHERE is_guest AND total_donated = 0 AND last_seen_at < now() - ($1 || ' days')::interval`,
    [String(GUEST_TTL_DAYS)],
  );
  if (rowCount) console.log(`[housekeeping] removed ${rowCount} idle guest account(s)`);
  return rowCount;
}

async function tidy() {
  await sweepGuests();
  const pruned = await pricelog.prune();
  if (pruned) console.log(`[housekeeping] pruned ${pruned} price log row(s) older than ${pricelog.KEEP_DAYS} days`);
}

function start() {
  const tick = () => tidy().catch((e) => console.error('housekeeping:', e.message));
  setTimeout(tick, 30_000);
  const t = setInterval(tick, 24 * 3600e3);
  if (t.unref) t.unref();
}

module.exports = { sweepGuests, tidy, start };
