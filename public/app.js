/* Wasbeer UI. No framework, no build step. */

import { createAmbient } from './ambient.js';

const $ = (sel) => document.querySelector(sel);
const el = (tag, props = {}, kids = []) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    // aria-* / data-* are attributes; assigning them as properties silently does nothing.
    if (k.includes('-')) n.setAttribute(k, v);
    else n[k] = v;
  }
  for (const k of [].concat(kids)) n.append(k);
  return n;
};
const svg = (tag, attrs = {}) => {
  const n = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
};

let CATALOG = [];        // describeCycle() for every cycle, in dial order
let CYCLES = new Map();  // code -> cycle
let FAVS = [];
let STATUS = null;
let wasRunning = null;
let timer = null;
let ambient = null;

/* ---------------- themes ---------------- */

const THEMES = [
  { id: 'water', icon: '🌊', label: 'Diep water',
    desc: 'Rustig, traag licht door het water, opstijgende bellen.',
    swatch: 'linear-gradient(135deg,#0a1b26,#2aa79a)' },
  { id: 'console', icon: '📟', label: 'Controlekamer',
    desc: 'Bijna zwart, fijn raster, monospace cijfers. Instrumenten.',
    swatch: 'linear-gradient(135deg,#04070a,#2fd3cf)' },
  { id: 'toy', icon: '🫧', label: 'Speelgoed',
    desc: 'Verzadigd paars-roze, dikke vormen, grote bellen.',
    swatch: 'linear-gradient(135deg,#271651,#ff79cf)' },
  { id: 'division', icon: '🔶', label: 'Tactisch',
    desc: 'Amber op zwart, afgeschuinde panelen, stofdeeltjes en scanlijnen.',
    swatch: 'linear-gradient(135deg,#0b0b09 40%,#ff7a1c)' },
];

function applyTheme(id) {
  const theme = THEMES.find((t) => t.id === id) ? id : 'water';
  document.documentElement.dataset.theme = theme;
  $('#theme-btn').textContent = THEMES.find((t) => t.id === theme).icon;
  ambient?.setTheme(theme);
  try { localStorage.setItem('wasbeer-theme', theme); } catch { /* private mode */ }
  // keep the browser chrome in step
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', bg);
}

function openThemeSheet() {
  const current = document.documentElement.dataset.theme;
  const list = el('div', { className: 'theme-list' });
  for (const t of THEMES) {
    const card = el('button', {
      className: 'theme-card', type: 'button', 'aria-pressed': String(t.id === current),
      onclick: () => { applyTheme(t.id); openThemeSheet(); },
    }, [
      el('span', { className: 'theme-swatch' }),
      el('span', {}, [el('b', { textContent: `${t.icon} ${t.label}` }), el('span', { textContent: t.desc })]),
    ]);
    card.querySelector('.theme-swatch').style.background = t.swatch;
    list.append(card);
  }
  openSheet('Thema', list, [btn('Klaar', '', closeSheet)]);
}

/* ---------------- api ---------------- */

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error ?? `HTTP ${res.status}`), { data, status: res.status });
  return data;
}

function toast(message, bad = false) {
  document.querySelector('.toast')?.remove();
  const t = el('div', { className: `toast${bad ? ' bad' : ''}`, textContent: message });
  document.body.append(t);
  setTimeout(() => t.remove(), bad ? 6000 : 3200);
}

/* ---------------- formatting ---------------- */

const TEMP = (v) => (v === 'cold' ? 'Koud' : v === 'none' ? '—' : `${v}°`);
const SPIN = (v) => ({ noSpin: 'Geen', rinseHold: 'Spoelstop' }[v] ?? `${v} tpm`);
const DRY = (v) => ({ none: 'Niet drogen', cupboard: 'Kastdroog' }[v] ?? `${v} min`);
const SOAK = (v) => (v === 'on' ? 'Aan' : 'Uit');
const TYPE = { allInOne: 'Wassen + drogen', washingOnly: 'Alleen wassen', dryingOnly: 'Alleen drogen' };
const PHASE = { wash: 'wassen', rinse: 'spoelen', spin: 'centrifuge', dry: 'drogen', weightSensing: 'wegen' };

