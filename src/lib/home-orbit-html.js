'use strict';

const { esc } = require('./public-html');

function renderHomeOrbit(template, photos, { flyerIntake = false } = {}) {
  const active = photos.filter(photo => photo.active === true && photo.imageUrl &&
    Number.isSafeInteger(photo.width) && Number.isSafeInteger(photo.height) && photo.width > 0 && photo.height > 0);
  const cards = active.map((photo, index) => {
    const name = esc(photo.title);
    const details = photo.credit ? `${name} · ${esc(photo.credit)}` : name;
    return `<button type="button" class="home-orbit-photo" data-orbit-ratio="${(photo.width / photo.height).toFixed(5)}" aria-label="Spin photo wheel — ${name}" aria-description="${esc(photo.altText)}" title="${details}" disabled><img src="${esc(photo.imageUrl)}" width="${photo.width}" height="${photo.height}" alt="${esc(photo.altText)}" draggable="false" decoding="async"${index === 0 ? ' fetchpriority="high"' : ''}><span class="home-orbit-photo-label" aria-hidden="true">${name}</span></button>`;
  }).join('');
  const credits = active.filter(photo => photo.credit).map(photo => `<li>${esc(photo.title)} — ${esc(photo.credit)}</li>`).join('');
  return template.replace('{{HOME_ORBIT_CTA_HREF}}', flyerIntake ? '/flyer' : '/login?next=%2Fevents%2Fnew')
    .replace('{{HOME_ORBIT_CTA_LABEL}}', flyerIntake ? 'Send us your flyer' : 'Create your event')
    .replace('<!-- HOME_ORBIT_PHOTOS -->', () => cards)
    .replace('<!-- HOME_ORBIT_CREDITS -->', () => credits);
}

module.exports = { renderHomeOrbit };
