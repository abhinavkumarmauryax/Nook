/* Nook - Copyright (c) 2026 Abhi. Source-available, non-commercial licence. See LICENSE. */
/* Smoothly turning cursor. The CSS cursor is always available as a fallback;
   the native one is hidden only after this overlay is visibly in place. */
(function () {
  'use strict';
  if (!window.matchMedia('(pointer: fine)').matches) return;

  const PATH = 'M8.846 0.908C5.732 2.211 2.259 5.905 0.749 9.52C-0.441 12.369 -0.299 17.987 1.801 51.129C3.137 72.202 5.208 105.868 6.404 125.943C7.6 146.018 9.016 164.216 9.552 166.383C12.324 177.606 26.684 181.495 34.613 173.17C36.041 171.671 44.037 159.868 52.38 146.943C75.505 111.121 71.194 113.758 112.099 110.419C128.46 109.084 143.491 107.525 145.503 106.955C155.694 104.068 159.672 89.192 152.113 82.238C150.866 81.092 135.446 71.265 117.846 60.402C78.79 36.296 67.346 29.222 56.346 22.389C20.182 -0.076 20.211 -0.06 15.42 0.007C12.904 0.042 9.946 0.447 8.846 0.908Z';
  const SVG = '<svg width="17" height="19" viewBox="0 0 156.039 177.642" fill="none" xmlns="http://www.w3.org/2000/svg">' +
    '<path d="' + PATH + '" fill="#FFFFFF" fill-rule="evenodd"/>' +
    '<path transform="matrix(0.7 0 0 0.7 23.4 26.7)" d="' + PATH + '" fill="#3A3A42" fill-rule="evenodd"/></svg>';

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
    el.style.transform = `translate3d(${px - 8}px,${py - 9}px,0) rotate(${deg}deg) scale(${scale})`;
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
