# Going live

Two repos, two hosts. About 20 minutes the first time.

## 0. What "live" means

Once the backend is up and `config.js` points at it, every visitor starts
with $100, no positions and no lobbyists, buys at real prices, and gets a
guest account that lives in that browser. "Keep this account" (username +
password, or Google) or Account → "Use on another device" (a 15-minute code)
carries it across devices. The demo (invented prices, seeded positions) now
only runs at `?demo`; a copy whose `config.js` still has the placeholder URL
shows a "not connected yet" notice instead of quietly playing the fake game.

For testing, put your username(s) in `ADMIN_USERNAMES`: the Account sheet
grows an Admin section that grants cash and lobbyists (real rows, so the
boards and the town see them) and resets the account to day one, and ☰ → Admin
opens the admin page. Admin names are reserved: nobody can sign up as, claim or
rename into one, and an admin account can't change its username. So to add an
admin, create that account first, then add its name here.

## 1. Backend on Heroku

```
cd heroku-trickledown
git init && git add . && git commit -m "Trickle Down backend"
heroku create trickledown-api            # or any name; note the URL it prints
heroku addons:create heroku-postgresql:essential-0
heroku config:set JWT_SECRET="$(openssl rand -hex 32)"
heroku config:set CORS_ORIGIN="https://stevenbhester.github.io,https://trickledown.stevenhester.com"
heroku config:set FINNHUB_API_KEY="your_finnhub_key"
heroku config:set GAME_TZ=America/Chicago LAUNCH_DATE=$(date +%F)
heroku config:set ADMIN_USERNAMES=steven          # your username(s), comma-separated; grant, cards and reset from Account
git push heroku main
heroku logs --tail                        # should say: Trickle Down API on :PORT (prices: live, …)
```

Then the one scheduled job the game needs, so every position freezes at its
24-hour mark whether or not the web dyno is awake:

```
heroku addons:create scheduler:standard   # free
heroku addons:open scheduler              # add a job: node scripts/mature.js, every 10 minutes
```

Check it once with `heroku run node scripts/mature.js` (it prints how many it
froze; zero is fine). Without this job, a position that matures while the
dyno is asleep gets frozen the next time someone shows up, at a logged price
near the mark if the game saw one, otherwise at that moment's price, flagged
"froze late".

Then check the price feed with your key, through the same code the game uses:

```
heroku run node scripts/check-prices.js
```

It prints a handful of stocks and coins with prices, day moves, and when each
last traded. If anything says FAILED, the key or a symbol in `src/assets.js`
is wrong.

`app.json` is also here, so the "Deploy to Heroku" button flow works and
prompts for the same settings (it adds the Scheduler add-on too, but Heroku
can't create the job from a manifest, so add `node scripts/mature.js` every
10 minutes by hand as above).

The server **refuses to start** in production if `JWT_SECRET` is short or the
default, or if `CORS_ORIGIN` is `*`. That's deliberate.

## 2. Front end on GitHub Pages

1. In `trickledown-stevenhester-com/config.js`, set `API_BASE` to the Heroku
   URL (no trailing slash) and `SITE_URL` to where the site will live.
2. Push the repo. Settings → Pages → deploy from `main`, root. Add a `CNAME`
   file if you use a custom domain, same as your other sites.
3. Load the site. The first visit creates a guest; "Keep this account" in the
   footer turns it into a real one.

Until `config.js` points at a real backend, the site runs in demo mode with
invented prices.

## 3. Google sign-in (optional)

1. [console.cloud.google.com](https://console.cloud.google.com) → APIs &
   Services → Credentials → Create credentials → OAuth client ID → Web
   application.
2. Authorized JavaScript origins: `https://stevenbhester.github.io` and
   `https://trickledown.stevenhester.com` (and `http://localhost:8080` for
   local testing). No redirect URIs are needed; the button uses a popup.
3. Configure the OAuth consent screen (External, just the app name and your
   email). While it's in "Testing", only the test users you list can sign in;
   publish it to open it up.
4. `heroku config:set GOOGLE_CLIENT_ID="…apps.googleusercontent.com"` and
   optionally put the same id in `config.js`. The button appears on the sign-in
   and account sheets as soon as the backend reports it.

The backend verifies each Google ID token's signature against Google's
published keys, plus issuer, audience and expiry, and keys the account on the
stable Google `sub`, never on the email address. Linking Google to an existing
account only happens while signed in to that account; nothing is ever matched
up by email.

## 4. The charities

They're real: 18 organizations in `src/charities.js`, each rated 4 of 4 stars
by Charity Navigator when the list was made. Rows are upserted by slug on every
boot; anything removed from the file is retired (history kept), and players
whose default was retired are asked to choose again, with their lobbyists
following their pick. Re-check the ratings before each quarter's payout.

Players ask for others from the game (Request a charity); the requests land on
the admin page (☰ → Admin → Requests). Adding one is a line in
`src/charities.js` and a redeploy.

If you set `DEMO_MODE=true` earlier (the old instructions said to), unset it
now: `heroku config:unset DEMO_MODE`. With it on, the site adds "demo, the
money is pretend" notes. See the README's "Before real money moves" list.

## Did the deploy take?

The page and the server ship separately, so it's easy to update one and not
the other. Open `https://<your-app>.herokuapp.com/health` in a browser. It
should say `"api":11` (the number in `API_VERSION` in `src/routes.js`). No
`api`, or a lower number, means the server is older than the page: upload
the whole backend again (every file in `src/`, including any new ones) and let
Heroku redeploy. Signed in as an admin, the page also says so in a yellow bar
at the bottom.

Uploading through GitHub's "Add files via upload": open the repo's top level,
not `src/`, and drag in the folders, so `src/achievements.js` lands at
`src/achievements.js`. The page's files (`app.js`, `api.js`, `coin.js`,
`demo-api.js`, `explainer.js`) don't belong in this repo; the server never
loads them.

## Day to day

- **Nothing accrues without a player.** Money lands only on days the player
  opens the game (`/me`), and every position freezes at 24 hours from
  purchase; the scheduler job above is what makes that true at 3 a.m. with
  nobody around. A player back after a month finds exactly what they left,
  frozen at the prices of the day it froze.

- **Rotate a leaked `JWT_SECRET`:** `heroku config:set JWT_SECRET=…` signs
  everyone out; they sign back in and keep everything.
- **A player locked out:** they can "Sign out everywhere" from Account, or you
  can `UPDATE users SET token_version = token_version + 1 WHERE username = '…'`.
- **Finnhub rate limit** is 60 calls/min on the free tier. Quotes are cached
  for a minute and crypto is one batched CoinGecko call, so even a busy day
  stays well under it. If a provider blips, the last good quote (up to an
  hour old) is used and marked `stale`; the picker says the feed is lagging.
- **Weekends:** stocks don't trade, so a stock bought Friday evening barely
  moves before it matures Saturday evening. The picker says "markets look
  closed" when a stock's last trade is more than half an hour old. Crypto
  moves all weekend.
- **Finnhub's free tier** is licensed for personal, non-commercial use. Once
  ads are on the site, check their terms or move to a paid tier; the price
  code only needs one function changed if you switch providers.
