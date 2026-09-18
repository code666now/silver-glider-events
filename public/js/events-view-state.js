(function exposeEventsViewState(root, factory) {
  const helpers = factory();
  if (typeof module === 'object' && module.exports) module.exports = helpers;
  if (root) root.SGEventsViewState = helpers;
})(typeof window !== 'undefined' ? window : globalThis, function createEventsViewState() {
  const VALID_VIEWS = new Set(['going', 'hosting']);

  function normalizeView(value) {
    return VALID_VIEWS.has(value) ? value : null;
  }

  function resolveInitialView(requestedView, rememberedView) {
    return normalizeView(requestedView) || normalizeView(rememberedView) || 'going';
  }

  function localDateKey(date = new Date()) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }

  function eventDateKey(value) {
    const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
    return match ? `${match[1]}-${match[2]}-${match[3]}` : '';
  }

  function isUpcomingEventDate(value, todayKey = localDateKey()) {
    const key = eventDateKey(value);
    return Boolean(key) && key >= todayKey;
  }

  return { normalizeView, resolveInitialView, localDateKey, eventDateKey, isUpcomingEventDate };
});
