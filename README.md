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
- At maturity the position freezes: `matured_price` / `matured_value` are
  stored at the full multiplier and it stops moving until collected. Three
  things do the freezing, in this order of preference: a Heroku Scheduler job
  (`node scripts/mature.js`, every 10 minutes; see DEPLOY.md) that runs
  whether or not the web dyno is awake; the web dyno's own timer
  (`MATURE_POLL_MS`, 60s) while it is; and `/me`, `/sell`, `/ride` and
  `/players` for the rows in front of them. A freeze more than
  `MATURE_LATE_MS` (10 min) after the mark uses the price the game logged
  nearest the mark (`price_log`: every quote fetched, one row per symbol per
  minute, kept `PRICE_LOG_DAYS` = 7); if there is none, it uses the current
  price and sets `matured_late`, which the receipt admits to. So nothing
  grows while a player is away, and a position's value is logged at (or
  within ten minutes of) 24 hours from purchase.
- `/sell` is both "collect" and "sell early": a matured position pays out its
  frozen value in full; a live one re-quotes and pays out at the current price
  and current multiplier. A profit is taxed `TAX_RATE` (25%); losses aren't.
  A position at zero can be "buried" (same endpoint). The receipt and history
  carry `collected: true|false`.
- `/ride` ("let it ride") is the third option for a matured position: the
  profit so far is taxed at `TAX_RATE × RIDE_TAX_FACTOR` (12.5% by default,
  half the collect rate), those lobbyists are hired for the chosen charity,
  and what's left is reinvested in the same asset at today's price as a new
  position. The old one's status becomes `rolled`; it shows in history with
  `rode: true` and counts on the 24h board. `ride_count` and `origin_invested`
  follow the chain so the UI can say "riding ×3, started with $50".
  - **The multiplier keeps climbing.** The new position's `mult_floor` is the
    old ceiling and its `multiplier` is one base multiplier higher: stocks
    ×10 → ×20 on the second day, ×20 → ×30 on the third; crypto ×5 → ×10 →
    ×15. After `RIDE_MAX_STEPS` (2) rides it runs flat at the cap. A ride
    at ×20 dies on a 5% dip, which is the point.
  - **The other half of the tax is deferred**, stored as `deferred_tax` on
    the new position. Sell the ride early and it comes due (so an early sell
    of a ride really is full rate on the original profit, plus the usual tax
    on anything new); hold it to maturity and it's forgiven. Without this,
    ride-then-sell-early seconds later at the same cached price realized the
    gain at half tax with no risk taken. Without any tax at all, riding was
    strictly better than collecting and the charity never saw a cent.
- **Day one** would otherwise be "buy, then wait 24 hours". So once a
  player has invested anything, `/me` offers `vesting`: their shares in
  Trickle Down Holdings have vested and policy says sell, for `VEST_AMOUNT`
  of pure profit (a `vested` position with `invested = 0`, kept off the
  gain boards). It's taxed like any win, which hires their first lobbyists
  and opens TrickleTown on the spot. Once per account (`users.vested_at`).
- **Money is shown in thousands.** The database and API deal in units
  ($100 a day, $40 to build); the front end renders a unit as $1K and a
  thousand as $1M, one decimal at most, so the numbers feel like a hedge
  fund's. Real stock prices stay real.
- **The tax hires lobbyists.** Every play-money dollar of tax hires one
  lobbyist for a charity the player picks. In the database and the API these
  are still called `donations` / `total_donated` (one lobbyist = $1 of tax);
  the front end never shows them as dollars, because they aren't.
- `/trickle` reports each charity's share of all lobbyists this quarter.
  `POOL_USD` is the real ad revenue you've collected (update it by hand until
  ads exist). The page shows what each charity would get by the published
  rules (`game.lobbyfestSplit`): at least $100 goes out (the owners top up),
  shares are by headcount, and any charity under $5 is left out and the split
  reruns. The rules are public promises (☰ → Mission & promises): change the
  page and `LOBBYFEST` in `src/game.js` together. Rollover of left-out
  charities and the wealth tax are promised but done by hand for now.
