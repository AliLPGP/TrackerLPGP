// Sign-in background: a field of dots that lights up in blue around the
// pointer, with a ripple where you click. With no pointer (phones, or the
// mouse idle a few seconds) a soft light drifts across on its own. Reduced
// motion gets the still field only.
(function () {
  const canvas = document.getElementById('loginBg');
  if (!canvas || !canvas.getContext) return;
  const ctx = canvas.getContext('2d');
  const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const GAP = 26;          // distance between dots, CSS px
  const REACH = 220;       // radius of the pointer's light
  let w = 0, h = 0, dpr = 1;
  const target = { x: -9999, y: -9999 };
  const light = { x: -9999, y: -9999 };
  let lastMove = 0;
  const ripples = [];

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = window.innerWidth; h = window.innerHeight;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (still) draw(performance.now());
  }

  function colours() {
    const dark = document.documentElement.getAttribute('data-theme') === 'dark';
    return dark
      ? { base: [255, 255, 255], baseA: 0.07, lit: [47, 128, 255], litA: 0.95, pool: 0.18 }
      : { base: [15, 23, 42], baseA: 0.10, lit: [31, 111, 235], litA: 0.85, pool: 0.10 };
  }

  function draw(now) {
    const c = colours();
    ctx.clearRect(0, 0, w, h);

    // Idle: let the light wander on a slow loop so the page is never flat.
    if (!still && now - lastMove > 3500) {
      const t = now / 1000;
      target.x = w * (0.5 + 0.32 * Math.sin(t * 0.23));
      target.y = h * (0.5 + 0.28 * Math.sin(t * 0.31 + 1.2));
    }
    light.x += (target.x - light.x) * 0.12;
    light.y += (target.y - light.y) * 0.12;

    for (let i = ripples.length - 1; i >= 0; i--) {
      ripples[i].r += 9;
      if (ripples[i].r > Math.max(w, h)) ripples.splice(i, 1);
    }

    // A soft pool of light under the lit dots.
    if (light.x > -999) {
      const g = ctx.createRadialGradient(light.x, light.y, 0, light.x, light.y, REACH * 1.6);
      g.addColorStop(0, `rgba(${c.lit[0]},${c.lit[1]},${c.lit[2]},${c.pool})`);
      g.addColorStop(1, `rgba(${c.lit[0]},${c.lit[1]},${c.lit[2]},0)`);
      ctx.fillStyle = g;
      ctx.fillRect(light.x - REACH * 1.6, light.y - REACH * 1.6, REACH * 3.2, REACH * 3.2);
    }

    const ox = (w % GAP) / 2, oy = (h % GAP) / 2;
    for (let y = oy; y <= h; y += GAP) {
      for (let x = ox; x <= w; x += GAP) {
        const d = Math.hypot(x - light.x, y - light.y);
        let glow = d < REACH ? Math.pow(1 - d / REACH, 2) : 0;
        for (const r of ripples) {
          const band = Math.abs(Math.hypot(x - r.x, y - r.y) - r.r);
          if (band < 26) glow = Math.max(glow, (1 - band / 26) * (1 - r.r / Math.max(w, h)) * 0.9);
        }
        const size = 1.1 + glow * 2.2;
        if (glow > 0.02) {
          ctx.fillStyle = `rgba(${c.lit[0]},${c.lit[1]},${c.lit[2]},${(c.baseA + glow * c.litA).toFixed(3)})`;
        } else {
          ctx.fillStyle = `rgba(${c.base[0]},${c.base[1]},${c.base[2]},${c.baseA})`;
        }
        ctx.beginPath();
        ctx.arc(x, y, size, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  function frame(now) {
    draw(now);
    if (!document.hidden) requestAnimationFrame(frame);
  }

  window.addEventListener('resize', resize);
  if (!still) {
    window.addEventListener('pointermove', e => {
      target.x = e.clientX; target.y = e.clientY; lastMove = performance.now();
      // Floating marks lean gently away from the pointer.
      document.documentElement.style.setProperty('--px', ((e.clientX / w) - 0.5).toFixed(3));
      document.documentElement.style.setProperty('--py', ((e.clientY / h) - 0.5).toFixed(3));
    }, { passive: true });
    window.addEventListener('pointerdown', e => {
      if (e.target.closest('.login-card, .login-theme-btn')) return;
      ripples.push({ x: e.clientX, y: e.clientY, r: 0 });
    }, { passive: true });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) requestAnimationFrame(frame); });
    // The theme button repaints the dots in the other palette straight away.
  }
  resize();
  if (!still) requestAnimationFrame(frame);
  else document.getElementById('loginThemeBtn')?.addEventListener('click', () => setTimeout(() => draw(0), 0));
})();
