(function initEventBackgrounds(root, factory) {
  const backgrounds = factory();
  if (typeof module === 'object' && module.exports) module.exports = backgrounds;
  if (root) root.SGEventBackgrounds = backgrounds;
})(typeof window !== 'undefined' ? window : null, function createEventBackgrounds() {
  const options = Object.freeze([
    Object.freeze({ key: 'adaptive', label: 'Match Photo', flyerLabel: 'Match Flyer', group: 'background' }),
    Object.freeze({ key: 'midnight', label: 'Midnight', group: 'background' }),
    Object.freeze({ key: 'aurora', label: 'Aurora', group: 'background' }),
    Object.freeze({ key: 'sunset', label: 'Sunset', group: 'background' }),
    Object.freeze({ key: 'ocean', label: 'Ocean', group: 'background' }),
    Object.freeze({ key: 'plaster', label: 'Plaster', group: 'background', thumbnail: '/images/flyer-plaster-wall.webp' }),
    Object.freeze({ key: 'halloween', label: 'Halloween', group: 'effect', thumbnail: 'https://res.cloudinary.com/dhvavjgnw/video/upload/so_0,f_jpg,q_auto,w_320/sg-events/effects/halloween.jpg' }),
    Object.freeze({ key: 'last-guest', label: 'The Last Guest', group: 'effect', thumbnail: 'https://res.cloudinary.com/dhvavjgnw/video/upload/so_0,f_jpg,q_auto,w_320/sg-events/effects/the-last-guest.jpg' }),
    Object.freeze({ key: 'disco', label: 'Disco', group: 'effect', thumbnail: 'https://res.cloudinary.com/dhvavjgnw/video/upload/so_0,f_jpg,q_auto,w_320/sg-events/effects/disco.jpg' }),
    Object.freeze({ key: 'fog', label: 'Fog', group: 'effect', thumbnail: 'https://res.cloudinary.com/dhvavjgnw/video/upload/so_0,f_jpg,q_auto,w_320/sg-events/effects/fog.jpg' }),
    Object.freeze({ key: 'paper', label: 'Kraft paper', group: 'effect', thumbnail: 'https://res.cloudinary.com/dhvavjgnw/image/upload/f_auto,q_auto,w_320/sg-events/textures/kraft-paper.jpg' }),
    Object.freeze({ key: 'static', label: 'TV static', group: 'effect' }),
    Object.freeze({ key: 'liquid-stardust', label: 'Liquid Stardust', group: 'effect', thumbnail: 'https://res.cloudinary.com/dhvavjgnw/video/upload/so_0,f_jpg,q_auto,w_320/sg-events/effects/liquid-stardust.jpg' }),
    Object.freeze({ key: 'color-static', label: 'Color Static', group: 'effect', thumbnail: 'https://res.cloudinary.com/dhvavjgnw/video/upload/so_0,f_jpg,q_auto,w_320/sg-events/effects/color-static.jpg' }),
    Object.freeze({ key: 'saloon', label: 'After Hours Saloon', group: 'effect', thumbnail: 'https://res.cloudinary.com/dhvavjgnw/image/upload/f_auto,q_auto,w_320/sg-events/backgrounds/after-hours-saloon.png' }),
    Object.freeze({ key: 'golden-tide', label: 'Golden Tide', group: 'effect', thumbnail: 'https://res.cloudinary.com/dhvavjgnw/video/upload/so_0,f_jpg,q_auto,w_320/sg-events/effects/golden-tide.jpg' }),
    Object.freeze({ key: 'rain-on-glass', label: 'Rain on Glass', group: 'effect', thumbnail: 'https://res.cloudinary.com/dhvavjgnw/video/upload/so_0,f_jpg,q_auto,w_320/sg-events/effects/rain-on-glass-v1.jpg' }),
    Object.freeze({ key: 'gather-and-glow', label: 'Gather & Glow', group: 'effect', thumbnail: 'https://res.cloudinary.com/dhvavjgnw/video/upload/so_0,f_jpg,q_auto,w_320/sg-events/effects/gather-and-glow-v1.jpg' }),
    Object.freeze({ key: 'candlelit-christmas', label: 'Candlelit Christmas', group: 'effect', thumbnail: 'https://res.cloudinary.com/dhvavjgnw/video/upload/so_0,f_jpg,q_auto,w_320/sg-events/effects/candlelit-christmas-v1.jpg' }),
    Object.freeze({ key: 'snow-day', label: 'Snow Day', group: 'effect', thumbnail: 'https://res.cloudinary.com/dhvavjgnw/video/upload/so_0,f_jpg,q_auto,w_320/sg-events/effects/snow-day-v1.jpg' }),
    Object.freeze({ key: 'midnight-toast', label: 'Midnight Toast', group: 'effect', thumbnail: 'https://res.cloudinary.com/dhvavjgnw/video/upload/so_0,f_jpg,q_auto,w_320/sg-events/effects/midnight-toast-v1.jpg' }),
    Object.freeze({ key: 'starlit-celebration', label: 'Starlit Celebration', group: 'effect', thumbnail: 'https://res.cloudinary.com/dhvavjgnw/video/upload/so_0,f_jpg,q_auto,w_320/sg-events/effects/starlit-celebration-v1.jpg' })
  ]);
  const byKey = new Map(options.map(option => [option.key, option]));
  const keys = Object.freeze(options.map(option => option.key));
  const backgroundKeys = Object.freeze(options.filter(option => option.group === 'background').map(option => option.key));
  const effectKeys = Object.freeze(options.filter(option => option.group === 'effect').map(option => option.key));

  function label(key, presentationMode = 'standard') {
    const option = byKey.get(key);
    if (!option) return key;
    return presentationMode === 'flyer' && option.flyerLabel ? option.flyerLabel : option.label;
  }

  return Object.freeze({ options, keys, backgroundKeys, effectKeys, label });
});