const FORMAT = {
  waterTemperature: TEMP, spinLevel: SPIN, rinseCycle: (v) => `${v}×`, dryingLevel: DRY, bubbleSoak: SOAK,
};

const minutes = (m) => {
  if (m == null) return '';
  const h = Math.floor(m / 60);
  return h ? `${h}u ${String(m % 60).padStart(2, '0')}` : `${m} min`;
};

const clockIn = (mins) => new Date(Date.now() + mins * 60000)
  .toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });

/* ---------------- icons ---------------- */

const EMOJI = ['👕', '🧺', '🛏️', '🐑', '🧦', '👖', '🧥', '🏃', '🎽', '🍼', '🧼', '🧽', '🌀', '💧', '🌬️', '☀️'];

/** Sensible default from what the cycle can physically do. */
function defaultIcon(code) {
  const byCode = { 29: '🧽', 28: '🌀', 27: '💧', 26: '🐑', 20: '🛏️', 33: '🧼', '1F': '🏃', 36: '☀️' };
  if (byCode[code]) return byCode[code];
  const c = CYCLES.get(code);
  if (c?.cycleType === 'dryingOnly') return '🌬️';
  return '👕';
}
const iconFor = (fav) => fav.icon || defaultIcon(fav.cycle);

/** Card tint: warmer wash, cooler wash, drying. */
function tintFor(fav) {
  const t = fav.waterTemperature;
  if (CYCLES.get(fav.cycle)?.cycleType === 'dryingOnly') return '#e0a23c';
  if (t === 'none' || t == null) return '#7f8fa3';
  if (t === 'cold' || Number(t) <= 20) return '#5aa9e6';
  if (Number(t) <= 40) return '#46b8a8';
  if (Number(t) <= 60) return '#e09a4a';
  return '#e2695f';
}

/* ---------------- the machine drawing ---------------- */

function buildDrum() {
  // perforations, so rotation is actually visible
  const holes = $('#holes');
  for (const [r, n] of [[48, 16], [34, 12], [20, 8]]) {
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      holes.append(svg('circle', {
        cx: (100 + Math.cos(a) * r).toFixed(1),
        cy: (100 + Math.sin(a) * r).toFixed(1),
        r: 2.6,
      }));
    }
  }
  $('#wave').setAttribute('d', 'M-20,12 Q5,0 30,12 T80,12 T130,12 T180,12 T230,12 L230,220 L-20,220 Z');

  const bubbles = $('#bubbles');
  for (let i = 0; i < 9; i++) {
    const c = svg('circle', { cx: 44 + i * 14, cy: 150 + (i % 3) * 10, r: 2 + (i % 4) });
    c.style.setProperty('--bt', `${2.4 + (i % 5) * 0.55}s`);
    c.style.animationDelay = `${(i * 0.37) % 3}s`;
    bubbles.append(c);
  }
}

const WATER_COLOUR = (t) => {
  if (t === 'cold' || Number(t) <= 20) return '#5aa9e6';
  if (Number(t) <= 30) return '#4a90d0';
  if (Number(t) <= 40) return '#46b8a8';
  if (Number(t) <= 60) return '#e09a4a';
  if (Number(t) >= 70) return '#e2695f';
  return '#4a90d0';
};

