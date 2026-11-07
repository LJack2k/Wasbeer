/**
 * Full-page ambient background: what the machine is doing, as weather.
 *
 * Canvas 2D, but not naively. The techniques that buy the quality:
 *
 *   - bubbles are pre-rendered once per size bucket into sprite canvases and
 *     blitted, so 200 of them cost 200 drawImage calls instead of 200 gradient
 *     constructions per frame
 *   - caustics are computed per-pixel at 160x90 and upscaled, which is the only
 *     way per-pixel maths is affordable at 60fps
 *   - agitation comes from a cheap analytic flow field, so bubbles travel
 *     through eddies rather than rising in straight lines
 *   - heat shimmer and water refraction are row-slice self-blits
 *
 * Motion policy: the no-vortex rule applies to the SPIN phase specifically --
 * nothing rotates under the reader's gaze; speed is expressed as horizontal
 * streaks in the periphery. Everything else is allowed to be lively.
 * prefers-reduced-motion still renders one static frame and stops.
 */

const TAU = Math.PI * 2;
const rand = (a, b) => a + Math.random() * (b - a);
const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

const THEMES = {
  water: {
    sky: ['#071118', '#0a1b26', '#06131b'],
    tint: { cold: '#2f7fc4', warm: '#2aa79a', hot: '#c2673f' },
    bubble: [205, 240, 255],
    water: [34, 118, 162],
    foam: [236, 250, 255],
    caustic: [120, 215, 255],
    lint: [220, 232, 240],
  },
  console: {
    sky: ['#04070a', '#070d13', '#03060a'],
    tint: { cold: '#1f6f96', warm: '#1d8f86', hot: '#9c5a2a' },
    bubble: [150, 245, 240],
    water: [22, 98, 116],
    foam: [200, 250, 250],
    caustic: [70, 220, 235],
    lint: [160, 220, 225],
    grid: 'rgba(90, 210, 230, 0.05)',
    gridStep: 48,
  },
  toy: {
    sky: ['#180f2e', '#271651', '#140b26'],
    tint: { cold: '#5b6fe0', warm: '#d85fbb', hot: '#e8743f' },
    bubble: [255, 225, 255],
    water: [122, 62, 184],
    foam: [255, 240, 255],
    caustic: [255, 150, 230],
    lint: [255, 225, 250],
    bubbleScale: 1.7,
  },
  division: {
    sky: ['#0b0b09', '#13120f', '#070706'],
    tint: { cold: '#2b6f85', warm: '#b06a1c', hot: '#d64a22' },
    bubble: [255, 200, 140],
    water: [116, 74, 30],
    foam: [255, 226, 190],
    caustic: [255, 170, 70],
    lint: [255, 196, 130],
    grid: 'rgba(255, 150, 60, 0.055)',
    gridStep: 56,
    scan: true,
  },
};

function tempKey(t) {
  if (t == null || t === 'none') return 'warm';
  if (t === 'cold' || Number(t) <= 25) return 'cold';
  if (Number(t) <= 45) return 'warm';
  return 'hot';
}

/**
 * Every phase as a set of dials. Nothing switches on or off abruptly -- the
 * renderer eases toward these, so transitions glide.
 */
function phaseShape(s) {
  const base = {
    energy: 0.1, level: 0.12, lift: 1, turbulence: 0.05, slosh: 0,
    foam: 0, streaks: 0, shimmer: 0, lint: 0, fill: 0, condensation: 0.12,
    label: 'idle',
  };
  if (!s) return { ...base, condensation: 0, label: 'offline' };
  if (!s.running) {
    if (s.operatingState === 'paused') {
      return { ...base, energy: 0.06, level: 0.6, turbulence: 0.02, foam: 0.25, condensation: 0.7, label: 'paused' };
    }
    return base;
  }

  const soak = s.bubbleSoak === 'on';
  switch (s.jobPhase ?? s.jobState) {
    case 'weightSensing':
      return { ...base, energy: 0.5, level: 0.3, turbulence: 0.55, slosh: 0.2,
        foam: 0.25, fill: 1, condensation: 0.45, label: 'filling' };
    case 'wash':
      return { ...base, energy: 0.95, level: 0.78, turbulence: 1, slosh: 1,
        foam: soak ? 1 : 0.75, condensation: 0.95, label: 'wash' };
    case 'rinse':
      return { ...base, energy: 0.65, level: 0.7, turbulence: 0.6, slosh: 0.7,
        foam: 0.22, condensation: 0.85, label: 'rinse' };
    case 'spin':
      return { ...base, energy: 1, level: 0.07, lift: -1, turbulence: 0.35, slosh: 0.12,
        streaks: 1, foam: 0.1, condensation: 0.6, label: 'spin' };
    case 'dry':
      return { ...base, energy: 0.55, level: 0, turbulence: 0.35,
        shimmer: 1, lint: 1, condensation: 0.05, label: 'dry' };
    default:
      return { ...base, energy: 0.7, level: 0.6, turbulence: 0.7, slosh: 0.8,
        foam: 0.4, condensation: 0.8, label: 'run' };
  }
}

