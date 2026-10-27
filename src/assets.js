// The tradable universe. Keep it curated: cheaper on price APIs, and no
// penny-stock nonsense. Edit freely.
//
//   symbol   what players see and what the game stores
//   type     'stock' (Finnhub) or 'crypto' (CoinGecko, Finnhub fallback)
//   cg       CoinGecko id (crypto only)
//   mood     flavor label shown in the picker; does not change the math
//            Calm / Normal / Spicy / Unhinged

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

const ASSETS = [
  ...stocks.map(([symbol, name, mood]) => ({
    symbol, name, mood, type: 'stock', multiplier: cfg.multipliers.stock,
  })),
  ...crypto.map(([symbol, name, cg, mood]) => ({
    symbol, name, mood, cg, type: 'crypto', multiplier: cfg.multipliers.crypto,
  })),
];

const BY_SYMBOL = new Map(ASSETS.map((a) => [a.symbol, a]));

module.exports = {
  ASSETS,
  find: (symbol) => BY_SYMBOL.get(String(symbol || '').toUpperCase()) || null,
};
