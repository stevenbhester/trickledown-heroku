// Live prices with a short in-memory cache, and a mock provider for offline dev.
//
//   stocks  Finnhub /quote (free tier: 60 calls/min, US listings, needs a key)
//   crypto  CoinGecko simple/price (free, no key), Finnhub as a fallback
//
// A quote is { price, change_pct, source, at }. change_pct is the asset's own
// day move (previous close for stocks, 24h for crypto) and is shown in the
// picker so people can see what the market is doing before they buy.

const cfg = require('./config');

const cache = new Map(); // symbol -> { quote, expires }

const FINNHUB = 'https://finnhub.io/api/v1';
const COINGECKO = 'https://api.coingecko.com/api/v3';

async function fetchJson(url, headers = {}) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`${res.status} from ${new URL(url).host}`);
  return res.json();
}

async function finnhubQuote(symbol) {
  if (!cfg.finnhubKey) throw new Error('FINNHUB_API_KEY is not set');
  const q = await fetchJson(`${FINNHUB}/quote?symbol=${encodeURIComponent(symbol)}&token=${cfg.finnhubKey}`);
  // Finnhub answers unknown symbols with 200 and zeros.
  if (!q || !q.c) throw new Error(`no price for ${symbol}`);
  return { price: q.c, change_pct: q.dp != null ? q.dp / 100 : null, source: 'finnhub', at: new Date().toISOString() };
}

async function coingeckoQuote(asset) {
  const headers = cfg.coingeckoKey ? { 'x-cg-demo-api-key': cfg.coingeckoKey } : {};
  const data = await fetchJson(
    `${COINGECKO}/simple/price?ids=${encodeURIComponent(asset.cg)}&vs_currencies=usd&include_24hr_change=true`,
    headers,
  );
  const row = data && data[asset.cg];
  if (!row || !row.usd) throw new Error(`no price for ${asset.symbol}`);
  return {
    price: row.usd,
    change_pct: row.usd_24h_change != null ? row.usd_24h_change / 100 : null,
    source: 'coingecko',
    at: new Date().toISOString(),
  };
}

async function liveQuote(asset) {
  if (asset.type === 'crypto') {
    try { return await coingeckoQuote(asset); } catch (e) {
      return finnhubQuote(`BINANCE:${asset.symbol}USDT`);
    }
  }
  return finnhubQuote(asset.symbol);
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
  // Slow wave plus a faster wobble; different phase per symbol.
  const move = vol * (Math.sin(t / 90 + seed * 7) + 0.4 * Math.sin(t / 11 + seed * 3));
  const price = +(base * (1 + move)).toFixed(asset.type === 'crypto' && base < 1 ? 6 : 2);
  return { price, change_pct: move, source: 'mock', at: new Date().toISOString() };
}

// --- Public API ----------------------------------------------------------------

async function getQuote(asset) {
  const hit = cache.get(asset.symbol);
  if (hit && hit.expires > Date.now()) return hit.quote;
  const quote = cfg.priceProvider === 'mock' ? mockQuote(asset) : await liveQuote(asset);
  cache.set(asset.symbol, { quote, expires: Date.now() + cfg.quoteCacheMs });
  return quote;
}

// Returns a map symbol -> quote | null (null when the lookup failed).
async function getQuotes(assets) {
  const unique = [...new Map(assets.map((a) => [a.symbol, a])).values()];
  const results = await Promise.allSettled(unique.map((a) => getQuote(a)));
  const out = {};
  unique.forEach((a, i) => {
    out[a.symbol] = results[i].status === 'fulfilled' ? results[i].value : null;
  });
  return out;
}

module.exports = { getQuote, getQuotes };
