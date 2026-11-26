'use strict';

(() => {
// One angle for the whole wheel. A photo tap adds one revolution, with
// zero added velocity at each end of the hand-off to the slow idle spin.
const TURN = 2 * Math.PI;
const BASE_SPEED = TURN / 49000;
const BOOST_MS = 2900;
const MOTION_KEY = 'sge-home-photo-motion';
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

function measureOrbit(width, height, heroWidth, heroHeight) {
  const mobile = width <= 700;
  const size = mobile ? Math.min(104, Math.max(80, width * .245))
    : Math.min(176, Math.max(108, width * .12), height * .215);
  const rx = mobile ? Math.max(width * .37, (heroWidth + size * .75) / 2 + 6)
    : Math.min(width / 2 - size * .12, Math.max(width * .31, (heroWidth + size * 1.2) / 2 + 16));
  const ry = mobile ? Math.max(160, (height - heroHeight) / 2 + 55)
    : Math.max(205, Math.min(height * .39, (height - heroHeight) / 2 + 90));
  return { width, height, mobile, size, rx, ry, zAmplitude: mobile ? 160 : 245 };
}

function photoDimensions(size, ratio) {
  const aspect = Math.sqrt(Number.isFinite(ratio) && ratio > 0 ? clamp(ratio, .36, 3) : 1);
  return { width: size * aspect, height: size / aspect };
}

function orbitFrame(angle, index, total, dimensions, photo) {
  const { rx, ry, mobile, zAmplitude, width, height } = dimensions;
  const a = angle + index * TURN / total;
  const x = rx * Math.cos(a);
  const y = ry * Math.sin(a) * .64;
  const z = zAmplitude * Math.sin(a);
  const front = (z + zAmplitude) / (2 * zAmplitude);
  const scale = (mobile ? .72 : .68) + front * (mobile ? .42 : .5);
  const tilt = (mobile ? 7 : 10) * Math.cos(a) + (mobile ? 4 : 7) * Math.sin(a);
  // Keep keyboard outlines in view even when side prints are clipped on phones.
  const perspective = 1600 / (1600 - z);
  const radians = tilt * Math.PI / 180;
  const extentX = (photo.width * Math.abs(Math.cos(radians)) + photo.height * Math.abs(Math.sin(radians))) * scale / 2;
  const extentY = (photo.height * Math.abs(Math.cos(radians)) + photo.width * Math.abs(Math.sin(radians))) * scale / 2;
  const safeX = Math.max(0, (width / 2 - 8) / perspective - extentX);
  const safeY = Math.max(0, (height / 2 - 8) / perspective - extentY);
  return {
    x, y, z, tilt, scale,
    focusX: clamp(x, -safeX, safeX), focusY: clamp(y, -safeY, safeY),
    depth: 20 + Math.round(front * 100),
    opacity: .38 + front * .62, brightness: .56 + front * .54,
    shadowY: Math.round(front > .62 ? 18 + front * 18 : 8 + front * 8),
    shadowBlur: Math.round(front > .62 ? 38 + front * 26 : 20 + front * 20),
    shadowOpacity: front > .62 ? .58 : .34
  };
}

function boostOffset(elapsed) {
  const progress = clamp(elapsed / BOOST_MS, 0, 1);
  return TURN * progress - Math.sin(TURN * progress);
}

function readPhotoMotion(win) {
  const fallback = new URLSearchParams(win.location?.search || '').get('photo-motion');
  if (fallback === 'off' || fallback === 'on') return fallback === 'on';
  for (const storage of ['localStorage', 'sessionStorage']) {
    try {
      const choice = win[storage]?.getItem(MOTION_KEY);
      if (choice === 'off' || choice === 'on') return choice === 'on';
    } catch { /* Continue when browser storage is restricted. */ }
  }
  return true;
}

function setPhotoMotion(win, enabled) {
  for (const storage of ['localStorage', 'sessionStorage']) {
    try {
      if (!win[storage]) continue;
      win[storage].setItem(MOTION_KEY, enabled ? 'on' : 'off');
      // A readable but unwritable local value can outrank a session write.
      if (readPhotoMotion(win) === enabled) return true;
    } catch { /* Fall back to the return link when storage is unavailable. */ }
  }
  return false;
}

function onMotionChange(reduce, handler) {
  if (typeof reduce.addEventListener === 'function') reduce.addEventListener('change', handler);
  else if (typeof reduce.addListener === 'function') reduce.addListener(handler);
}

function mountMotionControls(doc, win, reduce) {
  const panel = doc.querySelector('[data-home-motion-controls]');
  const input = doc.querySelector('[data-home-orbit-motion]');
  if (!panel || !input) return;
  const note = doc.querySelector('[data-home-motion-note]');
  const homeLink = doc.querySelector('.home-how-back');
  const defaultNote = note?.textContent;
  let enabled = readPhotoMotion(win);
  let returnLinkOnly = false;
  function render() {
    input.checked = enabled && !reduce.matches;
    input.disabled = reduce.matches;
    if (note) {
      note.textContent = reduce.matches ? 'Animation is off because your device uses Reduce Motion.'
        : returnLinkOnly ? 'Use Back to homepage to apply this choice; your browser didn’t save it.' : defaultNote;
    }
  }
  input.addEventListener('change', () => {
    if (reduce.matches) return render();
    enabled = input.checked;
    returnLinkOnly = !setPhotoMotion(win, enabled);
    if (homeLink) homeLink.href = returnLinkOnly ? `/?photo-motion=${enabled ? 'on' : 'off'}` : '/';
    render();
  });
  onMotionChange(reduce, render);
  render();
  panel.hidden = false;
}

function mountHomeOrbit(doc, win) {
  const stage = doc.querySelector('[data-home-orbit-stage]');
  const gallery = doc.querySelector('[data-home-orbit-gallery]');
  const hero = doc.querySelector('[data-home-orbit-hero]');
  const credits = doc.querySelector('.home-orbit-credits');
  const cards = gallery ? [...gallery.querySelectorAll('.home-orbit-photo')] : [];
  const reduce = typeof win.matchMedia === 'function' ? win.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
  mountMotionControls(doc, win, reduce);
  const ready = Boolean(stage && stage.parentElement && hero && cards.length > 1 && typeof win.requestAnimationFrame === 'function');
  let angle = -Math.PI / 2 + .09;
  let raf = null;
  let last = null;
  let spin = null;
  let playing = !reduce.matches && readPhotoMotion(win);
  let dimensions;
  const photos = cards.map(card => ({ card, label: card.getAttribute('aria-label'), ratio: Number(card.dataset.orbitRatio), properties: new Map() }));

  function syncPhotoActions() {
    for (const { card, label } of photos) {
      if (label) card.setAttribute('aria-label', playing ? label : label.replace(/^Spin photo wheel/, 'Step photo wheel'));
    }
  }

  function setStyle(photo, name, value) {
    if (photo.properties.get(name) === value) return;
    photo.card.style.setProperty(name, value);
    photo.properties.set(name, value);
  }

  function draw() {
    if (!dimensions) return;
    photos.forEach((photo, index) => {
      const value = orbitFrame(angle, index, photos.length, dimensions, photo);
      for (const [name, amount, units] of [
        ['x', value.x, 'px'], ['y', value.y, 'px'], ['z', value.z, 'px'],
        ['focus-x', value.focusX, 'px'], ['focus-y', value.focusY, 'px'],
        ['tilt', value.tilt, 'deg'], ['scale', value.scale, ''],
        ['opacity', value.opacity, ''], ['brightness', value.brightness, '']
      ]) setStyle(photo, `--ho-${name}`, `${amount.toFixed(3)}${units}`);
      setStyle(photo, '--ho-depth', String(value.depth));
      setStyle(photo, '--ho-shadow-y', `${value.shadowY}px`);
      setStyle(photo, '--ho-shadow-blur', `${value.shadowBlur}px`);
      setStyle(photo, '--ho-shadow-opacity', String(value.shadowOpacity));
    });
  }

  function measure() {
    if (!ready || !stage.clientWidth || !stage.clientHeight) return;
    dimensions = measureOrbit(stage.clientWidth, stage.clientHeight, hero.offsetWidth, hero.offsetHeight);
    for (const photo of photos) {
      Object.assign(photo, photoDimensions(dimensions.size, photo.ratio));
      setStyle(photo, '--ho-photo-width', `${photo.width.toFixed(2)}px`);
      setStyle(photo, '--ho-photo-height', `${photo.height.toFixed(2)}px`);
    }
    draw();
  }

  function shouldAnimate() {
    return ready && playing && !reduce.matches && !doc.hidden && !credits?.open
      && (spin || !gallery.querySelector(':focus-visible'));
  }

  function reconcile() {
    if (!shouldAnimate()) {
      if (raf !== null) win.cancelAnimationFrame(raf);
      raf = null;
      last = null;
    } else if (raf === null) {
      raf = win.requestAnimationFrame(frame);
    }
  }

  function frame(now) {
    raf = null;
    if (!shouldAnimate()) return reconcile();
    const elapsed = last === null ? 0 : clamp(now - last, 0, 50);
    last = now;
    let advance = playing ? elapsed * BASE_SPEED : 0;
    if (spin) {
      const previous = boostOffset(spin.elapsed);
      spin.elapsed = Math.min(BOOST_MS, spin.elapsed + elapsed);
      advance += boostOffset(spin.elapsed) - previous;
      if (spin.elapsed >= BOOST_MS) spin = null;
    }
    if (advance) {
      angle = (angle + advance) % TURN;
      draw();
    }
    reconcile();
  }

  for (const card of cards) {
    const img = card.querySelector('img');
    const missing = () => {
      card.classList.add('is-image-missing');
      if (img) img.hidden = true;
    };
    if (!img || (img.complete && !img.naturalWidth)) missing();
    else img.addEventListener('error', missing, { once: true });
  }
  if (!ready) return;

  stage.parentElement.classList.add('is-orbit-enhanced');
  for (const card of cards) {
    card.disabled = false;
    card.addEventListener('click', () => {
      if (spin) return;
      if (!playing || reduce.matches) {
        // Explicit navigation without animation when motion is turned off.
        angle = (angle + TURN / cards.length) % TURN;
        draw();
        return;
      }
      spin = { elapsed: 0 };
      reconcile();
    });
  }
  const onMotion = () => {
    if (reduce.matches) {
      spin = null;
      playing = false;
    }
    syncPhotoActions();
    reconcile();
  };
  function syncSavedMotion() {
    playing = !reduce.matches && readPhotoMotion(win);
    if (!playing) spin = null;
    syncPhotoActions();
    reconcile();
  }
  onMotionChange(reduce, onMotion);
  win.addEventListener('storage', event => {
    if (event.key === MOTION_KEY || event.key === null) syncSavedMotion();
  });
  win.addEventListener('pageshow', event => { if (event.persisted) syncSavedMotion(); });
  gallery.addEventListener('focusin', reconcile);
  gallery.addEventListener('focusout', () => Promise.resolve().then(reconcile));
  doc.addEventListener('visibilitychange', reconcile);
  credits?.addEventListener('toggle', reconcile);
  if (typeof win.ResizeObserver === 'function') {
    const observer = new win.ResizeObserver(measure);
    observer.observe(stage);
    observer.observe(hero);
  } else {
    win.addEventListener('resize', measure);
  }
  measure();
  syncPhotoActions();
  reconcile();
}

if (typeof module === 'object' && module.exports) {
  module.exports = { measureOrbit, photoDimensions, orbitFrame, boostOffset, mountHomeOrbit };
} else if (typeof window === 'object') {
  mountHomeOrbit(document, window);
}
})();
