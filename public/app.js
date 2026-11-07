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

/* ---------------- status ---------------- */

function renderStatus() {
  const text = $('#state-text');
  const sub = $('#state-sub');
  const rem = $('#remaining');
  const eta = $('#eta');

  // the porthole is drawn by the ambient engine, in its own frame loop
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


  // phases, with the ones already behind us dimmed
  renderTimeline(s);

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

  // --- moments, not states ---
  const phase = s.running ? (s.jobPhase ?? s.jobState ?? 'run')
    : (s.operatingState === 'paused' ? 'paused' : 'idle');
  if (lastPhase !== null && phase !== lastPhase) {
    if (phase === 'weightSensing' || (phase === 'wash' && lastPhase === 'idle')) ambient?.pulse('fill');
    else if (phase === 'spin') ambient?.pulse('drain');
    else if (phase === 'idle' && lastPhase !== 'paused') ambient?.pulse('done');
  }
  lastPhase = phase;

  syncClock(s);
  paintClock();

  // the wash just finished
  if (wasRunning === true && !s.running) celebrate();
  wasRunning = s.running;
}

/* ---------------- phase timeline ---------------- */

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/**
 * The cycle as one proportional bar rather than three floating pills.
 *
 * Segment widths follow the scheduled durations, so a 100-minute wash is
 * visibly five times the 15-minute spin. Fill comes from overall progress
 * distributed across the segments, which means the bar also answers "how far
 * into this phase am I" -- something the pills never showed.
 */
function renderTimeline(s) {
  const wrap = $('#phases');
  wrap.replaceChildren();

  const list = s?.phases ?? [];
  if (!s?.running || !list.length) return;

  const total = list.reduce((n, p) => n + (p.timeInMin || 0), 0) || 1;
  const elapsed = total * clamp((s.progress ?? 0) / 100, 0, 1);

  const bar = el('div', { className: 'timeline' });
  let start = 0;
  for (const p of list) {
    const dur = p.timeInMin || 1;
    const fill = clamp((elapsed - start) / dur, 0, 1);
    start += dur;

    const isNow = p.phaseName === s.jobPhase;
    // Durations are always emitted; CSS decides whether there is room for them
    // (only the current phase in the narrow card, all of them in monitor mode).
    const seg = el('div', {
      className: `tseg${isNow ? ' now' : ''}${fill >= 1 && !isNow ? ' done' : ''}`,
    }, [
      el('div', { className: 'tseg-track' }, el('div', { className: 'tseg-fill' })),
      el('div', { className: 'tseg-label' }, [
        el('b', { textContent: PHASE[p.phaseName] ?? p.phaseName }),
        el('span', { textContent: `${dur}m` }),
      ]),
    ]);
    seg.style.flexGrow = String(dur);
    seg.dataset.start = String(start - dur);
    seg.dataset.dur = String(dur);
    seg.querySelector('.tseg-fill').style.width = `${(fill * 100).toFixed(1)}%`;
    bar.append(seg);
  }
  wrap.append(bar);
}

/**
 * Move the fills from the ticking clock rather than rebuilding the bar, so the
 * timeline creeps along with the countdown instead of stepping once per poll.
 */
function updateTimelineFills(s, pct) {
  const segs = $('#phases').querySelectorAll('.tseg');
  if (!segs.length) return;
  const total = (s.phases ?? []).reduce((n, p) => n + (p.timeInMin || 0), 0) || 1;
  const elapsed = total * clamp(pct / 100, 0, 1);
  for (const seg of segs) {
    const start = Number(seg.dataset.start), dur = Number(seg.dataset.dur) || 1;
    const fill = clamp((elapsed - start) / dur, 0, 1);
    seg.querySelector('.tseg-fill').style.width = `${(fill * 100).toFixed(1)}%`;
  }
}

/* ---------------- live countdown, tab title, favicon ---------------- */

let lastPhase = null;
let endsAt = null;
let ticker = null;
let livePct = null;      // progress interpolated from the clock, 0..100

