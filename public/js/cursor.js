/* Nook - Copyright (c) 2026 Abhi. Source-available, non-commercial licence. See LICENSE. */
/* Direction-aware flow cursor: a thin arrow that turns toward movement with
   three lagging echoes for a soft, wave-like trail. */
(function () {
  'use strict';
  const root = document.getElementById('nookCursor');
  if (!root || !window.matchMedia('(pointer: fine)').matches) return;

  const arrow = root.querySelector('.cursor-arrow');
  const waves = Array.from(root.querySelectorAll('.cursor-wave'));
  let x = window.innerWidth / 2, y = window.innerHeight / 2;
  let tx = x, ty = y;
  let angle = 0, targetAngle = 0;
  let active = false;
  const trail = waves.map(() => ({ x, y }));

  function place(el, px, py, deg, scale) {
    el.style.transform = `translate3d(${px - 13}px,${py - 13}px,0) rotate(${deg}deg) scale(${scale})`;
  }

  document.addEventListener('mousemove', (e) => {
    const dx = e.clientX - tx;
    const dy = e.clientY - ty;
    if (Math.hypot(dx, dy) > 0.6) targetAngle = Math.atan2(dy, dx) * 180 / Math.PI + 90;
    tx = e.clientX;
    ty = e.clientY;
    if (!active) {
      active = true;
      x = tx; y = ty;
      trail.forEach((p) => { p.x = tx; p.y = ty; });
      root.style.opacity = '1';
    }
  }, { passive: true });

  document.addEventListener('mouseout', (e) => {
    if (!e.relatedTarget) root.style.opacity = '0';
  });

  function frame() {
    x += (tx - x) * 0.3;
    y += (ty - y) * 0.3;
    let delta = ((targetAngle - angle + 540) % 360) - 180;
    angle += delta * 0.16;
    place(arrow, x, y, angle, 1);
    let leadX = x, leadY = y;
    trail.forEach((p, i) => {
      const ease = 0.2 - i * 0.04;
      p.x += (leadX - p.x) * ease;
      p.y += (leadY - p.y) * ease;
      place(waves[i], p.x, p.y, angle, 0.88 - i * 0.09);
      leadX = p.x; leadY = p.y;
    });
    requestAnimationFrame(frame);
  }
  frame();
})();
