#!/usr/bin/env node
// One-off repair for a bug fixed in build 20261030a: the scheduler job
// (scripts/mature.js) didn't load the full symbol list, so a position in any
// stock outside the curated few that matured while the web dyno slept was
// taken for "delisted" and frozen at the price it was bought at.
//
// This finds open (not yet collected) positions frozen at exactly their
// purchase price in a symbol that is still listed, and re-freezes each at the
// price the game logged nearest its 24-hour mark, flagged "froze late" so the
// receipt says so. Collected ones are left alone (they've paid out).
//
//   heroku run node scripts/refreeze.js          # dry run: lists what it would change
//   heroku run node scripts/refreeze.js --apply  # writes it
const { pool, query } = require('../src/db');
const assets = require('../src/assets');
const pricelog = require('../src/pricelog');
const game = require('../src/game');

const apply = process.argv.includes('--apply');

(async () => {
  await assets.load(pool);
  if (!assets.ready()) { console.log('[refreeze] the symbol list is not in the database yet; nothing to compare against.'); await pool.end(); return; }
  const { rows } = await query(
    `SELECT p.*, u.username FROM positions p JOIN users u ON u.id = p.user_id
      WHERE p.status = 'open' AND p.matured_at IS NOT NULL
        AND p.matured_price = p.entry_price AND p.matured_value = p.invested
      ORDER BY p.matures_at`,
  );
  let fixed = 0, skipped = 0;
  for (const p of rows) {
    if (!assets.find(p.symbol)) { skipped++; continue; } // really delisted: frozen at cost is right
    const mark = new Date(p.matures_at).getTime();
    const logged = await pricelog.nearest(p.symbol, mark, 30 * 60e3);
    if (!logged || Number(logged.price) === Number(p.entry_price)) {
      console.log(`  skip #${p.id} ${p.username} ${p.symbol}: no different price logged within 30 min of the mark`);
      skipped++; continue;
    }
    const value = game.valueOf(p, Number(logged.price), mark).value;
    console.log(`  #${p.id} ${p.username} ${p.symbol}: ${p.invested} -> ${value} (price ${p.entry_price} -> ${logged.price}, logged ${new Date(logged.at).toISOString()})`);
    if (apply) {
      const { rowCount } = await query(
        `UPDATE positions SET matured_price = $1, matured_value = $2, matured_late = true
          WHERE id = $3 AND status = 'open' AND matured_price = entry_price`,
        [logged.price, value, p.id],
      );
      fixed += rowCount;
    } else fixed++;
  }
  console.log(`[refreeze] ${rows.length} frozen at cost; ${apply ? 'fixed' : 'would fix'} ${fixed}, left ${skipped}.${apply ? '' : ' Run with --apply to write.'}`);
  await pool.end();
})().catch((e) => { console.error('[refreeze] failed:', e); process.exit(1); });
