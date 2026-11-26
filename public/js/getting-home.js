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

  function upcomingRows({ upcoming, timezone, departureAt, timing }) {
    if (!upcoming || !Array.isArray(upcoming.departures)) return [];
    const rides = [...upcoming.departures];
    // GTFS keeps the last departure out of the upcoming array to avoid an
    // accidental duplicate. In the two-slot list it is useful, clearly marked.
    if (upcoming.includesLast && Number.isFinite(departureAt)) rides.push({ departureAt, timing });
    const seen = new Set();
    return rides.filter(ride => Number.isFinite(ride?.departureAt))
      .sort((a, b) => a.departureAt - b.departureAt)
      .flatMap(ride => {
        const label = formattedTime(ride.departureAt, timezone);
        if (!label || seen.has(ride.departureAt)) return [];
        seen.add(ride.departureAt);
        return [{ label, estimated: ride.timing === 'feed-estimate', alsoLast: ride.departureAt === departureAt }];
      }).slice(0, 2);
  }

  function requestDeadline(win, controller, { slowMs, timeoutMs, onSlow }) {
    let timedOut = false;
    const slow = onSlow && win.setTimeout(onSlow, slowMs);
    const timeout = win.setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    return {
      get timedOut() { return timedOut; },
      clear() { win.clearTimeout(timeout); if (slow) win.clearTimeout(slow); }
    };
  }

  function mapsDirections(candidate) {
    if (typeof candidate !== 'string') return null;
    try {
      const url = new URL(candidate);
      if (url.username || url.password) return null;
      if (url.origin === 'https://maps.google.com' || (url.origin === 'https://www.google.com' && /^\/maps(?:\/|$)/.test(url.pathname))) return url.href;
    } catch { /* The default public directions link stays intact. */ }
    return null;
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
    const testerPath = /^\/admin\/transportation\/venue-test\/plan\/?$/.test(win.location.pathname);
    const rawSlug = /^\/e\/([^/]+)\/getting-home\/?$/.exec(win.location.pathname)?.[1];
    if (!rawSlug && !testerPath) return;
    let slug = '';
    if (rawSlug) {
      try { slug = encodeURIComponent(decodeURIComponent(rawSlug)); } catch { return; }
    }
    const api = testerPath ? '/api/admin/transportation/venue-test' : `/api/public/events/${slug}/getting-home`;
    const eventPath = testerPath ? '/admin/transportation/venue-test' : `/e/${slug}`;
    const routeList = get('routes');
    const picker = get('route-picker');
    const plan = get('plan');
    const retry = get('retry');
    const retryDeparture = get('retry-departure');
    const status = get('status');
    const resultStatus = get('result-status');
    const direction = get('direction');
    const stop = get('stop');
    const destination = get('destination');
    const form = get('form');
    const check = get('check');
    const stopField = get('stop-field');
    const changeStop = get('change-stop');
    let active = null;
    let activeButton = null;
    let lookup = null;
    let loading = false;
    let routeChoices = [];
    let queuedSelection = null;
    let tester = testerPath;
    const routeButtons = new Map();

    const pilotPreview = slug === 'make-out-room-schedule-preview';
    const preview = pilotPreview || slug === 'san-francisco-schedule-preview';
    const submittedInteractions = new Set();
    function trackInteraction(kind) {
      if (preview || tester || submittedInteractions.has(kind)) return;
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
    get('directions').href = tester ? 'https://maps.google.com/?q=San%20Francisco%2C%20CA'
      : !preview ? `${eventPath}#event-location-map` : pilotPreview
      ? 'https://maps.google.com/?q=Make-Out%20Room%2C%203225%2022nd%20St%2C%20San%20Francisco%2C%20CA'
      : 'https://maps.google.com/?q=San%20Francisco%2C%20CA';
    if (tester) {
      get('event-link').querySelector('span').textContent = 'Test another venue';
    } else if (preview) {
      get('event-link').querySelector('span').textContent = 'Silver Glider Events';
    }

    function setDepartureBusy(busy) {
      check.textContent = busy ? 'Checking departures…' : active?.bart ? 'Check last departure' : 'Check departures';
      check.toggleAttribute('data-loading', busy);
      resultStatus.toggleAttribute('data-loading', busy);
      if (busy) {
        check.setAttribute('aria-disabled', 'true');
        form.setAttribute('aria-busy', 'true');
      } else {
        check.removeAttribute('aria-disabled');
        form.removeAttribute('aria-busy');
      }
    }

    function clearResult() {
      lookup?.abort();
      lookup = null;
      get('results').hidden = true;
      get('upcoming').hidden = true;
      retryDeparture.hidden = true;
      resultStatus.textContent = '';
      setDepartureBusy(false);
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

    function stopChoices() {
      return active?.bart ? active.stations : active?.directions[direction.value]?.stops || [];
    }

    function toggleStopField(open) {
      stopField.hidden = !open;
      changeStop.setAttribute('aria-expanded', String(open));
    }

    function updateStopSummary() {
      const choices = stopChoices();
      const pick = choices[stop.value];
      get('stop-summary').hidden = !pick;
      get('stop-picked').textContent = pick ? [pick.name, walkLabel(pick.walkSeconds)].filter(Boolean).join(' · ') : '';
      changeStop.hidden = choices.length < 2;
    }

    function showStops() {
      const choices = stopChoices();
      stop.disabled = !choices.length;
      fillSelect(stop, choices, choice => [choice.name, walkLabel(choice.walkSeconds)].filter(Boolean).join(' · '));
      toggleStopField(false);
      updateStopSummary();
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
      get('stop-kind').textContent = get('stop-label').textContent;
      fillSelect(direction, route.directions, item => item.label, route.directions.length > 1 ? 'Choose a direction' : null);
      fillSelect(destination, route.destinations, item => item.name, route.bart ? 'Choose a destination station' : null);
      showStops();
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

    function showUpcoming(data) {
      const { context } = data.upcoming || {};
      const title = context === 'after-show' ? 'Next after the show'
        : context === 'from-show-start' ? 'Next scheduled from show start'
          : active?.bus ? 'Next buses if you leave now' : 'Next departures if you leave now';
      const rides = upcomingRows(data);
      const list = get('upcoming-times');
      list.replaceChildren(...rides.map((ride, index) => {
        const item = win.document.createElement('li');
        const order = win.document.createElement('span');
        order.className = 'gh-departure-number';
        order.textContent = index ? 'Then' : 'Next';
        const time = win.document.createElement('strong');
        time.textContent = ride.label;
        item.append(order, time);
        const bits = [ride.estimated && 'Estimated', ride.alsoLast && (active?.bus ? 'Also the last bus' : 'Also the last departure')].filter(Boolean);
        if (bits.length) {
          const note = win.document.createElement('span');
          note.className = 'gh-note';
          note.textContent = bits.join(' · ');
          item.append(note);
        }
        return item;
      }));
      list.hidden = !rides.length;
      get('upcoming-title').textContent = title;
      get('upcoming-note').textContent = rides.length === 0 ? (active?.bart && data.status === 'scheduled'
        ? 'BART checks the last available connection to your chosen station.'
        : 'No reachable scheduled departures found for this time.')
        : rides.length === 1 ? (active?.bus ? 'Only one reachable scheduled bus found. Not a live arrival.' : 'Only one reachable scheduled departure found. Not a live arrival.')
          : 'Scheduled times, not live arrivals.';
      get('upcoming').hidden = false;
    }

    function showResult(data, selection) {
      const messages = {
        'destination-required': 'Choose a BART destination to check the last connection.',
        'invalid-destination': 'Choose a different BART destination station.',
        'unsupported-selection': 'This route choice is no longer available. Choose another stop or route.',
        'unsupported-event': 'Getting Home is unavailable for this event.'
      };
      const lastTitle = get('results-title');
      lastTitle.textContent = active?.bart ? 'Last connection tonight' : active?.bus ? 'Last bus tonight' : 'Last departure tonight';
      const departure = formattedTime(data.departureAt, data.timezone);
      const noLast = data.status === 'overnight' || data.status === 'no-service';
      if (!noLast && (data.status !== 'scheduled' || !departure)) {
        resultStatus.textContent = messages[data.status] || 'We couldn’t verify a departure. Try again or check the operator directly.';
        retryDeparture.hidden = Boolean(messages[data.status]);
        return;
      }
      showUpcoming(data);
      get('results').hidden = false;
      get('last-details').hidden = noLast;
      get('last-note').hidden = !noLast;
      if (noLast) {
        get('last-note').textContent = data.status === 'overnight'
          ? 'This route runs overnight, so there isn’t one last ride. Check the operator for changes.'
          : 'We couldn’t find a last scheduled departure for this stop and direction. Try another route or check the operator.';
        get('show-warning').hidden = true;
        get('leave-passed').hidden = true;
        get('upcoming-title').focus();
        if (data.status === 'overnight') root.dispatchEvent(new win.CustomEvent('getting-home:plan', { detail: { selection, plan: data } }));
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
      get('upcoming-title').focus();
      root.dispatchEvent(new win.CustomEvent('getting-home:plan', { detail: { selection, plan: data } }));
    }

    async function loadRoutes() {
      if (loading) return;
      loading = true;
      status.textContent = 'Finding nearby buses and trains…';
      status.setAttribute('data-loading', '');
      retry.hidden = true;
      const controller = new win.AbortController();
      const deadline = requestDeadline(win, controller, {
        slowMs: 6500, timeoutMs: 45000,
        onSlow: () => { status.textContent = 'Still checking nearby transit. You can also look for a ride below.'; }
      });
      try {
        const response = await win.fetch(`${api}/options`, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
        const data = await response.json();
        tester = testerPath || data.tester === true;
        if (tester) get('preview-label').hidden = true;
        if (preview && !tester && /^\d{4}-\d{2}-\d{2}$/.test(data.previewDate || '')) {
          const previewDay = new Date(`${data.previewDate}T12:00:00Z`);
          if (Number.isFinite(previewDay.getTime())) {
            const day = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }).format(previewDay);
            get('preview-label').textContent = `Test preview · Sample show on ${day}. No RSVP or texts.`;
            get('preview-label').hidden = false;
          }
        }
        if (response.status === 404 || data.status === 'unsupported-event') {
          status.textContent = tester ? 'Getting Home is unavailable for this venue.' : 'Getting Home is unavailable for this event.';
          return;
        }
        if (!response.ok || !['available', 'empty'].includes(data.status)) throw new Error('Schedule unavailable');
        get('walking-source').hidden = !data.walkingAttribution;
        routeChoices = makeRouteChoices(data.stops);
        const venue = typeof data.venue === 'string' ? data.venue.trim() : '';
        get('heading').textContent = venue ? `Getting home from ${venue}` : 'Getting home';
        const verifiedMap = (tester || preview) && mapsDirections(data.directionsUrl);
        if (verifiedMap) get('directions').href = verifiedMap;
        if (routeChoices.length === 0) {
          status.textContent = 'No nearby transit routes were verified. You can still get directions or look for a ride.';
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
        status.textContent = deadline.timedOut
          ? 'Finding nearby transit took too long. Try again or check directions below.'
          : 'Transit schedules are unavailable right now. Try again or check directions below.';
        retry.hidden = false;
      } finally {
        deadline.clear();
        status.removeAttribute('data-loading');
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
      updateStopSummary();
      showRideshare();
      form.requestSubmit(); // Recalculate the route only; no reminder mutation.
    }

    direction.addEventListener('change', () => { clearResult(); showStops(); });
    stop.addEventListener('change', () => { clearResult(); updateStopSummary(); });
    changeStop.addEventListener('click', () => {
      const open = stopField.hidden;
      toggleStopField(open);
      if (open) stop.focus();
    });
    destination.addEventListener('change', () => { clearResult(); showRideshare(); });
    retry.addEventListener('click', loadRoutes);
    retryDeparture.addEventListener('click', () => form.requestSubmit());
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
      setDepartureBusy(true);
      resultStatus.textContent = 'Checking departures…';
      const deadline = requestDeadline(win, current, {
        slowMs: 6500, timeoutMs: 30000,
        onSlow: () => {
          if (lookup !== current) return;
          resultStatus.removeAttribute('data-loading');
          resultStatus.textContent = 'Still checking this route. Other ways to get home are below.';
        }
      });
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
        if (lookup === current) {
          resultStatus.textContent = deadline.timedOut ? 'Checking this route took too long. Try again.'
            : 'We couldn’t verify a departure right now. Try again or check the operator directly.';
          retryDeparture.hidden = false;
        }
      } finally {
        deadline.clear();
        if (lookup === current) {
          lookup = null;
          setDepartureBusy(false);
        }
      }
    });
    loadRoutes();
  }

  return { createEmailVisitTracker, formattedTime, makeRouteChoices, makeRideshareLinks, mapsDirections, matchSavedChoice, requestDeadline, upcomingRows, mount };
});