- **Lobbyfest** is the quarter boundary: local midnight in `GAME_TZ` on the
  first day of the next quarter (`quarter_ends_at` on `/me`, `/trickle` and
  `/leaderboard`). Nothing needs to run at that moment: donations are tagged
  with their quarter when they happen, so "this quarter's lobbyists"
  (`user.quarter_donated`, `donations_by_charity`, the standings) roll to
  zero on their own, while `total_donated` and the career ranks keep counting.
  What you do at Lobbyfest is read `/trickle` for the closing quarter and send
  the real money.
- The charities in `src/charities.js` are real (4 stars on Charity Navigator).
  `DEMO_MODE=true` (off by default) adds notes that the money is pretend, for
  a test copy.

## TrickleTown

`src/town.js` is the village: two plots (housing, town square), each with an
extractive / compromise / decent building and two upgrades per building, and
two scores: **profit** (dollars a day added to, or taken from, the allowance)
and **happiness** (0–100; sets the lobbyist price, $1.4K a head at 0 to $500
at 100, and drifts back toward 55). Cards push those two plus one-time cash.
Every day Preston and Dolores bring a headline everyone gets plus at least two
cards from whatever the player's town has unlocked (a building, an upgrade, a
career headcount, cash on the coin at dawn, friends, a streak, days played, a
flag set by an earlier card, or happiness past a threshold), or half the
unplayed backlog if that's more (max 6). A card unlocked during the day by an
action joins today's agenda. A choice that leads to a follow-up is tagged with
how that tends to go (`later`: good / bad / mixed). 77 cards as of this
writing. The town opens once the player has hired one full lobbyist. The file
is pure rules and is byte-identical to the front end's `js/town.js`; edit one,
copy to the other. `/me` returns the whole view (`town`), including every
card's unlock status for the deck grid.

## Endpoints

