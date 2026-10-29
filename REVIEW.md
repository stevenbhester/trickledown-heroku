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

## Tester feedback, round two

- **"The browser bugged and I'm back in the tutorial."** After the first
  taxed sale the coin flipped by itself and the TrickleTown tour opened,
  which looked exactly like the orientation. Now the first hire is a
  ceremony: the tax walks across the recruiter's desk and comes out as
  lobbyists, the sheet says who was hired and for whom and that they've
  moved in on the other side of the coin, and a single button, "Flip the
  coin to meet them," does the flip, lands the bills in the payroll, and
  only then opens the tour. The tour itself now reads as a different
  document (green band, "TrickleTown" brand, "part two"). "Later" leaves a
  primary "Meet your lobbyists" button on the coin; the first flip to tails
  runs the tour.
- **"I thought we were moving off demo mode."** The demo now only runs at
  `?demo`; a copy pointed at the placeholder backend shows a setup notice.
  Real mode was verified end to end in a browser against the backend: a
  fresh guest starts with $100, no positions, no lobbyists, buys at the live
  price, collects, gets the ceremony, and the account can be carried to a
  second browser with a device code or claimed with a password.
- **Admin.** `ADMIN_USERNAMES` grows an Admin section in Account: grant
  cash and lobbyists (real rows), reset to day one.
- **Cross-device without a password.** Account → "Use on another device"
  gives a 15-minute single-use code; Sign in → "Use a code" on the other
  device. Guests included, so nobody has to invent a password to try the
  game on their phone.

- **Landing page.** Hero, three one-liners, "Take the employee training"
  above the ways in (training taken first ends in Create an account / Play
  as a guest / Sign in), then those two big buttons with Sign in as a line
  under them. Setting a password shows the honest beta note.

- **Day one was bland** (buy, then wait 24 hours). Now the first buy vests
  the player's shares in Trickle Down Holdings: an internal-memo sheet,
  "Sell. It's policy.", $40K of pure profit, $10K of tax, ten-ish lobbyists,
  and TrickleTown opens through the same first-hire ceremony and tour on the
  spot. Once per account; the `vested` position sits off the gain boards.
- **Everything is in thousands now.** $100K a day, $1.2M in play, $40K to
  build, $1K a head for lobbyists; one decimal at most, under $0.1K shown
  in plain dollars. Real stock prices stay real.

- **The universe.** The curated 52 became every US-listed stock and ETF on
  the real exchanges plus the top 250 coins, loaded daily from the
  providers into an `assets` table and searched server-side. The curated
  list stays as the featured set with its moods.
- **Movement right away.** After a buy the front end polls fresh quotes
  every 3 seconds, backing off to a minute; values are recomputed on the
  client with the server's formula, so the coin and rows move without a
  reload. The Finnhub budget caps the spend; a paid tier raises it.
- **Landing scenery.** A tilted heads coin with a sample portfolio on the
  right, a tails village on the left, a crowd of lobbyists, and a faint rain
  of bills in the gutters, all inline SVG. Phones get the rain only.

## The cards and buildings pass (tester notes, round three)

- **Cards didn't read as decisions.** Every one of the 77 now carries an
  explicit ask under its setup ("How do people get the password?") with
  "Preston and Dolores each have an answer; pick one." The vague labels
  became actions ("Charge for parking", "Paint it on the wall, free",
  "Close it; stairs are cardio"). The wifi setup now states the problem.
- **Buildings looked identical.** The arrow chips capped at ▲▲▲, so a
  +$18K slum and a +$8K high-rise both showed "Allowance ▲▲▲". Buildings
  and upgrades aren't secrets, so they now show their exact daily push
  ("Every day: +$18K allowance · −3 happiness · −4 health") on the build
  menu, the office, the zone tiles and the upgrade result; the advisors'
  cards keep their arrows, since not knowing is the game there.
- **Why build the slum?** Because it's cheap. Buildings have their own
  prices now: Tenement Row $20K, The Pinnacle $40K, Maple Co-op $60K;
  Casino $30K, Company Store $40K (and 20% off every card), Free Clinic
  $60K. The slum also pays $18K/day (was $15K). A new player with ~$70K
  after vesting can afford the extractive pair on day one and discover
  what that costs; the decent pair takes saving. The build menu says all
  of this in one paragraph, including what happiness and health actually
  do.
