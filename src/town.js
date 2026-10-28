// Lobbyton: the village your lobbyists live in. Pure rules, no I/O.
// The same file ships in the backend (src/town.js) and the front end
// (js/town.js, for demo mode). Edit one, copy to the other.
//
// Four things you steer:
//   income      $/day added to (or taken from) your daily allowance
//   hire cost   $ of tax per lobbyist hired; happier lobbyists come cheaper
//   happiness   0–100
//   health      0–100; below 40, lobbyists start quitting overnight
//
// Two plots to start (housing, square), each with a bad / compromise / good
// option. Every day Preston and Dolores bring one or two issues: one shared by
// every player, one triggered by your own town.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TownRules = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

  const BUILD_COST = 40;
  const QUIT_BELOW = 40;

  const PLOTS = {
    housing: {
      label: 'Housing',
      options: {
        tenement: {
          name: 'Tenement Row', tier: 'bad', income: 15, happy: -3, health: -4,
          pitch: { who: 'preston', line: 'Forty units where there used to be eight. Walls are a luxury, and we are not in the luxury business.' },
        },
        pinnacle: {
          name: 'The Pinnacle', tier: 'compromise', income: 8, happy: 1, health: -2,
          pitch: { who: 'preston', line: '"Luxury living." Granite-look countertops. The rooftop pool is coming soon, legally speaking.' },
        },
        coop: {
          name: 'Maple Co-op', tier: 'good', income: -3, happy: 3, health: 3,
          pitch: { who: 'dolores', line: 'They own it together and fix the boiler themselves. Costs you upkeep, pays you nothing. They will never forget it.' },
        },
      },
    },
    square: {
      label: 'Town square',
      options: {
        casino: {
          name: 'Lucky Lobby Casino', tier: 'bad', income: 18, happy: 1, health: -3,
          pitch: { who: 'preston', line: 'No clocks, no windows, free drinks. They have a wonderful time and we keep the change. All of the change.' },
        },
        store: {
          name: 'Company Store', tier: 'compromise', income: 8, happy: -1, health: 0,
          pitch: { who: 'preston', line: 'It is the only store. Prices are fair, by which I mean they are prices.' },
        },
        clinic: {
          name: 'Free Clinic', tier: 'good', income: -5, happy: 1, health: 4,
          pitch: { who: 'dolores', line: 'A doctor, two nurses, no billing department. Healthy lobbyists stay on the payroll.' },
        },
      },
    },
  };

  // fx keys: cash (one-time, from your coin), income ($/day, permanent),
  // happy, health (one-time nudges).
  // general: everyone gets these, one picked per day. Others need `when`.
  const ISSUES = [
    {
      id: 'rent_day', general: true, title: 'Rent day',
      setup: 'The lease renewals are on your desk.',
      preston: { label: 'Raise it 9%', line: 'The market will bear it. The market is very strong. I have seen it lift a car.', fx: { income: 4, happy: -8 } },
      dolores: { label: 'Freeze rent', line: "Hold it flat a year. They'll stop eating soup for dinner. Some of them.", fx: { income: -2, happy: 6 } },
    },
    {
      id: 'parking', general: true, title: 'The parking lot',
      setup: 'Someone noticed the parking lot is free.',
      preston: { label: 'Paid parking', line: 'Every empty space is a space that could be invoicing.', fx: { income: 3, happy: -5 } },
      dolores: { label: 'Bike racks', line: "Bike racks. They're cheap and the lobbyists get some sun.", fx: { cash: -15, happy: 3, health: 3 } },
    },
    {
      id: 'retreat', general: true, title: 'Team-building',
      setup: 'HR says morale is "a vibe."',
      preston: { label: 'Mandatory retreat', line: 'Unpaid weekend retreat. At the casino. Attendance is voluntary and tracked.', fx: { cash: 12, happy: -6, health: -2 } },
      dolores: { label: 'A real day off', line: "Hear me out: a day where nobody does anything. It's called a day off.", fx: { cash: -10, happy: 8, health: 3 } },
    },
    {
      id: 'snacks', general: true, title: 'The snack machine',
      setup: 'The vending machine in the lobby is out of everything.',
      preston: { label: 'Surge pricing', line: 'Prices that respond to hunger. The hungrier they are, the more they value a pretzel.', fx: { income: 2, happy: -3, health: -2 } },
      dolores: { label: 'Fruit bowl', line: 'A bowl. Of fruit. Free. I will carry it in myself.', fx: { cash: -8, health: 4 } },
    },
    {
      id: 'ball_pit', general: true, title: 'The ball pit',
      setup: 'The lobbyists have submitted a formal request.',
      preston: { label: 'Sell ball-pit NFTs', line: 'Digital ball pit. Unique balls. We mint, they pay, nobody gets wet.', fx: { cash: 12, happy: -3 } },
      dolores: { label: 'Build the ball pit', line: "I'm not saying it's a good idea. I'm saying they voted, and it was unanimous.", fx: { cash: -30, happy: 12 } },
    },
    {
      id: 'overtime', general: true, title: 'Crunch week',
      setup: 'Lobbyfest prep is behind schedule.',
      preston: { label: 'Unpaid overtime', line: "We don't call it unpaid. We call it equity in the mission.", fx: { cash: 18, health: -8, happy: -4 } },
      dolores: { label: 'Pay the overtime', line: 'Time and a half. It is the law in most places and a good idea in all of them.', fx: { cash: -12, happy: 4 } },
    },
    {
      id: 'flu', when: (t) => t.health < 55, title: 'Flu in the building',
      setup: 'Half the third floor is coughing.',
      preston: { label: '"Wellness accountability"', line: 'Sick days are a cost center. Also, flu-themed merch.', fx: { cash: 6, health: -7, happy: -4 } },
      dolores: { label: 'Weekend clinic hours', line: "Pay a nurse for Saturdays. They come back faster when they're not coughing on each other.", fx: { cash: -20, health: 12 } },
    },
    {
      id: 'petition', when: (t) => t.happiness < 45, title: 'A petition',
      setup: '212 signatures. Some of them are the same lobbyist.',
      preston: { label: 'Morale is a mindset', line: 'Frame it, hang it in the lobby, and thank them for their feedback.', fx: { happy: -8 } },
      dolores: { label: 'Meet with them', line: "Bring donuts. Listen for twenty minutes. Don't check your phone.", fx: { cash: -12, happy: 10 } },
    },
    {
      id: 'strike', when: (t) => t.happiness < 25, title: 'Strike vote',
      setup: "The village has stopped lobbying. They're standing outside holding signs. The signs are well-lobbied.",
      preston: { label: 'Hire replacements', line: 'There are always more lobbyists. That is the beauty of lobbyists.', fx: { cash: -25, happy: -10 } },
      dolores: { label: 'Give them the raise', line: "It's the cheapest thing on this list in about a month.", fx: { income: -4, happy: 18 } },
    },
    {
      id: 'mold', when: (t) => t.plots.housing === 'tenement', title: 'The mold report',
      setup: 'The inspector used the word "sentient."',
      preston: { label: 'Paint over it', line: 'A fresh coat of Eggshell Optimism. Mold is just texture.', fx: { cash: -3, health: -10 } },
      dolores: { label: 'Fix the walls', line: "It's the walls, not the paint. It's always the walls.", fx: { cash: -30, health: 12, happy: 3 } },
    },
    {
      id: 'amenity_fee', when: (t) => t.plots.housing === 'pinnacle', title: 'The amenities',
      setup: 'Residents of The Pinnacle are asking where the pool is.',
      preston: { label: 'Add an amenity fee', line: 'The fee funds the amenities. The amenities are the fee.', fx: { income: 5, happy: -7 } },
      dolores: { label: 'Build the pool', line: "You advertised a pool. Build a pool. Even a small pool. Even a big tub.", fx: { cash: -30, happy: 10, health: 2 } },
    },
    {
      id: 'coop_meeting', when: (t) => t.plots.housing === 'coop', title: 'The co-op meeting',
      setup: 'The co-op meeting is in hour four. They are discussing the meeting schedule.',
      preston: { label: 'Let me chair it', line: "I'll streamline. First item: I'm the board now.", fx: { income: 4, happy: -8 } },
      dolores: { label: 'Let it run long', line: 'This is what democracy looks like. It looks long.', fx: { happy: 4 } },
    },
    {
      id: 'high_roller', when: (t) => t.plots.square === 'casino', title: 'A high roller',
      setup: 'One lobbyist has been at the slots since Tuesday.',
      preston: { label: 'Comp him a suite', line: "Keep him comfortable. He's a valued guest and also our quarterly numbers.", fx: { cash: 25, health: -6, happy: -2 } },
      dolores: { label: 'Cut him off', line: "Cut him off and call his sister. She's been calling us.", fx: { cash: -5, happy: 4, health: 3 } },
    },
    {
      id: 'scrip', when: (t) => t.plots.square === 'store', title: 'Payday',
      setup: 'The Company Store would like to handle payroll.',
      preston: { label: 'Pay them in scrip', line: 'Store credit. Spendable at one (1) store. Ours.', fx: { income: 6, happy: -9 } },
      dolores: { label: 'Price-match outside', line: 'Match the prices at the store across the river. If they can, you can.', fx: { income: -3, happy: 6 } },
    },
    {
      id: 'clinic_bill', when: (t) => t.plots.square === 'clinic', title: 'The clinic budget',
      setup: 'The Free Clinic has a line out the door. Preston has a spreadsheet.',
      preston: { label: 'Add a billing department', line: 'Free is a price point. We could explore other price points.', fx: { income: 6, health: -6, happy: -4 } },
      dolores: { label: 'Hire another nurse', line: "One more nurse and the line's gone. A line costs you more than a nurse.", fx: { cash: -20, health: 8 } },
    },
  ];
  const BY_ID = new Map(ISSUES.map((i) => [i.id, i]));

  function hash(s) {
    let h = 2166136261;
    for (const ch of String(s)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }

  function fresh() {
    return { v: 1, day: null, happiness: 55, health: 70, perks: 0, plots: { housing: null, square: null }, issues: [], report: null };
  }

  function building(slot, key) { return key ? PLOTS[slot].options[key] : null; }
  function buildings(t) { return Object.keys(PLOTS).map((s) => building(s, t.plots[s])).filter(Boolean); }

  function income(t) { return round2(buildings(t).reduce((s, b) => s + b.income, 0) + (t.perks || 0)); }
  function hireCost(t) { return round2(clamp(1.5 - t.happiness / 100, 0.6, 1.5)); }
  function quitRate(t) { return t.health < QUIT_BELOW ? round2((QUIT_BELOW - t.health) / 200) : 0; }

  function pickIssues(t, day, uid) {
    const general = ISSUES.filter((i) => i.general);
    const first = general[hash(day) % general.length];
    const emergent = ISSUES.filter((i) => !i.general && i.when(t));
    let second = emergent.length ? emergent[hash(`${day}:${uid}`) % emergent.length] : null;
    if (!second) {
      const rest = general.filter((i) => i !== first);
      second = rest[hash(`${day}:${uid}:g`) % rest.length];
    }
    return [first, second].map((i) => ({ id: i.id, chosen: null }));
  }

  // Start a new day. Returns { ticked, report }. The caller applies
  // report.income to the allowance and report.quit_rate to the lobbyists.
  function tick(t, { day, uid }) {
    if (t.day === day) return { ticked: false, report: t.report };
    const firstDay = t.day === null;
    const before = { happiness: t.happiness, health: t.health };
    const ignored = (t.issues || []).filter((i) => !i.chosen).length;
    if (!firstDay) {
      const bs = buildings(t);
      // Buildings push every day; left alone, things drift back toward normal
      // (10% of the way to happiness 55 / health 70), so a town settles at
      // whatever its buildings make "normal" instead of pinning at 0 or 100.
      let dh = bs.reduce((s, b) => s + b.happy, 0) + (55 - t.happiness) * 0.1;
      let dl = bs.reduce((s, b) => s + b.health, 0) + (70 - t.health) * 0.1;
      dh -= ignored * 2; // being ignored is bad for morale
      t.happiness = clamp(Math.round(t.happiness + dh), 0, 100);
      t.health = clamp(Math.round(t.health + dl), 0, 100);
    }
    t.issues = pickIssues(t, day, uid);
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

  function applyFx(t, fx) {
    t.happiness = clamp(t.happiness + (fx.happy || 0), 0, 100);
    t.health = clamp(t.health + (fx.health || 0), 0, 100);
    t.perks = clamp(round2((t.perks || 0) + (fx.income || 0)), -20, 30);
  }

  // Returns { error } or { cash } (the one-time cash change for the caller).
  function decide(t, issueId, side, cashAvailable) {
    const slot = (t.issues || []).find((i) => i.id === issueId);
    if (!slot) return { error: "That issue isn't on today's agenda." };
    if (slot.chosen) return { error: 'Already decided.' };
    if (side !== 'preston' && side !== 'dolores') return { error: 'Pick Preston or Dolores.' };
    const fx = BY_ID.get(issueId)[side].fx;
    const cash = fx.cash || 0;
    if (cash < 0 && cashAvailable < -cash) return { error: `That costs $${-cash} and you have $${cashAvailable.toFixed(2)} on the coin.` };
    applyFx(t, fx);
    slot.chosen = side;
    return { cash };
  }

  function build(t, slot, key, cashAvailable) {
    if (!PLOTS[slot]) return { error: 'No such plot.' };
    if (!PLOTS[slot].options[key]) return { error: 'No such building.' };
    if (t.plots[slot] === key) return { error: "It's already there." };
    if (cashAvailable < BUILD_COST) return { error: `Building costs $${BUILD_COST}. You have $${cashAvailable.toFixed(2)} on the coin.` };
    t.plots[slot] = key;
    return { cash: -BUILD_COST };
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

  // What the client needs to draw the village and the panel.
  function view(t) {
    return {
      day: t.day,
      happiness: t.happiness,
      health: t.health,
      income: income(t),
      hire_cost: hireCost(t),
      quit_rate: quitRate(t),
      quit_below: QUIT_BELOW,
      build_cost: BUILD_COST,
      report: t.report,
      plots: Object.entries(PLOTS).map(([slot, p]) => ({
        slot,
        label: p.label,
        key: t.plots[slot],
        building: t.plots[slot] ? { key: t.plots[slot], ...p.options[t.plots[slot]] } : null,
        options: Object.entries(p.options).map(([key, o]) => ({
          key, name: o.name, tier: o.tier, pitch: o.pitch,
          clues: clues({ income: o.income, happy: o.happy * 3, health: o.health * 3 }), // per-day drift, scaled so the arrows read like a week
        })),
      })),
      issues: (t.issues || []).map((s) => {
        const i = BY_ID.get(s.id);
        if (!i) return null;
        const side = (k) => ({ label: i[k].label, line: i[k].line, clues: clues(i[k].fx), cost: Math.max(0, -(i[k].fx.cash || 0)) });
        return { id: i.id, title: i.title, setup: i.setup, general: !!i.general, chosen: s.chosen, preston: side('preston'), dolores: side('dolores') };
      }).filter(Boolean),
    };
  }

  return { fresh, tick, decide, build, view, hireCost, income, quitRate, PLOTS, ISSUES, BUILD_COST };
}));
