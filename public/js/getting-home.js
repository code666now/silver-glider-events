(function (factory) {
  const app = factory();
  if (typeof module === 'object' && module.exports) module.exports = app;
  else app.mount(document.querySelector('[data-getting-home]'), window);
})(function () {
  'use strict';

  const knownTimes = seconds => Number.isFinite(seconds) && seconds > 0;
  const walkLabel = seconds => knownTimes(seconds) ? `~${Math.ceil(seconds / 60)} min walk` : '';
  const rank = seconds => knownTimes(seconds) ? seconds : Infinity;
  const orderedStops = stops => [...stops].sort((a, b) => rank(a.walkSeconds) - rank(b.walkSeconds));

  function makeRouteChoices(stops) {
    const grouped = new Map();
    for (const stop of orderedStops(Array.isArray(stops) ? stops : [])) {
      if (!stop.stopId || !stop.name || !Array.isArray(stop.routes)) continue;
      for (const route of stop.routes) {
        if (!route.routeId) continue;
        const bart = Boolean(route.requiresDestination && stop.stationId);
        const key = bart ? `bart:${stop.stationId}` : `route:${route.routeId}`;
        const muni = /\bmuni\b|san francisco municipal/i.test(route.agency || '');
        if (!grouped.has(key)) grouped.set(key, {
          key, label: bart ? 'BART' : muni ? `Muni ${route.name}` : route.name || 'Transit',
          icon: bart || route.mode === 'rail' || (muni && /^[A-Z](?:\s|$)/.test(route.name)) ? 'train' : 'bus',
          bart, bus: !bart && route.mode === 'bus', closest: stop,
          directions: new Map(), stations: [], destinations: Array.isArray(stop.destinations) ? stop.destinations : []
        });
        const group = grouped.get(key);
        if (bart) {
          // BART last-train search checks all lines and platforms at the station.
          if (!group.stations.some(station => station.stationId === stop.stationId)) group.stations.push(stop);
          continue;
        }
        const directionKey = JSON.stringify([route.direction, route.headsign]);
        if (!group.directions.has(directionKey)) group.directions.set(directionKey, {
          label: route.headsign || (route.direction ? `Direction ${route.direction}` : 'Scheduled direction'),
          stops: []
        });
        const direction = group.directions.get(directionKey);
        if (!direction.stops.some(entry => entry.stopId === stop.stopId)) direction.stops.push({ ...stop, route });
      }
    }
    return [...grouped.values()].map(group => ({ ...group, directions: [...group.directions.values()] }));
  }

  function formattedTime(epochMs, timeZone) {
    if (!Number.isFinite(epochMs) || !timeZone) return '';
    try {
      const date = new Date(epochMs);
      const day = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', month: 'short', day: 'numeric' }).format(date);
      const clock = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(date);
      return `${day} · ${clock}`;
    } catch {
      return '';
    }
  }

  function matchSavedChoice(choices, selection) {
    if (!selection) return null;
    for (const choice of choices) {
      if (choice.bart && selection.stationId) {
        const stop = choice.stations.findIndex(station => station.stationId === selection.stationId);
        const destination = choice.destinations.findIndex(station => station.stationId === selection.destinationStationId);
        if (stop !== -1 && destination !== -1) return { choice, stop, destination };
      }
      if (choice.bart || selection.stationId) continue;
      for (const [direction, row] of choice.directions.entries()) {
        const stop = row.stops.findIndex(s => s.stopId === selection.stopId && s.route.routeId === selection.routeId &&
          (s.route.direction || '') === selection.direction && (s.route.headsign || '') === selection.headsign);
        if (stop !== -1) return { choice, direction, stop };
      }
    }
    return null;
  }

  function makeRideshareLinks(destination) {
    const uber = new URL('https://m.uber.com/looking');
    const lyft = new URL('https://ride.lyft.com/u');
    const { latitude, longitude, name } = destination || {};
    const prefilled = Number.isFinite(latitude) && Math.abs(latitude) <= 90 &&
      Number.isFinite(longitude) && Math.abs(longitude) <= 180 && typeof name === 'string' && Boolean(name.trim());
    if (prefilled) {
      uber.searchParams.set('pickup', 'my_location');
      uber.searchParams.set('drop[0]', JSON.stringify({ latitude, longitude, addressLine1: name }));
      lyft.searchParams.set('id', 'lyft');
      lyft.searchParams.set('destination[latitude]', latitude);
      lyft.searchParams.set('destination[longitude]', longitude);
    }
    return { uber: uber.href, lyft: lyft.href, prefilled };
  }

  function createEmailVisitTracker(document, track) {
    let queued = false;
    return options => {
      if (queued || options?.status !== 'available' || options.emailEntry !== true) return;
      queued = true;
      // A redirect alone isn't a visit. Don't count a hidden prerender.
      const recordWhenVisible = () => {
        if (document.visibilityState !== 'visible') return;
        document.removeEventListener('visibilitychange', recordWhenVisible);
        track('email_link_open');
      };
      document.addEventListener('visibilitychange', recordWhenVisible);
      recordWhenVisible();
    };
  }

  function mount(root, win) {
    if (!root) return;
    const get = key => root.querySelector(`#gh-${key}`);
    const rawSlug = /^\/e\/([^/]+)\/getting-home\/?$/.exec(win.location.pathname)?.[1];
    if (!rawSlug) return;
    let slug;
    try { slug = encodeURIComponent(decodeURIComponent(rawSlug)); } catch { return; }
    const api = `/api/public/events/${slug}/getting-home`;
    const eventPath = `/e/${slug}`;
    const routeList = get('routes');
    const picker = get('route-picker');
    const plan = get('plan');
    const retry = get('retry');
    const status = get('status');
    const resultStatus = get('result-status');
    const direction = get('direction');
    const stop = get('stop');
    const destination = get('destination');
    const form = get('form');
    const check = get('check');
    let active = null;
    let activeButton = null;
    let lookup = null;
    let loading = false;
    let routeChoices = [];
    let queuedSelection = null;
    const routeButtons = new Map();

    const pilotPreview = slug === 'make-out-room-schedule-preview';
    const preview = pilotPreview || slug === 'san-francisco-schedule-preview';
    const submittedInteractions = new Set();
    function trackInteraction(kind) {
      if (preview || submittedInteractions.has(kind)) return;
      submittedInteractions.add(kind);
      // A tracked link still opens normally even if this best-effort request fails.
      Promise.resolve().then(() => win.fetch(`${api}/interaction`, {
        method: 'POST', credentials: 'same-origin', keepalive: true,
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind })
      })).then(response => { if (!response.ok) submittedInteractions.delete(kind); })
        .catch(() => submittedInteractions.delete(kind));
    }
    const trackEmailVisit = createEmailVisitTracker(win.document, trackInteraction);

    for (const provider of ['uber', 'lyft']) {
      get(provider).addEventListener('click', () => trackInteraction(`${provider}_click`));
      get(provider).addEventListener('auxclick', event => { if (event.button === 1) trackInteraction(`${provider}_click`); });
    }
    get('event-link').href = preview ? '/' : eventPath;
    get('directions').href = !preview ? `${eventPath}#event-location-map` : pilotPreview
      ? 'https://maps.google.com/?q=Make-Out%20Room%2C%203225%2022nd%20St%2C%20San%20Francisco%2C%20CA'
      : 'https://maps.google.com/?q=San%20Francisco%2C%20CA';
    if (preview) {
      get('event-link').querySelector('span').textContent = 'Silver Glider Events';
      get('preview-label').hidden = false;
      get('preview-label').textContent = 'Test preview · Sample show, no RSVP or texts.';
    }

    function clearResult() {
      lookup?.abort();
      lookup = null;
      get('results').hidden = true;
      get('upcoming').hidden = true;
      get('last-next').hidden = true;
      resultStatus.textContent = '';
      check.removeAttribute('aria-disabled');
      form.removeAttribute('aria-busy');
      root.dispatchEvent(new win.CustomEvent('getting-home:plan', { detail: null }));
    }

    function fillSelect(select, rows, label, placeholder) {
      const fragment = win.document.createDocumentFragment();
      if (placeholder) {
        const option = new win.Option(placeholder, '', true, true);
        option.disabled = true;
        fragment.append(option);
      }
      rows.forEach((row, index) => fragment.append(new win.Option(label(row), String(index))));
      select.replaceChildren(fragment);
      select.required = true;
    }

    function showStops() {
      const choices = active?.bart ? active.stations : active?.directions[direction.value]?.stops || [];
      fillSelect(stop, choices, choice => [choice.name, walkLabel(choice.walkSeconds)].filter(Boolean).join(' · '));
    }

    function showRideshare() {
      const station = active?.bart && destination.value !== '' && active.destinations[destination.value];
      const links = makeRideshareLinks(station);
      get('uber').href = links.uber;
      get('lyft').href = links.lyft;
      get('rideshare-note').textContent = links.prefilled
        ? `We’ll pass ${station.name} as the destination. Confirm it with the provider before requesting a ride.`
        : 'Choose your pickup and destination with the provider.';
    }

    function showPlan(route, button) {
      active = route;
      activeButton = button;
      clearResult();
      get('plan-title').textContent = route.label;
      check.textContent = route.bart ? 'Check last departure' : 'Check departures';
      get('direction-field').hidden = route.bart;
      direction.disabled = route.bart;
      get('destination-field').hidden = !route.bart;
      destination.disabled = !route.bart;
      get('stop-label').textContent = route.bart ? 'Boarding station' : 'Boarding stop';
      fillSelect(direction, route.directions, item => item.label, route.directions.length > 1 ? 'Choose a direction' : null);
      fillSelect(destination, route.destinations, item => item.name, route.bart ? 'Choose a destination station' : null);
      if (!route.bart && route.directions.length > 1) {
        stop.disabled = true;
        fillSelect(stop, [], () => '', 'Choose a direction first');
      } else {
        stop.disabled = false;
        showStops();
      }
      picker.hidden = true;
      plan.hidden = false;
      showRideshare();
      if (route.bart && route.destinations.length === 0) resultStatus.textContent = 'Destination stations are unavailable. Check the transit provider for a connection.';
      get('plan-title').focus();
    }

    function selectedRoute() {
      if (!active || stop.value === '') return null;
      if (active.bart) {
        const board = active.stations[stop.value];
        const arrival = destination.value === '' ? null : active.destinations[destination.value];
        return board && arrival ? { stationId: board.stationId, destinationStationId: arrival.stationId } : null;
      }
      const board = active.directions[direction.value]?.stops[stop.value];
      return board ? { stopId: board.stopId, routeId: board.route.routeId, direction: board.route.direction || '', headsign: board.route.headsign || '' } : null;
    }

    function showUpcoming({ upcoming, timezone, leaveByPassed }) {
      if (!upcoming) return;
      const { context, includesLast, departures } = upcoming;
      const times = departures.map(ride => {
        const label = formattedTime(ride.departureAt, timezone);
        return label && (ride.timing === 'feed-estimate' ? `${label} · Estimated` : label);
      }).filter(Boolean);
      if (includesLast && !times.length) {
        get('last-next').textContent = context === 'after-show' ? 'Also the next reachable departure after the show.' : 'Also the next reachable departure.';
        get('last-next').hidden = false;
        return;
      }
      // The missed leave-by note already explains why there are no earlier rides.
      if (!times.length && leaveByPassed) return;
      const title = context === 'after-show' ? 'Next after the show'
        : context === 'from-show-start' ? 'Next scheduled from show start' : 'Next if you leave now';
      const list = get('upcoming-times');
      list.replaceChildren(...times.map(label => {
        const item = win.document.createElement('li');
        item.textContent = label;
        return item;
      }));
      list.hidden = !times.length;
      get('upcoming-title').textContent = title;
      get('upcoming-note').textContent = !times.length ? 'No reachable scheduled departures found for this time.'
        : includesLast ? 'Scheduled, not live. The last departure above comes next.' : 'Scheduled, not live.';
      get('upcoming').hidden = false;
    }

    function showResult(data, selection) {
      const messages = {
        overnight: 'This route runs overnight. There isn’t one last ride for this selection. Check the operator’s live schedule before you leave.',
        'no-service': 'No scheduled late ride was found for this stop and direction. Try another route or check the operator.',
        'destination-required': 'Choose a BART destination to check the last connection.',
        'invalid-destination': 'Choose a different BART destination station.',
        'unsupported-selection': 'This route choice is no longer available. Choose another stop or route.',
        'unsupported-event': 'Getting Home is unavailable for this event.'
      };
      if (data.status !== 'scheduled') {
        resultStatus.textContent = messages[data.status] || 'We couldn’t verify a departure. Check the operator directly before travelling.';
        if (data.status === 'overnight') {
          showUpcoming(data);
          root.dispatchEvent(new win.CustomEvent('getting-home:plan', { detail: { selection, plan: data } }));
        }
        return;
      }
      const departure = formattedTime(data.departureAt, data.timezone);
      if (!departure) {
        resultStatus.textContent = 'We couldn’t verify a departure. Check the operator directly before travelling.';
        return;
      }
      const leave = formattedTime(data.leaveByAt, data.timezone);
      const preview = formattedTime(data.proposedReminderAt, data.timezone);
      get('departure-label').textContent = data.timing === 'feed-estimate' ? 'Estimated last scheduled departure' : 'Last scheduled departure';
      get('departure-time').textContent = departure;
      get('boarding-stop').textContent = data.stopName ? `From ${data.stopName}. Scheduled, not live.` : 'Scheduled, not live.';
      get('leave-row').hidden = !leave;
      get('leave-time').textContent = leave;
      get('walk-helper').textContent = [walkLabel(data.walkSeconds), 'includes extra time to board'].filter(Boolean).join(' · ');
      get('preview-row').hidden = !preview;
      get('text-time').textContent = preview;
      get('show-warning').hidden = !data.departsBeforeEventEnds;
      get('leave-passed').hidden = !data.leaveByPassed;
      showUpcoming(data);
      get('results').hidden = false;
      get('results-title').focus();
      root.dispatchEvent(new win.CustomEvent('getting-home:plan', { detail: { selection, plan: data } }));
    }

    async function loadRoutes() {
      if (loading) return;
      loading = true;
      status.textContent = 'Checking nearby transit…';
      retry.hidden = true;
      try {
        const response = await win.fetch(`${api}/options`, { credentials: 'same-origin', cache: 'no-store' });
        const data = await response.json();
        if (preview && /^\d{4}-\d{2}-\d{2}$/.test(data.previewDate || '')) {
          const previewDay = new Date(`${data.previewDate}T12:00:00Z`);
          if (Number.isFinite(previewDay.getTime())) {
            const day = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }).format(previewDay);
            get('preview-label').textContent = `Test preview · Sample show on ${day}. No RSVP or texts.`;
          }
        }
        if (response.status === 404 || data.status === 'unsupported-event') {
          status.textContent = 'Getting Home is unavailable for this event.';
          return;
        }
        if (!response.ok || !['available', 'empty'].includes(data.status)) throw new Error('Schedule unavailable');
        get('walking-source').hidden = !data.walkingAttribution;
        routeChoices = makeRouteChoices(data.stops);
        get('venue').textContent = data.venue ? `From ${data.venue}` : '';
        get('venue').hidden = !data.venue;
        if (routeChoices.length === 0) {
          status.textContent = 'No nearby transit routes were verified for this event. You can still get directions or look for a ride.';
          return;
        }
        const fragment = win.document.createDocumentFragment();
        const template = get('route-template');
        routeButtons.clear();
        for (const choice of routeChoices) {
          const item = template.content.cloneNode(true);
          const button = item.querySelector('button');
          button.querySelector('strong').textContent = choice.label;
          button.querySelector('.gh-route-copy span').textContent = [choice.closest.name, walkLabel(choice.closest.walkSeconds)].filter(Boolean).join(' · ');
          button.querySelector('use').setAttribute('href', `#gh-icon-${choice.icon}`);
          button.addEventListener('click', () => {
            if (choice.bus) trackInteraction('bus_click');
            showPlan(choice, button);
          });
          routeButtons.set(choice, button);
          fragment.append(item);
        }
        routeList.replaceChildren(fragment);
        picker.hidden = false;
        status.textContent = '';
        trackEmailVisit(data);
      } catch {
        status.textContent = 'Transit schedules are unavailable right now. Try again or check directions below.';
        retry.hidden = false;
      } finally {
        loading = false;
        if (queuedSelection) {
          const selection = queuedSelection;
          queuedSelection = null;
          chooseSaved(selection);
        }
      }
    }

    function chooseSaved(selection) {
      if (!selection) return;
      if (loading) { queuedSelection = selection; return; }
      const match = matchSavedChoice(routeChoices, selection);
      if (!match) {
        status.textContent = 'This saved route is no longer available. Choose a route below or check the operator.';
        return;
      }
      showPlan(match.choice, routeButtons.get(match.choice));
      if (match.choice.bart) {
        destination.value = String(match.destination);
      } else {
        direction.value = String(match.direction);
        stop.disabled = false;
        showStops();
      }
      stop.value = String(match.stop);
      showRideshare();
      form.requestSubmit(); // Recalculate the route only; no reminder mutation.
    }

    direction.addEventListener('change', () => { clearResult(); stop.disabled = false; showStops(); });
    stop.addEventListener('change', clearResult);
    destination.addEventListener('change', () => { clearResult(); showRideshare(); });
    retry.addEventListener('click', loadRoutes);
    root.addEventListener('getting-home:choose-saved', (event) => chooseSaved(event.detail));
    get('change').addEventListener('click', () => {
      clearResult();
      active = null;
      plan.hidden = true;
      picker.hidden = false;
      showRideshare();
      activeButton?.focus();
    });
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (lookup) return;
      const selection = selectedRoute();
      if (!selection) return;
      clearResult();
      const current = new win.AbortController();
      lookup = current;
      form.setAttribute('aria-busy', 'true');
      check.setAttribute('aria-disabled', 'true');
      resultStatus.textContent = 'Checking the schedule…';
      try {
        const response = await win.fetch(`${api}/departure`, {
          method: 'POST', credentials: 'same-origin', cache: 'no-store', signal: current.signal,
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(selection)
        });
        const data = await response.json();
        if (lookup !== current) return;
        if (!response.ok && (!data.status || data.status === 'scheduled')) throw new Error('Schedule unavailable');
        resultStatus.textContent = '';
        showResult(data, selection);
      } catch {
        if (lookup === current) resultStatus.textContent = 'We couldn’t verify a departure right now. Please try again or check the operator directly.';
      } finally {
        if (lookup === current) {
          lookup = null;
          form.removeAttribute('aria-busy');
          check.removeAttribute('aria-disabled');
        }
      }
    });
    loadRoutes();
  }

  return { createEmailVisitTracker, formattedTime, makeRouteChoices, makeRideshareLinks, matchSavedChoice, mount };
});
