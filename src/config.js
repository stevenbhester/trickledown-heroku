require('dotenv').config();

const num = (v, d) => (v === undefined || v === '' ? d : Number(v));

const finnhubKey = process.env.FINNHUB_API_KEY || '';
const isProduction = (process.env.NODE_ENV || '').toLowerCase() === 'production';

module.exports = {
  port: num(process.env.PORT, 3000),
  isProduction,
  databaseUrl: process.env.DATABASE_URL || 'postgres://postgres@localhost:5432/trickledown',
  jwtSecret: process.env.JWT_SECRET || 'dev-secret-change-me',
  bcryptRounds: num(process.env.BCRYPT_ROUNDS, 12),
  googleClientId: process.env.GOOGLE_CLIENT_ID || '',
  // Usernames that get the Admin section (grant cash/lobbyists, reset) for
  // testing. Comma-separated, case-insensitive. Empty = nobody.
  adminUsernames: (process.env.ADMIN_USERNAMES || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  corsOrigins: (process.env.CORS_ORIGIN || '*').split(',').map((s) => s.trim()).filter(Boolean),

  gameTz: process.env.GAME_TZ || 'America/Chicago',
  launchDate: process.env.LAUNCH_DATE || '2026-10-27',

  dailyBase: num(process.env.DAILY_BASE, 100),
  streakBonus: num(process.env.STREAK_BONUS, 10),
  dailyCap: num(process.env.DAILY_CAP, 200),
  taxRate: num(process.env.TAX_RATE, 0.25),
  // Letting a matured winner ride is taxed too, at this fraction of TAX_RATE.
  // The rest is deferred: due if the ride is sold early, forgiven at maturity.
  rideTaxFactor: num(process.env.RIDE_TAX_FACTOR, 0.5),
  // A ride's multiplier keeps climbing, one base multiplier per day, for this
  // many rides; after that it rides flat at the cap (stocks ×30, crypto ×15).
  rideMaxSteps: num(process.env.RIDE_MAX_STEPS, 2),
  // A position lives this long. At maturity its value freezes at that
  // moment's price until the player collects it.
  holdHours: num(process.env.HOLD_HOURS, 24),
  maturePollMs: num(process.env.MATURE_POLL_MS, 60_000),
  // Multiplier at the moment of purchase; ramps to the full MULT_* at maturity.
  multFloor: num(process.env.MULT_FLOOR, 1),
  multipliers: {
    stock: num(process.env.MULT_STOCK, 10),
    crypto: num(process.env.MULT_CRYPTO, 5),
  },

  priceProvider: process.env.PRICE_PROVIDER || (finnhubKey ? 'live' : 'mock'),
  finnhubKey,
  coingeckoKey: process.env.COINGECKO_API_KEY || '',
  quoteCacheMs: num(process.env.QUOTE_CACHE_MS, 60_000),
  // Outbound Finnhub calls we allow ourselves per minute (their free tier is 60).
  finnhubBudget: num(process.env.FINNHUB_BUDGET, 50),
  // Town income can push the allowance past DAILY_CAP by at most this much.
  townIncomeCap: num(process.env.TOWN_INCOME_CAP, 40),

  poolUsd: num(process.env.POOL_USD, 0),

  // While true, the site says plainly that the charities are fictional and no
  // real money moves. Set DEMO_MODE=false once the charity list is real.
  demoMode: (process.env.DEMO_MODE || 'true').toLowerCase() !== 'false',
};