- **Upgrades didn't explain themselves.** A proposal now opens with "An
  add-on to The Pinnacle for $40K, one time. Buy it and it pushes the
  numbers below every day on top of what the building already does. Pass
  and it waits," the numbers, and why it's on the table ("Unlocked because
  you've hired 5 lobbyists"). The buttons say "Buy it for $40K" and "Pass
  for now."

## A pass for fun, onboarding and time in the game

What a session looks like now, and what was added to make each beat land:

1. **Land** on a page that shows the game (coins, village, the rain of
   money) and says the whole premise in three lines. Training is a button,
   not a gate.
2. **First minute.** The Buy section walks the first investment in three
   numbered steps and promises the gift. The vesting memo delivers it,
   the ceremony turns the tax into people, one button flips the coin, and
   the tour runs. Two cards are already waiting behind the flip.
3. **Every visit after that opens with a to-do strip** under the coin:
   collect KO (ready at +31%), play 2 cards, invest the $30K on the coin,
   build on the empty lot from $20K, hear a proposal. Each line is a
   button that takes you there. When it's all done it says so and when
   the next thing lands ("KO matures in 6h 12m; new money in 13h").
4. **Something to watch.** The live ticker makes a fresh buy move within
   seconds; the real move shows two decimals while it's small.
5. **Something to come back for.** Allowance only lands on days you show
   up, the streak grows it, positions mature on a 24-hour clock from when
   you bought, and the village changes overnight (the report, the cards,
   a proposal that just unlocked).

What I'd do next, in order of expected payoff:

- **A morning report on first load**: "Overnight: KO matured +31%,
  happiness 62 → 58 (the cup policy), 2 new cards, the doorman proposal
  unlocked." It's one paragraph built from data the server already has
  (`town.report`, matured positions, newly unlocked deck entries) and it
  makes the 24-hour loop feel like a story. Half a day.
- **Weekly Lobbyfest preview** on the Lobby page: where each charity
  stands and what your lobbyists would move if they switched. Gives the
  charity pick stakes.
- **Streak freeze**, one per month, Duolingo-style. Cheap, and it's the
  single biggest retention mechanic in daily games.
- **Push or email at maturity** is the obvious retention lever and the
  one thing this architecture can't do without adding a channel. If
  email ever exists for password reset, a "your positions matured" mail
  is one query.
- **Reactions on friends' coins** (a thumbs-up on a Legend cash-out)
  would make the friends feature social instead of voyeuristic. Needs a
  table and a notification spot; a day.
- **Balance watch after a week of real players**: the numbers to look at
  are hire cost distribution, how many towns sit under health 50, and
  how often rides go to ×30. `npm test` keeps the invariants; the feel is
  what the data will say.

## The deck's road ahead, and admin card tools

The deck used to say "Everyone gets this one" on 21 of 77 cards, which read
as a pile with no shape. Now:

- **8 headline cards** stay universal (Rent day, The parking lot,
  Team-building, The snack machine, The ball pit, Crunch week, The lobby
  art, The coffee cups). The deck intro says how many you've played.
- **13 cards open with days played** (An intern on day 2; The wifi
  password and A holiday request on 3; A cat and A suggestion box on 4;
  The lawn and The lunch hour on 5; Name badges 6; A dress code 7; The
  elevator 8; A company newsletter 9; Fire drill 10; The holiday party 12).
  The town
  counts the days you've visited (`t.days`), not calendar days, so a
  week off doesn't skip anything.
- **Every locked card shows your progress** against its requirement:
  "Unlock: play 5 days (you: 2)", "have $120K on the coin at dawn (you:
  $70K)", "hire 10 lobbyists, career (you: 3.4)".
- **A "Coming up" line** above the deck: how many cards open the next day
  you play, how many more follow just for showing up, and that the rest
  come from building, hiring, cash and friends.
- **The grid shows two and a half rows** (measured, so the cut lands
  mid-card at any width) with a fade and "Show all 77 cards". Within a
  status, your town's own cards sort before the headlines.

Admin (Account → Admin, `ADMIN_USERNAMES` only), each aimed at yourself or
at a player you name:

- **Deal it today** puts any card on today's agenda right now, after the
  day's own cards, so you can test a specific card without waiting.
- **Unlock it** / **Unlock every card** opens cards for future days
  (stored as `town.admin_open`; the deck tags them "opened by admin").
