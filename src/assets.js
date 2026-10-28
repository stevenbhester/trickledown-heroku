// The tradable universe.
//
// Two layers:
//   CURATED   a hand-picked list with flavor ("mood") that is always present,
//             is what the picker shows before you type, and is the whole
//             universe when there's no live price feed.
//   UNIVERSE  with a Finnhub key, every US-listed common stock, ETF, ADR and
//             REIT on the major exchanges (plain tickers only, no warrants or
//             units), plus the top CoinGecko coins by market cap. Loaded from
//             the database at boot, refreshed from the providers daily, and
//             searched server-side (GET /assets/search?q=) because the list is
//             thousands long.
//
//   symbol     what players see and what the game stores
//   type       'stock' (Finnhub) or 'crypto' (CoinGecko, Finnhub fallback)
//   cg         CoinGecko id (crypto only)
//   mood       flavor label in the picker (curated only); no effect on the math
//              Calm / Normal / Spicy / Unhinged
//   featured   true for the curated list

const cfg = require('./config');

const stocks = [
  ['AAPL', 'Apple', 'Normal'],
  ['MSFT', 'Microsoft', 'Calm'],
  ['NVDA', 'Nvidia', 'Spicy'],
  ['AMZN', 'Amazon', 'Normal'],
  ['GOOGL', 'Alphabet', 'Normal'],
  ['META', 'Meta', 'Normal'],
  ['TSLA', 'Tesla', 'Spicy'],
  ['NFLX', 'Netflix', 'Normal'],
  ['AMD', 'AMD', 'Spicy'],
  ['INTC', 'Intel', 'Normal'],
  ['PLTR', 'Palantir', 'Spicy'],
  ['COIN', 'Coinbase', 'Spicy'],
  ['GME', 'GameStop', 'Unhinged'],
  ['AMC', 'AMC Entertainment', 'Unhinged'],
  ['RIVN', 'Rivian', 'Spicy'],
  ['UBER', 'Uber', 'Normal'],
  ['ABNB', 'Airbnb', 'Normal'],
  ['SPOT', 'Spotify', 'Normal'],
  ['RBLX', 'Roblox', 'Spicy'],
  ['SNAP', 'Snap', 'Spicy'],
  ['DIS', 'Disney', 'Normal'],
  ['NKE', 'Nike', 'Normal'],
  ['SBUX', 'Starbucks', 'Normal'],
  ['MCD', "McDonald's", 'Calm'],
  ['KO', 'Coca-Cola', 'Calm'],
  ['PEP', 'PepsiCo', 'Calm'],
  ['COST', 'Costco', 'Calm'],
  ['WMT', 'Walmart', 'Calm'],
  ['JNJ', 'Johnson & Johnson', 'Calm'],
  ['PFE', 'Pfizer', 'Normal'],
  ['JPM', 'JPMorgan Chase', 'Normal'],
  ['V', 'Visa', 'Calm'],
  ['BA', 'Boeing', 'Normal'],
  ['F', 'Ford', 'Normal'],
  ['GM', 'General Motors', 'Normal'],
  ['XOM', 'ExxonMobil', 'Normal'],
  ['SPY', 'S&P 500 (ETF)', 'Calm'],
  ['QQQ', 'Nasdaq 100 (ETF)', 'Normal'],
  ['GLD', 'Gold (ETF)', 'Calm'],
  ['SLV', 'Silver (ETF)', 'Normal'],
  ['USO', 'Oil (ETF)', 'Spicy'],
  ['TLT', 'US Treasuries (ETF)', 'Calm'],
];

const crypto = [
  ['BTC', 'Bitcoin', 'bitcoin', 'Spicy'],
  ['ETH', 'Ethereum', 'ethereum', 'Spicy'],
  ['SOL', 'Solana', 'solana', 'Unhinged'],
  ['DOGE', 'Dogecoin', 'dogecoin', 'Unhinged'],
  ['XRP', 'XRP', 'ripple', 'Unhinged'],
  ['ADA', 'Cardano', 'cardano', 'Unhinged'],
  ['LTC', 'Litecoin', 'litecoin', 'Spicy'],
  ['LINK', 'Chainlink', 'chainlink', 'Unhinged'],
  ['AVAX', 'Avalanche', 'avalanche-2', 'Unhinged'],
  ['SHIB', 'Shiba Inu', 'shiba-inu', 'Unhinged'],
];

