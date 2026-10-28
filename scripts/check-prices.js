#!/usr/bin/env node
// Sanity-check the live price providers with your keys. Run it once after
// setting FINNHUB_API_KEY (and optionally COINGECKO_API_KEY) in .env, or on
// Heroku with:  heroku run node scripts/check-prices.js
//
// It fetches a few stocks and coins through the same code the game uses and
// prints what came back, so you can see prices, day moves, and when each one
// last traded before anyone plays with real money that isn't real.

process.env.PRICE_PROVIDER = process.env.PRICE_PROVIDER || 'live';
const prices = require('../src/prices');
const assets = require('../src/assets');
const cfg = require('../src/config');

(async () => {
  if (!cfg.finnhubKey) { console.error('FINNHUB_API_KEY is not set. Get a free key at https://finnhub.io and put it in .env.'); process.exit(1); }
  const sample = ['AAPL', 'NVDA', 'SPY', 'GLD', 'BTC', 'ETH', 'DOGE'].map((s) => assets.find(s)).filter(Boolean);
  console.log(`Provider: ${cfg.priceProvider}. Fetching ${sample.length} quotes…\n`);
  const t0 = Date.now();
  const quotes = await prices.getQuotes(sample);
  for (const a of sample) {
    const q = quotes[a.symbol];
    if (!q) { console.log(`${a.symbol.padEnd(6)} FAILED`); continue; }
    const ago = q.traded_at ? Math.round((Date.now() - new Date(q.traded_at)) / 60000) : null;
    console.log(`${a.symbol.padEnd(6)} $${String(q.price).padEnd(12)} day ${q.change_pct == null ? '  n/a' : (q.change_pct * 100).toFixed(2).padStart(6) + '%'}  via ${q.source.padEnd(9)} last trade ${ago == null ? 'unknown' : ago < 60 ? `${ago}m ago` : `${Math.round(ago / 60)}h ago`}${q.stale ? '  (STALE)' : ''}`);
  }
  console.log(`\n${Date.now() - t0} ms. Second call should hit the cache:`);
  const t1 = Date.now();
  await prices.getQuotes(sample);
  console.log(`${Date.now() - t1} ms.`);
  const failed = sample.filter((a) => !quotes[a.symbol]);
  if (failed.length) { console.error(`\n${failed.length} failed. Check the key, the symbol list in src/assets.js, and the rate limits.`); process.exit(1); }
  console.log('\nAll good. Stocks only move during US market hours; crypto never sleeps.');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
