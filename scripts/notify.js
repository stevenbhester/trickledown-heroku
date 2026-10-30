#!/usr/bin/env node
// The daily reminder. Run it every hour from Heroku Scheduler:
//   heroku addons:open scheduler   ->  "node scripts/notify.js", every hour
//
// For each device a player turned reminders on for: if it's NOTIFY_HOUR
// (default 17, 5pm) in that device's time zone, the player hasn't played
// today, and that device hasn't had one today, send one. Subscriptions the
// push service says are gone (404/410) are deleted. Without VAPID_PUBLIC,
// VAPID_PRIVATE and VAPID_SUBJECT set, it does nothing and says so.
const cfg = require('../src/config');
const { pool, query } = require('../src/db');
const { migrate } = require('../src/migrate');
const game = require('../src/game');
const Town = require('../src/town');

// The local date and hour in a time zone.
function localParts(tz, now) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' });
  const p = Object.fromEntries(f.formatToParts(now).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
}

const kStr = (n) => (n >= 1000 ? `$${Math.round(n / 100) / 10}M` : `$${Math.round(n)}K`);

// What to say, in rotation among the ones that are true today.
function messageFor(row, today) {
  const options = [];
  if (row.matured > 0) options.push("Your money matured. It's just sitting there.");
  if (Town.isUnlocked(row.total_donated)) {
    const t = row.town;
    const pending = t && t.day === today ? (t.issues || []).filter((i) => !i.chosen).length : 0;
    options.push(pending ? `${pending} card${pending === 1 ? '' : 's'} expire${pending === 1 ? 's' : ''} at midnight. The residents are watching.` : "Today's cards expire at midnight. The residents are watching.");
  }
  const streak = row.last_allowance_day === game.addDays(today, -1) ? row.streak + 1 : 1;
  options.push(`${kStr(game.allowanceFor(streak))} landed on the coin. Preston has ideas.`);
  return options[game.dayNumber(today) % options.length];
}

(async () => {
  if (!cfg.vapidPublic || !cfg.vapidPrivate || !cfg.vapidSubject) {
    console.log('[notify] VAPID_PUBLIC, VAPID_PRIVATE and VAPID_SUBJECT are not all set; reminders are off.');
    await pool.end();
    return;
  }
  const webpush = require('web-push');
  webpush.setVapidDetails(cfg.vapidSubject, cfg.vapidPublic, cfg.vapidPrivate);
  await migrate();
  const now = new Date();
  const today = game.dayKey(now);
  const { rows } = await query(
    `SELECT s.id, s.endpoint, s.keys, s.tz, s.last_sent_day, u.streak, u.last_allowance_day, u.total_donated, u.town,
            (SELECT COUNT(*) FROM positions p WHERE p.user_id = u.id AND p.status = 'open' AND p.matured_at IS NOT NULL)::int AS matured
       FROM push_subscriptions s JOIN users u ON u.id = s.user_id
      WHERE u.last_allowance_day IS DISTINCT FROM $1`, [today],
  );
  let sent = 0, gone = 0, failed = 0;
  for (const r of rows) {
    let local;
    try { local = localParts(r.tz, now); } catch (e) { local = localParts(cfg.gameTz, now); }
    if (local.hour !== cfg.notifyHour || r.last_sent_day === local.day) continue;
    const body = messageFor(r, today);
    try {
      await webpush.sendNotification({ endpoint: r.endpoint, keys: r.keys }, JSON.stringify({ title: 'Trickle Down', body, url: '/' }), { TTL: 6 * 3600 });
      await query('UPDATE push_subscriptions SET last_sent_day = $1 WHERE id = $2', [local.day, r.id]);
      sent++;
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) { await query('DELETE FROM push_subscriptions WHERE id = $1', [r.id]); gone++; } else { failed++; console.warn('[notify]', e.statusCode || '', e.message); }
    }
  }
  console.log(`[notify] ${rows.length} waiting, sent ${sent}, removed ${gone} expired, ${failed} failed`);
  await pool.end();
})().catch((e) => { console.error('[notify] failed:', e); process.exit(1); });

module.exports = { messageFor, localParts };
