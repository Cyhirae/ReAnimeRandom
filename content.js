/* Re:ANIME Random — content script
 *
 * Adds a "Random" button to the site header. Clicking it picks a random title
 * from Re:ANIME's own catalogue, restricted to TV series and movies that are
 * actually playable (OVA / ONA / Special / Music are never picked).
 *
 * Data source: https://reanime.cz/api/v1/search?q=&format=<FMT>&limit=50&offset=<N>
 *   - `format` filters server-side (TV, MOVIE, OVA, ONA, SPECIAL, MUSIC)
 *   - results are ordered by popularity, `total` gives the catalogue size
 *   - `subbed` / `dubbed` > 0 means the site actually hosts episodes for it
 *     (verified against /api/v1/anime/<id> `can_watch`: 125/125 agreement)
 *
 * Episode counts are the cheap availability signal; `can_watch` on the detail
 * endpoint is the authoritative one and is checked once per pick.
 */
(() => {
  if (window.__raRandomLoaded) return;
  window.__raRandomLoaded = true;

  const API = '/api/v1';
  const TOTALS_KEY = 'ra_totals_v1';
  const RECENT_KEY = 'recent';
  const HISTORY_KEY = 'history';
  const HISTORY_MAX = 40;
  const TOTALS_TTL = 6 * 60 * 60 * 1000; // 6h
  const RECENT_MAX = 40;

  const DEFAULTS = {
    tv: true,
    movie: true,
    ova: false,
    ona: false,
    special: false,
    excludeAdult: true,
    avoidRecent: true,
    minScore: 0, // 0 = any rating
    openMode: 'card' // 'card' | 'watch'
  };

  // UI toggle -> API `format` value, in display order.
  const FORMATS = [
    ['tv', 'TV'],
    ['movie', 'MOVIE'],
    ['ova', 'OVA'],
    ['ona', 'ONA'],
    ['special', 'SPECIAL']
  ];

  const FORMAT_LABEL = {
    TV: 'TV series',
    MOVIE: 'movie',
    OVA: 'OVA',
    ONA: 'ONA',
    SPECIAL: 'special'
  };

  /* ---------------------------------------------------------------- storage */

  const hasChromeStorage = !!(window.chrome && chrome.storage && chrome.storage.local);

  const store = {
    get(key) {
      return new Promise((resolve) => {
        if (hasChromeStorage) {
          chrome.storage.local.get([key], (o) => resolve(o ? o[key] : undefined));
          return;
        }
        try { resolve(JSON.parse(localStorage.getItem('ra_' + key))); } catch { resolve(undefined); }
      });
    },
    set(key, value) {
      if (hasChromeStorage) { try { chrome.storage.local.set({ [key]: value }); } catch {} return; }
      try { localStorage.setItem('ra_' + key, JSON.stringify(value)); } catch {}
    }
  };

  async function getSettings() {
    const saved = (await store.get('settings')) || {};
    return { ...DEFAULTS, ...saved };
  }

  /* ------------------------------------------------------------------ utils */

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function getJSON(url) {
    const res = await fetch(url, { credentials: 'include', headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + url);
    return res.json();
  }

  function stripHTML(s) {
    if (!s) return '';
    const div = document.createElement('div');
    div.innerHTML = String(s).replace(/<br\s*\/?>/gi, ' ');
    return (div.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function prettyTitle(t) {
    if (!t) return 'Untitled';
    return t.english || t.user_preferred || t.romaji || t.native || 'Untitled';
  }

  function isHosted(item) {
    return (item.subbed || 0) > 0 || (item.dubbed || 0) > 0;
  }

  /** Catalogue sizes per format, cached in sessionStorage for a few hours. */
  async function getTotals(formats) {
    let cache = null;
    try { cache = JSON.parse(sessionStorage.getItem(TOTALS_KEY)); } catch {}
    if (cache && cache.at && Date.now() - cache.at < TOTALS_TTL &&
        formats.every((f) => typeof cache.totals[f] === 'number')) {
      return cache.totals;
    }
    const totals = cache && cache.totals ? { ...cache.totals } : {};
    await Promise.all(formats.map(async (fmt) => {
      if (typeof totals[fmt] === 'number') return;
      try {
        const d = await getJSON(`${API}/search?q=&format=${fmt}&limit=1`);
        totals[fmt] = d.total || 0;
      } catch { totals[fmt] = 0; }
    }));
    try { sessionStorage.setItem(TOTALS_KEY, JSON.stringify({ at: Date.now(), totals })); } catch {}
    return totals;
  }

  /* ------------------------------------------------------------------- roll */

  // Sampled offsets stay inside the part of the catalogue the site actually
  // hosts (density of playable titles collapses past these points).
  const OFFSET_CAP = { TV: 4700, MOVIE: 3000, OVA: 1900, ONA: 2400, SPECIAL: 1100 };

  function weightedFormat(formats, totals) {
    const weights = formats.map((f) => Math.max(totals[f] || 0, 1));
    const sum = weights.reduce((a, b) => a + b, 0);
    let roll = Math.random() * sum;
    for (let i = 0; i < formats.length; i++) {
      roll -= weights[i];
      if (roll <= 0) return formats[i];
    }
    return formats[formats.length - 1];
  }

  const POOL_TTL = 10 * 60 * 1000; // 10 min

  /** Confirm a candidate against the authoritative detail endpoint. */
  async function confirm(pick, settings) {
    let detail = null;
    try { detail = await getJSON(`${API}/anime/${pick.anime_id}`); } catch {}
    if (detail && detail.can_watch === false) return null;
    if (settings.excludeAdult && detail && detail.is_adult) return null;
    return { pick, detail };
  }

  /**
   * Sweep the playable part of the catalogue once and keep every title above the
   * rating floor. High floors describe only a handful of titles in total, so random
   * offset sampling would keep missing them (measured: 4 TV + 1 movie at 9.0+).
   */
  async function harvestPool(formats, minScore) {
    const key = `ra_pool_v1_${minScore}_${formats.join('-')}`;
    let cached = null;
    try { cached = JSON.parse(sessionStorage.getItem(key)); } catch {}
    if (cached && cached.at && Date.now() - cached.at < POOL_TTL && Array.isArray(cached.items)) {
      return cached.items;
    }

    const jobs = [];
    for (const fmt of formats) {
      const cap = Math.min(OFFSET_CAP[fmt] || 3000, 3100);
      for (let off = 0; off < cap; off += 300) jobs.push([fmt, off]);
    }

    const found = new Map();
    for (let i = 0; i < jobs.length; i += 6) {
      const batch = jobs.slice(i, i + 6);
      const pages = await Promise.all(batch.map(([fmt, off]) =>
        getJSON(`${API}/search?q=&format=${fmt}&limit=100&offset=${off}`).catch(() => null)));
      pages.forEach((page) => {
        if (!page) return;
        for (const item of page.results || []) {
          if (!isHosted(item)) continue;
          if ((item.average_score || 0) < minScore) continue;
          if (!found.has(item.anime_id)) found.set(item.anime_id, item);
        }
      });
    }

    const items = [...found.values()];
    if (items.length) {
      try { sessionStorage.setItem(key, JSON.stringify({ at: Date.now(), items })); } catch {}
    }
    return items;
  }

  async function roll(settings) {
    const formats = FORMATS.filter(([key]) => settings[key]).map(([, fmt]) => fmt);
    if (!formats.length) formats.push('TV');

    const totals = await getTotals(formats);
    const recent = settings.avoidRecent ? ((await store.get(RECENT_KEY)) || []) : [];
    const minScore = Number(settings.minScore) || 0;
    const floor = minScore ? ` rated ${(minScore / 10).toFixed(1)}+` : '';
    const what = formats.map((f) => FORMAT_LABEL[f] || f).join(' / ');
    const noMatch = () => new Error(`No playable ${what}${floor} found. Roll again, or lower the minimum rating in the extension settings.`);

    // High floors: pick from a harvested shortlist instead of blind offsets.
    if (minScore >= 80) {
      const pool = await harvestPool(formats, minScore);
      if (!pool.length) throw noMatch();
      let candidates = pool.filter((x) => !recent.includes(x.anime_id));
      if (!candidates.length) candidates = pool.slice(); // shortlist smaller than the recent list
      for (let i = candidates.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
      }
      for (const candidate of candidates.slice(0, 15)) {
        const confirmed = await confirm(candidate, settings);
        if (confirmed) return confirmed;
      }
      throw noMatch();
    }

    let lastError = null;
    for (let attempt = 0; attempt < 12; attempt++) {
      const fmt = weightedFormat(formats, totals);
      const cap = OFFSET_CAP[fmt] || 3000;
      const span = Math.max(40, Math.min(totals[fmt] || cap, cap));
      // late attempts drift toward the popular end, where playable titles are dense
      const scale = attempt < 3 ? 1 : attempt < 5 ? 0.55 : 0.25;
      const offset = Math.floor(Math.random() * span * scale);

      let page;
      try {
        page = await getJSON(`${API}/search?q=&format=${fmt}&limit=50&offset=${offset}`);
      } catch (err) {
        lastError = err;
        await sleep(150 + Math.random() * 200);
        continue;
      }

      const pool = (page.results || []).filter((x) =>
        isHosted(x) &&
        !recent.includes(x.anime_id) &&
        (x.average_score || 0) >= minScore
      );
      if (!pool.length) continue;

      const confirmed = await confirm(pool[Math.floor(Math.random() * pool.length)], settings);
      if (confirmed) return confirmed;
    }
    throw lastError || noMatch();
  }

  const FORMAT_BADGE = { TV: 'TV', TV_SHORT: 'TV', MOVIE: 'Movie', OVA: 'OVA', ONA: 'ONA', SPECIAL: 'Special', MUSIC: 'Music' };

  function candidateView(pick, detail) {
    const d = detail || {};
    const title = prettyTitle(d.title || pick.title);
    const cover = (d.cover_image && (d.cover_image.large || d.cover_image.extra_large)) ||
                  (pick.cover_image && (pick.cover_image.large || pick.cover_image.extra_large)) || '';
    const fmt = d.format || pick.format;
    // season_year is 0 for some entries; start_date is an object ({day,month,year}) on the detail endpoint
    const startDate = d.start_date || pick.start_date;
    let year = d.season_year || pick.season_year || '';
    if (!year && startDate) {
      year = typeof startDate === 'object' ? (startDate.year || '') : String(startDate).slice(0, 4);
    }
    year = year ? String(year) : '';
    const score = typeof (d.average_score || pick.average_score) === 'number'
      ? (d.average_score || pick.average_score) / 10 : null;
    const genres = (d.genres || pick.genres || []).slice(0, 3);
    const subbed = d.subbed ?? pick.subbed ?? 0;
    const dubbed = d.dubbed ?? pick.dubbed ?? 0;
    const episodes = d.episodes_total || pick.episodes || null;
    // newest episode that actually has a server, and which track it belongs to.
    // (Links always open episode 1; this is kept as metadata on the history row.)
    const lang = subbed > 0 ? 'sub' : dubbed > 0 ? 'dub' : '';
    const ep = lang === 'sub' ? Number(subbed) : lang === 'dub' ? Number(dubbed) : 0;
    const desc = stripHTML(d.description || '');
    return {
      id: pick.anime_id,
      title,
      cover,
      format: FORMAT_BADGE[fmt] || fmt || 'TV',
      year: year || '',
      score,
      genres,
      subbed,
      dubbed,
      ep,
      lang,
      episodes,
      status: d.status || pick.status || '',
      desc: desc.length > 460 ? desc.slice(0, 457).trimEnd() + '…' : desc
    };
  }

  // Single source of truth for watch links: always the first episode, with the
  // language that actually has servers for that title.
  function watchHref(view) {
    const id = encodeURIComponent(view.id);
    const lang = view.lang ? `&lang=${view.lang}` : '';
    return `/watch/${id}?ep=1${lang}`;
  }

  async function remember(view) {
    const id = view.id;
    const list = (await store.get(RECENT_KEY)) || [];
    store.set(RECENT_KEY, [id, ...list.filter((x) => x !== id)].slice(0, RECENT_MAX));

    const history = (await store.get(HISTORY_KEY)) || [];
    const entry = {
      id,
      title: view.title || 'Untitled',
      cover: view.cover || '',
      format: view.format || '',
      year: view.year || '',
      score: view.score || null,
      ep: view.ep || 0,
      lang: view.lang || '',
      at: Date.now()
    };
    // newest first; re-rolling the same title moves it back to the top
    store.set(HISTORY_KEY, [entry, ...history.filter((x) => x && x.id !== id)].slice(0, HISTORY_MAX));
  }

  /* ------------------------------------------------------------------- icon */

  const DICE_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <rect x="3" y="3" width="18" height="18" rx="3"></rect>
    <circle cx="8.5" cy="8.5" r="1.1" fill="currentColor" stroke="none"></circle>
    <circle cx="15.5" cy="8.5" r="1.1" fill="currentColor" stroke="none"></circle>
    <circle cx="12" cy="12" r="1.1" fill="currentColor" stroke="none"></circle>
    <circle cx="8.5" cy="15.5" r="1.1" fill="currentColor" stroke="none"></circle>
    <circle cx="15.5" cy="15.5" r="1.1" fill="currentColor" stroke="none"></circle>
  </svg>`;

  /* ----------------------------------------------------------- header button */

  const BTN_ID = 'ra-random-btn';

  function headerHost() {
    const cta = document.querySelector('header button.header-cta');
    if (cta && cta.parentElement) return { parent: cta.parentElement, before: cta };
    const lang = document.querySelector('header .title-lang');
    if (lang && lang.parentElement) return { parent: lang.parentElement, before: lang };
    const header = document.querySelector('header');
    if (!header) return null;
    const row = header.querySelector('div.relative.z-10') || header;
    return { parent: row, before: null };
  }

  function buildButton() {
    const btn = document.createElement('button');
    btn.id = BTN_ID;
    btn.type = 'button';
    btn.className = 'ra-random-btn';
    btn.title = 'Random anime (TV or movie only) — Alt+R';
    btn.innerHTML = `${DICE_SVG}<span class="ra-lbl">Random</span>`;
    btn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); triggerRoll(btn); });
    return btn;
  }

  const HISTORY_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"></path>
    <path d="M3 3v5h5"></path>
    <path d="M12 7v5l3 3"></path>
  </svg>`;

  const HISTORY_BTN_ID = 'ra-history-btn';

  function buildHistoryButton() {
    const btn = document.createElement('button');
    btn.id = HISTORY_BTN_ID;
    btn.type = 'button';
    btn.className = 'ra-random-btn ra-history-btn';
    btn.title = 'Random history — last 40 picks (Alt+H)';
    btn.setAttribute('aria-label', 'Random history');
    btn.innerHTML = HISTORY_SVG;
    btn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); openHistory(); });
    return btn;
  }

  function mountButton() {
    const host = headerHost();
    if (!host || !host.parent) return;

    if (!document.getElementById(BTN_ID)) {
      const btn = buildButton();
      if (host.before && host.before.parentElement === host.parent) host.parent.insertBefore(btn, host.before);
      else host.parent.appendChild(btn);
    }

    if (!document.getElementById(HISTORY_BTN_ID)) {
      const hist = buildHistoryButton();
      const anchor = document.getElementById(BTN_ID);
      if (anchor && anchor.parentElement) anchor.parentElement.insertBefore(hist, anchor.nextSibling);
      else if (host.before && host.before.parentElement === host.parent) host.parent.insertBefore(hist, host.before);
      else host.parent.appendChild(hist);
    }
  }

  // Svelte re-renders the header on navigation; put the buttons back if they vanish.
  let observer = null;
  function watchHeader() {
    if (observer) return;
    observer = new MutationObserver(() => {
      if (!document.getElementById(BTN_ID) || !document.getElementById(HISTORY_BTN_ID)) mountButton();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  /* ------------------------------------------------------------------ modal */

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .stage {
      position: fixed; inset: 0; z-index: 2147483000;
      display: flex; align-items: center; justify-content: center;
      padding: 24px;
      background: rgba(3, 5, 4, .74);
      backdrop-filter: blur(10px) saturate(.9);
      font-family: "Inter Variable", Inter, system-ui, sans-serif;
      animation: fade .16s ease-out;
    }
    @keyframes fade { from { opacity: 0 } to { opacity: 1 } }
    @keyframes rise { from { opacity: 0; transform: translateY(10px) scale(.99) } to { opacity: 1; transform: none } }
    @keyframes spin { to { transform: rotate(360deg) } }
    @keyframes shimmer { 0% { background-position: -320px 0 } 100% { background-position: 320px 0 } }

    .card {
      position: relative;
      width: 100%; max-width: 760px;
      max-height: calc(100dvh - 40px); overflow: auto;
      display: grid; grid-template-columns: 196px 1fr;
      gap: 22px;
      padding: 20px;
      background: #0b0d0b;
      border: 1px solid rgba(255,255,255,.12);
      clip-path: polygon(16px 0, 100% 0, 100% calc(100% - 16px), calc(100% - 16px) 100%, 0 100%, 0 16px);
      box-shadow: 0 30px 90px rgba(0,0,0,.7);
      animation: rise .2s cubic-bezier(.2,.7,.3,1);
    }
    .card::after {
      content: ""; position: absolute; inset: 0; pointer-events: none;
      background: linear-gradient(135deg, oklch(76.8% .233 130.85 / .10), transparent 42%);
    }
    .poster {
      position: relative; width: 100%; align-self: stretch; min-height: 264px;
      background: #141614; border: 1px solid rgba(255,255,255,.08); overflow: hidden;
      clip-path: polygon(10px 0, 100% 0, 100% calc(100% - 10px), calc(100% - 10px) 100%, 0 100%, 0 10px);
    }
    .poster img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .poster.skeleton, .sk {
      background-image: linear-gradient(90deg, #141614 0%, #1e211e 40%, #141614 80%);
      background-size: 320px 100%; background-repeat: no-repeat;
      animation: shimmer 1.1s linear infinite;
    }
    .body { min-width: 0; display: flex; flex-direction: column; }
    .kicker {
      display: flex; align-items: center; gap: 8px; margin-bottom: 10px;
      font-size: 10px; font-weight: 800; letter-spacing: 1.6px; text-transform: uppercase;
      color: rgba(255,255,255,.42);
    }
    .badge {
      padding: 3px 7px; color: #04140a; background: oklch(76.8% .233 130.85);
      font-size: 10px; font-weight: 800; letter-spacing: 1.2px;
      clip-path: polygon(4px 0, 100% 0, 100% calc(100% - 4px), calc(100% - 4px) 100%, 0 100%, 0 4px);
    }
    h2 {
      margin: 0 0 8px; color: #fff; font-size: 25px; line-height: 1.16;
      font-weight: 800; letter-spacing: -.4px;
      display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
    }
    .meta { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }
    .pill {
      padding: 4px 8px; border: 1px solid rgba(255,255,255,.18); border-radius: 3px;
      font-size: 11px; font-weight: 600; color: rgba(255,255,255,.78);
    }
    .pill.score { color: oklch(76.8% .233 130.85); border-color: oklch(76.8% .233 130.85 / .45); }
    .desc {
      margin: 0 0 16px; color: rgba(255,255,255,.62); font-size: 13px; line-height: 1.62;
      display: -webkit-box; -webkit-line-clamp: 6; -webkit-box-orient: vertical; overflow: hidden;
    }
    .actions { margin-top: auto; display: flex; flex-wrap: wrap; gap: 9px; align-items: center; }
    .btn {
      display: inline-flex; align-items: center; gap: 7px;
      height: 38px; padding: 0 15px; cursor: pointer;
      font: 800 11px/1 inherit; letter-spacing: 1.1px; text-transform: uppercase; text-decoration: none;
      border: 1px solid rgba(255,255,255,.16); background: rgba(255,255,255,.04); color: #eaeaea;
      clip-path: polygon(8px 0, 100% 0, 100% calc(100% - 8px), calc(100% - 8px) 100%, 0 100%, 0 8px);
      transition: background .16s ease, color .16s ease, border-color .16s ease;
    }
    .btn:hover { border-color: rgba(255,255,255,.4); color: #fff; background: rgba(255,255,255,.09); }
    .btn.primary {
      background: oklch(76.8% .233 130.85); color: #04140a; border-color: oklch(87% .128 130.85);
    }
    .btn.primary:hover { background: oklch(83% .233 130.85); color: #04140a; }
    .btn svg { width: 14px; height: 14px; }
    .close {
      position: absolute; top: 14px; right: 14px; width: 32px; height: 32px; z-index: 3;
      display: grid; place-items: center; cursor: pointer;
      background: rgba(255,255,255,.05); border: 1px solid rgba(255,255,255,.14); color: #ccc;
      font-size: 16px; line-height: 1;
    }
    .close:hover { color: #fff; border-color: rgba(255,255,255,.4); }
    .hint { margin-left: auto; font-size: 10px; letter-spacing: .8px; color: rgba(255,255,255,.3); text-transform: uppercase; }
    .spinner {
      width: 15px; height: 15px; border-radius: 50%;
      border: 2px solid rgba(255,255,255,.2); border-top-color: oklch(76.8% .233 130.85);
      animation: spin .8s linear infinite;
    }
    .rolling { display: flex; align-items: center; gap: 10px; color: rgba(255,255,255,.6); font-size: 13px; }
    .err { color: #ff8585; font-size: 13px; line-height: 1.5; }

    /* -------------------------------------------------------------- history */
    .hist {
      width: 100%; max-width: 540px;
      display: flex; flex-direction: column;
      max-height: calc(100dvh - 40px);
      padding: 15px 15px 11px;
      background: #0b0d0b;
      box-shadow: inset 0 0 0 1px rgba(255,255,255,.10), 0 30px 90px rgba(0,0,0,.7);
      clip-path: polygon(12px 0, 100% 0, 100% calc(100% - 12px), calc(100% - 12px) 100%, 0 100%, 0 12px);
      animation: rise .18s cubic-bezier(.2,.7,.3,1);
    }
    .hist-head { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
    .hist-title {
      font-size: 10px; font-weight: 800; letter-spacing: 1.7px;
      text-transform: uppercase; color: #fff;
    }
    .hist-count {
      padding: 2px 6px; font-size: 9px; font-weight: 800; letter-spacing: .8px;
      color: oklch(76.8% .233 130.85);
      box-shadow: inset 0 0 0 1px oklch(76.8% .233 130.85 / .45);
    }
    .hist-clear { margin-left: auto; }
    .hist .close { position: static; top: auto; right: auto; width: 28px; height: 28px; font-size: 13px; }
    .hist-list { display: flex; flex-direction: column; gap: 5px; overflow-y: auto; padding-right: 2px; }
    .hist-list::-webkit-scrollbar { width: 6px; }
    .hist-list::-webkit-scrollbar-thumb { background: oklch(76.8% .233 130.85 / .3); }
    .hist-row {
      display: grid; grid-template-columns: 34px 1fr auto 10px;
      grid-template-areas: "thumb text time chev";
      column-gap: 9px; align-items: center;
      padding: 5px 8px 5px 5px; color: inherit; cursor: pointer;
      background: #101410; box-shadow: inset 0 0 0 1px rgba(255,255,255,.055);
      clip-path: polygon(6px 0, 100% 0, 100% calc(100% - 6px), calc(100% - 6px) 100%, 0 100%, 0 6px);
      transition: background .14s ease, box-shadow .14s ease;
    }
    .hist-row:hover { background: #151a15; box-shadow: inset 0 0 0 1px rgba(255,255,255,.22); }
    .hist-row:focus-visible { outline: none; box-shadow: inset 0 0 0 1px rgba(255,255,255,.5); }
    .hist-row[aria-expanded="true"] {
      grid-template-columns: 64px 1fr auto 10px;
      grid-template-areas: "thumb text time chev" "acts acts acts acts";
      row-gap: 7px; padding-bottom: 7px;
      background: #161b16;
      box-shadow: inset 0 0 0 1px oklch(76.8% .233 130.85 / .5);
    }
    .hist-text { grid-area: text; min-width: 0; }
    .hist-chev {
      grid-area: chev; width: 10px; height: 10px;
      color: rgba(255,255,255,.3);
      transition: transform .16s ease, color .16s ease;
    }
    .hist-row[aria-expanded="true"] .hist-chev { transform: rotate(90deg); color: oklch(76.8% .233 130.85); }
    .hist-actions { grid-area: acts; display: none; gap: 6px; }
    .hist-row[aria-expanded="true"] .hist-actions { display: flex; }
    .mini {
      display: inline-flex; align-items: center; gap: 6px;
      height: 28px; padding: 0 11px; cursor: pointer; text-decoration: none;
      border: 0; appearance: none; -webkit-appearance: none;
      font-family: inherit; font-size: 10px; font-weight: 800; line-height: 1; letter-spacing: .9px; text-transform: uppercase;
      background: rgba(255,255,255,.04); color: #eaeaea;
      box-shadow: inset 0 0 0 1px rgba(255,255,255,.16);
      clip-path: polygon(6px 0, 100% 0, 100% calc(100% - 6px), calc(100% - 6px) 100%, 0 100%, 0 6px);
      transition: background .14s ease, color .14s ease, box-shadow .14s ease;
    }
    .mini:hover { color: #fff; background: rgba(255,255,255,.09); box-shadow: inset 0 0 0 1px rgba(255,255,255,.4); }
    .mini.primary {
      background: oklch(76.8% .233 130.85); color: #04140a;
      box-shadow: inset 0 0 0 1px oklch(87% .128 130.85);
    }
    .mini.primary:hover { background: oklch(83% .233 130.85); color: #04140a; }
    .hist-thumb {
      grid-area: thumb;
      width: 34px; height: 46px; object-fit: cover; display: block;
      background: #0d100d; box-shadow: inset 0 0 0 1px rgba(255,255,255,.06);
      transition: width .16s ease, height .16s ease;
    }
    .hist-row[aria-expanded="true"] .hist-thumb { width: 64px; height: 84px; }
    .hist-name {
      display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
      font-size: 12px; font-weight: 600; line-height: 1.25; color: #f0f0f0;
    }
    .hist-meta {
      margin-top: 2px; font-size: 9px; font-weight: 700; letter-spacing: .7px;
      text-transform: uppercase; color: rgba(255,255,255,.34);
    }
    .hist-time {
      font-size: 9px; font-weight: 700; letter-spacing: .5px;
      color: rgba(255,255,255,.28); white-space: nowrap;
    }
    .hist-empty { padding: 26px 10px; text-align: center; font-size: 12px; line-height: 1.7; color: rgba(255,255,255,.42); }
    .hist-empty b { color: #fff; font-weight: 800; }
    .hist-foot {
      display: flex; align-items: center; gap: 8px; margin-top: 9px;
      font-size: 9px; letter-spacing: .9px; text-transform: uppercase; color: rgba(255,255,255,.22);
    }

    @media (max-width: 640px) {
      .card { grid-template-columns: 1fr; max-height: 88vh; overflow: auto; }
      .poster { max-width: 132px; }
      h2 { font-size: 20px; }
      .hint { display: none; }
      .hist { max-height: 88vh; padding: 13px 12px 10px; }
      .hist-time { display: none; }
    }
  `;

  let host = null;
  let root = null;
  let overlay = null;

  function ensureHost() {
    if (host && host.isConnected) return;
    host = document.createElement('div');
    host.id = 'ra-random-host';
    host.style.cssText = 'all: initial; position: fixed; inset: 0; z-index: 2147483000; display: none;';
    root = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = CSS;
    root.appendChild(style);
    document.documentElement.appendChild(host);
  }

  function closeOverlay() {
    if (overlay) { overlay.remove(); overlay = null; }
    if (host) host.style.display = 'none';
    document.documentElement.style.removeProperty('overflow');
  }

  function openOverlay() {
    ensureHost();
    host.style.display = 'block';
    if (overlay) overlay.remove();
    overlay = document.createElement('div');
    overlay.className = 'stage';
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) { closeOverlay(); return; }
      // Watch now / Details lead away from the page — close the panel first
      const link = e.target instanceof Element ? e.target.closest('a[href]') : null;
      if (!link) return;
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      closeOverlay();
    });
    root.appendChild(overlay);
    document.documentElement.style.overflow = 'hidden';
    return overlay;
  }

  function renderLoading() {
    if (!overlay) return;
    overlay.innerHTML = `
      <div class="card" role="dialog" aria-modal="true" aria-label="Random anime">
        <div class="poster skeleton"></div>
        <div class="body">
          <div class="kicker">Random pick</div>
          <div class="sk" style="height:26px;width:78%;margin:2px 0 10px;"></div>
          <div class="sk" style="height:14px;width:46%;margin-bottom:16px;"></div>
          <div class="sk" style="height:12px;width:100%;margin-bottom:8px;"></div>
          <div class="sk" style="height:12px;width:92%;margin-bottom:8px;"></div>
          <div class="sk" style="height:12px;width:64%;margin-bottom:18px;"></div>
          <div class="rolling"><span class="spinner"></span> Rolling the dice…</div>
        </div>
      </div>`;
  }

  function renderCard(view, error) {
    if (!overlay) return;
    const meta = [];
    if (view) {
      if (view.year) meta.push(`<span class="pill">${view.year}</span>`);
      if (view.status) meta.push(`<span class="pill">${view.status}</span>`);
      if (view.score) meta.push(`<span class="pill score">★ ${view.score.toFixed(1)}</span>`);
      if (view.episodes) meta.push(`<span class="pill">${view.episodes} ep</span>`);
      if (view.subbed) meta.push(`<span class="pill">SUB ${view.subbed}</span>`);
      if (view.dubbed) meta.push(`<span class="pill">DUB ${view.dubbed}</span>`);
    }
    const genres = view && view.genres.length
      ? view.genres.map((g) => `<span class="pill">${escapeHTML(g)}</span>`).join('') : '';

    overlay.innerHTML = `
      <div class="card" role="dialog" aria-modal="true" aria-label="Random anime">
        <button class="close" type="button" aria-label="Close">✕</button>
        <div class="poster">${view && view.cover ? `<img alt="" src="${view.cover}">` : ''}</div>
        <div class="body">
          <div class="kicker">Random pick <span class="badge">${view ? view.format : '—'}</span></div>
          <h2>${view ? escapeHTML(view.title) : 'No luck'}</h2>
          <div class="meta">${meta.join('')}${genres}</div>
          <p class="desc">${error ? `<span class="err">${escapeHTML(error)}</span>` : escapeHTML(view ? view.desc : '')}</p>
          <div class="actions">
            ${view ? `<a class="btn primary" href="${watchHref(view)}">▶ Watch now</a>
            <a class="btn" href="/anime/${encodeURIComponent(view.id)}">Details</a>` : ''}
            <button class="btn" type="button" data-act="reroll">⟳ Reroll</button>
            <span class="hint">Alt+R · Esc</span>
          </div>
        </div>
      </div>`;

    overlay.querySelector('.close').addEventListener('click', closeOverlay);
    const reroll = overlay.querySelector('[data-act="reroll"]');
    if (reroll) reroll.addEventListener('click', () => triggerRoll(reroll));
    const first = overlay.querySelector('a.btn.primary') || reroll;
    if (first) first.focus({ preventScroll: true });
  }

  function timeAgo(ts) {
    if (!ts) return '';
    const secs = Math.max(1, Math.round((Date.now() - ts) / 1000));
    if (secs < 60) return 'just now';
    const mins = Math.round(secs / 60);
    if (mins < 60) return mins + 'm ago';
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return hrs + 'h ago';
    return Math.round(hrs / 24) + 'd ago';
  }

  async function openHistory() {
    const entries = ((await store.get(HISTORY_KEY)) || []).filter((e) => e && e.id);
    const stage = openOverlay();

    const rows = entries.map((e) => {
      const meta = [e.format, e.year, e.score ? '★ ' + Number(e.score).toFixed(1) : '']
        .filter(Boolean).join(' · ');
      const thumb = e.cover
        ? `<img class="hist-thumb" src="${escapeHTML(e.cover)}" alt="" loading="lazy">`
        : '<span class="hist-thumb"></span>';
      const id = encodeURIComponent(e.id);
      return `<div class="hist-row" role="button" tabindex="0" aria-expanded="false">
          ${thumb}
          <span class="hist-text">
            <span class="hist-name">${escapeHTML(e.title || 'Untitled')}</span>
            <span class="hist-meta">${escapeHTML(meta)}</span>
          </span>
          <span class="hist-time">${timeAgo(e.at)}</span>
          <svg class="hist-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"></path></svg>
          <div class="hist-actions">
            <a class="mini primary" href="${watchHref(e)}">▶ Watch now</a>
            <a class="mini" href="/anime/${id}">Details</a>
          </div>
        </div>`;
    }).join('');

    stage.innerHTML = `
      <div class="hist" role="dialog" aria-modal="true" aria-label="Random history">
        <div class="hist-head">
          <span class="hist-title">History</span>
          <span class="hist-count">${entries.length}/${HISTORY_MAX}</span>
          ${entries.length ? '<button class="mini hist-clear" type="button">Clear</button>' : ''}
          <button class="close" type="button" aria-label="Close">✕</button>
        </div>
        <div class="hist-list">
          ${entries.length ? rows : '<div class="hist-empty">No rolls yet.<br>Hit <b>Random</b> or press <b>Alt+R</b>.</div>'}
        </div>
        <div class="hist-foot">Newest first · Alt+H reopens this list</div>
      </div>`;

    const closeBtn = stage.querySelector('.hist .close');
    if (closeBtn) closeBtn.addEventListener('click', closeOverlay);

    const clear = stage.querySelector('.hist-clear');
    if (clear) {
      clear.addEventListener('click', () => {
        store.set(HISTORY_KEY, []);
        store.set(RECENT_KEY, []);
        openHistory();
      });
    }

    // a dead cover URL should fall back to the empty plate, not a broken image icon
    stage.querySelectorAll('img.hist-thumb').forEach((img) => {
      img.addEventListener('error', () => {
        const plate = document.createElement('span');
        plate.className = 'hist-thumb';
        img.replaceWith(plate);
      });
    });

    const rowsEls = stage.querySelectorAll('.hist-row');
    const toggleRow = (row) => {
      const isOpen = row.getAttribute('aria-expanded') === 'true';
      rowsEls.forEach((other) => other.setAttribute('aria-expanded', 'false'));
      if (!isOpen) row.setAttribute('aria-expanded', 'true');
    };

    rowsEls.forEach((row) => {
      row.addEventListener('click', (ev) => {
        // the Watch now / Details links live inside the row — don't toggle on them
        if (ev.target.closest('.hist-actions')) return;
        toggleRow(row);
      });
      row.addEventListener('keydown', (ev) => {
        if (ev.target !== row) return;
        if (ev.key === 'Enter' || ev.key === ' ' || ev.key === 'Spacebar') {
          ev.preventDefault();
          toggleRow(row);
        }
      });
    });
    if (rowsEls.length) rowsEls[0].focus({ preventScroll: true });
  }

  function escapeHTML(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* ------------------------------------------------------------------ flow */

  let busy = false;

  async function triggerRoll(originEl) {
    if (busy) return;
    busy = true;
    const btn = document.getElementById(BTN_ID);
    if (btn) btn.dataset.busy = '1';
    if (originEl && originEl.setAttribute) originEl.setAttribute('disabled', 'disabled');

    try {
      const settings = await getSettings();

      if (settings.openMode === 'watch') {
        const { pick, detail } = await roll(settings);
        const view = candidateView(pick, detail);
        await remember(view);
        location.href = watchHref(view);
        return;
      }

      openOverlay();
      renderLoading();
      const { pick, detail } = await roll(settings);
      const view = candidateView(pick, detail);
      await remember(view);
      if (!overlay) openOverlay();
      renderCard(view, null);
    } catch (err) {
      if (!overlay) openOverlay();
      renderCard(null, (err && err.message) || 'Something went wrong.');
    } finally {
      busy = false;
      if (btn) delete btn.dataset.busy;
      document.querySelectorAll('.ra-random-btn').forEach((b) => b.removeAttribute('disabled'));
    }
  }

  /* -------------------------------------------------------------- lifecycle */

  function boot() {
    mountButton();
    watchHeader();

    document.addEventListener('keydown', (e) => {
      if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'r' || e.key === 'R')) {
        e.preventDefault();
        triggerRoll();
      } else if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'h' || e.key === 'H')) {
        e.preventDefault();
        openHistory();
      } else if (e.key === 'Escape' && overlay) {
        closeOverlay();
      }
    });

    // SPA navigations can drop the header subtree entirely.
    let last = location.href;
    setInterval(() => {
      if (location.href !== last) { last = location.href; mountButton(); }
    }, 700);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