- **Reset to brand new** now also clears `vested_at` (the $40K gift comes
  back), the player's own friend list, and device codes. On your own
  account the browser forgets the training and the TrickleTown tour, so
  the whole first day runs again: training, first-investment guide, the
  vesting memo, the first-hire ceremony, the tour. Other players who added
  you keep you on their list; that's their data.
- Admin calls have their own rate limit (120 per 15 minutes) instead of
  sharing the one that guards password changes.

## TrickleTown layout pass

- Each town section is its own panel with an icon and a quiet identity:
  Vitals (clinic chart), Town Hall (civic stone), Construction zone
  (hazard tape over a site-plan grid), the deck (card-table felt), Payroll
  (warm paper), Rank (a staff ID badge).
- Town Hall and the Site Office pin a stat bar to the top: Cash, Allowance,
  Happiness, Health, Lobbyist price. After a choice each stat that moved
  shows by how much. Card choices say "Costs $15K" or "Free".
- Building options lead with the name and a large price; short of cash the
  button says how much more is needed.
- After building, a "built" screen with Back to TrickleTown. The office's
  main button is Back to TrickleTown; tearing down is a small link.
- "Hiring cost" is now "Lobbyist price" everywhere it shows.
- **Purchase grace** (`town.js` `canPay`, `GRACE` = $0.1K): money shows to
  one decimal, so $29.97K reads as "$30K". Anything within a display step
  of a price counts as enough, and the purchase takes what's there (cash
  never goes negative). Same rule on both sides, so "$30K" on the coin
  always buys a $30K building.

## Default charity, Assign lobbyists, and the biggest-positions board

- **One pick, at the first cash-out.** `users.charity_id` is now the
  player's default. The first time lobbyists are hired (usually the vesting
  memo) the sheet asks "Pick your charity" and the button waits for an
  answer. After that every cash-out just says where the lobbyists are going.
  The server never overwrites a default from a sale (`COALESCE(charity_id,
  chosen)`), and with a default set it wins over whatever a client sends.
- **Assign lobbyists** (bottom of TrickleTown, in Payroll, which is now the
  last panel): move this quarter's lobbyists between charities with − / + /
  "All here", and pick the default for new hires. Moves are recorded as
  +/- donation rows with no position, like quitting, so every total stays a
  SUM; the server checks the allocation accounts for every lobbyist this
  quarter. Past quarters already marched and can't be rearranged.
- `/trickle` counts a charity's donors as players with lobbyists there now,
  not anyone who ever had a row (moves and quitting made that wrong).
- **Biggest positions right now** on the Leaders page: open positions by
  current value, with the friends filter. Priced from this process's last
  good quote or the price log, so a board view never calls a provider.
- A vesting memo that was closed before selling now shows up as a to-do
  ("Your shares vested. Sell them for $40K"); before, it could only open
  right after a buy.

## Achievements, a fairer deck, and money-or-people buildings

**Achievements** (`src/achievements.js`, table `achievements`). Eleven rare
milestones, each with a one-time gift from Mommy & Daddy, taxed like any win
so it hires lobbyists: Skin in the Game (first buy, $40K, the old vesting
amount and the only one on day one), Realized Gains, Character Building
(lose a whole position), Networking (3 friends), Creature of Habit (7-day
streak), Landlord (every lot built), Let It Ride (ride twice), Legendary,
Power Broker (50 lobbyists), Clocked In (30-day streak), Seven Figures ($1M
on the coin). Earned automatically on `/me` / `GET /achievements`, claimed
from a popup (burst, a handwritten note, the tax receipt). A dismissed one
stays in the to-do strip; the 🏆 in the masthead (with a count, and a nudge
when a gift is waiting) and the staff ID in TrickleTown open the trophy case
with progress bars. Old "vested" accounts were backfilled as having claimed
the first one. The onboarding now calls it what it is: a bonus.

**Onboarding copy.** "Hold 24 hours for ×10" says the multiplier works on
the move: a stock up 1% puts you up 10% at 24 hours; down 1%, down 10%.

**Popups.** Darker, blurred backdrop; the page behind a popup is frozen
(body pinned at its scroll offset, released on close). Tapping a building on
the coin opens its Site Office (it used to flip the coin back); tapping an
advisor opens Town Hall. A built lot's office now has labeled sections:
what it does every day, and every upgrade with its price, numbers and why
it's locked (with your progress).

