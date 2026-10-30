#!/usr/bin/env node
// Checks on the TrickleTown rules and deck. No database, no server:
//   node scripts/test-town.js
// Fails (exit 1) on the first broken invariant. Run it after editing
// src/town.js, and remember to copy the file to the front end.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Town = require('../src/town');

const src = fs.readFileSync(path.join(__dirname, '../src/town.js'), 'utf8');
let checks = 0;
const ok = (name) => { checks++; console.log('  ✓', name); };

// --- The deck as data ------------------------------------------------------
const t0 = Town.fresh();
const ctx0 = { day: '2026-11-01', uid: 1, unlocked: true, cash: 0, lobbyists: 0, friends: 0, streak: 1 };
Town.tick(t0, ctx0);
const deck = Town.view(t0, ctx0).deck;
const ids = deck.map((d) => d.id);
assert.strictEqual(new Set(ids).size, ids.length, 'duplicate card ids');
ok(`${ids.length} cards, ids unique`);

// Every flag a card needs is set by some card; every building/upgrade a card
// needs exists. Parsed from the source so the check doesn't depend on exports.
const needsFlags = [...src.matchAll(/needs: \{[^}]*flag: '([a-z_0-9]+)'/g)].map((m) => m[1]);
const setFlags = new Set([...src.matchAll(/sets: '([a-z_0-9]+)'/g)].map((m) => m[1]));
for (const f of needsFlags) assert(setFlags.has(f), `card needs flag '${f}' but nothing sets it`);
ok(`${needsFlags.length} follow-ups all have a source card`);
const upgradeKeys = new Set([...src.matchAll(/^\s{12}([a-z_0-9]+): \{ name:/gm)].map((m) => m[1]));
for (const [, u] of src.matchAll(/needs: \{[^}]*upgrade: '([a-z_0-9]+)'/g)) assert(upgradeKeys.has(u), `card needs upgrade '${u}' which doesn't exist`);
const buildingKeys = new Set([...src.matchAll(/^\s{8}([a-z_0-9]+): \{\s*$/gm)].map((m) => m[1]));
for (const [, b] of src.matchAll(/needs: \{[^}]*building: '([a-z_0-9]+)'/g)) assert(buildingKeys.has(b), `card needs building '${b}' which doesn't exist`);
ok('unlock requirements point at real buildings and upgrades');
for (const d of deck) assert(d.needs && !/undefined|NaN/.test(d.needs), `bad needs text on ${d.id}: ${d.needs}`);
ok('every card has unlock text');

// Every card's two sides have an fx object and a label; cash costs are whole dollars.
for (const id of ids) {
  const line = src.slice(src.indexOf(`{ id: '${id}'`));
  const card = line.slice(0, line.indexOf('\n    {', 1) > 0 ? line.indexOf('\n    {', 1) : line.indexOf('\n  ];'));
  for (const who of ['preston', 'dolores']) {
    assert(new RegExp(`${who}: \\{ label: '[^']+'`).test(card) || new RegExp(`${who}: \\{ label: "[^"]+"`).test(card), `${id}: ${who} has no label`);
    assert(card.includes(`${who}: {`) && /fx: \{/.test(card), `${id}: ${who} has no fx`);
  }
  for (const [, n] of card.matchAll(/cash: (-?\d+(?:\.\d+)?)/g)) assert(Number.isInteger(Number(n)), `${id}: fractional cash ${n}`);
}
ok('both advocates on every card, whole-dollar costs');

// --- Dealing -----------------------------------------------------------------
function day(n) { return new Date(Date.UTC(2026, 10, n)).toISOString().slice(0, 10); }
function sim({ build, side, days = 45, friends = 3, allowance = 100 }) {
  const t = Town.fresh();
  let cash = allowance;
  const dealt = [];
  // A rough model for the balance check: the day's money (a $150K
  // allowance plus the town's profit) is invested, and wins pay about 1.7%
  // of it in tax, hired at the town's lobbyist price.
  let payroll = 0, extra = 0;
  const perDay = [];
  for (let d = 1; d <= days; d++) {
    const ctx = { day: day(d), uid: 7, unlocked: true, cash, lobbyists: 5 + d, friends, streak: d };
    const r = Town.tick(t, ctx);
    payroll += (0.017 * Math.max(0, 150 + (r.report.income || 0))) / Town.hireCost(t);
    extra += r.report.income || 0;
    assert(Number.isFinite(t.happiness) && Number.isFinite(Town.income(t)), 'NaN in meters');
    assert(t.happiness >= 0 && t.happiness <= 100 && !('health' in t), 'meters out of range');
    cash += allowance + (r.report ? r.report.income : 0);
    if (d === 1) { assert(!Town.build(t, 'housing', build[0], cash, ctx.day).error); assert(!Town.build(t, 'square', build[1], cash, ctx.day).error); }
    assert(t.issues.length >= 2 && t.issues.length <= 1 + Town.MAX_TOWN_CARDS, `${t.issues.length} cards on day ${d}`);
    assert.strictEqual(new Set(t.issues.map((i) => i.id)).size, t.issues.length, 'the same card dealt twice in one day');
    perDay.push(t.issues.length);
    for (const i of t.issues) {
      dealt.push({ id: i.id, day: d });
      const res = Town.decide(t, i.id, typeof side === 'function' ? side(i) : side, cash);
      if (!res.error) cash = Math.max(0, cash + res.cash);
      assert(cash >= 0, 'negative cash');
    }
    cash = Math.min(cash, 250);
  }
  return { t, dealt, cash, payroll: Math.round(payroll * 10) / 10, extra: Math.round(extra), perDay };
}

const nice = sim({ build: ['coop', 'clinic'], side: 'dolores' });
const mean = sim({ build: ['tenement', 'casino'], side: 'preston' });
const mixed = sim({ build: ['pinnacle', 'store'], side: (i) => (i.id.length % 2 ? 'preston' : 'dolores') });
ok('45-day simulations run without NaN, negative cash, or out-of-range meters');

// A follow-up you've answered is never dealt again.
for (const run of [nice, mean, mixed]) {
  const byId = {};
  for (const x of run.dealt) (byId[x.id] = byId[x.id] || []).push(x.day);
  for (const [id, days] of Object.entries(byId)) {
    const card = deck.find((d) => d.id === id);
    if (card.followup) assert.strictEqual(days.length, 1, `follow-up ${id} dealt on days ${days.join(',')}`);
  }
}
ok('follow-ups are dealt once');

// Emergent cards come back, but a week apart at the least.
for (const run of [nice, mean]) {
  const byId = {};
  for (const x of run.dealt) (byId[x.id] = byId[x.id] || []).push(x.day);
  for (const [id, days] of Object.entries(byId)) {
    if (!/^(Happens when)/.test(deck.find((d) => d.id === id).needs)) continue;
    for (let i = 1; i < days.length; i++) assert(days[i] - days[i - 1] >= 7, `${id} came back after ${days[i] - days[i - 1]} days`);
  }
}
ok('emergent cards wait a week before returning');

// Unplayed cards go first: in 45 days a player sees most of what they've unlocked.
assert(new Set(nice.dealt.map((x) => x.id)).size >= 40, 'too few distinct cards in 45 days');
ok(`${new Set(nice.dealt.map((x) => x.id)).size} distinct cards in 45 days of a decent town; ${Math.min(...nice.perDay)}–${Math.max(...nice.perDay)} a day, ${(nice.perDay.reduce((a, b) => a + b, 0) / nice.perDay.length).toFixed(1)} on average`);

// Unlock something during the day and its card joins today's agenda.
{
  const t = Town.fresh();
  const ctx = { day: '2026-11-01', uid: 9, unlocked: true, cash: 100, lobbyists: 3, friends: 0, streak: 1 };
  Town.tick(t, ctx);
  const before = t.issues.length;
  assert.deepStrictEqual(Town.dealNewUnlocks(t, ctx), [], 'nothing new yet');
  Town.build(t, 'square', 'casino', 100, ctx.day);
  const dealt = Town.dealNewUnlocks(t, ctx);
  assert(dealt.includes('high_roller'), `building the casino deals its card today (got ${dealt})`);
  assert.strictEqual(t.issues.length, before + dealt.length);
  assert.deepStrictEqual(Town.dealNewUnlocks(t, ctx), [], 'and only once');
  const friendsNow = Town.dealNewUnlocks(t, { ...ctx, friends: 1 });
  assert(friendsNow.length >= 1, 'a new friend deals the friends card today');
  assert(!Town.dealNewUnlocks(t, { ...ctx, friends: 1, cash: 500 }).length, 'cash cards wait for dawn');
  const all = Town.dealAllUnlocked(t, ctx);
  assert(all.every((id) => t.issues.some((i) => i.id === id)), 'admin deal-all puts them on the agenda');
  ok(`same-day unlocks: the casino deals "${dealt.join(', ')}"; a friend deals ${friendsNow.length}; cash cards wait for dawn`);
}

// --- Balance: no pure strategy dominates ----------------------------------------
assert(Town.hireCost(nice.t) < Town.hireCost(mixed.t) && Town.hireCost(mixed.t) < Town.hireCost(mean.t), 'happier towns should hire cheaper');
assert(Town.income(mean.t) > Town.income(mixed.t) && Town.income(mixed.t) > Town.income(nice.t), 'extraction should pay the most per day');
ok(`extract: +$${Town.income(mean.t)}/day at $${Town.hireCost(mean.t)}/head; ` +
   `mixed: +$${Town.income(mixed.t)}/day at $${Town.hireCost(mixed.t)}; nice: $${Town.income(nice.t)}/day at $${Town.hireCost(nice.t)}`);
// The trade the buildings offer: extraction pays you, decency staffs the charity.
assert(mean.extra > mixed.extra && mixed.extra > nice.extra, 'extraction should earn the most allowance over 45 days');
assert(nice.payroll > mixed.payroll && mixed.payroll > mean.payroll, 'decent towns should hire the most lobbyists');
// ...but not so many more that the money stops mattering, or so few that it's no contest.
const edge = nice.payroll / mean.payroll;
assert(edge > 1.15 && edge < 1.8, `decent vs extractive lobbyists ${edge.toFixed(2)}x: out of balance`);
ok(`45 days: extract earns $${mean.extra}K extra allowance and hires ${mean.payroll} lobbyists; ` +
   `mixed $${mixed.extra}K / ${mixed.payroll}; nice $${nice.extra}K / ${nice.payroll} (${edge.toFixed(2)}x extract)`);
for (const f of new Set(Town.ISSUES.filter((i) => i.needs && i.needs.flag).map((i) => i.needs.flag))) assert(Town.LATER[f], `no "later" tone for ${f}`);
ok('every choice that leads to a follow-up says whether it tends to go well, badly, or either way');
// Every choice has something going for it.
for (const i of Town.ISSUES) for (const who of ['preston', 'dolores']) {
  const fx = i[who].fx;
  assert(!('health' in fx) && (fx.cash > 0 || fx.income > 0 || fx.happy > 0), `${i.id}: ${who}'s side has no upside`);
}
ok('every side of every card has a visible upside');

// --- Old saves ------------------------------------------------------------------
const old = { v: 4, day: '2026-10-30', happiness: 50, health: 60, perks: 0, plots: { housing: 'tenement', square: null }, upgrades: { housing: [], square: [] }, built: { housing: '2026-10-28', square: null }, issues: [], report: null, played: ['strike'], flags: [] };
Town.tick(old, { day: '2026-10-31', uid: 3, unlocked: true, cash: 100, lobbyists: 3 });
assert(old.last && old.issues.length >= 2, 'old save did not migrate');
const older = { day: '2026-10-30', happiness: 50, health: 60, plots: { housing: null, square: null }, issues: [] };
Town.tick(older, { day: '2026-10-31', uid: 3, unlocked: true, cash: 100, lobbyists: 3 });
assert(older.upgrades && older.played && older.flags && older.last && older.built, 'oldest save did not migrate');
assert(!('health' in old) && !('health' in older), 'old saves drop health');
ok('old saves migrate');

// --- Ride math (src/game.js) -----------------------------------------------------
const game = require('../src/game');
assert.deepStrictEqual(game.rideMultipliers({ multiplier: 10 }, 10), { floor: 10, ceiling: 20 });
assert.deepStrictEqual(game.rideMultipliers({ multiplier: 20 }, 10), { floor: 20, ceiling: 30 });
assert.deepStrictEqual(game.rideMultipliers({ multiplier: 30 }, 10), { floor: 30, ceiling: 30 }, 'rides run flat at the cap');
assert.deepStrictEqual(game.rideMultipliers({ multiplier: 5 }, 5), { floor: 5, ceiling: 10 });
const o = Date.now();
const ride = { opened_at: new Date(o).toISOString(), matures_at: new Date(o + 864e5).toISOString(), multiplier: 20, mult_floor: 10 };
assert.strictEqual(game.effectiveMultiplier(ride, o), 10, 'a ride starts where the last day ended');
assert.strictEqual(game.effectiveMultiplier(ride, o + 864e5), 20);
const full = game.settle({ invested: 40, value: 60 });
const half = game.settle({ invested: 40, value: 60 }, 0.125);
const early = game.settle({ invested: 57.5, value: 57.5, deferred: full.tax - half.tax });
assert.strictEqual(half.tax + early.tax, full.tax, 'ride then sell early pays exactly what collecting would');
assert.strictEqual(game.settle({ invested: 57.5, value: 1, deferred: 2.5 }).tax, 1, 'deferred tax never exceeds what is left');
assert.strictEqual(game.settle({ invested: 57.5, value: 80.5 }).deferred_tax, 0, 'matured: nothing deferred');
ok('ride multipliers climb and cap; deferred tax closes the early-sell gap');

// --- Day-gated cards and the admin overrides -------------------------------------
{
  const t = Town.fresh();
  const ctx = { day: '2026-11-01', uid: 7, unlocked: true, cash: 70, lobbyists: 10, friends: 1, streak: 1 };
  Town.tick(t, ctx);
  let v = Town.view(t, ctx);
  const headlines = v.deck.filter((d) => d.general).length;
  assert(headlines >= 6 && headlines <= 10, `expected a small headline pool, got ${headlines}`);
  const gated = v.deck.filter((d) => /play \d+ days/.test(d.needs));
  assert(gated.length >= 10, 'expected day-gated cards');
  assert(gated.every((d) => d.status === 'locked'), 'day-gated cards are locked on day one');
  assert(/you've played 0 of/.test(v.deck.find((d) => d.general).needs), 'headline cards say how many you have seen');
  assert(/\(you: 1\)/.test(gated[0].needs), 'day-gated cards show your progress');
  for (let d = 2; d <= 12; d++) Town.tick(t, { ...ctx, day: `2026-11-${String(d).padStart(2, '0')}` });
  assert.strictEqual(t.days, 12);
  v = Town.view(t, { ...ctx, day: '2026-11-12' });
  assert(gated.every((g) => v.deck.find((d) => d.id === g.id).status !== 'locked'), 'all day-gated cards open by day 12');
  // Admin: unlock one, deal one, unlock all.
  const t2 = Town.fresh();
  Town.tick(t2, ctx);
  assert.strictEqual(Town.adminUnlock(t2, ['holiday_party']).unlocked, 1);
  assert.strictEqual(Town.view(t2, ctx).deck.find((d) => d.id === 'holiday_party').status, 'available');
  assert.deepStrictEqual(Town.deal(t2, 'audit_return'), { dealt: 'audit_return' });
  assert(t2.issues.some((i) => i.id === 'audit_return'), 'dealt card is on today\'s agenda');
  assert(Town.deal(t2, 'audit_return').error, 'cannot deal the same card twice in a day');
  assert(Town.deal(t2, 'nope').error, 'unknown card is an error');
  assert(Town.adminUnlock(t2, '*').unlocked >= 1);
  assert.strictEqual(Town.view(t2, ctx).deck.filter((d) => d.status === 'locked').length, 0, 'unlock all opens every card');
  const dealt = Town.decide(t2, 'audit_return', 'dolores', 1000);
  assert(!dealt.error, `dealt card can be played: ${dealt.error}`);
  ok('13 cards unlock by days played; admin can unlock, deal, and open the whole deck');
}

// --- A display step of grace: $29.97K buys a $30K building ---------------------
{
  const t = Town.fresh();
  assert.strictEqual(Town.build(t, 'square', 'casino', 29.97, '2026-11-01').cash, -29.97, 'within a display step: takes what is there');
  const t2 = Town.fresh();
  assert(Town.build(t2, 'square', 'casino', 29.8, '2026-11-01').error, '$0.2K short is short');
  const t3 = Town.fresh();
  assert.strictEqual(Town.build(t3, 'square', 'casino', 45, '2026-11-01').cash, -30, 'enough: pays the price');
  assert(Town.canPay(29.95, 30) && !Town.canPay(29.85, 30));
  ok('$29.97K buys a $30K building (charged $29.97K); $29.8K does not');
}

// --- Achievement gifts: a floor, then a share of the money in play -------------
{
  const A = require('../src/achievements');
  const gift = (key, inplay) => A.BY_KEY.get(key).gift({ inplay });
  assert.strictEqual(A.nice(43), 45); assert.strictEqual(A.nice(613), 610); assert.strictEqual(A.nice(1234), 1250);
  assert.strictEqual(gift('first_win', 100), 20, 'early: the floor');
  assert.strictEqual(gift('streak_7', 850), 50, 'a week in, ~$850K in play: 6%');
  assert.strictEqual(gift('streak_30', 4000), 600, 'a month in, ~$4M in play: 15%');
  assert.strictEqual(gift('legend', 1000), 100);
  assert.strictEqual(gift('first_buy', 0), 40, 'day one stays VEST_AMOUNT');
  assert.ok(A.met('power_broker', { lobbyists: 500 }) && !A.met('power_broker', { lobbyists: 499 }), 'Power Broker is 500 lobbyists');
  // Never so big it dwarfs trading: the biggest share is 15% of what's in play.
  for (const a of A.LIST) assert.ok(a.gift({ inplay: 10000 }) <= 1500 + 50, `${a.key} gift capped by share`);
  ok('gifts: floors early, a share of money in play later, rounded like a check');
}

// --- Outcome names: the loss ladder mirrors the gain ladder ---------------------
{
  const game = require('../src/game');
  const t = (pct) => game.tierFor({ invested: 100, value: 100 * (1 + pct) });
  assert.deepStrictEqual([-1, -0.7, -0.5, -0.3, -0.12, -0.05, 0.05, 0.12, 0.3, 0.7, 1.2].map(t),
    ['Rest in peace', 'Comically disastrous', 'Comically disastrous', 'Taking on water', 'Flesh wound', 'Paper cut',
      'Pocket change', 'Respectable', 'Nice', 'Heater', 'Legend']);
  // The share card's copy in the front end must agree.
  const appPath = path.join(__dirname, '../../trickledown-stevenhester-com/js/app.js');
  const app = fs.existsSync(appPath) ? fs.readFileSync(appPath, 'utf8') : '';
  if (app) for (const name of ['Comically disastrous', 'Taking on water', 'Flesh wound', 'Paper cut']) assert.ok(app.includes(`'${name}'`), `app.js knows ${name}`);
  ok('loss tiers: Paper cut, Flesh wound, Taking on water, Comically disastrous, Rest in peace');
}

// --- The cat: day two, named by you, dressed at great expense -------------------
{
  const t = Town.fresh();
  const ctx = (day) => ({ day, unlocked: true, lobbyists: 12, cash: 100, friends: 0, streak: 2, uid: 7 });
  Town.tick(t, ctx('2026-11-01')); Town.ensureIssues(t, ctx('2026-11-01'));
  assert.ok(!t.issues.some((i) => i.id === 'cat'), 'no cat on day one');
  Town.tick(t, ctx('2026-11-02')); Town.ensureIssues(t, ctx('2026-11-02'));
  assert.ok(t.issues.some((i) => i.id === 'cat'), 'the cat is in the hand on day two');
  assert.strictEqual(Town.decide(t, 'cat', 'preston', 100).error, undefined);
  assert.ok(t.cat && t.cat.name === null, 'either side adopts her, unnamed');
  assert.ok(Town.nameCat(t, { name: '<b>', pronoun: 'he' }).error, 'names are letters and numbers');
  assert.strictEqual(Town.nameCat(t, { name: '  Mr.  Biscuits ', pronoun: 'he', coat: 'black' }).cat.name, 'Mr. Biscuits');
  const v = Town.view(t, ctx('2026-11-02'));
  assert.strictEqual(v.cat.coat, 'black');
  const strike = Town.ISSUES.find((i) => i.id === 'cat_strike');
  assert.strictEqual(Town.catWords(v.cat, strike.setup), 'Mr. Biscuits has stopped accepting pets, paid or otherwise. He sits on the register. He stares.');
  assert.ok(Town.buyCatItem(t, 'crown', 500).error, 'the crown costs $1M');
  const r = Town.buyCatItem(t, 'top_hat', 250);
  assert.strictEqual(r.cash, -200); assert.strictEqual(t.cat.wearing.head, 'top_hat');
  Town.buyCatItem(t, 'beret', 100); assert.strictEqual(t.cat.wearing.head, 'beret', 'one hat at a time');
  Town.wearCatItem(t, 'top_hat', true); assert.strictEqual(t.cat.wearing.head, 'top_hat');
  Town.wearCatItem(t, 'top_hat', false); assert.ok(!t.cat.wearing.head);
  assert.strictEqual(t.cat.spent, 240);
  // A town that met the cat before names existed gets Comptroller.
  const old = Town.fresh(); old.played = ['cat']; old.flags = ['cat_mascot']; delete old.cat; Town.migrate(old);
  assert.strictEqual(old.cat.name, 'Comptroller');
  ok('cat: day two, adopted either way, named, dressed, one hat at a time, older towns get Comptroller');
}

// --- Lobbyfest split (the published promises) ------------------------------------
{
  const game = require('../src/game');
  const sum = (r) => Math.round(r.rows.reduce((s, x) => s + x.usd, 0) * 100) / 100;
  // No ad money yet: the $100 minimum still goes out, by headcount.
  let r = game.lobbyfestSplit(0, [{ id: 1, n: 30 }, { id: 2, n: 10 }]);
  assert.strictEqual(r.pot, 100); assert.strictEqual(sum(r), 100);
  assert.deepStrictEqual(r.rows.map((x) => x.usd), [75, 25]);
  // More than the minimum: the ad money, all of it.
  r = game.lobbyfestSplit(250, [{ id: 1, n: 1 }, { id: 2, n: 1 }]);
  assert.strictEqual(r.pot, 250); assert.deepStrictEqual(r.rows.map((x) => x.usd), [125, 125]);
  // Under $5 is left out and the rest is rerun without it: $100 over 96/4
  // lobbyists would give the small one $4, so the big one gets all $100.
  r = game.lobbyfestSplit(100, [{ id: 1, n: 96 }, { id: 2, n: 4 }]);
  assert.deepStrictEqual(r.rows.map((x) => [x.usd, x.left_out]), [[100, false], [0, true]]);
  // Every charity under $5 in a round is left out together, then it reruns.
  r = game.lobbyfestSplit(100, [{ id: 1, n: 85 }, { id: 2, n: 4.9 }, { id: 3, n: 4.9 }, { id: 4, n: 4.9 }, { id: 5, n: 0.3 }]);
  assert.deepStrictEqual(r.rows.filter((x) => !x.left_out).map((x) => x.id), [1]);
  assert.strictEqual(sum(r), 100);
  // Exactly $5 is enough; cents always add up to the pot.
  r = game.lobbyfestSplit(100, [{ id: 1, n: 95 }, { id: 2, n: 5 }]);
  assert.deepStrictEqual(r.rows.map((x) => x.usd), [95, 5]);
  r = game.lobbyfestSplit(100, [{ id: 1, n: 1 }, { id: 2, n: 1 }, { id: 3, n: 1 }]);
  assert.strictEqual(sum(r), 100); assert(r.rows.every((x) => x.usd >= 33.33));
  // No lobbyists anywhere: nobody to pay, nobody left out.
  r = game.lobbyfestSplit(100, [{ id: 1, n: 0 }]);
  assert.deepStrictEqual(r.rows, [{ id: 1, usd: 0, left_out: false }]);
  // More charities than $100 can pay $5 each: the smallest drop one at a time, money still goes out.
  r = game.lobbyfestSplit(100, Array.from({ length: 25 }, (_, i) => ({ id: i + 1, n: 1 + i / 100 })));
  assert.strictEqual(sum(r), 100); assert(r.rows.filter((x) => x.usd > 0).every((x) => x.usd >= 5));
  ok('Lobbyfest split: $100 minimum, proportional, under-$5 left out and rerun, cents add up');
}

// --- Card 66: hiding the meters wears off; posting cancels hiding ----------------
{
  const t = Town.fresh();
  Town.tick(t, { day: '2026-11-01', unlocked: true, uid: 1 });
  t.issues = [{ id: 'followers', chosen: null }];
  assert(!Town.metersHidden(t));
  assert(!Town.decide(t, 'followers', 'preston', 100).error);
  assert(Town.metersHidden(t) && t.last.meters_hidden === '2026-11-01', 'Preston hides the meters, dated');
  assert(Town.metersHidden(t, '2026-11-07') && !Town.metersHidden(t, '2026-11-08'), 'by date alone, even if the town never ticks');
  Town.tick(t, { day: '2026-11-07', unlocked: true, uid: 1 });
  assert(Town.metersHidden(t), 'still hidden on day six');
  Town.tick(t, { day: '2026-11-08', unlocked: true, uid: 1 });
  assert(!Town.metersHidden(t) && !t.last.meters_hidden, 'shown again after seven days');
  t.issues = [{ id: 'followers', chosen: null }];
  Town.decide(t, 'followers', 'preston', 100);
  t.issues = [{ id: 'followers', chosen: null }];
  Town.decide(t, 'followers', 'dolores', 100);
  assert(!Town.metersHidden(t) && t.flags.includes('meters_posted'), 'posting the numbers cancels hiding them');
  // "buy the actual pool", not "buy the the actual pool".
  const built = Town.fresh(); built.plots.housing = 'pinnacle'; built.built.housing = '2026-10-01';
  const needs = Town.view(built, { day: '2026-11-01', unlocked: true }).deck.map((c) => c.needs).join(' ');
  assert(needs.includes('buy the actual pool') && !/the the /i.test(needs), 'no "the the" in unlock text');
  ok('card 66: meters hidden for seven days, posting cancels; no "the the"');
}

// --- 4.2: cards that buy an upgrade ---------------------------------------------
{
  const t = Town.fresh();
  t.plots.housing = 'pinnacle'; t.built.housing = '2026-10-20';
  Town.tick(t, { day: '2026-11-01', unlocked: true, uid: 1 });
  t.issues = [{ id: 'amenity_fee', chosen: null }];
  const view = Town.view(t, { day: '2026-11-01', unlocked: true });
  assert.strictEqual(view.issues[0].dolores.cost, 40, 'the card shows the pool\'s price');
  assert.strictEqual(Town.decide(t, 'amenity_fee', 'dolores', 30).error.includes('costs $40K'), true, 'not enough cash: the pool\'s price');
  const r = Town.decide(t, 'amenity_fee', 'dolores', 100);
  assert(!r.error && r.cash === -40 && t.upgrades.housing.includes('pool'), 'Dolores builds the actual pool, for its price');
  const ctx = { day: '2026-11-02', unlocked: true, uid: 1, lobbyists: 10, cash: 100 };
  assert(!Town.needsMet({ building: 'pinnacle', not_upgrade: 'pool' }, t, ctx), 'not_upgrade: closed once the pool exists');
  t.played = []; // even unplayed, it isn't dealt once the pool is owned
  for (let d = 2; d < 12; d++) { Town.tick(t, { ...ctx, day: `2026-11-${String(d).padStart(2, '0')}` }); assert(!t.issues.some((i) => i.id === 'amenity_fee'), 'amenity_fee dealt after the pool was bought'); }
  // The billing department, same way, on the clinic.
  const c = Town.fresh(); c.plots.square = 'clinic'; c.built.square = '2026-10-20';
  Town.tick(c, { day: '2026-11-01', unlocked: true, uid: 2 });
  c.issues = [{ id: 'clinic_bill', chosen: null }];
  assert(!Town.decide(c, 'clinic_bill', 'preston', 100).error && c.upgrades.square.includes('billing'), 'Preston adds the billing department');
  ok('cards 11 and 15 buy their upgrades at the upgrade price, then stop being dealt');
}

// --- 4.3: newer unlock types -----------------------------------------------------
{
  const t = Town.fresh();
  const met = (needs, ctx) => Town.needsMet(needs, t, { day: '2026-11-06', ...ctx });
  assert(met({ tier_yesterday: 'Rest in peace' }, { tiers_yesterday: ['Nice', 'Rest in peace'] }) && !met({ tier_yesterday: 'Rest in peace' }, { tiers_yesterday: ['Nice'] }) && !met({ tier_yesterday: 'Rest in peace' }, {}), 'tier_yesterday');
  assert(met({ same_ticker_days: 5 }, { same_ticker_days: 5 }) && !met({ same_ticker_days: 5 }, { same_ticker_days: 4 }), 'same_ticker_days');
  assert(met({ charity: true }, { charity_name: 'GiveDirectly' }) && !met({ charity: true }, {}), 'charity');
  assert(met({ days_to_lobbyfest_max: 7 }, { days_to_lobbyfest: 7 }) && !met({ days_to_lobbyfest_max: 7 }, { days_to_lobbyfest: 8 }), 'days_to_lobbyfest_max');
  assert(met({ weekday: 5 }, { weekday: 5 }) && !met({ weekday: 5 }, { weekday: 4 }), 'weekday');
  assert(met({ month: 12 }, { month: 12 }) && !met({ month: 12 }, { month: 11 }), 'month');
  // The deck's words for each.
  const forced = Object.assign(Town.fresh(), { admin_all_open: true });
  const deckText = Object.fromEntries(Town.view(forced, { day: '2026-11-06', unlocked: true }).deck.map((d) => [d.id, d.needs]));
  assert.strictEqual(deckText.draft_rip, 'Happens the day after a position goes to zero.');
  assert.strictEqual(deckText.draft_same_ticker, 'Unlock: buy the same stock 5 days running.');
  assert.strictEqual(deckText.draft_charity, 'Unlock: choose a charity.');
  assert.strictEqual(deckText.draft_lobbyfest_week, 'Happens in the last week before Lobbyfest.');
  assert.strictEqual(deckText.draft_friday, 'Happens on Fridays.');
  assert.strictEqual(deckText.draft_december, 'Happens in December.');
  // Drafts are never dealt or shown to a player, even when they qualify.
  const p = Town.fresh();
  const all = { day: '2026-12-25', unlocked: true, uid: 3, tiers_yesterday: ['Rest in peace'], same_ticker_days: 9, charity_name: 'X', days_to_lobbyfest: 7, weekday: 5, month: 12 };
  for (let d = 0; d < 20; d++) { Town.tick(p, { ...all, day: `2026-12-${String(5 + d).padStart(2, '0')}` }); assert(!p.issues.some((i) => /^draft_/.test(i.id)), 'a draft was dealt'); }
  assert(!Town.view(p, all).deck.some((d) => /^draft_/.test(d.id)), 'a draft is in a player\'s deck');
  // {Charity} in card text.
  assert.strictEqual(Town.catWords(null, 'For {Charity}.', 'GiveDirectly'), 'For GiveDirectly.');
  assert.strictEqual(Town.catWords(null, 'For {Charity}.'), 'For your charity.');
  ok('newer unlock types: each predicate, its deck text, drafts kept out, {Charity}');
}

// --- The digest's "cards expired": every unplayed card from the day before ------
{
  const t = Town.fresh();
  const c = { unlocked: true, uid: 9 };
  Town.tick(t, { ...c, day: '2026-11-01' });
  assert.strictEqual(t.report.expired, 0, 'first day: nothing expired');
  const n = t.issues.length;
  t.issues[0].chosen = 'preston';
  Town.tick(t, { ...c, day: '2026-11-02' });
  assert.strictEqual(t.report.expired, n - 1, 'the unplayed ones expired');
  assert.strictEqual(Town.view(t, { ...c, day: '2026-11-02' }).expired_yesterday, n - 1);
  ok('expired_yesterday counts yesterday\'s unplayed cards');
}

// --- The front end has the same file ------------------------------------------
const fe = path.join(__dirname, '../../trickledown-stevenhester-com/js/town.js');
if (fs.existsSync(fe)) {
  assert.strictEqual(fs.readFileSync(fe, 'utf8'), src, 'front end js/town.js differs from src/town.js: copy it over');
  ok('front end copy is identical');
}

console.log(`\n${checks} checks passed.`);
