const { Pool, types } = require('pg');
const cfg = require('./config');

// NUMERIC columns come back as strings by default; the game wants numbers.
types.setTypeParser(1700, (v) => (v === null ? null : parseFloat(v)));

const isLocal = /localhost|127\.0\.0\.1/.test(cfg.databaseUrl);
const useSsl = !isLocal && process.env.PGSSLMODE !== 'disable';

const pool = new Pool({
  connectionString: cfg.databaseUrl,
  ssl: useSsl ? { rejectUnauthorized: false } : false,
  max: 5,
});

async function query(text, params) {
  return pool.query(text, params);
}

// Run fn(client) inside a transaction. Rolls back on throw.
async function withTx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { pool, query, withTx };