const CURATED = [
  ...stocks.map(([symbol, name, mood]) => ({ symbol, name, mood, type: 'stock', multiplier: cfg.multipliers.stock, featured: true })),
  ...crypto.map(([symbol, name, cg, mood]) => ({ symbol, name, mood, cg, type: 'crypto', multiplier: cfg.multipliers.crypto, featured: true })),
];

// --- The universe ---------------------------------------------------------------

const universe = new Map(CURATED.map((a) => [a.symbol, a]));
let loadedFrom = 'curated';

// Finnhub exchange MICs we take: NYSE, Nasdaq (all tiers), NYSE Arca, NYSE
// American, Cboe BZX. Everything else is OTC, which is where the penny
// stocks live, and the game doesn't need them.
const MICS = new Set(['XNYS', 'XNAS', 'XNGS', 'XNMS', 'XNCM', 'ARCX', 'XASE', 'BATS']);
const TYPES = new Set(['Common Stock', 'ETP', 'ADR', 'REIT']);
const TICKER = /^[A-Z]{1,5}$/;

// "APPLE INC" -> "Apple Inc". Finnhub shouts.
const KEEP = { ETF: 'ETF', LLC: 'LLC', PLC: 'PLC', SPDR: 'SPDR', ISHARES: 'iShares', ADR: 'ADR', REIT: 'REIT', USA: 'USA', US: 'US', SA: 'SA', NV: 'NV', AG: 'AG', SE: 'SE', LP: 'LP', 'S&P': 'S&P', AI: 'AI', IT: 'IT', TV: 'TV', ETC: 'ETC' };
function prettyName(desc) {
  return String(desc || '').trim().split(/\s+/).map((w) => {
    const up = w.toUpperCase();
    if (KEEP[up]) return KEEP[up];
    if (/^[A-Z]&[A-Z]$/.test(up)) return up;
    return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
  }).join(' ').replace(/\s+(Inc|Corp|Co|Ltd)\.?$/i, (m) => m);
}

function setUniverse(list, from) {
  universe.clear();
  for (const a of CURATED) universe.set(a.symbol, a);
  for (const a of list) if (!universe.has(a.symbol)) universe.set(a.symbol, a);
  loadedFrom = from;
}

async function fetchJson(url, headers = {}) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`${res.status} from ${new URL(url).host}`);
  return res.json();
}

// Every tradable US stock and ETF Finnhub lists, filtered to the real exchanges.
async function fetchStocks() {
  const base = process.env.FINNHUB_URL || 'https://finnhub.io/api/v1';
  const rows = await fetchJson(`${base}/stock/symbol?exchange=US&token=${encodeURIComponent(cfg.finnhubKey)}`);
  const out = [];
  for (const r of rows) {
    const symbol = String(r.symbol || '').toUpperCase();
    if (!TICKER.test(symbol) || !TYPES.has(r.type) || !MICS.has(r.mic)) continue;
    const name = prettyName(r.description) || symbol;
    out.push({ symbol, name, type: 'stock', multiplier: cfg.multipliers.stock, exchange: r.mic, kind: r.type === 'ETP' ? 'etf' : 'stock' });
  }
  return out;
}

// The top coins by market cap. Symbols that collide with a stock (or an
// earlier coin) are skipped: the first by market cap keeps the ticker.
async function fetchCoins(taken) {
  const base = process.env.COINGECKO_URL || 'https://api.coingecko.com/api/v3';
  const headers = cfg.coingeckoKey ? { 'x-cg-demo-api-key': cfg.coingeckoKey } : {};
  const rows = await fetchJson(`${base}/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=${cfg.cryptoTop}&page=1`, headers);
  const out = [];
  for (const r of rows) {
    const symbol = String(r.symbol || '').toUpperCase();
    if (!/^[A-Z0-9]{2,8}$/.test(symbol) || taken.has(symbol)) continue;
    taken.add(symbol);
    out.push({ symbol, name: String(r.name || symbol), type: 'crypto', multiplier: cfg.multipliers.crypto, cg: r.id, kind: 'crypto' });
  }
  return out;
}

