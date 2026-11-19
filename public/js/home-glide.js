/* Homepage Familiar Faces: one automatic flight, with optional replay. */
(() => {
  const row = document.querySelector('.home-faces');
  const replay = document.querySelector('.home-faces-replay');
  const faces = row?.querySelectorAll('.home-face-avatar');
  const lastFace = faces?.[faces.length - 1];
  if (!lastFace || !replay || !window.matchMedia) return;

  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let observer = null;

  const stopObserving = () => {
    observer?.disconnect();
    observer = null;
  };

  const play = () => {
    if (motion.matches) return;
    stopObserving();
    row.style.setProperty('--glide-w', `${row.clientWidth}px`);
    row.classList.remove('is-gliding');
    void row.offsetWidth; // Give a replay a fresh timeline, even mid-flight.
    row.classList.add('is-gliding');
  };

  const updateMotion = () => {
    replay.hidden = motion.matches;
    if (motion.matches) {
      delete row.dataset.glideReady;
      row.classList.remove('is-gliding');
      stopObserving();
    } else {
      row.dataset.glideReady = '';
    }
  };

  // The plane lands before the last face finishes lighting up.
  lastFace.addEventListener('animationend', event => {
    if (event.animationName === 'home-face-light') row.classList.remove('is-gliding');
  });
  row.addEventListener('click', play);
  replay.addEventListener('click', play);
  if (motion.addEventListener) motion.addEventListener('change', updateMotion);
  else if (motion.addListener) motion.addListener(updateMotion);
  updateMotion();

  if (!motion.matches && 'IntersectionObserver' in window) {
    observer = new IntersectionObserver(entries => {
      if (observer && entries.some(entry => entry.isIntersecting && entry.intersectionRatio >= 0.8)) play();
    }, { threshold: 0.8 });
    observer.observe(row);
  }
})();
