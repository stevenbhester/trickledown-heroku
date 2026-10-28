// TrickleTown: the village your lobbyists live in. Pure rules, no I/O.
// The same file ships in the backend (src/town.js) and the front end
// (js/town.js, for demo mode). Edit one, copy to the other.
//
// Four things you steer:
//   income      $/day added to (or taken from) your daily allowance
//   hire cost   $ of tax per lobbyist hired; happier lobbyists come cheaper
//   happiness   0–100
//   health      0–100; below 40, lobbyists start quitting overnight
//
// Two plots, each with a bad / compromise / good building, and each building
// with upgrades. Every day Preston and Dolores bring one or two cards: one
// shared by every player, one from the cards your own town has unlocked.
//
// ctx, passed in by the caller: { day, uid, unlocked, cash, lobbyists }
//   cash       what's on the coin (after today's allowance, at tick time)
//   lobbyists  career total hired
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TownRules = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

  const BUILD_COST = 40;
  const QUIT_BELOW = 40;
  const UNLOCK_AT = 1; // career lobbyists needed before the town opens
  const isUnlocked = (lobbyistsEver) => Number(lobbyistsEver) >= UNLOCK_AT;

  // Per-day pushes. Upgrades add to their building's numbers.
  const PLOTS = {
    housing: {
      label: 'Housing',
      options: {
        tenement: {
          name: 'Tenement Row', tier: 'bad', income: 15, happy: -3, health: -4,
          pitch: { who: 'preston', line: 'Forty units where there used to be eight. Walls are a luxury, and we are not in the luxury business.' },
          sign: 'Now leasing. Always leasing.',
          upgrades: {
            fourth_floor: { name: 'A fourth floor', tier: 'bad', cost: 30, income: 8, health: -3, pitch: { who: 'preston', line: 'Zoning is a suggestion. Gravity is a stronger suggestion, but we have insurance.' } },
            boiler: { name: 'Fix the boiler', tier: 'good', cost: 25, health: 3, happy: 1, pitch: { who: 'dolores', line: 'Heat. In winter. I know. Radical.' } },
          },
        },
        pinnacle: {
          name: 'The Pinnacle', tier: 'compromise', income: 8, happy: 1, health: -2,
          pitch: { who: 'preston', line: '"Luxury living." Granite-look countertops. The rooftop pool is coming soon, legally speaking.' },
          sign: 'Elevated living. Elevator pending.',
          upgrades: {
            doorman: { name: 'A doorman', tier: 'compromise', cost: 25, income: 3, happy: 1, pitch: { who: 'preston', line: 'He says "welcome home." It is in his contract and, as of today, in their lease.' } },
            pool: { name: 'The actual pool', tier: 'good', cost: 40, happy: 3, health: 1, income: -1, pitch: { who: 'dolores', line: 'You advertised a pool. This is the pool. It is small. It is wet. It counts.' } },
          },
        },
        coop: {
          name: 'Maple Co-op', tier: 'good', income: -3, happy: 3, health: 3,
          pitch: { who: 'dolores', line: 'They own it together and fix the boiler themselves. Costs you upkeep, pays you nothing. They will never forget it.' },
          sign: 'Meeting Thursday. Still.',
          upgrades: {
            garden: { name: 'Community garden', tier: 'good', cost: 20, health: 2, happy: 1, income: -1, pitch: { who: 'dolores', line: 'Tomatoes. Morale. Same thing, in August.' } },
            tours: { name: 'Paid co-op tours', tier: 'bad', cost: 20, income: 6, happy: -2, pitch: { who: 'preston', line: 'Tourists love authenticity. We love charging for it. Everyone wins, except the residents, who are the exhibit.' } },
          },
        },
      },
    },
    square: {
      label: 'Town square',
      options: {
        casino: {
          name: 'Lucky Lobby Casino', tier: 'bad', income: 18, happy: 1, health: -3,
          pitch: { who: 'preston', line: 'No clocks, no windows, free drinks. They have a wonderful time and we keep the change. All of the change.' },
          sign: 'The house always wins. You are the house.',
          upgrades: {
            vip: { name: 'VIP room', tier: 'bad', cost: 35, income: 10, happy: -2, health: -1, pitch: { who: 'preston', line: 'A velvet rope. The rope is the product. The room is just where the rope is.' } },
            coffee: { name: 'Free coffee', tier: 'compromise', cost: 15, happy: 2, health: -1, pitch: { who: 'preston', line: 'Keeps them awake. Keeps them playing. Technically a benefit.' } },
          },
        },
        store: {
          name: 'Company Store', tier: 'compromise', income: 8, happy: -1, health: 0,
          pitch: { who: 'preston', line: 'It is the only store. Prices are fair, by which I mean they are prices.' },
          sign: 'Everything you need. Nothing you can afford.',
          upgrades: {
            loyalty: { name: 'Loyalty card', tier: 'bad', cost: 20, income: 5, happy: -1, pitch: { who: 'preston', line: 'Every tenth purchase is 4% off. Every purchase is tracked. Loyalty is a two-way street with one lane.' } },
            pricematch: { name: 'Price match', tier: 'good', cost: 20, happy: 2, income: -2, pitch: { who: 'dolores', line: 'Match the store across the river. If they can, you can.' } },
          },
        },
        clinic: {
          name: 'Free Clinic', tier: 'good', income: -5, happy: 1, health: 4,
          pitch: { who: 'dolores', line: 'A doctor, two nurses, no billing department. Healthy lobbyists stay on the payroll.' },
          sign: 'Walk-ins welcome. Limp-ins too.',
          upgrades: {
            dental: { name: 'Dental wing', tier: 'good', cost: 30, health: 3, income: -2, pitch: { who: 'dolores', line: 'Teeth are health. Legally, somehow, they are not. Here, they are.' } },
            billing: { name: 'Billing department', tier: 'bad', cost: 25, income: 7, health: -2, happy: -2, pitch: { who: 'preston', line: 'Free is a price point. We could explore other price points.' } },
          },
        },
      },
    },
  };

  // Cards. fx keys: cash (one-time), income ($/day, permanent), happy, health
  // (one-time nudges). needs: what unlocks the card. No needs = everyone gets
  // it, one per day. happiness_below / health_below are "it happens when".
  const ISSUES = [
    { id: 'rent_day', title: 'Rent day', setup: 'The lease renewals are on your desk.',
      preston: { label: 'Raise it 9%', line: 'The market will bear it. The market is very strong. I have seen it lift a car.', fx: { income: 4, happy: -8 } },
      dolores: { label: 'Freeze rent', line: "Hold it flat a year. They'll stop eating soup for dinner. Some of them.", fx: { income: -2, happy: 6 } } },
    { id: 'parking', title: 'The parking lot', setup: 'Someone noticed the parking lot is free.',
      preston: { label: 'Paid parking', line: 'Every empty space is a space that could be invoicing.', fx: { income: 3, happy: -5 } },
      dolores: { label: 'Bike racks', line: "Bike racks. They're cheap and the lobbyists get some sun.", fx: { cash: -15, happy: 3, health: 3 } } },
    { id: 'retreat', title: 'Team-building', setup: 'HR says morale is "a vibe."',
      preston: { label: 'Mandatory retreat', line: 'Unpaid weekend retreat. At the casino. Attendance is voluntary and tracked.', fx: { cash: 12, happy: -6, health: -2 } },
      dolores: { label: 'A real day off', line: "Hear me out: a day where nobody does anything. It's called a day off.", fx: { cash: -10, happy: 8, health: 3 } } },
    { id: 'snacks', title: 'The snack machine', setup: 'The vending machine in the lobby is out of everything.',
      preston: { label: 'Surge pricing', line: 'Prices that respond to hunger. The hungrier they are, the more they value a pretzel.', fx: { income: 2, happy: -3, health: -2 } },
      dolores: { label: 'Fruit bowl', line: 'A bowl. Of fruit. Free. I will carry it in myself.', fx: { cash: -8, health: 4 } } },
    { id: 'ball_pit', title: 'The ball pit', setup: 'The lobbyists have submitted a formal request.',
      preston: { label: 'Sell ball-pit NFTs', line: 'Digital ball pit. Unique balls. We mint, they pay, nobody gets wet.', fx: { cash: 12, happy: -3 } },
      dolores: { label: 'Build the ball pit', line: "I'm not saying it's a good idea. I'm saying they voted, and it was unanimous.", fx: { cash: -30, happy: 12 } } },
    { id: 'overtime', title: 'Crunch week', setup: 'Lobbyfest prep is behind schedule.',
      preston: { label: 'Unpaid overtime', line: "We don't call it unpaid. We call it equity in the mission.", fx: { cash: 18, health: -8, happy: -4 } },
      dolores: { label: 'Pay the overtime', line: 'Time and a half. It is the law in most places and a good idea in all of them.', fx: { cash: -12, happy: 4 } } },

    { id: 'flu', needs: { health_below: 55 }, title: 'Flu in the building', setup: 'Half the third floor is coughing.',
      preston: { label: '"Wellness accountability"', line: 'Sick days are a cost center. Also, flu-themed merch.', fx: { cash: 6, health: -7, happy: -4 } },
      dolores: { label: 'Weekend clinic hours', line: "Pay a nurse for Saturdays. They come back faster when they're not coughing on each other.", fx: { cash: -20, health: 12 } } },
    { id: 'petition', needs: { happiness_below: 45 }, title: 'A petition', setup: '212 signatures. Some of them are the same lobbyist.',
      preston: { label: 'Morale is a mindset', line: 'Frame it, hang it in the lobby, and thank them for their feedback.', fx: { happy: -8 } },
      dolores: { label: 'Meet with them', line: "Bring donuts. Listen for twenty minutes. Don't check your phone.", fx: { cash: -12, happy: 10 } } },
    { id: 'strike', needs: { happiness_below: 25 }, title: 'Strike vote', setup: "The village has stopped lobbying. They're outside holding signs. The signs are well-lobbied.",
      preston: { label: 'Hire replacements', line: 'There are always more lobbyists. That is the beauty of lobbyists.', fx: { cash: -25, happy: -10 } },
      dolores: { label: 'Give them the raise', line: "It's the cheapest thing on this list in about a month.", fx: { income: -4, happy: 18 } } },
    { id: 'mold', needs: { building: 'tenement' }, title: 'The mold report', setup: 'The inspector used the word "sentient."',
      preston: { label: 'Paint over it', line: 'A fresh coat of Eggshell Optimism. Mold is just texture.', fx: { cash: -3, health: -10 } },
      dolores: { label: 'Fix the walls', line: "It's the walls, not the paint. It's always the walls.", fx: { cash: -30, health: 12, happy: 3 } } },
    { id: 'amenity_fee', needs: { building: 'pinnacle' }, title: 'The amenities', setup: 'Residents of The Pinnacle are asking where the pool is.',
      preston: { label: 'Add an amenity fee', line: 'The fee funds the amenities. The amenities are the fee.', fx: { income: 5, happy: -7 } },
      dolores: { label: 'Build the pool', line: 'You advertised a pool. Build a pool. Even a small pool. Even a big tub.', fx: { cash: -30, happy: 10, health: 2 } } },
    { id: 'coop_meeting', needs: { building: 'coop' }, title: 'The co-op meeting', setup: 'Hour four. They are discussing the meeting schedule.',
      preston: { label: 'Let me chair it', line: "I'll streamline. First item: I'm the board now.", fx: { income: 4, happy: -8 } },
      dolores: { label: 'Let it run long', line: 'This is what democracy looks like. It looks long.', fx: { happy: 4 } } },
    { id: 'high_roller', needs: { building: 'casino' }, title: 'A high roller', setup: 'One lobbyist has been at the slots since Tuesday.',
      preston: { label: 'Comp him a suite', line: "Keep him comfortable. He's a valued guest and also our quarterly numbers.", fx: { cash: 25, health: -6, happy: -2 } },
      dolores: { label: 'Cut him off', line: "Cut him off and call his sister. She's been calling us.", fx: { cash: -5, happy: 4, health: 3 } } },
    { id: 'scrip', needs: { building: 'store' }, title: 'Payday', setup: 'The Company Store would like to handle payroll.',
      preston: { label: 'Pay them in scrip', line: 'Store credit. Spendable at one (1) store. Ours.', fx: { income: 6, happy: -9 } },
      dolores: { label: 'Price-match outside', line: 'Match the prices at the store across the river. If they can, you can.', fx: { income: -3, happy: 6 } } },
    { id: 'clinic_bill', needs: { building: 'clinic' }, title: 'The clinic budget', setup: 'The Free Clinic has a line out the door. Preston has a spreadsheet.',
      preston: { label: 'Add a billing department', line: 'Free is a price point. We could explore other price points.', fx: { income: 6, health: -6, happy: -4 } },
      dolores: { label: 'Hire another nurse', line: "One more nurse and the line's gone. A line costs you more than a nurse.", fx: { cash: -20, health: 8 } } },

    { id: 'reporter', needs: { lobbyists: 5 }, title: 'A reporter', setup: 'She has questions about the village. She has a notebook. She has already seen the parking lot.',
      preston: { label: 'Lobby the reporter', line: 'We hire a lobbyist to lobby the reporter. Ironic, but effective.', fx: { cash: -15, happy: -2 } },
      dolores: { label: 'Tell her the truth', line: 'Answer the questions. Fix the thing she asks about. Cheaper than a lobbyist, and she might write it down.', fx: { income: -2, happy: 6 } } },
    { id: 'union', needs: { lobbyists: 10 }, title: "They're organizing", setup: 'There is a meeting in the laundry room. Nobody is doing laundry.',
      preston: { label: 'A mandatory meeting', line: 'A mandatory meeting about why unions are sad. Catering is from the Company Store.', fx: { happy: -6 } },
      dolores: { label: 'Recognize the union', line: "Lobbyists, unionizing. You'd think they'd lobby you about it. They did. This is me.", fx: { income: -3, happy: 12, health: 4 } } },
    { id: 'bonus_day', needs: { lobbyists: 25 }, title: 'Bonus season', setup: 'The quarter went well. Someone should be rewarded.',
      preston: { label: 'Bonus yourself', line: 'Leadership is a lonely burden and should be compensated accordingly.', fx: { cash: 40, happy: -8 } },
      dolores: { label: 'Bonus them', line: 'Split it. Evenly. Yes, including the ones in the ball pit.', fx: { cash: -30, happy: 12 } } },
    { id: 'merger', needs: { cash: 120 }, title: 'A merger offer', setup: 'The town across the river is for sale. They have a lake. The lake is, allegedly, mostly water.',
      preston: { label: 'Buy the town', line: 'Synergies. Economies of scale. Also, a lake.', fx: { cash: -100, income: 12, happy: -4 } },
      dolores: { label: 'Pay down the clinic', line: "Pass. Put it toward the people who already live here. They're closer.", fx: { cash: -40, health: 6, happy: 4 } } },
    { id: 'whale', needs: { upgrade: 'vip' }, title: 'A whale in the VIP room', setup: 'He has been there for three days. He is the only one in the room. He seems to like the rope.',
      preston: { label: 'Comp everything', line: 'Suite, steak, a second rope. He is our quarter.', fx: { cash: 30, health: -5, happy: -2 } },
      dolores: { label: 'Cut him off', line: 'Walk him home. He lives in the Tenement. Or he did.', fx: { cash: -5, happy: 3, health: 2 } } },
    { id: 'harvest', needs: { upgrade: 'garden' }, title: 'Harvest day', setup: 'The garden produced. Mostly zucchini. An alarming amount of zucchini.',
      preston: { label: 'Sell it', line: 'Farmers market. Artisanal. Forty dollars a zucchini, and we do not explain why.', fx: { cash: 10, happy: -3 } },
      dolores: { label: 'Potluck', line: 'Everybody brings a dish. All the dishes are zucchini. It is still a potluck.', fx: { happy: 6, health: 2 } } },
  ];
  const BY_ID = new Map(ISSUES.map((i) => [i.id, i]));
  const ALL_UPGRADES = {};
  for (const slot of Object.keys(PLOTS)) for (const [bk, b] of Object.entries(PLOTS[slot].options)) for (const [uk, u] of Object.entries(b.upgrades)) ALL_UPGRADES[uk] = { ...u, key: uk, slot, building: bk };

  function hash(s) {
    let h = 2166136261;
    for (const ch of String(s)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }

  function fresh() {
    return { v: 2, day: null, happiness: 55, health: 70, perks: 0, plots: { housing: null, square: null }, upgrades: { housing: [], square: [] }, issues: [], report: null, played: [] };
  }
  function migrate(t) {
    if (!t.upgrades) t.upgrades = { housing: [], square: [] };
    if (!t.played) t.played = [];
    return t;
  }

  function building(slot, key) { return key ? PLOTS[slot].options[key] : null; }
  function ownedUpgrades(t, slot) {
    const b = building(slot, t.plots[slot]);
    return b ? ((t.upgrades && t.upgrades[slot]) || []).map((k) => b.upgrades[k]).filter(Boolean) : [];
  }

  // Per-day effect of one plot, building plus its upgrades.
  function plotEffects(t, slot) {
    const b = building(slot, t.plots[slot]);
    if (!b) return { income: 0, happy: 0, health: 0 };
    const e = { income: b.income || 0, happy: b.happy || 0, health: b.health || 0 };
    for (const u of ownedUpgrades(t, slot)) { e.income += u.income || 0; e.happy += u.happy || 0; e.health += u.health || 0; }
    return e;
  }
  function effects(t) {
    const e = { income: 0, happy: 0, health: 0 };
    for (const slot of Object.keys(PLOTS)) { const p = plotEffects(t, slot); e.income += p.income; e.happy += p.happy; e.health += p.health; }
    return e;
  }

  function income(t) { return round2(effects(t).income + (t.perks || 0)); }
  function hireCost(t) { return round2(clamp(1.5 - t.happiness / 100, 0.6, 1.5)); }
  function quitRate(t) { return t.health < QUIT_BELOW ? round2((QUIT_BELOW - t.health) / 200) : 0; }
  const hasUpgrade = (t, key) => Object.values(t.upgrades || {}).some((list) => list.includes(key));

  // --- Cards and what unlocks them ---------------------------------------------

  function needsMet(needs, t, ctx) {
    if (!needs) return true;
    if (needs.cash != null && !((ctx.cash || 0) >= needs.cash)) return false;
    if (needs.lobbyists != null && !((ctx.lobbyists || 0) >= needs.lobbyists)) return false;
    if (needs.building && !Object.values(t.plots).includes(needs.building)) return false;
    if (needs.upgrade && !hasUpgrade(t, needs.upgrade)) return false;
    if (needs.happiness_below != null && !(t.happiness < needs.happiness_below)) return false;
    if (needs.health_below != null && !(t.health < needs.health_below)) return false;
    return true;
  }

  function needsText(needs) {
    if (!needs) return 'Everyone gets this one.';
    const parts = [];
    if (needs.cash != null) parts.push(`have $${needs.cash} on the coin at dawn`);
    if (needs.lobbyists != null) parts.push(`hire ${needs.lobbyists} lobbyists, career`);
    if (needs.building) { for (const slot of Object.keys(PLOTS)) { const b = PLOTS[slot].options[needs.building]; if (b) parts.push(`build ${b.name}`); } }
    if (needs.upgrade) { const u = ALL_UPGRADES[needs.upgrade]; if (u) parts.push(`buy the ${u.name.replace(/^([A-Z])(?=[a-z])/, (c) => c.toLowerCase())}`); }
    if (needs.happiness_below != null) parts.push(`happiness drops under ${needs.happiness_below}`);
    if (needs.health_below != null) parts.push(`health drops under ${needs.health_below}`);
    const emergent = needs.happiness_below != null || needs.health_below != null;
    return (emergent ? 'Happens when ' : 'Unlock: ') + parts.join(' and ') + '.';
  }

  function pickIssues(t, ctx) {
    const general = ISSUES.filter((i) => !i.needs);
    const first = general[hash(ctx.day) % general.length];
    const pool = ISSUES.filter((i) => i.needs && needsMet(i.needs, t, ctx));
    let second = pool.length ? pool[hash(`${ctx.day}:${ctx.uid}`) % pool.length] : null;
    if (!second) { const rest = general.filter((i) => i !== first); second = rest[hash(`${ctx.day}:${ctx.uid}:g`) % rest.length]; }
    return [first, second].map((i) => ({ id: i.id, chosen: null }));
  }

  // Start a new day. Returns { ticked, report }. The caller applies
  // report.income to the allowance and report.quit_rate to the lobbyists.
  // While the town is locked nobody brings cards, so nothing can be ignored.
  function tick(t, ctx) {
    migrate(t);
    const { day, unlocked = true } = ctx;
    if (t.day === day) return { ticked: false, report: t.report };
    const firstDay = t.day === null;
    const before = { happiness: t.happiness, health: t.health };
    const ignored = unlocked ? (t.issues || []).filter((i) => !i.chosen).length : 0;
    if (!firstDay) {
      // Buildings push every day; left alone, things drift back toward normal
      // (10% of the way to happiness 55 / health 70), so a town settles at
      // whatever its buildings make "normal" instead of pinning at 0 or 100.
      const e = effects(t);
      let dh = e.happy + (55 - t.happiness) * 0.1;
      let dl = e.health + (70 - t.health) * 0.1;
      dh -= ignored * 2; // being ignored is bad for morale
      t.happiness = clamp(Math.round(t.happiness + dh), 0, 100);
      t.health = clamp(Math.round(t.health + dl), 0, 100);
    }
    t.issues = unlocked ? pickIssues(t, ctx) : [];
    t.report = {
      first_day: firstDay,
      income: income(t),
      happy_delta: t.happiness - before.happiness,
      health_delta: t.health - before.health,
      quit_rate: firstDay ? 0 : quitRate(t),
      quit: 0,
      ignored,
    };
    t.day = day;
    return { ticked: true, report: t.report };
  }

  // The day the town unlocks, deal today's cards right away instead of making
  // the new landlord wait for midnight. Returns true if it changed t.
  function ensureIssues(t, ctx) {
    migrate(t);
    if (!ctx.unlocked || t.day !== ctx.day || (t.issues && t.issues.length)) return false;
    t.issues = pickIssues(t, ctx);
    return true;
  }

  function applyFx(t, fx) {
    t.happiness = clamp(t.happiness + (fx.happy || 0), 0, 100);
    t.health = clamp(t.health + (fx.health || 0), 0, 100);
    t.perks = clamp(round2((t.perks || 0) + (fx.income || 0)), -20, 30);
  }

  // Returns { error } or { cash, fx, side }.
  function decide(t, issueId, side, cashAvailable) {
    migrate(t);
    const slot = (t.issues || []).find((i) => i.id === issueId);
    if (!slot) return { error: "That card isn't on today's agenda." };
    if (slot.chosen) return { error: 'Already decided.' };
    if (side !== 'preston' && side !== 'dolores') return { error: 'Pick Preston or Dolores.' };
    const fx = BY_ID.get(issueId)[side].fx;
    const cash = fx.cash || 0;
    if (cash < 0 && cashAvailable < -cash) return { error: `That costs $${-cash} and you have $${cashAvailable.toFixed(2)} on the coin.` };
    applyFx(t, fx);
    slot.chosen = side;
    if (!t.played.includes(issueId)) t.played.push(issueId);
    return { cash, fx: { ...fx }, side };
  }

  function build(t, slot, key, cashAvailable) {
    migrate(t);
    if (!PLOTS[slot]) return { error: 'No such plot.' };
    if (!PLOTS[slot].options[key]) return { error: 'No such building.' };
    if (t.plots[slot] === key) return { error: "It's already there." };
    if (cashAvailable < BUILD_COST) return { error: `Building costs $${BUILD_COST}. You have $${cashAvailable.toFixed(2)} on the coin.` };
    t.plots[slot] = key;
    t.upgrades[slot] = []; // the old building's upgrades go with it
    return { cash: -BUILD_COST };
  }

  function upgrade(t, slot, key, cashAvailable) {
    migrate(t);
    const b = PLOTS[slot] && building(slot, t.plots[slot]);
    if (!b) return { error: 'Build something there first.' };
    const u = b.upgrades[key];
    if (!u) return { error: `${b.name} doesn't offer that.` };
    if (t.upgrades[slot].includes(key)) return { error: 'Already built.' };
    if (cashAvailable < u.cost) return { error: `${u.name} costs $${u.cost}. You have $${cashAvailable.toFixed(2)} on the coin.` };
    t.upgrades[slot].push(key);
    return { cash: -u.cost };
  }

  // Direction-and-size hints instead of exact numbers.
  function clues(fx) {
    const out = [];
    const n = (v, a, b) => (Math.abs(v) <= a ? 1 : Math.abs(v) <= b ? 2 : 3);
    if (fx.income) out.push({ k: 'allowance', dir: Math.sign(fx.income), n: n(fx.income, 3, 6) });
    if (fx.cash) out.push({ k: 'cash', dir: Math.sign(fx.cash), n: n(fx.cash, 10, 20) });
    if (fx.happy) {
      out.push({ k: 'happiness', dir: Math.sign(fx.happy), n: n(fx.happy, 5, 10) });
      out.push({ k: 'hiring', dir: -Math.sign(fx.happy), n: n(fx.happy, 5, 10) });
    }
    if (fx.health) out.push({ k: 'health', dir: Math.sign(fx.health), n: n(fx.health, 5, 10) });
    return out;
  }
  // Per-day pushes scaled so the arrows read like a week.
  const dailyClues = (e) => clues({ income: e.income, happy: (e.happy || 0) * 3, health: (e.health || 0) * 3 });

  function motto(t) {
    const tiers = Object.keys(PLOTS).map((s) => building(s, t.plots[s])).filter(Boolean).map((b) => b.tier);
    if (!tiers.length) return 'Coming soon. Everything is coming soon.';
    const bad = tiers.filter((x) => x === 'bad').length, good = tiers.filter((x) => x === 'good').length;
    if (t.health < QUIT_BELOW) return 'A great place to have lived.';
    if (bad && !good) return t.happiness < 35 ? 'Where dreams come to be invoiced.' : 'Profitable. Ask us about the other thing.';
    if (good && !bad) return t.happiness > 70 ? 'Surprisingly livable. Suspiciously, even.' : 'Doing our best, which is unusual.';
    return 'Fine. Honestly. Fine.';
  }

  // What the client needs to draw the village and the panel.
  function view(t, ctx = {}) {
    migrate(t);
    const sideView = (i, k) => ({ label: i[k].label, line: i[k].line, clues: clues(i[k].fx), cost: Math.max(0, -(i[k].fx.cash || 0)) });
    return {
      day: t.day,
      happiness: t.happiness,
      health: t.health,
      income: income(t),
      hire_cost: hireCost(t),
      quit_rate: quitRate(t),
      quit_below: QUIT_BELOW,
      build_cost: BUILD_COST,
      unlock_at: UNLOCK_AT,
      motto: motto(t),
      report: t.report,
      plots: Object.entries(PLOTS).map(([slot, p]) => {
        const b = building(slot, t.plots[slot]);
        return {
          slot,
          label: p.label,
          key: t.plots[slot],
          building: b ? {
            key: t.plots[slot], name: b.name, tier: b.tier, sign: b.sign,
            clues: dailyClues(plotEffects(t, slot)),
            upgrades: Object.entries(b.upgrades).map(([uk, u]) => ({
              key: uk, name: u.name, tier: u.tier, cost: u.cost, pitch: u.pitch,
              owned: t.upgrades[slot].includes(uk),
              clues: dailyClues(u),
            })),
          } : null,
          options: Object.entries(p.options).map(([key, o]) => ({ key, name: o.name, tier: o.tier, pitch: o.pitch, clues: dailyClues(o) })),
        };
      }),
      issues: (t.issues || []).map((s) => {
        const i = BY_ID.get(s.id);
        if (!i) return null;
        return { id: i.id, title: i.title, setup: i.setup, general: !i.needs, chosen: s.chosen, preston: sideView(i, 'preston'), dolores: sideView(i, 'dolores') };
      }).filter(Boolean),
      // The whole collection, for the deck view.
      deck: ISSUES.map((i) => {
        const slot = (t.issues || []).find((s) => s.id === i.id);
        const status = slot ? (slot.chosen ? 'played' : 'today') : needsMet(i.needs, t, ctx) ? 'available' : 'locked';
        return { id: i.id, title: i.title, general: !i.needs, status, needs: needsText(i.needs), seen: t.played.includes(i.id) };
      }),
    };
  }

  return { fresh, migrate, tick, ensureIssues, decide, build, upgrade, view, hireCost, income, quitRate, isUnlocked, needsMet, UNLOCK_AT, PLOTS, ISSUES, BUILD_COST };
}));
