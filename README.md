# Trickle Down — backend

Express + Postgres API for the daily charity day-trading game. The front end
lives in `trickledown-stevenhester-com` and runs on GitHub Pages.

## How the game works (what this server enforces)

- Every day a player loads the game they get play money: `DAILY_BASE` ($100),
  plus `STREAK_BONUS` ($10) for each consecutive day beyond the first, capped at
  `DAILY_CAP` ($200). Granted at most once per game day; the game day rolls over
  at local midnight in `GAME_TZ`.
- A buy locks in the live price and lives `HOLD_HOURS` (24). Its value is
  `invested × (1 + multiplier_now × real_move)`, floored at zero, where
  `multiplier_now` ramps linearly from `MULT_FLOOR` (×1) at purchase to the
  position's full multiplier at maturity: stocks ×10, crypto ×5 (`MULT_STOCK`,
  `MULT_CRYPTO`). The full multiplier is stored on the position, so changing
  the config later doesn't rewrite history.
- At maturity the position freezes: `src/maturer.js` runs every
  `MATURE_POLL_MS` (60s), quotes anything past `matures_at`, and stores
  `matured_price` / `matured_value` at the full multiplier. `/me` and `/sell`
  also freeze lazily, so a late timer never shows a matured position moving.
- `/sell` is both "collect" and "sell early": a matured position pays out its
  frozen value in full; a live one re-quotes and pays out at the current price
  and current multiplier. A profit is taxed `TAX_RATE` (25%); losses aren't.
  A position at zero can be "buried" (same endpoint). The receipt and history
  carry `collected: true|false`.
- `/ride` ("let it ride") is the third option for a matured position: the
  frozen value is reinvested in the same asset at today's price as a new
  position (status of the old one becomes `rolled`, which keeps it out of
  history and the boards). No tax, no lobbyists, the clock and the multiplier
  ramp start over. `ride_count` and `origin_invested` follow the chain so the
  UI can say "riding ×3, started with $50".
- **The tax hires lobbyists.** Every play-money dollar of tax hires one
  lobbyist for a charity the player picks. In the database and the API these
  are still called `donations` / `total_donated` (one lobbyist = $1 of tax);
  the front end never shows them as dollars, because they aren't.
- `/trickle` reports each charity's share of all lobbyists this quarter.
  `POOL_USD` is the real ad revenue you've collected; the page shows what each
  charity's share of it would be by headcount. Update it by hand until ads exist.
- **Lobbyfest** is the quarter boundary: local midnight in `GAME_TZ` on the
  first day of the next quarter (`quarter_ends_at` on `/me`, `/trickle` and
  `/leaderboard`). Nothing needs to run at that moment: donations are tagged
  with their quarter when they happen, so "this quarter's lobbyists"
  (`user.quarter_donated`, `donations_by_charity`, the standings) roll to
  zero on their own, while `total_donated` and the career ranks keep counting.
  What you do at Lobbyfest is read `/trickle` for the closing quarter and send
  the real money.
- `DEMO_MODE=true` (the default) makes the site say plainly that the charities
  are fictional and nothing real is moving. The seed list in `src/charities.js`
  is deliberately made up for that reason.

## Endpoints

