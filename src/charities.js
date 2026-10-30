// The charities players' lobbyists can lobby for. Real organizations, each
// rated 4 of 4 stars by Charity Navigator when this list was made
// (checked on each one's Charity Navigator profile, Oct 29, 2026). Ratings
// change: re-check before each quarter's payout, and drop anything that slips.
//
// Rows are upserted by slug on every boot, so editing this file is enough.
// Removing one retires it without losing its history; players whose default
// was retired are asked to choose again (see migrate.js and POST /charity/choose).
// Players can request others from the game; they land on the admin page.
//
// Shown alphabetically. `rating` is shown as stars beside the name.

module.exports = [
  { slug: 'against-malaria', name: 'Against Malaria Foundation', ein: '20-3069841', category: 'Malaria', url: 'https://www.againstmalaria.com', rating: '4 stars', blurb: 'Funds long-lasting insecticidal nets that protect families from malaria.' },
  { slug: 'best-friends', name: 'Best Friends Animal Society', ein: '23-7147797', category: 'Animals', url: 'https://bestfriends.org', rating: '4 stars', blurb: "Working to end the killing of dogs and cats in America's shelters." },
  { slug: 'charity-water', name: 'charity: water', ein: '22-3936753', category: 'Clean water', url: 'https://www.charitywater.org', rating: '4 stars', blurb: 'Funds clean, safe drinking water projects in developing countries.' },
  { slug: 'crisis-text-line', name: 'Crisis Text Line', ein: '46-5039599', category: 'Mental health', url: 'https://www.crisistextline.org', rating: '4 stars', blurb: 'Free, 24/7 support by text for anyone in crisis.' },
  { slug: 'direct-relief', name: 'Direct Relief', ein: '95-1831116', category: 'Medical aid', url: 'https://www.directrelief.org', rating: '4 stars', blurb: 'Gets medicine and medical supplies to people hit by poverty and emergencies.' },
  { slug: 'doctors-without-borders', name: 'Doctors Without Borders USA', ein: '13-3433452', category: 'Global health', url: 'https://www.doctorswithoutborders.org', rating: '4 stars', blurb: 'Independent medical care in war zones, epidemics and disasters.' },
  { slug: 'donorschoose', name: 'DonorsChoose', ein: '13-4129457', category: 'Education', url: 'https://www.donorschoose.org', rating: '4 stars', blurb: 'Funds classroom projects requested by public school teachers.' },
  { slug: 'equal-justice-initiative', name: 'Equal Justice Initiative', ein: '63-1135091', category: 'Justice', url: 'https://eji.org', rating: '4 stars', blurb: 'Represents people who were wrongly convicted or unfairly sentenced.' },
  { slug: 'feeding-america', name: 'Feeding America', ein: '36-3673599', category: 'Hunger', url: 'https://www.feedingamerica.org', rating: '4 stars', blurb: 'A nationwide network of food banks fighting hunger in the US.' },
  { slug: 'fisher-house', name: 'Fisher House Foundation', ein: '11-3158401', category: 'Veterans', url: 'https://fisherhouse.org', rating: '4 stars', blurb: "Free lodging for military and veterans' families while a loved one is in the hospital." },
  { slug: 'givedirectly', name: 'GiveDirectly', ein: '27-1661997', category: 'Poverty', url: 'https://www.givedirectly.org', rating: '4 stars', blurb: 'Sends cash directly to people living in extreme poverty.' },
  { slug: 'habitat-for-humanity', name: 'Habitat for Humanity International', ein: '91-1914868', category: 'Housing', url: 'https://www.habitat.org', rating: '4 stars', blurb: 'Builds and repairs homes with families who need affordable housing.' },
  { slug: 'international-rescue-committee', name: 'International Rescue Committee', ein: '13-5660870', category: 'Refugees', url: 'https://www.rescue.org', rating: '4 stars', blurb: 'Helps people whose lives are upended by conflict and disaster survive and rebuild.' },
  { slug: 'nature-conservancy', name: 'The Nature Conservancy', ein: '53-0242652', category: 'Environment', url: 'https://www.nature.org', rating: '4 stars', blurb: 'Protects lands and waters around the world.' },
  { slug: 'save-the-children', name: 'Save the Children', ein: '06-0726487', category: 'Children', url: 'https://www.savethechildren.org', rating: '4 stars', blurb: 'Helps children in the US and around the world stay healthy, learn and stay safe.' },
  { slug: 'smile-train', name: 'Smile Train', ein: '13-3661416', category: "Kids' surgery", url: 'https://www.smiletrain.org', rating: '4 stars', blurb: 'Funds cleft lip and palate surgery and care for children worldwide.' },
  { slug: 'st-jude', name: "St. Jude Children's Research Hospital", ein: '35-1044585', category: "Kids' health", url: 'https://www.stjude.org', rating: '4 stars', blurb: 'Treats children with cancer and other deadly diseases. Families never get a bill. (Rated as ALSAC, its fundraising arm.)' },
  { slug: 'world-central-kitchen', name: 'World Central Kitchen', ein: '27-3521132', category: 'Disaster relief', url: 'https://wck.org', rating: '4 stars', blurb: 'Cooks and serves fresh meals on the front lines of disasters and crises.' },
];
