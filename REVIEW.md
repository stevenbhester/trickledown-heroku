# Trickle Down — critical review, October 2026

A pass over both repos (`heroku-trickledown`, `trickledown-stevenhester-com`)
with the question "is this as fun and as well built as it can be?" Two
reviewers: the one who wrote it, and a second pass with fresh eyes that had
not seen the code being written. What follows is what we found, what changed
because of it, and what's deliberately left for later.

## What changed in this pass

### Letting it ride: half the tax now, the other half deferred, and the multiplier keeps climbing

Before: a matured winner could ride untaxed, forever, and the new day's
multiplier reset to ×1, so "let it ride" quietly meant "start over". Now:

- `/ride` realizes the profit at `TAX_RATE × RIDE_TAX_FACTOR` (12.5%), hires
  those lobbyists for the chosen charity, and rolls the rest into a fresh 24
  hours. Records say "rode on, half tax".
- The other half is **deferred** onto the new position. Sell the ride early
  and it comes due, on top of the usual tax on anything new; hold it to
  maturity and it's forgiven. That closes the loophole the second reviewer
  found (ride, then sell seconds later at the same cached price for ~$0 new
  profit and ~$0 tax) without locking anyone in.
- The multiplier **doesn't restart**: a ride begins where the last day ended
  and climbs by the asset's base again, ×10 → ×20, then ×20 → ×30, then flat
  (crypto ×5 → ×10 → ×15). Riding is now a real "let it ride": more upside,
  and at ×20 a 5% dip is the end.

Riding a loser was never an exploit (a loss is untaxed either way, so it
equals collecting and rebuying), but with the climb it's now a choice with
teeth rather than a convenience.

### Nothing grows while you're away

The allowance only lands on days a player opens the game, and every position
freezes at its 24-hour mark. The freeze used to depend on a timer inside the
web dyno plus a lazy check when the player showed up, which on a sleeping or
restarting dyno meant "frozen at whatever the price was when you came back".
Now a Heroku Scheduler job (`scripts/mature.js`, every 10 minutes) freezes
everything due whether or not anyone is playing; the in-dyno timer stays as
the faster path while it's awake; and a `price_log` of every quote the game
fetches lets a late freeze use the price nearest the mark. If even that's
missing, the position freezes at the current price and says "froze late" on
its row. Verified: a position two days past maturity froze at the logged
price 4 minutes after its mark, not today's.

### Friends

One-directional, silent, capped at 50. Add anyone by username on the
Leaders page; you get a friends-only version of both boards, a line under
the crowd strip ("erin bought NVDA"), and a player sheet for anyone on any
board: their coin (live wedges), standing, rank, cash in play, favourite
charity, and a summary of their village. Nothing on the sheet is anything
the public boards didn't already show, plus play-money game state. No
email, no Google ids, nothing from Account. Guests can add but can't be
added back, which is one more reason to claim the account. Two cards unlock
on friends (1, 3, 5).

### The deck: 77 cards (was 51), and dealing that doesn't repeat itself

- 26 new cards: five small daily ones with consequences (lunch hour, the
  elevator, a newsletter, the fire drill, the holiday party), fourteen
  follow-ups (every mark a card can leave now has a card that comes back for
  it), two more emergent "town in trouble" cards (a headhunter, the health
  inspector), three that only a thriving town sees (a magazine profile, its
  fallout, an empty clinic), one for 5 friends, and two tied to upgrades
  (pool party, dental day).
- `needs.happiness_above` / `health_above` exist now, so a well-run town
  gets its own events instead of only the punishing ones.