function drawMachine(s) {
  const ring = $('#ring');
  const drum = $('#drum');
  const bubbles = $('#bubbles');
  const water = $('#water');
  const C = 502.6; // 2 * pi * 80

  const running = Boolean(s?.running);
  const phase = s?.jobPhase ?? s?.jobState ?? null;
  const pct = running ? (s.progress ?? 0) : 0;

  ring.style.strokeDashoffset = String(C * (1 - pct / 100));
  ring.style.stroke = running ? 'var(--run)' : (s ? 'var(--accent)' : 'var(--line)');

  // drum: slow tumble while washing, fast while spinning, still when idle
  const speed = !running ? null : phase === 'spin' ? '0.65s' : phase === 'dry' ? '3s' : '6s';
  drum.classList.toggle('still', !speed);
  drum.style.setProperty('--drum-speed', speed ?? '0s');
  drum.style.animationName = speed ? 'tumble' : 'none';

  // water: high while washing or rinsing, drained for spin or drying
  const wet = running && (phase === 'wash' || phase === 'rinse' || phase === 'weightSensing');
  water.style.setProperty('--water-y', wet ? '48px' : '128px');
  $('#wave').style.fill = WATER_COLOUR(s?.waterTemperature);

  bubbles.classList.toggle('on', Boolean(wet && !document.body.classList.contains('reduce')));
}

/* ---------------- status ---------------- */

function renderStatus() {
  const text = $('#state-text');
  const sub = $('#state-sub');
  const rem = $('#remaining');
  const eta = $('#eta');

  drawMachine(STATUS);
  ambient?.setStatus(STATUS);

  if (!STATUS) {
    text.textContent = 'Geen verbinding';
    sub.textContent = 'Kan de machine niet bereiken.';
    rem.textContent = ''; eta.textContent = '';
    $('#phases').replaceChildren();
    $('#current-opts').replaceChildren();
    $('#controls').replaceChildren();
    return;
  }

  const s = STATUS;
  const cyc = CYCLES.get(s.cycle);

  // One word where possible -- it shares a narrow column with the drum.
  const phaseWord = PHASE[s.jobPhase] ?? 'wassen';
  if (s.running) text.textContent = phaseWord[0].toUpperCase() + phaseWord.slice(1);
  else if (s.operatingState === 'paused') text.textContent = 'Gepauzeerd';
  else text.textContent = 'Klaar';

  sub.textContent = cyc
    ? `${cyc.label}${s.cycleType ? ` · ${TYPE[s.cycleType] ?? s.cycleType}` : ''}`
    : (s.cycle ? `Programma ${s.cycle}` : 'Geen programma gekozen');

  rem.textContent = s.running && s.remainingTime ? minutes(s.remainingTime) : '';
  eta.textContent = s.running && s.remainingTime ? `klaar om ${clockIn(s.remainingTime)}` : '';

  // phases, with the ones already behind us dimmed
  const phases = $('#phases');
  phases.replaceChildren();
  if (s.running && s.phases?.length) {
    let seen = false;
    for (const p of s.phases) {
      const now = p.phaseName === s.jobPhase;
      if (now) seen = true;
      phases.append(el('span', {
        className: now ? 'now' : (seen ? '' : 'done'),
        textContent: `${PHASE[p.phaseName] ?? p.phaseName} ${p.timeInMin}m`,
      }));
    }
  }

  const chips = $('#current-opts');
  chips.replaceChildren();
  for (const k of ['waterTemperature', 'spinLevel', 'rinseCycle', 'dryingLevel']) {
    const v = s[k];
    if (v == null || v === 'none') continue;
    chips.append(el('span', { className: 'chip', textContent: FORMAT[k](v) }));
  }

  const controls = $('#controls');
  controls.replaceChildren();
  if (s.running) {
    controls.append(btn('Pauzeren', 'secondary', () => doControl('pause')));
    controls.append(btn('Afbreken', 'danger', () => confirmThen('Programma afbreken?', () => doControl('cancel'))));
  } else if (s.operatingState === 'paused') {
    controls.append(btn('Hervatten', '', () => doControl('resume')));
    controls.append(btn('Afbreken', 'danger', () => confirmThen('Programma afbreken?', () => doControl('cancel'))));
  } else {
    controls.append(btn('Starten', '', () => doControl('start')));
  }

  const banner = $('#banner');
  if (!s.remoteControl) {
    banner.hidden = false;
    banner.className = 'banner';
    banner.innerHTML = '<b>Smart Control staat uit.</b> Druk op de knop op de machine zelf — zonder dat negeert hij alles wat we sturen.';
  } else {
    banner.hidden = true;
  }

  // the wash just finished
  if (wasRunning === true && !s.running) celebrate();
  wasRunning = s.running;
}