/**
 * Anchor an absolute end time from the poll, then count down locally. The API
 * only reports whole minutes, so re-anchoring on every poll would make the
 * seconds jump; keep the old end time unless the new reading disagrees by more
 * than 90 seconds.
 */
function syncClock(s) {
  if (!s?.running || s.remainingTime == null) { endsAt = null; return; }
  const predicted = Date.now() + s.remainingTime * 60000;
  if (endsAt === null || Math.abs(predicted - endsAt) > 90000) endsAt = predicted;
}

function countdown(ms) {
  const t = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60;
  const mm = String(m).padStart(2, '0'), ss = String(sec).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

const favCanvas = document.createElement('canvas');
function paintFavicon(pct, colour) {
  favCanvas.width = favCanvas.height = 32;
  const k = favCanvas.getContext('2d');
  k.clearRect(0, 0, 32, 32);
  k.lineWidth = 5; k.lineCap = 'round';
  k.strokeStyle = 'rgba(255,255,255,0.22)';
  k.beginPath(); k.arc(16, 16, 12, 0, Math.PI * 2); k.stroke();
  if (pct > 0.005) {
    k.strokeStyle = colour;
    k.beginPath(); k.arc(16, 16, 12, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * pct); k.stroke();
  } else {
    k.fillStyle = colour;
    k.beginPath(); k.arc(16, 16, 5, 0, Math.PI * 2); k.fill();
  }
  let link = document.querySelector('link[rel=icon]');
  if (!link) { link = el('link', { rel: 'icon' }); document.head.append(link); }
  link.href = favCanvas.toDataURL('image/png');
}

function paintClock() {
  const s = STATUS;
  const rem = $('#remaining'), eta = $('#eta');
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--run').trim() || '#4fb8e8';

  if (!s) {
    livePct = null; ambient?.setProgress(null);
    rem.textContent = ''; eta.textContent = '';
    document.title = 'Wasbeer — geen verbinding';
    paintFavicon(0, '#e2695f');
    return;
  }
  if (!s.running || endsAt === null) {
    livePct = null; ambient?.setProgress(null);
    rem.textContent = ''; eta.textContent = '';
    document.title = s.operatingState === 'paused' ? 'Gepauzeerd · Wasbeer' : 'Klaar · Wasbeer';
    paintFavicon(0, s.operatingState === 'paused' ? '#e0a23c' : '#3fc3b0');
    return;
  }
  const left = endsAt - Date.now();

  // Interpolate progress from the live clock. The API reports whole percent,
  // which is far too coarse for anything that reacts within a phase -- the
  // rinse drains arrived as jumps rather than drains.
  const op = s.operationTime || (s.phases ?? []).reduce((n, p) => n + (p.timeInMin || 0), 0);
  if (op > 0) {
    livePct = clamp(((op - left / 60000) / op) * 100, 0, 100);
    ambient?.setProgress(livePct);
    updateTimelineFills(s, livePct);
  }

  const text = countdown(left);
  rem.textContent = text;
  eta.textContent = `klaar om ${new Date(endsAt).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' })}`;
  document.title = `${text} · ${PHASE[s.jobPhase] ?? 'wassen'} · Wasbeer`;
  paintFavicon((s.progress ?? 0) / 100, accent);
}

/* ---------------- token ---------------- */

const CREATE_TOKEN_URL = 'https://account.smartthings.com/tokens';

function tokenStatusLine(m) {
  if (!m.present) return ['Geen token ingesteld.', 'bad'];
  if (m.lastAuthFailure) return ['Het token wordt geweigerd — waarschijnlijk verlopen.', 'bad'];
  if (m.likelyExpired) return [`Opgeslagen ${m.ageHours} uur geleden, dus waarschijnlijk verlopen.`, 'bad'];
  if (m.hoursLeft != null && m.hoursLeft < 4) return [`Nog ongeveer ${m.hoursLeft} uur geldig.`, 'warn'];
  if (m.hoursLeft != null) return [`Token ${m.hint} — nog ongeveer ${m.hoursLeft} uur geldig.`, 'ok'];
  return [`Token ${m.hint} aanwezig.`, 'ok'];
}

async function openTokenSheet() {
  let meta = { present: false };
  try { meta = await api('/api/token'); } catch { /* show the form anyway */ }

  const [line, tone] = tokenStatusLine(meta);
  const body = el('div');

  body.append(el('p', { className: `token-state ${tone}`, textContent: line }));
  body.append(el('p', {
    className: 'muted small',
    textContent: `Een personal access token van SmartThings vervalt ${meta.lifetimeHours ?? 24} uur na het aanmaken. `
      + 'Maak een nieuw token aan, plak het hieronder en de app gaat meteen weer verder — geen herstart nodig.',
  }));

  const open = el('a', {
    className: 'btn secondary block-link',
    href: meta.createUrl ?? CREATE_TOKEN_URL,
    target: '_blank', rel: 'noopener noreferrer',
    textContent: 'Nieuw token aanmaken ↗',
  });
  body.append(open);

  body.append(el('p', {
    className: 'muted small',
    textContent: 'Vink aan: Devices (list, read, execute) en Locations (read).',
  }));

  const input = el('input', {
    type: 'password', className: 'token-input', placeholder: 'Plak het token hier',
    autocomplete: 'off', spellcheck: false,
  });
  body.append(input);

  const feedback = el('p', { className: 'muted small' });
  body.append(feedback);

  const save = btn('Opslaan', '', async () => {
    const value = input.value.trim();
    if (!value) { feedback.textContent = 'Niets geplakt.'; feedback.className = 'token-state bad'; return; }
    feedback.className = 'muted small';
    feedback.textContent = 'Controleren bij SmartThings…';
    save.disabled = true;
    try {
      const r = await api('/api/token', { method: 'PUT', body: { token: value } });
      closeSheet();
      toast(r.warning ?? `Token opgeslagen — ${r.devices} apparaat(en) gevonden.`);
      endsAt = null;              // re-anchor the clock from the first fresh poll
      refreshStatus();
    } catch (err) {
      feedback.className = 'token-state bad';
      feedback.textContent = err.message;
      save.disabled = false;
    }
  });

  openSheet('Token', body, [btn('Sluiten', 'secondary', closeSheet), save], '🔑');
  setTimeout(() => input.focus(), 50);
}

/** Does this failure look like a credentials problem rather than a blip? */
const looksLikeAuth = (msg) => /401|403|verlopen|ongeldig|SMARTTHINGS_TOKEN/i.test(msg ?? '');

/* ---------------- monitor mode ---------------- */

let monitor = false;
let idleTimer = null;

function toggleMonitor(force) {
  monitor = force ?? !monitor;
  document.body.classList.toggle('monitor', monitor);
  try { localStorage.setItem('wasbeer-monitor', monitor ? '1' : '0'); } catch { /* */ }

  if (monitor) {
    document.documentElement.requestFullscreen?.().catch(() => { /* needs a gesture; fine without */ });
    armIdle();
    if (force === undefined) toast('Dubbeltik, Esc of ✕ om te sluiten');
  } else {
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    clearTimeout(idleTimer);
    document.body.classList.remove('dim');
  }
}

/** In monitor mode, fade the furniture after a minute of no pointer movement. */
function armIdle() {
  clearTimeout(idleTimer);
  document.body.classList.remove('dim');
  if (!monitor) return;
  idleTimer = setTimeout(() => document.body.classList.add('dim'), 60000);
}
// pointerdown too: a tablet produces no pointermove, so a tap must wake it
addEventListener('pointermove', () => { if (monitor) armIdle(); }, { passive: true });
addEventListener('pointerdown', () => { if (monitor) armIdle(); }, { passive: true });

/**
 * Double-tap anywhere to leave monitor mode. `dblclick` is unreliable on touch,
 * so this measures it by hand: two taps within 400ms and 40px of each other.
 * Taps on anything interactive are ignored, so Pauzeren still just pauses.
 */
let lastTapAt = 0, lastTapX = 0, lastTapY = 0;
addEventListener('pointerup', (e) => {
  if (!monitor) return;
  if (e.target.closest?.('button, input, select, a, label, .debug')) return;

  const now = Date.now();
  const near = Math.hypot(e.clientX - lastTapX, e.clientY - lastTapY) < 40;
  if (now - lastTapAt < 400 && near) {
    lastTapAt = 0;
    toggleMonitor(false);
    return;
  }
  lastTapAt = now; lastTapX = e.clientX; lastTapY = e.clientY;
});

// Leaving fullscreen by the browser's own route (Esc, F11, a system gesture)
// should drop monitor mode too, rather than stranding a chrome-less page.
document.addEventListener('fullscreenchange', () => {
  if (monitor && !document.fullscreenElement) toggleMonitor(false);
});

/** Cards gain a scrim as the bubbles pile up, so zeepfeest stays readable. */
function applyScrim(density) {
  document.documentElement.style.setProperty('--scrim', String(Math.min(0.5, 0.045 * density)));
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
  const SCHEDULE = [
    { phaseName: 'wash', timeInMin: 100 },
    { phaseName: 'rinse', timeInMin: 29 },
    { phaseName: 'spin', timeInMin: 15 },
  ];
  const total = SCHEDULE.reduce((n, p) => n + p.timeInMin, 0);

  // The slider means "through THIS phase", which is what you want when you are
  // checking how the rinse clears. Convert it to the overall progress the
  // renderer expects.
  let overall = fake.progress;
  const idx = SCHEDULE.findIndex((p) => p.phaseName === fake.phase);
  if (idx >= 0) {
    const before = SCHEDULE.slice(0, idx).reduce((n, p) => n + p.timeInMin, 0);
    overall = ((before + SCHEDULE[idx].timeInMin * (fake.progress / 100)) / total) * 100;
  }

  // The clock only re-anchors when a reading disagrees by more than 90s, which
  // is right for real polls and wrong for the slider -- drop the anchor so a
  // simulated jump takes effect immediately.
  endsAt = null;

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
    progress: overall,
    remainingTime: Math.round(total * (1 - overall / 100)),
    operationTime: total,
    waterTemperature: fake.temp,
    spinLevel: '1200',
    rinseCycle: '3',
    dryingLevel: fake.phase === 'dry' ? 'cupboard' : 'none',
    bubbleSoak: 'off',
    phases: SCHEDULE,
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
      applyScrim(density);
      try { localStorage.setItem('wasbeer-density', String(density)); } catch { /* */ }
    },
  });
  bubbleVal.textContent = `${density}× — ${moodFor(density)}`;
  applyScrim(density);
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
    b.replaceChildren(el('span', { textContent: err.message }));
    // a dead token is fixable from here, so offer the way in rather than
    // leaving an error message with nothing to do about it
    if (looksLikeAuth(err.message)) {
      b.append(el('button', {
        className: 'btn secondary banner-action', textContent: 'Token vernieuwen',
        onclick: openTokenSheet,
      }));
    }
  }
  renderStatus();
  // Poll quickly while something is happening, slowly when idle.
  clearTimeout(timer);
  timer = setTimeout(refreshStatus, STATUS?.running ? 20000 : 60000);
}

(async function init() {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) document.body.classList.add('reduce');

  ambient = createAmbient($('#ambient'));
  ambient.attachPorthole($('#porthole'));
  ticker = setInterval(paintClock, 1000);

  let saved = 'water';
  try { saved = localStorage.getItem('wasbeer-theme') ?? 'water'; } catch { /* private mode */ }
  applyTheme(saved);

  $('#sheet').addEventListener('click', (e) => { if (e.target.dataset.close !== undefined) closeSheet(); });
  $('#add').onclick = () => openEditor(null);
  $('#refresh').onclick = refreshStatus;
  $('#theme-btn').onclick = openThemeSheet;
  $('#monitor-btn').onclick = () => toggleMonitor();
  $('#monitor-close').onclick = () => toggleMonitor(false);
  $('#token-btn').onclick = openTokenSheet;

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { if (!$('#sheet').hidden) closeSheet(); else if (monitor) toggleMonitor(false); }
    if (e.key === 'm' && !/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) toggleMonitor();
  });

  try { if (localStorage.getItem('wasbeer-monitor') === '1') toggleMonitor(true); } catch { /* */ }

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
