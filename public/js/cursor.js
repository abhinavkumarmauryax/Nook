/* Nook - Copyright (c) 2026 Abhi. Source-available, non-commercial licence. See LICENSE. */
/* Direction-aware flow cursor with a soft wave trail. */
(function () {
  'use strict';
  const root = document.getElementById('nookCursor');
  if (!root) return;
  const fine = window.matchMedia('(pointer: fine)').matches || !('ontouchstart' in window);
  if (!fine) return;

  const ARROW = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3 L19 12 L12 13 L9 20 Z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M19 12 L12 13" stroke="currentColor" stroke-width="1"/></svg>';
  const arrow = root.querySelector('.cursor-arrow');
  const waves = Array.from(root.querySelectorAll('.cursor-wave'));
  [arrow, ...waves].forEach((el) => { if (el) el.innerHTML = ARROW; });

  let x = window.innerWidth / 2, y = window.innerHeight / 2;
  let tx = x, ty = y, angle = 0, targetAngle = 0, active = false;
  const trail = waves.map(() => ({ x, y }));

  function place(el, px, py, deg, scale) {
    if (!el) return;
    el.style.transform = `translate3d(${px - 13}px,${py - 13}px,0) rotate(${deg}deg) scale(${scale})`;
  }

  document.addEventListener('mousemove', (e) => {
    const dx = e.clientX - tx, dy = e.clientY - ty;
    if (Math.hypot(dx, dy) > 0.5) targetAngle = Math.atan2(dy, dx) * 180 / Math.PI + 90;
    tx = e.clientX; ty = e.clientY;
    if (!active) {
      active = true;
      x = tx; y = ty;
      trail.forEach((p) => { p.x = tx; p.y = ty; });
    }
  }, { passive: true });

  document.addEventListener('mouseout', (e) => {
    if (!e.relatedTarget) root.style.opacity = '0';
  });
  document.addEventListener('mouseover', () => { root.style.opacity = '1'; });

  // Only hide the native cursor once everything above is ready.
  document.documentElement.classList.add('has-flow-cursor');
  document.documentElement.classList.remove('cursor-hidden');
  root.style.opacity = '1';
  place(arrow, x, y, angle, 1);
  trail.forEach((p, i) => place(waves[i], p.x, p.y, angle, 0.88 - i * 0.09));

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
  requestAnimationFrame(frame);
})();
