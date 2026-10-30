// TrickleTown: the village your lobbyists live in. Pure rules, no I/O.
// The same file ships in the backend (src/town.js) and the front end
// (js/town.js, for demo mode). Edit one, copy to the other.
//
// Two scores, that's all:
//   profit      $/day the village adds to (or takes from) your daily allowance
//   happiness   0–100; sets the lobbyist price: $1.3K a head at 0, $700 at 100
// Extraction pays you more every day; decency makes every lobbyist cheaper.
//
// Two plots, each with an extractive / compromise / decent building, and each
// building with upgrades. Every day Preston and Dolores bring cards: a
// headline shared by every player, plus cards your own town has unlocked.
//
// ctx, passed in by the caller: { day, uid, unlocked, cash, lobbyists, friends, streak }
//   cash       what's on the coin (after today's allowance, at tick time)
//   lobbyists  career total hired
//   friends    how many friends the player has added
//   streak     current daily streak
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TownRules = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

  const BUILD_COST = 40;
  const UNLOCK_AT = 1; // career lobbyists needed before the town opens
  const isUnlocked = (lobbyistsEver) => Number(lobbyistsEver) >= UNLOCK_AT;

  // Per-day pushes. Upgrades add to their building's numbers.
  const PLOTS = {
    housing: {
      label: 'Housing',
      options: {
        tenement: {
          name: 'Tenement Row', tier: 'bad', income: 18, happy: -4, cost: 20,
          pitch: { who: 'preston', line: 'Forty units where there used to be eight. Walls are a luxury, and we are not in the luxury business.' },
          sign: 'Now leasing. Always leasing.',
          upgrades: {
            fourth_floor: { name: 'A fourth floor', tier: 'bad', cost: 30, income: 8, happy: -2, needs: { days: 2 }, pitch: { who: 'preston', line: 'Zoning is a suggestion. Gravity is a stronger suggestion, but we have insurance.' }, objection: 'The third floor is held up by a rumor.' },
            boiler: { name: 'Fix the boiler', tier: 'good', cost: 25, happy: 3, needs: { happiness_below: 50 }, pitch: { who: 'dolores', line: 'Heat. In winter. I know. Radical.' }, objection: 'Sweaters are cheaper, and they come in colors.' },
          },
        },
        pinnacle: {
          name: 'The Pinnacle', tier: 'compromise', income: 8, happy: -1, cost: 40,
          pitch: { who: 'preston', line: '"Luxury living." Granite-look countertops. The rooftop pool is coming soon, legally speaking.' },
          sign: 'Elevated living. Elevator pending.',
          upgrades: {
            doorman: { name: 'A doorman', tier: 'compromise', cost: 25, income: 3, happy: 1, needs: { days: 1 }, pitch: { who: 'preston', line: 'He says "welcome home." It is in his contract and, as of today, in their lease.' }, objection: 'A doorman who also reports who comes home late. I read the contract.' },
            pool: { name: 'The actual pool', tier: 'good', cost: 40, happy: 4, income: -1, needs: { lobbyists: 5 }, pitch: { who: 'dolores', line: 'You advertised a pool. This is the pool. It is small. It is wet. It counts.' }, objection: '"Coming soon" is a promise with no end date. It is the best kind.' },
          },
        },
        coop: {
          name: 'Maple Co-op', tier: 'good', income: -3, happy: 5, cost: 60,
          pitch: { who: 'dolores', line: 'They own it together and fix the boiler themselves. Costs you upkeep, pays you nothing. They will never forget it.' },
          sign: 'Meeting Thursday. Still.',
          upgrades: {
            garden: { name: 'Community garden', tier: 'good', cost: 20, happy: 3, income: -1, needs: { days: 2 }, pitch: { who: 'dolores', line: 'Tomatoes. Morale. Same thing, in August.' }, objection: 'Dirt. You would be paying for dirt. Premium dirt, but dirt.' },
            tours: { name: 'Paid co-op tours', tier: 'bad', cost: 20, income: 6, happy: -2, needs: { cash: 60 }, pitch: { who: 'preston', line: 'Tourists love authenticity. We love charging for it. Everyone wins, except the residents, who are the exhibit.' }, objection: 'They live there. It is not a zoo. It is barely a co-op.' },
          },
        },
      },
    },
    square: {
      label: 'Town square',
      options: {
        casino: {
          name: 'Lucky Lobby Casino', tier: 'bad', income: 18, happy: -5, cost: 30,
          pitch: { who: 'preston', line: 'No clocks, no windows, free drinks. They have a wonderful time and we keep the change. All of the change.' },
          sign: 'The house always wins. You are the house.',
          upgrades: {
            vip: { name: 'VIP room', tier: 'bad', cost: 35, income: 10, happy: -3, needs: { lobbyists: 5 }, pitch: { who: 'preston', line: 'A velvet rope. The rope is the product. The room is just where the rope is.' }, objection: 'A smaller room where the same people lose more. Bold.' },
            coffee: { name: 'Free coffee', tier: 'compromise', cost: 15, happy: 1, needs: { days: 1 }, pitch: { who: 'preston', line: 'Keeps them awake. Keeps them playing. Technically a benefit.' }, objection: 'Free coffee in a casino is not kindness. It is logistics.' },
          },
        },
        store: {
          name: 'Company Store', tier: 'compromise', income: 8, happy: -2, cost: 40,
          pitch: { who: 'preston', line: 'It is the only store. Prices are fair, by which I mean they are prices.' },
          sign: 'Everything you need. Nothing you can afford. Cards cost 20% less here.',
          card_discount: 0.2,
          upgrades: {
            loyalty: { name: 'Loyalty card', tier: 'bad', cost: 20, income: 5, happy: -1, needs: { days: 1 }, pitch: { who: 'preston', line: 'Every tenth purchase is 4% off. Every purchase is tracked. Loyalty is a two-way street with one lane.' }, objection: 'It is a surveillance program with a punch card.' },
            pricematch: { name: 'Price match', tier: 'good', cost: 20, happy: 2, income: -2, needs: { happiness_below: 50 }, pitch: { who: 'dolores', line: 'Match the store across the river. If they can, you can.' }, objection: 'The store across the river is a lie we tell new hires.' },
          },
        },
        clinic: {
          name: 'Free Clinic', tier: 'good', income: -5, happy: 6, cost: 60,
          pitch: { who: 'dolores', line: 'A doctor, two nurses, no billing department. Healthy lobbyists stay on the payroll.' },
          sign: 'Walk-ins welcome. Limp-ins too.',
          upgrades: {
            dental: { name: 'Dental wing', tier: 'good', cost: 30, happy: 3, income: -2, needs: { days: 3 }, pitch: { who: 'dolores', line: 'Teeth are health. Legally, somehow, they are not. Here, they are.' }, objection: 'Teeth are optional. I have checked with several lobbyists.' },
            billing: { name: 'Billing department', tier: 'bad', cost: 25, income: 7, happy: -3, needs: { cash: 80 }, pitch: { who: 'preston', line: 'Free is a price point. We could explore other price points.' }, objection: '"Free Clinic" is on the sign. The sign was forty dollars.' },
          },
        },
      },
    },
  };

  // Cards. fx keys: cash (one-time), income ($/day of profit, permanent), happy
  // (one-time nudges). needs: what unlocks the card. No needs = everyone gets
  // it, one per day. happiness_below / happiness_above are "it happens when".
  const ISSUES = [
    { id: 'rent_day', title: 'Rent day', setup: 'The lease renewals are on your desk.', ask: 'What happens to the rent?',
      preston: { label: 'Raise rent 9%', line: 'The market will bear it. The market is very strong. I have seen it lift a car.', fx: { income: 4, happy: -8 } },
      dolores: { label: 'Freeze rent', line: "Hold it flat a year. They'll stop eating soup for dinner. Some of them.", fx: { income: -2, happy: 6 } } },
    { id: 'parking', title: 'The parking lot', setup: 'Someone noticed the parking lot is free.', ask: 'What do you do with the lot?',
      preston: { label: 'Charge for parking', line: 'Every empty space is a space that could be invoicing.', fx: { income: 3, happy: -5 } },
      dolores: { label: 'Bike racks instead', line: "Bike racks. They're cheap and the lobbyists get some sun.", fx: { cash: -15, happy: 6 } } },
    { id: 'retreat', title: 'Team-building', setup: 'HR says morale is "a vibe."', ask: 'How do you fix morale?',
      preston: { label: 'Unpaid mandatory retreat', line: 'Unpaid weekend retreat. At the casino. Attendance is voluntary and tracked.', fx: { cash: 12, happy: -8 } },
      dolores: { label: 'Give them a real day off', line: "Hear me out: a day where nobody does anything. It's called a day off.", fx: { cash: -10, happy: 11 } } },
    { id: 'snacks', title: 'The snack machine', setup: 'The vending machine in the lobby is out of everything.', ask: 'How does the machine get restocked?',
      preston: { label: 'Surge pricing on snacks', line: 'Prices that respond to hunger. The hungrier they are, the more they value a pretzel.', fx: { income: 2, happy: -5 } },
      dolores: { label: 'Put out a free fruit bowl', line: 'A bowl. Of fruit. Free. I will carry it in myself.', fx: { cash: -8, happy: 4 } } },
    { id: 'ball_pit', title: 'The ball pit', setup: 'The lobbyists have submitted a formal request.', ask: 'Do they get the ball pit?',
      preston: { label: 'Sell ball-pit NFTs', line: 'Digital ball pit. Unique balls. We mint, they pay, nobody gets wet.', fx: { cash: 12, happy: -3 } },
      dolores: { label: 'Build the ball pit', line: "I'm not saying it's a good idea. I'm saying they voted, and it was unanimous.", fx: { cash: -30, happy: 12 } } },
    { id: 'overtime', title: 'Crunch week', setup: 'Lobbyfest prep is behind schedule.', ask: 'Who pays for the extra hours?',
      preston: { label: 'Unpaid overtime', line: "We don't call it unpaid. We call it equity in the mission.", fx: { cash: 18, happy: -12 } },
      dolores: { label: 'Pay the overtime', line: 'Time and a half. It is the law in most places and a good idea in all of them.', fx: { cash: -12, happy: 4 } } },

    { id: 'flu', needs: { days_played: 6 }, title: 'Flu in the building', setup: 'Half the third floor is coughing.', ask: 'How do you handle the sick days?',
      preston: { label: '"Wellness accountability"', line: 'Sick days are a cost center. Also, flu-themed merch.', fx: { cash: 6, happy: -11 } },
      dolores: { label: 'Weekend clinic hours', line: "Pay a nurse for Saturdays. They come back faster when they're not coughing on each other.", fx: { cash: -20, happy: 12 } } },
    { id: 'petition', needs: { happiness_below: 45 }, title: 'A petition', setup: '212 signatures. Some of them are the same lobbyist.', ask: 'What do you do with the petition?',
      preston: { label: 'Ignore it; morale is a mindset', line: 'Frame it, hang it in the lobby, and bill the signers for the frame.', fx: { cash: 6, happy: -8 } },
      dolores: { label: 'Meet with them', line: "Bring donuts. Listen for twenty minutes. Don't check your phone.", fx: { cash: -12, happy: 10 } } },
    { id: 'strike', needs: { happiness_below: 25 }, title: 'Strike vote', setup: "The village has stopped lobbying. They're outside holding signs. The signs are well-lobbied.", ask: 'How do you end the strike?',
      preston: { label: 'Hire replacements', line: 'There are always more lobbyists, and the new ones work for less. That is the beauty of lobbyists.', fx: { income: 3, happy: -12 } },
      dolores: { label: 'Give them the raise', line: "It's the cheapest thing on this list in about a month.", fx: { income: -4, happy: 18 } } },
    { id: 'mold', needs: { building: 'tenement' }, title: 'The mold report', setup: 'The inspector used the word "sentient."', ask: 'What do you do about the mold?',
      preston: { label: 'Paint over it', line: 'A fresh coat of Eggshell Optimism. Mold is just texture.', fx: { income: 2, happy: -10 } },
      dolores: { label: 'Fix the walls', line: "It's the walls, not the paint. It's always the walls.", fx: { cash: -30, happy: 15 } } },
    { id: 'amenity_fee', needs: { building: 'pinnacle', not_upgrade: 'pool' }, title: 'The amenities', setup: 'Residents of The Pinnacle are asking where the pool is.', ask: 'What do you tell them about the pool?',
      preston: { label: 'Add an amenity fee', line: 'The fee funds the amenities. The amenities are the fee.', fx: { income: 5, happy: -7 } },
      dolores: { label: 'Build the pool', line: 'You advertised a pool. Build a pool. Even a small pool. Even a big tub.', fx: { cash: -40, happy: 4, income: -1 }, buys: 'pool' } },
    { id: 'coop_meeting', needs: { building: 'coop' }, title: 'The co-op meeting', setup: 'Hour four. They are discussing the meeting schedule.', ask: 'How do you handle the meeting?',
      preston: { label: 'Let Preston chair it', line: "I'll streamline. First item: I'm the board now.", fx: { income: 4, happy: -8 } },
      dolores: { label: 'Let it run long', line: 'This is what democracy looks like. It looks long.', fx: { happy: 4 } } },
    { id: 'high_roller', needs: { building: 'casino' }, title: 'A high roller', setup: 'One lobbyist has been at the slots since Tuesday.', ask: 'What do you do about him?',
      preston: { label: 'Comp him a suite', line: "Keep him comfortable. He's a valued guest and also our quarterly numbers.", fx: { cash: 25, happy: -8 } },
      dolores: { label: 'Cut him off', line: "Cut him off and call his sister. She's been calling us.", fx: { cash: -5, happy: 7 } } },
    { id: 'scrip', needs: { building: 'store' }, title: 'Payday', setup: 'The Company Store would like to handle payroll.', ask: 'How do you pay them this month?',
      preston: { label: 'Pay them in scrip', line: 'Store credit. Spendable at one (1) store. Ours.', fx: { income: 6, happy: -9 } },
      dolores: { label: 'Price-match outside', line: 'Match the prices at the store across the river. If they can, you can.', fx: { income: -3, happy: 6 } } },
    { id: 'clinic_bill', needs: { building: 'clinic', not_upgrade: 'billing' }, title: 'The clinic budget', setup: 'The Free Clinic has a line out the door. Preston has a spreadsheet.', ask: 'How do you shorten the line?',
      preston: { label: 'Add a billing department', line: 'Free is a price point. We could explore other price points.', fx: { cash: -25, income: 7, happy: -3 }, buys: 'billing' },
      dolores: { label: 'Hire another nurse', line: "One more nurse and the line's gone. A line costs you more than a nurse.", fx: { cash: -20, happy: 8 } } },

    { id: 'reporter', needs: { lobbyists: 5 }, title: 'A reporter', setup: 'She has questions about the village. She has a notebook. She has already seen the parking lot.', ask: 'What do you tell the reporter?',
      preston: { label: 'Sell her the exclusive', line: 'We sell her an exclusive, then lobby her about what to write in it. Ironic, but profitable.', fx: { cash: 10, happy: -3 } },
      dolores: { label: 'Tell her the truth', line: 'Answer the questions. Fix the thing she asks about. Cheaper than a lobbyist, and she might write it down.', fx: { income: -2, happy: 6 } } },
    { id: 'union', needs: { lobbyists: 10 }, title: "They're organizing", setup: 'There is a meeting in the laundry room. Nobody is doing laundry.', ask: 'Do you recognize the union?',
      preston: { label: 'A mandatory meeting', line: 'A mandatory meeting about why unions are sad. Wages stay exactly where they are. Catering is from the Company Store.', fx: { income: 2, happy: -6 } },
      dolores: { label: 'Recognize the union', line: "Lobbyists, unionizing. You'd think they'd lobby you about it. They did. This is me.", fx: { income: -3, happy: 16 } } },
    { id: 'bonus_day', needs: { lobbyists: 25 }, title: 'Bonus season', setup: 'The quarter went well. Someone should be rewarded.', ask: 'Who gets the bonus?',
      preston: { label: 'Bonus yourself', line: 'Leadership is a lonely burden and should be compensated accordingly.', fx: { cash: 40, happy: -8 } },
      dolores: { label: 'Bonus them', line: 'Split it. Evenly. Yes, including the ones in the ball pit.', fx: { cash: -30, happy: 12 } } },
    { id: 'merger', needs: { cash: 120 }, title: 'A merger offer', setup: 'The town across the river is for sale. They have a lake. The lake is, allegedly, mostly water.', ask: 'Do you buy the town?',
      preston: { label: 'Buy the town', line: 'Synergies. Economies of scale. Also, a lake.', fx: { cash: -100, income: 12, happy: -4 } },
      dolores: { label: 'Spend it here instead', line: "Pass. Put it toward the people who already live here. They're closer.", fx: { cash: -40, happy: 10 } } },
    // Small, cheap, and they come back around. A side with `sets` leaves a mark
    // on the town; later cards need that mark to appear.
    { id: 'lobby_art', title: 'The lobby art', setup: 'The lobby wall is blank. Several lobbyists have noticed. One has a ladder.', ask: 'What goes on the wall?',
      preston: { label: 'Motivational posters', line: '"Hustle." "Grind." "Teamwork," with an eagle. Laminated, so they can never come down.', fx: { cash: 3, happy: -1 }, sets: 'posters' },
      dolores: { label: 'Let them paint a mural', line: 'They have a ladder and a plan. The plan involves a whale. I did not ask why.', fx: { cash: -5, happy: 2 }, sets: 'mural' } },
    { id: 'coffee_cups', title: 'The coffee cups', setup: 'The break room is out of cups again. There is a theory about where they go.', ask: 'How do you solve the cups?',
      preston: { label: 'One cup per person, per day', line: 'A cup policy. Enforced by a cup registry. Staffed by a cup officer.', fx: { income: 1, happy: -2 }, sets: 'cup_policy' },
      dolores: { label: 'Buy mugs with their names on', line: "Twelve dollars. They'll wash them. They'll guard them. They'll bring them to Lobbyfest.", fx: { cash: -6, happy: 2 }, sets: 'mugs' } },
    { id: 'intern', needs: { days_played: 2 }, title: 'An intern', setup: 'A college student wants to learn about lobbying. She is already better at it than most of the staff.', ask: 'Does she get paid?',
      preston: { label: 'Unpaid internship', line: 'She is paid in experience. Experience is priceless, which is why we are not pricing it.', fx: { cash: 5, happy: -2 }, sets: 'unpaid_intern' },
      dolores: { label: 'Pay the intern', line: "Minimum wage. She'll remember who paid her. So will her very online friends.", fx: { cash: -8, happy: 1 }, sets: 'paid_intern' } },
    { id: 'holiday', needs: { days_played: 3 }, title: 'A holiday request', setup: 'The lobbyists would like the day off for a holiday. The holiday is "Thursday."', ask: 'Does Thursday happen?',
      preston: { label: 'Mark it with a sale', line: 'Thursday Sale. Fifteen percent off at the Company Store, redeemable on Thursdays, while working.', fx: { income: 2, happy: -3 }, sets: 'holiday_sale' },
      dolores: { label: 'Give them the day', line: 'Everyone gets Thursday. Thursday is now a thing. You did that.', fx: { cash: -8, happy: 4 }, sets: 'holiday_off' } },
    { id: 'suggestion_box', needs: { days_played: 4 }, title: 'A suggestion box', setup: 'Someone has suggested a suggestion box. The suggestion was made verbally, which is the problem.', ask: 'Does the box get read?',
      preston: { label: 'Install it. Never open it.', line: 'The box is the message. The contents are a liability. A vendor gave us the box free, plus a little extra for the logo.', fx: { cash: 2, happy: -1 }, sets: 'box_ignored' },
      dolores: { label: 'Install it, read it Fridays', line: "I'll read them to you. You'll hate some of them. That's the point.", fx: { cash: -2, happy: 2 }, sets: 'box_read' } },
    { id: 'lawn', needs: { days_played: 5 }, title: 'The lawn', setup: 'The patch of grass behind Housing has not been mowed. Something is living in it.', ask: 'What do you do with the lawn?',
      preston: { label: 'Lay astroturf', line: 'Green forever. Never grows, never dies, never asks for anything. My ideal tenant.', fx: { cash: -10, income: 1 }, sets: 'astroturf' },
      dolores: { label: 'Let it grow wild', line: "Leave it. Whatever's in there is paying more attention to the lobbyists than you are.", fx: { happy: 1 }, sets: 'wild_lawn' } },
    { id: 'name_badges', needs: { days_played: 6 }, title: 'Name badges', setup: 'HR has ordered name badges. HR would like to know what goes on them.', ask: 'What goes on the badges?',
      preston: { label: 'Numbers, not names', line: 'Names change. Numbers scale. Lobbyist 0047 reports to Lobbyist 0012, forever.', fx: { income: 1, happy: -3 }, sets: 'numbered' },
      dolores: { label: 'First names, big type', line: 'First names. Big type. Dolores, in big type, is a lot. I accept this.', fx: { cash: -4, happy: 2 }, sets: 'named' } },

    // The consequences.
    { id: 'mural_viral', needs: { flag: 'mural' }, title: 'The mural went viral', setup: 'Someone posted the whale. The whale has 40,000 likes. The whale has a fan account.', ask: 'What do you do with the fame?',
      preston: { label: 'Sell prints', line: 'Limited edition. Signed by you. You did not paint it, but you did own the wall.', fx: { cash: 20, happy: -3 } },
      dolores: { label: 'Credit the painters', line: 'Put their names on it. Big type. Yes, I have a theme.', fx: { happy: 7 } } },
    { id: 'posters_edited', needs: { flag: 'posters' }, title: 'Someone edited the posters', setup: 'The eagle now has a speech bubble. The speech bubble is about your parking policy. It is accurate.', ask: 'What do you do about the edits?',
      preston: { label: 'Find the culprit', line: 'Handwriting analysis. Hallway cameras. A fine for whoever did it, and fines are revenue.', fx: { cash: 6, happy: -5 } },
      dolores: { label: 'Leave them up', line: "They're funnier now. Morale is up for the first time since the posters.", fx: { happy: 5 } } },
    { id: 'mug_thief', needs: { flag: 'mugs' }, title: 'The mug thief', setup: "Three mugs are missing. Dolores's is one of them. She has a list of suspects. The list is everyone.", ask: 'How do you handle the missing mugs?',
      preston: { label: 'Put cameras in the break room', line: 'Small ones. Tasteful ones. Ones that also catch who’s taking long lunches.', fx: { income: 2, happy: -6 } },
      dolores: { label: 'Buy three more mugs', line: "It's six dollars. I'll let the thief keep mine. I'll know.", fx: { cash: -6, happy: 3 } } },
    { id: 'cup_audit', needs: { flag: 'cup_policy' }, title: 'The cup audit', setup: 'The cup officer has found irregularities. The cup officer has requested a deputy.', ask: 'Does the cup officer get a deputy?',
      preston: { label: 'Fund the deputy', line: 'Two cup officers. A cup division. Cups, finally, under control.', fx: { cash: -8, income: 2, happy: -4 } },
      dolores: { label: 'Repeal the policy', line: 'Give them the cups. Give the cup officer a mug. Never speak of this.', fx: { income: -1, happy: 5 } } },
    { id: 'intern_ideas', needs: { flag: 'paid_intern' }, title: 'The intern has ideas', setup: "She has a plan to cut the clinic's wait time in half. It's good. It's annoyingly good.", ask: 'Whose idea is it?',
      preston: { label: 'Take the credit', line: 'Present it as yours. She will understand. That is what interns are for.', fx: { cash: 10, happy: -4 } },
      dolores: { label: 'Promote her', line: 'Give her a title and a raise. She will run this place in five years. Be on her good side.', fx: { income: -1, happy: 9 } } },
    { id: 'intern_blog', needs: { flag: 'unpaid_intern' }, title: 'The intern wrote a blog post', setup: 'It is titled "What I Learned at TrickleTown." It is extremely well written. It has been shared by a senator.', ask: 'How do you answer the post?',
      preston: { label: 'Lawyer up', line: 'Cease, desist, then license her post as our recruiting brochure. She was unpaid, so it’s ours.', fx: { cash: 8, happy: -4 } },
      dolores: { label: 'Pay her, retroactively', line: 'Back pay, an apology, and a quote for her follow-up post. She will be fair. Fairer than you were.', fx: { cash: -15, happy: 4 } } },
    { id: 'thursday', needs: { flag: 'holiday_off' }, title: 'Thursday is a tradition now', setup: 'There is a parade. There is a float. The float is a papier-mâché version of you, and it is flattering, mostly.', ask: 'How do you treat the parade?',
      preston: { label: 'Charge admission', line: 'Five dollars to see the float. Ten to ride it. Twenty to be on it.', fx: { cash: 10, happy: -4 } },
      dolores: { label: 'Show up with a cake', line: 'Bring a cake. Stand next to the float. Wave. It costs a cake.', fx: { cash: -5, happy: 7 } } },
    { id: 'box_full', needs: { flag: 'box_read' }, title: 'The box is full', setup: 'Dolores has read all of them. Forty-one are about the parking lot. One is a poem. It is also about the parking lot.', ask: 'What do you do with the suggestions?',
      preston: { label: 'Shred and reset', line: 'A full box is a finished box. We thank them for their input, and the shredding company buys the paper.', fx: { cash: 3, happy: -5 } },
      dolores: { label: 'Act on three', line: "Pick three. Do them. Tell them which three. That's the whole trick.", fx: { cash: -15, happy: 10 } } },
    { id: 'box_found', needs: { flag: 'box_ignored' }, title: 'They found out', setup: 'Someone opened the suggestion box. It was empty. Not because nobody wrote anything. Because of the mice.', ask: 'What do you say to them?',
      preston: { label: 'Deny everything', line: 'The box was decorative. The mice are contractors, and the contractors bill the tenants.', fx: { cash: 4, happy: -6 } },
      dolores: { label: 'Open it now, in front of them', line: 'Read what survived. Out loud. It will be bad. It will be better after.', fx: { cash: -5, happy: 3 } } },
    { id: 'bees', needs: { flag: 'wild_lawn' }, title: 'Bees', setup: 'The lawn has bees. A lobbyist has started a hive. He has a smoker and a very calm voice.', ask: 'What happens to the bees?',
      preston: { label: 'Sell the honey', line: 'TrickleTown Honey. Small-batch. Extracted, if you will.', fx: { cash: 12, happy: -1 } },
      dolores: { label: 'Leave the bees', line: "Let him keep the bees. Everyone's calmer. Nobody knows why. It's the bees. Also there is honey now, and people pay for honey.", fx: { income: 1, happy: 6 } } },
    { id: 'number_pride', needs: { flag: 'numbered' }, title: "They've started going by their numbers", setup: '0047 and 0012 are dating. 0003 has a podcast. It is called "Three."', ask: 'Do the numbers stay?',
      preston: { label: 'Lean in, sell merch', line: 'Numbered hoodies. Numbered mugs, if we had mugs. A numbered future.', fx: { cash: 8, happy: -2 } },
      dolores: { label: 'Give the names back', line: 'New badges. First names. 0003 is keeping the podcast name. I negotiated.', fx: { cash: -4, happy: 6 } } },

    // Round three: more small ones, and cards that need friends or a streak.
    { id: 'wifi', needs: { days_played: 3 }, title: 'The wifi password', setup: 'Everyone keeps asking for the wifi password. It is on a sticky note on the router, the sticky note is the only copy, and the router is in a closet nobody can find.', ask: 'How do people get the password?',
      preston: { label: 'Change it weekly, sell the new one', line: 'Fifty cents a week. Connectivity is a privilege. A tiered privilege.', fx: { income: 1, happy: -2 }, sets: 'wifi_paid' },
      dolores: { label: 'Paint it on the wall, free', line: "Paint it on the wall. Big type. You know how I feel about big type.", fx: { happy: 2 }, sets: 'wifi_free' } },
    { id: 'dress_code', needs: { days_played: 7 }, title: 'A dress code', setup: 'HR would like a dress code. HR has drawn a diagram. The diagram has a lot of arrows.', ask: 'Is there a dress code?',
      preston: { label: 'Mandatory blazers, deducted from pay', line: 'Navy. Company crest. Deducted from pay, so technically they own them.', fx: { income: 3, happy: -4 }, sets: 'blazers' },
      dolores: { label: 'Casual Fridays', line: 'Casual Fridays. Then casual Thursdays. I have a roadmap.', fx: { happy: 3 }, sets: 'casual' } },
    // Day two, every time (pin): the cat. Either way she stays, and you name her.
    { id: 'cat', pin: true, needs: { days_played: 2 }, title: 'A cat', setup: 'A cat has moved into the lobby and taken the good chair. Nobody has objected. Nobody would dare.', ask: 'What\'s the cat\'s job?',
      preston: { label: 'Charge for petting', line: 'A dollar a pet. A revenue stream with whiskers. You name it; I invoice it.', fx: { income: 1, happy: -1 }, sets: 'cat_fee' },
      dolores: { label: 'Make the cat the mascot', line: 'A name, a badge and the good chair, permanently. You pick the name.', fx: { cash: -4, happy: 4 }, sets: 'cat_mascot' } },
    { id: 'wifi_leak', needs: { flag: 'wifi_paid' }, title: 'Someone shared the password', setup: "It's on a lamppost. It's on the lampposts in the next town. It's on a billboard, and the billboard was not cheap.", ask: 'What do you do now that everyone has it?',
      preston: { label: 'Cut the wifi', line: 'No wifi, no problem, no bill. They can lobby by mail.', fx: { income: 2, happy: -6 } },
      dolores: { label: 'Make it free, say sorry', line: 'Free wifi and an apology. The apology is the expensive part.', fx: { income: -1, happy: 5 } } },
    { id: 'blazer_revolt', needs: { flag: 'blazers' }, title: 'The blazers are in the dumpster', setup: 'All of them. Folded. There is a note. The note is polite, which is somehow worse.', ask: 'What do you do about the blazers?',
      preston: { label: 'Bill them for the blazers', line: 'Forty dollars a blazer, payable in installments, with interest.', fx: { cash: 10, happy: -6 } },
      dolores: { label: 'Casual, forever', line: 'The dumpster has spoken. It usually does, eventually.', fx: { happy: 6 } } },
    { id: 'cat_agent', needs: { flag: 'cat_mascot' }, title: '{Cat} has an agent', setup: '{Cat} has been offered a commercial. The agent is a lobbyist. Of course he is.', ask: 'Does {cat} take the deal?',
      preston: { label: 'Sell {Cat} merch', line: '{Cat} mugs. {Cat} blazers. {Cat}, the fragrance.', fx: { cash: 15, happy: -2 } },
      dolores: { label: 'Give {him} the window seat', line: '{He} gets the window. The sunny one. That is the whole negotiation.', fx: { happy: 6 } } },
    { id: 'visitor', needs: { friends: 1 }, title: 'A friend stopped by', setup: 'One of your friends came to see the village. They are standing in the lobby, taking notes. Or pictures. Notes and pictures.', ask: 'How do you host them?',
      preston: { label: 'The tour, then the upsell', line: 'Free tour. Gift shop at the end. The gift shop is the tour.', fx: { cash: 5, happy: -1 } },
      dolores: { label: 'Lunch at the Company Store', line: 'Buy them lunch. Let them meet the lobbyists. Let the lobbyists complain. It is good for everyone.', fx: { cash: -6, happy: 4 } } },
    { id: 'rivalry', needs: { friends: 3 }, title: "Your friends' towns are nicer", setup: 'The lobbyists have seen the other villages. One of them has a pool. An actual pool.', ask: 'How do you answer the nicer towns?',
      preston: { label: 'Poach their lobbyists', line: 'Signing bonuses. Non-competes. A fruit basket with a contract in it.', fx: { income: 3, happy: -4 } },
      dolores: { label: 'Host a block party', line: 'Invite the other towns. Feed everyone. Let them see we are fine. We are fine.', fx: { cash: -20, happy: 10 } } },
    { id: 'streak_week', needs: { streak: 7 }, title: 'A week straight', setup: "Seven days in a row. The lobbyists noticed. They've made a banner. The banner is slightly off-center.", ask: 'How do you mark a week?',
      preston: { label: 'Mandatory applause', line: 'Announce it. Applause, two minutes, logged.', fx: { cash: 10, happy: -3 } },
      dolores: { label: 'Afternoon off, for everyone', line: 'You showed up seven days. So did they. Give them the afternoon.', fx: { cash: -5, happy: 9 } } },
    { id: 'streak_month', needs: { streak: 30 }, title: 'A month straight', setup: 'Thirty days. There is talk of naming something after you. The talk is coming from you.', ask: 'What gets named?',
      preston: { label: 'Name a building after you', line: 'The tallest thing in town becomes The You. Rent goes up, because it is The You now.', fx: { income: 3, happy: -5 } },
      dolores: { label: 'Name it after them', line: 'Name it after the lobbyists. All of them. The sign will be long. The sign will be loved.', fx: { happy: 12 } } },
    { id: 'audit', needs: { cash: 200 }, title: 'An audit', setup: 'An auditor has arrived. She is very calm. She has a pencil. She has already found the ball pit.', ask: 'How do you handle the auditor?',
      preston: { label: 'Creative accounting', line: 'The ball pit is a research facility. The casino is a wellness center. I have receipts, in the sense that I have printed them.', fx: { cash: 25, happy: -2 }, sets: 'cooked_books' },
      dolores: { label: 'Pay the fine', line: 'Pay it. Fix the thing. She will be back, and it is better if she likes us.', fx: { cash: -30, happy: 3 } } },
    { id: 'audit_return', needs: { flag: 'cooked_books' }, title: 'The auditor is back', setup: 'She has a second pencil. She has questions about the research facility.', ask: 'What do you tell her this time?',
      preston: { label: 'Lawyer up', line: 'Every lawyer in the county. Several from the next one. They found a loophole, and the loophole pays.', fx: { cash: 15, happy: -5 } },
      dolores: { label: 'Come clean', line: 'Tell her everything. Pay what we owe. Sleep, for once.', fx: { cash: -25, happy: 7 } } },

    { id: 'whale', needs: { upgrade: 'vip' }, title: 'A whale in the VIP room', setup: 'He has been there for three days. He is the only one in the room. He seems to like the rope.', ask: 'What do you do with the whale?',
      preston: { label: 'Comp everything', line: 'Suite, steak, a second rope. He is our quarter.', fx: { cash: 30, happy: -7 } },
      dolores: { label: 'Cut him off', line: 'Walk him home. He lives in the Tenement. Or he did.', fx: { cash: -5, happy: 5 } } },
    { id: 'harvest', needs: { upgrade: 'garden' }, title: 'Harvest day', setup: 'The garden produced. Mostly zucchini. An alarming amount of zucchini.', ask: 'What happens to the zucchini?',
      preston: { label: 'Sell it at the farmers market', line: 'Farmers market. Artisanal. Forty dollars a zucchini, and we do not explain why.', fx: { cash: 10, happy: -3 } },
      dolores: { label: 'Throw a potluck', line: 'Everybody brings a dish. All the dishes are zucchini. It is still a potluck. The leftovers go to the farmers market; the lobbyists keep the till.', fx: { income: 1, happy: 8 } } },

    // Round four: more small daily ones with consequences, more follow-ups,
    // and some cards that only a thriving town ever sees.
    { id: 'lunch_hour', needs: { days_played: 5 }, title: 'The lunch hour', setup: 'Nobody can agree on how long lunch is. HR has a stopwatch. HR has always had a stopwatch.', ask: 'How long is lunch?',
      preston: { label: 'Thirty minutes, timed', line: 'Thirty minutes. The stopwatch is already here. It would be a shame to waste it.', fx: { income: 1, happy: -3 }, sets: 'short_lunch' },
      dolores: { label: 'An hour, outside', line: 'An hour. Outside. Sunlight is free and nobody has found a way to invoice it yet.', fx: { happy: 4 }, sets: 'long_lunch' } },
    { id: 'elevator', needs: { days_played: 8 }, title: 'The elevator', setup: 'The elevator stopped between floors. The lobbyists inside have formed a committee.', ask: 'What happens to the elevator?',
      preston: { label: 'Close it; stairs are cardio', line: 'Close it. Call it a wellness initiative. Put a poster on every landing.', fx: { cash: 5, happy: -4 }, sets: 'stairs' },
      dolores: { label: 'Fix the elevator', line: 'Fix the elevator. The committee has drafted bylaws. It is getting serious in there.', fx: { cash: -18, happy: 3 }, sets: 'elevator_fixed' } },
    { id: 'newsletter', needs: { days_played: 9 }, title: 'A company newsletter', setup: 'Someone wants to start a newsletter. "The Trickle." The name was not negotiable.', ask: 'Who runs the newsletter?',
      preston: { label: 'Fill it with sponsored content', line: 'Every issue brought to you by the Company Store. Every article, also, about the Company Store.', fx: { income: 1, happy: -1 }, sets: 'newsletter_ads' },
      dolores: { label: 'Let them write it', line: 'Their newsletter. Their words. You will not enjoy every issue, which is how you know it is working.', fx: { happy: 3 }, sets: 'newsletter_free' } },
    { id: 'fire_drill', needs: { days_played: 10 }, title: 'Fire drill', setup: 'The annual fire drill is due. The fire marshal has left three voicemails. The third was just sighing.', ask: 'Does the drill happen?',
      preston: { label: 'Sign the form, skip the drill', line: 'Everyone knows where the door is. It is the big one that says "door."', fx: { cash: 4, happy: -1 }, sets: 'no_drill' },
      dolores: { label: 'Run the drill', line: 'Twenty minutes. Everybody outside. {Cat} goes first; {he} has made that clear.', fx: { cash: -3, happy: 2 } } },
    { id: 'holiday_party', needs: { days_played: 12 }, title: 'The holiday party', setup: 'There is a budget line for a party. It is a small line. It has a question mark next to it.', ask: 'What kind of party is it?',
      preston: { label: 'Cash bar, mandatory', line: 'Attendance is required. Drinks are not. That is where the margin lives.', fx: { cash: 8, happy: -4 } },
      dolores: { label: 'Open bar, optional', line: 'Nobody has to come. Everybody will. Budget for that.', fx: { cash: -25, happy: 8 } } },
    { id: 'newsletter_expose', needs: { flag: 'newsletter_free' }, title: 'The newsletter ran an exposé', setup: 'Issue four is about you. It is well sourced. One of the sources is {cat}.', ask: 'How do you answer the exposé?',
      preston: { label: 'Shut it down', line: 'Freedom of the press is a lovely idea for a press we do not own.', fx: { income: 1, happy: -6 } },
      dolores: { label: 'Print a correction, fix the thing', line: 'They were right about the boiler. Fix the boiler. Let them print that too.', fx: { cash: -10, happy: 6 } } },
    { id: 'small_fire', needs: { flag: 'no_drill' }, title: 'A small fire', setup: 'A small fire. In the break room. Everyone went toward it, to look.', ask: 'What happens after the fire?',
      preston: { label: 'Call it a controlled burn', line: 'We were going to replace that microwave anyway. Now we have a reason, a smell, and an insurance claim.', fx: { cash: 6, happy: -8 } },
      dolores: { label: 'Evacuate, then drills forever', line: 'Everybody out. Then the drill. Then the drill every month, until they can do it asleep, because one day they might be.', fx: { cash: -15, happy: 5 } } },
    { id: 'elevator_music', needs: { flag: 'elevator_fixed' }, title: 'The elevator has music now', setup: 'Nobody installed it. It is just there. It is one song.', ask: 'What do you do with the music?',
      preston: { label: 'Sell the ad slot', line: 'Thirty seconds of audio, captive audience, four floors. Advertisers call that a dream.', fx: { income: 1, happy: -1 } },
      dolores: { label: 'Let the lobbyists pick', line: 'A playlist. Everyone gets a song. {Cat} gets two; {he} pushed the button.', fx: { happy: 3 } } },
    { id: 'lunch_truck', needs: { flag: 'long_lunch' }, title: 'A food truck found you', setup: 'A taco truck has started parking outside at noon. The lobbyists are, for once, early for something.', ask: 'What\'s the deal with the truck?',
      preston: { label: 'Charge it rent', line: 'Prime curb. Hungry crowd. Rent, plus a percentage, plus the good tacos for the office.', fx: { income: 2, happy: -2 } },
      dolores: { label: 'Give it the good corner', line: 'The sunny corner. Free. In exchange for nothing, which is what good neighbors charge. Lunch gets faster, and so does the afternoon.', fx: { income: 1, happy: 5 } } },
    { id: 'headhunter', needs: { happiness_below: 35 }, title: 'A headhunter in the lobby', setup: 'A recruiter from the next town is handing out cards. The lobbyists are taking them. Some are taking two.', ask: 'How do you keep them?',
      preston: { label: 'Non-competes, retroactive', line: 'They cannot leave if they cannot work anywhere else. It is elegant, in a way.', fx: { income: 2, happy: -5 } },
      dolores: { label: 'Make counteroffers', line: 'Match the offers. Every one. It is cheaper than finding out what an empty town costs.', fx: { income: -3, happy: 8 } } },
    { id: 'health_inspector', needs: { happiness_below: 40 }, title: 'The health inspector', setup: 'She arrived unannounced. She is wearing gloves. She brought her own gloves.', ask: 'What does she get to see?',
      preston: { label: 'A tour of the nice floor', line: 'Show her the lobby. Show her the lobby again. No findings, no fines, and the fines were already in the budget.', fx: { cash: 5, happy: -4 } },
      dolores: { label: 'Show her everything', line: 'Open every door. Write down what she says. Do what she says. She is the cheapest consultant you will ever meet.', fx: { cash: -20, happy: 11 } } },
    { id: 'profile', needs: { happiness_above: 80 }, title: 'A magazine wants the story', setup: 'A journalist wants to profile TrickleTown. "The company town that works." She seems suspicious of the premise. So are you.', ask: 'Does she get the story?',
      preston: { label: 'Charge for the interview', line: 'Access is a product. Candor is a premium tier.', fx: { cash: 15, happy: -2 } },
      dolores: { label: 'Let the lobbyists talk', line: 'Point her at the lobbyists. Walk away. Whatever they say, you earned.', fx: { happy: 4 }, sets: 'profiled' } },
    { id: 'profile_fallout', needs: { flag: 'profiled' }, title: 'The article is out', setup: 'It is mostly kind. It quotes {cat}. Three other towns have called to ask how you did it.', ask: 'What do you tell the other towns?',
      preston: { label: 'Sell them a consultancy', line: 'TrickleTown Solutions. A deck, a retainer, a lanyard.', fx: { cash: 20, happy: -1 } },
      dolores: { label: 'Tell them for free', line: 'Tell them. Build the clinic. Fix the walls. Listen. It is not a secret, which is why nobody believes it. They will send their new hires here to learn, and new hires buy lunch.', fx: { income: 2, happy: 7 } } },
    { id: 'thriving', needs: { happiness_above: 85 }, title: 'Nobody is sick', setup: 'The clinic is empty. The nurse is reading. Someone has started a running club, voluntarily, which is unsettling.', ask: 'What do you do with an empty clinic?',
      preston: { label: 'Cut the clinic hours', line: 'Nobody is using it. Half the hours, same sign.', fx: { income: 3, happy: -4 } },
      dolores: { label: 'Keep it open', line: 'It is empty because it is open. That is the whole idea. It is working. Leave it.', fx: { happy: 3 } } },
    { id: 'followers', needs: { friends: 5 }, title: 'Your friends are watching', setup: 'Five of your friends can see this village. One of them has been refreshing. You can tell.', ask: 'Do your friends see the numbers?',
      preston: { label: 'Hide the meters', line: 'A village is only as unhappy as the public can prove.', fx: { income: 1, happy: -2 }, sets: 'meters_hidden' },
      dolores: { label: 'Post the numbers in the lobby', line: 'Happiness and profit, on a board, every morning. If you are embarrassed by the numbers, change the numbers.', fx: { happy: 3 }, sets: 'meters_posted' } },
    { id: 'pool_party', needs: { upgrade: 'pool' }, title: 'Pool party', setup: 'The pool is small. The party is not.', ask: 'Who gets in the pool?',
      preston: { label: 'Sell tickets', line: 'A velvet rope, but wet. Admission, towels extra.', fx: { cash: 12, happy: -2 } },
      dolores: { label: 'Open swim', line: 'Everybody in. {Cat} is a lifeguard. {He} did not apply; {he} was simply there.', fx: { happy: 8 } } },
    // Round five: every mark gets a card that comes back for it.
    { id: 'sale_stampede', needs: { flag: 'holiday_sale' }, title: 'The Thursday Sale stampede', setup: 'Fifteen percent off has drawn a crowd. The crowd is the lobbyists. They are shopping on the clock, which is the only time the sale is valid.', ask: 'What happens to the sale?',
      preston: { label: 'Raise prices Wednesday', line: 'Up fifteen Wednesday, down fifteen Thursday. The sale is real. The math is also real.', fx: { income: 2, happy: -4 } },
      dolores: { label: 'Make Thursday a real holiday', line: 'Give them the day. Close the store. A sale nobody can shop at is a sign, not a sale.', fx: { income: -1, happy: 5 }, sets: 'holiday_off' } },
    { id: 'astroturf_melt', needs: { flag: 'astroturf' }, title: 'The astroturf melted', setup: 'August happened. The lawn is now a texture. The smell has been described as "a new car, on fire."', ask: 'What replaces the astroturf?',
      preston: { label: 'Paint it green', line: 'Green paint. Outdoor grade. Billed to the tenants as landscaping. It will look exactly like it did, from the road, at night.', fx: { cash: 3, happy: -2 } },
      dolores: { label: 'Real grass, finally', line: 'Grass. Seed. Water. It will take a season, and nobody will have to explain the smell to the inspector.', fx: { cash: -12, happy: 5 }, sets: 'wild_lawn' } },
    { id: 'name_plaque', needs: { flag: 'named' }, title: 'The badges have fans', setup: 'The big-type first names caught on. Lobbyists from the next town over are asking for badges. There is a waiting list for a badge.', ask: 'Who gets a badge?',
      preston: { label: 'Sell the badges', line: 'Forty dollars a badge. Sixty with a lanyard. The lanyard costs us a dollar.', fx: { cash: 12, happy: -1 } },
      dolores: { label: 'Give one to anyone who asks', line: 'A badge costs nothing and says "we see you." Hand them out. Spell the names right.', fx: { cash: -5, happy: 4 } } },
    { id: 'wifi_traffic', needs: { flag: 'wifi_free' }, title: "Everyone's on the wifi", setup: 'Free wifi worked. The whole town is streaming. The router has a fan now, and the fan has a sound.', ask: 'Does the bandwidth get bigger?',
      preston: { label: 'Throttle it after six', line: 'Full speed during work. A trickle after. A trickle is on brand.', fx: { income: 1, happy: -2 } },
      dolores: { label: 'Buy more bandwidth', line: 'A bigger pipe. It is the cheapest thing anyone has asked for this month.', fx: { cash: -10, happy: 3 } } },
    { id: 'casual_thursday', needs: { flag: 'casual' }, title: 'Casual Thursday', setup: 'Casual Friday has crept into Thursday, as promised. Somebody wore a robe. It was a nice robe.', ask: 'How casual does it get?',
      preston: { label: 'Sell the company hoodie', line: 'Branded. Comfortable. Technically a uniform, legally a souvenir.', fx: { cash: 10, happy: -1 } },
      dolores: { label: 'Casual, all week', line: 'The roadmap ends here. Wear what you want. The robe stays, within reason.', fx: { happy: 4 } } },
    { id: 'cat_strike', needs: { flag: 'cat_fee' }, title: '{Cat} has gone on strike', setup: '{Cat} has stopped accepting pets, paid or otherwise. {He} sits on the register. {He} stares.', ask: 'How do you end the strike?',
      preston: { label: 'Dock {his} treats', line: '{Cat} is on half rations until {he} clocks back in. {He} will remember this.', fx: { income: 1, happy: -5 } },
      dolores: { label: 'Refund the petting fees', line: 'Give the money back. Apologize to {cat}. {He} will not accept it, but the lobbyists will notice you tried.', fx: { cash: -10, income: -1, happy: 5 } } },
    { id: 'lunch_smuggling', needs: { flag: 'short_lunch' }, title: 'Lunch is being smuggled', setup: 'Thirty-minute lunches have produced a black market in sandwiches. There is a guy. Everyone knows the guy.', ask: 'What do you do about the sandwiches?',
      preston: { label: 'Bag checks at the door', line: 'Random bag checks. For sandwiches. HR has volunteered. HR is very excited.', fx: { income: 1, happy: -4 } },
      dolores: { label: 'Give the hour back', line: 'An hour. The guy retires. Everyone eats sitting down, like people.', fx: { income: -1, happy: 5 }, sets: 'long_lunch' } },
    { id: 'stair_fall', needs: { flag: 'stairs' }, title: 'Someone fell on the stairs', setup: 'Cardio claimed a victim. He is fine. He is also, as of this morning, represented.', ask: 'How do you handle the claim?',
      preston: { label: 'Make everyone sign a waiver', line: 'Everyone signs a stair waiver. Retroactively. The lawyer says that is fine and the lawyer is on retainer.', fx: { cash: 2, happy: -6 } },
      dolores: { label: 'Fix the elevator, finally', line: 'Fix it. Pay the man. Put a plaque on the elevator that says "finally."', fx: { cash: -22, happy: 6 }, sets: 'elevator_fixed' } },
    { id: 'newsletter_nobody', needs: { flag: 'newsletter_ads' }, title: 'Nobody reads the newsletter', setup: 'Issue three was entirely about the Company Store. Issue four, also. Readership is one, and it is {cat}, and {he} is using it as a mat.', ask: 'What do you do with a newsletter nobody reads?',
      preston: { label: 'Make reading it mandatory', line: 'A quiz. Weekly. Scores are posted. The newsletter has never been more read, technically.', fx: { income: 1, happy: -3 } },
      dolores: { label: 'Hand it to the lobbyists', line: 'Let them write it. They will write about you. That is what a newsletter is for.', fx: { happy: 3 }, sets: 'newsletter_free' } },
    { id: 'dental_day', needs: { upgrade: 'dental' }, title: 'Free dental day', setup: 'The dental wing is offering a free day. The line is around the block. Everyone is smiling, carefully.', ask: 'What does free dental day include?',
      preston: { label: 'Charge for the fluoride', line: 'The exam is free. The fluoride is an upgrade. The toothbrush is a souvenir, and souvenirs are not free.', fx: { cash: 6, happy: -1 } },
      dolores: { label: 'Floss for everyone', line: 'Floss. Toothbrushes. A pamphlet that is actually read. Teeth, finally, in the budget.', fx: { happy: 6 } } },
    // Drafts: one per newer unlock type, so the mechanism can be tested. Never
    // dealt or shown in the deck (draft: true) unless an admin forces them open.
    { id: 'draft_rip', draft: true, needs: { tier_yesterday: 'Rest in peace' }, title: 'DRAFT', setup: 'DRAFT: a position went to zero yesterday.', ask: 'DRAFT?',
      preston: { label: 'DRAFT Preston', line: 'DRAFT.', fx: { income: 1 } }, dolores: { label: 'DRAFT Dolores', line: 'DRAFT.', fx: { happy: 1 } } },
    { id: 'draft_same_ticker', draft: true, needs: { same_ticker_days: 5 }, title: 'DRAFT', setup: 'DRAFT: five days running on the same stock.', ask: 'DRAFT?',
      preston: { label: 'DRAFT Preston', line: 'DRAFT.', fx: { income: 1 } }, dolores: { label: 'DRAFT Dolores', line: 'DRAFT.', fx: { happy: 1 } } },
    { id: 'draft_charity', draft: true, needs: { charity: true }, title: 'DRAFT', setup: 'DRAFT: {Charity} sent a thank-you note.', ask: 'DRAFT?',
      preston: { label: 'DRAFT Preston', line: 'DRAFT.', fx: { income: 1 } }, dolores: { label: 'DRAFT Dolores', line: 'DRAFT: write back to {Charity}.', fx: { happy: 1 } } },
    { id: 'draft_lobbyfest_week', draft: true, needs: { days_to_lobbyfest_max: 7 }, title: 'DRAFT', setup: 'DRAFT: Lobbyfest is this week.', ask: 'DRAFT?',
      preston: { label: 'DRAFT Preston', line: 'DRAFT.', fx: { income: 1 } }, dolores: { label: 'DRAFT Dolores', line: 'DRAFT.', fx: { happy: 1 } } },
    { id: 'draft_friday', draft: true, needs: { weekday: 5 }, title: 'DRAFT', setup: 'DRAFT: it is Friday.', ask: 'DRAFT?',
      preston: { label: 'DRAFT Preston', line: 'DRAFT.', fx: { income: 1 } }, dolores: { label: 'DRAFT Dolores', line: 'DRAFT.', fx: { happy: 1 } } },
    { id: 'draft_december', draft: true, needs: { month: 12 }, title: 'DRAFT', setup: 'DRAFT: it is December.', ask: 'DRAFT?',
      preston: { label: 'DRAFT Preston', line: 'DRAFT.', fx: { income: 1 } }, dolores: { label: 'DRAFT Dolores', line: 'DRAFT.', fx: { happy: 1 } } },
  ];
  const BY_ID = new Map(ISSUES.map((i) => [i.id, i]));

  // --- The cat ---------------------------------------------------------------
  // Arrives on day two (the 'cat' card); either answer keeps her. You name
  // her, pick he or she and a coat, and then you can spend a truly stupid
  // amount of money on her wardrobe. Outfits do nothing. That's the point.
  const CAT_COATS = ['tabby', 'black', 'gray', 'calico', 'white'];
  // cost in $K. One item per slot is worn at a time.
  const CAT_ITEMS = [
    { id: 'bow_tie', slot: 'neck', name: 'Silk bow tie', cost: 15, blurb: 'Hand-tied by a man who only ties bows.' },
    { id: 'monocle', slot: 'eyes', name: 'Monocle', cost: 25, blurb: 'For reading the fine print. The cat does not read.' },
    { id: 'beret', slot: 'head', name: 'Cashmere beret', cost: 40, blurb: 'Has been to Paris. Did not care for it.' },
    { id: 'blazer', slot: 'body', name: 'Tiny company blazer', cost: 60, blurb: 'Navy, with the crest. Tailored twice: the first tailor was bitten.' },
    { id: 'pearls', slot: 'neck', name: 'Pearl collar', cost: 90, blurb: 'Each pearl was, at one point, inside something else.' },
    { id: 'sunglasses', slot: 'eyes', name: 'Designer sunglasses', cost: 150, blurb: 'The logo is most of the lens.' },
    { id: 'top_hat', slot: 'head', name: 'Silk top hat', cost: 200, blurb: 'Collapsible. Has never once been collapsed.' },
    { id: 'gold_chain', slot: 'neck', name: 'Gold chain', cost: 300, blurb: 'Twenty-four karat. Heavier than advised.' },
    { id: 'tiara', slot: 'head', name: 'Diamond tiara', cost: 500, blurb: 'Formerly a duchess’s. The duchess is fine. Mostly.' },
    { id: 'cape', slot: 'body', name: 'Ermine cape', cost: 750, blurb: 'Velvet lining, ermine trim, and a train two lobbyists carry.' },
    { id: 'crown', slot: 'head', name: 'Solid gold crown', cost: 1000, blurb: 'Real gold, real jewels, a real monarchy’s worth of paperwork.' },
  ];
  const CAT_BY_ID = new Map(CAT_ITEMS.map((x) => [x.id, x]));
  const CAT_DEFAULT_NAME = 'Comptroller';
  const newCat = (day) => ({ name: null, pronoun: 'she', coat: 'tabby', owned: [], wearing: {}, spent: 0, since: day || null });

  // Card text names the cat: {Cat}/{cat} is the name (or "The cat"/"the
  // cat" before there is one), and {He} {he} {him} {his} follow the pronoun.
  function catWords(cat, text, charity = null) {
    if (!text || text.indexOf('{') < 0) return text;
    const name = cat && cat.name;
    const she = !cat || cat.pronoun !== 'he';
    const w = { Cat: name || 'The cat', cat: name || 'the cat', He: she ? 'She' : 'He', he: she ? 'she' : 'he', him: she ? 'her' : 'him', his: she ? 'her' : 'his', Charity: charity || 'your charity' };
    return text.replace(/\{(Cat|cat|He|he|him|his|Charity)\}/g, (_, k) => w[k]);
  }

  // A cat's name: letters, numbers, spaces and . ' - only; 1 to 20 of them.
  function cleanCatName(raw) {
    const name = String(raw == null ? '' : raw).normalize('NFC').replace(/\s+/g, ' ').trim();
    if (!name) return { error: 'Give the cat a name.' };
    if ([...name].length > 20) return { error: 'Twenty characters at most. The badge is small.' };
    if (!/^[\p{L}\p{N}][\p{L}\p{N} .'’-]*$/u.test(name)) return { error: 'Letters, numbers, spaces and . \' - only.' };
    return { name };
  }

  function nameCat(t, { name, pronoun, coat } = {}) {
    migrate(t);
    if (!t.cat) return { error: 'There is no cat yet. She arrives on your second day.' };
    const c = cleanCatName(name);
    if (c.error) return c;
    t.cat.name = c.name;
    if (pronoun === 'he' || pronoun === 'she') t.cat.pronoun = pronoun;
    if (CAT_COATS.includes(coat)) t.cat.coat = coat;
    return { cat: t.cat };
  }

  // Buying wears it straight away (replacing whatever was in that slot).
  function buyCatItem(t, itemId, cashAvailable) {
    migrate(t);
    if (!t.cat) return { error: 'There is no cat yet.' };
    if (!t.cat.name) return { error: 'Name the cat first. It is the least you can do.' };
    const it = CAT_BY_ID.get(itemId);
    if (!it) return { error: 'No such item.' };
    if (t.cat.owned.includes(it.id)) return { error: 'Already in the wardrobe.' };
    if (!canPay(cashAvailable, it.cost)) return { error: `${it.name} costs $${it.cost}K. You have ${kStr(cashAvailable)} on the coin.` };
    t.cat.owned.push(it.id);
    t.cat.wearing[it.slot] = it.id;
    t.cat.spent = Math.round(((t.cat.spent || 0) + it.cost) * 100) / 100;
    return { cash: charge(cashAvailable, it.cost), item: it.id };
  }

  function wearCatItem(t, itemId, on) {
    migrate(t);
    if (!t.cat) return { error: 'There is no cat yet.' };
    const it = CAT_BY_ID.get(itemId);
    if (!it || !t.cat.owned.includes(it.id)) return { error: 'Not in the wardrobe.' };
    if (on) t.cat.wearing[it.slot] = it.id;
    else if (t.cat.wearing[it.slot] === it.id) delete t.cat.wearing[it.slot];
    return { cat: t.cat };
  }
  const ALL_UPGRADES = {};
  for (const slot of Object.keys(PLOTS)) for (const [bk, b] of Object.entries(PLOTS[slot].options)) for (const [uk, u] of Object.entries(b.upgrades)) ALL_UPGRADES[uk] = { ...u, key: uk, slot, building: bk };

  function hash(s) {
    let h = 2166136261;
    for (const ch of String(s)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }

  function fresh() {
    return { v: 5, day: null, happiness: 55, perks: 0, plots: { housing: null, square: null }, upgrades: { housing: [], square: [] }, built: { housing: null, square: null }, issues: [], report: null, played: [], flags: [], last: {}, days: 0, admin_open: [], sides: { preston: 0, dolores: 0 }, choices: {} };
  }
  function migrate(t) {
    if (!t.upgrades) t.upgrades = { housing: [], square: [] };
    if (!t.played) t.played = [];
    if (!t.flags) t.flags = [];
    if (!t.last) t.last = {};
    if (t.days == null) t.days = t.day ? 1 : 0;        // days the village has been visited
    if (!t.admin_open) t.admin_open = [];               // card ids an admin forced open, one by one
    // Admin switches, each reversible: every card open; every open card dealt, daily.
    if (t.admin_open.includes('*')) { t.admin_all_open = true; t.admin_open = t.admin_open.filter((id) => id !== '*'); }
    if (t.admin_all_open == null) t.admin_all_open = false;
    if (t.admin_deal_all == null) t.admin_deal_all = false;
    if (!t.built) t.built = { housing: t.plots.housing ? t.day : null, square: t.plots.square ? t.day : null };
    if ('health' in t) delete t.health;                 // health was cut: two scores now
    // Cards played per side, for the profile. Counting started with profiles;
    // today's already-played cards seed it for older towns.
    if (!t.sides) {
      t.sides = { preston: 0, dolores: 0 };
      for (const i of t.issues || []) if (i.chosen === 'preston' || i.chosen === 'dolores') t.sides[i.chosen] += 1;
    }
    // The cat. Towns that met her before naming existed get her as Comptroller,
    // the name the cards always used.
    if (!t.cat && ((t.played || []).includes('cat') || (t.flags || []).some((f) => f === 'cat_fee' || f === 'cat_mascot'))) {
      t.cat = { ...newCat((t.last || {}).cat || t.day), name: CAT_DEFAULT_NAME };
    }
    if (t.cat) { if (!Array.isArray(t.cat.owned)) t.cat.owned = []; if (!t.cat.wearing || typeof t.cat.wearing !== 'object') t.cat.wearing = {}; }
    // Which side you took on each card, last time you played it, for the deck.
    if (!t.choices) {
      t.choices = {};
      for (const i of t.issues || []) if (i.chosen) t.choices[i.id] = { side: i.chosen, day: t.day };
    }
    return t;
  }
  const dayDiff = (a, b) => (a && b ? Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000) : 0);
  // Marks that wear off: how many days each lasts, counted from the day it
  // was set (kept in t.last under the mark's own name). Hiding the meters
  // and posting them cancel each other.
  const TIMED_FLAGS = { meters_hidden: 7, meters_posted: 7 };
  const FLAG_CANCELS = { meters_hidden: 'meters_posted', meters_posted: 'meters_hidden' };
  // Whether other players see this town's happiness and profit. Checks the
  // date too, so the meters come back on time even if the owner hasn't
  // logged in to tick the town over.
  const metersHidden = (t, day) => !!(t && Array.isArray(t.flags) && t.flags.includes('meters_hidden') && t.last && t.last.meters_hidden
    && (!day || dayDiff(t.last.meters_hidden, day) < TIMED_FLAGS.meters_hidden));
  // Which card leaves which mark, for the deck's "it depends on how you handled…" text.
  const FLAG_SOURCE = {};
  for (const i of ISSUES) for (const k of ['preston', 'dolores']) if (i[k].sets) FLAG_SOURCE[i[k].sets] = i.title;
  // Marks that some later card actually asks about.
  const FOLLOWED = new Set(ISSUES.filter((i) => i.needs && i.needs.flag).map((i) => i.needs.flag));
  // How the card that follows a choice tends to go, so a pitch can warn (or
  // tease) without saying what happens: good, bad, or anyone's guess.
  const LATER = {
    mural: 'good', paid_intern: 'good', named: 'good', cat_mascot: 'good', long_lunch: 'good', elevator_fixed: 'good', profiled: 'good', holiday_off: 'good',
    posters: 'bad', cup_policy: 'bad', unpaid_intern: 'bad', holiday_sale: 'bad', box_ignored: 'bad', astroturf: 'bad', numbered: 'bad', wifi_paid: 'bad',
    blazers: 'bad', cat_fee: 'bad', cooked_books: 'bad', short_lunch: 'bad', stairs: 'bad', newsletter_ads: 'bad', no_drill: 'bad',
    mugs: 'mixed', box_read: 'mixed', wild_lawn: 'mixed', wifi_free: 'mixed', casual: 'mixed', newsletter_free: 'mixed',
  };
  const laterOf = (side) => (side.sets && FOLLOWED.has(side.sets) ? (LATER[side.sets] || 'mixed') : null);

  function building(slot, key) { return key ? PLOTS[slot].options[key] : null; }
  function ownedUpgrades(t, slot) {
    const b = building(slot, t.plots[slot]);
    return b ? ((t.upgrades && t.upgrades[slot]) || []).map((k) => b.upgrades[k]).filter(Boolean) : [];
  }

  // Per-day effect of one plot, building plus its upgrades.
  function plotEffects(t, slot) {
    const b = building(slot, t.plots[slot]);
    if (!b) return { income: 0, happy: 0 };
    const e = { income: b.income || 0, happy: b.happy || 0 };
    for (const u of ownedUpgrades(t, slot)) { e.income += u.income || 0; e.happy += u.happy || 0; }
    return e;
  }
  function effects(t) {
    const e = { income: 0, happy: 0 };
    for (const slot of Object.keys(PLOTS)) { const p = plotEffects(t, slot); e.income += p.income; e.happy += p.happy; }
    return e;
  }

  function income(t) { return round2(effects(t).income + (t.perks || 0)); }
  // Happiness is the lobbyist price: $1.4K a head at 0, $1K around 55, $500
  // at 100. Every point counts, and the top of the scale counts most: a
  // properly happy town hires nearly three times what a miserable one does
  // with the same tax. That's the payoff for spending profit on decency.
  function hireCost(t) { return round2(clamp(1.4 - 0.9 * Math.pow(clamp(t.happiness, 0, 100) / 100, 1.5), 0.5, 1.4)); }
  const hasUpgrade = (t, key) => Object.values(t.upgrades || {}).some((list) => list.includes(key));

  // --- Cards and what unlocks them ---------------------------------------------

  const adminOpen = (t, id) => !!t.admin_all_open || (!!t.admin_open && (t.admin_open.includes('*') || t.admin_open.includes(id)));

  function needsMet(needs, t, ctx, slot = null) {
    if (!needs) return true;
    if (needs.days_played != null && !((t.days || 0) >= needs.days_played)) return false;
    if (needs.days != null && !(slot && t.built && t.built[slot] && dayDiff(t.built[slot], ctx.day) >= needs.days)) return false;
    if (needs.cash != null && !((ctx.cash || 0) >= needs.cash)) return false;
    if (needs.lobbyists != null && !((ctx.lobbyists || 0) >= needs.lobbyists)) return false;
    if (needs.building && !Object.values(t.plots).includes(needs.building)) return false;
    if (needs.upgrade && !hasUpgrade(t, needs.upgrade)) return false;
    if (needs.flag && !(t.flags || []).includes(needs.flag)) return false;
    if (needs.friends != null && !((ctx.friends || 0) >= needs.friends)) return false;
    if (needs.streak != null && !((ctx.streak || 0) >= needs.streak)) return false;
    if (needs.happiness_below != null && !(t.happiness < needs.happiness_below)) return false;
    if (needs.happiness_above != null && !(t.happiness > needs.happiness_above)) return false;
    if (needs.not_upgrade && hasUpgrade(t, needs.not_upgrade)) return false;
    // The newer ones read the day and the player's record, which the server passes in ctx.
    if (needs.tier_yesterday && !(Array.isArray(ctx.tiers_yesterday) && ctx.tiers_yesterday.includes(needs.tier_yesterday))) return false;
    if (needs.same_ticker_days != null && !((ctx.same_ticker_days || 0) >= needs.same_ticker_days)) return false;
    if (needs.charity && !(ctx.charity_name || ctx.has_charity)) return false;
    if (needs.days_to_lobbyfest_max != null && !(ctx.days_to_lobbyfest != null && ctx.days_to_lobbyfest <= needs.days_to_lobbyfest_max)) return false;
    if (needs.weekday != null && ctx.weekday !== needs.weekday) return false;
    if (needs.month != null && ctx.month !== needs.month) return false;
    return true;
  }

  // t and ctx are optional: with them the text says where you stand
  // ("play 5 days; you've played 2").
  function needsText(needs, t = null, ctx = null) {
    if (!needs) {
      const n = ISSUES.filter((i) => !i.needs).length;
      const seen = t ? ISSUES.filter((i) => !i.needs && t.played.includes(i.id)).length : null;
      return `Daily headline: everyone gets one of these ${n} each day${seen != null ? ` (you've played ${seen} of ${n})` : ''}.`;
    }
    const parts = [];
    const have = (v) => (v == null ? '' : ` (you: ${v})`);
    if (needs.days_played != null) parts.push(`play ${needs.days_played} day${needs.days_played === 1 ? '' : 's'}${t ? have(t.days || 0) : ''}`);
    if (needs.days != null) parts.push(`${needs.days} day${needs.days === 1 ? '' : 's'} after building`);
    if (needs.cash != null) parts.push(`have $${needs.cash}K on the coin at dawn${ctx && ctx.cash != null ? have(`$${Math.round(ctx.cash)}K`) : ''}`);
    if (needs.lobbyists != null) parts.push(`hire ${needs.lobbyists} lobbyists, career${ctx && ctx.lobbyists != null ? have(Math.round(ctx.lobbyists * 10) / 10) : ''}`);
    if (needs.friends != null) parts.push(`have ${needs.friends} friend${needs.friends === 1 ? '' : 's'}${ctx && ctx.friends != null ? have(ctx.friends) : ''}`);
    if (needs.streak != null) parts.push(`a ${needs.streak}-day streak${ctx && ctx.streak != null ? have(`${ctx.streak} day${ctx.streak === 1 ? '' : 's'}`) : ''}`);
    if (needs.building) { for (const slot of Object.keys(PLOTS)) { const b = PLOTS[slot].options[needs.building]; if (b) parts.push(`build ${b.name}`); } }
    if (needs.upgrade) { const u = ALL_UPGRADES[needs.upgrade]; if (u) parts.push(`buy the ${u.name.replace(/^([A-Z])(?=[a-z])/, (c) => c.toLowerCase()).replace(/^the /, '')}`); }
    if (needs.flag) return `Follows one of the two choices on “${FLAG_SOURCE[needs.flag] || 'an earlier card'}.” Play that card and see.`;
    if (needs.happiness_below != null) parts.push(`happiness drops under ${needs.happiness_below}`);
    if (needs.happiness_above != null) parts.push(`happiness is over ${needs.happiness_above}`);
    if (needs.same_ticker_days != null) parts.push(`buy the same stock ${needs.same_ticker_days} days running${ctx && ctx.same_ticker_days != null ? have(ctx.same_ticker_days) : ''}`);
    if (needs.charity) parts.push('choose a charity');
    // When it happens, rather than what unlocks it.
    const when = [];
    if (needs.tier_yesterday) when.push(needs.tier_yesterday === 'Rest in peace' ? 'the day after a position goes to zero' : `the day after a “${needs.tier_yesterday}” trade`);
    if (needs.days_to_lobbyfest_max != null) when.push(needs.days_to_lobbyfest_max === 7 ? 'in the last week before Lobbyfest' : `in the last ${needs.days_to_lobbyfest_max} days before Lobbyfest`);
    if (needs.weekday != null) when.push(`on ${WEEKDAYS[needs.weekday]}s`);
    if (needs.month != null) when.push(`in ${MONTHS[needs.month - 1]}`);
    const gone = needs.not_upgrade && ALL_UPGRADES[needs.not_upgrade] ? ` Not once you've bought ${ALL_UPGRADES[needs.not_upgrade].name.replace(/^([A-Z])(?=[a-z])/, (c) => c.toLowerCase())}.` : '';
    if (when.length) return `${parts.length ? `Unlock: ${parts.join(' and ')}. ` : ''}Happens ${when.join(' and ')}.${gone}`;
    const emergent = ['happiness_below', 'happiness_above'].some((k) => needs[k] != null);
    return (emergent ? 'Happens when ' : 'Unlock: ') + parts.join(' and ') + '.' + gone;
  }
  const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

  const RECUR_DAYS = 7;
  // Money shows to one decimal of $1K, so $29.97K reads as "$30K". Anything
  // within a display step of the price counts as enough, and the purchase
  // takes what's there: nobody is told they're $30 short of a $30K casino.
  const GRACE = 0.1;
  const canPay = (have, cost) => Number(have) + GRACE >= cost;
  const charge = (have, cost) => -round2(Math.min(cost, Math.max(0, Number(have) || 0)));
  // $25K, $12.5K, $1.2M: the same shape the front end uses, for error messages.
  const kStr = (n) => { const a = Math.abs(Number(n) || 0), r = (v) => String(Math.round(v * 10) / 10); return `${n < 0 ? '-' : ''}$${a >= 1000 ? `${r(a / 1000)}M` : `${r(a)}K`}`; };

  // The daily deal. One headline everyone gets (keyed to the date, swapped
  // for one you haven't seen if you've played it), then town cards: at least
  // 2, or half of what your town has unlocked and you haven't played yet,
  // whichever is more (never more than MAX_TOWN_CARDS). Unplayed first;
  // emergent ones (a strike, the flu) can come back a week later; a
  // follow-up you've answered never knocks twice.
  const MAX_TOWN_CARDS = 6;
  const EMERGENT = ['happiness_below', 'happiness_above', 'tier_yesterday', 'days_to_lobbyfest_max', 'weekday', 'month'];
  // Drafts are never dealt unless an admin forces them open.
  const unlockedCards = (t, ctx) => ISSUES.filter((i) => i.needs && (adminOpen(t, i.id) || (!i.draft && needsMet(i.needs, t, ctx))));
  function pickIssues(t, ctx) {
    const played = new Set(t.played || []);
    const general = ISSUES.filter((i) => !i.needs);
    let first = general[hash(ctx.day) % general.length];
    const freshGeneral = general.filter((i) => !played.has(i.id));
    if (played.has(first.id) && freshGeneral.length) first = freshGeneral[hash(`${ctx.day}:${ctx.uid}:f`) % freshGeneral.length];
    const unlocked = unlockedCards(t, ctx);
    const recurring = (i) => EMERGENT.some((k) => i.needs[k] != null);
    const order = (list, salt) => [...list].sort((a, b) => hash(`${ctx.day}:${ctx.uid}:${salt}:${a.id}`) - hash(`${ctx.day}:${ctx.uid}:${salt}:${b.id}`));
    // A pinned card (the cat) always makes the day's hand once it's unlocked.
    const pool = order(unlocked.filter((i) => !played.has(i.id)), 'p').sort((a, b) => (b.pin ? 1 : 0) - (a.pin ? 1 : 0));
    const again = order(unlocked.filter((i) => played.has(i.id) && recurring(i) && (!(t.last || {})[i.id] || dayDiff(t.last[i.id], ctx.day) >= RECUR_DAYS)), 'a');
    const want = Math.min(MAX_TOWN_CARDS, Math.max(2, Math.ceil(pool.length / 2)));
    const town = [...pool, ...again].slice(0, want);
    if (!town.length) {
      const rest = (freshGeneral.length > 1 ? freshGeneral : general).filter((i) => i !== first);
      town.push(rest[hash(`${ctx.day}:${ctx.uid}:g`) % rest.length]);
    }
    return [first, ...town].map((i) => ({ id: i.id, chosen: null }));
  }

  // Cards a player unlocks during the day by doing something (a building, an
  // upgrade, a hire, a friend) join today's agenda right away instead of
  // waiting for tomorrow. Cards that unlock with days played, cash at dawn, a
  // streak, a follow-up, or a town in trouble keep arriving with the daily
  // deal. t.unlock_seen is what was unlocked at the last look, so only a
  // change since then counts. Returns the ids dealt.
  const midday = (needs) => needs.days_played == null && needs.cash == null && needs.streak == null && needs.flag == null && !EMERGENT.some((k) => needs[k] != null);
  function dealNewUnlocks(t, ctx) {
    migrate(t);
    if (!ctx.unlocked || t.day !== ctx.day) return [];
    const now = unlockedCards(t, ctx).map((i) => i.id);
    if (!Array.isArray(t.unlock_seen)) { t.unlock_seen = now; return []; }
    const seen = new Set(t.unlock_seen), played = new Set(t.played || []);
    if (!t.issues) t.issues = [];
    const today = new Set(t.issues.map((i) => i.id));
    const fresh = now.filter((id) => !seen.has(id) && !played.has(id) && !today.has(id) && midday(BY_ID.get(id).needs));
    for (const id of fresh) t.issues.push({ id, chosen: null });
    if (t.admin_deal_all) fresh.push(...dealAllUnlocked(t, ctx));
    t.unlock_seen = now;
    return fresh;
  }

  // Admin: every unlocked card not already on today's agenda, on it now.
  function dealAllUnlocked(t, ctx) {
    migrate(t);
    if (!t.issues) t.issues = [];
    const today = new Set(t.issues.map((i) => i.id));
    const ids = unlockedCards(t, ctx).map((i) => i.id).filter((id) => !today.has(id));
    for (const id of ids) t.issues.push({ id, chosen: null });
    return ids;
  }

  // Start a new day. Returns { ticked, report }. The caller applies
  // report.income to the allowance.
  // While the town is locked nobody brings cards, so nothing can be ignored.
  function tick(t, ctx) {
    migrate(t);
    const { day, unlocked = true } = ctx;
    if (t.day === day) return { ticked: false, report: t.report };
    for (const [f, days] of Object.entries(TIMED_FLAGS)) {
      if (t.flags.includes(f) && (!t.last[f] || dayDiff(t.last[f], day) >= days)) { t.flags = t.flags.filter((x) => x !== f); delete t.last[f]; }
    }
    const firstDay = t.day === null;
    const before = { happiness: t.happiness };
    // Unplayed cards cost morale, but only ones that had a free side (a card
    // you couldn't afford either way isn't being ignored), only once there's a
    // village to notice, and never more than 2 a night.
    const freeSide = (id) => { const c = BY_ID.get(id); return !!c && ((c.preston.fx.cash || 0) >= 0 || (c.dolores.fx.cash || 0) >= 0); };
    const built = !!(t.plots.housing || t.plots.square);
    const ignored = unlocked && built ? (t.issues || []).filter((i) => !i.chosen && freeSide(i.id)).length : 0;
    // Every card left unplayed yesterday, for the morning digest.
    const expired = firstDay ? 0 : (t.issues || []).filter((i) => !i.chosen).length;
    if (!firstDay) {
      // Buildings push every day; left alone, happiness drifts back toward 55
      // (10% of the way, at least a point), so a town settles at whatever its
      // buildings make "normal" instead of pinning at 0 or 100.
      const e = effects(t);
      const drift = (gap) => (Math.abs(gap) < 1 ? 0 : Math.sign(gap) * Math.max(1, Math.abs(gap) * 0.1));
      let dh = e.happy + drift(55 - t.happiness);
      dh -= Math.min(2, ignored * 2); // being ignored is bad for morale
      t.happiness = clamp(Math.round(t.happiness + dh), 0, 100);
    }
    t.days = (t.days || 0) + 1; // count today before dealing, so a "play 2 days" card can land on day two
    t.issues = unlocked ? pickIssues(t, ctx) : [];
    t.unlock_seen = unlockedCards(t, ctx).map((i) => i.id); // the baseline for same-day unlocks
    t.report = {
      first_day: firstDay,
      income: income(t),
      happy_delta: t.happiness - before.happiness,
      ignored,
      expired,
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
    if (t.admin_deal_all) dealAllUnlocked(t, ctx);
    t.unlock_seen = unlockedCards(t, ctx).map((i) => i.id);
    return true;
  }

  // What a card's side costs here: the Company Store takes a cut off anything
  // that costs money, which is the one nice thing about it.
  function cardCost(t, fx) {
    const c = fx.cash || 0;
    if (c >= 0) return c;
    const store = building('square', t.plots.square);
    return store && store.card_discount ? -Math.round(-c * (1 - store.card_discount)) : c;
  }

  function applyFx(t, fx) {
    t.happiness = clamp(t.happiness + (fx.happy || 0), 0, 100);
    t.perks = clamp(round2((t.perks || 0) + (fx.income || 0)), -20, 30);
  }

  // Admin (testing): force a card open, or every card ('*'); deal one onto
  // today's agenda right now, locked or not.
  function adminUnlock(t, ids) {
    migrate(t);
    if (ids === '*') { t.admin_all_open = true; return { unlocked: 1 }; }
    const list = [].concat(ids).filter((id) => BY_ID.has(id));
    for (const id of list) if (!t.admin_open.includes(id)) t.admin_open.push(id);
    return { unlocked: list.length };
  }

  // Admin (testing): the two switches, on or off. Turning them off undoes
  // them as far as it can without rewriting history:
  //   unlockAll off  the deck goes back to what this town has earned. Cards
  //                  you've already played stay open (and played); today's
  //                  unplayed cards that are locked again leave the agenda.
  //   dealAll off    today's hand goes back to a normal day's deal. Cards
  //                  you've played today stay; the rest is what the day
  //                  would have dealt.
  function adminSwitch(t, ctx, { unlockAll, dealAll } = {}) {
    migrate(t);
    if (!t.issues) t.issues = [];
    const today = ctx.day;
    if (unlockAll != null && !!unlockAll !== t.admin_all_open) {
      t.admin_all_open = !!unlockAll;
      if (!unlockAll) {
        const played = new Set(t.played || []);
        for (const i of ISSUES) if (played.has(i.id) && !needsMet(i.needs, t, ctx) && !t.admin_open.includes(i.id)) t.admin_open.push(i.id);
        const open = new Set(unlockedCards(t, ctx).map((i) => i.id));
        t.issues = t.issues.filter((s) => s.chosen || open.has(s.id));
      }
      if (unlockAll && t.admin_deal_all && t.day === today) dealAllUnlocked(t, ctx);
      t.unlock_seen = unlockedCards(t, ctx).map((i) => i.id);
    }
    if (dealAll != null && !!dealAll !== t.admin_deal_all) {
      t.admin_deal_all = !!dealAll;
      if (t.day === today) {
        if (dealAll) dealAllUnlocked(t, ctx);
        else {
          const before = (t.played || []).filter((id) => (t.last || {})[id] !== today);
          const natural = pickIssues({ ...t, played: before }, ctx);
          const kept = t.issues.filter((s) => s.chosen);
          const have = new Set(kept.map((s) => s.id));
          t.issues = [...kept, ...natural.filter((s) => !have.has(s.id))];
        }
      }
    }
    return { unlock_all: t.admin_all_open, deal_all: t.admin_deal_all };
  }
  function deal(t, issueId) {
    migrate(t);
    if (!BY_ID.has(issueId)) return { error: 'No such card.' };
    if (!t.issues) t.issues = [];
    if (t.issues.some((i) => i.id === issueId)) return { error: "It's already on today's agenda." };
    if (!t.admin_open.includes(issueId) && !t.admin_open.includes('*')) t.admin_open.push(issueId);
    t.issues.push({ id: issueId, chosen: null });
    return { dealt: issueId };
  }

  // Returns { error } or { cash, fx, side }.
  function decide(t, issueId, side, cashAvailable) {
    migrate(t);
    const slot = (t.issues || []).find((i) => i.id === issueId);
    if (!slot) return { error: "That card isn't on today's agenda." };
    if (slot.chosen) return { error: 'Already decided.' };
    if (side !== 'preston' && side !== 'dolores') return { error: 'Pick Preston or Dolores.' };
    const card = BY_ID.get(issueId)[side];
    let fx = card.fx, paid;
    if (card.buys) {
      // This side buys a building's upgrade: the upgrade's price, owned exactly
      // as the Site Office would, and its own daily effects from then on.
      const u = ALL_UPGRADES[card.buys];
      if (!u || t.plots[u.slot] !== u.building) return { error: 'Build it first. There is nothing to put it on.' };
      if (hasUpgrade(t, card.buys)) return { error: `You already have ${u.name.replace(/^([A-Z])(?=[a-z])/, (c) => c.toLowerCase())}.` };
      if (!canPay(cashAvailable, u.cost)) return { error: `That costs $${u.cost}K and you have ${kStr(cashAvailable)} on the coin.` };
      paid = charge(cashAvailable, u.cost);
      t.upgrades[u.slot].push(card.buys);
      fx = { cash: -u.cost, income: u.income || 0, happy: u.happy || 0 };
    } else {
      const cash = cardCost(t, fx);
      if (cash < 0 && !canPay(cashAvailable, -cash)) return { error: `That costs $${-cash}K and you have ${kStr(cashAvailable)} on the coin.` };
      paid = cash < 0 ? charge(cashAvailable, -cash) : cash;
      applyFx(t, fx);
    }
    slot.chosen = side;
    t.sides[side] = (t.sides[side] || 0) + 1;
    t.choices[issueId] = { side, day: t.day };
    if (issueId === 'cat' && !t.cat) t.cat = newCat(t.day);
    if (!t.played.includes(issueId)) t.played.push(issueId);
    t.last[issueId] = t.day;
    const sets = BY_ID.get(issueId)[side].sets || null;
    if (sets && FLAG_CANCELS[sets]) { t.flags = t.flags.filter((x) => x !== FLAG_CANCELS[sets]); delete t.last[FLAG_CANCELS[sets]]; }
    if (sets && !t.flags.includes(sets)) t.flags.push(sets);
    if (sets && TIMED_FLAGS[sets]) t.last[sets] = t.day;
    return { cash: paid, fx: { ...fx }, side, noted: !!sets && FOLLOWED.has(sets) };
  }

  function build(t, slot, key, cashAvailable, day = t.day) {
    migrate(t);
    if (!PLOTS[slot]) return { error: 'No such plot.' };
    if (!PLOTS[slot].options[key]) return { error: 'No such building.' };
    if (t.plots[slot] === key) return { error: "It's already there." };
    const cost = PLOTS[slot].options[key].cost || BUILD_COST;
    if (!canPay(cashAvailable, cost)) return { error: `${PLOTS[slot].options[key].name} costs $${cost}K. You have ${kStr(cashAvailable)} on the coin.` };
    t.plots[slot] = key;
    t.upgrades[slot] = []; // the old building's upgrades go with it
    t.built[slot] = day;
    return { cash: charge(cashAvailable, cost) };
  }

  function upgrade(t, slot, key, cashAvailable, ctx = {}) {
    migrate(t);
    const b = PLOTS[slot] && building(slot, t.plots[slot]);
    if (!b) return { error: 'Build something there first.' };
    const u = b.upgrades[key];
    if (!u) return { error: `${b.name} doesn't offer that.` };
    if (t.upgrades[slot].includes(key)) return { error: 'Already built.' };
    if (!needsMet(u.needs, t, { ...ctx, cash: cashAvailable }, slot)) return { error: `${u.name} isn't on the table yet. ${needsText(u.needs)}` };
    if (!canPay(cashAvailable, u.cost)) return { error: `${u.name} costs $${u.cost}K. You have ${kStr(cashAvailable)} on the coin.` };
    t.upgrades[slot].push(key);
    return { cash: charge(cashAvailable, u.cost) };
  }

  // Direction-and-size hints instead of exact numbers.
  function clues(fx) {
    const out = [];
    const n = (v, a, b) => (Math.abs(v) <= a ? 1 : Math.abs(v) <= b ? 2 : 3);
    if (fx.income) out.push({ k: 'allowance', dir: Math.sign(fx.income), n: n(fx.income, 3, 6) });
    if (fx.cash) out.push({ k: 'cash', dir: Math.sign(fx.cash), n: n(fx.cash, 10, 20) });
    if (fx.happy) out.push({ k: 'happiness', dir: Math.sign(fx.happy), n: n(fx.happy, 5, 10) });
    return out;
  }
  // Per-day pushes scaled so the arrows read like a week.
  const dailyClues = (e) => clues({ income: e.income, happy: (e.happy || 0) * 3 });
  // Buildings aren't a mystery: their exact daily push is shown.
  const fxOf = (o) => ({ income: o.income || 0, happy: o.happy || 0 });

  // "Unlocked: you've hired 5 lobbyists." for a proposal that's on the table.
  function unlockedText(needs) {
    if (!needs) return 'Always available.';
    const parts = [];
    if (needs.days != null) parts.push(`the building is ${needs.days} day${needs.days === 1 ? '' : 's'} old`);
    if (needs.cash != null) parts.push(`you had $${needs.cash}K on the coin at dawn`);
    if (needs.lobbyists != null) parts.push(`you've hired ${needs.lobbyists} lobbyists`);
    if (needs.friends != null) parts.push(`you have ${needs.friends} friend${needs.friends === 1 ? '' : 's'}`);
    if (needs.streak != null) parts.push(`your streak hit ${needs.streak} days`);
    if (needs.happiness_below != null) parts.push(`happiness is under ${needs.happiness_below}`);
    if (needs.happiness_above != null) parts.push(`happiness is over ${needs.happiness_above}`);
    return parts.length ? `Unlocked because ${parts.join(' and ')}.` : 'Unlocked.';
  }

  function motto(t) {
    const tiers = Object.keys(PLOTS).map((s) => building(s, t.plots[s])).filter(Boolean).map((b) => b.tier);
    if (!tiers.length) return 'Coming soon. Everything is coming soon.';
    const bad = tiers.filter((x) => x === 'bad').length, good = tiers.filter((x) => x === 'good').length;
    if (t.happiness < 15) return 'A great place to have lived.';
    if (bad && !good) return t.happiness < 35 ? 'Where dreams come to be invoiced.' : 'Profitable. Ask us about the other thing.';
    if (good && !bad) return t.happiness > 70 ? 'Surprisingly livable. Suspiciously, even.' : 'Doing our best, which is unusual.';
    return 'Fine. Honestly. Fine.';
  }

  // What the client needs to draw the village and the panel.
  function view(t, ctx = {}) {
    migrate(t);
    const say = (text) => catWords(t.cat, text, ctx.charity_name || null);
    // A side that buys an upgrade shows the upgrade's price and effects.
    const sideFx = (side) => { const u = side.buys && ALL_UPGRADES[side.buys]; return u ? { cash: -u.cost, income: u.income || 0, happy: u.happy || 0 } : side.fx; };
    const sideView = (i, k) => ({ label: say(i[k].label), line: say(i[k].line), clues: clues(sideFx(i[k])), cost: i[k].buys ? Math.max(0, -sideFx(i[k]).cash) : Math.max(0, -cardCost(t, i[k].fx)), later: laterOf(i[k]), buys: i[k].buys || null });
    return {
      day: t.day,
      happiness: t.happiness,
      income: income(t),
      hire_cost: hireCost(t),
      build_cost: BUILD_COST,
      unlock_at: UNLOCK_AT,
      motto: motto(t),
      report: t.report,
      expired_yesterday: (t.report && t.report.expired) || 0,
      cat: t.cat ? { name: t.cat.name, pronoun: t.cat.pronoun, coat: t.cat.coat, owned: [...t.cat.owned], wearing: { ...t.cat.wearing }, spent: t.cat.spent || 0, since: t.cat.since } : null,
      plots: Object.entries(PLOTS).map(([slot, p]) => {
        const b = building(slot, t.plots[slot]);
        return {
          slot,
          label: p.label,
          key: t.plots[slot],
          built: t.built[slot] || null,
          days: t.built[slot] && ctx.day ? dayDiff(t.built[slot], ctx.day) : 0,
          proposals: b ? Object.entries(b.upgrades).filter(([uk, u]) => !t.upgrades[slot].includes(uk) && needsMet(u.needs, t, ctx, slot)).length : 0,
          building: b ? {
            key: t.plots[slot], name: b.name, tier: b.tier, sign: b.sign, cost: b.cost || BUILD_COST,
            perk: b.card_discount ? `Cards cost ${Math.round(b.card_discount * 100)}% less` : null,
            effects: fxOf(b),
            total: plotEffects(t, slot),
            clues: dailyClues(plotEffects(t, slot)),
            upgrades: Object.entries(b.upgrades).map(([uk, u]) => {
              const owned = t.upgrades[slot].includes(uk);
              return {
                key: uk, name: u.name, tier: u.tier, cost: u.cost, pitch: u.pitch, objection: u.objection,
                owned,
                status: owned ? 'owned' : needsMet(u.needs, t, ctx, slot) ? 'available' : 'locked',
                needs: needsText(u.needs, t, ctx),
                unlocked_by: needsMet(u.needs, t, ctx, slot) ? unlockedText(u.needs) : null,
                effects: fxOf(u),
                clues: dailyClues(u),
              };
            }),
          } : null,
          options: Object.entries(p.options).map(([key, o]) => ({ key, name: o.name, tier: o.tier, cost: o.cost || BUILD_COST, pitch: o.pitch, effects: fxOf(o), perk: o.card_discount ? `Cards cost ${Math.round(o.card_discount * 100)}% less` : null, clues: dailyClues(o) })),
        };
      }),
      issues: (t.issues || []).map((s) => {
        const i = BY_ID.get(s.id);
        if (!i) return null;
        return { id: i.id, title: say(i.title), setup: say(i.setup), ask: say(i.ask || ''), general: !i.needs, chosen: s.chosen, consequence: !!(i.preston.sets || i.dolores.sets), followup: !!(i.needs && i.needs.flag), preston: sideView(i, 'preston'), dolores: sideView(i, 'dolores') };
      }).filter(Boolean),
      // The whole collection, for the deck view.
      deck: ISSUES.filter((i) => !i.draft || adminOpen(t, i.id)).map((i) => {
        const slot = (t.issues || []).find((s) => s.id === i.id);
        const status = slot ? (slot.chosen ? 'played' : 'today') : (needsMet(i.needs, t, ctx) || adminOpen(t, i.id)) ? 'available' : 'locked';
        const seen = t.played.includes(i.id);
        return { id: i.id, title: say(i.title), general: !i.needs, status, needs: needsText(i.needs, t, ctx), seen, consequence: !!(i.preston.sets || i.dolores.sets), followup: !!(i.needs && i.needs.flag), forced: adminOpen(t, i.id),
          // What you chose last time, for the deck's look-back. (Older towns
          // know that a card was played, and when, but not which side.)
          choice: seen || status === 'played' ? (t.choices[i.id] || null) : null, last: seen ? (t.last[i.id] || null) : null };
      }),
    };
  }

  return { fresh, migrate, tick, ensureIssues, dealNewUnlocks, dealAllUnlocked, MAX_TOWN_CARDS, decide, build, upgrade, view, hireCost, income, isUnlocked, needsMet, adminUnlock, deal, canPay, GRACE, LATER, UNLOCK_AT, PLOTS, ISSUES, BUILD_COST, clues, laterOf, adminSwitch, metersHidden, TIMED_FLAGS, CAT_ITEMS, CAT_COATS, catWords, cleanCatName, nameCat, buyCatItem, wearCatItem };
}));
