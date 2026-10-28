const express = require('express');
const cors = require('cors');
const cfg = require('./config');
const { migrate } = require('./migrate');
const routes = require('./routes');
const maturer = require('./maturer');
const housekeeping = require('./housekeeping');
const auth = require('./auth');

// Refuse to run a real deployment with development settings.
function preflight() {
  const problems = [];
  if (cfg.isProduction) {
    if (cfg.jwtSecret === 'dev-secret-change-me' || cfg.jwtSecret.length < 32) problems.push('JWT_SECRET must be set to a long random value (try: openssl rand -hex 32).');
    if (cfg.corsOrigins.includes('*')) problems.push('CORS_ORIGIN must list your site(s), e.g. https://stevenbhester.github.io,https://trickledown.stevenhester.com');
    for (const k of ['GOOGLE_CERTS_URL', 'FINNHUB_URL', 'COINGECKO_URL']) if (process.env[k]) problems.push(`${k} is a test hook; unset it in production.`);
    if (cfg.priceProvider === 'mock') console.warn('[trickledown] PRICE_PROVIDER=mock in production: prices are invented. Set FINNHUB_API_KEY.');
    if (cfg.demoMode) console.warn('[trickledown] DEMO_MODE=true: the site says the charities are fictional. Fine until the list is real.');
  }
  if (problems.length) { console.error('[trickledown] Refusing to start:\n - ' + problems.join('\n - ')); process.exit(1); }
}
preflight();

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

// Heroku terminates TLS and tells us the original scheme. Plain HTTP would
// send tokens in the clear, so refuse it in production.
app.use((req, res, next) => {
  if (cfg.isProduction && req.get('x-forwarded-proto') === 'http') return res.status(403).json({ error: 'Use https.' });
  next();
});
app.use(auth.securityHeaders);
app.use(cors({
  origin: cfg.corsOrigins.includes('*') ? true : cfg.corsOrigins,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  maxAge: 600,
}));
app.use(express.json({ limit: '16kb' }));

app.get('/', (req, res) => res.json({ name: 'Trickle Down API', docs: 'https://github.com/stevenbhester/heroku-trickledown' }));
app.use('/', routes);

app.use((req, res) => res.status(404).json({ error: 'Not found.' }));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err && (err.type === 'entity.parse.failed' || err.type === 'entity.too.large')) {
    return res.status(400).json({ error: err.type === 'entity.too.large' ? 'That request is too big.' : "Couldn't read that request. Send JSON." });
  }
  console.error(err);
  res.status(500).json({ error: 'Something broke on our end. Try again.' });
});

migrate()
  .then(() => {
    maturer.start(cfg.maturePollMs);
    housekeeping.start();
    app.listen(cfg.port, () => {
      console.log(`Trickle Down API on :${cfg.port} (prices: ${cfg.priceProvider}, tz: ${cfg.gameTz}, hold: ${cfg.holdHours}h)`);
    });
  })
  .catch((e) => {
    console.error('Could not migrate the database:', e);
    process.exit(1);
  });