function celebrate() {
  const logo = $('#logo');
  logo.classList.remove('cheer');
  void logo.offsetWidth;        // restart the animation
  logo.classList.add('cheer');
  toast('Was is klaar! 🦝');
}

const btn = (label, cls, onclick) =>
  el('button', { className: `btn ${cls}`.trim(), textContent: label, onclick });

async function doControl(action, force = false) {
  try {
    const r = await api('/api/control', { method: 'POST', body: { action, force } });
    STATUS = r.status ?? STATUS;
    renderStatus();
    toast('Verstuurd.');
  } catch (err) {
    toast(err.message, true);
    if (err.data?.status) { STATUS = err.data.status; renderStatus(); }
  }
}

/* ---------------- favourites ---------------- */

function renderFavourites() {
  const grid = $('#favourites');
  grid.replaceChildren();
  $('#empty').hidden = FAVS.length > 0;

  for (const f of FAVS) {
    const cyc = CYCLES.get(f.cycle);
    const bits = [];
    if (f.waterTemperature && f.waterTemperature !== 'none') bits.push(TEMP(f.waterTemperature));
    if (f.spinLevel) bits.push(SPIN(f.spinLevel));
    if (f.dryingLevel && f.dryingLevel !== 'none') bits.push(DRY(f.dryingLevel));

    const card = el('button', { className: `fav${f.valid ? '' : ' invalid'}`, onclick: () => openApply(f) }, [
      el('span', { className: 'fav-icon', textContent: iconFor(f) }),
      el('span', { className: 'fav-label', textContent: f.label }),
      el('span', { className: 'fav-cycle', textContent: cyc ? cyc.label : `Programma ${f.cycle}` }),
      el('span', { className: 'fav-meta', textContent: f.valid ? bits.join(' · ') : 'Ongeldig — bewerk' }),
    ]);
    card.style.setProperty('--tint', tintFor(f));
    grid.append(card);
  }
}

/* ---------------- sheet ---------------- */

function openSheet(title, bodyNodes, actions, icon) {
  $('#sheet-title').replaceChildren(
    ...(icon ? [el('span', { textContent: icon })] : []),
    el('span', { textContent: title }),
  );
  $('#sheet-body').replaceChildren(...[].concat(bodyNodes));
  $('#sheet-actions').replaceChildren(...[].concat(actions));
  $('#sheet').hidden = false;
}
const closeSheet = () => { $('#sheet').hidden = true; };

function confirmThen(question, fn) {
  openSheet(question, el('p', { className: 'muted', textContent: 'Dit kan niet ongedaan gemaakt worden.' }), [
    btn('Annuleren', 'secondary', closeSheet),
    btn('Doorgaan', 'danger', () => { closeSheet(); fn(); }),
  ]);
}

