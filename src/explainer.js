// Tutorials, as two short decks in the voice of a cheerful holding company.
// Every title should work on its own: read just the titles and you know the
// game. The body is flavor and optional detail.
//
//   Explainer.open({ deck, rules, onDone, onClose })
//     deck     'main' (first open) or 'town' (after your first full lobbyist)
//     onDone   called when the last slide's button is pressed
//     onClose  called whenever the deck closes, finished or not
//   Explainer.seen(deck)   true once that deck has been finished or closed
//   Explainer.isOpen()
window.Explainer = (function () {
  const KEYS = { main: 'trickledown.oriented', town: 'trickledown.town-intro' };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // Shared shapes, in the same 20×40 footprint the game uses.
  const bill = (x, y, cls = '', rot = 0) => `<g class="x-bill ${cls}" transform="translate(${x} ${y}) rotate(${rot})"><rect x="-10" y="-20" width="20" height="40" rx="2"/><rect x="-7.5" y="-17.5" width="15" height="35" rx="1" class="in"/><text y="5" text-anchor="middle">$</text></g>`;
  const suit = (x, y, cls = '', s = 1) => `<g class="x-suit ${cls}" transform="translate(${x} ${y}) scale(${s})"><circle cx="9" cy="5.5" r="4.5"/><path d="M3 12 h12 l1.5 14 h-15 z"/><path class="tie" d="M9 12 l1.6 0 l-0.3 9 l-0.5 1.4 l-0.5 -1.4 z"/><rect x="4.5" y="26" width="4" height="13" rx="0.5"/><rect x="9.5" y="26" width="4" height="13" rx="0.5"/><rect class="case" x="15" y="21" width="5" height="7" rx="0.8"/></g>`;
  const coin = (cx, cy, r) => `<circle cx="${cx}" cy="${cy}" r="${r + 5}" class="x-rim"/><circle cx="${cx}" cy="${cy}" r="${r}" class="x-field"/>`;
  const arrow = (x1, x2, y) => `<path d="M${x1} ${y} L${x2} ${y}" class="x-arrow"/><path d="M${x2 - 6} ${y - 6} L${x2 + 2} ${y} L${x2 - 6} ${y + 6}" class="x-arrow"/>`;
  const svg = (inner) => `<svg viewBox="0 0 280 150" class="x-art">${inner}</svg>`;

  function wedge(cx, cy, r0, r1, a0, a1) {
    const p = (r, a) => { const t = (a - 90) * Math.PI / 180; return [cx + r * Math.cos(t), cy + r * Math.sin(t)]; };
    const [x0, y0] = p(r1, a0), [x1, y1] = p(r1, a1), [x2, y2] = p(r0, a1), [x3, y3] = p(r0, a0);
    const L = a1 - a0 > 180 ? 1 : 0;
    return `M${x0} ${y0} A${r1} ${r1} 0 ${L} 1 ${x1} ${y1} L${x2} ${y2} A${r0} ${r0} 0 ${L} 0 ${x3} ${y3} Z`;
  }

  // A little town on a strip of grass, for the town deck.
  const miniTown = (extra = '') => `
    <rect x="0" y="0" width="280" height="104" fill="#CDE4EB"/><circle cx="240" cy="30" r="12" fill="#F2D06B"/>
    <rect x="0" y="104" width="280" height="46" fill="#9BC48F"/>
    <rect x="56" y="40" width="26" height="64" fill="#9FB6C2" stroke="#4F6874"/><path d="M56 40 L69 28 L82 40 Z" fill="#D4A72C"/>
    <rect x="160" y="72" width="44" height="32" fill="#E7C48F" stroke="#8A6A3A"/><path d="M156 72 L182 54 L208 72 Z" fill="#B0412E"/>
    ${extra}`;

  // A portrait with a speech bubble, for meeting the advocates.
  const person = (who, quote) => `<div class="x-art x-person ${who}">
      ${window.Coin ? window.Coin[who](92) : ''}
      <div class="x-bubble">${esc(quote)}</div>
    </div>`;

  function mainDeck(r) {
    const pct = Math.round(r.tax_rate * 100);
    return [
      {
        kicker: 'Welcome to Trickle Down',
        title: 'Fake money. Real charity.',
        art: svg(`
          ${coin(46, 70, 28)}<text x="46" y="82" text-anchor="middle" class="x-big">$</text>
          ${arrow(84, 104, 70)}
          ${suit(112, 52, '', 0.85)}${suit(130, 52, '', 0.85)}${suit(148, 52, '', 0.85)}
          ${arrow(172, 192, 70)}
          <rect x="204" y="52" width="52" height="38" fill="#fff" stroke="#8EA3AC"/><path d="M200 52 L230 34 L260 52 Z" fill="#1879A0"/>
          <text x="230" y="78" text-anchor="middle" fill="#B0412E" font-size="18">♥</text>
          <text x="46" y="122" text-anchor="middle" class="x-small">fake money</text>
          <text x="139" y="122" text-anchor="middle" class="x-small">lobbyists</text>
          <text x="230" y="122" text-anchor="middle" class="x-small">real charity</text>`),
        body: `You get $${r.daily_base}K of fake money every day (more on a streak). Invest it in real stocks. Your wins send this site's real ad money to charity.`,
        fine: 'Losing costs you nothing. Legal checked.',
        next: 'How do I win?',
      },
      {
        title: `Hold ${r.hold_hours} hours for ×10`,
        art: svg(`
          <line x1="24" y1="118" x2="256" y2="118" class="x-axis"/>
          <path d="M24 112 L256 26" class="x-ramp"/>
          <circle r="7" class="x-runner"><animateMotion dur="3.2s" repeatCount="indefinite" path="M24 112 L256 26"/></circle>
          <text x="20" y="136" class="x-small">buy: ×1</text><text x="256" y="136" text-anchor="end" class="x-small">${r.hold_hours}h: ×10</text>
          <circle cx="256" cy="26" r="9" class="x-gold"/>
          <text x="256" y="16" text-anchor="end" class="x-small">stock +1% → you +10%</text>`),
        body: `Pick a stock, crypto or fund and say how much. It rides the real market for ${r.hold_hours} hours, and the move is multiplied: the stock goes up 1%, you go up 10%. Down 1%, down 10%. Then it matures and you collect.`,
        fine: 'Sell early any time at a smaller multiplier. Crypto tops out at ×5.',
        next: 'And the charity part?',
      },
      {
        title: 'Wins hire lobbyists',
        art: svg(`
          ${bill(32, 70, 'hop h1')}${bill(56, 70, 'hop h2')}
          ${arrow(78, 102, 70)}
          <rect x="110" y="70" width="82" height="44" rx="3" class="x-desk"/>
          <text x="151" y="98" text-anchor="middle" class="x-desk-text">RECRUITER</text>
          ${suit(141, 34, '', 0.9)}
          ${arrow(196, 216, 70)}
          ${suit(224, 52, 'pop p1')}${suit(246, 52, 'pop p2')}`),
        body: `${pct}% of every win is tax. The tax hires lobbyists for your charity. Every quarter at Lobbyfest, the charity with the most lobbyists gets the biggest share of the real money.`,
        fine: r.demo ? 'The money will be real. The charities in this demo are not.' : 'Receipts are posted on the Lobby page.',
        next: 'Got it',
      },
      {
        title: 'Your first buy pays a bonus',
        art: svg(`
          ${miniTown()}
          <rect x="0" y="0" width="280" height="150" fill="#EDF1F2" opacity=".82"/>
          <rect x="96" y="40" width="88" height="56" rx="6" fill="#fff" stroke="#0F2430" stroke-width="2"/>
          <text x="140" y="76" text-anchor="middle" fill="#0F2430" font-size="22" font-weight="900">$${r.vest_amount || 40}K</text>
          <text x="140" y="122" text-anchor="middle" class="x-tag">from Mommy &amp; Daddy</text>`),
        body: `Make your first investment and Mommy & Daddy send $${r.vest_amount || 40}K, taxed like any win. That tax hires your first lobbyists, and they need somewhere to live. That's TrickleTown, on the other side of your coin. We'll show you around when you get there.`,
        fine: 'Nothing about this is normal. Everything about it is legal.',
        next: 'Start playing',
      },
    ];
  }

  function townDeck() {
    return [
      {
        kicker: 'Your first lobbyists moved in',
        title: 'Welcome to TrickleTown',
        art: svg(miniTown(`${suit(120, 72, '', 0.9)}<text x="140" y="140" text-anchor="middle" class="x-tag">the other side of your coin</text>`)),
        body: 'Your lobbyists live here, and you own the place. It has two scores. Profit: what the town adds to your allowance every day. Happiness: what each new lobbyist costs you, since happy towns hire cheap.',
        fine: 'Congratulations on becoming a landlord. It happens to the best of us.',
      },
      {
        title: 'Money, or people',
        art: svg(`
          <rect x="0" y="104" width="280" height="46" fill="#9BC48F"/>
          <rect x="34" y="56" width="80" height="48" fill="#8E2232"/><rect x="34" y="50" width="80" height="8" fill="#D4A72C"/>
          <text x="74" y="86" text-anchor="middle" fill="#F2D06B" font-size="20" font-weight="900">$ $ $</text>
          <text x="74" y="130" text-anchor="middle" class="x-tag up">+ profit</text>
          <rect x="168" y="58" width="76" height="46" fill="#fff" stroke="#8EA3AC"/>
          <rect x="200" y="62" width="12" height="26" fill="#2E9C72"/><rect x="193" y="69" width="26" height="12" fill="#2E9C72"/>
          <text x="206" y="130" text-anchor="middle" class="x-tag up">+ happiness</text>`),
        body: 'Two empty lots. Each offers three buildings: a casino or tenement makes profit and unhappy lobbyists; a clinic or co-op costs profit and makes them happy; one in the middle. Tap a lot to build.',
        fine: 'Every lot offers an extractive option, a compromise, and a decent one. We put them in that order for a reason.',
      },
      {
        title: 'Cards every day',
        art: `<div class="x-art x-duo">
          <div class="x-half preston">${window.Coin ? window.Coin.preston(64) : ''}<div class="x-bubble">A casino. Two casinos.</div></div>
          <div class="x-half dolores">${window.Coin ? window.Coin.dolores(64) : ''}<div class="x-bubble">They would like a park.</div></div>
        </div>`,
        body: 'Preston and Dolores bring a few cards a day. Preston\'s side pays; Dolores\'s side makes people happier. Pick one per card. Some choices come back around later; the card will say so.',
        fine: 'Unplayed cards expire at midnight. Built something? The residents notice when you skip a day.',
        next: 'Visit TrickleTown',
      },
    ];
  }

  let dlg, i = 0, list = [], current = null;

  function build() {
    dlg = document.createElement('dialog');
    dlg.className = 'sheet explainer';
    dlg.setAttribute('aria-label', 'How Trickle Down works');
    dlg.innerHTML = `
      <div class="sheet-body">
        <div class="x-head">
          <span class="x-brand">Trickle Down Holdings<br><span class="x-sub"></span></span>
          <button type="button" class="close" aria-label="Close">×</button>
        </div>
        <div class="x-stage" aria-live="polite"></div>
        <div class="x-dots" role="tablist"></div>
        <div class="x-nav">
          <button type="button" class="btn quiet" data-x="back">Back</button>
          <button type="button" class="btn primary" data-x="next">Next</button>
        </div>
        <div class="x-finale" hidden>
          <div class="x-finale-row">
            <button type="button" class="btn primary" data-finale="register">Create an account</button>
            <button type="button" class="btn primary" data-finale="guest">Play as a guest</button>
          </div>
          <button type="button" class="linkish center" data-finale="login">Already have an account? Sign in</button>
        </div>
      </div>`;
    document.body.appendChild(dlg);
    dlg.querySelector('.close').onclick = () => close(false);
    dlg.querySelector('[data-x="back"]').onclick = () => go(i - 1);
    dlg.querySelector('[data-x="next"]').onclick = () => (i === list.length - 1 ? close(true) : go(i + 1));
    dlg.querySelectorAll('[data-finale]').forEach((b) => {
      b.onclick = () => { const c = current, choice = b.dataset.finale; close(true); if (c && c.onFinale) c.onFinale(choice); };
    });
    dlg.addEventListener('click', (e) => { if (e.target === dlg) close(false); });
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(false); });
    dlg.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight') go(i + 1);
      if (e.key === 'ArrowLeft') go(i - 1);
    });
  }

  function go(n) {
    i = Math.max(0, Math.min(list.length - 1, n));
    const s = list[i];
    dlg.querySelector('.x-stage').innerHTML = `
      <div class="x-slide">
        ${s.art}
        ${s.kicker ? `<div class="x-step">${esc(s.kicker)}</div>` : ''}
        <h2>${esc(s.title)}</h2>
        <p class="x-body">${esc(s.body)}</p>
        <p class="x-fine">${esc(s.fine)}</p>
      </div>`;
    dlg.querySelector('.x-dots').innerHTML = list.map((_, k) => `<button type="button" role="tab" aria-selected="${k === i}" aria-label="Slide ${k + 1}" data-k="${k}"></button>`).join('');
    dlg.querySelectorAll('.x-dots button').forEach((b) => { b.onclick = () => go(Number(b.dataset.k)); });
    dlg.querySelector('[data-x="back"]').disabled = i === 0;
    dlg.querySelector('[data-x="next"]').textContent = s.next || 'Next';
    // Training taken before signing up ends in the three ways in, not "Start playing".
    const finale = !!(current && current.finale) && i === list.length - 1;
    dlg.querySelector('.x-nav').hidden = finale;
    dlg.querySelector('.x-finale').hidden = !finale;
  }

  function markSeen(deck) { try { localStorage.setItem(KEYS[deck], '1'); } catch (e) { /* private mode */ } }

  function close(done) {
    if (!current) return;
    const c = current;
    current = null;
    markSeen(c.deck);
    if (dlg && dlg.open) dlg.close();
    if (done && c.onDone) c.onDone();
    if (c.onClose) c.onClose();
  }

  function open({ deck = 'main', rules, onDone, onClose, finale = false, onFinale } = {}) {
    const r = Object.assign({ daily_base: 100, streak_bonus: 10, daily_cap: 200, tax_rate: 0.25, hold_hours: 24, demo: true }, rules || {});
    if (!dlg) build();
    if (current) close(false);
    current = { deck, onDone, onClose, finale, onFinale };
    list = deck === 'town' ? townDeck() : mainDeck(r);
    // The two tutorials must not look like the same one: a tester who just
    // unlocked the town should never think they're back at orientation.
    dlg.classList.toggle('deck-town', deck === 'town');
    dlg.querySelector('.x-sub').textContent = deck === 'town' ? 'TrickleTown Resident Services · part two' : 'Employee Training · New Associate Orientation';
    go(0);
    if (!dlg.open) dlg.showModal();
    dlg.querySelector('[data-x="next"]').focus();
  }

  function seen(deck = 'main') { try { return localStorage.getItem(KEYS[deck]) === '1'; } catch (e) { return false; } }
  function isOpen() { return !!current; }

  return { open, seen, isOpen };
})();
