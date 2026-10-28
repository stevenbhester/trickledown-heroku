// Creates tables if missing and seeds charities. Safe to run every boot.
const { pool } = require('./db');
const charities = require('./charities');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS charities (
  id SERIAL PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  blurb TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '',
  active BOOLEAN NOT NULL DEFAULT true,
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT,
  is_guest BOOLEAN NOT NULL DEFAULT false,
  cash NUMERIC(14,2) NOT NULL DEFAULT 0,
  total_donated NUMERIC(14,2) NOT NULL DEFAULT 0,
  realized_pnl NUMERIC(14,2) NOT NULL DEFAULT 0,
  streak INTEGER NOT NULL DEFAULT 0,
  last_allowance_day TEXT,
  charity_id INTEGER REFERENCES charities(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS positions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  symbol TEXT NOT NULL,
  name TEXT NOT NULL,
  asset_type TEXT NOT NULL,
  multiplier NUMERIC(6,2) NOT NULL,
  invested NUMERIC(14,2) NOT NULL,
  entry_price NUMERIC(20,8) NOT NULL,
  opened_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  opened_day TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  closed_at TIMESTAMPTZ,
  closed_day TEXT,
  exit_price NUMERIC(20,8),
  proceeds NUMERIC(14,2),
  profit NUMERIC(14,2),
  tax NUMERIC(14,2),
  charity_id INTEGER REFERENCES charities(id),
  tier TEXT
);
CREATE INDEX IF NOT EXISTS positions_user_status ON positions(user_id, status);
CREATE INDEX IF NOT EXISTS positions_opened_day ON positions(opened_day);
CREATE INDEX IF NOT EXISTS positions_closed_at ON positions(closed_at);

CREATE TABLE IF NOT EXISTS donations (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  charity_id INTEGER NOT NULL REFERENCES charities(id),
  position_id INTEGER REFERENCES positions(id),
  amount NUMERIC(14,2) NOT NULL,
  quarter TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS donations_quarter ON donations(quarter, charity_id);
CREATE INDEX IF NOT EXISTS donations_user ON donations(user_id);

-- Maturity (added after the first schema; ADD COLUMN IF NOT EXISTS keeps
-- this safe on existing databases).
ALTER TABLE positions ADD COLUMN IF NOT EXISTS matures_at TIMESTAMPTZ;
ALTER TABLE positions ADD COLUMN IF NOT EXISTS matured_at TIMESTAMPTZ;
ALTER TABLE positions ADD COLUMN IF NOT EXISTS matured_price NUMERIC(20,8);
ALTER TABLE positions ADD COLUMN IF NOT EXISTS matured_value NUMERIC(14,2);
UPDATE positions SET matures_at = opened_at + interval '24 hours' WHERE matures_at IS NULL;
CREATE INDEX IF NOT EXISTS positions_matures ON positions(status, matures_at) WHERE matured_at IS NULL;

-- The village (src/town.js). Null until the first visit after this ships.
ALTER TABLE users ADD COLUMN IF NOT EXISTS town JSONB;

-- Friends: one-directional. Adding someone lets you see their coin and town.
CREATE TABLE IF NOT EXISTS friends (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  friend_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, friend_id)
);
CREATE INDEX IF NOT EXISTS friends_friend ON friends(friend_id);
-- Positions and donations must go when a user does (guest sweep). Rewriting
-- a foreign key locks and revalidates the table, so only do it once.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'positions_user_id_fkey' AND confdeltype = 'c') THEN
    ALTER TABLE positions DROP CONSTRAINT IF EXISTS positions_user_id_fkey;
    ALTER TABLE positions ADD CONSTRAINT positions_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'donations_user_id_fkey' AND confdeltype = 'c') THEN
    ALTER TABLE donations DROP CONSTRAINT IF EXISTS donations_user_id_fkey;
    ALTER TABLE donations ADD CONSTRAINT donations_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
  END IF;
END $$;

-- Accounts: Google sign-in, and a token version so sign-out-everywhere works.
ALTER TABLE users ADD COLUMN IF NOT EXISTS google_sub TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMPTZ;
CREATE UNIQUE INDEX IF NOT EXISTS users_google_sub ON users (google_sub) WHERE google_sub IS NOT NULL;
-- Usernames are unique regardless of case, so Steven and steven can't both exist.
CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower ON users (lower(username));

-- "Let it ride": a matured position rolled into a fresh one in the same asset.
ALTER TABLE positions ADD COLUMN IF NOT EXISTS rolled_from INTEGER REFERENCES positions(id);
ALTER TABLE positions ADD COLUMN IF NOT EXISTS ride_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE positions ADD COLUMN IF NOT EXISTS origin_invested NUMERIC(14,2);
UPDATE positions SET origin_invested = invested WHERE origin_invested IS NULL;
-- A ride's multiplier climbs from where the last one ended (mult_floor) to a
-- higher ceiling (multiplier). The half of the tax it skipped is deferred:
-- due if the ride is sold early, forgiven when it matures.
ALTER TABLE positions ADD COLUMN IF NOT EXISTS mult_floor NUMERIC(6,2);
ALTER TABLE positions ADD COLUMN IF NOT EXISTS deferred_tax NUMERIC(14,2) NOT NULL DEFAULT 0;
-- Set when a position had to be frozen long after its 24 hours with no
-- logged price near the mark, so the receipt can say so.
ALTER TABLE positions ADD COLUMN IF NOT EXISTS matured_late BOOLEAN NOT NULL DEFAULT false;

-- "Use on another device": a short-lived, single-use code that signs the
-- other device into the same account. Stored hashed.
CREATE TABLE IF NOT EXISTS link_codes (
  code_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ
);

-- Every quote the game fetches, one row per symbol per minute, kept a week.
-- If a position has to be frozen late, the price nearest its 24-hour mark
-- comes from here instead of from whenever someone next showed up.
CREATE TABLE IF NOT EXISTS price_log (
  symbol TEXT NOT NULL,
  at TIMESTAMPTZ NOT NULL,
  price NUMERIC(20,8) NOT NULL,
  PRIMARY KEY (symbol, at)
);

`;

async function migrate() {
  await pool.query(SCHEMA);
  for (let i = 0; i < charities.length; i++) {
    const c = charities[i];
    await pool.query(
      `INSERT INTO charities (slug, name, blurb, url, category, sort, active)
       VALUES ($1, $2, $3, $4, $5, $6, true)
       ON CONFLICT (slug) DO UPDATE SET
         name = EXCLUDED.name, blurb = EXCLUDED.blurb, url = EXCLUDED.url,
         category = EXCLUDED.category, sort = EXCLUDED.sort, active = true`,
      [c.slug, c.name, c.blurb, c.url, c.category, i],
    );
  }
  // Anything no longer in the list is retired, not deleted: its donation
  // history stays, it just stops being an option.
  if (charities.length) {
    const slots = charities.map((_, i) => `$${i + 1}`).join(', ');
    await pool.query(`UPDATE charities SET active = false WHERE slug NOT IN (${slots})`, charities.map((c) => c.slug));
  }
}

module.exports = { migrate };

if (require.main === module) {
  migrate()
    .then(() => { console.log('migrated'); return pool.end(); })
    .catch((e) => { console.error(e); process.exit(1); });
}