function openApply(fav) {
  const cyc = CYCLES.get(fav.cycle);
  const rows = el('div');

  rows.append(el('p', { className: 'muted small', textContent: cyc ? cyc.label : `Programma ${fav.cycle}` }));
  for (const [k, fmt] of Object.entries(FORMAT)) {
    const opt = cyc?.options[k];
    if (!opt) continue;
    rows.append(el('div', { className: 'row' }, [
      el('label', { textContent: opt.label }),
      el('span', {
        className: opt.adjustable ? '' : 'fixed',
        textContent: fmt(fav[k]) + (opt.adjustable ? '' : ' (vast)'),
      }),
    ]));
  }

  const details = el('details', { className: 'preview' }, el('summary', { textContent: 'Wat wordt er verstuurd?' }));
  rows.append(details);

  // Open straight away; the preview fills itself in when it arrives.
  openSheet(fav.label, rows, [
    btn('Bewerken', 'secondary', () => openEditor(fav)),
    btn('Instellen', '', () => applyFav(fav, false)),
    btn('Start', '', () => applyFav(fav, true)),
  ], iconFor(fav));

  api('/api/preview', { method: 'POST', body: fav }).then((p) => {
    details.append(el('code', { textContent: p.preview.join('\n') }));
    if (p.skipped.length) {
      details.append(el('code', {
        textContent: `\nNiet verstuurd (machine legt deze vast):\n${p.skipped.map((s) => `  ${s.option}`).join('\n')}`,
      }));
    }
  }).catch(() => details.append(el('code', { textContent: 'Kon de preview niet laden.' })));
}

async function applyFav(fav, start, force = false) {
  try {
    const r = await api('/api/apply', { method: 'POST', body: { ...fav, start, force } });
    STATUS = r.status ?? STATUS;
    closeSheet();
    renderStatus();
    toast(start ? `${iconFor(fav)} ${fav.label} gestart.` : `${fav.label} ingesteld — nu nog starten.`);
  } catch (err) {
    if (err.data?.reason === 'running') {
      openSheet('De machine draait nog', el('p', { textContent: err.message }), [
        btn('Laat maar', 'secondary', closeSheet),
        btn('Toch wijzigen', 'danger', () => applyFav(fav, start, true)),
      ]);
      return;
    }
    toast(err.message, true);
    if (err.data?.status) { STATUS = err.data.status; renderStatus(); }
  }
}

/* ---------------- editor ---------------- */

function openEditor(existing) {
  const draft = existing
    ? { ...existing }
    : { label: '', cycle: CATALOG[0].code, icon: null,
        ...Object.fromEntries(Object.keys(FORMAT).map((k) => [k, null])) };

  const body = el('div');
  const render = () => {
    const cyc = CYCLES.get(draft.cycle);

    // fill blanks from the cycle's own defaults
    draft.cycleType ??= cyc.cycleType;
    if (!cyc.cycleTypes.includes(draft.cycleType)) draft.cycleType = cyc.cycleType;
    for (const k of Object.keys(FORMAT)) {
      const o = cyc.options[k];
      if (draft[k] == null || (o.values.length && !o.values.includes(draft[k]))) draft[k] = o.default;
    }

    body.replaceChildren();

    const name = el('input', {
      type: 'text', value: draft.label ?? '', placeholder: cyc.label,
      oninput: (e) => { draft.label = e.target.value; },
    });
    body.append(el('div', { className: 'row' }, [el('label', { textContent: 'Naam' }), name]));

    // icon
    const picks = el('div', { className: 'emoji-pick' });
    const current = draft.icon ?? defaultIcon(draft.cycle);
    for (const e of EMOJI) {
      picks.append(el('button', {
        type: 'button', textContent: e, 'aria-pressed': String(e === current),
        onclick: () => { draft.icon = e; render(); },
      }));
    }
    body.append(el('div', { className: 'row' }, [el('label', { textContent: 'Icoon' }), picks]));

    body.append(el('label', { className: 'muted small', textContent: 'Programma' }));
    const list = el('div', { className: 'cycle-list' });
    for (const c of CATALOG) {
      list.append(el('button', {
        type: 'button',
        'aria-pressed': String(c.code === draft.cycle),
        onclick: () => { draft.cycle = c.code; draft.cycleType = null; render(); },
        innerHTML: `${c.label}<span class="code">${c.code}</span>`,
      }));
    }
    body.append(list);

    if (cyc.cycleTypes.length > 1) {
      const seg = el('div', { className: 'seg' });
      for (const t of cyc.cycleTypes) {
        seg.append(el('button', {
          type: 'button', textContent: TYPE[t] ?? t,
          'aria-pressed': String(t === draft.cycleType),
          onclick: () => { draft.cycleType = t; render(); },
        }));
      }
      body.append(el('div', { className: 'row' }, [el('label', { textContent: 'Soort' }), seg]));
    }

    // the five options, constrained to what THIS cycle allows
    for (const [k, fmt] of Object.entries(FORMAT)) {
      const o = cyc.options[k];
      const row = el('div', { className: 'row' }, el('label', { textContent: o.label }));
      if (!o.adjustable) {
        row.append(el('span', { className: 'fixed', textContent: `${fmt(o.fixedAt ?? o.default)} (vast)` }));
      } else {
        const sel = el('select', { onchange: (e) => { draft[k] = e.target.value; } });
        for (const v of o.values) {
          sel.append(el('option', { value: v, textContent: fmt(v), selected: v === draft[k] }));
        }
        row.append(sel);
      }
      body.append(row);
    }
  };
  render();

  const actions = [
    btn('Annuleren', 'secondary', closeSheet),
    btn('Opslaan', '', async () => {
      try {
        const saved = await api('/api/favourites', { method: 'PUT', body: draft });
        if (!saved.ok) return toast(saved.errors.join('; '), true);
        FAVS = await api('/api/favourites');
        renderFavourites();
        closeSheet();
        toast('Opgeslagen.');
      } catch (err) { toast(err.message, true); }
    }),
  ];
  if (existing) {
    actions.unshift(btn('Wissen', 'danger', () => confirmThen(`"${existing.label}" verwijderen?`, async () => {
      await fetch(`/api/favourites/${encodeURIComponent(existing.id)}`, { method: 'DELETE' });
      FAVS = await api('/api/favourites');
      renderFavourites();
      closeSheet();
    })));
  }

  openSheet(existing ? 'Favoriet bewerken' : 'Nieuwe favoriet', body, actions);
}

