// Trickle Down — front end. Plain JS, no build step.
(function () {
  'use strict';

  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
  const SITE = (window.TRICKLE_CONFIG.SITE_URL || location.origin).replace(/^https?:\/\//, '');
  const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const CHARITY_COLORS = ['#1879A0', '#2C9BC4', '#0F5873', '#63B6D3', '#1B6E8C', '#9ED3E4'];

  // While any popup is open, the page behind it is frozen in place: only the
  // popup scrolls. (Body fixed at its scroll offset; iOS ignores overflow
  // alone.) Unlocks synchronously on close() so a scrollIntoView right after
  // closing still works, and on the close event for Escape and form closes.
  (function lockScrollUnderPopups() {
    const root = document.documentElement;
    let y = 0;
    const lock = () => {
      if (root.classList.contains('popup-open')) return;
      y = window.scrollY;
      document.body.style.top = `-${y}px`;
      root.classList.add('popup-open');
    };
    const unlock = () => {
      if (!root.classList.contains('popup-open') || document.querySelector('dialog[open]')) return;
      root.classList.remove('popup-open');
      document.body.style.top = '';
      window.scrollTo(0, y);
    };
    const show = HTMLDialogElement.prototype.showModal;
    const close = HTMLDialogElement.prototype.close;
    HTMLDialogElement.prototype.showModal = function (...a) { lock(); try { return show.apply(this, a); } catch (e) { unlock(); throw e; } };
    HTMLDialogElement.prototype.close = function (...a) { const r = close.apply(this, a); unlock(); return r; };
    document.addEventListener('close', () => unlock(), true);
  })();

  const state = {
    me: null,            // response of GET /me
    assets: [],
    charities: [],
    selected: null,      // asset chosen for the slice
    quote: null,
    carve: 0,            // dollars being carved right now (0 = no slice)
    sell: null,          // position being cashed out
    flipped: false,      // which side of the coin is up
    authMode: 'login',
    tab: 'today',
    busy: false,
    grow: null,          // { id, t } animation of one wedge's size, t in 0..1
    flipTimer: null,
    assetSearch: false,  // the server searches a universe too big to ship
    assetCount: 0,
    found: new Map(),    // symbol -> asset, from search results, so selection works off-list
    ticker: null,        // the live-price loop: { timer, step, symbols }
    achShown: new Set(), // achievements already popped this page load
  };

  // --- formatting ----------------------------------------------------------------

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // Play money is shown in thousands: a unit is $1K, a thousand units is $1M,
  // one decimal at most. Under $0.1K it's shown in plain dollars ($40) rather
  // than rounding a real amount to nothing. Real stock prices use price().
  const fmt1 = (v) => { const r = Math.round(v * 10) / 10; return Number.isInteger(r) ? String(r) : r.toFixed(1); };
  const moneyParts = (n, opts = {}) => {
    if (n === null || n === undefined || Number.isNaN(n)) return null;
    const a = Math.abs(n), sign = n < 0 ? '-' : '';
    if (a === 0) return { sign, num: '0', unit: '' };
    if (a >= 1000) return { sign, num: fmt1(a / 1000), unit: 'M' };
    if (a < 0.1 && !opts.whole) return { sign, num: String(Math.round(a * 1000)), unit: '' };
    return { sign, num: opts.whole ? String(Math.round(a)) : fmt1(a), unit: 'K' };
  };
  const money = (n, opts = {}) => { const m = moneyParts(n, opts); return m ? `${m.sign}$${m.num}${m.unit}` : '—'; };
  const moneySplit = (n) => { const m = moneyParts(n) || { sign: '', num: '0', unit: '' }; return `${m.sign}<small>$</small>${esc(m.num)}${m.unit ? `<small>${m.unit}</small>` : ''}`; };
  const pct = (p, digits = 1) => {
    if (p === null || p === undefined || Number.isNaN(p)) return '—';
    const v = p * 100;
    return `${v > 0 ? '+' : ''}${v.toFixed(digits)}%`;
  };
  const dir = (p) => (p > 0 ? 'up' : p < 0 ? 'down' : '');
  // Real prices, in real dollars.
  const price = (p) => (p === null || p === undefined || Number.isNaN(p) ? '—' : p >= 1000 ? `$${Math.round(p).toLocaleString('en-US')}` : p >= 1 ? `$${p.toFixed(2)}` : `$${p.toPrecision(3)}`);
  const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
  const mult = (m) => `×${Number.isInteger(m) ? m : m.toFixed(1)}`;
  // The multipliers a ride off position p would run at: the new day starts
  // where this one ended and climbs by the asset's base multiplier, up to a cap.
  function rideMults(p) {
    const base = p.asset_type === 'crypto' ? 5 : 10;
    const steps = state.me && state.me.rules.ride_max_steps != null ? state.me.rules.ride_max_steps : 2;
    const cap = base * (1 + steps);
    const floor = Math.min(p.multiplier, cap);
    return { floor, ceiling: Math.min(floor + base, cap), capped: floor >= cap };
  }
  const shortDate = (iso) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

  // "3h ago", "25m ago", "2d ago"
  function ago(iso) {
    const s = Math.max(0, (Date.now() - new Date(iso)) / 1000);
    if (s < 90) return 'just now';
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
  }
  // "21h 12m", "48m", "ready"
  function left(matures_at) {
    const s = (new Date(matures_at) - Date.now()) / 1000;
    if (s <= 0) return 'ready';
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    return h > 0 ? `${h}h ${m}m` : `${Math.max(1, m)}m`;
  }
  function countdown(iso) {
    const ms = new Date(iso) - Date.now();
    if (ms <= 0) return 'any second now';
    const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000);
    return h > 0 ? `${h}h ${m}m` : `${Math.max(1, m)}m`;
  }
  // "64d 6h", "6h 12m", "12m"
  function untilLong(iso) {
    const ms = new Date(iso) - Date.now();
    if (ms <= 0) return 'any minute now';
    const d = Math.floor(ms / 86400000), h = Math.floor((ms % 86400000) / 3600000), m = Math.floor((ms % 3600000) / 60000);
    if (d > 0) return `${d}d ${h}h`;
    return h > 0 ? `${h}h ${m}m` : `${Math.max(1, m)}m`;
  }
  const festDate = (iso) => new Date(iso).toLocaleDateString('en-US', { month: 'long', day: 'numeric' });

  // Play-money tax hires lobbyists for a charity at a dollar a head. They are
  // not dollars, and the copy never pretends they are.
  const lobbyN = (n) => { const v = round2(n); return Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/0$/, ''); };
  const lobby = (n) => `${lobbyN(n)} lobbyist${round2(n) === 1 ? '' : 's'}`;

  // One lobbyist: suit, tie, briefcase. The fractional one is clipped from the
  // feet up, so a quarter of a lobbyist is a head and shoulders.
  const LOBBYIST = `<svg class="lobbyist" viewBox="0 0 20 40" aria-hidden="true">
      <circle cx="9" cy="5.5" r="4.5"/>
      <path d="M3 12 h12 l1.5 14 h-15 z"/>
      <path class="tie" d="M9 12 l1.6 0 l-0.3 9 l-0.5 1.4 l-0.5 -1.4 z"/>
      <rect x="4.5" y="26" width="4" height="13" rx="0.5"/>
      <rect x="9.5" y="26" width="4" height="13" rx="0.5"/>
      <rect class="case" x="15" y="21" width="5" height="7" rx="0.8"/>
    </svg>`;
  function lobbyists(n, { mini = false, max = 24 } = {}) {
    const whole = Math.floor(n + 1e-9), frac = round2(n - whole);
    let out = LOBBYIST.repeat(Math.min(whole, max));
    if (whole > max) out += `<span class="more">+${whole - max}</span>`;
    if (frac > 0) out += LOBBYIST.replace('class="lobbyist"', `class="lobbyist frac" style="clip-path: inset(0 0 ${Math.round((1 - frac) * 100)}% 0)"`);
    return `<span class="lobbyists ${mini ? 'mini' : ''}" role="img" aria-label="${esc(lobby(n))}">${out}</span>`;
  }
  // A dollar, same footprint as a lobbyist so one can become the other.
  const BILL = `<svg class="billsvg" viewBox="0 0 20 40" aria-hidden="true"><rect x="0.5" y="0.5" width="19" height="39" rx="2"/><rect x="3" y="3" width="14" height="34" rx="1" class="bill-inner"/><text x="10" y="25" text-anchor="middle" class="bill-text">$</text></svg>`;
  function billsRow(n, { max = 24 } = {}) {
    const whole = Math.floor(n + 1e-9), frac = round2(n - whole);
    let out = BILL.repeat(Math.min(whole, max));
    if (whole > max) out += `<span class="more">+${whole - max}</span>`;
    if (frac > 0) out += BILL.replace('class="billsvg"', `class="billsvg frac" style="clip-path: inset(0 0 ${Math.round((1 - frac) * 100)}% 0)"`);
    return `<span class="lobbyists" role="img" aria-label="${esc(money(n))}">${out}</span>`;
  }

  function toast(text, ms = 2800) {
    const el = $('#toast');
    el.textContent = text; el.hidden = false;
    clearTimeout(toast.t);
    toast.t = setTimeout(() => { el.hidden = true; }, ms);
  }

  // --- screens / routing ---------------------------------------------------------------

  function showScreen(name) {
    $$('.screen').forEach((s) => { s.hidden = s.id !== `screen-${name}`; });
    $$('#tabs a').forEach((a) => a.classList.toggle('active', a.dataset.tab === name));
    state.tab = name;
    window.scrollTo({ top: 0 });
  }

  const UNCONFIGURED = !API.demo && /YOUR-HEROKU-APP/.test((window.TRICKLE_CONFIG || {}).API_BASE || '');

  async function route() {
    const hash = (location.hash || '#today').slice(1);
    if (UNCONFIGURED) { showScreen('welcome'); renderUnconfigured(); return; }
    if (!API.token()) { showScreen('welcome'); renderWelcome(); return; }
    const name = ['today', 'trickle', 'leaders', 'how'].includes(hash) ? hash : 'today';
    const firstLoad = !state.me;
    if (firstLoad) { await loadMe(); if (!API.token()) return; }
    showScreen(name);
    if (name === 'today' && !firstLoad) loadMe();
    if (name === 'trickle') loadTrickle();
    if (name === 'leaders') loadLeaders();
    if (name === 'how') renderHow();
  }

  function setSignedIn(on) {
    $('#tabs').hidden = !on;
    $('#foot').hidden = !on;
    $('#masthead-day').hidden = !on;
    $('#btn-trophies').hidden = !on;
    scenery(on ? 'game' : 'landing');
  }

  // --- welcome ----------------------------------------------------------------------

  function renderUnconfigured() {
    setSignedIn(false);
    $('#screen-welcome').innerHTML = `
      <div class="welcome">
        <h1 class="hero">Not connected yet.</h1>
        <p>This copy of Trickle Down doesn't know where its backend lives. In <code>config.js</code>, set <code>API_BASE</code> to your Heroku app's URL (see DEPLOY.md), then reload.</p>
        <p class="muted">Want to see the game without a backend? <a href="?demo">Open the demo</a>: invented prices, made-up charities, nothing saved.</p>
      </div>`;
  }

  // Scenery behind the page: a faint rain of bills in both gutters, always;
  // on the landing page also a tilted heads coin with a sample portfolio on
  // the right and a tails village on the left; in the game, your own
  // lobbyists loitering at the bottom right instead. All inline SVG, so
  // nothing can fail to load; all decorative, hidden from assistive tech and
  // masked away from the text column.
  function scenery(mode) {
    const have = $('.landing-bg');
    if (have && have.dataset.mode === mode) { if (mode === 'game') sceneryCrowd(); return; }
    if (have) have.remove();
    if (mode === 'landing') landingArt(); else gameArt();
    document.body.classList.add('landing');
  }
  function sceneryCrowd() {
    const el = $('.landing-bg .bg-crowd');
    if (!el || !state.me) return;
    const n = Math.max(0, state.me.user.quarter_donated || 0);
    const key = String(Math.round(n * 100));
    if (el.dataset.n === key) return;
    el.dataset.n = key;
    el.innerHTML = n > 0 ? lobbyists(n, { max: 18 }) : '';
    const cap = $('.landing-bg .bg-ground .bg-cap');
    if (cap) cap.textContent = n > 0 ? `${lobby(n)}, loitering` : '';
  }
  function gameArt() {
    const bg = document.createElement('div');
    bg.className = 'landing-bg game';
    bg.dataset.mode = 'game';
    bg.setAttribute('aria-hidden', 'true');
    bg.innerHTML = `${rainSvg()}<div class="bg-ground"><div class="bg-crowd"></div><div class="bg-cap"></div></div>`;
    document.body.appendChild(bg);
    sceneryCrowd();
  }
  function rainSvg() {
    return `<svg class="bg-rain" xmlns="http://www.w3.org/2000/svg" width="100%" height="100%">
      <defs><pattern id="rain-p" width="150" height="190" patternUnits="userSpaceOnUse">
        <g transform="translate(18 12) rotate(-14)"><rect width="18" height="36" rx="2"/><text x="9" y="24" text-anchor="middle" font-size="13" font-weight="700">$</text></g>
        <g transform="translate(96 54) rotate(11)"><rect width="18" height="36" rx="2"/><text x="9" y="24" text-anchor="middle" font-size="13" font-weight="700">$</text></g>
        <g transform="translate(52 118) rotate(-5)"><rect width="18" height="36" rx="2"/><text x="9" y="24" text-anchor="middle" font-size="13" font-weight="700">$</text></g>
        <path transform="translate(118 140) scale(0.5)" d="M16 4 C16 11 7 15.5 7 21.5 a9 9 0 0 0 18 0 C25 15.5 16 11 16 4Z"/>
      </pattern></defs>
      <rect width="100%" height="100%" fill="url(#rain-p)"/>
    </svg>`;
  }
  function landingArt() {
    const sample = [
      { id: 1, symbol: 'NVDA', invested: 40, value: 54, swing_pct: 0.35, busted: false, matured: false },
      { id: 2, symbol: 'BTC', invested: 25, value: 27.5, swing_pct: 0.1, busted: false, matured: true },
      { id: 3, symbol: 'DOGE', invested: 15, value: 9, swing_pct: -0.4, busted: false, matured: false },
      { id: 4, symbol: 'KO', invested: 10, value: 10.2, swing_pct: 0.02, busted: false, matured: false },
    ];
    const strip = (svg) => svg.replace(/ tabindex="0"/g, '').replace(/ role="button"/g, '');
    const heads = strip(Coin.front({ positions: sample, cash: 30, preview: null, grow: null }));
    const town = { happiness: 72, plots: [{ slot: 'housing', key: 'coop' }, { slot: 'square', key: 'casino' }] };
    const tails = strip(Coin.village({ town, pop: 12, pending: 2 }));
    const bg = document.createElement('div');
    bg.className = 'landing-bg';
    bg.dataset.mode = 'landing';
    bg.setAttribute('aria-hidden', 'true');
    bg.innerHTML = `${rainSvg()}
      <div class="bg-coin bg-heads"><div class="bg-face">${heads}</div><div class="bg-cap">heads: the portfolio</div></div>
      <div class="bg-coin bg-tails"><div class="bg-face">${tails}</div><div class="bg-cap">tails: your lobbyists</div></div>
      <div class="bg-ground"><div class="bg-crowd">${lobbyists(9, { max: 9 })}</div></div>`;
    document.body.appendChild(bg);
  }

  function renderWelcome() {
    setSignedIn(false);
    $('#screen-welcome').innerHTML = `
      <div class="welcome">
        <h1 class="hero">Fake money. Real market. Real charity.</h1>
        <ul class="pitch">
          <li><b>$100K a day</b> of fake money. Put it on real stocks, hold 24 hours, and the move is multiplied ×10.</li>
          <li><b>Wins are taxed.</b> The tax hires lobbyists for the charity you pick.</li>
          <li><b>Every quarter</b> this site's real ad money goes to the charities with the most lobbyists.</li>
        </ul>
        <button class="training" id="btn-orient" type="button">
          <span class="training-tag">Step one</span>
          <span class="training-title">Take the employee training</span>
          <span class="training-sub">Four slides. Mandatory. Compensated in knowledge.</span>
        </button>
        <div class="ways-in">
          <button class="btn primary" id="btn-register">Create an account</button>
          <button class="btn primary" id="btn-guest">Play as a guest</button>
        </div>
        <button class="linkish center" id="btn-signin">Already have an account? Sign in</button>
      </div>`;
    $('#btn-orient').onclick = () => Explainer.open({ deck: 'main', finale: true, onFinale: welcomeFinale });
    $('#btn-guest').onclick = startGuest;
    $('#btn-register').onclick = () => openAuth('register');
    $('#btn-signin').onclick = () => openAuth('login');
  }

  // Training taken from the landing page ends in the three ways in.
  const welcomeFinale = (choice) => { if (choice === 'guest') startGuest(); else openAuth(choice); };

  async function startGuest() {
    if (state.busy) return;
    state.busy = true;
    try {
      const r = await API.post('/auth/guest');
      API.setToken(r.token);
      location.hash = '#today'; route();
    } catch (e) { toast(e.message, 4000); }
    finally { state.busy = false; }
  }

  // --- today: data ------------------------------------------------------------------

  async function loadMe() {
    try {
      const me = await API.get('/me');
      state.me = me;
      // The server hands out a fresh token when the current one is past half
      // its life, so a guest who keeps showing up is never signed out.
      if (me.token && !API.demo) API.setToken(me.token);
      setSignedIn(true);
      renderToday();
      renderTrophyCount();
      if (me.fresh_cards && me.fresh_cards.length) setTimeout(() => announceCards(me.fresh_cards), me.allowance ? 5400 : 800);
      if (!state.justBought) maybeAchievement(me.allowance && !REDUCED ? 2600 : 900);
      if (!Explainer.seen('main') && !state.oriented) {
        state.oriented = true;
        setTimeout(() => Explainer.open({ deck: 'main', rules: me.rules }), me.allowance && !REDUCED ? 1700 : 300);
      }
      if (me.allowance) {
        tossCoin();
        const a = me.allowance;
        const ti = a.town_income || 0;
        const village = ti ? ` (${money(a.base != null ? a.base : a.amount - ti, { whole: true })} stipend ${ti > 0 ? '+' : '−'} ${money(Math.abs(ti), { whole: true })} ${ti > 0 ? 'from' : 'upkeep for'} TrickleTown)` : '';
        const quit = '';
        setTimeout(() => toast(`${me.user.streak > 1 ? `Day ${me.user.streak} of your streak: ` : ''}${money(a.amount, { whole: true })} landed on the coin${village}.${quit}`, 4200), REDUCED ? 0 : 1100);
      }
    } catch (e) {
      if (e.status === 401) { API.setToken(null); route(); return; }
      toast(e.message);
    }
  }

  async function ensureAssets() {
    if (!state.assets.length) { const r = await API.get('/assets'); state.assets = r.assets; state.assetSearch = !!r.search; state.assetCount = r.count || r.assets.length; }
    await ensureCharities();
  }
  async function ensureCharities() {
    if (!state.charities.length) state.charities = (await API.get('/charities')).charities;
  }

  function renderMasthead() {
    const { day, user } = state.me;
    $('#day-number').textContent = `Day ${day.number}`;
    $('#day-countdown').textContent = `New money in ${countdown(day.resets_at)}`;
    $('#foot-user').textContent = user.is_guest ? `Playing as ${user.username}` : `Signed in as ${user.username}`;
    $('#btn-claim').hidden = !user.is_guest;
  }

  // --- today: the coin ------------------------------------------------------------------

  function totalInPlay(me) {
    return me.user.cash + me.positions.reduce((s, p) => s + (p.quote_error ? p.invested : p.value), 0);
  }

  function coinFrontMarkup() {
    const me = state.me;
    const svg = Coin.front({ positions: me.positions, cash: me.user.cash, preview: state.carve > 0 ? { amount: state.carve } : null, grow: state.grow });
    const total = totalInPlay(me);
    let center;
    if (state.carve > 0) {
      center = `<b>${moneySplit(state.carve)}</b><span>slice, ${Math.round(state.carve / me.user.cash * 100)}% of your bills</span>`;
    } else if (me.user.cash >= 0.01) {
      center = `<b>${moneySplit(me.user.cash)}</b><span><span class="free">free to spend</span><br>${money(total)} in play</span>`;
    } else if (total > 0) {
      center = `<b>${moneySplit(total)}</b><span>in play<br>nothing free to spend</span>`;
    } else {
      center = `<b><small>$</small>0</b><span>Come back tomorrow.</span>`;
    }
    return `${svg}<div class="coin-center">${center}</div><button class="coin-tap" type="button" aria-label="Flip the coin"></button>`;
  }

  function pendingIssues() {
    const t = state.me && state.me.town;
    return t && t.unlocked ? t.issues.filter((i) => !i.chosen).length : 0;
  }

  // The TrickleTown tour, once, the first time the town is open and nobody's
  // in the middle of another tutorial.
  function maybeTownIntro(delay = 0) {
    setTimeout(() => {
      const me = state.me;
      if (!me || !me.town || !me.town.unlocked || Explainer.seen('town') || Explainer.isOpen()) return;
      if (state.tab !== 'today' || !state.flipped || $('#dlg-hire').open || $('#dlg-site').open || $('#dlg-advisors').open) return;
      Explainer.open({ deck: 'town', onDone: () => { if (!state.flipped) flip(true); setTimeout(() => { const a = $('#agenda'); if (a) a.scrollIntoView({ behavior: REDUCED ? 'auto' : 'smooth', block: 'start' }); }, 500); } });
    }, delay);
  }

  function coinBackMarkup() {
    const me = state.me;
    const q = Math.max(0, me.user.quarter_donated || 0);
    const svg = Coin.village({ town: me.town, pop: round2(q), pending: pendingIssues(), locked: !me.town.unlocked, progress: me.user.total_donated });
    if (!me.town.unlocked) return `${svg}<button class="coin-tap village-tap" type="button" aria-label="Flip the coin back"></button>`;
    // Tap a building for its Site Office, an advisor for Town Hall; anywhere else flips back.
    const plot = (slot) => me.town.plots.find((p) => p.slot === slot);
    const label = (slot) => { const p = plot(slot); return p && p.building ? `${p.building.name}: open the Site Office` : `Empty lot (${p ? p.label : slot}): build something`; };
    return `${svg}<button class="coin-tap village-tap" type="button" aria-label="Flip the coin back"></button>
      <button type="button" class="coin-hit site-housing" data-coin-site="housing" aria-label="${esc(label('housing'))}"></button>
      <button type="button" class="coin-hit site-square" data-coin-site="square" aria-label="${esc(label('square'))}"></button>
      ${pendingIssues() ? '<button type="button" class="coin-hit adv-a1" data-coin-adv aria-label="Speak with your advisors"></button><button type="button" class="coin-hit adv-a2" data-coin-adv aria-label="Speak with your advisors"></button>' : ''}`;
  }

  // Redraw only the coin faces. Keeps the carve panel (and its focus) intact.
  function paintCoin() {
    const front = $('#coin-front'), back = $('#coin-back');
    if (!front) return;
    front.innerHTML = coinFrontMarkup();
    back.innerHTML = coinBackMarkup();
    wireCoin();
  }

  function tipFor(p) {
    const head = `<b>${esc(p.symbol)}</b> ${esc(p.name)}`;
    if (p.quote_error) return `${head}<br>${money(p.invested)} in. Price unavailable right now.`;
    if (p.busted) return `${head}<br>${money(p.invested)} in → <span class="tip-money">$0</span><br>${esc(p.name)} fell ${pct(Math.abs(p.real_pct))} at ${mult(p.multiplier_now)}. It's gone.`;
    const line2 = `${money(p.invested)} in → <span class="tip-money">${money(p.value)}</span> <span class="${dir(p.swing_pct)}">${pct(p.swing_pct, 0)}</span>`;
    const line3 = `real ${pct(p.real_pct)} at ${mult(p.multiplier_now)}`;
    const line4 = p.matured
      ? `<span class="ready">Matured. Collect it, or let it ride.</span>`
      : `<span class="time">${left(p.matures_at)} to maturity, when it hits ${mult(p.multiplier)} and freezes.</span>`;
    const ride = p.ride_count > 0 ? `<br><span class="time">Riding ×${p.ride_count}, ${mult(p.mult_floor)} → ${mult(p.multiplier)}, started with ${money(p.origin_invested)}.</span>` : '';
    return `${head}<br>${line2}<br>${line3}<br>${line4}${ride}`;
  }

  function showTip(html, ev) {
    const stage = $('.coin-stage'); let tip = $('#coin-tip');
    if (!stage) return;
    if (!tip) { tip = document.createElement('div'); tip.id = 'coin-tip'; tip.className = 'coin-tip'; stage.appendChild(tip); }
    tip.innerHTML = html;
    const r = stage.getBoundingClientRect();
    tip.style.left = `${Math.max(100, Math.min(r.width - 100, ev.clientX - r.left))}px`;
    tip.style.top = `${ev.clientY - r.top}px`;
    tip.hidden = false;
  }
  function hideTip() { const t = $('#coin-tip'); if (t) t.hidden = true; }

  function wireCoin() {
    $$('.coin-tap').forEach((b) => { b.onclick = () => flip(); });
    $$('[data-coin-site]').forEach((b) => { b.onclick = (e) => { e.stopPropagation(); openSite(b.dataset.coinSite); }; });
    $$('[data-coin-adv]').forEach((b) => { b.onclick = (e) => { e.stopPropagation(); openAdvisors(); }; });
    $$('.wedge[data-id]').forEach((w) => {
      const p = () => state.me.positions.find((x) => x.id === Number(w.dataset.id));
      w.onclick = () => { hideTip(); openSell(Number(w.dataset.id)); };
      w.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openSell(Number(w.dataset.id)); } };
      w.onpointerenter = (e) => { if (e.pointerType === 'mouse' && p()) showTip(tipFor(p()), e); };
      w.onpointermove = (e) => { if (e.pointerType === 'mouse' && p()) showTip(tipFor(p()), e); };
      w.onpointerleave = hideTip;
    });
    $$('.v-advocate').forEach((g) => { g.style.cursor = 'pointer'; g.onclick = (e) => { e.stopPropagation(); openAdvisors(); }; });
    $$('.v-site').forEach((g) => { g.style.cursor = 'pointer'; g.onclick = (e) => { e.stopPropagation(); if (state.me.town.unlocked) openSite(g.dataset.site); }; });
    const cash = $('.cash-sector');
    if (cash) {
      cash.onclick = () => { hideTip(); const i = $('#carve-search'); const u = $('#carve-usd'); if (u && !u.closest('[hidden]')) { u.focus(); u.select(); } else if (i) i.focus(); };
      cash.onpointerenter = (e) => { if (e.pointerType === 'mouse') showTip(`<b>${esc(money(state.me.user.cash))}</b> free to spend<br><span class="time">Pick something below and carve a slice.</span>`, e); };
      cash.onpointermove = (e) => { if (e.pointerType === 'mouse') showTip(`<b>${esc(money(state.me.user.cash))}</b> free to spend<br><span class="time">Pick something below and carve a slice.</span>`, e); };
      cash.onpointerleave = hideTip;
    }
  }

  // The two sides of the coin, named. Tapping a side flips to it. The side
  // you're not on carries id="btn-flip" so older code and tests that "flip"
  // keep working.
  function captionMarkup() {
    const me = state.me;
    const n = pendingIssues();
    const locked = me && me.town && !me.town.unlocked;
    const tab = (side, label, extra = '') => {
      const on = state.flipped === (side === 'back');
      return `<button type="button" role="tab" aria-selected="${on}" class="side-tab ${on ? 'on' : ''}" data-side="${side}" ${on ? '' : 'id="btn-flip"'}>${label}${extra}</button>`;
    };
    const townExtra = locked ? ' <span class="side-lock" title="Opens with your first lobbyist">🔒</span>'
      : n ? ` <span class="side-badge">${n}</span>` : '';
    return `<div class="side-switch" role="tablist" aria-label="Which side of the coin">
      ${tab('front', 'Portfolio')}
      ${tab('back', 'TrickleTown', townExtra)}
    </div>
    <div class="side-hint muted small">${locked ? 'TrickleTown opens when you hire your first lobbyist.' : state.flipped ? 'Where your lobbyists live.' : n ? `${n} card${n === 1 ? '' : 's'} waiting in TrickleTown.` : ''}</div>`;
  }
  function wireCaption() {
    $$('.side-tab').forEach((b) => { b.onclick = () => { const to = b.dataset.side === 'back'; if (to !== state.flipped) flip(to); }; });
  }

  function flip(to) {
    clearTimeout(state.flipTimer);
    state.flipped = to === undefined ? !state.flipped : to;
    const coin = $('#coin');
    if (coin) coin.classList.toggle('flipped', state.flipped);
    const cap = $('.coin-caption');
    if (cap) { cap.innerHTML = captionMarkup(); wireCaption(); }
    hideTip();
    renderUnder();
    // The first visit to an open village gets the tour, after the flip lands.
    if (state.flipped && !state.ceremony && state.me && state.me.town && state.me.town.unlocked && !Explainer.seen('town')) maybeTownIntro(REDUCED ? 100 : 750);
  }

  // The day's first load: the coin is tossed in and lands.
  function tossCoin() {
    const coin = $('#coin');
    if (!coin || REDUCED) return;
    coin.classList.remove('landing');
    void coin.offsetWidth; // restart the animation if it already ran
    coin.classList.add('landing');
    coin.addEventListener('animationend', () => coin.classList.remove('landing'), { once: true });
  }

  // Animate one wedge from t0 to t1 over ms, then settle.
  function animateWedge(id, t0, t1, ms = 480) {
    if (REDUCED) { state.grow = null; paintCoin(); return Promise.resolve(); }
    return new Promise((resolve) => {
      const start = performance.now();
      const step = (now) => {
        const k = Math.min(1, (now - start) / ms);
        const e = 1 - Math.pow(1 - k, 3);
        state.grow = { id, t: t0 + (t1 - t0) * e };
        paintCoin();
        if (k < 1) requestAnimationFrame(step); else { state.grow = null; paintCoin(); resolve(); }
      };
      requestAnimationFrame(step);
    });
  }

  // --- today: layout ----------------------------------------------------------------------

  function renderToday() {
    tickerStart(state.justBought); state.justBought = false;
    sceneryCrowd();
    const me = state.me;
    if (!me) return;
    renderMasthead();
    if (state.carve > me.user.cash) state.carve = 0;

    $('#screen-today').innerHTML = `
      <div class="coin-stage">
        <div class="coin ${state.flipped ? 'flipped' : ''}" id="coin">
          <div class="coin-inner">
            <div class="coin-face front" id="coin-front"></div>
            <div class="coin-face back" id="coin-back"></div>
          </div>
        </div>
        <div class="coin-caption">${captionMarkup()}</div>
      </div>
      <div id="under"></div>`;
    paintCoin();
    wireCaption();
    renderUnder();
  }

  function renderUnder() {
    const el = $('#under');
    if (!el) return;
    el.innerHTML = `<div class="under">${state.flipped ? backMarkup() : frontMarkup()}</div>`;
    if (state.flipped) wireBack(); else wireFront();
  }

  // Front: pick → amount → buy, then the legend, crowd, share.
  function frontMarkup() {
    const me = state.me;
    const { user, positions, rules } = me;
    const canCarve = user.cash >= 0.01;
    const ready = positions.filter((p) => p.matured && !p.quote_error).length;
    const nextMoney = money(Math.min(rules.daily_cap, rules.daily_base + rules.streak_bonus * user.streak), { whole: true });
    const head = `
      <div class="side-head">
        <h2>Portfolio</h2>
        <span class="muted">${money(user.cash)} free · ${nextMoney} tomorrow${user.streak > 1 ? ` · ${user.streak}-day streak` : ''}</span>
      </div>`;
    const firstTime = isFirstTime(me);
    const fb = achOf(me, 'first_buy');
    const guide = firstTime ? `
      <div class="first-steps" id="first-steps">
        <div class="fs-head"><b>Your first buy</b><span>Three taps.</span></div>
        <ol>
          <li data-step="1"><b>Pick something.</b> A company, a ticker, or a coin.</li>
          <li data-step="2"><b>Say how much.</b> Any slice of your ${money(user.cash)}.</li>
          <li data-step="3"><b>Buy.</b> It rides the real market for ${me.rules.hold_hours} hours.</li>
        </ol>
        <p class="fs-gift">🏆 Your first buy unlocks an achievement and a <b>${money(fb ? fb.gift : 40)} bonus</b> from Mommy &amp; Daddy.</p>
      </div>` : '';
    const carve = canCarve ? `
      <section class="carve">
        <h2>Buy</h2>
        ${guide}
        <div class="picker" id="picker">
          <div class="picked" id="picked" hidden></div>
          <input type="search" id="carve-search" placeholder="Nvidia, BTC, gold, the S&amp;P…" autocomplete="off" spellcheck="false" aria-label="Search for something to buy">
          <ul class="asset-list" id="asset-list" role="listbox" hidden></ul>
        </div>
        <div class="amount-zone" id="amount-zone" hidden>
          <div class="amount-row"><span class="amount-prefix">$</span><input id="carve-usd" type="number" min="0.01" max="${user.cash}" step="0.01" inputmode="decimal" placeholder="0.0" aria-label="Amount in thousands of dollars"><span class="amount-suffix">K</span></div>
          <div class="chips" id="carve-chips">
            <button type="button" data-pct="10">10%</button>
            <button type="button" data-pct="25">25%</button>
            <button type="button" data-pct="50">50%</button>
            <button type="button" data-pct="100">All of it</button>
          </div>
        </div>
        <p class="form-error" id="carve-error" hidden></p>
        <button type="button" class="btn primary wide" id="carve-buy" disabled>Pick something first</button>
      </section>` : `
      <section class="all-in">
        <b>All in.</b>
        <span class="muted">${ready ? `${ready} position${ready === 1 ? ' is' : 's are'} ready to collect.` : 'New money tomorrow.'}</span>
      </section>`;

    const legend = positions.length ? `
      <section class="legend">
        <h2>On the coin <span class="muted">${positions.length} position${positions.length === 1 ? '' : 's'}${ready ? ` · ${ready} ready` : ''}</span></h2>
        <ul class="positions">${positions.map(positionRow).join('')}</ul>
      </section>` : '';

    return `${head}${todoStrip()}${carve}${legend}${crowdStrip(me.crowd)}
      <div class="row-actions">
        <button class="btn quiet small" id="btn-share">Share today</button>
      </div>`;
  }

  // What's worth doing right now, in one glance: collect, play cards, invest,
  // build. When it's all done it says so, and when the next thing lands.
  function todoStrip() {
    const me = state.me;
    if (isFirstTime(me)) return ''; // the first-investment guide is the to-do
    const items = [];
    const ready = me.positions.filter((p) => p.matured && !p.quote_error && !p.busted);
    const buried = me.positions.filter((p) => p.matured && p.busted);
    const town = me.town;
    // Earned, but the popup was closed (or the tab was): the gift is still waiting.
    for (const key of unclaimedKeys(me)) { const a = achOf(me, key); items.push({ k: 'gift', id: key, text: `🏆 <b>${esc(a.title)}</b>: ${esc(a.from)} sent ${money(a.gift, { whole: true })}. Open it` }); }
    if (ready.length) items.push({ k: 'collect', id: ready[0].id, text: ready.length === 1 ? `Collect <b>${esc(ready[0].symbol)}</b>, ready at ${pct(ready[0].swing_pct, 0)}` : `Collect <b>${ready.length} matured</b> positions` });
    if (buried.length) items.push({ k: 'collect', id: buried[0].id, text: `Bury <b>${esc(buried[0].symbol)}</b>. It's gone.` });
    const cards = pendingIssues();
    if (town && town.unlocked && cards) items.push({ k: 'cards', text: `Play <b>${cards} card${cards === 1 ? '' : 's'}</b> at TrickleTown Hall` });
    if (me.user.cash >= 1 && !isFirstTime(me)) items.push({ k: 'invest', text: `Invest the <b>${money(me.user.cash)}</b> sitting on the coin` });
    if (town && town.unlocked) {
      const empty = town.plots.find((pl) => !pl.building);
      if (empty) { const cheapest = Math.min(...empty.options.map((o) => o.cost)); items.push({ k: 'site', slot: empty.slot, text: affords(me.user.cash, cheapest) ? `Build on the empty <b>${esc(empty.label.toLowerCase())}</b> lot, from ${money(cheapest, { whole: true })}` : `Save up for the empty <b>${esc(empty.label.toLowerCase())}</b> lot (from ${money(cheapest, { whole: true })})` }); }
      const prop = town.plots.find((pl) => pl.building && pl.proposals);
      if (prop) items.push({ k: 'site', slot: prop.slot, text: `Hear <b>${prop.proposals} upgrade proposal${prop.proposals === 1 ? '' : 's'}</b> at ${esc(prop.building.name)}` });
    }
    if (!items.length) {
      const live = me.positions.filter((p) => !p.matured);
      const soonest = live.length ? live.reduce((a, b) => (new Date(a.matures_at) < new Date(b.matures_at) ? a : b)) : null;
      return `<div class="todo done"><b>All done for today.</b> <span>${soonest ? `${esc(soonest.symbol)} matures in <span data-left="${esc(soonest.matures_at)}">${left(soonest.matures_at)}</span>; ` : ''}new money in <span data-countdown>${countdown(me.day.resets_at)}</span>.</span></div>`;
    }
    return `<div class="todo"><b>To do</b><ul>${items.map((it, i) => `<li><button type="button" class="linkish" data-todo="${esc(it.k)}" data-id="${it.id || ''}" data-slot="${it.slot || ''}">${it.text}</button></li>`).join('')}</ul></div>`;
  }

  function positionRow(p) {
    const cls = ['position'];
    if (p.quote_error) cls.push('stale');
    else if (p.busted) cls.push('busted');
    else cls.push(dir(p.swing_pct));
    if (p.matured) cls.push('matured');
    const opened = new Date(p.opened_at).getTime(), matures = new Date(p.matures_at).getTime();
    const k = p.matured ? 1 : Math.max(0, Math.min(1, (Date.now() - opened) / Math.max(1, matures - opened)));
    const riding = p.ride_count > 0 ? `<span class="tag">Riding ×${p.ride_count}</span>` : '';
    let value, move, action;
    if (p.quote_error) {
      value = `${money(p.invested)} → <b>?</b>`;
      move = `${riding}Price unavailable right now.`;
      action = `<button class="btn small" disabled>Sell</button>`;
    } else if (p.busted) {
      value = `${money(p.invested)} → <b>${money(0)}</b>`;
      move = `${riding}Fell ${pct(Math.abs(p.real_pct))} at ${mult(p.multiplier_now)}. Gone.`;
      action = `<button class="btn small" data-sell="${p.id}">Bury it</button>`;
    } else if (p.matured) {
      value = `${money(p.invested)} → <b>${money(p.value)}</b> <span class="yours ${dir(p.swing_pct)}">${pct(p.swing_pct, 0)}</span>`;
      move = `${riding}<span class="ready">Matured at ${mult(p.multiplier)}.</span> Collect it, or let it ride.${p.matured_late ? ' <span class="muted">(Froze at the next price seen after its 24 hours.)</span>' : ''}`;
      action = `<button class="btn small primary" data-sell="${p.id}">Collect</button> <button class="btn small" data-ride="${p.id}">Ride</button>`;
    } else {
      value = `${money(p.invested)} → <b>${money(p.value)}</b> <span class="yours ${dir(p.swing_pct)}">${pct(p.swing_pct, 0)}</span>`;
      move = `${riding}Real move ${pct(p.real_pct, Math.abs(p.real_pct) < 0.01 ? 2 : 1)}, at ${mult(p.multiplier_now)} now. <span class="time">${mult(p.multiplier)} in <span data-left="${esc(p.matures_at)}">${left(p.matures_at)}</span>.</span>${p.deferred_tax > 0 ? ` <span class="muted">Early sale owes ${money(p.deferred_tax)} ride tax.</span>` : ''}`;
      action = `<button class="btn small" data-sell="${p.id}">Sell early</button>`;
    }
    return `
      <li class="${cls.join(' ')}" data-id="${p.id}">
        <span class="swatch"></span>
        <div class="ticker"><b>${esc(p.symbol)}</b><span>${esc(p.name)}</span></div>
        <div class="value">${value}</div>
        <div class="move">${move}</div>
        <div class="action">${action}</div>
        <span class="hold-bar" aria-hidden="true"><i style="--w:${Math.round(k * 100)}%"></i></span>
      </li>`;
  }

  function crowdStrip(crowd) {
    if (!crowd || !crowd.buys) return `<p class="muted" style="font-size:14px">Nobody has bought anything yet today. First mover.</p>`;
    const total = crowd.buys;
    const friends = (crowd.friends || []).filter((f) => f.symbols && f.symbols.length);
    const friendLine = friends.length
      ? `<p class="muted crowd-friends" style="font-size:14px">${friends.slice(0, 4).map((f) => `<a href="#" class="player-link" data-player="${esc(f.username)}">${esc(f.username)}</a> bought ${f.symbols.map((s) => `<b>${esc(s)}</b>`).join(', ')}`).join('; ')}${friends.length > 4 ? `; and ${friends.length - 4} more` : ''}.</p>`
      : '';
    return `<p class="muted crowd-line">Today's buys, ${crowd.players} player${crowd.players === 1 ? '' : 's'}: ${crowd.picks.map((c) => `<b>${esc(c.symbol)}</b> ${Math.round(c.buys / total * 100)}%`).join(' · ')}.</p>${friendLine}`;
  }

  // --- The live ticker -------------------------------------------------------------
  //
  // Right after a buy you want to see the thing move. The server's quote
  // cache is a minute; this loop asks for fresher quotes (?fresh=1, up to 4s
  // old) every 3 seconds at first, then backs off to once a minute while the
  // page stays open, and starts over fast on the next buy. Values are
  // recomputed here with the same formula the server uses, so the coin and
  // the rows update without a full reload.
  const TICKER_STEPS = [3000, 3000, 3000, 3000, 5000, 5000, 5000, 8000, 8000, 12000, 15000, 20000, 30000, 45000, 60000];

  function valueLive(p, px) {
    const opened = new Date(p.opened_at).getTime(), matures = new Date(p.matures_at).getTime();
    const k = Math.max(0, Math.min(1, (Date.now() - opened) / Math.max(1, matures - opened)));
    const floor = Math.min(p.mult_floor != null ? p.mult_floor : 1, p.multiplier);
    const m = floor + (p.multiplier - floor) * k;
    const real = (px - p.entry_price) / p.entry_price;
    const swing = m * real;
    const raw = p.invested * (1 + swing);
    const value = round2(Math.max(0, raw));
    const profit = round2(value - p.invested);
    const rate = state.me.rules.tax_rate;
    const own = profit > 0 ? round2(profit * rate) : 0;
    const due = round2(Math.min(Math.max(0, p.deferred_tax || 0), Math.max(0, value - own)));
    const tax = round2(own + due);
    return { price: px, real_pct: real, swing_pct: Math.max(-1, swing), multiplier_now: Math.round(m * 100) / 100, value, busted: raw <= 0,
      preview: { profit, tax, deferred_tax: due, net: round2(value - tax), tier: p.preview ? p.preview.tier : '' } };
  }

  function tickerStart(fast = false) {
    tickerStop();
    if (!state.me || API.demo) return;
    const symbols = [...new Set(state.me.positions.filter((p) => !p.matured && !p.quote_error).map((p) => p.symbol))];
    if (!symbols.length) return;
    state.ticker = { symbols, step: fast ? 0 : 6, timer: null };
    tickerSchedule();
  }
  function tickerStop() { if (state.ticker && state.ticker.timer) clearTimeout(state.ticker.timer); state.ticker = null; }
  function tickerSchedule() {
    const t = state.ticker; if (!t) return;
    t.timer = setTimeout(tickerTick, TICKER_STEPS[Math.min(t.step, TICKER_STEPS.length - 1)]);
  }
  async function tickerTick() {
    const t = state.ticker;
    if (!t || !state.me || state.tab !== 'today' || document.visibilityState !== 'visible') { if (t) tickerSchedule(); return; }
    try {
      const r = await API.get(`/quotes?symbols=${encodeURIComponent(t.symbols.join(','))}&fresh=1`);
      let changed = false;
      for (const p of state.me.positions) {
        const q = r.quotes[p.symbol];
        if (p.matured || !q || !(q.price > 0)) continue;
        const live = valueLive(p, q.price);
        if (live.value !== p.value || live.price !== p.price) changed = true;
        Object.assign(p, live);
      }
      if (changed && !state.flipped && !$('#dlg-sell').open) {
        paintCoin();
        for (const p of state.me.positions) {
          const row = $(`.position[data-id="${p.id}"]`);
          if (!row || p.matured) continue;
          const fresh = document.createElement('div'); fresh.innerHTML = positionRow(p);
          const next = fresh.firstElementChild;
          row.className = next.className;
          row.querySelector('.value').innerHTML = next.querySelector('.value').innerHTML;
          row.querySelector('.move').innerHTML = next.querySelector('.move').innerHTML;
        }
      }
    } catch (e) {
      // An older backend without /quotes: stand down instead of retrying.
      if (e && e.status === 404) { tickerStop(); return; }
    }
    if (state.ticker === t) { t.step++; tickerSchedule(); }
  }

  // Refresh the "3h ago" / "21h 12m" bits without rebuilding the panel.
  function tickTimes() {
    $$('[data-ago]').forEach((el) => { el.textContent = ago(el.dataset.ago); });
    $$('[data-left]').forEach((el) => { el.textContent = left(el.dataset.left); });
    $$('[data-fest]').forEach((el) => { el.textContent = untilLong(el.dataset.fest); });
  }

  function wireFront() {
    $$('[data-sell]').forEach((b) => { b.onclick = () => openSell(Number(b.dataset.sell)); });
    $$('[data-ride]').forEach((b) => { b.onclick = () => openSell(Number(b.dataset.ride), { ride: true }); });
    $$('[data-player]').forEach((a) => { a.onclick = (ev) => { ev.preventDefault(); openPlayer(a.dataset.player); }; });
    $$('[data-todo]').forEach((b) => {
      b.onclick = () => {
        const k = b.dataset.todo;
        if (k === 'collect') openSell(Number(b.dataset.id));
        else if (k === 'gift') openAchievement(b.dataset.id);
        else if (k === 'cards') { flip(true); if (Explainer.seen('town')) setTimeout(() => openAdvisors(), REDUCED ? 50 : 700); }
        else if (k === 'invest') { const sch = $('#carve-search'); if (sch) { sch.scrollIntoView({ behavior: REDUCED ? 'auto' : 'smooth', block: 'center' }); sch.focus(); } }
        else if (k === 'site') { flip(true); if (Explainer.seen('town')) setTimeout(() => openSite(b.dataset.slot), REDUCED ? 50 : 700); }
      };
    });
    $('#btn-share').onclick = share;
    const search = $('#carve-search');
    if (!search) return;
    const list = $('#asset-list'), usd = $('#carve-usd');
    const cash = state.me.user.cash;

    const setCarve = (dollars, fromInput) => {
      const d = round2(Math.max(0, Math.min(cash, Number(dollars) || 0)));
      state.carve = d;
      if (!fromInput) usd.value = d > 0 ? d : '';
      $$('#carve-chips button').forEach((b) => b.classList.toggle('on', d > 0 && Math.round(d / cash * 100) === Number(b.dataset.pct)));
      paintCoin();
      updateBuyButton();
    };
    usd.addEventListener('input', () => setCarve(usd.value, true));
    $$('#carve-chips button').forEach((b) => {
      b.onclick = () => { setCarve(Number(b.dataset.pct) === 100 ? cash : cash * Number(b.dataset.pct) / 100); usd.focus(); };
    });

    let searchTimer = null, searchSeq = 0;
    const openList = () => {
      list.hidden = false;
      const q = search.value.trim();
      if (!state.assetSearch || !q) { renderAssetList(q); return; }
      // Server search: the universe is thousands of names. Debounced, and a
      // late answer to an older keystroke is ignored.
      renderAssetList(q, state.lastSearch && state.lastSearch.q === q ? state.lastSearch.assets : null);
      clearTimeout(searchTimer);
      const seq = ++searchSeq;
      searchTimer = setTimeout(async () => {
        try {
          const r = await API.get(`/assets/search?q=${encodeURIComponent(q)}`);
          if (seq !== searchSeq || search.value.trim() !== q) return;
          r.assets.forEach((a) => state.found.set(a.symbol, a));
          state.lastSearch = { q, assets: r.assets };
          if (!list.hidden) renderAssetList(q, r.assets);
        } catch (e) { /* keep whatever is showing */ }
      }, 160);
    };
    search.addEventListener('focus', openList);
    search.addEventListener('input', openList);
    search.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') list.hidden = true;
      if (e.key === 'Enter') { const first = $('li[data-symbol]', list); if (first) { e.preventDefault(); selectAsset(first.dataset.symbol); } }
    });
    search.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== search) list.hidden = true; }, 150));
    $('#carve-buy').onclick = submitBuy;

    ensureAssets().then(() => { if (state.selected) showPicked(); }).catch((e) => toast(e.message));
    // Carry an in-progress slice across a refresh.
    if (state.selected) showPicked();
    if (state.carve > 0) setCarve(state.carve);
    guideStep();
  }

  const moodChip = (a) => (a.mood ? `<span class="mood ${esc(a.mood)}">${esc(a.mood)} ${mult(a.multiplier)}</span>` : `<span class="mood plain">${a.kind === 'etf' ? 'ETF ' : a.type === 'crypto' ? 'Crypto ' : ''}${mult(a.multiplier)}</span>`);

  // results: a server search's answer, or null to filter the featured list locally.
  function renderAssetList(q, results = null) {
    const el = $('#asset-list');
    if (!el) return;
    const needle = q.trim().toLowerCase();
    let list;
    if (results) list = results;
    else if (!needle) list = state.assets;
    else list = state.assets.filter((a) => a.symbol.toLowerCase().includes(needle) || a.name.toLowerCase().includes(needle));
    if (!list.length) {
      el.innerHTML = results || !state.assetSearch
        ? `<li class="nothing">Nothing by that name. Try the ticker${state.assetSearch ? `; ${state.assetCount.toLocaleString('en-US')} names are in the game` : ''}.</li>`
        : `<li class="nothing">Searching…</li>`;
      return;
    }
    const head = !needle && state.assetSearch ? `<li class="nothing">Featured. Type any US ticker or company name; ${state.assetCount.toLocaleString('en-US')} are in the game.</li>` : '';
    el.innerHTML = head + list.slice(0, 60).map((a) => `
      <li role="option" data-symbol="${esc(a.symbol)}">
        <b>${esc(a.symbol)}</b>
        <span>${esc(a.name)}</span>
        ${moodChip(a)}
      </li>`).join('');
    $$('li[data-symbol]', el).forEach((li) => {
      // pointerdown beats the search field's blur, so the tap registers.
      li.onpointerdown = (e) => { e.preventDefault(); selectAsset(li.dataset.symbol); };
    });
  }

  async function selectAsset(symbol) {
    state.selected = state.assets.find((a) => a.symbol === symbol) || state.found.get(symbol) || null;
    state.quote = null;
    showPicked();
    updateBuyButton();
    try {
      const quote = await API.get(`/quote/${encodeURIComponent(symbol)}`);
      if (!state.selected || state.selected.symbol !== symbol) return;
      state.quote = quote;
      showPicked();
      updateBuyButton();
    } catch (e) {
      const pk = $('#picked'); if (pk) pk.querySelector('.q').innerHTML = `<span class="down">${esc(e.message)}</span>`;
    }
  }

  // Swap the search field for the chosen asset, and reveal the amount.
  function showPicked() {
    const pk = $('#picked'), search = $('#carve-search'), list = $('#asset-list'), zone = $('#amount-zone');
    if (!pk) return;
    const a = state.selected, q = state.quote;
    if (!a) { pk.hidden = true; search.hidden = false; zone.hidden = true; return; }
    const closed = q && a.type !== 'crypto' && q.traded_at && (Date.now() - new Date(q.traded_at)) > 30 * 60e3;
    const qline = !q ? `Getting a price…`
      : `<b>${price(q.price)}</b> ${closed ? `last trade ${ago(q.traded_at)}` : 'right now'}${q.change_pct == null ? '' : `, today <span class="${dir(q.change_pct)}">${pct(q.change_pct)}</span>`}${q.stale ? ' <span class="down">(price feed is lagging)</span>' : ''}${closed ? `<br><span class="muted">Markets look closed. You'd buy at that price, and it won't move until they open.</span>` : ''}`;
    pk.innerHTML = `
      <div class="picked-main"><b>${esc(a.symbol)}</b><span>${esc(a.name)}</span>${moodChip(a)}</div>
      <div class="q">${qline}</div>
      <button type="button" class="linkish" id="carve-change">Change</button>`;
    pk.hidden = false; search.hidden = true; list.hidden = true; zone.hidden = false;
    $('#carve-change').onclick = () => {
      state.selected = null; state.quote = null; state.carve = 0;
      const usd = $('#carve-usd'); if (usd) usd.value = '';
      showPicked(); paintCoin(); updateBuyButton();
      search.value = ''; search.focus();
    };
    if (!(state.carve > 0)) { const usd = $('#carve-usd'); if (usd) setTimeout(() => usd.focus(), 30); }
  }

  function guideStep() {
    const g = $('#first-steps');
    if (!g) return;
    const step = !state.selected ? 1 : !(state.carve > 0) ? 2 : 3;
    $$('li', g).forEach((li) => { li.classList.toggle('now', Number(li.dataset.step) === step); li.classList.toggle('done', Number(li.dataset.step) < step); });
  }

  function updateBuyButton() {
    guideStep();
    const btn = $('#carve-buy');
    if (!btn) return;
    const amt = state.carve;
    if (!state.selected) { btn.disabled = true; btn.textContent = 'Pick something first'; return; }
    if (!state.quote) { btn.disabled = true; btn.textContent = `Pricing ${state.selected.symbol}…`; return; }
    if (!(amt > 0)) { btn.disabled = true; btn.textContent = `How much ${state.selected.symbol}?`; return; }
    btn.disabled = false;
    btn.textContent = `Buy ${money(amt)} of ${state.selected.symbol}`;
  }

  async function submitBuy() {
    if (state.busy || !state.selected || !(state.carve > 0)) return;
    const amount = state.carve, asset = state.selected;
    state.busy = true; $('#carve-buy').disabled = true; $('#carve-buy').textContent = 'Buying…';
    try {
      const r = await API.post('/buy', { symbol: asset.symbol, amount });
      state.carve = 0; state.selected = null; state.quote = null; state.justBought = true;
      toast(`${money(amount)} of ${asset.symbol} at ${price(r.quote.price)}. It matures in ${state.me.rules.hold_hours} hours.`);
      await loadMe();
      const row = $(`.position[data-id="${r.position.id}"]`);
      if (row) row.classList.add('fresh');
      await animateWedge(r.position.id, 0, 1);
      // Day one: the first buy is the first achievement.
      if (unclaimedKeys(state.me).length) { maybeAchievement(REDUCED ? 100 : 700); return; }
      const s = $('#carve-search'); if (s) s.focus();
    } catch (e) {
      const err = $('#carve-error'); if (err) { err.textContent = e.message; err.hidden = false; }
    } finally {
      state.busy = false; updateBuyButton();
    }
  }

  // --- Tails: TrickleTown -----------------------------------------------------------------

  const CLUE_LABEL = { allowance: 'Profit', cash: 'Cash now', happiness: 'Happiness' };
  const TIER_LABEL = { bad: 'Extractive', compromise: 'Compromise', good: 'Decent' };
  const WHO = { preston: { name: 'Preston Yield', role: 'Value Extraction Partner' }, dolores: { name: 'Dolores Pike', role: 'Lobbyist for Lobbyists' } };

  // ▲▼ hints, never exact numbers. Green means good for you.
  function clueChips(clues, cls = '') {
    return `<span class="clues ${cls}">${clues.map((c) => {
      const good = c.k === 'hiring' ? c.dir < 0 : c.dir > 0;
      return `<span class="clue ${good ? 'good' : 'bad'}">${esc(CLUE_LABEL[c.k])} ${(c.dir > 0 ? '▲' : '▼').repeat(c.n)}</span>`;
    }).join('')}</span>`;
  }

  // What actually happened, once it has.
  function fxChips(fx) {
    const out = [];
    if (fx.cash) out.push(`<span class="clue ${fx.cash > 0 ? 'good' : 'bad'}">Cash ${fx.cash > 0 ? '+' : '−'}${money(Math.abs(fx.cash), { whole: true })}</span>`);
    if (fx.income) out.push(`<span class="clue ${fx.income > 0 ? 'good' : 'bad'}">Profit ${fx.income > 0 ? '+' : '−'}${money(Math.abs(fx.income), { whole: true })}/day</span>`);
    if (fx.happy) out.push(`<span class="clue ${fx.happy > 0 ? 'good' : 'bad'}">Happiness ${fx.happy > 0 ? '+' : '−'}${Math.abs(fx.happy)}</span>`);
    return `<span class="clues">${out.join('')}</span>`;
  }

  // Where you stand, pinned to the top of Town Hall and the Site Office, so
  // every choice is made with the numbers in view. After a choice, each stat
  // that moved shows by how much.
  function statSnapshot() {
    const t = state.me.town, u = state.me.user;
    return { cash: u.cash, income: t.income, happiness: t.happiness, hire: t.hire_cost };
  }
  function renderStats(id) {
    const el = $(id); if (!el || !state.me || !state.me.town) return;
    const s = statSnapshot(), prev = state.statPrev, t = state.me.town;
    const delta = (k, fmt, upIsGood = true) => {
      if (!prev || Math.abs(s[k] - prev[k]) < 0.005) return '';
      const up = s[k] > prev[k];
      return `<em class="${up === upIsGood ? 'good' : 'bad'}">${up ? '+' : '−'}${fmt(Math.abs(s[k] - prev[k]))}</em>`;
    };
    const bar = (v) => `<span class="ss-bar"><i style="--w:${Math.max(0, Math.min(100, v))}%"></i></span>`;
    const m = (v) => money(v);
    el.innerHTML = `
      <div class="ss"><span>Cash</span><b>${money(s.cash)}</b>${delta('cash', m)}</div>
      <div class="ss"><span>Profit</span><b class="${s.income < 0 ? 'down' : ''}">${s.income >= 0 ? '+' : '−'}${money(Math.abs(s.income), { whole: true })}<small>/day</small></b>${delta('income', m)}</div>
      <div class="ss"><span>Happiness</span><b>${s.happiness}</b>${bar(s.happiness)}${delta('happiness', String)}</div>
      <div class="ss ss-price" title="Lobbyist price: the tax it takes to hire one lobbyist. Happier towns pay less."><span>Lobbyist price</span><b>${money(s.hire)}</b>${delta('hire', m, false)}</div>`;
  }

  function meter(label, value, opts = {}) {
    const warn = opts.warnBelow != null && value < opts.warnBelow;
    return `<div class="meter ${warn ? 'warn' : ''}">
      <div class="meter-top"><span>${esc(label)}</span><b>${value}</b></div>
      <div class="meter-bar"><i style="--w:${value}%"></i>${opts.warnBelow != null ? `<s style="--at:${opts.warnBelow}%"></s>` : ''}</div>
      ${opts.note ? `<div class="meter-note">${opts.note}</div>` : ''}
    </div>`;
  }

  function reportLine(r) {
    if (!r || r.first_day) return '';
    const bits = [];
    bits.push(r.income >= 0 ? `TrickleTown's profit added <b>${money(r.income)}</b> to your allowance` : `TrickleTown's losses took <b>${money(-r.income)}</b> from your allowance`);
    if (r.happy_delta) bits.push(`happiness ${r.happy_delta > 0 ? '▲' : '▼'}${Math.abs(r.happy_delta)}`);
    let out = `Overnight: ${bits.join(', ')}.`;
    if (r.ignored) out += ` You left ${r.ignored} card${r.ignored === 1 ? '' : 's'} unplayed yesterday. They noticed.`;
    return `<p class="v-report">${out}</p>`;
  }

  // One small line icon per town section, so each reads as its own place.
  const T_ICON = {
    vitals: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12h4l2-5 4 10 2-5h6"/></svg>',
    hall: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 9l9-5 9 5"/><path d="M5 9v9M9.5 9v9M14.5 9v9M19 9v9"/><path d="M3 20h18"/></svg>',
    zone: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 21V4h12"/><path d="M6 8l4-4"/><path d="M16 4v5"/><rect x="13.5" y="9" width="5" height="4" rx="1"/><path d="M3 21h8"/></svg>',
    deck: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="6" width="11" height="15" rx="2" transform="rotate(-8 8.5 13.5)"/><rect x="10" y="3" width="11" height="15" rx="2"/></svg>',
    payroll: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/></svg>',
  };
  const tHead = (icon, title, sub = '') => `<h3 class="t-h"><span class="t-ico">${T_ICON[icon]}</span><span class="t-title">${title}</span>${sub ? ` <span class="muted">${sub}</span>` : ''}</h3>`;

  // The construction zone: one tile per plot. Tap to open the Site Office.
  function zoneTile(p) {
    const b = p.building;
    const badge = !b ? '<span class="zone-badge build">Tap to build</span>'
      : p.proposals ? `<span class="zone-badge proposal">${p.proposals} proposal${p.proposals === 1 ? '' : 's'}</span>`
      : '';
    return `<button type="button" class="zone-tile ${b ? `tier-${b.tier}` : 'empty'}" data-site="${esc(p.slot)}">
      ${Coin.buildingIcon(p.key, 150)}
      <span class="zone-text">
        <span class="plot-label">${esc(p.label)}</span>
        <b>${b ? esc(b.name) : 'Empty lot'}</b>
        ${b ? `<small>${b.total.income ? `${b.total.income > 0 ? '+' : '−'}${money(Math.abs(b.total.income), { whole: true })} profit` : 'no profit'} · ${b.total.happy >= 0 ? '+' : '−'}${Math.abs(b.total.happy)} happiness</small>`
          : `<small>${money(Math.min(...p.options.map((o) => o.cost)), { whole: true })}–${money(Math.max(...p.options.map((o) => o.cost)), { whole: true })} · three choices</small>`}
      </span>
      ${badge}
    </button>`;
  }

  function lockedMarkup() {
    const me = state.me;
    const have = Math.max(0, me.user.total_donated || 0);
    const need = me.town.unlock_at || 1;
    return `
      <div class="side-head"><h2>TrickleTown</h2><span class="muted">Under construction</span></div>
      <section class="locked">
        <p><b>Your lobbyists will live here.</b> Hire your first one and the town opens.</p>
        <div class="lobby-row"><b>${esc(lobbyN(have))} / ${need}</b>${have > 0 ? lobbyists(have) : ''}</div>
        <div class="rank-bar"><i style="--w:${Math.min(100, (have / need) * 100).toFixed(0)}%"></i></div>
        <p class="muted small">Win on a position, or take your first-buy bonus: the tax on it hires lobbyists.</p>
      </section>`;
  }

  // The collection: every card, with what unlocks it. Locked cards that open
  // with days played get a "coming up" line, so the deck reads as a road
  // ahead rather than a wall of question marks.
  function deckComing(deck) {
    const gated = deck.filter((d) => d.status === 'locked').map((d) => {
      const m = /^Unlock: play (\d+) days? \(you: (\d+)\)\.$/.exec(d.needs || '');
      return m ? Number(m[1]) - Number(m[2]) : null;
    }).filter((n) => n != null && n > 0);
    if (!gated.length) return '';
    const soon = Math.min(...gated), k = gated.filter((n) => n === soon).length, rest = gated.length - k;
    const when = soon === 1 ? 'the next day you play' : `after ${soon} more days of play`;
    return `<p class="deck-coming"><b>Coming up:</b> ${k} new card${k === 1 ? '' : 's'} ${k === 1 ? 'unlocks' : 'unlock'} ${when}${rest ? `, and ${rest} more after that just for showing up` : ''}. The rest open with what you build, hire, earn and who you bring.</p>`;
  }
  function deckMarkup(deck) {
    const order = { today: 0, played: 1, available: 2, locked: 3 };
    // Same status: the town's own cards before the headlines, so the first
    // rows show what's particular to you.
    const sorted = [...deck].sort((a, b) => order[a.status] - order[b.status] || (a.general ? 1 : 0) - (b.general ? 1 : 0));
    const counts = deck.reduce((m, d) => { m[d.status] = (m[d.status] || 0) + 1; return m; }, {});
    const heads = deck.filter((d) => d.general), headsSeen = heads.filter((d) => d.seen || d.status === 'played').length;
    const needs = (d) => (d.general ? `Everyone gets one of these ${heads.length} a day.`
      : d.status === 'locked' || d.forced ? d.needs : d.needs.replace(/^Unlock:/, 'Unlocked:'));
    return `
      <p class="muted small"><b>${deck.length - (counts.locked || 0)} of ${deck.length} unlocked.</b> Every day: one of ${heads.length} headlines everyone gets (you've played ${headsSeen}), plus two or more from what your town has unlocked.</p>
      ${deckComing(deck)}
      <div class="deck-grid">${sorted.map((d) => `
        <div class="mini-card ${d.status} ${d.general ? 'general' : ''}">
          <span class="mini-status">${{ today: 'In hand', played: 'Played today', available: 'In the pile', locked: 'Locked' }[d.status]}</span>
          <b>${d.status === 'locked' ? '???' : esc(d.title)}</b>
          ${d.consequence ? '<span class="mini-tag">consequences</span>' : d.followup ? '<span class="mini-tag followup">follow-up</span>' : d.general ? '<span class="mini-tag headline">headline</span>' : ''}
          <span class="mini-needs">${esc(needs(d))}</span>
          ${d.forced && d.status !== 'locked' ? '<span class="mini-tag admin">opened by admin</span>' : ''}
          ${d.seen && d.status !== 'played' ? '<span class="mini-seen">✓ played before</span>' : ''}
        </div>`).join('')}</div>`;
  }
  function openDeck() {
    const t = state.me && state.me.town; if (!t) return;
    $('#deck-body').innerHTML = deckMarkup(t.deck);
    $('#dlg-deck').showModal();
  }
  // One line for the town panel: how many unlocked, what's next.
  function deckLine(deck) {
    const unlocked = deck.filter((d) => d.status !== 'locked').length;
    const soon = deck.filter((d) => d.status === 'locked').map((d) => { const m = /^Unlock: play (\d+) days? \(you: (\d+)\)\.$/.exec(d.needs || ''); return m ? Number(m[1]) - Number(m[2]) : null; }).filter((n) => n != null && n > 0);
    const next = soon.length ? Math.min(...soon) : null;
    return `${unlocked} of ${deck.length} cards unlocked${next ? ` · ${soon.filter((n) => n === next).length} more ${next === 1 ? 'tomorrow' : `in ${next} days`}` : ''}`;
  }

  function backMarkup() {
    const me = state.me;
    if (!me.town.unlocked) return lockedMarkup();
    const { user, history, day, town } = me;
    const given = me.donations_by_charity.filter((c) => c.amount > 0);
    const q = Math.max(0, user.quarter_donated || 0);
    const badges = user.badges, next = badges.next;
    const have = badges.earned.length ? badges.earned[badges.earned.length - 1] : null;
    const prevAt = have ? have.at : 0;
    const progress = next ? Math.min(100, ((user.total_donated - prevAt) / (next.at - prevAt)) * 100) : 100;
    const pending = pendingIssues();
    const decided = town.issues.length - pending;
    const defaultName = (() => {
      const id = user.charity_id; if (!id) return null;
      const c = state.charities.find((x) => x.id === id) || me.donations_by_charity.find((x) => x.id === id);
      return c ? c.name : null;
    })();
    const r = town.report;
    return `
      <div class="side-head">
        <div><h2>TrickleTown</h2><div class="motto">“${esc(town.motto)}”</div></div>
        <span class="muted">Lobbyfest in <b data-fest="${esc(day.quarter_ends_at)}">${esc(untilLong(day.quarter_ends_at))}</b></span>
      </div>

      <div class="t-stats" aria-label="Town scores">
        <div class="ss"><span>Profit</span><b class="${town.income < 0 ? 'down' : 'up'}">${town.income >= 0 ? '+' : '−'}${money(Math.abs(town.income), { whole: true })}<small>/day</small></b><em class="ss-note">to your allowance</em></div>
        <div class="ss"><span>Happiness</span><b>${town.happiness}</b><span class="ss-bar"><i style="--w:${town.happiness}%"></i></span></div>
        <div class="ss"><span>Lobbyist price</span><b>${money(town.hire_cost)}</b><em class="ss-note">happier is cheaper</em></div>
        <div class="ss"><span>Lobbyists</span><b>${esc(lobbyN(q))}</b><em class="ss-note">this quarter</em></div>
      </div>
      ${r && !r.first_day && (r.income || r.happy_delta || r.ignored) ? `<p class="t-overnight">Overnight: ${[r.income ? `profit ${r.income > 0 ? '+' : '−'}${money(Math.abs(r.income), { whole: true })}` : '', r.happy_delta ? `happiness ${r.happy_delta > 0 ? '▲' : '▼'}${Math.abs(r.happy_delta)}` : '', r.ignored ? `${r.ignored} card${r.ignored === 1 ? '' : 's'} left unplayed` : ''].filter(Boolean).join(' · ')}.</p>` : ''}

      <section class="t-section t-panel t-hall ${pending ? 'waiting' : ''}">
        ${tHead('hall', 'Town Hall')}
        <div class="advisors-cta ${pending ? 'waiting' : ''}">
          <div class="advisors-faces">${Coin.preston(52)}${Coin.dolores(52)}</div>
          <div class="advisors-text">
            <b>${pending ? `${pending} card${pending === 1 ? '' : 's'} to play` : decided ? "Today's cards are played" : 'No cards today'}</b>
            <span class="muted">${pending ? 'Preston wants profit. Dolores wants happiness. Pick a side on each.' : 'More tomorrow, or when you unlock something.'}</span>
          </div>
          <button type="button" class="btn ${pending ? 'primary' : 'quiet'}" id="btn-advisors">${pending ? 'Play the cards' : 'Review'}</button>
        </div>
        <button type="button" class="linkish t-deck-link" id="btn-deck">${deckLine(town.deck)} ›</button>
      </section>

      <section class="t-section t-panel t-zone zone">
        ${tHead('zone', 'Construction zone', `${town.plots.filter((p) => p.building).length} of ${town.plots.length} lots built`)}
        <div class="zone-grid">${town.plots.map(zoneTile).join('')}</div>
      </section>

      <section class="t-section t-panel t-payroll records">
        ${tHead('payroll', 'Payroll', `marches to Lobbyfest on ${esc(festDate(day.quarter_ends_at))}`)}
        ${given.length ? `<ul class="given">${given.map((c, i) => `
          <li><span><span class="sw" style="background:${CHARITY_COLORS[i % 6]}"></span>${esc(c.name)}${c.id === user.charity_id ? ' <em class="default-tag">default</em>' : ''}</span><span>${lobbyists(c.amount, { mini: true, max: 12 })} <b>${esc(lobbyN(c.amount))}</b></span></li>`).join('')}</ul>` : '<p class="muted small">Nobody on the payroll this quarter yet.</p>'}
        <p class="small payroll-default">${defaultName ? `New lobbyists go to <b>${esc(defaultName)}</b>. ` : ''}The charity with the most lobbyists at Lobbyfest gets the biggest share of the real money.</p>
        <button type="button" class="btn primary wide" id="btn-assign">Assign lobbyists</button>
        <div class="rank-row">
          <span><b>${have ? esc(have.name) : 'Unranked'}</b> <span class="muted">${next ? `· ${esc(next.name)} at ${next.at} lobbyists (${lobbyN(Math.max(0, next.at - user.total_donated))} to go)` : '· top rank'}</span></span>
          ${me.achievements ? `<button type="button" class="linkish" id="btn-badge-trophies">🏆 ${me.achievements.earned} of ${me.achievements.total}</button>` : ''}
        </div>
        <div class="rank-bar"><i style="--w:${progress.toFixed(1)}%"></i></div>
        <details class="records-more"><summary>Records</summary>
        ${history.length ? `<ul class="history">${history.map((h) => {
          const hired = h.lobbyists != null ? h.lobbyists : h.tax;
          if (h.gift) return `<li>
            <span><span class="tier">🏆 Gift</span> &nbsp;${esc(h.name)} <span class="muted">from Mommy &amp; Daddy, ${money(h.proceeds)}</span></span>
            <span class="to">${hired > 0 ? `${esc(lobby(hired))} for ${esc(h.charity_name || 'your charity')}` : shortDate(h.closed_at)}</span>
          </li>`;
          return `<li>
            <span><span class="tier">${esc(h.tier)}</span> &nbsp;${esc(h.symbol)} ${money(h.invested)} → ${money(h.proceeds)} <span class="muted">${h.vested ? 'vested, sold per policy' : h.rode ? 'rode on, half tax' : h.collected ? 'collected' : h.proceeds > 0 ? 'sold early' : 'buried'}</span></span>
            <span class="to">${hired > 0 ? `${esc(lobby(hired))} for ${esc(h.charity_name)}` : shortDate(h.closed_at)}</span>
          </li>`;
        }).join('')}</ul>` : `<p class="muted">Nothing collected yet.</p>`}
        </details>
      </section>`;
  }

  // After any village change, redraw the coin, the caption and the panel in place.
  function refreshVillage(town, user) {
    clearTimeout(state.flipTimer);
    state.me.town = town;
    if (user) state.me.user = { ...state.me.user, ...user };
    paintCoin();
    const cap = $('.coin-caption');
    if (cap) { cap.innerHTML = captionMarkup(); wireCaption(); }
    const y = window.scrollY;
    renderUnder();
    window.scrollTo({ top: y });
  }

  const REACTIONS = {
    preston: ['Preston is delighted. He is already drafting the press release.', 'Preston gives you a thumbs-up and a business card. You already have six.', 'Preston nods. Somewhere, a number went up.', 'Preston says "love that for us." He means him.'],
    dolores: ['Dolores nods once. From her, that is a standing ovation.', 'Dolores writes something on her clipboard. It might be your name. It might be "fine."', 'Dolores says "huh." It is the warmest thing she has said all week.', 'Dolores does not smile, but she does not not smile.'],
  };
  const reaction = (who) => REACTIONS[who][Math.floor(Math.random() * REACTIONS[who].length)];

  async function townPost(path, body, btn) {
    if (state.busy) return null;
    state.busy = true; if (btn) btn.disabled = true;
    try { return await API.post(path, body); }
    catch (e) { toast(e.message, 3600); if (btn) btn.disabled = false; return null; }
    finally { state.busy = false; }
  }

  function wireBack() {
    const adv = $('#btn-advisors'); if (adv) adv.onclick = () => openAdvisors();
    const dk = $('#btn-deck'); if (dk) dk.onclick = openDeck;
    const asg = $('#btn-assign'); if (asg) asg.onclick = () => openAssign();
    const bt = $('#btn-badge-trophies'); if (bt) bt.onclick = () => openTrophies();
    $$('[data-site]').forEach((btn) => { btn.onclick = () => openSite(btn.dataset.site); });
  }

  // --- The Site Office: build a plot, hear proposals --------------------------------------

  const site = { slot: null, mode: 'office', i: 0, result: null };
  const plotOf = (slot) => state.me.town.plots.find((p) => p.slot === slot);

  function openSite(slot, mode) {
    clearTimeout(state.flipTimer);
    if (!state.flipped) flip(true);
    const p = plotOf(slot);
    if (!p) return;
    site.slot = slot; site.result = null; site.i = 0; state.statPrev = null;
    site.mode = mode || (p.building ? 'office' : 'build');
    renderSite();
    const d = $('#dlg-site');
    if (!d.open) d.showModal();
  }

  // "Every day: +$18K profit · −4 happiness". Buildings and
  // upgrades show their real numbers; only the advisors' cards keep arrows.
  function effectChips(e, { perDay = true } = {}) {
    if (!e) return '';
    const items = [];
    const chip = (good, text) => `<span class="clue num ${good ? 'good' : 'bad'}">${text}</span>`;
    if (e.income) items.push(chip(e.income > 0, `${e.income > 0 ? '+' : '−'}${money(Math.abs(e.income), { whole: true })} profit`));
    if (e.happy) items.push(chip(e.happy > 0, `${e.happy > 0 ? '+' : '−'}${Math.abs(e.happy)} happiness`));
    if (!items.length) items.push(`<span class="clue num">no daily effect</span>`);
    return `<span class="clues">${perDay ? '<span class="clue-label">Every day:</span>' : ''}${items.join('')}</span>`;
  }

  const quoted = (line) => esc(String(line || '').replace(/"([^"]*)"/g, '‘$1’'));
  // The price is always in plain sight, top right, whether or not you can
  // afford it; short of cash, the button says how much more you need.
  // Same rule as the server (town.js canPay): within a display step of the
  // price is enough, so "$30K" on the coin always buys a $30K building.
  const affords = (cash, cost) => (window.TownRules && TownRules.canPay ? TownRules.canPay(cash, cost) : cash >= cost);
  const priceTag = (cost, cash) => `<span class="price-tag ${affords(cash, cost) ? '' : 'short'}">${money(cost, { whole: true })}</span>`;
  const buyLabel = (verb, cost, cash) => (affords(cash, cost) ? `${verb} for ${money(cost, { whole: true })}` : `Need ${money(cost - cash)} more`);
  function sitePitch(o, who, cash) {
    const w = WHO[who], short = !affords(cash, o.cost);
    return `<button type="button" class="build-option tier-${o.tier} ${short ? 'short' : ''}" data-build="${esc(o.key)}" ${short ? 'disabled' : ''}>
      <span class="bo-head">
        <span class="bo-name"><span class="tier-badge tier-${o.tier}">${TIER_LABEL[o.tier]}</span><b>${esc(o.name)}</b></span>
        <span class="bo-price ${short ? 'short' : ''}">${money(o.cost, { whole: true })}</span>
      </span>
      ${effectChips(o.effects)}
      ${o.perk ? `<span class="bo-perk">Perk: ${esc(o.perk)}.</span>` : ''}
      <span class="bo-pitch">${Coin[who](30)}<span><b>${esc(w.name.split(' ')[0])}:</b> <q>${quoted(o.pitch.line)}</q></span></span>
      <span class="bo-cta">${esc(buyLabel('Build it', o.cost, cash))}</span>
    </button>`;
  }

  const freshLine = (titles) => (titles && titles.length
    ? `<p class="fresh-card">🃏 <b>New card unlocked:</b> ${titles.map((x) => `“${esc(x)}”`).join(', ')}. ${titles.length === 1 ? "It's" : "They're"} on today's agenda.</p>` : '');

  function renderSite() {
    renderStats('#site-stats');
    const p = plotOf(site.slot);
    const stage = $('#site-stage');
    $('#site-title').textContent = `Site Office · ${p.label}`;
    const cost = state.me.town.build_cost;
    const cash = state.me.user.cash;

    if (site.mode === 'build') {
      const rebuilding = !!p.building;
      stage.innerHTML = `
        <div class="adv-card" id="site-card">
          <div class="adv-band village">${rebuilding ? 'Rebuilding' : 'Empty lot'} · ${esc(p.label)}</div>
          <h3>${rebuilding ? `What replaces ${esc(p.building.name)}?` : 'What goes here?'}</h3>
          <p>${rebuilding ? 'Tearing it down takes its upgrades with it. ' : ''}Each building pushes two numbers every day for as long as it stands. <b>Extractive</b> ones add <b>profit</b> to your allowance and make your lobbyists unhappy, so every lobbyist you hire costs more. <b>Decent</b> ones cost you profit and make them happier, so every lobbyist costs less. Every building also unlocks a card of its own.</p>
          ${p.options.some((o) => o.key !== p.key && affords(cash, o.cost)) ? '' : `<p class="site-broke">You have ${money(cash)}. Not enough for any of them yet: collect a win, or come back tomorrow for your allowance.</p>`}
        </div>
        <div class="site-options">
          ${p.options.filter((o) => o.key !== p.key).map((o) => sitePitch(o, o.pitch.who, cash)).join('')}
        </div>
        ${rebuilding ? '<div class="adv-foot"><button type="button" class="linkish" data-site-mode="office">Keep what\'s there</button><span></span></div>' : ''}`;
      wireSite(); return;
    }

    const b = p.building;
    if (site.mode === 'built' && site.built) {
      const r = site.built;
      stage.innerHTML = `
        <div class="adv-card result ${r.who} site-built">
          <div class="adv-band village">${esc(p.label)} · built</div>
          <div class="site-icon">${Coin.buildingIcon(r.key, 180)}</div>
          <div class="adv-result-who">${Coin[r.who](56)}<div><b>${esc(r.name)} is up.</b><span>${r.cost != null ? `${money(r.cost, { whole: true })} from the coin. ` : ''}${esc(r.line)}</span></div></div>
          ${effectChips(r.effects)}
          <p class="muted small">It does this every day from tomorrow on. Upgrades get proposed here as the town grows; the lot tile shows a badge when one's waiting.</p>
          ${freshLine(r.fresh)}
          <div class="adv-actions">${r.fresh && r.fresh.length ? '<button type="button" class="btn quiet" data-site-hall>Play it at Town Hall</button>' : ''}<button type="button" class="btn primary" data-site-close>Back to TrickleTown</button></div>
        </div>`;
      wireSite(); return;
    }
    if (site.mode === 'proposal') {
      const avail = b.upgrades.filter((u) => u.status === 'available');
      if (site.result) {
        const r = site.result;
        stage.innerHTML = `
          <div class="adv-card result ${r.who}">
            <div class="adv-band">${esc(b.name)}</div>
            <div class="adv-result-who">${Coin[r.who](56)}<div><b>${esc(r.name)}: built.</b><span>${money(r.cost, { whole: true })}, from the coin</span></div></div>
            <p>${esc(r.line)}</p>
            ${effectChips(r.effects)}
            <p class="muted small">That's on top of the building, every day from now on.</p>
            ${freshLine(r.fresh)}
            <div class="adv-actions">${r.fresh && r.fresh.length ? '<button type="button" class="btn quiet" data-site-hall>Play it at Town Hall</button>' : ''}<button type="button" class="btn primary" data-site-close>Back to TrickleTown</button><button type="button" class="btn quiet" data-site-mode="office">Back to the office</button></div>
          </div>`;
        wireSite(); return;
      }
      if (!avail.length || site.i >= avail.length) { site.mode = 'office'; renderSite(); return; }
      const u = avail[site.i];
      const who = u.pitch.who, other = who === 'preston' ? 'dolores' : 'preston';
      stage.innerHTML = `
        <div class="adv-card" id="site-card">
          <div class="adv-band village">Upgrade for ${esc(b.name)} · ${site.i + 1} of ${avail.length}</div>
          <span class="adv-tag">${TIER_LABEL[u.tier]}</span>
          <h3>${esc(u.name)} ${priceTag(u.cost, cash)}</h3>
          <p>An add-on to ${esc(b.name)} for ${money(u.cost, { whole: true })}, one time. Buy it and it pushes the numbers below every day on top of what the building already does. Pass and it waits.</p>
          ${effectChips(u.effects)}
          <p class="muted small">${esc(u.unlocked_by || '')}</p>
        </div>
        <div class="adv-pitches">
          <button type="button" class="adv-pitch ${who} ${affords(cash, u.cost) ? '' : 'short'}" data-upgrade="${esc(u.key)}" ${affords(cash, u.cost) ? '' : 'disabled'}>
            <span class="adv-who">${Coin[who](44)}<span><b>${esc(WHO[who].name)}</b><small>proposes</small></span>${priceTag(u.cost, cash)}</span>
            <q>${quoted(u.pitch.line)}</q>
            <span class="adv-label">${esc(buyLabel('Buy it', u.cost, cash))}</span>
          </button>
          <button type="button" class="adv-pitch ${other}" data-pass="1">
            <span class="adv-who">${Coin[other](44)}<span><b>${esc(WHO[other].name)}</b><small>objects</small></span></span>
            <q>${quoted(u.objection)}</q>
            <span class="adv-label">Pass for now</span>
          </button>
        </div>
        <div class="adv-foot"><button type="button" class="linkish" data-site-mode="office">Back to the office</button><span class="muted small">${affords(cash, u.cost) ? '' : `Need ${money(u.cost - cash)} more.`}</span></div>`;
      wireSite(); return;
    }

    // office: the building, what it does, proposals waiting, the rest of the list
    const avail = b.upgrades.filter((u) => u.status === 'available');
    const owned = b.upgrades.filter((u) => u.status === 'owned');
    const locked = b.upgrades.filter((u) => u.status === 'locked');
    const age = p.days === 0 ? 'Built today' : `Built ${p.days} day${p.days === 1 ? '' : 's'} ago`;
    const upRow = (u) => `<li class="up-${u.status}">
          <div class="up-top"><b>${u.status === 'owned' ? '✓ ' : u.status === 'locked' ? '🔒 ' : ''}${esc(u.name)}</b><span class="price-inline">${u.status === 'owned' ? 'owned' : money(u.cost, { whole: true })}</span></div>
          ${effectChips(u.effects, { perDay: false })}
          <span class="up-why">${u.status === 'owned' ? 'Built. Its numbers are in the total above.' : u.status === 'available' ? 'Proposed today. Hear the pitch to buy it.' : esc(u.needs)}</span>
        </li>`;
    stage.innerHTML = `
      <div class="adv-card site-office tier-${b.tier}">
        <div class="adv-band village">${esc(p.label)}</div>
        <span class="tier-badge tier-${b.tier}" style="float:right;margin-top:6px">${TIER_LABEL[b.tier]}</span>
        <h3>${esc(b.name)}</h3>
        <p class="plot-sign">“${esc(b.sign)}”</p>
        <div class="site-icon">${Coin.buildingIcon(b.key, 200)}</div>
        <div class="site-sec">
          <div class="site-k">What it does, every day</div>
          <div class="plot-now">${effectChips(b.total, { perDay: false })}${b.perk ? `<span class="muted small">Perk: ${esc(b.perk)}.</span>` : ''}</div>
          <p class="muted small">${age}. Including any upgrades you own.</p>
        </div>
        <div class="site-sec">
          <div class="site-k">Upgrades</div>
          <p class="muted small">Add-ons for this building, bought once. Their numbers stack on top of the building's.</p>
          <ul class="site-ups">${[...avail, ...locked, ...owned].map(upRow).join('')}</ul>
        </div>
        <div class="adv-actions">
          ${avail.length ? `<button type="button" class="btn primary" data-site-mode="proposal">Hear ${avail.length === 1 ? 'the proposal' : `${avail.length} proposals`}</button>` : ''}
          <button type="button" class="btn ${avail.length ? 'quiet' : 'primary'}" data-site-close>Back to TrickleTown</button>
        </div>
      </div>
      <div class="adv-foot site-foot"><span></span><button type="button" class="linkish danger-link" data-site-mode="build">Tear it down and build something else…</button></div>`;
    wireSite();
  }

  function wireSite() {
    const dlg = $('#dlg-site');
    const p = plotOf(site.slot);
    $$('[data-site-mode]', dlg).forEach((b) => { b.onclick = () => { site.mode = b.dataset.siteMode; site.i = 0; site.result = null; state.statPrev = null; renderSite(); }; });
    $$('[data-pass]', dlg).forEach((b) => { b.onclick = () => { site.i += 1; state.statPrev = null; renderSite(); }; });
    $$('[data-site-close]', dlg).forEach((b) => { b.onclick = () => { state.statPrev = null; dlg.close(); }; });
    $$('[data-site-hall]', dlg).forEach((b) => { b.onclick = () => { state.statPrev = null; dlg.close(); openAdvisors(); }; });
    $$('[data-build]', dlg).forEach((b) => {
      b.onclick = async () => {
        const before = statSnapshot();
        const r = await townPost('/town/build', { slot: site.slot, key: b.dataset.build }, b);
        if (!r) return;
        const nb = r.town.plots.find((x) => x.slot === site.slot).building;
        const opt = plotOf(site.slot).options.find((o) => o.key === b.dataset.build);
        state.statPrev = before;
        refreshVillage(r.town, r.user);
        site.built = {
          key: nb.key, name: nb.name, tier: nb.tier, cost: opt ? opt.cost : null, effects: nb.effects || (opt && opt.effects), who: opt ? opt.pitch.who : (nb.tier === 'good' ? 'dolores' : 'preston'),
          line: nb.tier === 'bad' ? 'Preston is already invoicing.' : nb.tier === 'good' ? 'Dolores almost smiled.' : 'Nobody is thrilled. Nobody is suing.',
          fresh: r.fresh_cards || [],
        };
        site.mode = 'built'; renderSite();
        refreshAchievements();
      };
    });
    $$('[data-upgrade]', dlg).forEach((b) => {
      b.onclick = async () => {
        const u = p.building.upgrades.find((x) => x.key === b.dataset.upgrade);
        const card = $('#site-card');
        const before = statSnapshot();
        const r = await townPost('/town/upgrade', { slot: site.slot, key: b.dataset.upgrade }, b);
        if (!r) return;
        if (card && !REDUCED) { card.classList.add(`fly-${u.pitch.who}`); await new Promise((res) => setTimeout(res, 420)); }
        state.statPrev = before;
        refreshVillage(r.town, r.user);
        site.result = { who: u.pitch.who, name: u.name, cost: u.cost, effects: u.effects, line: reaction(u.pitch.who), fresh: r.fresh_cards || [] };
        renderSite();
      };
    });
  }

  // --- The advisors: cards, one at a time ---------------------------------------------------

  const adv = { cards: [], i: 0, result: null };

  function openAdvisors(startAt = 0) {
    clearTimeout(state.flipTimer); // they're engaged; don't flip the coin back under them
    if (!state.flipped) flip(true);
    const t = state.me.town;
    adv.cards = t.issues.slice();
    adv.i = Math.max(0, Math.min(adv.cards.length, startAt));
    adv.result = null;
    state.statPrev = null;
    // Start on the first unplayed card, if any.
    const firstOpen = adv.cards.findIndex((c) => !c.chosen);
    if (startAt === 0 && firstOpen > 0) adv.i = firstOpen;
    renderAdvisors();
    const d = $('#dlg-advisors');
    if (!d.open) d.showModal();
  }

  function advisorsSummary() {
    const t = state.me.town;
    const locked = t.deck.filter((d) => d.status === 'locked').length;
    const played = t.issues.filter((c) => c.chosen);
    const p = played.filter((c) => c.chosen === 'preston').length, d = played.filter((c) => c.chosen === 'dolores').length;
    const verdict = !played.length ? 'You played nothing. The advisors have noted it.'
      : p && !d ? 'Preston is buying champagne. Dolores is updating her résumé.'
      : d && !p ? 'Dolores is quietly pleased. Preston is in the parking lot, on the phone, pacing.'
      : 'One each. Preston calls it balance. Dolores calls it a coin flip.';
    return `<div class="adv-card summary">
      <div class="adv-band">That's the table</div>
      <h3>Agenda closed</h3>
      <p>${esc(verdict)}</p>
      <div class="adv-tally"><span>${Coin.preston(32)} ${p}</span><span>${Coin.dolores(32)} ${d}</span></div>
      <p class="muted small">${locked} card${locked === 1 ? '' : 's'} still locked. Build, hire, and spend to meet them.</p>
      <div class="adv-actions"><button type="button" class="btn quiet" data-adv="deck">See the deck</button><button type="button" class="btn primary" data-adv="close">Back to town</button></div>
    </div>`;
  }

  function advisorPitch(i, who, played) {
    const p = i[who], w = WHO[who];
    const mine = i.chosen === who, other = i.chosen && !mine;
    const cash = state.me.user.cash, short = !played && p.cost > 0 && !affords(cash, p.cost);
    const tag = p.cost > 0 ? `<span class="price-tag cost ${short ? 'short' : ''}">Costs ${money(p.cost, { whole: true })}</span>` : '<span class="price-tag free">Free</span>';
    return `<button type="button" class="adv-pitch ${who} ${mine ? 'chosen' : ''} ${other ? 'passed' : ''} ${short ? 'short' : ''}" data-pick="${who}" ${played || short ? 'disabled' : ''}>
      <span class="adv-who">${Coin[who](44)}<span><b>${esc(w.name)}</b><small>${esc(w.role)}</small></span>${tag}</span>
      <q>${quoted(p.line)}</q>
      ${clueChips(p.clues)}
      ${p.later ? `<span class="later later-${p.later}">${{ good: '✨ Could pay off later', bad: '⚠️ Could come back to bite', mixed: '🔮 Something comes of this later' }[p.later]}</span>` : ''}
      <span class="adv-label">${mine ? '✓ ' : ''}${esc(p.label)}${short ? `<small class="need">Need ${money(p.cost - cash)} more</small>` : ''}</span>
    </button>`;
  }

  function renderAdvisors() {
    renderStats('#adv-stats');
    const stage = $('#adv-stage');
    const n = adv.cards.length;
    if (adv.i >= n) { stage.innerHTML = advisorsSummary(); wireAdvisors(); return; }
    const c = adv.cards[adv.i];
    const played = !!c.chosen;
    if (adv.result && adv.result.id === c.id) {
      const r = adv.result, w = WHO[r.side];
      stage.innerHTML = `
        <div class="adv-card result ${r.side}">
          <div class="adv-band">${esc(c.title)}</div>
          <div class="adv-result-who">${Coin[r.side](56)}<div><b>You went with ${esc(w.name.split(' ')[0])}.</b><span>${esc(c[r.side].label)}</span></div></div>
          <p>${esc(r.line)}</p>
          ${fxChips(r.fx)}
          ${Object.keys(r.fx).length === 0 ? '<p class="muted small">Nothing measurable happened. That is its own kind of outcome.</p>' : ''}
          ${r.noted ? '<p class="adv-noted">Noted. This will come back around.</p>' : ''}
          ${crowdLine(r.crowd, r.side)}
          <div class="adv-actions"><button type="button" class="btn primary" data-adv="next">${adv.i + 1 < n ? 'Next card' : 'Done'}</button></div>
        </div>`;
      wireAdvisors(); return;
    }
    stage.innerHTML = `
      <div class="adv-card ${played ? 'played' : ''}" id="adv-card">
        <div class="adv-band ${c.general ? 'headline' : 'village'}">${c.general ? "Today's headline" : c.followup ? 'It came back around' : 'From your village'} · ${adv.i + 1} of ${n}</div>
        <h3>${esc(c.title)}</h3>
        <p>${esc(c.setup)}</p>
        ${c.ask ? `<p class="adv-ask">${esc(c.ask)} <span class="muted">Preston and Dolores each have an answer; pick one.</span></p>` : ''}
        ${played ? `<div class="adv-played">Played. You went with ${esc(WHO[c.chosen].name.split(' ')[0])}: ${esc(c[c.chosen].label)}.</div>` : ''}
      </div>
      <div class="adv-pitches">${advisorPitch(c, 'preston', played)}${advisorPitch(c, 'dolores', played)}</div>
      <div class="adv-foot">
        <button type="button" class="linkish" data-adv="prev" ${adv.i === 0 ? 'disabled' : ''}>Previous</button>
        <span class="adv-dots">${adv.cards.map((x, k) => `<i class="${k === adv.i ? 'on' : ''} ${x.chosen ? 'done' : ''}"></i>`).join('')}</span>
        <button type="button" class="linkish" data-adv="next">${played ? 'Next' : 'Skip for now'}</button>
      </div>`;
    wireAdvisors();
  }

  function wireAdvisors() {
    const dlg = $('#dlg-advisors');
    $$('[data-adv]', dlg).forEach((b) => {
      b.onclick = () => {
        const a = b.dataset.adv;
        if (a === 'close') dlg.close();
        else if (a === 'deck') { dlg.close(); openDeck(); }
        else if (a === 'next') { adv.result = null; state.statPrev = null; adv.i += 1; renderAdvisors(); }
        else if (a === 'prev') { adv.result = null; state.statPrev = null; adv.i = Math.max(0, adv.i - 1); renderAdvisors(); }
      };
    });
    const card = $('#adv-card');
    $$('[data-pick]', dlg).forEach((b) => {
      const who = b.dataset.pick;
      b.onpointerenter = () => { if (card) card.classList.add(`lean-${who}`); };
      b.onpointerleave = () => { if (card) card.classList.remove(`lean-${who}`); };
      b.onclick = async () => {
        const c = adv.cards[adv.i];
        $$('[data-pick]', dlg).forEach((x) => { x.disabled = true; });
        const before = statSnapshot();
        const r = await townPost('/town/decide', { issue_id: c.id, side: who }, b);
        if (!r) { $$('[data-pick]', dlg).forEach((x) => { x.disabled = false; }); return; }
        // Fly the card off toward the chosen side, then show the result.
        if (card && !REDUCED) {
          card.classList.remove('lean-preston', 'lean-dolores');
          card.classList.add(`fly-${who}`);
          await new Promise((res) => setTimeout(res, 420));
        }
        c.chosen = who;
        adv.result = { id: c.id, side: who, fx: r.fx || {}, noted: !!(r.noted), crowd: r.crowd || null, line: reaction(who) };
        state.statPrev = before;
        refreshVillage(r.town, r.user);
        adv.cards = state.me.town.issues.slice();
        renderAdvisors();
      };
    });
  }

  // "61% of players sided with Preston today." Only once a few have answered.
  function crowdLine(crowd, side) {
    if (!crowd) return '';
    const total = (crowd.preston || 0) + (crowd.dolores || 0);
    if (total < 3) return '';
    const mine = crowd[side] || 0;
    const pctMine = Math.round(mine / total * 100);
    const who = side === 'preston' ? 'Preston' : 'Dolores';
    return `<p class="muted small adv-crowd">${pctMine}% of the ${total} landlords who've answered this today went with ${who}${pctMine >= 50 ? '. Company.' : '. You and the brave few.'}</p>`;
  }

  // --- Assign lobbyists: move this quarter's between charities, set the default ---------------

  const assign = { alloc: new Map(), start: new Map(), pool: 0, def: null, startDef: null, order: [] };

  async function openAssign() {
    clearTimeout(state.flipTimer);
    try { await ensureCharities(); } catch (e) { toast(e.message); return; }
    const me = state.me;
    const now = new Map((me.donations_by_charity || []).filter((c) => c.amount > 0).map((c) => [c.id, round2(c.amount)]));
    assign.alloc = new Map(now); assign.start = new Map(now); assign.pool = 0;
    assign.def = me.user.charity_id || null; assign.startDef = assign.def;
    // Charities with your lobbyists first (biggest first), then the rest in list order.
    const has = [...now.keys()].sort((a, b) => now.get(b) - now.get(a));
    assign.order = [...has, ...state.charities.map((c) => c.id).filter((id) => !now.has(id))].filter((id) => state.charities.some((c) => c.id === id) || now.has(id));
    renderAssign();
    $('#assign-error').hidden = true;
    $('#dlg-assign').showModal();
  }

  function renderAssign() {
    const total = round2([...assign.start.values()].reduce((x, n) => x + n, 0));
    const name = (id) => (state.charities.find((c) => c.id === id) || (state.me.donations_by_charity || []).find((c) => c.id === id) || { name: 'A retired charity' }).name;
    const changed = assign.def !== assign.startDef || assign.order.some((id) => round2(assign.alloc.get(id) || 0) !== round2(assign.start.get(id) || 0));
    $('#assign-body').innerHTML = `
      <p class="assign-lede">${total > 0 ? `This quarter you have <b>${esc(lobby(total))}</b>. Move them wherever you like until Lobbyfest on ${esc(festDate(state.me.day.quarter_ends_at))}; after that they march, and the payroll starts fresh.` : `No lobbyists on the payroll this quarter yet. You can still pick where new ones go.`}</p>
      ${total > 0 ? `<div class="assign-pool ${assign.pool > 0.004 ? 'open' : ''}" aria-live="polite">${assign.pool > 0.004 ? `<b>${esc(lobby(assign.pool))}</b> waiting for a charity. Tap + to place them.` : 'Every lobbyist has a charity.'}</div>` : ''}
      <ul class="assign-list">${assign.order.map((id) => {
        const n = round2(assign.alloc.get(id) || 0);
        return `<li class="${n > 0 ? 'has' : ''} ${assign.def === id ? 'is-default' : ''}">
          <div class="al-name">
            <b>${esc(name(id))}</b>
            <label class="al-default"><input type="radio" name="al-default" value="${id}" ${assign.def === id ? 'checked' : ''}> ${assign.def === id ? 'New hires go here' : 'Make default'}</label>
          </div>
          ${total > 0 ? `<div class="al-step">
            <button type="button" class="al-btn" data-dec="${id}" ${n <= 0 ? 'disabled' : ''} aria-label="One fewer for ${esc(name(id))}">−</button>
            <b class="al-n">${esc(lobbyN(n))}</b>
            <button type="button" class="al-btn" data-inc="${id}" ${assign.pool <= 0.004 ? 'disabled' : ''} aria-label="One more for ${esc(name(id))}">+</button>
            <button type="button" class="linkish al-all" data-all="${id}" ${n >= total - 0.004 ? 'disabled' : ''}>All here</button>
          </div>` : ''}
        </li>`;
      }).join('')}</ul>`;
    const save = $('#assign-save');
    save.disabled = !changed || assign.pool > 0.004;
    save.textContent = assign.pool > 0.004 ? `Place ${lobby(assign.pool)} first` : changed ? 'Save' : 'No changes';
    const body = $('#assign-body');
    $$('[data-dec]', body).forEach((b) => { b.onclick = () => { const id = Number(b.dataset.dec), n = assign.alloc.get(id) || 0, d = Math.min(1, n); assign.alloc.set(id, round2(n - d)); assign.pool = round2(assign.pool + d); renderAssign(); }; });
    $$('[data-inc]', body).forEach((b) => { b.onclick = () => { const id = Number(b.dataset.inc), d = Math.min(1, assign.pool); assign.alloc.set(id, round2((assign.alloc.get(id) || 0) + d)); assign.pool = round2(assign.pool - d); renderAssign(); }; });
    $$('[data-all]', body).forEach((b) => { b.onclick = () => { const id = Number(b.dataset.all); for (const k of assign.order) assign.alloc.set(k, 0); assign.alloc.set(id, total); assign.pool = 0; renderAssign(); }; });
    $$('input[name="al-default"]', body).forEach((r) => { r.onchange = () => { assign.def = Number(r.value); renderAssign(); }; });
  }

  async function saveAssign() {
    const btn = $('#assign-save');
    if (btn.disabled || state.busy) return;
    const moved = assign.order.some((id) => round2(assign.alloc.get(id) || 0) !== round2(assign.start.get(id) || 0));
    const body = {};
    if (moved) body.allocation = assign.order.filter((id) => (assign.alloc.get(id) || 0) > 0).map((id) => ({ charity_id: id, amount: round2(assign.alloc.get(id)) }));
    if (assign.def !== assign.startDef && assign.def != null) body.default_charity_id = assign.def;
    state.busy = true; btn.disabled = true; btn.textContent = 'Saving…';
    try {
      const r = await API.post('/lobbyists/assign', body);
      state.me.donations_by_charity = r.donations_by_charity;
      $('#dlg-assign').close();
      refreshVillage(state.me.town, r.user);
      const defName = body.default_charity_id ? (state.charities.find((c) => c.id === body.default_charity_id) || {}).name : null;
      toast([r.moved > 0 ? `Moved ${lobby(r.moved)}.` : '', defName ? `New lobbyists now go to ${defName}.` : ''].filter(Boolean).join(' ') || 'Saved.', 3600);
    } catch (e) {
      const er = $('#assign-error'); er.textContent = e.message; er.hidden = false;
      btn.disabled = false; btn.textContent = 'Save';
    } finally { state.busy = false; }
  }

  // --- collect / sell sheet ----------------------------------------------------------------

  // The player's default charity: picked once, at the first cash-out, and
  // changed only from TrickleTown → Assign lobbyists.
  function defaultCharity() {
    const id = state.me && state.me.user.charity_id;
    return (id && state.charities.find((c) => c.id === id)) || null;
  }

  // Where new lobbyists go. With a default: one line saying so. Without one
  // (the first cash-out): pick it, which also sets it for every hire after.
  function assignBox({ hired, selectId, conditional = false }) {
    const def = defaultCharity();
    const who = hired > 0 ? esc(lobby(hired)) : 'new lobbyists';
    if (def) {
      return `
      <div class="assign assign-default">
        <div class="assign-head"><b>${conditional ? `If it lands as a profit, the lobbyists go to ${esc(def.name)}` : `Your ${who} go to ${esc(def.name)}`}</b></div>
        <p class="muted small">Your default charity. To move lobbyists or change the default, use <b>Assign lobbyists</b> at the bottom of TrickleTown.</p>
      </div>`;
    }
    const options = state.charities.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
    return `
      <div class="assign assign-first">
        <div class="assign-head"><b>Pick your charity</b></div>
        <p>${conditional ? 'If this lands as a profit, the tax hires lobbyists.' : `The tax hires ${who}.`} Lobbyists lobby for one charity, and at Lobbyfest the charity with the most lobbyists gets the biggest share of the real ad money. Whatever you pick here becomes your default: every lobbyist you hire goes there from now on.</p>
        <label class="field charity-pick"><span>Lobby for</span><select id="${selectId}" required><option value="" disabled selected>Choose a charity…</option>${options}</select></label>
        <p class="muted small">You can move lobbyists between charities, or change the default, anytime from TrickleTown → Assign lobbyists.</p>
      </div>`;
  }
  // A first-cash-out picker must be answered before the button works.
  function requirePick(selectId, buttons) {
    const sel = $(`#${selectId}`);
    if (!sel) return;
    const sync = () => buttons.forEach((b) => { if (b) b.disabled = !sel.value; });
    sync();
    sel.onchange = sync;
  }

  async function openSell(id, opts = {}) {
    const p = state.me.positions.find((x) => x.id === id);
    if (!p || p.quote_error) return;
    try { await ensureAssets(); } catch (e) { toast(e.message); return; }
    state.sell = p;
    const s = p.preview;
    const win = s.profit > 0, bust = p.busted, mat = p.matured;
    const tierClass = bust || s.profit < 0 ? 'loss' : win ? 'win' : '';
    const rate = Math.round(state.me.rules.tax_rate * 100);
    const rateNow = state.me.town ? state.me.town.hire_cost : 1;
    // s.tax is the whole bill: tax on this position's own profit, plus any
    // deferred ride tax that comes due because this is an early sell.
    const deferred = s.deferred_tax || 0;
    const ownTax = round2(s.tax - deferred);
    const taxed = s.tax > 0;
    const hired = taxed ? round2(s.tax / rateNow) : 0;
    const rm = mat && !bust ? rideMults(p) : null;
    // Riding a winner is taxed too, at half the rate.
    const rideFactor = state.me.rules.ride_tax_factor != null ? state.me.rules.ride_tax_factor : 0.5;
    const rideRate = Math.round(state.me.rules.tax_rate * rideFactor * 1000) / 10;
    const rideTax = win ? round2(s.profit * state.me.rules.tax_rate * rideFactor) : 0;
    const rideHired = win ? round2(rideTax / rateNow) : 0;
    const verb = bust ? 'Bury it' : mat ? 'Collect' : 'Sell early';

    $('#sell-title').textContent = verb;
    $('#sell-body').innerHTML = `
      <div class="receipt-tier ${tierClass}">${esc(s.tier)}.</div>
      <ul class="receipt">
        <li><span>You put in${mat ? '' : `, ${ago(p.opened_at)}`}</span><b>${money(p.invested)}</b></li>
        <li><span>${esc(p.name)} moved ${pct(p.real_pct)}, at ${mult(p.multiplier_now)}${mat ? '' : ` (${mult(p.multiplier)} in ${left(p.matures_at)})`}</span><b class="${dir(p.swing_pct)}">${pct(p.swing_pct, 0)}</b></li>
        <li><span>${mat ? 'Worth at maturity' : 'Worth right now'}</span><b>${money(p.value)}</b></li>
        ${win ? `<li><span>Tax, ${rate}% of the ${money(s.profit)} profit${deferred > 0 ? '' : `. Hires ${esc(lobby(hired))}`}</span><b>${money(ownTax)}</b></li>` : ''}
        ${!win && s.profit < 0 ? `<li><span>Loss. Not taxed.</span><b class="down">${money(s.profit)}</b></li>` : ''}
        ${deferred > 0 ? `<li><span>Deferred ride tax, due on an early sale. ${win ? 'Together they hire' : 'Hires'} ${esc(lobby(hired))}</span><b>${money(deferred)}</b></li>` : ''}
        <li class="total"><span>Back onto the coin</span><b>${money(s.net)}</b></li>
      </ul>
      ${taxed ? `<div class="hire-row">
        <div class="hire-side"><span class="muted">${money(s.tax)} of tax</span>${billsRow(s.tax, { max: 12 })}</div>
        <span class="hire-arrow" aria-hidden="true">→</span>
        <div class="hire-side"><span class="muted">${esc(lobby(hired))} at ${money(rateNow)} each</span>${lobbyists(hired, { max: 12 })}</div>
      </div>` : ''}
      ${taxed || (!mat && !bust) ? assignBox({ hired, selectId: 'sell-charity', conditional: !taxed }) : ''}
      ${!mat && !bust ? `<p class="muted small">Or wait: in ${left(p.matures_at)} it matures at ${mult(p.multiplier)}${deferred > 0 ? ` and the ${money(deferred)} of deferred ride tax is forgiven` : ''}. The sale happens at the market price when you tap.</p>` : ''}
      ${mat && !bust ? `<div class="ride-box">
        <b>Or let it ride.</b>
        <span>${win
          ? `Pay half the tax now (${rideRate}%: ${money(rideTax)} hires ${esc(lobby(rideHired))}) and put ${money(p.value - rideTax)} back on ${esc(p.name)} for another ${state.me.rules.hold_hours} hours at ${mult(rm.floor)}→${mult(rm.ceiling)}. The other ${money(rideTax)} is due if you sell the ride early, forgiven if it matures.`
          : `Put the whole ${money(p.value)} back on ${esc(p.name)} for another ${state.me.rules.hold_hours} hours at ${mult(rm.floor)}→${mult(rm.ceiling)}. No profit, so no tax.`}${rm.capped ? ' That is the ceiling.' : ''} It can still go to zero, faster.</span>
        <button type="button" class="btn small" id="sell-ride">${win ? `Ride with ${money(p.value - rideTax)}` : 'Let it ride'}</button>
      </div>` : ''}
      ${mat && bust ? `<p class="muted small">Nothing left to ride. Burying it clears the spot.</p>` : ''}`;
    $('#sell-error').hidden = true;
    $('#sell-submit').disabled = false;
    $('#sell-submit').textContent = bust ? 'Bury it' : mat ? `Collect ${money(s.net)}` : `Sell early for about ${money(s.net)}`;
    const rideBtn = $('#sell-ride');
    if (rideBtn) rideBtn.onclick = () => { const sel = $('#sell-charity'); $('#dlg-sell').close(); ride(p.id, sel && sel.value ? Number(sel.value) : undefined); };
    requirePick('sell-charity', [$('#sell-submit'), win ? rideBtn : null]);
    $('#dlg-sell').showModal();
    if (opts.ride && rideBtn) { rideBtn.closest('.ride-box').scrollIntoView({ block: 'center' }); rideBtn.focus(); }
  }

  async function ride(id, charity_id) {
    const p = state.me.positions.find((x) => x.id === id);
    if (!p || state.busy) return;
    state.busy = true;
    try {
      const r = await API.post('/ride', { position_id: id, charity_id });
      const ro = r.rolled;
      const hours = state.me.rules.hold_hours;
      const msg = ro.tax > 0
        ? `Riding at ${mult(ro.mult_floor)}→${mult(ro.multiplier)}. ${Math.round(ro.rate * 1000) / 10}% tax on the ${money(ro.profit)} profit hired ${lobby(ro.lobbyists)}${ro.charity ? ` for ${ro.charity.name}` : ''}; ${money(ro.net)} rides on ${p.name} at ${price(r.quote.price)} for another ${hours} hours. ${money(ro.deferred)} deferred.`
        : `Riding at ${mult(ro.mult_floor)}→${mult(ro.multiplier)}. ${money(ro.value)} back on ${p.name} at ${price(r.quote.price)} for another ${hours} hours. No profit, so nobody got hired.`;
      toast(msg, 5000);
      await loadMe();
      const row = $(`.position[data-id="${r.position.id}"]`);
      if (row) row.classList.add('fresh');
    } catch (e) { toast(e.message, 4000); }
    finally { state.busy = false; }
  }

  async function submitSell(ev) {
    ev.preventDefault();
    if (state.busy || !state.sell) return;
    const p = state.sell;
    const sel = $('#sell-charity');
    const charity_id = sel && sel.value ? Number(sel.value) : undefined;
    state.busy = true; $('#sell-submit').disabled = true; $('#sell-submit').textContent = p.matured ? 'Collecting…' : 'Selling…';
    try {
      const r = await API.post('/sell', { position_id: p.id, charity_id });
      $('#dlg-sell').close();
      const rc = r.receipt;
      // Shrink the wedge back into bills, then refresh.
      await animateWedge(p.id, 1, 0, 420);
      await loadMe();
      const how = rc.collected ? 'Collected' : rc.busted ? 'Buried' : 'Sold early';
      if (rc.tax > 0) {
        const hiredNow = rc.lobbyists != null ? rc.lobbyists : rc.tax;
        const t = state.me.town;
        if (t && t.unlocked && !Explainer.seen('town')) {
          // The hire that opened the town: a ceremony, then a clear "flip the
          // coin" before the tour, so nobody mistakes the tour for orientation.
          openHireCeremony(rc, hiredNow, how);
        } else {
          toast(`${rc.tier}. ${how}: ${money(rc.tax)} of tax hired ${lobby(hiredNow)} for ${rc.charity.name}. They're moving into TrickleTown.`, 4200);
          // Watch them arrive, then stay: the switch under the coin goes back.
          flip(true);
          await hireAnimation(hiredNow);
        }
      } else {
        toast(rc.busted ? `${rc.tier}. ${p.symbol} is in the ground.` : `${rc.tier}. ${how} for ${money(rc.net)}, back on the coin.`);
      }
    } catch (e) {
      $('#sell-error').textContent = e.message; $('#sell-error').hidden = false;
      $('#sell-submit').disabled = false; $('#sell-submit').textContent = 'Try again';
    } finally { state.busy = false; }
  }

  // --- Achievements --------------------------------------------------------------------------
  //
  // Rare milestones. Each comes with a gift from Mommy & Daddy, taxed like any
  // win (so it hires lobbyists). The server records them as they're earned;
  // the popup is where the player takes the money.
  const achOf = (me, key) => (me && me.achievements ? me.achievements.list.find((a) => a.key === key) : null);
  const unclaimedKeys = (me) => (me && me.achievements ? me.achievements.unclaimed : []);
  // Before the first buy, the first-investment guide owns the screen.
  const isFirstTime = (me) => { const fb = achOf(me, 'first_buy'); return !!fb && !fb.earned_at; };
  const TROPHY = (cls = '') => `<svg class="trophy ${cls}" viewBox="0 0 64 64" aria-hidden="true"><path class="t-cup" d="M18 8h28v14a14 14 0 0 1-28 0V8z"/><path class="t-handle" d="M18 13H9v3a9 9 0 0 0 9 9M46 13h9v3a9 9 0 0 1-9 9"/><path class="t-stem" d="M28 35h8v9h-8z"/><path class="t-base" d="M20 44h24v8H20z"/><path class="t-shine" d="M24 12v9"/></svg>`;

  function renderTrophyCount() {
    const a = state.me && state.me.achievements;
    const btn = $('#btn-trophies');
    if (!btn || !a) return;
    $('#trophy-count').textContent = `${a.earned}/${a.total}`;
    btn.classList.toggle('waiting', a.unclaimed.length > 0);
    btn.setAttribute('aria-label', `Achievements: ${a.earned} of ${a.total}${a.unclaimed.length ? `, ${a.unclaimed.length} gift waiting` : ''}`);
  }

  // Pop the first unclaimed achievement, once per page load per achievement,
  // when nothing else is on screen. If it's closed, the to-do strip and the
  // trophy button keep it.
  function maybeAchievement(delay = 0) {
    setTimeout(() => {
      const key = unclaimedKeys(state.me).find((k) => !state.achShown.has(k));
      if (!key || $('dialog[open]') || Explainer.isOpen() || state.tab === 'welcome') return;
      openAchievement(key);
    }, delay);
  }

  // After something that might have earned one without reloading /me (a
  // building, a friend), ask the server and pop it if so.
  async function refreshAchievements(delay = 600) {
    if (!state.me) return;
    try { state.me.achievements = await API.get('/achievements'); } catch (e) { return; }
    renderTrophyCount();
    maybeAchievement(delay);
  }

  function announceCards(titles) {
    if (!titles || !titles.length) return;
    toast(titles.length === 1 ? `New card unlocked: “${titles[0]}”. It's on today's agenda at Town Hall.` : `${titles.length} new cards unlocked and dealt for today: ${titles.map((x) => `“${x}”`).join(', ')}.`, 4800);
  }

  async function openAchievement(key) {
    const a = achOf(state.me, key);
    if (!a || !a.earned_at || a.claimed_at || $('#dlg-ach').open) return;
    state.achShown.add(key);
    try { await ensureCharities(); } catch (e) { /* the picker comes up empty; the server picks */ }
    const rate = state.me.rules.tax_rate, rateNow = state.me.town ? state.me.town.hire_cost : 1;
    const tax = round2(a.gift * rate), net = round2(a.gift - tax), hired = round2(tax / rateNow);
    const n = state.me.achievements.earned;
    $('#ach-body').innerHTML = `
      <div class="ach-burst">
        <div class="ach-rays" aria-hidden="true"></div>
        <div class="ach-confetti" aria-hidden="true">${Array.from({ length: 14 }, (_, i) => `<i style="--x:${(i * 37) % 100}%;--d:${(i % 7) * 0.18}s;--r:${(i * 53) % 360}deg"></i>`).join('')}</div>
        ${TROPHY('ach-trophy')}
        <div class="ach-eyebrow">Achievement unlocked</div>
        <h2 class="ach-title">${esc(a.title)}</h2>
        <div class="ach-how">${esc(a.how)}</div>
        <div class="ach-count">${n} of ${state.me.achievements.total}</div>
      </div>
      <div class="ach-note">
        <div class="ach-note-head"><span>A little something from Mommy &amp; Daddy</span><b>${money(a.gift, { whole: true })}</b></div>
        <p>“${esc(a.note)}”</p>
        <span class="ach-sign">— ${esc(a.from)}</span>
      </div>
      <ul class="receipt ach-receipt">
        <li><span>The gift. A bonus, pure profit.</span><b class="up">${money(a.gift)}</b></li>
        <li><span>Tax, ${Math.round(rate * 100)}%, like any win. Hires ${esc(lobby(hired))}</span><b>${money(tax)}</b></li>
        <li class="total"><span>Onto your coin as bills</span><b>${money(net)}</b></li>
      </ul>
      ${assignBox({ hired, selectId: 'ach-charity' })}
      <button type="button" class="btn primary wide ach-take" id="ach-claim">Thanks, ${esc(a.from)}</button>
      <p class="muted small ach-fine">Achievements are rare. Each one comes with a gift. Nothing about this is normal; everything about it is legal.</p>`;
    $('#dlg-ach').showModal();
    $('#ach-claim').onclick = () => claimAchievement(key);
    requirePick('ach-charity', [$('#ach-claim')]);
  }

  async function claimAchievement(key) {
    if (state.busy) return;
    state.busy = true;
    const btn = $('#ach-claim'); btn.disabled = true; btn.textContent = 'Depositing…';
    try {
      const sel = $('#ach-charity');
      const r = await API.post('/achievements/claim', { key, charity_id: sel && sel.value ? Number(sel.value) : undefined });
      $('#dlg-ach').close();
      await loadMe();
      const rc = r.receipt;
      const hiredNow = rc.lobbyists || 0;
      const t = state.me.town;
      if (hiredNow > 0 && t && t.unlocked && !Explainer.seen('town')) openHireCeremony(rc, hiredNow, 'Gift');
      else {
        toast(`${money(rc.net)} onto the coin.${hiredNow > 0 && rc.charity ? ` ${money(rc.tax)} of tax hired ${lobby(hiredNow)} for ${rc.charity.name}.` : ''}`, 4200);
        maybeAchievement(REDUCED ? 300 : 1400); // another one waiting?
      }
    } catch (e) {
      toast(e.message, 4000); btn.disabled = false; btn.textContent = 'Try again';
    } finally { state.busy = false; }
  }

  async function openTrophies() {
    const me = state.me; if (!me || !me.achievements) return;
    const A = me.achievements;
    const date = (iso) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const row = (a) => {
      const status = a.claimed_at ? 'claimed' : a.earned_at ? 'waiting' : 'locked';
      const pr = a.progress && a.progress.need > 1 ? a.progress : null;
      return `<li class="tro ${status}">
        ${TROPHY(status === 'locked' ? 'dim' : '')}
        <div class="tro-main">
          <b>${esc(a.title)}</b>
          <span class="tro-how">${esc(a.how)}</span>
          ${status === 'claimed' ? `<span class="tro-meta">Earned ${date(a.earned_at)} · ${money(a.gift, { whole: true })} from ${esc(a.from)}${a.lobbyists ? ` · hired ${esc(lobby(a.lobbyists))}` : ''}</span>`
            : status === 'waiting' ? `<button type="button" class="btn small primary" data-open-gift="${esc(a.key)}">Open ${esc(a.from)}'s gift: ${money(a.gift, { whole: true })}</button>`
            : `<span class="tro-meta">Gift: ${money(a.gift, { whole: true })} from ${esc(a.from)}</span>${pr ? `<span class="tro-prog"><i style="--w:${Math.round((pr.have / pr.need) * 100)}%"></i></span><span class="tro-meta">${pr.money ? `${money(pr.have)} of ${money(pr.need)}` : `${pr.have} of ${pr.need}`}</span>` : ''}`}
        </div>
      </li>`;
    };
    const order = [...A.list].sort((x, y) => (x.claimed_at ? 1 : x.earned_at ? 0 : 2) - (y.claimed_at ? 1 : y.earned_at ? 0 : 2));
    $('#trophies-body').innerHTML = `
      <p class="tro-lede"><b>${A.earned} of ${A.total}.</b> Rare on purpose. Each one comes with a gift from Mommy &amp; Daddy, taxed like any win.</p>
      <ul class="tro-list">${order.map(row).join('')}</ul>`;
    $$('[data-open-gift]', $('#trophies-body')).forEach((b) => { b.onclick = () => { $('#dlg-trophies').close(); openAchievement(b.dataset.openGift); }; });
    $('#dlg-trophies').showModal();
  }

  // The first lobbyist: the tax walks across the desk and comes out a person,
  // the player reads what just happened, and chooses to flip the coin. The
  // TrickleTown tour opens after the flip, not before.
  function openHireCeremony(rc, hiredNow, how) {
    const count = Math.min(10, Math.max(1, Math.ceil(hiredNow - 1e-9)));
    const dlg = $('#dlg-hire');
    $('#hire-title').textContent = hiredNow >= 2 ? 'Your first lobbyists' : 'Your first lobbyist';
    $('#hire-body').innerHTML = `
      <div class="receipt-tier win">${esc(rc.tier)}.</div>
      <p>${rc.gift ? `${esc(rc.achievement ? rc.achievement.from : 'Daddy')}'s gift for <b>${esc(rc.name)}</b>: ${money(rc.profit)} of pure profit` : rc.vested ? `Your Trickle Down Holdings shares sold for ${money(rc.profit)} of pure profit` : `${how} ${esc(rc.symbol)}: ${money(rc.profit)} of profit`}, ${money(rc.tax)} of it taxed. Not to the government. To your recruiter.</p>
      <div class="hire-scene" aria-hidden="true">
        <div class="hire-from">${billsRow(Math.max(1, rc.tax), { max: count })}</div>
        <div class="hire-desk"><b>RECRUITER</b><span>${money(rc.hire_cost || 1)} a head</span></div>
        <div class="hire-to">${lobbyists(hiredNow, { max: count })}</div>
      </div>
      <p class="hire-line"><b>${esc(lobby(hiredNow))}</b> hired for <b>${esc(rc.charity.name)}</b>. They've moved into <b>TrickleTown</b>, the company town on the other side of your coin. You own it. They'd like a word.</p>
      <button type="button" class="btn primary wide" id="hire-flip">Meet them in TrickleTown</button>
      <button type="button" class="linkish center" id="hire-later">Later</button>`;
    dlg.showModal();
    const targets = $$('#hire-body .hire-to .lobbyist');
    targets.forEach((t) => t.classList.add('arriving'));
    setTimeout(() => deskAnimation(targets), REDUCED ? 0 : 350);
    $('#hire-later').onclick = () => { dlg.close(); renderUnder(); };
    $('#hire-flip').onclick = async () => {
      dlg.close();
      state.ceremony = true; // the flip must not start the tour; we do, after the bills land
      try { flip(true); await hireAnimation(hiredNow); } finally { state.ceremony = false; }
      maybeTownIntro(300);
    };
  }

  // Inside the ceremony: each bill crosses the desk and unfolds into a person.
  async function deskAnimation(targets) {
    const from = $('#hire-body .hire-from');
    if (!from || !targets.length) return;
    if (REDUCED) { targets.forEach((t) => t.classList.remove('arriving')); return; }
    const bills = $$('.billsvg', from);
    const flights = targets.map((t, i) => new Promise((resolve) => {
      const b = bills[Math.min(i, bills.length - 1)];
      const r0 = b.getBoundingClientRect(), r1 = t.getBoundingClientRect();
      const fly = document.createElement('div');
      fly.className = 'flyer';
      fly.innerHTML = `<span class="fly-bill">${BILL}</span><span class="fly-person">${LOBBYIST}</span>`;
      fly.style.left = `${r0.left}px`; fly.style.top = `${r0.top}px`;
      document.body.appendChild(fly);
      const dx = r1.left - r0.left, dy = r1.top - r0.top;
      const delay = i * 140, dur = 1100;
      const path = fly.animate(
        [{ transform: 'translate(0,0)', opacity: 1, offset: 0 }, { transform: `translate(${dx * 0.5}px, ${dy * 0.5 - 26}px) scale(1.15)`, opacity: 1, offset: 0.5 }, { transform: `translate(${dx}px, ${dy}px)`, opacity: 1, offset: 1 }],
        { duration: dur, delay, easing: 'cubic-bezier(.3,.1,.3,1)', fill: 'forwards' },
      );
      fly.querySelector('.fly-bill').animate(
        [{ transform: 'rotateY(0deg)', opacity: 1, offset: 0 }, { transform: 'rotateY(0deg)', opacity: 1, offset: 0.42 }, { transform: 'rotateY(90deg)', opacity: 0, offset: 0.58 }, { transform: 'rotateY(90deg)', opacity: 0, offset: 1 }],
        { duration: dur, delay, fill: 'forwards' },
      );
      fly.querySelector('.fly-person').animate(
        [{ transform: 'rotateY(-90deg)', opacity: 0, offset: 0 }, { transform: 'rotateY(-90deg)', opacity: 0, offset: 0.56 }, { transform: 'rotateY(0deg)', opacity: 1, offset: 0.74 }, { transform: 'rotateY(0deg)', opacity: 1, offset: 1 }],
        { duration: dur, delay, fill: 'forwards' },
      );
      const done = () => { t.classList.remove('arriving'); fly.remove(); resolve(); };
      path.finished.then(done).catch(done);
    }));
    await Promise.all(flights);
  }

  // Bills fly out of the coin into the payroll row and turn into lobbyists on the way.
  async function hireAnimation(n) {
    const coin = $('#coin');
    const row = $('#under .lobby-row .lobbyists');
    if (!coin || !row) return;
    const count = Math.min(12, Math.ceil(n - 1e-9));
    const targets = $$('.lobbyist', row).slice(-count);
    if (REDUCED || !targets.length) return;
    targets.forEach((t) => t.classList.add('arriving'));
    await new Promise((r) => setTimeout(r, 650)); // let the flip finish
    const c = coin.getBoundingClientRect();
    const x0 = c.left + c.width / 2 - 8, y0 = c.top + c.height / 2 - 16;
    const flights = targets.map((t, i) => new Promise((resolve) => {
      const r = t.getBoundingClientRect();
      const fly = document.createElement('div');
      fly.className = 'flyer';
      fly.innerHTML = `<span class="fly-bill">${BILL}</span><span class="fly-person">${LOBBYIST}</span>`;
      fly.style.left = `${x0}px`; fly.style.top = `${y0}px`;
      document.body.appendChild(fly);
      const dx = r.left - x0, dy = r.top - y0;
      const delay = i * 70, dur = 950;
      const path = fly.animate(
        [
          { transform: 'translate(0,0) scale(1.2)', opacity: 0, offset: 0 },
          { transform: `translate(${dx * 0.1}px, ${dy * 0.1 - 40}px) scale(1.25)`, opacity: 1, offset: 0.12 },
          { transform: `translate(${dx * 0.55}px, ${dy * 0.45 - 70}px) scale(1.1)`, opacity: 1, offset: 0.55 },
          { transform: `translate(${dx}px, ${dy}px) scale(1)`, opacity: 1, offset: 1 },
        ],
        { duration: dur, delay, easing: 'cubic-bezier(.3,.1,.3,1)', fill: 'forwards' },
      );
      // Mid-flight: the bill folds away, the person unfolds.
      fly.querySelector('.fly-bill').animate(
        [{ transform: 'rotateY(0deg)', opacity: 1, offset: 0 }, { transform: 'rotateY(0deg)', opacity: 1, offset: 0.4 }, { transform: 'rotateY(90deg)', opacity: 0, offset: 0.58 }, { transform: 'rotateY(90deg)', opacity: 0, offset: 1 }],
        { duration: dur, delay, fill: 'forwards' },
      );
      fly.querySelector('.fly-person').animate(
        [{ transform: 'rotateY(-90deg)', opacity: 0, offset: 0 }, { transform: 'rotateY(-90deg)', opacity: 0, offset: 0.56 }, { transform: 'rotateY(0deg)', opacity: 1, offset: 0.74 }, { transform: 'rotateY(0deg)', opacity: 1, offset: 1 }],
        { duration: dur, delay, fill: 'forwards' },
      );
      path.finished.then(() => { t.classList.remove('arriving'); fly.remove(); resolve(); }).catch(() => { t.classList.remove('arriving'); fly.remove(); resolve(); });
    }));
    await Promise.all(flights);
  }

  // --- share --------------------------------------------------------------------------------

  async function share() {
    const me = state.me;
    if (!me) return;
    const emoji = (p) => (p.busted ? '💀' : p.swing_pct > 0 ? '📈' : p.swing_pct < 0 ? '📉' : '➖');
    const open = me.positions.map((p) => `${emoji(p)} ${p.symbol} ${p.busted ? 'RIP' : pct(p.swing_pct, 0)}${p.matured ? ' (ready)' : ''}`);
    const locked = me.history.filter((h) => h.closed_day === me.day.key)
      .map((h) => { const hired = h.lobbyists != null ? h.lobbyists : h.tax; return `🔒 ${h.symbol} ${h.tier}${hired > 0 ? ` → ${lobby(hired)} for ${h.charity_name}` : ''}`; });
    const lines = [
      `Trickle Down #${me.day.number}`,
      me.today_donated > 0 ? `🕴️ ${lobby(me.today_donated)} hired today` : '🕴️ No lobbyists hired yet today',
      ...locked.slice(0, 4),
      ...open.slice(0, 5),
      me.user.streak > 1 ? `🔥 ${me.user.streak}-day streak` : null,
      !me.user.is_guest ? `🤝 Add me: ${me.user.username}` : null,
      SITE,
    ].filter(Boolean);
    const text = lines.join('\n');
    try {
      if (navigator.share) await navigator.share({ text });
      else { await navigator.clipboard.writeText(text); toast('Copied. Go brag.'); }
    } catch (e) { /* user cancelled */ }
  }

  // --- the lobby --------------------------------------------------------------------------------

  async function loadTrickle() {
    const el = $('#screen-trickle');
    el.innerHTML = `<h1>The lobby</h1><p class="lede">Loading…</p>`;
    try {
      const t = await API.get('/trickle');
      const max = Math.max(...t.charities.map((c) => c.share), 0.0001);
      el.innerHTML = `
        <h1>The lobby</h1>
        <p class="lede">Where the real money goes. At Lobbyfest, ${t.demo ? 'the' : "this site's"} ad money is split between these charities by how many lobbyists each has.</p>
        ${t.demo ? `<div class="note warn">Demo: the charities are made up and no real money is moving yet.</div>` : ''}
        <div class="lobby-stats">
          <div><b>${esc(lobbyN(t.quarter_total))}</b><span>lobbyists this quarter, from ${t.quarter_donors} player${t.quarter_donors === 1 ? '' : 's'}</span></div>
          <div><b data-fest="${esc(t.quarter_ends_at)}">${esc(untilLong(t.quarter_ends_at))}</b><span>until Lobbyfest, ${esc(festDate(t.quarter_ends_at))}</span></div>
          <div><b>${money(t.pool_usd, { whole: true })}</b><span>${t.demo ? 'pretend' : 'real'} ad money in the pool</span></div>
        </div>
        <ul class="charities">
          ${t.charities.map((c) => `
            <li class="charity">
              <div class="charity-top">
                ${c.url ? `<a class="name" href="${esc(c.url)}" target="_blank" rel="noopener">${esc(c.name)}</a>` : `<span class="name">${esc(c.name)}</span>`}
                <b>${Math.round(c.share * 100)}%</b>
              </div>
              <div class="charity-bar"><i style="--w:${(c.share / max * 100).toFixed(1)}%"></i></div>
              <div class="charity-sub">
                <span>${esc(lobby(c.quarter_total))} from ${c.quarter_donors} player${c.quarter_donors === 1 ? '' : 's'}</span>
                <span>${t.pool_usd > 0 ? `would get ${money(c.est_usd)}` : ''}</span>
              </div>
              <p class="blurb">${esc(c.blurb)}</p>
            </li>`).join('')}
        </ul>
        <p class="muted small">Every quarter starts at zero. Career totals and ranks carry over.</p>`;
    } catch (e) {
      el.innerHTML = `<h1>The lobby</h1><p class="lede">${esc(e.message)}</p>`;
    }
  }

  // --- leaders ----------------------------------------------------------------------------------

  // Leaders: the boards (everyone, or just your friends), and the friends
  // list itself. Adding a friend is one-way: you see them, they don't see you
  // until they add you back. Usernames link to a player sheet.
  const leaders = { scope: 'all' };

  const playerLink = (name, cls = '') => `<a href="#" class="player-link ${cls}" data-player="${esc(name)}">${esc(name)}</a>`;

  async function loadLeaders() {
    const el = $('#screen-leaders');
    el.innerHTML = `<h1>Leaders</h1><p class="lede">Loading…</p>`;
    const signedIn = !!(state.me && API.token());
    try {
      const friendsOnly = leaders.scope === 'friends' && signedIn;
      const [b, f] = await Promise.all([
        API.get(friendsOnly ? '/leaderboard?friends=1' : '/leaderboard'),
        signedIn ? API.get('/friends').catch(() => null) : Promise.resolve(null),
      ]);
      const meName = state.me ? state.me.user.username : null;
      const rowCls = (u) => (u === meName ? 'me' : '');
      const friends = f ? f.friends : [];
      el.innerHTML = `
        <h1>Leaders</h1>
        ${signedIn ? `<div class="scope-toggle" role="tablist">
          <button class="chip ${friendsOnly ? '' : 'on'}" data-scope="all" role="tab">Everyone</button>
          <button class="chip ${friendsOnly ? 'on' : ''}" data-scope="friends" role="tab">Friends${friends.length ? ` (${friends.length + 1})` : ''}</button>
        </div>` : ''}
        <h2 class="board-h">Lobbyfest standings <span class="muted">${friendsOnly ? 'friends · ' : ''}marching in ${esc(untilLong(b.quarter_ends_at))}</span></h2>
        ${b.all_time.length ? `
        <table class="board board-fold">
          <thead><tr><th></th><th>Player</th><th class="num">This quarter</th><th class="num">Career</th><th class="num">Streak</th></tr></thead>
          <tbody>${b.all_time.map((r, i) => `
            <tr class="${i >= 10 && r.username !== meName ? 'fold' : ''}"><td class="rank">${i + 1}</td><td class="${rowCls(r.username)}">${playerLink(r.username)}</td><td class="num">${esc(lobbyN(r.quarter || 0))}</td><td class="num muted">${esc(lobbyN(r.donated))}</td><td class="num">${r.streak}</td></tr>`).join('')}
          </tbody>
        </table>` : `<p class="muted">${friendsOnly ? 'None of your friends have hired anyone this quarter. Lead by example.' : 'Nobody has collected a profit yet. The board is yours.'}</p>`}

        <h2 class="board-h">Best cash-out <span class="muted">last 24 hours</span></h2>
        ${b.last_24h.length ? `
        <table class="board board-fold">
          <thead><tr><th></th><th>Player</th><th>Trade</th><th class="num">Gain</th></tr></thead>
          <tbody>${b.last_24h.map((r, i) => `
            <tr class="${i >= 10 && r.username !== meName ? 'fold' : ''}">
              <td class="rank">${i + 1}</td>
              <td class="${rowCls(r.username)}">${playerLink(r.username)}</td>
              <td><span class="tier">${esc(r.tier)}</span>${esc(r.symbol)} ${money(r.invested)} → ${money(r.proceeds)}</td>
              <td class="num ${dir(r.gain_pct)}">${pct(r.gain_pct, 0)}</td>
            </tr>`).join('')}
          </tbody>
        </table>` : `<p class="muted">No cash-outs in the last day.</p>`}

        <h2 class="board-h">Biggest positions <span class="muted">right now</span></h2>
        ${b.biggest && b.biggest.length ? `
        <table class="board board-biggest board-fold">
          <thead><tr><th></th><th>Player</th><th>Position</th><th class="num">Worth</th></tr></thead>
          <tbody>${b.biggest.map((r, i) => `
            <tr class="${i >= 10 && r.username !== meName ? 'fold' : ''}">
              <td class="rank">${i + 1}</td>
              <td class="${rowCls(r.username)}">${playerLink(r.username)}</td>
              <td><b>${esc(r.symbol)}</b> <span class="muted">${money(r.invested)} in${r.multiplier_now ? ` · ${mult(r.multiplier_now)}` : ''}${r.matured ? ' · matured' : r.ride_count ? ' · riding' : ''}</span></td>
              <td class="num"><b>${money(r.value)}</b>${r.priced && r.swing_pct != null ? ` <span class="${dir(r.swing_pct)} small">${pct(r.swing_pct, 0)}</span>` : ''}</td>
            </tr>`).join('')}
          </tbody>
        </table>
        ` : `<p class="muted">${friendsOnly ? 'None of your friends are holding anything right now.' : 'Nobody is holding anything right now.'}</p>`}

        <section class="friends">
          <h2>Friends</h2>
          ${!signedIn ? `<p class="muted">Sign in to add friends and see what they're holding.</p>` : `
          <form class="friend-add" id="friend-add" autocomplete="off">
            <input id="friend-name" type="text" placeholder="Add by username" maxlength="20" spellcheck="false" aria-label="Username to add">
            <button class="btn small primary" type="submit">Add</button>
          </form>
          <p class="muted friend-hint">${f && f.is_guest ? `You're a guest, so nobody can add <i>you</i> back. Claim your account to get a username worth sharing.` : `Your username is <b>${esc(f ? f.your_username : meName)}</b>. ${f && f.added_you ? `${f.added_you} player${f.added_you === 1 ? ' has' : 's have'} added you.` : 'Share it and get added.'} Friends are one-way; they see you only if they add you back.`}</p>
          ${friends.length ? `<ul class="friend-list">${friends.map((u) => `
            <li class="friend" data-player="${esc(u.username)}">
              <div class="friend-main">
                <b>${esc(u.username)}</b>
                <span class="muted">${u.badges && u.badges.earned.length ? esc(u.badges.earned[u.badges.earned.length - 1].name) : 'No rank yet'} · ${esc(lobby(u.quarter_donated))} this quarter · ${u.streak}-day streak</span>
                ${u.town ? `<span class="muted friend-town">Town: ${Math.round(u.town.happiness)} happy. “${esc(u.town.motto)}”</span>` : `<span class="muted friend-town">No village yet.</span>`}
              </div>
              <span class="muted friend-seen">${esc(u.last_seen || '')}</span>
              <button class="btn quiet small" data-unfriend="${esc(u.username)}" title="Remove">×</button>
            </li>`).join('')}</ul>` : `<p class="muted">No friends yet. Ask someone for their username${API.demo ? ' (in the demo, try <b>ravi_k</b> or <b>bagholder_ben</b>)' : ''}.</p>`}`}
        </section>`;
      $$('#screen-leaders [data-scope]').forEach((btn) => { btn.onclick = () => { leaders.scope = btn.dataset.scope; loadLeaders(); }; });
      // Ten rows per board; the rest behind one tap.
      $$('#screen-leaders .board-fold').forEach((tbl) => {
        const hidden = tbl.querySelectorAll('tr.fold').length;
        if (!hidden) return;
        const more = document.createElement('button'); more.type = 'button'; more.className = 'linkish board-more'; more.textContent = `Show ${hidden} more`;
        more.onclick = () => { tbl.querySelectorAll('tr.fold').forEach((tr) => tr.classList.remove('fold')); more.remove(); };
        tbl.insertAdjacentElement('afterend', more);
      });
      $$('#screen-leaders .player-link').forEach((a) => { a.onclick = (ev) => { ev.preventDefault(); openPlayer(a.dataset.player); }; });
      $$('#screen-leaders .friend').forEach((li) => { li.onclick = (ev) => { if (ev.target.closest('[data-unfriend]')) return; openPlayer(li.dataset.player); }; });
      $$('#screen-leaders [data-unfriend]').forEach((btn) => {
        btn.onclick = async (ev) => {
          ev.stopPropagation();
          try { await API.post('/friends/remove', { username: btn.dataset.unfriend }); toast(`${btn.dataset.unfriend} removed. They'll never know.`); await loadLeaders(); } catch (e) { toast(e.message, 4000); }
        };
      });
      const form = $('#friend-add');
      if (form) form.onsubmit = (ev) => { ev.preventDefault(); addFriend($('#friend-name').value.trim()); };
    } catch (e) {
      el.innerHTML = `<h1>Leaders</h1><p class="lede">${esc(e.message)}</p>`;
    }
  }

  async function addFriend(name) {
    if (!name || state.busy) return;
    state.busy = true;
    try {
      const r = await API.post('/friends/add', { username: name });
      toast(`${r.username} added. You can see their coin now; they can't see yours until they add you back.`, 4500);
      if (state.me) state.me.friend_count = r.friend_count;
      await loadLeaders();
      refreshAchievements(1200);
    } catch (e) { toast(e.message, 4500); }
    finally { state.busy = false; }
  }

  // --- player sheet --------------------------------------------------------------------------------

  async function openPlayer(name) {
    if (!name) return;
    const dlg = $('#dlg-player');
    $('#player-title').textContent = name;
    $('#player-body').innerHTML = `<p class="muted">Loading…</p>`;
    if (!dlg.open) dlg.showModal();
    try {
      const { player: p } = await API.get(`/players/${encodeURIComponent(name)}`);
      renderPlayer(p);
    } catch (e) {
      $('#player-body').innerHTML = `<p class="muted">${esc(e.message)}</p>`;
    }
  }

  function renderPlayer(p) {
    const rank = p.badges && p.badges.earned.length ? p.badges.earned[p.badges.earned.length - 1].name : 'No rank yet';
    const open = p.positions || [];
    const coin = Coin.front({ cash: p.cash, positions: open, size: 220, quiet: true });
    const posRows = open.length ? open.map((x) => `
      <li><span><b>${esc(x.symbol)}</b> ${money(x.invested)}${x.ride_count > 0 ? ` <span class="muted">riding ×${x.ride_count}</span>` : ''}${x.matured ? ' <span class="muted">matured</span>' : ''}</span><b class="${x.busted ? 'down' : dir(x.swing_pct)}">${x.busted ? 'RIP' : x.quote_error ? '—' : pct(x.swing_pct, 0)}</b></li>`).join('') : '';
    const town = p.town;
    $('#player-title').textContent = p.is_you ? `${p.username} (you)` : p.username;
    $('#player-body').innerHTML = `
      <div class="player-head">
        <div class="player-coin" aria-hidden="true">${coin}</div>
        <div class="player-facts">
          <div class="player-rank">${esc(rank)}</div>
          <ul class="player-stats">
            <li><span>Hired this quarter</span><b>${esc(lobby(p.quarter_donated))}</b></li>
            <li><span>Hired, career</span><b>${esc(lobby(p.total_donated))}</b></li>
            <li><span>Streak</span><b>${p.streak} day${p.streak === 1 ? '' : 's'}</b></li>
            <li><span>On the coin</span><b>${money(p.in_play)}</b></li>
            ${p.top_charity ? `<li><span>Lobbies for</span><b>${esc(p.top_charity)}</b></li>` : ''}
            ${p.achievements ? `<li><span>Trophies</span><b>${p.achievements.earned.length ? `🏆 ${p.achievements.earned.map((a) => esc(a.title)).join(', ')}` : 'None yet'}</b></li>` : ''}
          </ul>
        </div>
      </div>
      ${open.length ? `<ul class="receipt player-positions">${posRows}</ul>` : `<p class="muted">Nothing on the coin right now. ${money(p.cash)} in bills.</p>`}
      ${town ? `<div class="player-town">
        <b>TrickleTown</b> <span class="muted">${Math.round(town.happiness)} happy${town.income != null ? ` · ${money(town.income, { whole: true })}/day profit` : ''}</span>
        <div class="player-buildings">${(town.buildings || []).map((b) => (b.key ? `<span class="chip ${esc(b.tier || '')}">${esc(b.name)}</span>` : `<span class="chip empty">Empty lot</span>`)).join('')}</div>
        <p class="muted" style="margin:6px 0 0">“${esc(town.motto || '')}”</p>
      </div>` : `<p class="muted" style="font-size:13px">No village yet. TrickleTown opens at the first full lobbyist.</p>`}
      <p class="muted" style="font-size:13px">Played ${esc(p.last_seen || 'recently')}.${p.added_you && !p.is_you ? ' Has added you.' : ''}</p>
      <div class="row-actions">
        ${p.is_you ? '' : p.is_friend
          ? `<button class="btn small" id="player-unfriend">Remove friend</button>`
          : (state.me && API.token() ? `<button class="btn small primary" id="player-add">Add friend</button>` : '')}
        <button class="btn quiet small" id="player-close">Close</button>
      </div>`;
    $('#player-close').onclick = () => $('#dlg-player').close();
    const add = $('#player-add'); if (add) add.onclick = async () => { await addFriend(p.username); openPlayer(p.username); };
    const rm = $('#player-unfriend'); if (rm) rm.onclick = async () => { try { await API.post('/friends/remove', { username: p.username }); toast(`${p.username} removed.`); if ($('#screen-leaders').classList.contains('on') || location.hash === '#leaders') loadLeaders(); openPlayer(p.username); } catch (e) { toast(e.message, 4000); } };
  }

  // --- how -----------------------------------------------------------------------------------------

  function renderHow() {
    const me = state.me;
    const rules = me ? me.rules : { daily_base: 100, streak_bonus: 10, daily_cap: 200, tax_rate: 0.25, hold_hours: 24, mult_floor: 1, demo: true, vest_amount: 40 };
    const earned = me ? me.user.badges.earned.map((b) => b.name) : [];
    const badgeList = [
      { at: 1, name: 'Intern' }, { at: 10, name: 'Staffer' }, { at: 50, name: 'Consultant' }, { at: 250, name: 'Lobbyist' },
      { at: 1000, name: 'Fixer' }, { at: 5000, name: 'Kingmaker' }, { at: 25000, name: 'Shadow Cabinet' },
    ];
    const pct = Math.round(rules.tax_rate * 100);
    const h = rules.hold_hours;
    const qa = [
      ['What is this?', `A daily game. You get fake money every morning, invest it in real stocks, and your wins send this site's real ad money to charity. Losing costs you nothing.`],
      ['What do I do each day?', `Three things, in about two minutes: <b>collect</b> anything that matured, <b>buy</b> something with the day's money, and <b>play the cards</b> in TrickleTown. The to-do list under your coin keeps track.`],
      ['How much money do I get?', `${money(rules.daily_base, { whole: true })} a day. Each day of your streak adds ${money(rules.streak_bonus, { whole: true })}, up to ${money(rules.daily_cap, { whole: true })}. Miss a day and it drops back to ${money(rules.daily_base, { whole: true })}. Bills you don't spend stay on the coin.`],
      [`What's the ×10?`, `Every buy rides the real market for ${h} hours, and the move is multiplied. It starts at ${mult(rules.mult_floor)} the moment you buy and climbs to ×10 at the ${h}-hour mark (×5 for crypto). The multiplier works on the move, not the money: the stock goes up 1% over the day, you're up 10%; down 1%, down 10%. At ${h} hours it matures and the value freezes. A position can fall to $0; it can't go below.`],
      ['Collect, sell early, or ride?', `<b>Collect</b> a matured position and the money comes back to the coin. <b>Sell early</b> any time at the current, smaller multiplier. <b>Ride</b> a matured winner instead: the profit so far is taxed at half rate (${pct / 2}%), and what's left goes back on the same stock for another ${h} hours with the multiplier climbing higher (×10 to ×20, then ×30). The other half of the tax is due if you sell the ride early, forgiven if you let it mature.`],
      ['What happens when I win?', `${pct}% of the profit is tax. The tax hires <b>lobbyists</b> (about $1K a head; the exact price is set by your town's happiness) for your <b>charity</b>, which you pick at your first cash-out. Losses aren't taxed.`],
      ['What is Lobbyfest?', `Every quarter, on the last day at midnight Central, every lobbyist in the game marches off to Lobbyfest. The ad money this site earned is split between the charities by headcount: the charity with the most lobbyists gets the biggest share. Then every village empties and the next quarter starts at zero. The Lobby page shows the standings.`],
      ['What is TrickleTown?', `The other side of your coin, where your lobbyists live. It has two scores. <b>Profit</b>: what the town adds to (or takes from) your daily money. <b>Happiness</b>: what each new lobbyist costs you, from $1.4K in a miserable town to $500 in a happy one. Two lots to build on: extractive buildings (a casino, tenements) make profit and unhappiness; decent ones (a clinic, a co-op) cost profit and make people happy. Buildings get upgrade proposals as the town grows. The Company Store takes 20% off anything a card costs.`],
      ['What are the cards?', `Each day Preston (wants profit) and Dolores (wants happiness) bring a few decisions to Town Hall: a headline everyone gets, plus cards your own town has unlocked. Pick a side on each. The arrows show which way a choice pushes; a tag says if it comes back around later. Unplayed cards expire at midnight, and once you've built something, skipping them costs a little happiness. The deck shows every card and what unlocks it.`],
      ['Can I move my lobbyists?', `Yes. TrickleTown → Assign lobbyists moves this quarter's lobbyists between charities and changes where new ones go. Past quarters already marched.`],
      ['What are achievements?', `Rare milestones (your first buy, your first win, a week-long streak, building out the town, a million on the coin). Each comes with a one-time gift from Mommy &amp; Daddy, taxed like any win. The 🏆 at the top shows how close you are.`],
      ['Friends and leaders?', `Add friends by username on the Leaders page. It's one-way: you see their coin and town, they see yours only if they add you back. The boards show Lobbyfest standings, the best cash-out of the last day, and the biggest positions held right now.`],
      ['Ranks?', `Ranks count every lobbyist you ever hire, across every Lobbyfest. <span class="badges-inline">${badgeList.map((b) => `<span class="${earned.includes(b.name) ? 'earned' : ''}"><b>${esc(b.name)}</b> ${b.at}</span>`).join('')}</span>`],
      ['Fine print', `<span class="muted">Trickle Down Holdings is a fictional company and a wholly owned subsidiary of Trickle Down Holdings. Prices come from Finnhub and CoinGecko and can be a minute or so behind. Stocks only move while the market is open; crypto never stops. A guest account lives in one browser until you keep it with a password, Google, or a device code.</span>`],
    ];
    $('#screen-how').innerHTML = `
      <h1>How it works</h1>
      <p class="lede">Fake money, real stocks, real charity. The whole game in one sentence: invest, hold ${h} hours, and your wins hire lobbyists for a charity.</p>
      <div class="row-actions" style="margin:6px 0 14px"><button class="btn quiet small" id="btn-orient-how">Replay the training</button>${me && me.town && me.town.unlocked ? '<button class="btn quiet small" id="btn-town-how">Replay the TrickleTown tour</button>' : ''}</div>
      ${rules.demo ? `<div class="note warn">Demo. The charities are fictional and no real money moves. The game is real; the philanthropy isn't yet.</div>` : ''}
      <div class="faq">${qa.map(([q, a], n) => `<details class="faq-item" ${n === 0 ? 'open' : ''}><summary>${esc(q)}</summary><p>${a}</p></details>`).join('')}</div>`;
    $('#btn-orient-how').onclick = () => Explainer.open({ deck: 'main', rules });
    const tt = $('#btn-town-how'); if (tt) tt.onclick = () => Explainer.open({ deck: 'town' });
  }

  // --- auth sheet ----------------------------------------------------------------------------------

  // Google Identity Services: loaded on demand, only when the server (or
  // config.js) says a client id exists. The button hands us an ID token; the
  // server verifies it against Google's keys and keys the account on `sub`.
  const gsi = { clientId: window.TRICKLE_CONFIG.GOOGLE_CLIENT_ID || '', checked: false, ready: null, intent: 'login' };

  async function googleAvailable() {
    if (!gsi.checked) {
      gsi.checked = true;
      try { const o = await API.get('/auth/options'); if (o && o.google && o.google_client_id) gsi.clientId = o.google_client_id; else if (o && o.google === false) gsi.clientId = ''; } catch (e) { /* keep config.js value */ }
    }
    return !!gsi.clientId;
  }

  function loadGsi() {
    if (gsi.ready) return gsi.ready;
    gsi.ready = new Promise((resolve, reject) => {
      if (window.google && window.google.accounts) return resolve();
      const sc = document.createElement('script');
      sc.src = 'https://accounts.google.com/gsi/client'; sc.async = true; sc.defer = true;
      sc.onload = () => resolve(); sc.onerror = () => reject(new Error("Couldn't load Google sign-in."));
      document.head.appendChild(sc);
    }).then(() => {
      window.google.accounts.id.initialize({ client_id: gsi.clientId, callback: onGoogleCredential, ux_mode: 'popup', auto_select: false });
    });
    return gsi.ready;
  }

  // Render (or re-render) the Google button into a container, for a given intent.
  async function mountGoogle(containerId, intent) {
    const slot = $(`#${containerId}`);
    if (!slot) return false;
    if (!(await googleAvailable())) { slot.hidden = true; return false; }
    slot.hidden = false;
    try {
      await loadGsi();
      const target = slot.querySelector('div') || slot;
      target.innerHTML = '';
      gsi.intent = intent;
      window.google.accounts.id.renderButton(target, { theme: 'outline', size: 'large', shape: 'pill', width: Math.min(320, target.clientWidth || 320), text: intent === 'link' ? 'continue_with' : 'signin_with' });
      return true;
    } catch (e) {
      slot.innerHTML = `<p class="muted small">${esc(e.message)}</p>`;
      return false;
    }
  }

  async function onGoogleCredential(resp) {
    if (!resp || !resp.credential || state.busy) return;
    state.busy = true;
    try {
      const linking = gsi.intent === 'link' && API.token();
      const r = await API.post(linking ? '/auth/link-google' : '/auth/google', { credential: resp.credential });
      API.setToken(r.token);
      if ($('#dlg-auth').open) $('#dlg-auth').close();
      if ($('#dlg-account').open) $('#dlg-account').close();
      toast(linking ? `Linked. You're ${r.user.username} now, on every device.` : r.created ? `Welcome, ${r.user.username}. You can change that name in Account.` : `Hi, ${r.user.username}.`, 4000);
      state.me = null;
      location.hash = '#today'; route();
    } catch (e) {
      const err = $('#dlg-auth').open ? $('#auth-error') : $('#account-error');
      if (err) { err.textContent = e.message; err.hidden = false; } else toast(e.message, 4000);
    } finally { state.busy = false; }
  }

  function openAuth(mode) {
    state.authMode = mode;
    const code = mode === 'code';
    const title = { login: 'Sign in', register: 'Create an account', claim: 'Keep this account', code: 'Use a code' }[mode];
    const blurb = {
      login: 'Pick up where you left off.',
      register: 'A username and a password. That\'s it.',
      claim: 'Give your guest account a name and a password, or link Google, so it follows you to other devices. Everything you\'ve done comes with it.',
      code: 'On the device that\'s already signed in: Account → Use on another device. Type the code it shows here. It works once and lasts 15 minutes.',
    }[mode];
    $('#auth-title').textContent = title;
    $('#auth-blurb').textContent = blurb;
    // Anyone setting a password gets the honest version of where security stands.
    $('#auth-beta').hidden = !(mode === 'register' || mode === 'claim');
    $('#auth-submit').textContent = code ? 'Sign in with the code' : title;
    $('#auth-fields').hidden = code;
    $('#auth-code-field').hidden = !code;
    $('#auth-user').required = !code; $('#auth-pass').required = !code; $('#auth-code').required = code;
    $('#auth-switch').hidden = mode === 'claim' || code;
    $('#auth-switch').textContent = mode === 'login' ? 'New here? Create an account' : 'Have an account? Sign in';
    $('#auth-code-link').hidden = mode === 'claim';
    $('#auth-code-link').textContent = code ? 'Back to username and password' : 'Signed in on another device? Use a code';
    $('#auth-pass').autocomplete = mode === 'login' ? 'current-password' : 'new-password';
    $('#auth-pass').placeholder = mode === 'login' ? '' : 'at least 8 characters';
    $('#auth-error').hidden = true;
    $('#auth-user').value = ''; $('#auth-pass').value = ''; $('#auth-code').value = '';
    $('#dlg-auth').showModal();
    $('#auth-google').hidden = code;
    if (!code) mountGoogle('auth-google', mode === 'claim' ? 'link' : 'login');
    setTimeout(() => (code ? $('#auth-code') : $('#auth-user')).focus(), 50);
  }

  async function submitAuth(ev) {
    ev.preventDefault();
    if (state.busy) return;
    const username = $('#auth-user').value.trim();
    const password = $('#auth-pass').value;
    const path = { login: '/auth/login', register: '/auth/register', claim: '/auth/claim', code: '/auth/redeem-code' }[state.authMode];
    state.busy = true; $('#auth-submit').disabled = true;
    try {
      const r = await API.post(path, state.authMode === 'code' ? { code: $('#auth-code').value.trim() } : { username, password });
      API.setToken(r.token);
      $('#dlg-auth').close();
      toast(state.authMode === 'claim' ? `You're ${r.user.username} now. It'll remember you.` : state.authMode === 'code' ? `This is ${r.user.username}'s coin now, here too.` : `Hi, ${r.user.username}.`);
      state.me = null;
      location.hash = '#today'; route();
    } catch (e) {
      $('#auth-error').textContent = e.message; $('#auth-error').hidden = false;
    } finally { state.busy = false; $('#auth-submit').disabled = false; }
  }

  // --- account sheet ----------------------------------------------------------------------------------

  // "Use on another device": a code the other device types into Sign in.
  const deviceSection = () => `
      <details class="acct-section" id="acct-device">
        <summary>Use on another device</summary>
        <p class="muted small">Get a code here, then on the other device tap Sign in → “Signed in on another device? Use a code.” It works once and lasts 15 minutes. No password needed.</p>
        <button type="button" class="btn small" id="acct-code-btn">Get a code</button>
        <div class="device-code" id="acct-code" hidden></div>
      </details>`;
  // Testing tools, only for ADMIN_USERNAMES. Every action defaults to your own
  // account; type a player's name to aim it at theirs instead.
  const adminCardOptions = () => {
    const deck = (state.me && state.me.town && state.me.town.deck) || [];
    const label = { today: 'in hand', played: 'played today', available: 'in the pile', locked: 'locked' };
    return [...deck].sort((a, b) => a.title.localeCompare(b.title))
      .map((d) => `<option value="${esc(d.id)}">${esc(d.title)} · ${label[d.status] || d.status}${d.general ? ' · headline' : ''}</option>`).join('');
  };
  const adminSection = (u) => (u.is_admin ? `
      <details class="acct-section admin" id="acct-admin">
        <summary>Admin</summary>
        <p class="muted small">Testing only. Everything here is real: grants land on the boards, resets delete rows.</p>
        <label class="field"><span>Player <em class="muted">(blank = you)</em></span><input id="acct-admin-who" type="text" autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="40" placeholder="${esc(u.username)}"></label>
        <h4 class="admin-h">Grant</h4>
        <form id="acct-grant-form" class="acct-form">
          <label class="field"><span>Cash to add ($K)</span><input id="acct-grant-cash" type="number" min="0" step="1" placeholder="0" inputmode="numeric"></label>
          <label class="field"><span>Lobbyists to add</span><input id="acct-grant-lob" type="number" min="0" step="0.01" placeholder="0" inputmode="decimal"></label>
          <button type="submit" class="btn small">Grant</button>
        </form>
        <h4 class="admin-h">Cards</h4>
        <label class="field"><span>Card</span><select id="acct-card">${adminCardOptions()}</select></label>
        <div class="row-actions admin-row">
          <button type="button" class="btn small" id="acct-deal">Deal it today</button>
          <button type="button" class="btn quiet small" id="acct-unlock">Unlock it</button>
          <button type="button" class="btn quiet small" id="acct-unlock-all">Unlock every card</button>
          <button type="button" class="btn quiet small" id="acct-deal-all">Deal every unlocked card today</button>
        </div>
        <p class="muted small">Deal puts the card on today's agenda now (the town has to be open). Unlock puts it in the pile for future days.</p>
        <h4 class="admin-h">Start over</h4>
        <p class="muted small">Back to a brand-new account: no positions, lobbyists, town, friends, streak or achievements, $100K at the next load. On your own account this browser also forgets the training and tours, so you get the whole first-day experience again.</p>
        <div class="row-actions"><button type="button" class="btn quiet small danger" id="acct-reset">Reset to brand new</button></div>
      </details>` : '');
  function wireShared() {
    const err = (m) => { const e = $('#account-error'); e.textContent = m; e.hidden = false; };
    const codeBtn = $('#acct-code-btn');
    if (codeBtn) codeBtn.onclick = async () => {
      codeBtn.disabled = true;
      try {
        const r = await API.post('/auth/device-code');
        const box = $('#acct-code');
        box.hidden = false;
        box.innerHTML = `<b>${esc(r.code)}</b><span class="muted small">Type this on the other device within ${r.ttl_minutes} minutes.</span>`;
        codeBtn.textContent = 'Get another code';
      } catch (e) { err(e.message); }
      finally { codeBtn.disabled = false; }
    };
    // Admin: aim at yourself unless a player is named.
    const who = () => { const w = $('#acct-admin-who'); const v = w ? w.value.trim() : ''; return v && v.toLowerCase() !== state.me.user.username.toLowerCase() ? v : ''; };
    const aim = (body) => (who() ? { ...body, username: who() } : body);
    const reload = (opts = {}) => {
      $('#dlg-account').close(); state.me = null;
      if (opts.town) state.flipped = true;
      location.hash = '#today'; route();
    };
    const busy = async (btn, fn) => { if (btn.disabled) return; btn.disabled = true; try { await fn(); } catch (e) { err(e.message); } finally { btn.disabled = false; } };
    const grant = $('#acct-grant-form');
    if (grant) grant.onsubmit = (ev) => {
      ev.preventDefault();
      const cash = Number($('#acct-grant-cash').value) || 0, lobbyists = Number($('#acct-grant-lob').value) || 0;
      busy(grant.querySelector('button'), async () => {
        await API.post('/admin/grant', aim({ cash, lobbyists }));
        toast(`Granted${who() ? ` ${who()}` : ''}: ${cash ? money(cash) : ''}${cash && lobbyists ? ' and ' : ''}${lobbyists ? lobby(lobbyists) : ''}.`);
        reload();
      });
    };
    const card = $('#acct-card');
    const cardName = () => (card && card.selectedOptions[0] ? card.selectedOptions[0].textContent.split(' · ')[0] : 'that card');
    const deal = $('#acct-deal');
    if (deal) deal.onclick = () => busy(deal, async () => {
      await API.post('/admin/deal', aim({ issue_id: card.value }));
      toast(`Dealt “${cardName()}”${who() ? ` to ${who()}` : ''}. It's on today's agenda.`);
      reload({ town: !who() });
    });
    const unlock = $('#acct-unlock');
    if (unlock) unlock.onclick = () => busy(unlock, async () => {
      await API.post('/admin/unlock', aim({ issue_id: card.value }));
      toast(`Unlocked “${cardName()}”${who() ? ` for ${who()}` : ''}. It can be dealt from tomorrow.`);
      reload();
    });
    const dealAll = $('#acct-deal-all');
    if (dealAll) dealAll.onclick = () => busy(dealAll, async () => {
      const r = await API.post('/admin/deal', aim({ all: true }));
      const n = Array.isArray(r.dealt) ? r.dealt.length : 1;
      toast(`Dealt ${n} card${n === 1 ? '' : 's'}${who() ? ` to ${who()}` : ''}. They're on today's agenda.`);
      reload({ town: !who() });
    });
    const all = $('#acct-unlock-all');
    if (all) all.onclick = () => busy(all, async () => {
      if (all.dataset.armed !== '1') { all.dataset.armed = '1'; all.textContent = 'Tap again to open the whole deck'; return; }
      await API.post('/admin/unlock', aim({ all: true }));
      toast(`Every card is unlocked${who() ? ` for ${who()}` : ''}.`);
      reload();
    });
    const reset = $('#acct-reset');
    if (reset) reset.onclick = () => busy(reset, async () => {
      if (reset.dataset.armed !== '1') { reset.dataset.armed = '1'; reset.textContent = who() ? `Tap again to wipe ${who()} back to brand new` : 'Tap again to wipe everything and start over'; return; }
      const target = who();
      const r = await API.post('/admin/reset', aim({}));
      if (r.self === false || target) { toast(`${target} is brand new again. Their own browser still remembers the training they've seen.`); reload(); return; }
      forgetFirstRun();
      toast('Brand new. Welcome to Trickle Down Corp.');
      reload();
    });
  }

  // Everything this browser remembers about having played before, so a reset
  // account replays the training, the first-investment guide, the vesting
  // gift, the first hire and the TrickleTown tour from the top.
  function forgetFirstRun() {
    for (const k of ['trickledown.oriented', 'trickledown.town-intro']) { try { localStorage.removeItem(k); } catch (e) { /* private mode */ } }
    tickerStop();
    Object.assign(state, { flipped: false, oriented: false, ceremony: false, selected: null, quote: null, carve: 0, sell: null });
    state.found.clear();
  }

  async function openAccount() {
    const u = state.me && state.me.user;
    if (!u) return;
    const body = $('#account-body');
    if (u.is_guest) {
      body.innerHTML = `
        <p>You're playing as <b>${esc(u.username)}</b>, a guest. It lives in this browser only.</p>
        <p class="muted">Claim it to keep your coin, your lobbyists and TrickleTown on every device.</p>
        <div class="row-actions"><button type="button" class="btn primary" id="acct-claim">Keep this account</button><button type="button" class="btn quiet" id="acct-signout">Sign out</button></div>
        ${deviceSection()}
        ${adminSection(u)}
        <p class="form-error" id="account-error" hidden></p>`;
      $('#dlg-account').showModal();
      $('#acct-claim').onclick = () => { $('#dlg-account').close(); openAuth('claim'); };
      $('#acct-signout').onclick = signOut;
      wireShared();
      return;
    }
    const hasG = await googleAvailable();
    body.innerHTML = `
      <div class="acct-row"><span class="muted">Signed in as</span><b>${esc(u.username)}</b></div>
      ${u.google ? `<div class="acct-row"><span class="muted">Google</span><span>Linked${u.email ? ` · ${esc(u.email)}` : ''}</span></div>` : ''}
      <p class="muted small">Friends add you by that username; it's the only thing about you they can see. <a href="#leaders">Your friends</a>${state.me.friend_count ? ` (${state.me.friend_count})` : ''}.</p>

      <details class="acct-section" open>
        <summary>Change username</summary>
        <form id="acct-username-form" class="acct-form">
          <label class="field"><span>New username</span><input id="acct-username" minlength="3" maxlength="20" pattern="[A-Za-z0-9_]+" autocapitalize="off" spellcheck="false" required value="${esc(u.username)}"></label>
          <button type="submit" class="btn small">Save</button>
        </form>
      </details>

      <details class="acct-section">
        <summary>${u.has_password ? 'Change password' : 'Set a password'}</summary>
        <form id="acct-password-form" class="acct-form">
          ${u.has_password ? '<label class="field"><span>Current password</span><input id="acct-current" type="password" autocomplete="current-password" required></label>' : '<p class="muted small">You sign in with Google. A password gives you a second way in.</p>'}
          <label class="field"><span>New password</span><input id="acct-new" type="password" autocomplete="new-password" minlength="8" required placeholder="at least 8 characters"></label>
          <button type="submit" class="btn small">Save</button>
          <p class="muted small">Saving signs out every other device.</p>
        </form>
      </details>

      ${hasG && !u.google ? `<details class="acct-section"><summary>Link Google</summary><div class="google-slot" id="account-google"><div id="g-btn-account"></div></div><p class="muted small">Then you can sign in with either.</p></details>` : ''}
      ${deviceSection()}
      ${adminSection(u)}

      <div class="row-actions" style="margin-top:14px">
        <button type="button" class="btn quiet small" id="acct-signout">Sign out</button>
        <button type="button" class="btn quiet small" id="acct-signout-all">Sign out everywhere</button>
      </div>
      <p class="form-error" id="account-error" hidden></p>`;
    $('#dlg-account').showModal();
    wireShared();
    $$('#account-body a[href="#leaders"]').forEach((a) => { a.onclick = () => { $('#dlg-account').close(); }; });
    const err = (m) => { const e = $('#account-error'); e.textContent = m; e.hidden = false; };
    $('#acct-username-form').onsubmit = async (ev) => {
      ev.preventDefault();
      try { const r = await API.post('/auth/username', { username: $('#acct-username').value.trim() }); state.me.user = { ...state.me.user, ...r.user }; renderMasthead(); toast(`You're ${r.user.username} now.`); $('#dlg-account').close(); } catch (e) { err(e.message); }
    };
    $('#acct-password-form').onsubmit = async (ev) => {
      ev.preventDefault();
      const cur = $('#acct-current'); const body2 = { password: $('#acct-new').value };
      if (cur) body2.current = cur.value;
      try { const r = await API.post('/auth/password', body2); API.setToken(r.token); state.me.user = { ...state.me.user, ...r.user }; toast('Password saved. Every other device is signed out.', 4000); $('#dlg-account').close(); } catch (e) { err(e.message); }
    };
    $('#acct-signout').onclick = signOut;
    $('#acct-signout-all').onclick = async () => { try { await API.post('/auth/logout-all'); } catch (e) { /* token may already be dead */ } signOut(); toast('Signed out everywhere.'); };
    if (hasG && !u.google) mountGoogle('account-google', 'link');
  }

  function signOut() {
    tickerStop();
    API.setToken(null); state.me = null; state.flipped = false;
    if ($('#dlg-account').open) $('#dlg-account').close();
    location.hash = ''; route();
  }

  // --- wiring ----------------------------------------------------------------------------------------

  function wire() {
    $$('[data-close]').forEach((b) => { b.onclick = () => b.closest('dialog').close(); });
    $('#assign-save').onclick = saveAssign;
    $('#btn-trophies').onclick = openTrophies;
    for (const id of ['#dlg-site', '#dlg-advisors', '#dlg-hire', '#dlg-sell', '#dlg-assign']) { const d = $(id); if (d) d.addEventListener('close', () => maybeAchievement(500)); }
    $('#dlg-advisors').addEventListener('close', () => { adv.result = null; });
    $$('dialog.sheet').forEach((d) => { d.addEventListener('click', (e) => { if (e.target === d) d.close(); }); });
    $('#form-sell').addEventListener('submit', submitSell);
    $('#form-auth').addEventListener('submit', submitAuth);
    $('#auth-switch').onclick = () => openAuth(state.authMode === 'login' ? 'register' : 'login');
    $('#auth-code-link').onclick = () => openAuth(state.authMode === 'code' ? 'login' : 'code');
    $('#btn-claim').onclick = () => openAuth('claim');
    $('#btn-account').onclick = openAccount;
    $('#btn-help').onclick = () => Explainer.open({ deck: 'main', rules: state.me ? state.me.rules : undefined, finale: !API.token(), onFinale: welcomeFinale });
    $('#btn-signout').onclick = signOut;
    window.addEventListener('hashchange', route);

    // Keep the clocks honest and the coin fresh while the tab is open, but
    // never yank the carve panel out from under someone mid-slice.
    const carving = () => state.carve > 0 || state.selected || ['carve-usd', 'carve-search'].includes(document.activeElement && document.activeElement.id);
    setInterval(() => {
      if (!state.me) return;
      $('#day-countdown').textContent = `New money in ${countdown(state.me.day.resets_at)}`;
      tickTimes();
      if (new Date(state.me.day.resets_at) <= Date.now() && state.tab === 'today' && !carving()) loadMe();
    }, 30_000);
    setInterval(() => {
      if (state.me && state.tab === 'today' && document.visibilityState === 'visible' && !$('#dlg-sell').open && !carving()) loadMe();
    }, 60_000);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && state.me && state.tab === 'today' && !carving()) loadMe();
    });
  }

  wire();
  route();
})();