- **Bug fixed:** `pickIssues` never excluded cards you'd already played.
  Once a flag was set, its follow-up ("The auditor is back", "A month
  straight") would be dealt every single day. Unplayed cards come first
  now; a follow-up you've answered doesn't come back; emergent cards (a
  strike, the flu) can return, but no sooner than a week after the last
  time (`t.last` records the day each card was played). Old saves migrate.

### Smaller fixes

- Guest accounts that never hired a lobbyist and haven't been seen in 45
  days are swept daily (`src/housekeeping.js`); positions and friendships
  cascade. Before this, every curious visitor was a row forever.
- Plain `http://` is refused in production.
- `pickCharity` fallback (asked-for → most-hired → last pick → first
  active) is shared by `/sell` and `/ride`, so a profit never fails for
  want of a charity and a loss never demands one.
- README documents the new endpoints, env vars (`RIDE_TAX_FACTOR`,
  `GUEST_TTL_DAYS`) and the dealing rules; `app.json` prompts for them.

## Is the town economy degenerate? (simulated)

The second reviewer's answer, before this pass, was yes: the casino had no
real downside (health −3 landed above the quitting cliff at 40), happiness
bought nothing past 90, and "Co-op + Casino" beat every other pair. The
"compromise" buildings never appeared in an optimal pair. So the levers
changed:

- **Casino:** happiness −2, health −6 (was +1 / −3). Alone it now bleeds
  lobbyists; it needs a clinic or a co-op next to it.
- **Recruiter's rate:** $1.25 a head at happiness 0 down to 75¢ at 100,
  continuous (was $1.50 → 60¢, floored at 90). The range now matches what
  extraction can add to the allowance (±25%), so neither lever dominates.
- **Quitting:** a slope from health 50, not a cliff at 40: 4% a night at 40,
  10% at 25, 20% at 0.
- **Company Store:** cards cost 20% less. It finally has a reason to exist.
- **Unplayed cards:** −2 happiness a night, capped, only once you've built
  something, and only for cards that had a free side. The tutorial now says
  so instead of "exactly the same".
- **Drift:** at least one point a night, so meters actually arrive at their
  equilibrium instead of stalling within rounding distance.

60-day simulation, cards answered, averaged over the last two weeks
(`lobbyists/day index` ≈ allowance ÷ recruiter's rate, base 100):

| Building pair | Cards: alternate | Cards: always Preston | Cards: always Dolores |
| --- | --- | --- | --- |
| Co-op + Casino | 165, 1%/night attrition | 117, 12% attrition | 144 |
| Pinnacle + Clinic | 164 | 108 | 128 |
| Pinnacle + Store | 160 (+20% off cards) | 117, 8% attrition | 139 |
| Co-op + Clinic | 156 | 115 | 113 |
| Tenement + Casino | 139, 19% attrition | 130, 20% attrition | 140, 15% attrition |
| Nothing built | 143 | 104 | 122 |

Reading it: the top four pairs are within 5% of each other and differ in
risk, in the cards they unlock, and in cash on the coin; the pure-extraction
pairs lose on the board they're supposedly optimizing for; always-Preston is a
trap whatever you build; always-Dolores is safe and modest. "Focusing one too
hard hurts the others" holds, and the compromise buildings are competitive.

`npm test` asserts the shape of this (happier towns hire cheaper, only the
extractive town bleeds, extraction pays the most per day) so a future card
edit can't quietly break it.

## The second reviewer's findings, and what happened to each

A fresh agent with no memory of writing the code reviewed both repos. It
reported 24 findings. The bad ones were real.

### Critical

1. **A fresh database could not boot.** `migrate.js` altered `donations`
   before creating it; Postgres runs the schema as one implicit transaction,
   so nothing was created and the server exited. The existing database only
   worked because `donations` predated that block. Any `app.json` deploy or
   `heroku pg:reset` would have crash-looped. **Fixed**: `donations` moves
   above the block that touches it; verified on an empty database, twice
   (idempotent), and on the existing one. The foreign-key rewrite is now
   guarded so it runs once instead of relocking the tables every boot (#18).

### High

2. **Ride-then-sell-early halved the tax with no risk.** Ride at maturity
   (12.5% tax), sell early seconds later: same cached price, ×1 multiplier,
   zero profit, zero tax. Verified by the reviewer with the real modules.
   **Fixed** with deferred tax (above): an early sell of a ride owes the
   skipped half, so the exploit nets exactly what collecting would have, and
   nobody is locked in. The row's Ride button now opens the sheet with the
   numbers instead of firing blind (#10). Verified: ride then immediate sell
   paid 2.50 + 2.50 on a $20 profit, the full 25%.
3. **Ignoring the village cost ~27% of your score while the tutorial called
   it free.** **Fixed** as described above (capped, built-only, free-side
   only, honest copy). Seven cards cost cash on both sides; those no longer
   count as ignored.
4. **The casino had no downside; the compromise tier was never right.**
   **Rebalanced**, table above.
5. **Player sheets shared the `sensitive` rate limit**: ten profile views
   locked out password changes and friend-adds for 15 minutes. **Fixed**:
   `/players` and `/quote` get a 120/min read limiter, friend-adds 30/15min.
6. **`/quote` was unauthenticated and unlimited** and could spend the whole
   Finnhub allowance from one curl loop, after which every wedge would show
   "price unavailable". **Fixed**: read limiter, plus a per-minute Finnhub
   budget (`FINNHUB_BUDGET`, 50) so a burst degrades to stale quotes instead
   of a 429 that stalls the maturer.

### Medium

7. **A database error during auth crashed the process.** `requireUser` was an
   async middleware; Express 4 ignores the promise, so a rejected query was an
   unhandled rejection, which Node 22 treats as fatal. **Fixed**: errors go to
   `next()`.
8. **The allowance grant could overwrite a concurrent build or card.** `/me`
   ticked a stale copy of the town and wrote it back unconditionally; the
   front end calls `/me` on timers. **Fixed**: the grant runs on a locked row
   (`SELECT … FOR UPDATE`) inside one transaction with the quitting. Verified
   with two concurrent `/me` calls on a new day: one grant, correct cash.
9. **"Noted. This will come back around." was false for 9 of 24 marks.**
   **Fixed twice**: `noted` is only true when a card really follows, and the
   nine orphaned marks each got their follow-up card (the Thursday Sale
   stampede, the astroturf melting, the cat's strike, lunch smuggling, a fall
   on the stairs…). That also fixes the asymmetry where only Dolores's choices
   had consequences. **77 cards.**
10. Row "Ride" was a one-tap irreversible reinvest with no numbers. **Fixed**
    (see #2).
11. **Guest accounts died silently at day 180** when the token expired, with
    no way back in. **Fixed**: `/me` returns a fresh token past half-life and
    the client stores it; `token_version` still revokes.
12. **Removing a symbol from `assets.js` stranded open positions forever**
    and made `/ride` 500. **Fixed**: the maturer freezes a delisted position
    at its entry price, `/sell` hands the money back ("Delisted"), `/ride`
    says to collect instead.
13. **Stale quotes (up to an hour old) were accepted for `/buy`.** **Fixed**:
    `/buy` and `/ride` refuse a stale quote; collecting never needs one.
14. **Preflight didn't refuse the test-only URL overrides in production.**
    **Fixed**.
15. **`DAILY_CAP` didn't cap town income.** **Fixed**: `TOWN_INCOME_CAP`
    (40) bounds how far past the cap the village can push.

### Low

16. Streak-gated cards unlocked a day late. **Fixed** (today's streak is
    passed to the tick).
17. Friend-gated cards flipped to "Locked" in the response after any town
    action. **Fixed**.
18. Migration did real work every boot. **Fixed** for the FK rewrite; the two
    backfill `UPDATE … WHERE … IS NULL` statements stay (cheap, and they're
    what makes an old database safe).
19. The share card counted lobbyists differently from the records. **Fixed**.
20. Dead `Coin.back`, stale README design note, orphan CSS. **Removed**.
21. `/players` exposed `last_seen_at` to anyone as a presence signal.
    **Coarsened** to today / this week / this month / a while ago.
22. Meter drift stalled within ±4 of target. **Fixed**.
23. Malformed JSON returned a 500. **Now a 400** with a readable message.
24. The welcome hero omitted the crypto multiplier. **Fixed**.

### Retention notes it made, and what was done

- *Dolores never offers +income; once a player notices Preston's +income is
  permanent and her happiness is a one-time nudge, the cards reduce to
  "Preston unless health is low."* Four of her sides now carry durable income
  (honey from the bees, the potluck's surplus, the food truck, the towns that
  send their new hires to learn): small, but it means her column isn't all
  cost.
- *The shared headline card is a social hook that's invisible.* Playing a
  card now returns how everyone else answered it today, and the result shows
  "67% of the 9 landlords who've answered this today went with Dolores."
  One `GROUP BY` over the town JSON; no new table.
- *Friends are watch-only.* The sheet already says "Has added you"; the
  cheap next step is a nudge in the morning report ("erin's village is
  happier than yours"). Not built.

### What the reviewer said was good, so nobody "fixes" it

Money movement is atomic SQL on locked rows, with no external I/O inside a
transaction. No IDOR, no injection, parameterized throughout, constant-time
login against a dummy hash, HS256 pinned, token versioning, Google ID tokens
verified by `kid` against JWKS with iss/aud/exp and keyed on `sub`. The
maturity freeze with lazy settlement is the right shape for a dyno that
sleeps. `town.js` being pure and byte-identical in both repos, driven by one
`view()`, is a good shape. And: "The writing (Preston, Dolores, the charities,
the mottos) is the best part of the product; don't let a balance pass flatten
it." It didn't.

## Still open

- **True 24-hour leaderboard** (portfolio now vs. 24h ago) needs stored
  closes. The cash-out board is the proxy.
- **Real charities and real money.** Everything needed is listed under
  "Before real money moves" in the README; nothing here changes it.
- **Rate limits are per dyno.** Fine at one dyno; Redis if there are two.
- **No email, so no password reset.** Google link is the recovery path; the
  account sheet says so.
- **The explainer is two tutorials and a How page.** It could use one more
  slide about friends; the Leaders page carries the explanation for now.

