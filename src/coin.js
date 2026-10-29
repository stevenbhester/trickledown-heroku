// The coin. Pure drawing: takes numbers, returns SVG markup. No app state here.
//
//   Coin.front({ positions, cash, preview, grow })  the ring of wedges + the fan of bills
//
// Geometry: 320×320 viewBox. Milled edge 150–160, wedge ring 84–146, inset
// center under 84. Angles clockwise from 12 o'clock. Positions come first
// (oldest first), then the cash sector, so a slice carved from the start of
// the cash sector sits right where the next wedge will appear.
//
// Wedges are labeled with the dollars in them and colored by how they're doing:
// pale to strong green for gains, pale to strong rust for losses, dark when
// busted, a gold edge once matured. The return itself lives in the tooltip.
window.Coin = (function () {
  const CX = 160, CY = 160, R = 146, RI = 84, RM = (R + RI) / 2;
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function polar(r, deg) {
    const a = (deg - 90) * Math.PI / 180;
    return [CX + r * Math.cos(a), CY + r * Math.sin(a)];
  }
  const f = (n) => n.toFixed(2);

  function sector(a0, sweep, r0 = RI, r1 = R) {
    sweep = Math.max(0, Math.min(359.99, sweep));
    if (sweep <= 0) return '';
    const [x0, y0] = polar(r1, a0), [x1, y1] = polar(r1, a0 + sweep);
    const [xi1, yi1] = polar(r0, a0 + sweep), [xi0, yi0] = polar(r0, a0);
    const large = sweep > 180 ? 1 : 0;
    return `M${f(x0)} ${f(y0)} A${r1} ${r1} 0 ${large} 1 ${f(x1)} ${f(y1)} L${f(xi1)} ${f(yi1)} A${r0} ${r0} 0 ${large} 0 ${f(xi0)} ${f(yi0)} Z`;
  }

  // Linear blend of two hex colours, k in 0..1.
  function mix(a, b, k) {
    const pa = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16));
    const pb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16));
    return '#' + pa.map((v, i) => Math.round(v + (pb[i] - v) * k).toString(16).padStart(2, '0')).join('');
  }
  // Colour by outcome. Intensity saturates around ±60%.
  function wedgeFill(p) {
    if (p.quote_error) return '#C9D4D9';
    if (p.busted) return '#0F2430';
    const s = p.swing_pct || 0;
    const k = Math.min(1, Math.abs(s) / 0.6);
    if (s > 0) return mix('#DDF0E6', '#2E9C72', k);
    if (s < 0) return mix('#F4E1DC', '#C04A35', k);
    return '#CDE4EB';
  }
  // Play money in thousands, like the rest of the UI: $50K, $1.2M.
  const fmt1 = (v) => { const r = Math.round(v * 10) / 10; return Number.isInteger(r) ? String(r) : r.toFixed(1); };
  const money = (n) => (n >= 1000 ? `$${fmt1(n / 1000)}M` : n > 0 && n < 0.1 ? `$${Math.round(n * 1000)}` : `$${fmt1(n)}K`);

  function label(a0, sweep, lines, cls = '', light = false) {
    if (sweep < 20) return '';
    const [x, y] = polar(RM, a0 + sweep / 2);
    const second = sweep >= 34 ? lines[1] : null;
    return `<text class="wedge-label ${cls} ${light ? 'light' : ''}" x="${f(x)}" y="${f(y)}" text-anchor="middle">
      <tspan x="${f(x)}" dy="${second ? '-0.1em' : '0.35em'}" class="wl-ticker">${esc(lines[0])}</tspan>
      ${second ? `<tspan x="${f(x)}" dy="1.25em" class="wl-sub">${esc(second)}</tspan>` : ''}
    </text>`;
  }

  // A fan of bills along the cash sector. One bill per $10, 1..20 of them.
  function bills(a0, sweep, cash) {
    if (sweep <= 0 || cash <= 0) return '';
    const n = Math.max(1, Math.min(20, Math.ceil(cash / 10)));
    const step = sweep / n;
    let out = '';
    for (let i = 0; i < n; i++) {
      const a = a0 + step * (i + 0.5);
      const [x, y] = polar(RM + 2, a);
      out += `<g class="bill" transform="translate(${f(x)} ${f(y)}) rotate(${f(a)})">
        <rect x="-10" y="-20" width="20" height="40" rx="2"/>
        <rect x="-7.5" y="-17.5" width="15" height="35" rx="1" class="bill-inner"/>
        <text y="4" text-anchor="middle" class="bill-text">$</text>
      </g>`;
    }
    return out;
  }

  // The coin body: silver (or gunmetal, on the back), a milled edge, a raised
  // rim, the field the wedges sit on.
  function body(back) {
    const id = back ? 'cb' : 'cf';
    const k = back ? ' back' : '';
    const defs = back ? `
      <radialGradient id="${id}-field" cx="38%" cy="32%" r="85%"><stop offset="0" stop-color="#2C4654"/><stop offset="0.65" stop-color="#15293A"/><stop offset="1" stop-color="#0A1820"/></radialGradient>
      <linearGradient id="${id}-rim" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#4A6473"/><stop offset="0.5" stop-color="#1E3442"/><stop offset="1" stop-color="#0B1A22"/></linearGradient>` : `
      <radialGradient id="${id}-field" cx="38%" cy="32%" r="85%"><stop offset="0" stop-color="#FDFEFE"/><stop offset="0.55" stop-color="#E9EEF0"/><stop offset="1" stop-color="#C3CDD2"/></radialGradient>
      <linearGradient id="${id}-rim" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#F6F8F9"/><stop offset="0.5" stop-color="#C2CCD1"/><stop offset="1" stop-color="#98A8B0"/></linearGradient>`;
    return `
      <defs>${defs}<clipPath id="${id}-hole"><circle cx="${CX}" cy="${CY}" r="${RI - 3}"/></clipPath></defs>
      <circle cx="${CX}" cy="${CY}" r="159" class="coin-edge${k}" fill="url(#${id}-rim)"/>
      <circle cx="${CX}" cy="${CY}" r="155" class="coin-reed${k}"/>
      <circle cx="${CX}" cy="${CY}" r="150" class="coin-rim${k}" fill="url(#${id}-rim)"/>
      <circle cx="${CX}" cy="${CY}" r="${R + 1}" class="coin-field${k}" fill="url(#${id}-field)"/>`;
  }

  // A lobbyist, drawn once here for the back's watermark.
  const LOBBYIST_PATHS = `<circle cx="9" cy="5.5" r="4.5"/><path d="M3 12 h12 l1.5 14 h-15 z"/><rect x="4.5" y="26" width="4" height="13" rx="0.5"/><rect x="9.5" y="26" width="4" height="13" rx="0.5"/><rect x="15" y="21" width="5" height="7" rx="0.8"/>`;

  // The inset center, with a faint stamp under the number: a $ on heads, a
  // lobbyist on tails, in the same spot, so the flip turns one into the other.
  function center(back) {
    const id = back ? 'cb' : 'cf';
    const k = back ? ' back' : '';
    const stamp = back
      ? `<g class="coin-stamp${k}" transform="translate(${CX - 50} ${CY - 108}) scale(5.4)">${LOBBYIST_PATHS}</g>`
      : `<text class="coin-stamp" x="${CX}" y="${CY + 46}" text-anchor="middle">$</text>`;
    return `<circle cx="${CX}" cy="${CY}" r="${RI}" class="coin-hole${k}" fill="url(#${id}-field)"/>
      <circle cx="${CX}" cy="${CY}" r="${RI - 3}" class="coin-hole-inner${k}"/>
      <g clip-path="url(#${id}-hole)">${stamp}</g>`;
  }

  // positions: [{ id, symbol, invested, value, swing_pct, busted, quote_error, matured }]
  // cash: number, preview: { amount } | null, grow: { id, t } | null (t in 0..1)
  function front({ positions, cash, preview, grow }) {
    const items = positions.map((p) => {
      let v = p.quote_error ? p.invested : p.value;
      if (grow && grow.id === p.id) v *= grow.t;
      return { ...p, v };
    });
    let cashShown = cash;
    if (grow) { const g = items.find((p) => p.id === grow.id); if (g) cashShown += (g.quote_error ? g.invested : g.value) * (1 - grow.t); }
    const total = items.reduce((s, p) => s + p.v, 0) + cashShown;
    const deg = (v) => (total > 0 ? (v / total) * 360 : 0);

    let a = 0, wedges = '', labels = '';
    for (const p of items) {
      const sw = p.busted ? Math.max(deg(p.v), 3) : deg(p.v);
      if (sw <= 0) continue;
      const cls = ['wedge', p.quote_error ? 'stale' : p.busted ? 'busted' : p.swing_pct > 0 ? 'up' : p.swing_pct < 0 ? 'down' : 'flat', p.matured ? 'matured' : ''].join(' ');
      wedges += `<path class="${cls}" data-id="${p.id}" d="${sector(a, sw)}" style="fill:${wedgeFill(p)}" tabindex="0" role="button" aria-label="${esc(p.symbol)}, ${money(p.invested)} in"></path>`;
      const strong = !p.busted && !p.quote_error && Math.abs(p.swing_pct || 0) >= 0.45;
      labels += label(a, sw, [p.symbol, p.busted ? 'gone' : money(p.invested)], p.busted ? 'busted' : '', p.busted || strong);
      a += sw;
    }
    const cashSweep = deg(cashShown);
    let cashLayer = '';
    if (cashSweep > 0) {
      cashLayer += `<path class="cash-sector" d="${sector(a, cashSweep)}" role="button" tabindex="0" aria-label="${money(cashShown)} free to spend"/>`;
      cashLayer += bills(a, cashSweep, cashShown);
      if (preview && preview.amount > 0) {
        const sw = Math.min(cashSweep, deg(preview.amount));
        cashLayer += `<path class="preview-slice" d="${sector(a, sw, RI - 3, R + 3)}"/>`;
      }
    }
    return `<svg class="coin-svg" viewBox="0 0 320 320" aria-label="Your money as a coin">
      ${body(false)}
      ${wedges}${cashLayer}${labels}
      ${total <= 0 ? `<circle cx="${CX}" cy="${CY}" r="${RM}" class="coin-empty-ring"/>` : ''}
      ${center(false)}
    </svg>`;
  }

  // --- Tails: the village --------------------------------------------------------

  // The two advocates, as small portraits. size is the rendered width in px.
  function preston(size = 40) {
    return `<svg class="advocate preston" width="${size}" height="${size}" viewBox="0 0 40 40" aria-hidden="true">
      <circle cx="20" cy="20" r="20" fill="#E7EEF1"/>
      <path d="M6 40 C6 30 12 27 20 27 C28 27 34 30 34 40 Z" fill="#1B2F4A"/>
      <path d="M17 27 L20 38 L23 27 Z" fill="#fff"/><path d="M19 28 L21 28 L21.6 35 L20 37 L18.4 35 Z" fill="#D4A72C"/>
      <circle cx="20" cy="17" r="8" fill="#E9C6A1"/>
      <path d="M11.5 15 C12 8 19 7 25 9 C28 10 29 13 28.5 15 C26 12 21 11.5 17 13 C15 13.5 13 14.5 11.5 15 Z" fill="#2A2018"/>
      <path d="M16.5 20.5 Q20 23.5 23.5 20.5" stroke="#7A3B2A" stroke-width="1.2" fill="none" stroke-linecap="round"/>
      <circle cx="17" cy="17" r="0.9" fill="#1B1B1B"/><circle cx="23" cy="17" r="0.9" fill="#1B1B1B"/>
    </svg>`;
  }
  function dolores(size = 40) {
    return `<svg class="advocate dolores" width="${size}" height="${size}" viewBox="0 0 40 40" aria-hidden="true">
      <circle cx="20" cy="20" r="20" fill="#E7EEF1"/>
      <path d="M6 40 C6 30 12 27 20 27 C28 27 34 30 34 40 Z" fill="#2F7A6B"/>
      <rect x="23" y="29" width="9" height="11" rx="1" fill="#C9A46A"/><rect x="24.5" y="31" width="6" height="7" fill="#fff"/>
      <circle cx="20" cy="17" r="8" fill="#C99A72"/>
      <circle cx="20" cy="7.5" r="4" fill="#8E8A86"/>
      <path d="M11.8 17 C11.5 11 15 9 20 9 C25 9 28.5 11 28.2 17 C27 13.5 24 12.5 20 12.5 C16 12.5 13 13.5 11.8 17 Z" fill="#8E8A86"/>
      <circle cx="16.8" cy="17.5" r="2.3" fill="none" stroke="#1B1B1B" stroke-width="1"/><circle cx="23.2" cy="17.5" r="2.3" fill="none" stroke="#1B1B1B" stroke-width="1"/>
      <path d="M19.1 17.5 L20.9 17.5" stroke="#1B1B1B" stroke-width="1"/>
      <path d="M17.5 22 L22.5 22" stroke="#6A3B2A" stroke-width="1.2" stroke-linecap="round"/>
    </svg>`;
  }

  // Buildings are drawn centred on x with their base on y.
  const BUILDINGS = {
    empty: (x, y) => `
      <rect x="${x - 34}" y="${y - 30}" width="68" height="30" class="b-lot"/>
      <line x1="${x}" y1="${y - 30}" x2="${x}" y2="${y - 52}" class="b-post"/>
      <rect x="${x - 24}" y="${y - 66}" width="48" height="16" rx="2" class="b-sign"/>
      <text x="${x}" y="${y - 55}" text-anchor="middle" class="b-sign-text">EMPTY LOT</text>`,
    tenement: (x, y) => `
      <g transform="rotate(-2 ${x} ${y})">
        <rect x="${x - 36}" y="${y - 44}" width="34" height="44" class="b-tene"/>
        <rect x="${x - 2}" y="${y - 58}" width="36" height="58" class="b-tene dark"/>
        <rect x="${x - 30}" y="${y - 70}" width="26" height="26" class="b-tene"/>
        ${[0, 1, 2].map((r) => [0, 1].map((c) => `<rect x="${x + 4 + c * 14}" y="${y - 52 + r * 16}" width="8" height="8" class="b-win ${(r + c) % 3 === 0 ? 'broken' : 'dim'}"/>`).join('')).join('')}
        ${[0, 1].map((r) => [0, 1].map((c) => `<rect x="${x - 30 + c * 14}" y="${y - 38 + r * 16}" width="8" height="8" class="b-win dim"/>`).join('')).join('')}
        <path d="M${x - 26} ${y - 46} Q${x - 10} ${y - 40} ${x + 6} ${y - 46}" class="b-line"/>
        <rect x="${x - 20}" y="${y - 44}" width="5" height="7" fill="#C04A35"/><rect x="${x - 10}" y="${y - 43}" width="5" height="7" fill="#E7C24A"/>
      </g>`,
    pinnacle: (x, y) => `
      <line x1="${x + 26}" y1="${y}" x2="${x + 26}" y2="${y - 112}" class="b-crane"/><line x1="${x + 26}" y1="${y - 112}" x2="${x - 30}" y2="${y - 112}" class="b-crane"/>
      <line x1="${x - 18}" y1="${y - 112}" x2="${x - 18}" y2="${y - 100}" class="b-crane thin"/>
      <rect x="${x - 15}" y="${y - 104}" width="30" height="104" class="b-tower"/>
      <path d="M${x - 15} ${y - 104} L${x} ${y - 118} L${x + 15} ${y - 104} Z" class="b-gold"/>
      ${Array.from({ length: 8 }, (_, r) => [0, 1, 2].map((c) => `<rect x="${x - 11 + c * 8}" y="${y - 96 + r * 11}" width="5" height="6" class="b-win ${(r * 3 + c) % 4 === 0 ? 'lit' : 'dim'}"/>`).join('')).join('')}
      <rect x="${x - 40}" y="${y - 70}" width="25" height="12" class="b-banner"/><text x="${x - 27.5}" y="${y - 61}" text-anchor="middle" class="b-banner-text">LUXURY</text>`,
    coop: (x, y) => `
      <rect x="${x - 36}" y="${y - 30}" width="32" height="30" class="b-house a"/><path d="M${x - 40} ${y - 30} L${x - 20} ${y - 48} L${x} ${y - 30} Z" class="b-roof"/>
      <rect x="${x + 2}" y="${y - 34}" width="32" height="34" class="b-house b"/><path d="M${x - 2} ${y - 34} L${x + 18} ${y - 52} L${x + 38} ${y - 34} Z" class="b-roof"/>
      <rect x="${x - 24}" y="${y - 22}" width="8" height="8" class="b-win lit"/><rect x="${x + 14}" y="${y - 26}" width="8" height="8" class="b-win lit"/>
      <rect x="${x - 4}" y="${y - 12}" width="8" height="12" class="b-door"/>
      <circle cx="${x + 40}" cy="${y - 18}" r="9" class="b-tree"/><rect x="${x + 39}" y="${y - 10}" width="2" height="10" class="b-trunk"/>
      <text x="${x - 20}" y="${y - 34}" text-anchor="middle" class="b-heart">♥</text>`,
    casino: (x, y) => `
      <rect x="${x - 38}" y="${y - 44}" width="76" height="44" class="b-casino"/>
      <rect x="${x - 38}" y="${y - 50}" width="76" height="8" class="b-gold"/>
      ${Array.from({ length: 10 }, (_, i) => `<circle cx="${x - 34 + i * 7.5}" cy="${y - 46}" r="1.6" class="b-bulb" style="animation-delay:${i * 0.12}s"/>`).join('')}
      <text x="${x}" y="${y - 54}" text-anchor="middle" class="b-neon">$ $ $</text>
      <rect x="${x - 10}" y="${y - 22}" width="20" height="22" class="b-door gold"/>
      <text x="${x}" y="${y - 28}" text-anchor="middle" class="b-casino-text">LUCKY LOBBY</text>`,
    store: (x, y) => `
      <rect x="${x - 34}" y="${y - 40}" width="68" height="40" class="b-store"/>
      ${Array.from({ length: 6 }, (_, i) => `<rect x="${x - 36 + i * 12}" y="${y - 40}" width="12" height="10" class="${i % 2 ? 'b-awn-w' : 'b-awn-r'}"/>`).join('')}
      <rect x="${x - 30}" y="${y - 56}" width="60" height="14" class="b-sign"/>
      <text x="${x}" y="${y - 46}" text-anchor="middle" class="b-sign-text">COMPANY STORE</text>
      <rect x="${x - 8}" y="${y - 22}" width="16" height="22" class="b-door"/>
      <rect x="${x - 28}" y="${y - 24}" width="14" height="12" class="b-win lit"/><rect x="${x + 14}" y="${y - 24}" width="14" height="12" class="b-win lit"/>`,
    clinic: (x, y) => `
      <rect x="${x - 32}" y="${y - 44}" width="64" height="44" class="b-clinic"/>
      <rect x="${x - 6}" y="${y - 40}" width="12" height="24" class="b-cross"/><rect x="${x - 12}" y="${y - 34}" width="24" height="12" class="b-cross"/>
      <rect x="${x - 8}" y="${y - 14}" width="16" height="14" class="b-door"/>
      <rect x="${x - 26}" y="${y - 32}" width="12" height="10" class="b-win lit"/><rect x="${x + 14}" y="${y - 32}" width="12" height="10" class="b-win lit"/>`,
  };

  // town: the /me town view. pop: this quarter's lobbyists. pending: issues awaiting a decision.
  function village({ town, pop, pending, locked = false, progress = 0 }) {
    const hp = town.happiness / 100, hl = hp; // one mood: the sky and the grass both follow happiness
    const sky0 = mix('#8E9AA0', '#7FC3DD', hp), sky1 = mix('#C7CED1', '#E6F4F8', hp);
    const ground = mix('#9C8F6E', '#7DB27A', hl), ground2 = mix('#857A5C', '#5E9A5E', hl);
    const plots = Object.fromEntries(town.plots.map((p) => [p.slot, p.key]));
    const n = Math.min(14, Math.ceil(pop - 1e-9));
    const frac = round2(pop - Math.floor(pop));
    const sick = false;
    const sad = town.happiness < 30;
    let people = '';
    for (let i = 0; i < n; i++) {
      const x = 62 + ((i * 47) % 186) + (i % 3) * 3;
      const y = 218 + ((i * 29) % 30);
      const down = sick && i % 3 === 1;
      const clip = i === n - 1 && frac > 0 ? ` style="clip-path: inset(0 0 ${Math.round((1 - frac) * 100)}% 0)"` : '';
      people += down
        ? `<g class="v-person down" transform="translate(${x} ${y + 12}) rotate(-90) scale(0.75)"${clip}>${LOBBYIST_PATHS}</g>`
        : `<g class="v-walk" style="animation-delay:${(i % 5) * 0.6}s"><g class="v-person" transform="translate(${x} ${y}) scale(0.75)"${clip}>${LOBBYIST_PATHS}${sad && i % 4 === 0 ? '<rect x="6" y="-14" width="14" height="10" class="v-protest"/><line x1="13" y1="-4" x2="13" y2="12" class="v-protest-stick"/>' : ''}</g></g>`;
    }
    const weather = hp > 0.55
      ? `<circle cx="252" cy="70" r="13" class="v-sun"/>`
      : `<g class="v-cloud"><ellipse cx="238" cy="72" rx="20" ry="9"/><ellipse cx="252" cy="66" rx="13" ry="9"/></g>${hp < 0.3 ? '<g class="v-cloud dark"><ellipse cx="96" cy="84" rx="22" ry="9"/><ellipse cx="110" cy="78" rx="12" ry="8"/></g>' : ''}`;
    const advocates = pending > 0 ? `
      <g class="v-advocate a1" transform="translate(98 262)">${preston(36).replace(/<svg[^>]*>/, '').replace('</svg>', '')}<g transform="translate(26 -10)"><rect width="16" height="14" rx="3" class="v-bubble"/><text x="8" y="11" text-anchor="middle" class="v-bubble-text">!</text></g></g>
      <g class="v-advocate a2" transform="translate(186 262)">${dolores(36).replace(/<svg[^>]*>/, '').replace('</svg>', '')}<g transform="translate(26 -10)"><rect width="16" height="14" rx="3" class="v-bubble"/><text x="8" y="11" text-anchor="middle" class="v-bubble-text">!</text></g></g>` : '';
    return `<svg class="coin-svg village" viewBox="0 0 320 320" aria-label="Your lobbyist village">
      ${body(true)}
      <defs>
        <clipPath id="v-clip"><circle cx="${CX}" cy="${CY}" r="${R + 1}"/></clipPath>
        <linearGradient id="v-sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${sky0}"/><stop offset="1" stop-color="${sky1}"/></linearGradient>
      </defs>
      <g clip-path="url(#v-clip)">
        <rect x="0" y="0" width="320" height="200" fill="url(#v-sky)"/>
        ${weather}
        <rect x="0" y="196" width="320" height="130" fill="${ground}"/>
        <path d="M0 214 Q160 200 320 214 L320 222 Q160 208 0 222 Z" fill="${ground2}" opacity=".5"/>
        <text x="160" y="46" text-anchor="middle" class="v-title">${locked ? '???' : 'TRICKLETOWN'}</text>
        ${locked ? '' : `<text x="160" y="62" text-anchor="middle" class="v-pop">pop. ${esc(pop % 1 ? pop.toFixed(2).replace(/0$/, '') : pop)}</text>`}
        <g class="v-site" data-site="housing">${BUILDINGS[plots.housing || 'empty'](104, 200)}</g>
        <g class="v-site" data-site="square">${BUILDINGS[plots.square || 'empty'](220, 200)}</g>
        ${locked ? '' : people}
        ${locked ? '' : advocates}
        ${locked ? `
          <rect x="0" y="0" width="320" height="320" class="v-fog"/>
          <g transform="translate(160 150)">
            <path d="M-16 -6 v-10 a16 16 0 0 1 32 0 v10" fill="none" class="v-lock-shackle"/>
            <rect x="-24" y="-6" width="48" height="38" rx="6" class="v-lock"/>
            <text y="20" text-anchor="middle" class="v-lock-text">?</text>
          </g>
          <text x="160" y="218" text-anchor="middle" class="v-locked-title">UNDER CONSTRUCTION</text>
          <text x="160" y="238" text-anchor="middle" class="v-locked-sub">opens with your first lobbyist</text>
          <rect x="100" y="250" width="120" height="8" rx="4" class="v-prog-bg"/>
          <rect x="100" y="250" width="${Math.min(120, 120 * Math.max(0, progress))}" height="8" rx="4" class="v-prog"/>` : ''}
      </g>
    </svg>`;
  }

  const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

  // One building on a little patch of ground, for tiles. key: a building key or null.
  function buildingIcon(key, size = 120) {
    const art = BUILDINGS[key || 'empty'](70, 118);
    return `<svg class="b-icon" width="${size}" height="${Math.round(size * 0.8)}" viewBox="0 0 140 112" aria-hidden="true">
      <rect x="0" y="0" width="140" height="112" fill="#DCEAF0"/>
      <rect x="0" y="100" width="140" height="12" fill="#9BC48F"/>
      ${art}
    </svg>`;
  }

  return { front, village, buildingIcon, preston, dolores };
})();
