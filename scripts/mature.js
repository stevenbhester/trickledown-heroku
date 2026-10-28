#!/usr/bin/env node
// Freeze every position that has reached its 24-hour mark, then exit.
//
// Run this from Heroku Scheduler every 10 minutes:
//   heroku addons:create scheduler:standard
//   heroku addons:open scheduler   ->  "node scripts/mature.js", every 10 minutes
//
// The web dyno does the same thing on a 60-second timer while it's awake, and
// /me does it for your own rows when you show up. This one-off is what keeps
// the mark honest when the dyno is asleep or restarting: a position's value is
// logged at (or within ten minutes of) 24 hours from purchase whether or not
// anyone is playing. Safe to run alongside the timer: the freeze is a guarded
// UPDATE, so a row can only be frozen once.
const { pool } = require('../src/db');
const { migrate } = require('../src/migrate');
const maturer = require('../src/maturer');
const pricelog = require('../src/pricelog');

(async () => {
  const started = Date.now();
  await migrate();
  let total = 0, n;
  // settleMatured takes 500 at a time; loop until nothing is due.
  do { n = await maturer.settleMatured(); total += n; } while (n === 500);
  const pruned = await pricelog.prune().catch(() => 0);
  console.log(`[mature] froze ${total} position(s)${pruned ? `, pruned ${pruned} price log row(s)` : ''} in ${Date.now() - started}ms`);
  await pool.end();
})().catch((e) => { console.error('[mature] failed:', e); process.exit(1); });