/* ---------------- debug bar ---------------- */

/* On localhost always; anywhere else only with ?debug in the URL. */
const DEBUG_ALLOWED = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)
  || new URLSearchParams(location.search).has('debug');

const DEBUG_PHASES = [
  { id: 'live', label: 'Live' },
  { id: 'idle', label: 'Klaar / stil', patch: { running: false, operatingState: 'ready', jobPhase: null } },
  { id: 'weightSensing', label: 'Vullen' },
  { id: 'wash', label: 'Wassen' },
  { id: 'rinse', label: 'Spoelen' },
  { id: 'spin', label: 'Centrifuge' },
  { id: 'dry', label: 'Drogen' },
  { id: 'paused', label: 'Pauze', patch: { running: false, operatingState: 'paused', jobPhase: 'wash' } },
  { id: 'done', label: 'Net klaar 🎉', patch: { running: false, operatingState: 'ready', jobPhase: null } },
  { id: 'nocontrol', label: 'Smart Control uit', patch: { remoteControl: false } },
  { id: 'offline', label: 'Offline' },
];

const DEBUG_TEMPS = [['cold', 'Koud'], ['30', '30°'], ['40', '40°'], ['60', '60°'], ['70', '70°']];

const fake = { phase: 'live', temp: '40', progress: 45 };

