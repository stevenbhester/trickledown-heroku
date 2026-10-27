// Seed list of charities players can direct their tax to. Placeholder for the
// demo: before launch, verify each one's current rating on Charity Navigator
// (or whichever grader you settle on) and that you're comfortable sending them
// real money. No affiliation or endorsement is implied by their inclusion.
//
// Rows are upserted by slug on every migrate, so edits here flow to the DB.
// Set active: false to retire one without losing its donation history.

module.exports = [
  { slug: 'msf', name: 'Doctors Without Borders', category: 'Medical', url: 'https://www.doctorswithoutborders.org', blurb: 'Emergency medical care where it is hardest to get.' },
  { slug: 'givedirectly', name: 'GiveDirectly', category: 'Poverty', url: 'https://www.givedirectly.org', blurb: 'Sends cash straight to people living in extreme poverty.' },
  { slug: 'amf', name: 'Against Malaria Foundation', category: 'Health', url: 'https://www.againstmalaria.com', blurb: 'Bed nets. One of the cheapest ways to save a life.' },
  { slug: 'direct-relief', name: 'Direct Relief', category: 'Medical', url: 'https://www.directrelief.org', blurb: 'Medicine and supplies to clinics in disasters and poverty.' },
  { slug: 'feeding-america', name: 'Feeding America', category: 'Hunger', url: 'https://www.feedingamerica.org', blurb: 'The national network of food banks.' },
  { slug: 'central-texas-food-bank', name: 'Central Texas Food Bank', category: 'Hunger', url: 'https://www.centraltexasfoodbank.org', blurb: 'Feeds Central Texas, including Austin and the Hill Country.' },
  { slug: 'wck', name: 'World Central Kitchen', category: 'Hunger', url: 'https://wck.org', blurb: 'Hot meals in the middle of disasters and wars.' },
  { slug: 'charity-water', name: 'charity: water', category: 'Water', url: 'https://www.charitywater.org', blurb: 'Clean water projects. Thematically appropriate.' },
  { slug: 'st-jude', name: "St. Jude Children's Research Hospital", category: 'Medical', url: 'https://www.stjude.org', blurb: 'Treats kids with cancer. Families never get a bill.' },
  { slug: 'habitat', name: 'Habitat for Humanity', category: 'Housing', url: 'https://www.habitat.org', blurb: 'Builds and repairs homes with the families who live in them.' },
  { slug: 'khan-academy', name: 'Khan Academy', category: 'Education', url: 'https://www.khanacademy.org', blurb: 'Free education for anyone, anywhere.' },
  { slug: 'aspca', name: 'ASPCA', category: 'Animals', url: 'https://www.aspca.org', blurb: 'Rescues and protects animals across the US.' },
];
