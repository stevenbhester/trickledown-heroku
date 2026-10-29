// Achievements: rare milestones, each with a one-time cash gift from Mommy &
// Daddy. The gift is taxed like any win, so it hires lobbyists for the
// player's default charity. Earned automatically (checked on /me and
// GET /achievements); claimed by the player (POST /achievements/claim),
// which is when the money moves.
//
// Day one has exactly one to earn: first_buy, the old "your shares vested"
// windfall, same amount (VEST_AMOUNT).
//
// How big the gift is. Money in play grows fast (every day's allowance stays
// on the coin, so a daily player has ~$1M by day 8 and ~$4M by day 30), and a
// fixed $100K that feels big in week one is a rounding error by week four.
// So past week one a gift is a share of the money you have in play when you
// earn it, with a floor: the richer you are, the more Mommy and Daddy send.
// Of course. Shares are set so each gift hires roughly half a day (week-one
// milestones) to two days (a 30-day streak) of what trading hires at that
// point. See REVIEW.md, "Achievement gifts".
const cfg = require('./config');
const { query } = require('./db');

// $K, rounded to something a parent would write on a check.
function nice(k) {
  const step = k < 100 ? 5 : k < 1000 ? 10 : 50;
  return Math.round(k / step) * step;
}
// floor in $K; share of money in play (cash plus open positions at cost).
const scaled = (floor, share) => (s) => nice(Math.max(floor, share * ((s && s.inplay) || 0)));

// gift is in $K, like everything else. from: who signs the note.
// Was 50, which a daily player passes in week one. 500 is about three weeks.
const POWER_BROKER = 500;
const LIST = [
  {
    key: 'first_buy', title: 'Skin in the Game', how: 'Make your first investment.', from: 'Daddy',
    gift: () => cfg.vestAmount,
    note: "Proud of you, champ. Here's a little something so you never have to touch the principal.",
  },
  {
    key: 'first_win', title: 'Realized Gains', how: 'Cash out a profit.', from: 'Mommy', gift: scaled(20, 0.04),
    note: 'Your first real money! Daddy got misty. Buy yourself something with a crest on it.',
  },
  {
    key: 'first_bust', title: 'Character Building', how: 'Lose a whole position.', from: 'Daddy', gift: scaled(25, 0.06),
    note: 'Everybody loses one. I lost a shipping line. This should cover it.',
  },
  {
    key: 'networking', title: 'Networking', how: 'Add 3 friends.', from: 'Mommy', gift: scaled(20, 0.04),
    note: 'Wonderful, darling. Who are their parents?',
  },
  {
    key: 'streak_7', title: 'Creature of Habit', how: 'Play 7 days in a row.', from: 'Mommy', gift: scaled(30, 0.06),
    note: 'A whole week! You get the discipline from my side.',
  },
  {
    key: 'landlord', title: 'Landlord', how: 'Build on every lot in TrickleTown.', from: 'Daddy', gift: scaled(40, 0.04),
    note: 'Property. Finally, a real job.',
  },
  {
    key: 'let_it_ride', title: 'Let It Ride', how: 'Ride the same position twice.', from: 'Daddy', gift: scaled(40, 0.04),
    note: 'Never take money off the table. Your grandfather never did, and look at him. Well, look at his portrait.',
  },
  {
    key: 'legend', title: 'Legendary', how: 'Cash out at Legend tier (double your money or better).', from: 'Mommy', gift: scaled(50, 0.10),
    note: "I told everyone at the club. They're asking who your advisor is.",
  },
  {
    key: 'power_broker', title: 'Power Broker', how: `Hire ${POWER_BROKER} lobbyists, career.`, from: 'Mommy', gift: scaled(60, 0.10),
    note: 'Five hundred! Your father had four hundred and they named an interchange after him.',
  },
  {
    key: 'streak_30', title: 'Clocked In', how: 'Play 30 days in a row.', from: 'Daddy', gift: scaled(100, 0.15),
    note: 'Thirty days without missing one. Nobody in this family has ever done that. Not even at the office.',
  },
  {
    key: 'seven_figures', title: 'Seven Figures', how: 'Have $1M on the coin at once.', from: 'Daddy', gift: scaled(100, 0.06),
    note: "A million! They say the first one is the hardest. I wouldn't know.",
  },
];
const BY_KEY = new Map(LIST.map((a) => [a.key, a]));