**Balance: money or people.** Decent buildings now attract volunteers:
free lobbyists every night for the default charity (Co-op 0.5, Clinic 0.6,
Pinnacle 0.1; decent upgrades 0.15–0.2), scaled by happiness (×0.5 to
×1.5). Extractive buildings keep their big allowance. The 45-day model in
`npm test`: extract earns ~$2.8M extra allowance and ends the quarter with
~6 lobbyists (quitting eats them); mixed ~$1.8M and ~83; nice −$0.8M and
~160, about 72 of them volunteers. The Pinnacle's health cost went from −2
to −1 so the compromise town doesn't bleed. Each building unlocks its own
card; cards aren't stronger for decent buildings, and the copy says so.

**Every card choice has an upside.** 19 of Preston's sides were pure loss
(e.g. "Lobby the reporter": −$15K, −happiness). Each now pays something
visible (cash or allowance) for its cost in people. `npm test` checks it.

**More cards a day.** One headline plus at least two town cards, or half
the unplayed backlog if that's more (max 6). A card unlocked during the day
by an action (building, upgrade, hires, friends) joins today's agenda right
away (`dealNewUnlocks`, baseline `town.unlock_seen`); days-played, cash at
dawn, streak, follow-up and "happens when" cards still arrive with the
daily deal. Admin can deal every unlocked card at once.

## Two scores: profit and happiness

Testers found the town convoluted: happiness, health, quitting, volunteers,
a recruiter's rate. Now there are two scores and one thing each does:

- **Profit**: dollars a day the village adds to (or takes from) the
  allowance. Extractive buildings make it; decent ones cost it.
- **Happiness**: sets the lobbyist price, $1.4K a head at 0, about $1K at
  55, $500 at 100. The top of the scale is worth the most, so a properly
  decent town really is cheaper to staff. Drifts back toward 55.

Health, quitting and volunteers are gone. Building and card effects that
were on health folded into happiness; the cards gated on health now gate on
happiness (the inspector, "nobody calls in sick") or on days played (the
flu). Old saves drop the field.

