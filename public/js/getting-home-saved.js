(function (factory) {
  const saved = factory();
  if (typeof module === 'object' && module.exports) module.exports = saved;
  else saved.mount(document.querySelector('[data-getting-home]'), window);
})(function () {
  'use strict';

  const id = value => typeof value === 'string' && /^[\p{L}\p{N}_.:/-]{1,100}$/u.test(value);
  const knownStates = new Set(['available', 'none', 'not-applicable', 'unavailable', 'not-eligible']);

  function readSelection(selection) {
    if (!selection || typeof selection !== 'object' || Array.isArray(selection)) return null;
    const { stationId, destinationStationId, stopId, routeId, direction, headsign } = selection;
    if (stationId !== undefined || destinationStationId !== undefined) {
      return id(stationId) && id(destinationStationId) && stationId !== destinationStationId ? { stationId, destinationStationId } : null;
    }
    return id(stopId) && id(routeId) && ['', '0', '1'].includes(direction) && typeof headsign === 'string' &&
      headsign.length <= 160 && !/[\x00-\x1f\x7f]/.test(headsign) ? { stopId, routeId, direction, headsign } : null;
  }

  function savePayload(detail, remember) {
    if (remember !== true || !['scheduled', 'overnight'].includes(detail?.plan?.status)) return null;
    const selection = readSelection(detail?.selection);
    // A preference is not a text consent or a scheduled itinerary. Store only
    // the verified route choice; the server will check this night's service.
    return selection ? { remember: true, selection } : null;
  }

  function savedTitle(label) {
    if (typeof label !== 'string' || !label.trim()) return 'Your saved route';
    return `Taking ${/^(?:Muni\b|BART\b)/i.test(label) ? '' : 'the '}${label} again?`;
  }

  function mount(root, win) {
    if (!root) return;
    const slug = /^\/e\/([a-z0-9-]{1,120})\/getting-home\/?$/i.exec(win.location.pathname)?.[1];
    if (!slug) return;
    const api = `/api/public/events/${slug}/getting-home/saved-route`;
    const get = id => root.querySelector(`#gh-${id}`);
    const panel = get('saved');
    const title = get('saved-title');
    const details = get('saved-details');
    const use = get('saved-use');
    const change = get('saved-change');
    const remove = get('saved-remove');
    const offer = get('remember');
    const check = get('remember-check');
    const save = get('remember-save');
    const status = get('saved-status');
    if (![panel, title, details, use, change, remove, offer, check, save, status].every(Boolean)) return;

    let preference = { status: 'unavailable' };
    let detail = null;
    let busy = false;
    check.checked = false;
    const tell = message => { status.textContent = message; };

    function render() {
      const saved = preference.status === 'available' ? readSelection(preference.selection) : null;
      const known = saved || (preference.hasPreference === true && ['not-applicable', 'unavailable'].includes(preference.status));
      const draft = savePayload(detail, true)?.selection;
      const canRemember = Boolean(draft && ['available', 'none', 'not-applicable'].includes(preference.status) &&
        JSON.stringify(draft) !== JSON.stringify(saved));
      panel.hidden = !known;
      title.textContent = saved ? savedTitle(preference.routeLabel) : 'Your saved route';
      details.textContent = saved ? [preference.stopLabel, preference.directionLabel].filter(value => typeof value === 'string' && value).join(' · ')
        : preference.status === 'unavailable' ? 'We couldn’t check this saved route right now.' : 'This saved route doesn’t serve this event.';
      use.hidden = !saved;
      change.hidden = !saved;
      remove.hidden = !known;
      use.disabled = busy;
      change.disabled = busy;
      remove.disabled = busy;
      offer.hidden = !canRemember;
      check.disabled = busy;
      save.disabled = busy || !canRemember || !check.checked;
    }

    async function read() {
      const response = await win.fetch(api, { credentials: 'same-origin', cache: 'no-store' });
      const result = await response.json();
      if (result && knownStates.has(result.status)) {
        preference = result;
        render();
      }
    }

    async function update(method, body) {
      if (busy) return;
      busy = true;
      render();
      tell(method === 'POST' ? 'Saving your route…' : 'Removing your saved route…');
      try {
        const response = await win.fetch(api, {
          method, credentials: 'same-origin', cache: 'no-store',
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
        });
        const result = await response.json();
        if (method === 'POST' && response.ok && result?.status === 'available' && readSelection(result.selection)) {
          preference = result;
          check.checked = false;
          render();
          tell('Route saved. This did not schedule a text.');
          title.focus();
        } else if (method === 'DELETE' && response.ok && result?.status === 'removed') {
          preference = { status: 'none' };
          check.checked = false;
          render();
          tell('Saved route removed. Any ride text already set is unchanged.');
          if (!get('results')?.hidden) get('results-title')?.focus();
          else get('routes-title')?.focus();
        } else {
          await read().catch(() => {});
          tell(method === 'POST' && result?.status === 'not-applicable'
            ? 'This route is no longer available to save. Check the schedule again.'
            : 'We couldn’t confirm the change to your saved route. Try again.');
        }
      } catch {
        await read().catch(() => {});
        tell('We couldn’t confirm the change to your saved route. Try again.');
      } finally {
        busy = false;
        render();
      }
    }

    root.addEventListener('getting-home:plan', event => {
      detail = event.detail || null;
      check.checked = false;
      if (!busy) tell('');
      render();
    });
    use.addEventListener('click', () => {
      const selection = preference.status === 'available' && readSelection(preference.selection);
      if (selection && !busy) root.dispatchEvent(new win.CustomEvent('getting-home:choose-saved', { detail: selection }));
    });
    change.addEventListener('click', () => {
      if (busy) return;
      const changePlan = get('change');
      if (changePlan && !get('plan')?.hidden) changePlan.click();
      get('routes-title')?.focus();
    });
    remove.addEventListener('click', () => {
      if (!remove.hidden) update('DELETE', {});
    });
    check.addEventListener('change', render);
    save.addEventListener('click', () => {
      const payload = savePayload(detail, check.checked);
      if (payload && !offer.hidden) update('POST', payload);
    });

    render();
    read().catch(() => {}); // Saved preferences never block the transit planner.
  }

  return { mount, savePayload, savedTitle };
});
