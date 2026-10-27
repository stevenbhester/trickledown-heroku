const express = require('express');
const cors = require('cors');
const cfg = require('./config');
const { migrate } = require('./migrate');
const routes = require('./routes');

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(cors({
  origin: cfg.corsOrigins.includes('*') ? true : cfg.corsOrigins,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(express.json({ limit: '16kb' }));

app.get('/', (req, res) => res.json({ name: 'Trickle Down API', docs: 'https://github.com/stevenbhester/heroku-trickledown' }));
app.use('/', routes);

app.use((req, res) => res.status(404).json({ error: 'Not found.' }));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Something broke on our end. Try again.' });
});

migrate()
  .then(() => {
    app.listen(cfg.port, () => {
      console.log(`Trickle Down API on :${cfg.port} (prices: ${cfg.priceProvider}, tz: ${cfg.gameTz})`);
    });
  })
  .catch((e) => {
    console.error('Could not migrate the database:', e);
    process.exit(1);
  });