function applyFake() {
  if (fake.phase === 'live') return refreshStatus();

  clearTimeout(timer);                 // stop polling while we are pretending

  if (fake.phase === 'offline') {
    STATUS = null;
    renderStatus();
    return;
  }

  const entry = DEBUG_PHASES.find((p) => p.id === fake.phase);
  const total = 145;

  // "Net klaar" only fires the celebration if we were running a moment ago.
  if (fake.phase === 'done') wasRunning = true;

  STATUS = {
    running: true,
    remoteControl: true,
    operatingState: 'running',
    cycle: '25',
    cycleType: 'washingOnly',
    jobPhase: entry.patch?.jobPhase !== undefined ? entry.patch.jobPhase : fake.phase,
    jobState: fake.phase,
    progress: fake.progress,
    remainingTime: Math.round(total * (1 - fake.progress / 100)),
    operationTime: total,
    waterTemperature: fake.temp,
    spinLevel: '1200',
    rinseCycle: '3',
    dryingLevel: fake.phase === 'dry' ? 'cupboard' : 'none',
    bubbleSoak: 'off',
    phases: [
      { phaseName: 'wash', timeInMin: 100 },
      { phaseName: 'rinse', timeInMin: 29 },
      { phaseName: 'spin', timeInMin: 15 },
    ],
    ...entry.patch,
  };
  renderStatus();
  ambient?.snap();      // show the selected phase at once, don't ease into it
  drawDebug();
}

let debugEl = null;

function drawDebug() {
  if (!debugEl) return;
  for (const b of debugEl.querySelectorAll('[data-phase]')) {
    b.setAttribute('aria-pressed', String(b.dataset.phase === fake.phase));
  }
  for (const b of debugEl.querySelectorAll('[data-temp]')) {
    b.setAttribute('aria-pressed', String(b.dataset.temp === fake.temp));
  }
  for (const b of debugEl.querySelectorAll('[data-theme-id]')) {
    b.setAttribute('aria-pressed', String(b.dataset.themeId === document.documentElement.dataset.theme));
  }
  debugEl.classList.toggle('faking', fake.phase !== 'live');
  const state = debugEl.querySelector('.debug-state');
  if (state) {
    const entry = DEBUG_PHASES.find((p) => p.id === fake.phase);
    state.textContent = fake.phase === 'live' ? '· live' : `· ${entry?.label ?? fake.phase} (gesimuleerd)`;
  }
}

