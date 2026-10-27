// Charities players can direct their tax to.
//
// THESE ARE MADE UP. The demo runs with fictional charities on purpose so no
// one mistakes play-money tax for a real donation. Before any real payout,
// replace this list with real organizations you've vetted (and set
// DEMO_MODE=false so the site stops saying it's pretend). Rows are upserted by
// slug on every boot, so editing this file is enough; removing one from the
// list retires it without losing its donation history.

module.exports = [
  { slug: 'taller-trees', name: 'Society for Slightly Taller Trees', category: 'Forestry', url: '', blurb: "We can't make trees taller. We can make them feel taller." },
  { slug: 'pigeons-dignity', name: 'Pigeons With Dignity', category: 'Animals', url: '', blurb: 'Tiny hats. Big self-esteem.' },
  { slug: 'ducks-owed-bread', name: 'Fund for Ducks Who Are Owed Bread', category: 'Animals', url: '', blurb: 'A debt generations in the making.' },
  { slug: 'left-sock-recovery', name: 'Left Sock Recovery Initiative', category: 'Household', url: '', blurb: "They're somewhere. We are going to find them." },
  { slug: 'hold-music-trust', name: 'Hold Music Appreciation Trust', category: 'Arts', url: '', blurb: 'Someone wrote that. They deserve to know it mattered.' },
  { slug: 'moon-visibility', name: 'Moon Visibility Foundation', category: 'Science', url: '', blurb: 'Keeping the moon visible, one clear night at a time.' },
  { slug: 'lighthouse-lunch', name: "Lighthouse Keepers' Lunch Program", category: 'Hunger', url: '', blurb: "It's a long way down for a sandwich." },
  { slug: 'toilet-paper-over', name: 'Coalition for Correctly Rolled Toilet Paper', category: 'Civics', url: '', blurb: 'Over. It was always over.' },
  { slug: 'umbrella-relief', name: 'Umbrella Relief Fund for Umbrellas', category: 'Weather', url: '', blurb: 'You left it on the train. We take it from here.' },
  { slug: 'puddle-preservation', name: 'Puddle Preservation League', category: 'Water', url: '', blurb: 'Every puddle was once a cloud. Thematically appropriate.' },
  { slug: 'unbothered-institute', name: 'Hill Country Institute of Being Unbothered', category: 'Wellness', url: '', blurb: "We're working on it." },
  { slug: 'joke-rehoming', name: 'Elderly Jokes Rehoming Society', category: 'Humor', url: '', blurb: 'Every joke deserves a second tell.' },
];
