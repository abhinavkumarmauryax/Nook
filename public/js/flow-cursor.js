/* Nook - Copyright (c) 2026 Abhi. Source-available, non-commercial licence. See LICENSE. */
/* Smoothly turning cursor. The CSS cursor is always available as a fallback;
   the native one is hidden only after this overlay is visibly in place. */
(function () {
  'use strict';
  if (!window.matchMedia('(pointer: fine)').matches) return;

  const SVG = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">' +
    '<circle cx="12" cy="12" r="6.2" stroke="#E7F1FD" stroke-width="1" opacity="0.4"/>' +
    '<path d="M12 2.5V8M12 16V21.5M2.5 12H8M16 12H21.5" stroke="#E7F1FD" stroke-width="1.5" stroke-linecap="round"/>' +
    '<circle cx="12" cy="12" r="1.7" fill="#F8A838"/></svg>';

  const root = document.createElement('div');
  root.id = 'flowCursor';
  root.setAttribute('aria-hidden', 'true');
  root.innerHTML = '<span class="flow-trail"></span><span class="flow-trail flow-trail-2"></span><span class="flow-arrow"></span>';
  document.body.appendChild(root);

  const arrow = root.querySelector('.flow-arrow');
  const trails = Array.from(root.querySelectorAll('.flow-trail'));
  [arrow, ...trails].forEach((el) => { el.innerHTML = SVG; });

  let x = window.innerWidth / 2, y = window.innerHeight / 2;
  let tx = x, ty = y;
  let angle = 0, target = 0, active = false;
  const trail = trails.map(() => ({ x, y, a: 0 }));

  function place(el, px, py, deg, scale) {
    el.style.transform = `translate3d(${px - 12}px,${py - 12}px,0) rotate(${deg}deg) scale(${scale})`;
  }

  document.addEventListener('mousemove', (e) => {
    const dx = e.clientX - tx, dy = e.clientY - ty;
    if (Math.hypot(dx, dy) > 0.5) target = Math.atan2(dy, dx) * 180 / Math.PI + 90;
    tx = e.clientX; ty = e.clientY;
    // Place immediately so the pointer is never left behind if animation
    // frames are throttled (e.g. background tab).
    x = tx; y = ty;
    place(arrow, x, y, angle, 1);
    trail.forEach((p, i) => { p.x = x; p.y = y; place(trails[i], x, y, p.a, 0.9 - i * 0.12); });
    if (!active) {
      active = true;
      x = tx; y = ty;
      trail.forEach((p) => { p.x = tx; p.y = ty; p.a = 0; });
      root.style.opacity = '1';
      // Hide the native cursor only now, when the overlay is actually visible.
      document.documentElement.classList.add('cursor-rotating');
    }
  }, { passive: true });

  document.addEventListener('mouseout', (e) => {
    if (!e.relatedTarget) root.style.opacity = '0';
  });
  document.addEventListener('mouseover', () => { if (active) root.style.opacity = '1'; });
  window.addEventListener('blur', () => document.documentElement.classList.remove('cursor-rotating'));

  place(arrow, x, y, angle, 1);
  trail.forEach((p, i) => place(trails[i], p.x, p.y, p.a, 0.9 - i * 0.12));

  function frame() {
    try {
      x += (tx - x) * 0.34;
      y += (ty - y) * 0.34;
      // Slow, flowing turn toward the direction of travel.
      let delta = ((target - angle + 540) % 360) - 180;
      angle += delta * 0.055;
      place(arrow, x, y, angle, 1);
      let leadX = x, leadY = y, leadA = angle;
      trail.forEach((p, i) => {
        const ease = 0.16 - i * 0.05;
        p.x += (leadX - p.x) * ease;
        p.y += (leadY - p.y) * ease;
        let ad = ((leadA - p.a + 540) % 360) - 180;
        p.a += ad * 0.05;
        place(trails[i], p.x, p.y, p.a, 0.9 - i * 0.12);
        leadX = p.x; leadY = p.y; leadA = p.a;
      });
    } catch (err) {
      // Never leave the user without a cursor.
      document.documentElement.classList.remove('cursor-rotating');
    }
  }
  // A timer keeps easing even where animation frames are throttled.
  setInterval(frame, 16);
})();
