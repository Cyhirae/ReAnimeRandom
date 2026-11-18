const DEFAULTS = {
  tv: true,
  movie: true,
  ova: false,
  ona: false,
  special: false,
  excludeAdult: true,
  avoidRecent: true,
  minScore: 0,
  openMode: 'card'
};

const FORMATS = [
  ['tv', 'TV'],
  ['movie', 'Movies'],
  ['ova', 'OVA'],
  ['ona', 'ONA'],
  ['special', 'Specials']
];

const SCORES = [
  [0, 'Any'], [50, '5.0+'], [55, '5.5+'], [60, '6.0+'], [65, '6.5+'],
  [70, '7.0+'], [75, '7.5+'], [80, '8.0+'], [85, '8.5+'], [90, '9.0+']
];

/* chrome.storage inside the extension; localStorage when the page is opened
   directly, so the styling can be previewed without loading the extension. */
const hasChrome = !!(window.chrome && chrome.storage && chrome.storage.local);

const store = {
  get(key) {
    return new Promise((resolve) => {
      if (hasChrome) { chrome.storage.local.get([key], (o) => resolve(o ? o[key] : undefined)); return; }
      try { resolve(JSON.parse(localStorage.getItem('ra_' + key))); } catch { resolve(undefined); }
    });
  },
  set(obj) {
    return new Promise((resolve) => {
      if (hasChrome) { chrome.storage.local.set(obj, resolve); return; }
      Object.entries(obj).forEach(([k, v]) => {
        try { localStorage.setItem('ra_' + k, JSON.stringify(v)); } catch {}
      });
      resolve();
    });
  },
  remove(key) {
    return new Promise((resolve) => {
      if (hasChrome) { chrome.storage.local.remove(key, resolve); return; }
      try { localStorage.removeItem('ra_' + key); } catch {}
      resolve();
    });
  }
};

let state = { ...DEFAULTS };

/* ------------------------------------------------------------------ render */

function makeChip(label, value, onclick) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'chip';
  btn.dataset.v = String(value);
  btn.textContent = label;
  btn.addEventListener('click', onclick);
  return btn;
}

function buildFormatChips() {
  const box = document.getElementById('formats');
  box.innerHTML = '';
  for (const [key, label] of FORMATS) {
    const btn = makeChip(label, key, () => {
      const next = !state[key];
      if (!next) {
        const remaining = FORMATS.filter(([k]) => k !== key && state[k]).length;
        if (!remaining) { status('Keep one on'); return; }
      }
      state[key] = next;
      render();
      save();
    });
    btn.dataset.k = key;
    box.appendChild(btn);
  }
}

function buildScoreChips() {
  const box = document.getElementById('chips');
  box.innerHTML = '';
  for (const [value, label] of SCORES) {
    box.appendChild(makeChip(label, value, () => {
      state.minScore = value;
      render();
      save();
    }));
  }
}

function render() {
  document.querySelectorAll('#filters .chip').forEach((c) => {
    c.setAttribute('aria-pressed', String(!!state[c.dataset.k]));
  });
  document.querySelectorAll('#formats .chip').forEach((c) => {
    c.setAttribute('aria-pressed', String(!!state[c.dataset.k]));
  });
  document.querySelectorAll('#chips .chip').forEach((c) => {
    c.setAttribute('aria-pressed', String(Number(c.dataset.v) === Number(state.minScore)));
  });
  document.querySelectorAll('#mode button').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.v === state.openMode));
  });
}

/* ------------------------------------------------------------------ status */

let statusTimer = null;
function status(text) {
  const el = document.getElementById('status');
  el.textContent = text;
  el.classList.add('on');
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => {
    el.classList.remove('on');
    el.textContent = 'Autosave';
  }, 1500);
}

/* -------------------------------------------------------------------- save */

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    await store.set({ settings: { ...state } });
    status('Saved');
  }, 120);
}

/* -------------------------------------------------------------------- wire */

function wire() {
  document.querySelectorAll('#filters .chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      const k = btn.dataset.k;
      state[k] = !state[k];
      render();
      save();
    });
  });

  document.querySelectorAll('#mode button').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.openMode = btn.dataset.v;
      render();
      save();
    });
  });

  document.getElementById('reset').addEventListener('click', async () => {
    state = { ...DEFAULTS };
    await store.set({ settings: { ...state } });
    await store.remove('recent');
    render();
    status('Reset');
  });
}

/* -------------------------------------------------------------------- boot */

(async function boot() {
  buildFormatChips();
  buildScoreChips();
  const saved = await store.get('settings');
  state = { ...DEFAULTS, ...(saved || {}) };
  if (!SCORES.some(([v]) => Number(v) === Number(state.minScore))) state.minScore = 0;
  if (!FORMATS.some(([k]) => state[k])) state.tv = true;
  wire();
  render();
})();