function buildDebugBar() {
  const row = (label, kids) => el('div', { className: 'debug-row' }, [
    el('span', { className: 'debug-label', textContent: label }),
    el('div', { className: 'debug-btns' }, kids),
  ]);

  const phaseBtns = DEBUG_PHASES.map((p) => el('button', {
    type: 'button', textContent: p.label, 'data-phase': p.id,
    onclick: () => { fake.phase = p.id; applyFake(); drawDebug(); },
  }));

  const tempBtns = DEBUG_TEMPS.map(([v, label]) => el('button', {
    type: 'button', textContent: label, 'data-temp': v,
    onclick: () => { fake.temp = v; applyFake(); drawDebug(); },
  }));

  const themeBtns = THEMES.map((t) => el('button', {
    type: 'button', textContent: `${t.icon} ${t.label}`, 'data-theme-id': t.id,
    onclick: () => { applyTheme(t.id); drawDebug(); },
  }));

  const slider = el('input', {
    type: 'range', min: '0', max: '100', step: '1', value: String(fake.progress),
    className: 'debug-range',
    oninput: (e) => {
      fake.progress = Number(e.target.value);
      e.target.nextSibling.textContent = `${fake.progress}%`;
      if (fake.phase !== 'live') applyFake();
    },
  });

  const qualityBtns = [['Hoog', 2], ['Midden', 1], ['Laag', 0]].map(([label, t]) => el('button', {
    type: 'button', textContent: label, 'data-quality': String(t),
    onclick: () => { ambient?.setQuality(t); drawDebug(); },
  }));

  const stats = el('span', { className: 'debug-stats', textContent: '—' });

  // --- bubbles ---
  const MOODS = [
    [0.5, 'kalm'], [1.25, 'normaal'], [3, 'bruisend'], [7, 'veel zeep'],
    [15, 'zeepfeest 🫧'], [Infinity, 'VEEL TE VEEL 🚨'],
  ];
  const moodFor = (d) => MOODS.find(([max]) => d <= max)[1];

  let density = 1;
  try { density = Number(localStorage.getItem('wasbeer-density')) || 1; } catch { /* */ }

  const bubbleVal = el('span', { className: 'debug-val wide' });
  const bubbleSlider = el('input', {
    type: 'range', min: '0.25', max: '30', step: '0.25', value: String(density),
    className: 'debug-range',
    oninput: (e) => {
      density = Number(e.target.value);
      ambient?.setDensity(density);
      bubbleVal.textContent = `${density}× — ${moodFor(density)}`;
      debugEl?.classList.toggle('silly', density > 15);
      try { localStorage.setItem('wasbeer-density', String(density)); } catch { /* */ }
    },
  });
  bubbleVal.textContent = `${density}× — ${moodFor(density)}`;
  ambient?.setDensity(density);

  const body = el('div', { className: 'debug-body' }, [
    row('Fase', phaseBtns),
    row('Temp', tempBtns),
    row('Thema', themeBtns),
    row('Voortgang', [slider, el('span', { className: 'debug-val', textContent: `${fake.progress}%` })]),
    row('Bellen', [bubbleSlider, bubbleVal]),
    row('Grafisch', [...qualityBtns, stats]),
  ]);

  // live cost readout, so "GPU mode" is not a guess
  setInterval(() => {
    if (!debugEl?.classList.contains('open')) return;
    const s = ambient?.stats();
    if (!s) return;
    stats.textContent = `${s.bubbles} bellen · ${s.frameCost}ms (~${s.fps}fps) · tier ${s.tier} · ${s.phase}`;
    stats.classList.toggle('hot', s.frameCost > 16);
    for (const b of debugEl.querySelectorAll('[data-quality]')) {
      b.setAttribute('aria-pressed', String(Number(b.dataset.quality) === s.tier));
    }
  }, 1000);

  const toggle = el('button', {
    className: 'debug-toggle', type: 'button',
    innerHTML: '<b>DEBUG</b> <span class="debug-state"></span>',
    onclick: () => {
      debugEl.classList.toggle('open');
      try { localStorage.setItem('wasbeer-debug-open', debugEl.classList.contains('open') ? '1' : '0'); } catch { /* */ }
    },
  });

  debugEl = el('div', { className: 'debug', id: 'debug' }, [toggle, body]);
  document.body.append(debugEl);
  document.body.classList.add('has-debug');

  let open = '0';
  try { open = localStorage.getItem('wasbeer-debug-open') ?? '0'; } catch { /* */ }
  if (open === '1') debugEl.classList.add('open');

  drawDebug();
}

/* ---------------- boot ---------------- */

async function refreshStatus() {
  try {
    STATUS = await api('/api/status');
  } catch (err) {
    STATUS = null;
    const b = $('#banner');
    b.hidden = false;
    b.className = 'banner error';
    b.textContent = err.message;
  }
  renderStatus();
  // Poll quickly while something is happening, slowly when idle.
  clearTimeout(timer);
  timer = setTimeout(refreshStatus, STATUS?.running ? 20000 : 60000);
}

(async function init() {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) document.body.classList.add('reduce');
  buildDrum();

  ambient = createAmbient($('#ambient'));
  let saved = 'water';
  try { saved = localStorage.getItem('wasbeer-theme') ?? 'water'; } catch { /* private mode */ }
  applyTheme(saved);

  $('#sheet').addEventListener('click', (e) => { if (e.target.dataset.close !== undefined) closeSheet(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheet(); });
  $('#add').onclick = () => openEditor(null);
  $('#refresh').onclick = refreshStatus;
  $('#theme-btn').onclick = openThemeSheet;

  if (DEBUG_ALLOWED) buildDebugBar();

  try {
    const boot = await api('/api/bootstrap');
    CATALOG = boot.cycles;
    CYCLES = new Map(CATALOG.map((c) => [c.code, c]));
    FAVS = boot.favourites;
    renderFavourites();
  } catch (err) {
    toast(`Kon de catalogus niet laden: ${err.message}`, true);
  }
  refreshStatus();
})();
