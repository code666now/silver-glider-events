/* Homepage hero: the phone turns gently toward the pointer on desktop and
   eases back to its resting lean when the pointer leaves. A click or tap
   spins it once to show its back: a hidden delight. Tilt is off for touch
   screens; both are off for anyone who asks for reduced motion.

   Everything here is decoration, so it fails quietly: if anything is missing
   or unsupported the phone simply stays still. */

(() => {
  const MAX_TILT = 8;        // degrees, small enough to keep the event page readable
  const SPIN_MS = 1200;      // matches the .is-spinning transition in index.html
  const SPIN_GRACE_MS = 250; // extra time before the fallback settles a spin

  function watch(query, onChange) {
    const list = window.matchMedia(query);
    if (list.addEventListener) list.addEventListener('change', onChange);
    else if (list.addListener) list.addListener(onChange); // Safari before 14
    return list;
  }

  function initializeHeroTilt() {
    const hero = document.querySelector('.home-hero');
    const frame = hero && hero.querySelector('.home-phone-frame');
    if (!frame || !window.matchMedia || !window.requestAnimationFrame) return;

    let frameRequest = 0;
    let pointer = null;
    let spinning = false;
    let spinStartedAt = 0;
    let spinFallback = 0;

    const setTilt = (rx, ry, sheen) => {
      frame.style.setProperty('--rx', `${rx.toFixed(2)}deg`);
      frame.style.setProperty('--ry', `${ry.toFixed(2)}deg`);
      if (sheen !== undefined) frame.style.setProperty('--sheen', `${sheen.toFixed(1)}%`);
    };

    const apply = () => {
      frameRequest = 0;
      // During a spin the angle is left alone; settle() catches up afterwards.
      if (!pointer || spinning) return;
      const box = frame.getBoundingClientRect();
      if (!box.width || !box.height) return;
      // -1 … 1 from the phone's centre, measured across the viewport so the
      // phone reacts before the pointer reaches it.
      const x = Math.max(-1, Math.min(1, (pointer.x - (box.left + box.width / 2)) / (window.innerWidth / 2)));
      const y = Math.max(-1, Math.min(1, (pointer.y - (box.top + box.height / 2)) / (window.innerHeight / 2)));
      setTilt(-y * MAX_TILT, x * MAX_TILT, 50 + x * 40);
    };

    const schedule = () => {
      if (!frameRequest) frameRequest = window.requestAnimationFrame(apply);
    };

    const release = () => {
      pointer = null;
      if (frameRequest) window.cancelAnimationFrame(frameRequest);
      frameRequest = 0;
      frame.classList.remove('is-tracking');
      if (!spinning) setTilt(0, 0);
    };

    // Ends a spin exactly once, however it ends: the transition finishing,
    // the fallback timer, or reduced motion switching on mid-turn.
    const settle = () => {
      if (!spinning) return;
      spinning = false;
      window.clearTimeout(spinFallback);
      // A full turn looks the same as none: jump back to 0 without animating,
      // so the next spin starts fresh.
      frame.classList.add('is-settling');
      frame.classList.remove('is-spinning');
      frame.style.setProperty('--spin', '0deg');
      void frame.offsetWidth; // commit the jump before transitions come back
      frame.classList.remove('is-settling');
      if (pointer) schedule(); else setTilt(0, 0);
    };

    const finePointer = watch('(hover: hover) and (pointer: fine)', release);
    const reducedMotion = watch('(prefers-reduced-motion: reduce)', () => { settle(); release(); });

    // Follow the pointer anywhere across the hero's band of the page, edge to
    // edge, not only inside its centred column.
    document.addEventListener('pointermove', event => {
      if (!finePointer.matches || reducedMotion.matches || event.pointerType !== 'mouse') return;
      const band = hero.getBoundingClientRect();
      if (event.clientY < band.top - 40 || event.clientY > band.bottom + 40) {
        if (pointer) release();
        return;
      }
      pointer = { x: event.clientX, y: event.clientY };
      frame.classList.add('is-tracking');
      schedule();
    }, { passive: true });
    document.documentElement.addEventListener('pointerleave', release);
    window.addEventListener('blur', release);

    frame.addEventListener('click', () => {
      if (spinning || reducedMotion.matches) return;
      spinning = true;
      spinStartedAt = Date.now();
      frame.classList.add('is-spinning');
      frame.style.setProperty('--spin', '360deg');
      // transitionend can be skipped (a hidden tab, an interrupted
      // transition), so a timer guarantees the spin always settles.
      spinFallback = window.setTimeout(settle, SPIN_MS + SPIN_GRACE_MS);
    });
    frame.addEventListener('transitionend', event => {
      if (!spinning || event.target !== frame || event.propertyName !== 'transform') return;
      // Ignore a tilt transition that happened to finish just after the click.
      if (Date.now() - spinStartedAt < SPIN_MS * 0.75) return;
      settle();
    });
    // The image is decoration: no native drag ghost when someone grabs it.
    frame.addEventListener('dragstart', event => event.preventDefault());
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeHeroTilt, { once: true });
  } else {
    initializeHeroTilt();
  }
})();
