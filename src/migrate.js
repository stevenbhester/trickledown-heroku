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

-- "Let it ride": a matured position rolled into a fresh one in the same asset.
ALTER TABLE positions ADD COLUMN IF NOT EXISTS rolled_from INTEGER REFERENCES positions(id);
ALTER TABLE positions ADD COLUMN IF NOT EXISTS ride_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE positions ADD COLUMN IF NOT EXISTS origin_invested NUMERIC(14,2);
UPDATE positions SET origin_invested = invested WHERE origin_invested IS NULL;

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