/** Analytic flow field. Cheap, seamless, and good enough to read as turbulence. */
function flowAt(x, y, t) {
  const a = Math.sin(x * 0.0075 + t * 0.55) + Math.sin(y * 0.0105 - t * 0.4);
  const b = Math.cos(x * 0.0125 - t * 0.47) + Math.cos(y * 0.0085 + t * 0.6);
  return { fx: a, fy: b * 0.55 };
}

/* ---------------- bubble sprites ---------------- */

const SPRITE_BUCKETS = 9;

/**
 * One sprite per size bucket, matching the reference photography: a faint body,
 * a bright rim where light wraps the bubble wall, and a specular highlight.
 */
function makeBubbleSprites([r, g, b]) {
  const sprites = [];
  for (let i = 0; i < SPRITE_BUCKETS; i++) {
    const radius = 3 + i * 4.2;                 // 3 .. 36px
    const pad = Math.ceil(radius * 1.35);
    const size = pad * 2;
    const c = document.createElement('canvas');
    c.width = size; c.height = size;
    const x = pad, y = pad;
    const k = c.getContext('2d');

    // body: thin shell, darker core, so it reads as hollow
    const body = k.createRadialGradient(x, y, radius * 0.1, x, y, radius);
    body.addColorStop(0, `rgba(${r},${g},${b},0.04)`);
    body.addColorStop(0.62, `rgba(${r},${g},${b},0.07)`);
    body.addColorStop(0.88, `rgba(${r},${g},${b},0.26)`);
    body.addColorStop(1, `rgba(${r},${g},${b},0)`);
    k.fillStyle = body;
    k.beginPath(); k.arc(x, y, radius, 0, TAU); k.fill();

    // rim: brightest at the lower right, where light refracts through
    const rim = k.createLinearGradient(x - radius, y - radius, x + radius, y + radius);
    rim.addColorStop(0, `rgba(255,255,255,0.15)`);
    rim.addColorStop(0.55, `rgba(${r},${g},${b},0.5)`);
    rim.addColorStop(1, `rgba(255,255,255,0.85)`);
    k.strokeStyle = rim;
    k.lineWidth = Math.max(0.7, radius * 0.13);
    k.beginPath(); k.arc(x, y, radius * 0.93, 0, TAU); k.stroke();

    // specular highlight, upper left
    if (radius > 4) {
      const hr = radius * 0.3;
      const hx = x - radius * 0.34, hy = y - radius * 0.38;
      const hi = k.createRadialGradient(hx, hy, 0, hx, hy, hr);
      hi.addColorStop(0, 'rgba(255,255,255,0.9)');
      hi.addColorStop(1, 'rgba(255,255,255,0)');
      k.fillStyle = hi;
      k.beginPath(); k.arc(hx, hy, hr, 0, TAU); k.fill();
    }
    sprites.push({ canvas: c, radius, pad });
  }
  return sprites;
}

/* ---------------- engine ---------------- */

