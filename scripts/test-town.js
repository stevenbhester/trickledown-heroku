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
  for (let d = 1; d <= days; d++) {
    const ctx = { day: day(d), uid: 7, unlocked: true, cash, lobbyists: 5 + d, friends, streak: d };
    const r = Town.tick(t, ctx);
    assert(Number.isFinite(t.happiness) && Number.isFinite(t.health) && Number.isFinite(Town.income(t)), 'NaN in meters');
    assert(t.happiness >= 0 && t.happiness <= 100 && t.health >= 0 && t.health <= 100, 'meters out of range');
    cash += allowance + (r.report ? r.report.income : 0);
    if (d === 1) { assert(!Town.build(t, 'housing', build[0], cash, ctx.day).error); assert(!Town.build(t, 'square', build[1], cash, ctx.day).error); }
    assert.strictEqual(t.issues.length, 2, 'two cards a day');
    assert.notStrictEqual(t.issues[0].id, t.issues[1].id, 'the same card dealt twice in one day');
    for (const i of t.issues) {
      dealt.push({ id: i.id, day: d });
      const res = Town.decide(t, i.id, typeof side === 'function' ? side(i) : side, cash);
      if (!res.error) cash = Math.max(0, cash + res.cash);
      assert(cash >= 0, 'negative cash');
    }
    cash = Math.min(cash, 250);
  }
  return { t, dealt, cash };
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
ok(`${new Set(nice.dealt.map((x) => x.id)).size} distinct cards in 45 days of a decent town`);

// --- Balance: no pure strategy dominates ----------------------------------------
assert(Town.hireCost(nice.t) < Town.hireCost(mixed.t) && Town.hireCost(mixed.t) < Town.hireCost(mean.t), 'happier towns should hire cheaper');
assert(Town.quitRate(mean.t) > 0 && Town.quitRate(nice.t) === 0 && Town.quitRate(mixed.t) === 0, 'only the extractive town should bleed lobbyists');
assert(Town.income(mean.t) > Town.income(mixed.t) && Town.income(mixed.t) > Town.income(nice.t), 'extraction should pay the most per day');
ok(`extract: +$${Town.income(mean.t)}/day at $${Town.hireCost(mean.t)}/head, ${Math.round(Town.quitRate(mean.t) * 100)}% quit; ` +
   `mixed: +$${Town.income(mixed.t)}/day at $${Town.hireCost(mixed.t)}; nice: $${Town.income(nice.t)}/day at $${Town.hireCost(nice.t)}`);

// --- Old saves ------------------------------------------------------------------
const old = { v: 4, day: '2026-10-30', happiness: 50, health: 60, perks: 0, plots: { housing: 'tenement', square: null }, upgrades: { housing: [], square: [] }, built: { housing: '2026-10-28', square: null }, issues: [], report: null, played: ['strike'], flags: [] };
Town.tick(old, { day: '2026-10-31', uid: 3, unlocked: true, cash: 100, lobbyists: 3 });
assert(old.last && old.issues.length === 2, 'old save did not migrate');
const older = { day: '2026-10-30', happiness: 50, health: 60, plots: { housing: null, square: null }, issues: [] };
Town.tick(older, { day: '2026-10-31', uid: 3, unlocked: true, cash: 100, lobbyists: 3 });
assert(older.upgrades && older.played && older.flags && older.last && older.built, 'oldest save did not migrate');
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

// --- The front end has the same file ------------------------------------------
const fe = path.join(__dirname, '../../trickledown-stevenhester-com/js/town.js');
if (fs.existsSync(fe)) {
  assert.strictEqual(fs.readFileSync(fe, 'utf8'), src, 'front end js/town.js differs from src/town.js: copy it over');
  ok('front end copy is identical');
}

console.log(`\n${checks} checks passed.`);