// Where the player stands, for "met" and for progress bars.
async function stats(user, db = { query }) {
  const { rows: [p] } = await db.query(
    `SELECT COUNT(*) FILTER (WHERE status NOT IN ('vested', 'gift'))::int AS bought,
            COALESCE(BOOL_OR(status IN ('closed', 'rolled') AND profit > 0), false) AS won,
            COALESCE(BOOL_OR(status = 'closed' AND invested > 0 AND proceeds <= 0), false) AS bust,
            COALESCE(BOOL_OR(status IN ('closed', 'rolled') AND tier = 'Legend'), false) AS legend,
            COALESCE(MAX(ride_count), 0)::int AS rides,
            COALESCE(SUM(COALESCE(matured_value, invested)) FILTER (WHERE status = 'open'), 0)::float8 AS held
       FROM positions WHERE user_id = $1`,
    [user.id],
  );
  const { rows: [f] } = await db.query('SELECT COUNT(*)::int AS n FROM friends WHERE user_id = $1', [user.id]);
  const plots = user.town && user.town.plots ? Object.values(user.town.plots) : [];
  return {
    bought: p.bought, won: p.won, bust: p.bust, legend: p.legend, rides: p.rides,
    friends: f.n, streak: user.streak || 0, cash: Number(user.cash) || 0, lobbyists: Number(user.total_donated) || 0,
    inplay: (Number(user.cash) || 0) + (Number(p.held) || 0),
    built: plots.filter(Boolean).length, lots: plots.length || 2,
  };
}

// { have, need } for anything with a count; null for one-off events.
function progress(key, s) {
  switch (key) {
    case 'first_buy': return { have: Math.min(s.bought, 1), need: 1 };
    case 'networking': return { have: Math.min(s.friends, 3), need: 3 };
    case 'streak_7': return { have: Math.min(s.streak, 7), need: 7 };
    case 'streak_30': return { have: Math.min(s.streak, 30), need: 30 };
    case 'landlord': return { have: Math.min(s.built, s.lots), need: s.lots };
    case 'let_it_ride': return { have: Math.min(s.rides, 2), need: 2 };
    case 'power_broker': return { have: Math.min(Math.floor(s.lobbyists), POWER_BROKER), need: POWER_BROKER };
    case 'seven_figures': return { have: Math.min(Math.floor(s.cash), 1000), need: 1000, money: true };
    default: return null;
  }
}

function met(key, s) {
  switch (key) {
    case 'first_buy': return s.bought >= 1;
    case 'first_win': return s.won;
    case 'first_bust': return s.bust;
    case 'networking': return s.friends >= 3;
    case 'streak_7': return s.streak >= 7;
    case 'streak_30': return s.streak >= 30;
    case 'landlord': return s.lots > 0 && s.built >= s.lots;
    case 'let_it_ride': return s.rides >= 2;
    case 'legend': return s.legend;
    case 'power_broker': return s.lobbyists >= POWER_BROKER;
    case 'seven_figures': return s.cash >= 1000;
    default: return false;
  }
}

// Record anything newly earned (once; earned_at sticks). Returns the view.
async function sync(user) {
  const s = await stats(user);
  const { rows: had } = await query('SELECT * FROM achievements WHERE user_id = $1', [user.id]);
  const have = new Map(had.map((r) => [r.key, r]));
  const fresh = LIST.filter((a) => !have.has(a.key) && met(a.key, s));
  for (const a of fresh) {
    const { rows: [r] } = await query(
      `INSERT INTO achievements (user_id, key, gift) VALUES ($1, $2, $3)
       ON CONFLICT (user_id, key) DO NOTHING RETURNING *`,
      [user.id, a.key, a.gift(s)],
    );
    if (r) have.set(a.key, r);
  }
  return view(have, s);
}

function view(have, s) {
  const list = LIST.map((a) => {
    const r = have.get(a.key);
    return {
      key: a.key, title: a.title, how: a.how, from: a.from, note: a.note,
      gift: r && r.gift != null ? Number(r.gift) : a.gift(s),
      earned_at: r ? r.earned_at : null,
      claimed_at: r ? r.claimed_at : null,
      lobbyists: r && r.lobbyists != null ? Number(r.lobbyists) : null,
      progress: r ? null : progress(a.key, s),
    };
  });
  return {
    list,
    unclaimed: list.filter((a) => a.earned_at && !a.claimed_at).map((a) => a.key),
    earned: list.filter((a) => a.earned_at).length,
    total: list.length,
  };
}

module.exports = { LIST, BY_KEY, stats, progress, met, sync, nice, scaled, POWER_BROKER };