export function createAmbient(canvas) {
  const ctx = canvas.getContext('2d', { alpha: false });
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

  let W = 0, H = 0, dpr = 1;
  let theme = 'water';
  let status = null;
  let sprites = makeBubbleSprites(THEMES.water.bubble);

  // quality tier: 2 full, 1 reduced, 0 minimal. Dropped automatically if slow.
  let tier = 2;
  let frameCost = 16;
  // bubble multiplier. Above 1.25 the auto-degrade stands down: you asked for it.
  let density = 1;

  let target = phaseShape(null);
  const cur = { ...target };
  let tintTarget = tempKey(null), tintPrev = 'warm', tintMix = 1;

  // the small porthole in the status card, drawn from this same engine so the
  // two never disagree about what the machine is doing
  let port = null, portCtx = null, portDpr = 1;
  let drumAngle = 0;
  const laundry = [
    { r: 0.56, a: 0.0, w: 0.30, h: 0.19, c: '#d9604f', wob: 1.1 },
    { r: 0.48, a: 2.1, w: 0.26, h: 0.21, c: '#e8b84b', wob: 0.8 },
    { r: 0.58, a: 4.0, w: 0.31, h: 0.17, c: '#5aa6dc', wob: 1.4 },
    { r: 0.30, a: 5.3, w: 0.22, h: 0.16, c: '#79c99a', wob: 0.6 },
    { r: 0.38, a: 3.0, w: 0.20, h: 0.14, c: '#cfd6de', wob: 1.0 },
  ];

  // one-off events: a surge when filling, a drain at the top of the spin,
  // a bloom when it finishes. Smooth eases have no punctuation without these.
  let pulseKind = null, pulseT = 0;

  const bubbles = [];
  const foam = [];
  const drops = [];     // condensation on the glass
  const motes = [];     // lint, for the dry phase
  const streaks = [];

  // caustics: per-pixel at low resolution, upscaled on composite
  const CW = 160, CH = 90;
  const causticCanvas = document.createElement('canvas');
  causticCanvas.width = CW; causticCanvas.height = CH;
  const cctx = causticCanvas.getContext('2d');
  const causticImg = cctx.createImageData(CW, CH);

  // scratch buffer for row-slice refraction and shimmer
  const scratch = document.createElement('canvas');
  const sctx = scratch.getContext('2d');

  function resize() {
    dpr = Math.min(devicePixelRatio || 1, tier === 2 ? 2 : 1.5);
    W = canvas.clientWidth; H = canvas.clientHeight;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    scratch.width = canvas.width; scratch.height = canvas.height;
    sctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    seed();
  }

  function bubbleCount() {
    const area = (W * H) / 1000;
    const per = tier === 2 ? 0.34 : tier === 1 ? 0.18 : 0.08;
    const base = clamp(area * per, 30, tier === 2 ? 260 : 130);
    // 8000 is roughly where the sprite blitter finally costs a 60fps frame
    return Math.round(clamp(base * density, 8, 8000));
  }

  /**
   * Add or remove bubbles to match the requested count, rather than reseeding.
   * Dragging the slider across its range otherwise rebuilds the whole array on
   * every input event.
   */
  function resizeBubblePool() {
    const want = bubbleCount();
    while (bubbles.length > want) bubbles.pop();
    while (bubbles.length < want) bubbles.push(newBubble());

    const wantFoam = Math.round(clamp((tier === 2 ? 110 : 50) * Math.sqrt(density), 10, 900));
    while (foam.length > wantFoam) foam.pop();
    while (foam.length < wantFoam) {
      foam.push({ x: rand(0, W), r: rand(3, 14), off: rand(-7, 5), ph: rand(0, TAU), a: rand(0.3, 0.9) });
    }
  }

  function newBubble(y) {
    // Normally heavily biased toward small bubbles. Crank the density and the
    // distribution flattens, so it stops being fizz and becomes a wall of foam.
    const bias = density > 4 ? 1.15 : density > 2 ? 1.6 : 2.1;
    const bucket = Math.min(SPRITE_BUCKETS - 1, Math.floor(Math.pow(Math.random(), bias) * SPRITE_BUCKETS));
    const scale = (THEMES[theme].bubbleScale ?? 1) * (density > 6 ? 1.3 : 1);
    return {
      x: rand(0, W), y: y ?? rand(0, H),
      bucket,
      scale: scale * rand(0.75, 1.15),
      // bigger bubbles are more buoyant and wobble harder
      rise: 14 + bucket * 9 + rand(-5, 10),
      wob: rand(0.5, 1.6),
      ph: rand(0, TAU),
      a: rand(0.45, 1),
      vx: 0, vy: 0,
    };
  }

  function seed() {
    bubbles.length = 0;
    for (let i = 0, n = bubbleCount(); i < n; i++) bubbles.push(newBubble());

    foam.length = 0;
    for (let i = 0, n = tier === 2 ? 110 : 50; i < n; i++) {
      foam.push({ x: rand(0, W), r: rand(3, 14), off: rand(-7, 5), ph: rand(0, TAU), a: rand(0.3, 0.9) });
    }

    drops.length = 0;
    for (let i = 0, n = tier === 2 ? 70 : 28; i < n; i++) {
      drops.push({ x: rand(0, W), y: rand(0, H), r: rand(1.6, 7), a: rand(0.25, 0.8), run: 0, speed: 0 });
    }

    motes.length = 0;
    for (let i = 0, n = tier === 2 ? 70 : 32; i < n; i++) {
      motes.push({ x: rand(0, W), y: rand(0, H), r: rand(0.8, 3.2), rot: rand(0, TAU),
        spin: rand(-2, 2), rise: rand(8, 30), ph: rand(0, TAU), a: rand(0.2, 0.7) });
    }

    streaks.length = 0;
    for (let i = 0; i < 60; i++) {
      streaks.push({ x: rand(0, W), y: rand(0, H), len: rand(40, 220), sp: rand(600, 1900), a: rand(0.1, 0.5) });
    }
  }

  function setTier(next) {
    if (next === tier) return;
    tier = next;
    resize();
  }

  /* ----- layers ----- */

  function drawCaustics(time, waterTop, alpha) {
    const C = THEMES[theme].caustic;
    const d = causticImg.data;
    const t = time * 0.9;
    let i = 0;
    for (let y = 0; y < CH; y++) {
      for (let x = 0; x < CW; x++) {
        // three interfering wave trains; sharp positive peaks read as caustics
        const v = Math.sin(x * 0.17 + t)
          + Math.sin(y * 0.19 - t * 0.83)
          + Math.sin((x + y) * 0.12 + t * 0.62)
          + Math.sin((x - y) * 0.09 - t * 0.44);
        const p = Math.max(0, v - 1.1);
        const b = p * p * 62;
        d[i++] = C[0]; d[i++] = C[1]; d[i++] = C[2]; d[i++] = Math.min(255, b);
      }
    }
    cctx.putImageData(causticImg, 0, 0);

    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    ctx.globalAlpha = alpha;
    ctx.drawImage(causticCanvas, 0, waterTop - 20, W, H - waterTop + 40);
    ctx.restore();
  }

  function drawWaterBody(time, waterTop, slosh) {
    const [r, g, b] = THEMES[theme].water;
    const amp = 6 + 16 * cur.energy;

    ctx.beginPath();
    ctx.moveTo(-40, H + 40);
    ctx.lineTo(-40, waterTop);
    for (let x = -40; x <= W + 40; x += 12) {
      const xs = x + slosh;
      const y = waterTop
        + Math.sin(xs * 0.0075 + time * 1.1) * amp
        + Math.sin(xs * 0.019 - time * 0.8) * amp * 0.45
        + Math.sin(xs * 0.041 + time * 1.9) * amp * 0.18;
      ctx.lineTo(x, y);
    }
    ctx.lineTo(W + 40, H + 40);
    ctx.closePath();

    const grad = ctx.createLinearGradient(0, waterTop, 0, H);
    grad.addColorStop(0, `rgba(${r},${g},${b},0.42)`);
    grad.addColorStop(0.35, `rgba(${r},${g},${b},0.3)`);
    grad.addColorStop(1, `rgba(${r},${g},${b},0.14)`);
    ctx.fillStyle = grad;
    ctx.fill();

    // bright surface tension line
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    ctx.strokeStyle = `rgba(255,255,255,${0.1 + cur.energy * 0.14})`;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.restore();
  }

  function surfaceY(x, time, waterTop, slosh) {
    const amp = 6 + 16 * cur.energy;
    const xs = x + slosh;
    return waterTop
      + Math.sin(xs * 0.0075 + time * 1.1) * amp
      + Math.sin(xs * 0.019 - time * 0.8) * amp * 0.45
      + Math.sin(xs * 0.041 + time * 1.9) * amp * 0.18;
  }

  function drawBubbles(dt, time, waterTop, slosh) {
    const turb = cur.turbulence;
    ctx.save();
    for (const p of bubbles) {
      const { fx, fy } = turb > 0.02 ? flowAt(p.x, p.y, time) : { fx: 0, fy: 0 };

      // buoyancy, agitation, and a little inertia
      const buoy = p.rise * (0.25 + cur.energy * 1.25) * cur.lift;
      p.vx = lerp(p.vx, fx * 52 * turb + Math.sin(time * p.wob + p.ph) * 16 * turb, dt * 3);
      p.vy = lerp(p.vy, -buoy + fy * 40 * turb, dt * 3);
      p.x += p.vx * dt;
      p.y += p.vy * dt;

      if (p.x < -50) p.x = W + 50; else if (p.x > W + 50) p.x = -50;
      if (cur.lift > 0 && p.y < waterTop - 60) Object.assign(p, newBubble(H + rand(10, 90)));
      else if (cur.lift < 0 && p.y > H + 60) Object.assign(p, newBubble(-rand(10, 90)));

      // bubbles only exist in water: fade them out as they break the surface
      const sy = surfaceY(p.x, time, waterTop, slosh);
      const depth = cur.level < 0.04 ? 0 : clamp((p.y - sy) / 70, 0, 1);
      const a = p.a * depth * (0.3 + cur.energy * 0.8);
      if (a < 0.02) continue;

      const sp = sprites[p.bucket];
      const size = sp.pad * 2 * p.scale;
      ctx.globalAlpha = Math.min(1, a);
      ctx.drawImage(sp.canvas, p.x + slosh * 0.35 - size / 2, p.y - size / 2, size, size);
    }
    ctx.restore();
  }

  function drawFoam(time, waterTop, slosh) {
    if (cur.foam < 0.03) return;
    const [r, g, b] = THEMES[theme].foam;
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    for (const f of foam) {
      const x = f.x + slosh * 0.6;
      const y = surfaceY(x, time, waterTop, slosh) + f.off + Math.sin(time * 1.4 + f.ph) * 3;
      ctx.globalAlpha = f.a * cur.foam * 0.5;
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.beginPath();
      ctx.arc(x, y, f.r * (0.6 + cur.foam * 0.7), 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  }

  function drawFillJet(time, waterTop, slosh) {
    if (cur.fill < 0.05) return;
    const x = W * 0.62 + Math.sin(time * 0.6) * 12;
    const top = 0, bottom = surfaceY(x, time, waterTop, slosh);
    const g = ctx.createLinearGradient(x, top, x, bottom);
    g.addColorStop(0, `rgba(255,255,255,${0.02 * cur.fill})`);
    g.addColorStop(1, `rgba(255,255,255,${0.2 * cur.fill})`);
    ctx.fillStyle = g;
    const w = 9 + Math.sin(time * 9) * 2;
    ctx.fillRect(x - w / 2, top, w, bottom - top);

    // churn where it lands
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    for (let i = 0; i < 12; i++) {
      const a = (time * 3 + i) % 1;
      ctx.globalAlpha = (1 - a) * 0.3 * cur.fill;
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(x + Math.sin(i * 2.4 + time * 4) * 40 * a, bottom - a * 18, 2 + a * 9, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  }

  /** Spin: speed lives in the periphery. The centre, where you read, stays calm. */
  function drawStreaks(dt, time) {
    if (cur.streaks < 0.05) return;
    const margin = W * 0.26;
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    ctx.lineCap = 'round';
    for (const s of streaks) {
      s.x += s.sp * dt * cur.streaks * (s.y % 2 < 1 ? 1 : -1);
      if (s.x > W + 300) s.x = -300; else if (s.x < -300) s.x = W + 300;

      // fade to nothing toward the middle of the screen
      const edge = Math.min(s.x, W - s.x);
      const weight = 1 - clamp(edge / margin, 0, 1);
      if (weight < 0.03) continue;

      ctx.globalAlpha = s.a * weight * cur.streaks * 0.5;
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1 + weight * 1.6;
      ctx.beginPath();
      ctx.moveTo(s.x, s.y);
      ctx.lineTo(s.x - s.len * weight, s.y);
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawMotes(dt, time) {
    if (cur.lint < 0.05) return;
    const [r, g, b] = THEMES[theme].lint;
    ctx.save();
    for (const m of motes) {
      m.y -= m.rise * dt * (0.4 + cur.energy);
      m.x += Math.sin(time * 0.8 + m.ph) * 22 * dt;
      m.rot += m.spin * dt;
      if (m.y < -20) { m.y = H + rand(0, 60); m.x = rand(0, W); }
      ctx.globalAlpha = m.a * cur.lint * 0.55;
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.save();
      ctx.translate(m.x, m.y);
      ctx.rotate(m.rot);
      ctx.fillRect(-m.r, -m.r * 0.35, m.r * 2, m.r * 0.7);   // tumbling fibres, not dots
      ctx.restore();
    }
    ctx.restore();
  }

  /** Condensation on the inside of the door. Occasionally a drop lets go. */
  function drawDrops(dt, time) {
    if (cur.condensation < 0.04) return;
    ctx.save();
    for (const d of drops) {
      if (d.run > 0) {
        d.speed += 240 * dt;
        d.y += d.speed * dt;
        d.run -= dt;
        if (d.y > H + 20) { d.y = rand(-20, H * 0.4); d.run = 0; d.speed = 0; }
      } else if (Math.random() < 0.0012 * cur.condensation) {
        d.run = rand(0.8, 2.4);
      }
      ctx.globalAlpha = d.a * cur.condensation * 0.5;
      const grd = ctx.createRadialGradient(d.x - d.r * 0.3, d.y - d.r * 0.3, 0, d.x, d.y, d.r);
      grd.addColorStop(0, 'rgba(255,255,255,0.55)');
      grd.addColorStop(0.7, 'rgba(255,255,255,0.1)');
      grd.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = grd;
      ctx.beginPath(); ctx.arc(d.x, d.y, d.r, 0, TAU); ctx.fill();

      if (d.speed > 60) {   // a trail behind a running drop
        ctx.globalAlpha = d.a * cur.condensation * 0.14;
        ctx.fillRect(d.x - d.r * 0.4, d.y - 26, d.r * 0.8, 26);
      }
    }
    ctx.restore();
  }

  /** Row-slice self-blit: heat haze when drying, refraction through the water. */
  function distort(time, waterTop) {
    if (tier < 2) return;
    const heat = cur.shimmer, wet = cur.level > 0.1 ? cur.energy * 0.5 : 0;
    if (heat < 0.05 && wet < 0.05) return;

    sctx.clearRect(0, 0, W, H);
    sctx.drawImage(canvas, 0, 0, canvas.width, canvas.height, 0, 0, W, H);

    const step = 3;
    const from = heat > 0.05 ? H * 0.35 : waterTop;
    for (let y = from; y < H; y += step) {
      const k = heat > 0.05
        ? Math.sin(y * 0.045 + time * 3.1) * 5 * heat * ((y - from) / (H - from))
        : Math.sin(y * 0.03 + time * 1.4) * 3.4 * wet;
      if (Math.abs(k) < 0.4) continue;
      ctx.drawImage(scratch, 0, y * dpr, canvas.width, step * dpr, k, y, W, step);
    }
  }

  /* ----- the porthole ----- */

  function drawPorthole(dt, time, slosh) {
    if (!port) return;
    const S = port.clientWidth;
    if (!S) return;
    if (port.width !== Math.round(S * portDpr)) {
      portDpr = Math.min(devicePixelRatio || 1, 2);
      port.width = port.height = Math.round(S * portDpr);
      portCtx.setTransform(portDpr, 0, 0, portDpr, 0, 0);
    }
    const k = portCtx;
    const cx = S / 2, cy = S / 2;
    const rOuter = S * 0.46;        // progress ring
    const rGlass = S * 0.355;
    const T = THEMES[theme];

    k.clearRect(0, 0, S, S);

    // the drum turns with the tumble, and reverses with it
    const spinning = cur.streaks > 0.3;
    const dir = Math.tanh(Math.sin(time * 0.78) * 2.2);
    drumAngle += dt * (spinning ? 11 : dir * 1.9 * cur.energy);

    // --- progress ring ---
    const pct = clamp((status?.progress ?? 0) / 100, 0, 1) * (status?.running ? 1 : 0);
    k.lineWidth = S * 0.035;
    k.lineCap = 'round';
    k.strokeStyle = 'rgba(255,255,255,0.09)';
    k.beginPath(); k.arc(cx, cy, rOuter, 0, TAU); k.stroke();
    if (pct > 0.002) {
      k.strokeStyle = T.tint[tintTarget];
      k.shadowColor = T.tint[tintTarget];
      k.shadowBlur = S * 0.06;
      k.beginPath();
      k.arc(cx, cy, rOuter, -Math.PI / 2, -Math.PI / 2 + TAU * pct);
      k.stroke();
      k.shadowBlur = 0;
    }

    // --- inside the glass ---
    k.save();
    k.beginPath(); k.arc(cx, cy, rGlass, 0, TAU); k.clip();

    k.fillStyle = 'rgba(0,0,0,0.55)';
    k.fillRect(0, 0, S, S);

    // perforated drum wall, rotating
    k.save();
    k.translate(cx, cy); k.rotate(drumAngle);
    for (const [rr, n] of [[0.86, 18], [0.63, 13], [0.4, 8]]) {
      for (let i = 0; i < n; i++) {
        const a = (i / n) * TAU;
        const hx = Math.cos(a) * rGlass * rr, hy = Math.sin(a) * rGlass * rr;
        k.fillStyle = 'rgba(0,0,0,0.5)';
        k.beginPath(); k.arc(hx, hy, S * 0.014, 0, TAU); k.fill();
        k.fillStyle = 'rgba(255,255,255,0.1)';
        k.beginPath(); k.arc(hx, hy + S * 0.006, S * 0.011, 0, Math.PI); k.fill();
      }
    }
    // tumbling laundry
    for (const L of laundry) {
      const wob = Math.sin(time * L.wob + L.a) * 0.1;
      const a = L.a + wob;
      const lx = Math.cos(a) * rGlass * L.r, ly = Math.sin(a) * rGlass * L.r;
      k.save();
      k.translate(lx, ly);
      k.rotate(a + Math.PI / 2 + wob * 2);
      const w = rGlass * L.w, h = rGlass * L.h;
      const g = k.createLinearGradient(0, -h, 0, h);
      g.addColorStop(0, L.c);
      g.addColorStop(1, 'rgba(0,0,0,0.55)');
      k.fillStyle = g;
      k.globalAlpha = 0.93;
      k.beginPath();
      k.roundRect(-w, -h, w * 2, h * 2, h * 0.8);
      k.fill();
      k.restore();
    }
    k.restore();

    // water inside the drum, sloshing with the page
    if (cur.level > 0.04) {
      const top = cy + rGlass - (rGlass * 2) * clamp(cur.level, 0, 1);
      const amp = rGlass * 0.07 * (0.4 + cur.energy);
      k.beginPath();
      k.moveTo(cx - rGlass * 1.2, S);
      k.lineTo(cx - rGlass * 1.2, top);
      for (let x = -1.2; x <= 1.2; x += 0.12) {
        const px = cx + rGlass * x;
        k.lineTo(px, top + Math.sin(x * 7 + time * 2.4 + slosh * 0.05) * amp);
      }
      k.lineTo(cx + rGlass * 1.2, S);
      k.closePath();
      const [wr, wg, wb] = T.water;
      const wgrad = k.createLinearGradient(0, top, 0, S);
      wgrad.addColorStop(0, `rgba(${wr},${wg},${wb},0.62)`);
      wgrad.addColorStop(1, `rgba(${wr},${wg},${wb},0.34)`);
      k.fillStyle = wgrad;
      k.fill();
      k.globalCompositeOperation = 'screen';
      k.strokeStyle = 'rgba(255,255,255,0.18)';
      k.lineWidth = 1.2; k.stroke();
      k.globalCompositeOperation = 'source-over';

      // the same bubble sprites, small
      const n = Math.round(12 + cur.energy * 26);
      for (let i = 0; i < n; i++) {
        const sp = sprites[(i * 3) % 5];
        const bx = cx + Math.sin(i * 2.7 + time * 0.6) * rGlass * 0.85;
        const by = S - ((time * (30 + i * 9) + i * 70) % (S - top)) ;
        if (by < top) continue;
        const size = sp.pad * 2 * 0.42;
        k.globalAlpha = 0.5;
        k.drawImage(sp.canvas, bx - size / 2, by - size / 2, size, size);
      }
      k.globalAlpha = 1;
    }

    // glass highlight
    const shine = k.createLinearGradient(cx - rGlass, cy - rGlass, cx + rGlass * 0.3, cy + rGlass);
    shine.addColorStop(0, 'rgba(255,255,255,0.26)');
    shine.addColorStop(0.5, 'rgba(255,255,255,0.02)');
    shine.addColorStop(1, 'rgba(255,255,255,0)');
    k.fillStyle = shine;
    k.fillRect(0, 0, S, S);
    k.restore();

    // rim and hinge
    k.lineWidth = S * 0.028;
    k.strokeStyle = 'rgba(255,255,255,0.14)';
    k.beginPath(); k.arc(cx, cy, rGlass, 0, TAU); k.stroke();
    k.fillStyle = 'rgba(255,255,255,0.14)';
    k.beginPath(); k.arc(cx - rOuter * 0.98, cy, S * 0.018, 0, TAU); k.fill();
  }

  /* ----- frame ----- */

  function draw(dt, time) {
    const T = THEMES[theme];

    // Frame-rate independent easing. `dt * rate` as a lerp factor converges at a
    // speed that depends on the frame rate, which left the water half-drained
    // seconds into the dry phase on a throttled tab. 1 - e^(-dt*rate) does not.
    const k = 1 - Math.exp(-dt * 1.9);
    for (const key of ['energy', 'level', 'lift', 'turbulence', 'slosh', 'foam',
      'streaks', 'shimmer', 'lint', 'fill', 'condensation']) {
      const v = lerp(cur[key], target[key], k);
      // settle fully instead of asymptotically hovering above a threshold
      cur[key] = Math.abs(v - target[key]) < 0.004 ? target[key] : v;
    }
    tintMix = Math.min(1, tintMix + dt * 0.5);

    // the signature washer motion: tumble one way, reverse, repeat.
    // tanh flattens the sine into a hold-reverse-hold, like a real drum.
    const slosh = Math.tanh(Math.sin(time * 0.78) * 2.2) * 46 * cur.slosh;

    const waterTop = H * (1 - cur.level);

    // sky
    const sky = ctx.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, T.sky[1]);
    sky.addColorStop(0.55, T.sky[0]);
    sky.addColorStop(1, T.sky[2]);
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, W, H);

    // temperature glow
    const glowY = waterTop + 60;
    for (const [colour, alpha] of [[T.tint[tintPrev], (1 - tintMix) * 0.5], [T.tint[tintTarget], tintMix * 0.5]]) {
      if (alpha < 0.01) continue;
      const g = ctx.createRadialGradient(W / 2, glowY, 0, W / 2, glowY, Math.max(W, H) * 0.8);
      g.addColorStop(0, colour);
      g.addColorStop(1, 'transparent');
      ctx.globalAlpha = alpha * (0.3 + cur.energy * 0.38);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
    }
    ctx.globalAlpha = 1;

    // drying: a warm updraft from the heater, so the phase has its own look
    // instead of just being "water missing"
    if (cur.shimmer > 0.04) {
      const heat = ctx.createLinearGradient(0, H, 0, H * 0.25);
      heat.addColorStop(0, `rgba(255, 168, 86, ${0.3 * cur.shimmer})`);
      heat.addColorStop(0.4, `rgba(255, 140, 70, ${0.12 * cur.shimmer})`);
      heat.addColorStop(1, 'rgba(255,120,60,0)');
      ctx.fillStyle = heat;
      ctx.fillRect(0, 0, W, H);

      // slow convection columns
      ctx.save();
      ctx.globalCompositeOperation = 'screen';
      for (let i = 0; i < 5; i++) {
        const x = (W / 5) * (i + 0.5) + Math.sin(time * 0.33 + i * 1.7) * 90;
        const g = ctx.createRadialGradient(x, H * 0.95, 0, x, H * 0.95, H * 0.7);
        g.addColorStop(0, `rgba(255,170,90,${0.07 * cur.shimmer})`);
        g.addColorStop(1, 'rgba(255,170,90,0)');
        ctx.fillStyle = g;
        ctx.fillRect(x - H * 0.7, 0, H * 1.4, H);
      }
      ctx.restore();
    }

    if (T.grid) {
      const step = T.gridStep ?? 48;
      ctx.strokeStyle = T.grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = 0; x < W; x += step) { ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, H); }
      for (let y = 0; y < H; y += step) { ctx.moveTo(0, y + 0.5); ctx.lineTo(W, y + 0.5); }
      ctx.stroke();
    }

    // light shafts from above the waterline
    if (tier === 2 && cur.level > 0.15) {
      ctx.save();
      ctx.globalCompositeOperation = 'screen';
      for (let i = 0; i < 4; i++) {
        const x = (W / 4) * i + Math.sin(time * 0.17 + i) * 70 + slosh * 0.5;
        const g = ctx.createLinearGradient(x, waterTop, x + 60, H);
        g.addColorStop(0, `rgba(255,255,255,${0.05 + cur.energy * 0.04})`);
        g.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.moveTo(x - 34, waterTop); ctx.lineTo(x + 34, waterTop);
        ctx.lineTo(x + 150, H); ctx.lineTo(x - 70, H);
        ctx.closePath(); ctx.fill();
      }
      ctx.restore();
    }

    if (cur.level > 0.04) {
      drawWaterBody(time, waterTop, slosh);
      if (tier === 2) drawCaustics(time, waterTop, 0.1 + cur.energy * 0.22);
    }

    drawFillJet(time, waterTop, slosh);
    drawBubbles(dt, time, waterTop, slosh);
    drawFoam(time, waterTop, slosh);
    drawStreaks(dt, time);
    drawMotes(dt, time);

    distort(time, waterTop);

    drawDrops(dt, time);

    if (T.scan) {
      ctx.fillStyle = 'rgba(0, 0, 0, 0.22)';
      for (let y = 0; y < H; y += 3) ctx.fillRect(0, y, W, 1);
      const sweepH = 180;
      const sy = ((time % 16) / 16) * (H + sweepH) - sweepH;
      const g = ctx.createLinearGradient(0, sy, 0, sy + sweepH);
      g.addColorStop(0, 'rgba(255, 160, 60, 0)');
      g.addColorStop(0.5, `rgba(255, 170, 70, ${(0.035 + cur.energy * 0.03).toFixed(3)})`);
      g.addColorStop(1, 'rgba(255, 160, 60, 0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, sy, W, sweepH);
    }

    // vignette keeps the UI legible over all of the above
    const v = ctx.createRadialGradient(W / 2, H * 0.4, Math.min(W, H) * 0.3, W / 2, H * 0.5, Math.max(W, H) * 0.85);
    v.addColorStop(0, 'transparent');
    v.addColorStop(1, 'rgba(0,0,0,0.42)');
    ctx.fillStyle = v;
    ctx.fillRect(0, 0, W, H);

    // --- transition moments ---
    if (pulseT > 0) {
      const dur = { fill: 1.6, drain: 1.4, done: 2.4 }[pulseKind] ?? 1.5;
      pulseT = Math.max(0, pulseT - dt / dur);
      const p = pulseT;            // 1 -> 0
      ctx.save();
      ctx.globalCompositeOperation = 'screen';

      if (pulseKind === 'fill') {
        // a surge of water climbing the screen
        const y = H - (1 - p) * H * 0.9;
        const g = ctx.createLinearGradient(0, y, 0, y + 220);
        g.addColorStop(0, `rgba(190,235,255,0)`);
        g.addColorStop(0.4, `rgba(190,235,255,${0.3 * p})`);
        g.addColorStop(1, `rgba(190,235,255,0)`);
        ctx.fillStyle = g;
        ctx.fillRect(0, y, W, 220);
      } else if (pulseKind === 'drain') {
        // the water leaving, as a band falling away
        const y = (1 - p) * H * 1.2 - 150;
        const g = ctx.createLinearGradient(0, y, 0, y + 190);
        g.addColorStop(0, 'rgba(255,255,255,0)');
        g.addColorStop(0.5, `rgba(210,240,255,${0.26 * p})`);
        g.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = g;
        ctx.fillRect(0, y, W, 190);
      } else if (pulseKind === 'done') {
        const r = (1 - p) * Math.max(W, H) * 0.9;
        const g = ctx.createRadialGradient(W / 2, H * 0.42, r * 0.55, W / 2, H * 0.42, r);
        g.addColorStop(0, 'rgba(255,255,255,0)');
        g.addColorStop(0.75, `rgba(200,255,235,${0.3 * p})`);
        g.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, W, H);
      }
      ctx.restore();
      if (pulseT === 0) pulseKind = null;
    }

    drawPorthole(dt, time, slosh);
  }

  /* ----- loop ----- */

  let raf = null, last = 0, slowFrames = 0;

  function frame(ms) {
    raf = requestAnimationFrame(frame);
    const now = ms / 1000;
    const dt = clamp(now - last || 0.016, 0.001, 0.05);
    last = now;

    const t0 = performance.now();
    draw(dt, now);
    frameCost = lerp(frameCost, performance.now() - t0, 0.08);

    // If we cannot hold ~60fps, shed detail rather than stutter all day -- but
    // not when the bubble slider has been cranked. That cost was requested.
    if (density <= 1.25 && frameCost > 13 && tier > 0) {
      if (++slowFrames > 90) { setTier(tier - 1); slowFrames = 0; }
    } else slowFrames = Math.max(0, slowFrames - 1);
  }

  const start = () => { if (!raf && !reduce) { last = performance.now() / 1000; raf = requestAnimationFrame(frame); } };
  const stop = () => { if (raf) cancelAnimationFrame(raf); raf = null; };

  const onVisibility = () => (document.hidden ? stop() : start());
  document.addEventListener('visibilitychange', onVisibility);
  addEventListener('resize', resize);

  resize();
  if (reduce) draw(0.016, 0); else start();

  const api = {
    setStatus(s) {
      status = s;
      target = phaseShape(s);
      const key = tempKey(s?.waterTemperature);
      if (key !== tintTarget) { tintPrev = tintTarget; tintTarget = key; tintMix = 0; }
      if (reduce) draw(0.016, 0);
    },
    setTheme(name) {
      if (!THEMES[name]) return;
      theme = name;
      sprites = makeBubbleSprites(THEMES[name].bubble);
      seed();
      if (reduce) draw(0.016, 0);
    },
    setQuality(t) { setTier(clamp(t, 0, 2)); },
    /** Draw the status-card porthole from this same engine, in the same frame. */
    attachPorthole(c) {
      port = c;
      portCtx = c?.getContext('2d') ?? null;
    },
    /** 'fill' | 'drain' | 'done' -- a one-off moment, not a state change. */
    pulse(kind) { pulseKind = kind; pulseT = 1; },
    /** Bubble multiplier, 0.25x .. 12x. Past ~4x this is a joke setting. */
    setDensity(d) {
      density = clamp(Number(d) || 1, 0.25, 30);
      resizeBubblePool();
    },
    /** Render n frames synchronously and report the cost. Works with the tab
     *  hidden, where requestAnimationFrame does not run at all. */
    benchmark(n = 30) {
      const t0 = performance.now();
      for (let i = 0; i < n; i++) draw(1 / 60, i / 60);
      const ms = (performance.now() - t0) / n;
      return { ms: Math.round(ms * 100) / 100, fps: Math.round(1000 / ms), bubbles: bubbles.length, density };
    },
    /** Jump straight to the target state instead of easing -- the debug bar
     *  wants the phase it just selected, not a three-second fade into it. */
    snap() {
      for (const key of Object.keys(cur)) if (typeof target[key] === 'number') cur[key] = target[key];
      tintMix = 1; tintPrev = tintTarget;
      if (reduce) draw(0.016, 0);
    },
    stats: () => ({
      tier, frameCost: Math.round(frameCost * 10) / 10, bubbles: bubbles.length,
      phase: phaseShape(status).label,
      level: Math.round(cur.level * 100) / 100,
      density,
      fps: Math.round(1000 / Math.max(frameCost, 1)),
      targetLevel: target.level,
    }),
    destroy() {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
      removeEventListener('resize', resize);
    },
  };

  if (['localhost', '127.0.0.1'].includes(location.hostname)) window.__ambient = api;
  return api;
}

export const THEME_NAMES = Object.keys(THEMES);
