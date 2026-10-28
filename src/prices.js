// Live prices with a short in-memory cache, and a mock provider for offline dev.
//
//   stocks  Finnhub /quote (free tier: 60 calls/min, US listings, needs a key)
//   crypto  CoinGecko simple/price, one batched call for every coin needed;
//           Finnhub BINANCE:XXXUSDT as a per-coin fallback
//
// A quote is { price, change_pct, traded_at, source, at, stale }.
//   change_pct  the asset's own day move (vs previous close for stocks, 24h
//               for crypto), shown in the picker
//   traded_at   when the price last changed; a stock with an old traded_at
//               means the market is closed
//   stale       true when a provider failed and this is the last good quote
//               (up to an hour old) rather than a fresh one
//
// Quotes are cached QUOTE_CACHE_MS (60s). A player who buys and sells inside
// a minute sees the same price; that's intended.

const cfg = require('./config');

const cache = new Map();     // symbol -> { quote, expires }
const lastGood = new Map();  // symbol -> quote, kept for an hour past expiry
const STALE_MS = 60 * 60e3;

const FINNHUB = process.env.FINNHUB_URL || 'https://finnhub.io/api/v1';
const COINGECKO = process.env.COINGECKO_URL || 'https://api.coingecko.com/api/v3';

async function fetchJson(url, headers = {}) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`${res.status} from ${new URL(url).host}`);
  return res.json();
}
const iso = (secs) => (secs ? new Date(secs * 1000).toISOString() : null);

// Finnhub's free tier allows 60 calls a minute. Spend at most FINNHUB_BUDGET
// of them ourselves, so a burst of lookups degrades to stale quotes instead
// of a 429 that takes the maturer and every /me down with it.
const budget = { minute: 0, used: 0 };
function finnhubAllowed() {
  const m = Math.floor(Date.now() / 60e3);
  if (budget.minute !== m) { budget.minute = m; budget.used = 0; }
  if (budget.used >= cfg.finnhubBudget) return false;
  budget.used++;
  return true;
}

async function finnhubQuote(symbol) {
  if (!cfg.finnhubKey) throw new Error('FINNHUB_API_KEY is not set');
  if (!finnhubAllowed()) throw new Error(`finnhub budget spent this minute (${cfg.finnhubBudget})`);
  const q = await fetchJson(`${FINNHUB}/quote?symbol=${encodeURIComponent(symbol)}&token=${encodeURIComponent(cfg.finnhubKey)}`);
  // Finnhub answers unknown symbols with 200 and zeros.
  if (!q || !(q.c > 0)) throw new Error(`no price for ${symbol}`);
  return { price: q.c, change_pct: q.dp != null ? q.dp / 100 : null, traded_at: iso(q.t), source: 'finnhub', at: new Date().toISOString(), stale: false };
}

// One call for every coin in the list. Returns a map symbol -> quote for the
// ones CoinGecko knew about.
async function coingeckoQuotes(assets) {
  const headers = cfg.coingeckoKey ? { 'x-cg-demo-api-key': cfg.coingeckoKey } : {};
  const ids = [...new Set(assets.map((a) => a.cg))].join(',');
  const data = await fetchJson(
    `${COINGECKO}/simple/price?ids=${encodeURIComponent(ids)}&vs_currencies=usd&include_24hr_change=true&include_last_updated_at=true`,
    headers,
  );
  const out = {};
  for (const a of assets) {
    const row = data && data[a.cg];
    if (!row || !(row.usd > 0)) continue;
    out[a.symbol] = {
      price: row.usd,
      change_pct: row.usd_24h_change != null ? row.usd_24h_change / 100 : null,
      traded_at: iso(row.last_updated_at),
      source: 'coingecko', at: new Date().toISOString(), stale: false,
    };
  }
  return out;
}

// --- Mock provider -----------------------------------------------------------
// Deterministic per symbol, drifts over time so buys and sells differ. Good
// enough to develop the whole loop without a key or network.

function hash(s) {
  let h = 2166136261;
  for (const ch of s) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return (h >>> 0) / 4294967295;
}

function mockQuote(asset) {
  const seed = hash(asset.symbol);
  const base = asset.type === 'crypto' ? 10 + seed * 90000 : 5 + seed * 600;
  const t = Date.now() / 1000;
  const vol = asset.type === 'crypto' ? 0.04 : 0.015;
  const move = vol * (Math.sin(t / 90 + seed * 7) + 0.4 * Math.sin(t / 11 + seed * 3));
  const price = +(base * (1 + move)).toFixed(asset.type === 'crypto' && base < 1 ? 6 : 2);
  return { price, change_pct: move, traded_at: new Date().toISOString(), source: 'mock', at: new Date().toISOString(), stale: false };
}

// --- Fetching with cache, batching and a stale fallback ------------------------

function remember(symbol, quote) {
  cache.set(symbol, { quote, expires: Date.now() + cfg.quoteCacheMs });
  lastGood.set(symbol, quote);
  return quote;
}
function staleFor(symbol) {
  const q = lastGood.get(symbol);
  if (!q || Date.now() - new Date(q.at).getTime() > STALE_MS) return null;
  return { ...q, stale: true };
}

// Run fn over items with at most n in flight.
async function pooled(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]).then((v) => ({ ok: true, v }), (e) => ({ ok: false, e })); }
  }));
  return out;
}

// Returns a map symbol -> quote | null (null when nothing, not even a stale
// quote, is available).
async function getQuotes(assets) {
  const unique = [...new Map(assets.map((a) => [a.symbol, a])).values()];
  const out = {};
  const need = [];
  for (const a of unique) {
    const hit = cache.get(a.symbol);
    if (hit && hit.expires > Date.now()) out[a.symbol] = hit.quote; else need.push(a);
  }
  if (!need.length) return out;

  if (cfg.priceProvider === 'mock') {
    for (const a of need) out[a.symbol] = remember(a.symbol, mockQuote(a));
    return out;
  }

  const coins = need.filter((a) => a.type === 'crypto');
  const stocks = need.filter((a) => a.type !== 'crypto');

  if (coins.length) {
    let got = {};
    try { got = await coingeckoQuotes(coins); } catch (e) { console.warn('coingecko:', e.message); }
    const missing = [];
    for (const a of coins) { if (got[a.symbol]) out[a.symbol] = remember(a.symbol, got[a.symbol]); else missing.push(a); }
    const fb = await pooled(missing, 3, (a) => finnhubQuote(`BINANCE:${a.symbol}USDT`));
    missing.forEach((a, k) => { out[a.symbol] = fb[k].ok ? remember(a.symbol, fb[k].v) : staleFor(a.symbol); });
  }
  if (stocks.length) {
    const res = await pooled(stocks, 5, (a) => finnhubQuote(a.symbol));
    stocks.forEach((a, k) => {
      if (res[k].ok) out[a.symbol] = remember(a.symbol, res[k].v);
      else { console.warn('finnhub:', a.symbol, res[k].e.message); out[a.symbol] = staleFor(a.symbol); }
    });
  }
  return out;
}

async function getQuote(asset) {
  const q = (await getQuotes([asset]))[asset.symbol];
  if (!q) throw new Error(`no price for ${asset.symbol}`);
  return q;
}

module.exports = { getQuote, getQuotes };