The 45-day model in `npm test` (the day's money invested, about 1.7% of it
coming back as tax, hired at the town's price): extractive earns about $2.8M
of extra allowance and hires ~118 lobbyists; compromise ~$1.8M and ~145;
decent −$0.8M and ~200. Money or people, with the middle in the middle. The
compromise buildings went to −1 and −2 happiness to keep it there.

A card choice that leads to a follow-up now says how that tends to go:
"✨ Could pay off later", "⚠️ Could come back to bite", or "🔮 Something
comes of this later" (`town.js` LATER, checked by `npm test`).

## The simplification pass

Testers said the game was hard to grasp. Nothing in the rules changed; the
screens and the words did.

**Navigation.** The hidden heads/tails flip is now a labelled switch under
the coin: Portfolio | TrickleTown, with a badge for cards waiting and a lock
until the town opens. The coin still flips (and tapping it still works), but
nobody has to know what "tails" means. The surprise auto-flip-back after a
collect is gone; after a hire you stay in town and the switch takes you back.

**Today.** Portfolio header is one line. The buy box is a search field and
a button. Position rows are two lines plus a 24-hour progress bar instead of
three lines of prose. The crowd line is one line. Phone height 1760 → 1576
for the same state.

**TrickleTown.** Seven panels became four: the scores strip (profit,
happiness, lobbyist price, lobbyists this quarter; the same component the
dialogs use), Town Hall, Construction zone, Payroll (with rank and records
folded in). The 77-card deck moved into a sheet behind one line ("10 of 77
cards unlocked · 1 more tomorrow"). The staff-ID badge and the Vitals panel
are gone; the overnight report is one line. Phone height 3439 → 2161.

**Tutorials.** Employee training: 7 slides → 4 (fake money/real charity;
hold 24h for ×10 on the move; wins hire lobbyists, most lobbyists wins
Lobbyfest; your first buy pays a bonus). TrickleTown tour: 7 → 3 (two
scores; money or people; cards every day). Jokes stay in the fine print and
on the cards; the instructional lines are plain.

**How page.** 4800px of chapters → 14 short questions in an accordion, the
first one open. Lobby page: three numbers and the list. Leaders: ten rows a
board, "Show N more". Sell sheet: five receipt lines, not nine.

Everything a player could do before, they can still do, in the same places.

## "No achievement on my first buy"

Cause: the live server was several releases behind the page. GitHub showed
`src/routes.js` last updated before achievements existed, and
`src/achievements.js` was never uploaded (the page's own scripts had landed
in `src/` instead). So `/me` had no `achievements`, and the page, which only
read `achievements`, showed no guide, no popup and no gift. With a matching
server the flow worked end to end.

Fixes, so a half-finished deploy can't look like a bug again:
- `/health` and `/me` report `api: 8`. The page expects 8. If the server is
  older, admins get a yellow bar saying so; everyone gets a console warning.
- Against an older server, the page reads the old `vesting` field as the
  first achievement and claims it through `/vest`. Tested against the code
  that is actually on GitHub: the gift pops, pays $40K, hires lobbyists.
- `index.html` loads its scripts and stylesheet with `?v=…`, so a cached
  page can't mix an old `index.html` with new scripts. Bump it each release.

## Profiles, the ☰ menu, and achievement gifts

**Navigation.** The Today / Lobby / Leaders / How tabs are gone. Today's game
is the page; everything else is in a ☰ menu (your profile, Leaderboards,
Friends, Lobbyfest & charities, Trophies, How to play, Account, Sign out).
Friends moved off the Leaders page to a page of their own. Every username in
the game opens that player's profile (`#u/<name>`; yours is `#profile`).

**Profile** (GET /players/:username, extended; public like the boards):
- *Trading gains*: a Robinhood-style line of cumulative profit and loss from
  positions only, one point per day since the first buy, with today's point
  including what's open at current prices. Scrub it, pick 1W / 1M / 3M / All.
  `performanceFor()` sums `profit` on closed and rolled positions by
  `closed_day`; gifts and the old vest are excluded by status, and town
  spending never touches positions. Before tax. Rides: the roll realizes the
  first leg, the ride's own close the rest; summed, that's the whole chain.
  Win rate, best and worst trade, open P&L underneath.
- Holding now, TrickleTown (profit/day, happiness, lobbyist price, buildings
  with their upgrades, Preston-vs-Dolores tally), lobbyists by charity this
  quarter, trophies.
- The tally is new state (`town.sides`), counted from today on; older towns
  are seeded from today's played cards.

**The wall.** Friends-only: readable and writable by the owner and by anyone
the owner has added (adding someone is the owner's say-so, so strangers
can't post). The owner deletes anything on their wall, an author their own.
Plain text, 280 characters, escaped on render, never HTML. On the way in:
every control and format character goes (bidi overrides, zero-width
spaces; the emoji joiner stays), line separators become newlines, blank-
looking filler letters go, combining marks are capped at two per letter, and
3+ newlines collapse. 12 posts per 10 minutes per account; a wall keeps its
latest 200.

A separate security review of this pass found one medium issue and four low
ones; all fixed: an unfriended author deleting their own post got the wall
back in the response (now empty unless they still have access); the Unicode
gaps above; profiles listed every open position (now the biggest 60 plus a
count, and buying stops at 100 open positions); other people's profiles
showed exact buy and achievement times (now "about 5h", the day, and the
month you joined); and "Add friend" now says it opens your wall to them. GET /me carries
`wall_unread` (posts by others since you last opened your profile) for the
red dot on ☰. Admin reset clears walls too.

**Achievement gifts.** Simulated 2,000 daily players for 90 days (allowance
$100K + $10K/day of streak, capped $200K; ×10 stocks at ~1.6% daily moves;
25% tax). Because every day's allowance stays on the coin, money in play is
~$850K at day 7, ~$4M at day 30, ~$7M by day 90, and trading hires ~15
lobbyists/day in week one, ~80/day by day 30.

| | when | old gift | share of money then | verdict |
|---|---|---|---|---|
| Skin in the Game | day 1 | $40K | 40% | right: unlocks the town |
| Realized Gains, Let It Ride, Landlord, Networking | days 1–5 | $15–40K | 10–20% | fine |
| Creature of Habit (7-day streak) | day 7 | $30K | 3.5% | too small |
| Seven Figures | day 8 | $100K | 9% | fine-ish |
| Power Broker (50 lobbyists) | day 7 | $60K | 6% | earned in week one: not rare |
| Clocked In (30-day streak) | day 30 | $100K | 2.5% | far too small: a third of one day's trading |
| Legendary, Character Building | rare, ~day 40 | $50K / $25K | under 5% | far too small for the rarest two |

Nothing was overpowered; everything after week one was underpowered. Now
each gift is `max(floor, share × money in play)`, rounded like a check, with
the old amounts as floors: 4% for the early ones, 6% for Creature of Habit,
Character Building and Seven Figures, 10% for Legendary and Power Broker,
15% for Clocked In. A gift then hires roughly half a day (early) to two days
(30-day streak) of what trading hires at that point, and adds 3–11% to the
money in play after tax. Power Broker is now 500 lobbyists (about three weeks).
`scripts/test-town.js` checks the amounts.

## Share card, loss tiers, link previews

**Loss tiers.** Losses had one name, Paper cut, from −0.01% to −99%. They now
mirror the gain ladder: Paper cut (under −10%), Flesh wound (−10 to −25%),
Taking on water (−25 to −50%), Comically disastrous (−50% or worse), Rest in
peace (zero). `tierFor` in `src/game.js`; old receipts keep the name they
were given. Checked in `scripts/test-town.js`.

**Share my day** (front end only). Was a list of open positions, lobbyists
and a streak. Now a short card previewed in a sheet, with Share (phones) and
Copy: an opening line set by the day's combined result ("On a heater. Please
clap." … "Comically disastrous. Truly something to see."), then "Trickle Down
· Day N · +$18K", each position cashed out or let ride today with its % and
$ and a tier emoji (🚀🔥📈🪙 / 🩹🤕🌊🤡💀, 🎢 for a ride), today's new buys,
and the link. No achievements, gifts or lobbyists. Days with only buys say
so ("All in on AAPL. See you in 24 hours.").

**Link previews.** The page had a title and a description and nothing else,
so Slack and iMessage showed a bare link. Now: Open Graph and Twitter card
tags, a 1200×630 `og.jpg` (the wordmark, "Fake money. Real stocks. Real
charity.", and the real coin from demo mode, rendered with the real fonts),
and an `apple-touch-icon.png`. The preview is the same for everyone: a
per-player preview would need the server to render images, which it can't
yet.

## Tighter share card, finding your profile, deck look-back, admin switches

**Share card**, a few labelled lines and no commentary:
`Trickle Down · Day 9 · +$18K` / `Sold: 📈 NVDA +34% · 🤕 DOGE −12%` /
`Riding: 👍 TSLA +12%` / `Bought: KO $30K · BTC $15K` / the link. Day N is
how many days the account has been going (`account_day` on the user, game
time zone; an admin reset restarts it). Every trade gets its tier's emoji
(🚀 🔥 📈 👍 🪙 / 🩹 🤕 🌊 🤡 💀).

**Wall alerts**: /me now says who wrote (`wall_unread_from`) and the newest
post's id (`wall_latest`). A new post gets one quiet toast (remembered per
browser by that id, so reloads don't repeat it), a to-do line ("erin wrote
on your wall. Read it", which opens your profile at the wall), and the red
dot on your avatar. The line and dot go once you've looked.

**Your profile** has three doors now: your avatar in the masthead (it carries
the red "new on your wall" dot), "Your profile" at the top of ☰ in so many
words, and "My profile & trading history" next to Share on Today. On narrow
phones the countdown shortens to "Refill in 6h" (and hides under 340px) so
the masthead still fits.

**The deck**: any card you've played opens to the situation, both pitches,
and which one you took and when. New state: `town.choices` (card → side,
day), recorded by `decide`; the card text comes from the rules file the
page already has. Cards played before this shipped show the situation and
both sides, and say the pick wasn't recorded then.

**Admin switches**: "Unlock every card" and "Deal every unlocked card" are
checkboxes now (`town.admin_all_open`, `town.admin_deal_all`; GET/POST
/admin/switches), aimed at you or the named player. Unticking unlock-all
returns the deck to what the town has earned; anything already played stays
open, and today's unplayed cards that lock again leave the agenda. Unticking
deal-all puts today back to a normal day's hand, keeping what's been played.
A town that used the old one-way "unlock everything" reads as the switch
being on. Also fixed: the admin card routes kept running after an error
reply (a "No player by that name" would throw on the way out).

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

