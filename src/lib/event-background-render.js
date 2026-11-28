'use strict';

const EventBackgrounds = require('../../public/js/event-backgrounds');

// Violet and ember are legacy-only: hidden from the MVP picker, but still
// rendered for already-published events that selected them.
const THEMES = [...EventBackgrounds.backgroundKeys, 'violet', 'ember'];
const EFFECTS = EventBackgrounds.effectKeys;
const VIDEO_EFFECTS = {
  halloween: 'sg-events/effects/halloween',
  'liquid-stardust': 'sg-events/effects/liquid-stardust',
  'color-static': 'sg-events/effects/color-static',
  'last-guest': 'sg-events/effects/the-last-guest',
  'golden-tide': 'sg-events/effects/golden-tide',
  'rain-on-glass': 'sg-events/effects/rain-on-glass-v1',
  'gather-and-glow': 'sg-events/effects/gather-and-glow-v1',
  'candlelit-christmas': 'sg-events/effects/candlelit-christmas-v1',
  'snow-day': 'sg-events/effects/snow-day-v1',
  'midnight-toast': 'sg-events/effects/midnight-toast-v1',
  'starlit-celebration': 'sg-events/effects/starlit-celebration-v1',
  disco: 'sg-events/effects/disco',
  fog: 'sg-events/effects/fog'
};

function renderEventBackground(chosen) {
  const isEffect = EFFECTS.includes(chosen);
  const theme = (THEMES.includes(chosen) || isEffect) ? chosen : 'midnight';
  const bgClass = isEffect ? `fx-${theme}` : `bg-${theme}`;
  const videoPublicId = VIDEO_EFFECTS[theme];
  // Keep the long source clip intact in storage; deliver a compact ambient loop.
  const videoTrim = ['golden-tide', 'rain-on-glass', 'gather-and-glow', 'candlelit-christmas', 'snow-day', 'midnight-toast', 'starlit-celebration'].includes(theme) ? 'du_20,' : '';
  const fxMedia = videoPublicId
    ? `<video class="fx-video-media" data-effect-theme="${theme}" autoplay muted loop playsinline webkit-playsinline preload="auto" poster="https://res.cloudinary.com/dhvavjgnw/video/upload/so_0,f_jpg,q_auto,w_1600/${videoPublicId}.jpg" aria-hidden="true" tabindex="-1"><source media="(max-width: 900px)" src="https://res.cloudinary.com/dhvavjgnw/video/upload/${videoTrim}f_mp4,vc_h264,q_auto:eco,w_800,c_limit,fl_progressive/${videoPublicId}.mp4" type="video/mp4"><source src="https://res.cloudinary.com/dhvavjgnw/video/upload/${videoTrim}f_mp4,vc_h264,q_auto:eco,w_1280,c_limit,fl_progressive/${videoPublicId}.mp4" type="video/mp4"></video>`
    : '';
  // Effects sit behind everything and need a darkening veil for legibility
  const fxVeil = `<div id="event-fx-veil" class="fx-veil${theme === 'paper' ? ' fx-veil-soft' : ''}${theme === 'saloon' ? ' fx-veil-warm' : ''}" aria-hidden="true"${isEffect ? '' : ' hidden'}></div>`;
  return { theme, isEffect, bgClass, fxMedia, fxVeil, bgEffect: isEffect ? theme : null };
}

module.exports = { renderEventBackground };