// Pull the universe from the providers and remember it in the database.
async function refresh(db) {
  if (cfg.priceProvider !== 'live' || cfg.assetUniverse !== 'all') return { skipped: true };
  const list = await fetchStocks();
  const taken = new Set([...CURATED.map((a) => a.symbol), ...list.map((a) => a.symbol)]);
  let coins = [];
  try { coins = await fetchCoins(taken); } catch (e) { console.warn('[assets] coingecko list:', e.message); }
  const all = [...list, ...coins];
  setUniverse(all, 'providers');
  if (db) await save(db, all);
  return { stocks: list.length, coins: coins.length };
}

async function save(db, list) {
  const CHUNK = 500;
  await db.query('UPDATE assets SET active = false');
  for (let i = 0; i < list.length; i += CHUNK) {
    const part = list.slice(i, i + CHUNK);
    const values = [], params = [];
    part.forEach((a, k) => {
      const n = k * 6;
      values.push(`($${n + 1}, $${n + 2}, $${n + 3}, $${n + 4}, $${n + 5}, $${n + 6}, true, now())`);
      params.push(a.symbol, a.name, a.type, a.cg || null, a.exchange || null, a.kind || a.type);
    });
    await db.query(
      `INSERT INTO assets (symbol, name, type, cg, exchange, kind, active, updated_at) VALUES ${values.join(', ')}
       ON CONFLICT (symbol) DO UPDATE SET name = EXCLUDED.name, type = EXCLUDED.type, cg = EXCLUDED.cg, exchange = EXCLUDED.exchange, kind = EXCLUDED.kind, active = true, updated_at = now()`,
      params,
    );
  }
}

async function loadFromDb(db) {
  const { rows } = await db.query('SELECT symbol, name, type, cg, exchange, kind FROM assets WHERE active');
  if (!rows.length) return false;
  setUniverse(rows.map((r) => ({ symbol: r.symbol, name: r.name, type: r.type, cg: r.cg || undefined, exchange: r.exchange || undefined, kind: r.kind, multiplier: r.type === 'crypto' ? cfg.multipliers.crypto : cfg.multipliers.stock })), 'database');
  return true;
}

// Boot: whatever the database has is good enough to serve; then refresh from
// the providers in the background and again every day.
function start(db) {
  loadFromDb(db).then((had) => {
    console.log(`[assets] ${universe.size} symbols (${had ? 'from the database' : 'curated only'})`);
    const tick = () => refresh(db)
      .then((r) => { if (!r.skipped) console.log(`[assets] refreshed: ${r.stocks} stocks, ${r.coins} coins, ${universe.size} total`); })
      .catch((e) => console.warn('[assets] refresh failed:', e.message));
    setTimeout(tick, had ? 60_000 : 2_000);
    const t = setInterval(tick, 24 * 3600e3);
    if (t.unref) t.unref();
  }).catch((e) => console.warn('[assets] load failed:', e.message));
}

// --- Lookup and search -------------------------------------------------------------

function find(symbol) { return universe.get(String(symbol || '').toUpperCase()) || null; }

// Ranked: exact ticker, ticker prefix, name starts with, a word of the name
// starts with, name contains. Featured first within a rank, then shorter
// tickers (AAPL before AAPLW-style noise), then alphabetical.
function search(q, limit = 25) {
  const needle = String(q || '').trim().toLowerCase();
  if (!needle) return CURATED.slice(0, limit);
  const up = needle.toUpperCase();
  const scored = [];
  for (const a of universe.values()) {
    const sym = a.symbol, name = a.name.toLowerCase();
    let rank = null;
    if (sym === up) rank = 0;
    else if (sym.startsWith(up)) rank = 1;
    else if (name.startsWith(needle)) rank = 2;
    else if (name.split(/[\s(]+/).some((w) => w.startsWith(needle))) rank = 3;
    else if (needle.length >= 3 && name.includes(needle)) rank = 4;
    if (rank === null) continue;
    scored.push([rank, a.featured ? 0 : 1, sym.length, sym, a]);
  }
  scored.sort((x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2] || (x[3] < y[3] ? -1 : 1));
  return scored.slice(0, limit).map((s) => s[4]);
}

module.exports = {
  CURATED,
  ASSETS: CURATED, // what the picker shows before you type (and the whole game without a live feed)
  find,
  search,
  size: () => universe.size,
  source: () => loadedFrom,
  start,
  refresh,
};
