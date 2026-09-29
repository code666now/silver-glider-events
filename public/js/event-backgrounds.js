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
    Object.freeze({ key: 'plaster', label: 'Plaster', group: 'background' }),
    Object.freeze({ key: 'halloween', label: 'Halloween', group: 'effect' }),
    Object.freeze({ key: 'last-guest', label: 'The Last Guest', group: 'effect' }),
    Object.freeze({ key: 'disco', label: 'Disco', group: 'effect' }),
    Object.freeze({ key: 'fog', label: 'Fog', group: 'effect' }),
    Object.freeze({ key: 'paper', label: 'Kraft paper', group: 'effect' }),
    Object.freeze({ key: 'static', label: 'TV static', group: 'effect' }),
    Object.freeze({ key: 'liquid-stardust', label: 'Liquid Stardust', group: 'effect' }),
    Object.freeze({ key: 'color-static', label: 'Color Static', group: 'effect' }),
    Object.freeze({ key: 'saloon', label: 'After Hours Saloon', group: 'effect' })
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