| Method | Path | Auth | What |
| --- | --- | --- | --- |
| GET | `/health` | | liveness + which price provider is active |
| GET | `/config` | | rules, badges, today's day key / reset time |
| GET | `/assets` | | the tradable list (`src/assets.js`) |
| GET | `/quote/:symbol` | | live price + day change |
| GET | `/charities` | | active charities (`src/charities.js`) |
| POST | `/auth/guest` | | create a guest account, returns a token |
| POST | `/auth/register` | | username + password |
| POST | `/auth/login` | | username + password |
| POST | `/auth/claim` | ✓ | give a guest account a username + password |
| GET | `/me` | ✓ | grants today's money if due; portfolio with live values, history, today's crowd picks |
| POST | `/buy` | ✓ | `{ symbol, amount }` |
| POST | `/sell` | ✓ | `{ position_id, charity_id }` — collects a matured position in full, or sells a live one early (charity required only when there's a profit) |
| POST | `/ride` | ✓ | `{ position_id }` — let a matured position ride: its frozen value becomes a fresh 24h position in the same asset at today's price, untaxed |
| GET | `/trickle` | | per-charity shares this quarter + all time |
| GET | `/leaderboard` | | all-time donations; best lock-in in the last 24h |

Auth is a Bearer JWT in the `Authorization` header. Tokens last 180 days.

## Prices

- Stocks: [Finnhub](https://finnhub.io) `/quote` — free key, 60 calls/min.
- Crypto: CoinGecko `simple/price` — no key. Finnhub `BINANCE:XXXUSDT` as a fallback.
- Quotes are cached in memory for `QUOTE_CACHE_MS` (60s), so a player buying and
  selling inside a minute sees the same price. That's intended.
- With no `FINNHUB_API_KEY`, the server runs with `PRICE_PROVIDER=mock`:
  deterministic made-up prices that drift, so you can develop offline.

The free Finnhub tier is plenty for a demo. If the site grows, the cheap
upgrade is a nightly job that stores daily closes, which also enables a true
"24-hour portfolio change" leaderboard.

One quirk worth knowing: stocks don't trade on weekends, so a stock bought on
Friday afternoon barely moves before it matures Saturday afternoon (it still
freezes at Finnhub's last price). Crypto moves all weekend. That's a feature
until someone says otherwise; a weekday-only clock for stocks would be a
small change in `game.effectiveMultiplier` and `maturer.js`.

## Run locally

```
cp .env.example .env     # edit DATABASE_URL at minimum
npm install
npm start                # migrates on boot, listens on :3000
npm run smoke            # exercises the whole loop against localhost:3000
```

`src/migrate.js` creates tables if missing and upserts the charity list, and
runs on every boot, so there is no separate migration step.

## Deploy to Heroku

```
heroku create trickledown-api
heroku addons:create heroku-postgresql:essential-0
heroku config:set JWT_SECRET="$(openssl rand -hex 32)"
heroku config:set FINNHUB_API_KEY=your_key
heroku config:set CORS_ORIGIN=https://stevenbhester.github.io,https://trickledown.stevenhester.com
heroku config:set GAME_TZ=America/Chicago LAUNCH_DATE=$(date +%F)
git push heroku main
heroku logs --tail
```

Then put the app's URL into the front end's `config.js`.

Heroku Postgres requires SSL; `src/db.js` turns it on automatically for any
non-localhost `DATABASE_URL`.

## Files

```
src/server.js     express app, CORS, boot-time migrate
src/routes.js     every endpoint
src/game.js       the rules as pure functions (day keys, multiplier ramp, value, tax, tiers, ranks)
src/maturer.js    freezes positions at maturity (timer + lazy)
src/prices.js     Finnhub / CoinGecko / mock, with a cache
src/assets.js     the curated tradable list
src/charities.js  the curated charity list (seeded into the DB)
src/auth.js       bcrypt + JWT helpers, requireUser middleware
src/db.js         pg pool + transaction helper
src/migrate.js    schema + seed
scripts/smoke.sh  end-to-end check
```

## Before real money moves

Things the demo deliberately leaves out:

- **Charity list.** The seed list is fictional. Replace it with real
  organizations you've vetted (Charity Navigator or your grader of choice, with
  a minimum grade), then set `DEMO_MODE=false`. Rows are upserted by slug on
  boot and anything you remove from the file is retired, so editing
  `src/charities.js` is enough.
- **Disbursement.** Something like Every.org can pay many charities from one
  pot with receipts. Post those receipts on the Trickle page.
- **Legal.** Several US states regulate "commercial co-ventures" (businesses
  advertising that activity benefits a charity). Worth a short conversation
  with someone who knows before the first real payout. Not legal advice.
- **Abuse.** No rate limiting, no CAPTCHA on guest creation. Add
  `express-rate-limit` on `/auth/*` and `/buy` before announcing it anywhere big.
- **Ads.** The footer has a labelled placeholder slot.

## Roadmap (ideas from the design sessions, not built)

- **True 24h leaderboard** — portfolio value now vs 24 hours ago. Needs stored
  price history (nightly closes). The current "best lock-in in the last 24h"
  board is the cheap proxy.
- **Collectible rewards** — ranks exist (Intern → Shadow Cabinet, computed
  from lobbyists hired). Making them visible on share cards, and adding
  non-lobbying badges (first bust, 7-day streak, "bought the top"), is UI work.
- **Double-or-nothing** — a roulette-style gamble on locked-in gains that does
  not touch the leaderboards. Keep it strictly play money and purely cosmetic
  to the charity math, or it drifts toward gambling-adjacent territory.
- **Streak freeze** — one missed day forgiven per month, Duolingo-style.
- **Friends boards** — leaderboard filtered to people you follow.
