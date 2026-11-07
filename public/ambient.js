/**
 * Full-page ambient background. One canvas behind everything, driven by what the
 * machine is actually doing.
 *
 * Motion rules, deliberately conservative -- this thing may sit on a second
 * monitor all day:
 *   - nothing rotates, nothing parallaxes, nothing moves faster than ~40px/s
 *   - the spin phase gets MORE of the same motion, not different motion
 *   - capped at 30fps, and fully paused when the tab is hidden
 *   - prefers-reduced-motion renders one static frame and stops
 */

const TAU = Math.PI * 2;
const rand = (a, b) => a + Math.random() * (b - a);
const lerp = (a, b, t) => a + (b - a) * t;

/** Per-theme palettes. Hue drifts with wash temperature inside each theme. */
const THEMES = {
  water: {
    sky: ['#071118', '#0a1b26', '#06131b'],
    tint: { cold: '#2f7fc4', warm: '#2aa79a', hot: '#c2673f' },
    particle: 'rgba(190, 235, 255, ALPHA)',
    caustic: 'rgba(120, 220, 255, ALPHA)',
    waterFill: 'rgba(38, 125, 170, 0.34)',
    causticCount: 5,
  },
  console: {
    sky: ['#04070a', '#070d13', '#03060a'],
    tint: { cold: '#1f6f96', warm: '#1d8f86', hot: '#9c5a2a' },
    particle: 'rgba(120, 240, 230, ALPHA)',
    caustic: 'rgba(60, 200, 220, ALPHA)',
    waterFill: 'rgba(24, 104, 126, 0.26)',
    grid: 'rgba(90, 210, 230, 0.05)',
    causticCount: 2,
  },
  toy: {
    sky: ['#180f2e', '#271651', '#140b26'],
    tint: { cold: '#5b6fe0', warm: '#d85fbb', hot: '#e8743f' },
    particle: 'rgba(255, 225, 255, ALPHA)',
    caustic: 'rgba(255, 140, 220, ALPHA)',
    waterFill: 'rgba(138, 70, 205, 0.36)',
    causticCount: 4,
  },
  // Tactical HUD: warm-black plate, amber instrumentation, drifting dust,
  // and a projected-display scan. Dust rather than bubbles.
  division: {
    sky: ['#0b0b09', '#13120f', '#070706'],
    tint: { cold: '#2b6f85', warm: '#b06a1c', hot: '#d64a22' },
    particle: 'rgba(255, 186, 110, ALPHA)',
    caustic: 'rgba(255, 146, 44, ALPHA)',
    waterFill: 'rgba(120, 76, 28, 0.2)',
    grid: 'rgba(255, 150, 60, 0.055)',
    gridStep: 56,
    causticCount: 3,
    scan: true,
  },
};

/** Temperature -> which tint of the theme to lean on. */
function tempKey(t) {
  if (t == null || t === 'none') return 'warm';
  if (t === 'cold' || Number(t) <= 25) return 'cold';
  if (Number(t) <= 45) return 'warm';
  return 'hot';
}

/**
 * Phase -> how the field behaves.
 *   energy  how much is moving (0..1)
 *   level   how full of water the screen is (0..1)
 *   lift    particle direction: +1 rising, -1 draining
 */
function phaseShape(s) {
  if (!s) return { energy: 0.12, level: 0.1, lift: 1, label: 'offline' };
  if (!s.running) {
    const done = s.operatingState === 'paused';
    return { energy: done ? 0.1 : 0.18, level: 0.12, lift: 1, label: done ? 'paused' : 'idle' };
  }
  switch (s.jobPhase ?? s.jobState) {
    case 'weightSensing': return { energy: 0.3, level: 0.25, lift: 1, label: 'filling' };
    case 'wash': return { energy: 0.62, level: 0.78, lift: 1, label: 'wash' };
    case 'rinse': return { energy: 0.5, level: 0.68, lift: 1, label: 'rinse' };
    case 'spin': return { energy: 1.0, level: 0.14, lift: -1, label: 'spin' };
    case 'dry': return { energy: 0.45, level: 0.0, lift: 1, label: 'dry' };
    default: return { energy: 0.55, level: 0.6, lift: 1, label: 'run' };
  }
}

