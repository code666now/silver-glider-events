(() => {
  const controllers = new WeakMap();

  function attach(video, { fadeMs = 900, leadSeconds = 1.15 } = {}) {
    if (!video) return null;
    if (controllers.has(video)) return controllers.get(video);

    const standby = video.cloneNode(true);
    video.loop = false;
    standby.loop = false;
    standby.autoplay = false;
    standby.removeAttribute('autoplay');
    standby.muted = true;
    standby.defaultMuted = true;
    standby.classList.remove('is-playing');
    video.classList.add('is-seamless-loop', 'is-seamless-active');
    standby.classList.add('is-seamless-loop');
    standby.dataset.seamlessClone = 'true';
    video.after(standby);

    let active = video;
    let next = standby;
    let switching = false;
    let destroyed = false;
    let animationFrame = 0;
    let transitionTimer = 0;

    const reveal = media => media.classList.add('is-playing');

    async function crossfade() {
      if (switching || destroyed || document.hidden || active.paused) return;
      switching = true;
      next.currentTime = 0;
      try {
        await next.play();
        if (destroyed) return;
        reveal(next);
        requestAnimationFrame(() => {
          if (destroyed) return;
          next.classList.add('is-seamless-active');
          active.classList.remove('is-seamless-active');
        });
        transitionTimer = window.setTimeout(() => {
          const previous = active;
          active = next;
          next = previous;
          next.pause();
          next.currentTime = 0;
          next.classList.remove('is-playing');
          switching = false;
        }, fadeMs);
      } catch (_) {
        active.loop = true;
        switching = false;
      }
    }

    function monitor() {
      if (destroyed) return;
      if (!video.isConnected && !standby.isConnected) {
        destroy();
        return;
      }
      const remaining = active.duration - active.currentTime;
      if (!active.paused && Number.isFinite(remaining) && remaining <= leadSeconds) crossfade();
      animationFrame = requestAnimationFrame(monitor);
    }

    async function play() {
      active.loop = false;
      const result = active.play();
      await result;
      reveal(active);
      if (!animationFrame) animationFrame = requestAnimationFrame(monitor);
      return result;
    }

    function pause() {
      video.pause();
      standby.pause();
    }

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      window.clearTimeout(transitionTimer);
      cancelAnimationFrame(animationFrame);
      standby.remove();
      controllers.delete(video);
      controllers.delete(standby);
    }

    const controller = { play, pause, destroy };
    controllers.set(video, controller);
    controllers.set(standby, controller);
    return controller;
  }

  window.SGSeamlessVideoLoop = { attach };
})();
