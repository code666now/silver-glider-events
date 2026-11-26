'use strict';

(() => {
// One angle for the whole wheel. A photo tap adds one revolution, with
// zero added velocity at each end of the hand-off to the slow idle spin.
const TURN = 2 * Math.PI;
const BASE_SPEED = TURN / 49000;
const BOOST_MS = 2900;
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

function mountHomeOrbit(doc, win) {
  const stage = doc.querySelector('[data-home-orbit-stage]');
  const gallery = doc.querySelector('[data-home-orbit-gallery]');
  const hero = doc.querySelector('[data-home-orbit-hero]');
  const pause = doc.querySelector('[data-home-orbit-pause]');
  const dialog = doc.querySelector('[data-home-orbit-dialog]');
  const trigger = doc.querySelector('[data-home-orbit-how]');
  const close = doc.querySelector('[data-home-orbit-close]');
  const credits = doc.querySelector('.home-orbit-credits');
  const cards = gallery ? [...gallery.querySelectorAll('.home-orbit-photo')] : [];
  const reduce = typeof win.matchMedia === 'function' ? win.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
  const ready = Boolean(stage && stage.parentElement && hero && pause && cards.length > 1 && typeof win.requestAnimationFrame === 'function');
  const marker = pause?.querySelector('span');
  let angle = -Math.PI / 2 + .09;
  let raf = null;
  let last = null;
  let spin = null;
  let playing = !reduce.matches;
  let dimensions;
  const photos = cards.map(card => ({ card, ratio: Number(card.dataset.orbitRatio), properties: new Map() }));

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

  function syncPause() {
    if (!ready) return;
    const active = Boolean(playing || spin);
    const label = active ? 'Pause animation' : 'Play animation';
    pause.hidden = reduce.matches;
    pause.title = label;
    pause.setAttribute('aria-label', label);
    if (marker) marker.textContent = active ? 'Ⅱ' : '▶';
  }

  function shouldAnimate() {
    return ready && !reduce.matches && !doc.hidden && !dialog?.open && !credits?.open
      && (spin || (playing && !gallery.querySelector(':focus-visible')));
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
      if (spin.elapsed >= BOOST_MS) {
        spin = null;
        syncPause();
      }
    }
    if (advance) {
      angle = (angle + advance) % TURN;
      draw();
    }
    reconcile();
  }

  // The link doubles as a no-JS fragment navigation. Dialog controls are
  // enhanced only when showModal is available (native focus trap and Escape).
  if (dialog && trigger && close && typeof dialog.showModal === 'function') {
    trigger.addEventListener('click', event => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      event.preventDefault();
      if (dialog.open) return;
      dialog.showModal();
      close.focus();
      reconcile();
    });
    close.addEventListener('click', event => {
      if (!dialog.open) return;
      event.preventDefault();
      dialog.close();
    });
    dialog.addEventListener('click', event => {
      if (dialog.open && event.target === dialog) dialog.close();
    });
    dialog.addEventListener('close', () => {
      trigger.focus();
      reconcile();
    });
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
      if (dialog?.open || spin) return;
      if (reduce.matches) {
        // Explicit navigation, no animation for a reduced-motion preference.
        angle = (angle + TURN / cards.length) % TURN;
        draw();
        return;
      }
      spin = { elapsed: 0 };
      syncPause();
      reconcile();
    });
  }
  pause.addEventListener('click', () => {
    playing = !spin && !playing;
    spin = null;
    syncPause();
    reconcile();
  });
  const onMotion = () => {
    if (reduce.matches) {
      spin = null;
      playing = false;
    }
    syncPause();
    reconcile();
  };
  if (typeof reduce.addEventListener === 'function') reduce.addEventListener('change', onMotion);
  else if (typeof reduce.addListener === 'function') reduce.addListener(onMotion);
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
  syncPause();
  reconcile();
}

if (typeof module === 'object' && module.exports) {
  module.exports = { measureOrbit, photoDimensions, orbitFrame, boostOffset, mountHomeOrbit };
} else if (typeof window === 'object') {
  mountHomeOrbit(document, window);
}
})();
