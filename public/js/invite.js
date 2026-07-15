const video = document.getElementById('invite-fog');
const motionPreference = matchMedia('(prefers-reduced-motion: reduce)');
const saveData = navigator.connection && navigator.connection.saveData;

if (video && !motionPreference.matches && !saveData) {
  video.muted = true;
  video.defaultMuted = true;
  const reveal = () => video.classList.add('is-playing');
  const attemptPlay = () => video.play().then(reveal).catch(() => {});
  video.addEventListener('playing', reveal);
  video.addEventListener('loadeddata', () => { if (!video.paused) reveal(); });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) video.pause();
    else attemptPlay();
  });
  document.addEventListener('pointerdown', attemptPlay, { once: true, passive: true });
  document.addEventListener('touchstart', attemptPlay, { once: true, passive: true });
  attemptPlay();
} else if (video) {
  video.pause();
  video.removeAttribute('autoplay');
}

const interestButton = document.getElementById('spanish-interest');
const response = document.getElementById('interest-response');
interestButton.addEventListener('click', () => {
  response.hidden = false;
  interestButton.setAttribute('aria-expanded', 'true');
  interestButton.textContent = interestButton.dataset.successLabel;
  interestButton.disabled = true;
  response.focus();
});