export function createAmbient(canvas) {
  const ctx = canvas.getContext('2d', { alpha: false });
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

  let W = 0, H = 0, dpr = 1;
  let theme = 'water';
  let status = null;

  // what we are animating toward, and where we are now (eased, so phase
  // changes glide instead of snapping)
  let target = phaseShape(null);
  const cur = { energy: 0.12, level: 0.1, lift: 1 };
  let tintTarget = tempKey(null);
  let tintMix = 0;            // 0..1 crossfade between previous and target tint
  let tintPrev = 'warm';

  const particles = [];
  const caustics = [];

  function resize() {
    dpr = Math.min(devicePixelRatio || 1, 2);
    W = canvas.clientWidth; H = canvas.clientHeight;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    seed();
  }

  function seed() {
    particles.length = 0;
    const n = Math.round(Math.min(64, (W * H) / 26000));
    for (let i = 0; i < n; i++) {
      particles.push({
        x: rand(0, W), y: rand(0, H),
        r: rand(1.5, theme === 'toy' ? 11 : 6),
        sp: rand(6, 26),                 // px/s at full energy
        wob: rand(0.3, 1.1),
        ph: rand(0, TAU),
        a: rand(0.22, 0.7),
      });
    }
    caustics.length = 0;
    for (let i = 0; i < (THEMES[theme].causticCount ?? 4); i++) {
      caustics.push({
        x: rand(0, W), y: rand(0, H),
        r: rand(Math.min(W, H) * 0.3, Math.min(W, H) * 0.75),
        sp: rand(3, 9), dir: rand(0, TAU), ph: rand(0, TAU),
      });
    }
  }

  function skyGradient() {
    const t = THEMES[theme];
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, t.sky[1]);
    g.addColorStop(0.55, t.sky[0]);
    g.addColorStop(1, t.sky[2]);
    return g;
  }

  const withAlpha = (tpl, a) => tpl.replace('ALPHA', a.toFixed(3));

  function draw(dt, time) {
    const T = THEMES[theme];

    // ease the field toward the target so phase changes are a glide
    const k = Math.min(1, dt * 0.6);
    cur.energy = lerp(cur.energy, target.energy, k);
    cur.level = lerp(cur.level, target.level, k);
    cur.lift = lerp(cur.lift, target.lift, k);
    tintMix = Math.min(1, tintMix + dt * 0.5);

    ctx.fillStyle = skyGradient();
    ctx.fillRect(0, 0, W, H);

    // --- temperature glow, low on the screen, where the "water" is ---
    const from = T.tint[tintPrev], to = T.tint[tintTarget];
    const glowY = H * (1 - cur.level * 0.55) + 40;
    for (const [colour, alpha] of [[from, (1 - tintMix) * 0.5], [to, tintMix * 0.5]]) {
      if (alpha < 0.01) continue;
      const g = ctx.createRadialGradient(W / 2, glowY, 0, W / 2, glowY, Math.max(W, H) * 0.75);
      g.addColorStop(0, colour);
      g.addColorStop(1, 'transparent');
      ctx.globalAlpha = alpha * (0.34 + cur.energy * 0.44);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
    }
    ctx.globalAlpha = 1;

    // --- console theme: faint instrument grid ---
    if (T.grid) {
      const step = T.gridStep ?? 48;
      ctx.strokeStyle = T.grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = 0; x < W; x += step) { ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, H); }
      for (let y = 0; y < H; y += step) { ctx.moveTo(0, y + 0.5); ctx.lineTo(W, y + 0.5); }
      ctx.stroke();
    }

    // --- caustics: slow soft light pools ---
    for (const c of caustics) {
      c.x += Math.cos(c.dir) * c.sp * dt * (0.4 + cur.energy);
      c.y += Math.sin(c.dir) * c.sp * dt * (0.4 + cur.energy) * 0.4;
      if (c.x < -c.r) c.x = W + c.r; else if (c.x > W + c.r) c.x = -c.r;
      if (c.y < -c.r) c.y = H + c.r; else if (c.y > H + c.r) c.y = -c.r;

      const pulse = 0.5 + 0.5 * Math.sin(time * 0.25 + c.ph);
      const a = (0.07 + cur.energy * 0.14) * pulse;
      const g = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, c.r);
      g.addColorStop(0, withAlpha(T.caustic, a));
      g.addColorStop(1, withAlpha(T.caustic, 0));
      ctx.fillStyle = g;
      ctx.fillRect(c.x - c.r, c.y - c.r, c.r * 2, c.r * 2);
    }

    // --- water body, with a gentle surface ---
    if (cur.level > 0.02) {
      const surface = H * (1 - cur.level);
      const amp = 7 * (0.3 + cur.energy);
      ctx.beginPath();
      ctx.moveTo(0, H);
      ctx.lineTo(0, surface);
      for (let x = 0; x <= W; x += 16) {
        const y = surface
          + Math.sin(x * 0.006 + time * 0.5) * amp
          + Math.sin(x * 0.013 - time * 0.33) * amp * 0.5;
        ctx.lineTo(x, y);
      }
      ctx.lineTo(W, H);
      ctx.closePath();
      ctx.fillStyle = T.waterFill;
      ctx.fill();
    }

    // --- particles: bubbles rising, or draining during the spin ---
    const waterTop = H * (1 - cur.level);
    for (const p of particles) {
      const speed = p.sp * (0.18 + cur.energy * 0.9);
      p.y -= speed * dt * cur.lift;
      p.x += Math.sin(time * p.wob + p.ph) * 9 * dt * (0.3 + cur.energy);

      if (cur.lift > 0 && p.y < -20) { p.y = H + rand(0, 60); p.x = rand(0, W); }
      if (cur.lift < 0 && p.y > H + 20) { p.y = -rand(0, 60); p.x = rand(0, W); }
      if (p.x < -20) p.x = W + 20; else if (p.x > W + 20) p.x = -20;

      // bubbles only exist where there is water; fade them above the surface
      const depth = cur.level < 0.05 ? 1 : Math.min(1, Math.max(0, (p.y - waterTop + 60) / 120));
      const a = p.a * (0.3 + cur.energy * 0.9) * depth;
      if (a < 0.015) continue;

      ctx.fillStyle = withAlpha(T.particle, a);
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, TAU);
      ctx.fill();
    }

    // --- projected-display scan: fixed raster plus one slow sweep ---
    if (T.scan) {
      ctx.fillStyle = 'rgba(0, 0, 0, 0.22)';
      for (let y = 0; y < H; y += 3) ctx.fillRect(0, y, W, 1);

      // ~16s top to bottom. Slow enough to read as atmosphere, not movement.
      const sweepH = 180;
      const sy = ((time % 16) / 16) * (H + sweepH) - sweepH;
      const g = ctx.createLinearGradient(0, sy, 0, sy + sweepH);
      g.addColorStop(0, 'rgba(255, 160, 60, 0)');
      g.addColorStop(0.5, `rgba(255, 170, 70, ${(0.035 + cur.energy * 0.03).toFixed(3)})`);
      g.addColorStop(1, 'rgba(255, 160, 60, 0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, sy, W, sweepH);
    }

    // --- vignette, keeps the text side of things legible ---
    const v = ctx.createRadialGradient(W / 2, H * 0.4, Math.min(W, H) * 0.25, W / 2, H * 0.5, Math.max(W, H) * 0.8);
    v.addColorStop(0, 'transparent');
    v.addColorStop(1, 'rgba(0,0,0,0.38)');
    ctx.fillStyle = v;
    ctx.fillRect(0, 0, W, H);
  }

  // --- loop: 30fps cap, paused while hidden ---
  let raf = null, last = 0, acc = 0;
  const STEP = 1 / 30;

  function frame(ms) {
    raf = requestAnimationFrame(frame);
    const now = ms / 1000;
    const dt = Math.min(0.1, now - last || 0.016);
    last = now;
    acc += dt;
    if (acc < STEP) return;
    acc = 0;
    draw(dt, now);
  }

  function start() {
    if (raf || reduce) return;
    last = performance.now() / 1000;
    raf = requestAnimationFrame(frame);
  }
  function stop() {
    if (raf) cancelAnimationFrame(raf);
    raf = null;
  }

  const onVisibility = () => (document.hidden ? stop() : start());
  document.addEventListener('visibilitychange', onVisibility);
  addEventListener('resize', resize);

  resize();
  if (reduce) draw(0.016, 0); else start();

  return {
    setStatus(s) {
      status = s;
      target = phaseShape(s);
      const k = tempKey(s?.waterTemperature);
      if (k !== tintTarget) { tintPrev = tintTarget; tintTarget = k; tintMix = 0; }
      if (reduce) draw(0.016, 0);
    },
    setTheme(name) {
      if (!THEMES[name]) return;
      theme = name;
      seed();
      if (reduce) draw(0.016, 0);
    },
    phaseLabel: () => phaseShape(status).label,
    destroy() {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
      removeEventListener('resize', resize);
    },
  };
}

export const THEME_NAMES = Object.keys(THEMES);