| Method | Path | Auth | What |
| --- | --- | --- | --- |
| GET | `/health` | | liveness + which price provider is active |
| GET | `/config` | | rules, badges, today's day key / reset time |
| GET | `/assets` | | the featured list (curated, with moods), plus `count` of the whole universe and `search: true` |
| GET | `/assets/search?q=` | | up to 25 matches from the universe, ranked: exact ticker, ticker prefix, name prefix, name word, name contains |
| GET | `/quote/:symbol` | | live price + day change; `?fresh=1` asks for one no older than `FRESH_QUOTE_MS` |
| GET | `/quotes?symbols=A,B,C` | | up to 12 at once, same `?fresh=1`; what the front end's live ticker polls |
| GET | `/charities` | | active charities (`src/charities.js`), with `donate` (the charity's own giving page) |
| POST | `/auth/guest` | | create a guest account, returns a token |
| POST | `/auth/register` | | username + password |
| POST | `/auth/login` | | username + password |
| POST | `/auth/claim` | ✓ | give a guest account a username + password |
| GET | `/me` | ✓ | grants today's money if due (allowance plus the town's profit); portfolio with live values, history, today's crowd picks; `achievements` (earned/claimed/progress, newly earned ones recorded here); `fresh_cards`: titles of cards that unlocked since the last look and were added to today's agenda; `user.last_seen_at` is the visit *before* this one and `town.expired_yesterday` the cards left unplayed yesterday (for "While you were out") |
| GET | `/positions/review?ids=1,2` | ✓ | the welcome-back performance review: for your own matured positions in `ids` (up to 40), plus your live ones over the same stretch, each position's value from its buy to its 24-hour mark as `points: [[ms, dollars], ...]` (worked out from `price_log` with the coin's own math, thinned to ~90; matured lines end exactly at the frozen value); `start` is the earliest buy, `end` the latest maturity. Someone else's ids return nothing |
| POST | `/buy` | ✓ | `{ symbol, amount }` |
| GET | `/achievements` | ✓ | the trophy case: every achievement with gift, giver, earned/claimed dates and progress; records anything newly earned |
| POST | `/achievements/claim` | ✓ | `{ key, charity_id? }` — take an earned achievement's gift from Mommy & Daddy: pure profit, taxed like any win, so it hires lobbyists (`charity_id` only matters before the player has a default). Recorded as a closed `gift` position |
| POST | `/vest` | ✓ | older clients: same as claiming `first_buy` (the day-one gift, `VEST_AMOUNT`) |
| POST | `/sell` | ✓ | `{ position_id, charity_id? }` — collects a matured position in full, or sells a live one early. `charity_id` (here, on `/vest` and on `/ride`) only matters when the player has no default charity yet: it becomes the default. With a default set, new lobbyists always go there |
| POST | `/ride` | ✓ | `{ position_id, charity_id? }` — let a matured position ride: profit taxed at half rate now (the other half deferred), the rest becomes a fresh 24h position in the same asset at today's price with the multiplier climbing from where it ended |
| GET | `/trickle` | | per-charity shares this quarter + all time, with `rank`, `gap_to_next` (lobbyists behind the charity one place up; 0 for the leader) and `donate` |
| GET | `/lobbyfests` | | past Lobbyfests, newest first: quarter, paid date, pot (real dollars), receipt link, notes, and each charity's lobbyists and dollars |
| GET | `/events/current` | | events running today (`featured_charity`: lobbyists hired for that charity count ×`multiplier`, 1.25 by default) |
| GET | `/push/key` | | the VAPID public key for daily reminders (null when they're not set up) and the hour they go out |
| POST | `/push/subscribe` | ✓ | `{ subscription, tz }` — turn on the daily reminder for this device. The endpoint must be a real push service (FCM, Mozilla, Apple, Windows); five devices a player |
| POST | `/push/unsubscribe` | ✓ | `{ endpoint? }` — this device, or all of yours |
| POST | `/town/decide` | ✓ | `{ issue_id, side }` — play one of today's cards with Preston's or Dolores's answer; returns the real `fx` and `crowd` (how everyone else answered it today) |
| POST | `/town/build` | ✓ | `{ slot, key }` — put a building on a plot ($40); replacing one clears its upgrades |
| POST | `/town/upgrade` | ✓ | `{ slot, key }` — buy an upgrade for the building on a plot |
| POST | `/town/upgrade/pass` | ✓ | `{ slot, key }` — side with whoever objects to an upgrade that's on the table: nothing is bought, it stops counting in the plot's `proposals`, and it stays for sale with `passed: true` (buying it later clears that; a new building clears all passes). Returns `who` (the objector) |
| GET | `/ledger` | ✓ | your money, newest first, 60 at a time (`?cursor=` from the last page): buys, sales, collections, gifts, achievements, card plays, buildings, upgrades, cat items, admin adjustments, each with its cash change and, where it applies, a `title` (card), `name` (building/upgrade) or item. Rides, lobbyist moves and admin removals are left out |
| GET | `/leaderboard` | opt | this quarter's standings + career; best cash-out in the last 24h; `biggest`: the 25 largest open positions by current value (priced from quotes the game already has, no provider calls). `?friends=1` (signed in) scopes all three to your friends and you |
| POST | `/lobbyists/assign` | yes | `{ allocation?: [{ charity_id, amount }], default_charity_id? }` — move this quarter's lobbyists between charities (the allocation must account for every one) and/or change the default charity new hires go to |
| GET | `/friends` | ✓ | your friends with quarter/career headcount, streak, rank, town mood; `added_you` = how many players added you |
| POST | `/friends/add` | ✓ | `{ username }` — one-directional; cap 50 |
| POST | `/friends/invite` | ✓ | `{ from }` — a new player starts out following whoever's link brought them (`?from=`). One direction only, the same row "Add friend" makes; the inviter sees "added you" |
| POST | `/friends/remove` | ✓ | `{ username }` |
| GET | `/players/:username` | opt | a player's public sheet: open positions with live values, headcounts, rank, cash in play, favourite charity, town summary, `is_friend` / `added_you` for the viewer. If the owner played "Hide the meters" (card 66) in the last 7 days, everyone else gets `happiness`, `income` and `hire_cost` as null and `meters_hidden: true` (the friends list nulls `town.happiness` the same way) |

| POST | `/auth/google` | | `{ credential }` — sign in or up with a Google ID token |
| POST | `/auth/link-google` | ✓ | `{ credential }` — attach Google to the signed-in account (claims a guest) |
| POST | `/auth/password` | ✓ | `{ current?, password }` — set/change password; signs out other devices |
| POST | `/auth/username` | ✓ | `{ username }` |
| POST | `/auth/logout-all` | ✓ | invalidate every token for this account |
| POST | `/auth/device-code` | ✓ | a one-time `XXXX-XXXX` code, 15 minutes, for signing another device into this account (guests too) |
| POST | `/auth/redeem-code` | | `{ code }` — the other device gets its own token |
| POST | `/admin/grant` | admin | `{ cash?, lobbyists?, username?, charity_id? }` — testing: real rows, so boards and town see them |
| POST | `/admin/reset` | admin | `{ username? }` — a brand-new account: no positions, lobbyists, town, friends on their list, streak or device codes; shares unvested; $100 on the next `/me`. Username and sign-ins stay |
| POST | `/admin/unlock` | admin | `{ issue_id \| issue_ids \| all: true, username? }` — open cards early; they go in the pile for future days |
| POST | `/admin/deal` | admin | `{ issue_id \| all: true, username? }` — put a card (or every unlocked card) on today's agenda now (town must be open and started today) |
| POST | `/admin/transactions/undo` | admin | `{ ref, dry_run? }` — delete one feed row and undo it: a position goes with its ride chain (buy refunded, payouts, lobbyists and P&L taken back, a gift re-opened); allowance, cards, building, the cat and grants give their money (and a grant's lobbyists) back. Cash stops at $0. Records an `admin undo` row |
| GET | `/admin/lobbyists?username=` | admin | a player's lobbyists this quarter, by charity |
| POST | `/admin/lobbyists/remove` | admin | `{ username, take: [{ charity_id, amount }], dry_run? }` — gone, not moved: off this quarter and the all-time count |
| POST | `/admin/users/remove` | admin | `{ usernames: [...], confirm, dry_run? }` — delete accounts and everything of theirs; `confirm` is the username (one) or the count (several). Never admins |
| POST | `/admin/lobbyfests` | admin | `{ quarter, paid_at?, pot, receipt_url?, notes?, payouts: [{ charity_id, lobbyists, usd }] }` — enter (or replace) a quarter's Lobbyfest |
| POST | `/admin/lobbyfests/delete` | admin | `{ quarter }` |
| GET | `/admin/events` | admin | the last 30 events, past and future |
| POST | `/admin/events` | admin | `{ kind: 'featured_charity', charity_id, starts_on, ends_on, multiplier?, title?, blurb? }` — a month at most, ×1 to ×3 |
| POST | `/admin/events/delete` | admin | `{ id }` — end it now; lobbyists already hired keep their count |
| GET | `/auth/options` | | whether Google sign-in is on, and the client id |

Auth is a Bearer JWT (HS256) in the `Authorization` header. Tokens last 180
days and carry the account's `token_version`; a password change or
"sign out everywhere" bumps it, so older tokens stop working immediately.

## Security

- Passwords: bcrypt, cost 12. Minimum 8 characters, not the username, not a
  one-character repeat, not on a short list of the most common passwords.
- Login runs the bcrypt comparison even when the username doesn't exist (against
  a dummy hash), and returns the same message either way, so neither timing nor
  wording reveals which usernames are taken. Usernames are unique ignoring case.
- Rate limits (per IP, in memory): 20 logins / 15 min (and 10 per username),
  10 new accounts / hour, 10 guest accounts / hour, 10 sensitive changes / 15
  min, 30 friend-adds / 15 min, 60 trades / min, 120 reads (`/quote`,
  `/players`) / min. One dyno; move the store to Redis if you scale out.
- Device codes are 8 characters from an unambiguous alphabet (40 bits),
  hashed at rest, single-use, 15 minutes, one live code per account, and
  redeeming shares the login rate limit (20 / 15 min per IP).
- Admin is a username allow-list (`ADMIN_USERNAMES`), checked on the
  signed-in account; the endpoints log who granted what to whom. Admin names
  are reserved (no sign-up, claim or rename into one; admins can't rename
  away), so the allow-list can't be joined by grabbing a name.
- Tokens slide: `/me` returns a fresh `token` once the current one is past
  half its 180 days, so a guest who keeps playing is never signed out of an
  account they can't sign back into. `token_version` still revokes.
- Finnhub calls are budgeted (`FINNHUB_BUDGET`, 50/min of their free 60), so a
  burst degrades to stale quotes instead of a 429 that stalls the maturer.
  `/buy` and `/ride` refuse a stale quote; collecting never needs one.
- **The live ticker.** After a buy the front end polls `/quotes?fresh=1`
  every 3 seconds, backing off to once a minute while the page stays open,
  and starts over fast on the next buy. A fresh quote may be up to
  `FRESH_QUOTE_MS` (4s) old; each stock in it is one Finnhub call when it
  isn't. One player with three live stocks at full tilt is ~60 calls a
  minute, which is the whole free tier, so with more than a couple of
  simultaneous players the budget runs out and the ticker quietly serves
  the cached quote until the next minute. Finnhub's paid tiers raise the
  limit; raise `FINNHUB_BUDGET` to match. Crypto is one batched CoinGecko
  call regardless.
- In production the server also refuses to start with `GOOGLE_CERTS_URL`,
  `FINNHUB_URL` or `COINGECKO_URL` set (test hooks).
- Google: ID tokens are verified against Google's JWKS (RS256 by `kid`),
  issuer, audience and expiry, with no library in between. Accounts key on
  `sub`. Linking requires being signed in; nothing is matched by email.
- Headers: `nosniff`, `no-referrer`, `no-store`, `DENY` framing, HSTS in
  production. CORS is locked to `CORS_ORIGIN`. Bodies are capped at 16 KB.
- The server refuses to boot in production with a weak `JWT_SECRET` or
  `CORS_ORIGIN=*`.
- The front end keeps the token in `localStorage` and sends it as a Bearer
  header (no cookies, so no CSRF). Every piece of user-supplied text is
  escaped before it's rendered.
- Friends and player sheets expose only what the leaderboards already show
  plus play-money game state (open positions, town mood). Never email, never
  Google ids, never anything from Account. Adding is one-way and silent.
- Guest accounts that never hired anyone and haven't been seen for
  `GUEST_TTL_DAYS` (45) are deleted once a day (`src/housekeeping.js`), with
  their positions, so abandoned guests don't pile up.
- Plain `http://` is refused in production (Heroku's `x-forwarded-proto`).
- The front end says all of this to anyone setting a password ("Beta. Don't
  reuse a password from anywhere else."), including what's not done.
- Not done: email/password reset (there's no email), 2FA, CAPTCHA. For a game
  with no real money in player accounts, that's a reasonable place to stop.

## The universe

With a Finnhub key, `src/assets.js` loads every US-listed common stock, ETF,
ADR and REIT on NYSE, Nasdaq, NYSE Arca, NYSE American and Cboe (plain
tickers only: no warrants, units, preferreds, dotted share classes or OTC),
plus the top `CRYPTO_TOP` (250) coins by market cap from CoinGecko, skipping
any coin whose ticker collides with a stock. That's several thousand names.
The list is stored in the `assets` table, served from there at boot, and
refreshed from the providers a minute after boot and daily. The curated
list (with the Calm/Spicy/Unhinged moods) is always present, is what the
picker shows before you type, and is the whole universe without a live feed
or with `ASSET_UNIVERSE=curated`. Search is server-side.

A symbol that drops out of the list is treated as delisted: open positions
freeze at their entry price and can be collected.

## Prices

- Stocks: [Finnhub](https://finnhub.io) `/quote` — free key, 60 calls/min.
- Crypto: CoinGecko `simple/price` — no key. Finnhub `BINANCE:XXXUSDT` as a fallback.
- Stocks move in regular hours only (9:30–4 Eastern on trading days). The front
  end's `js/market.js` holds NYSE's holidays and early closes (through 2028) and,
  when stocks are quiet, says so on the Buy box and lists crypto first. Add each
  new year's dates there when NYSE publishes them.
- Quotes are cached in memory for `QUOTE_CACHE_MS` (60s), so a player buying and
  selling inside a minute sees the same price. That's intended.
- With no `FINNHUB_API_KEY`, the server runs with `PRICE_PROVIDER=mock`:
  deterministic made-up prices that drift, so you can develop offline.
- The price sampler (`src/sampler.js`) keeps `price_log` dense enough to chart:
  every `SAMPLE_POLL_MS` (2 min) while the web dyno is awake, and on every run
  of the 10-minute scheduler job, it logs a fresh price for every symbol
  someone holds live, stalest first, aiming for one row per symbol every
  `SAMPLE_EVERY_MS` (10 min). Stocks are capped per pass (`SAMPLE_BATCH`, 8;
  20 in the scheduler job) and always leave 25 Finnhub calls a minute for
  players; coins are one CoinGecko call. The welcome-back review draws from it.

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
npm test                 # deck + town rules invariants (no server, no database)
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
src/maturer.js    freezes positions at maturity (scheduler one-off, timer, lazy), late-freeze backstop
src/pricelog.js   a week of every quote the game fetched, for late freezes and the review chart
src/sampler.js    logs held symbols' prices on a schedule, so the overnight chart has points
scripts/mature.js the Heroku Scheduler job: freeze everything due, sample prices, exit
scripts/refreeze.js  one-off repair: re-freeze positions the old scheduler froze at cost (dry run; --apply)
scripts/notify.js the hourly daily-reminder job (web push; needs the VAPID_* vars)
src/prices.js     Finnhub / CoinGecko / mock, with a cache
src/assets.js     the curated tradable list
src/charities.js  the curated charity list (seeded into the DB)
src/auth.js       bcrypt + JWT helpers, password policy, requireUser, security headers
src/google.js     Google ID token verification (JWKS, no deps)
src/ratelimit.js  in-memory per-IP limiter
src/housekeeping.js  daily sweep of abandoned guest accounts
REVIEW.md         the October 2026 critical review: what was found, what changed, what's left
src/town.js       TrickleTown rules + the card deck (byte-identical to the front end's js/town.js)
src/db.js         pg pool + transaction helper
src/migrate.js    schema + seed
scripts/smoke.sh  end-to-end check against a running server
scripts/test-town.js  deck and rules invariants, no server needed (npm test)
scripts/check-prices.js  verify the live price feed with your keys
app.json          Heroku app manifest (addons + env prompts)
DEPLOY.md         step-by-step go-live
```

## Before real money moves

Things the demo deliberately leaves out:

- **Charity list.** Done: 18 real charities, each 4 of 4 stars on Charity
  Navigator as of Oct 29, 2026. Re-check before each payout; edit
  `src/charities.js` (upserted by slug on boot, removals retired).
- **Disbursement.** Something like Every.org can pay many charities from one
  pot with receipts. Post those receipts on the Trickle page.
- **Legal.** Several US states regulate "commercial co-ventures" (businesses
  advertising that activity benefits a charity). Worth a short conversation
  with someone who knows before the first real payout. Not legal advice.
- **Abuse.** Rate limits exist (see Security). Add a CAPTCHA on guest
  creation if bots show up.
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
- **Mutual friends / nudges** — friends are one-way on purpose (no
  notifications to build, nothing to moderate). A "they added you back"
  badge is the cheap next step.
