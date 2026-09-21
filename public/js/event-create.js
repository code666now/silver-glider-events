(() => {
  const form = document.getElementById('quick-create-form');
  if (!form) return;
  renderNav('events');
  const adminEditorMode = sgIsAdminEditorPath();

  const $ = id => document.getElementById(id);
  const LocationUtils = window.SGLocation;
  const mobileFlowQuery = window.matchMedia('(max-width: 879px)');
  const reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  const mobileSteps = Array.from(form.querySelectorAll('[data-create-step]'));
  const mobileBack = $('quick-create-mobile-back');
  const mobileProgress = $('quick-create-mobile-progress');
  const submitButton = $('quick-create-submit');
  const footnote = $('quick-create-footnote');
  const QUICK_CREATE_DRAFT_PREFIX = 'sge-quick-create-draft:';
  const QUICK_CREATE_HISTORY_KEY = 'sgeQuickCreate';
  const draftStorageKey = `${QUICK_CREATE_DRAFT_PREFIX}${window.location.pathname}`;
  const location = {
    venueName: '', venueAddress: '', venueCity: '', venueState: '',
    venueLatitude: null, venueLongitude: null, googlePlaceId: '', kind: null
  };
  let manualMode = false;
  let applyingPlace = false;
  let placesLoader;
  let mobileStep = 0;
  let mobileHistoryReady = false;
  let quickCreateDirty = false;

  const today = new Date();
  const localToday = new Date(today.getTime() - today.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  $('create-date').min = localToday;

  function setStatus(message) { $('create-places-status').textContent = message || ''; }
  function mobileFlowEnabled() { return mobileFlowQuery.matches; }
  function safeText(value, maxLength = 500) {
    return typeof value === 'string' ? value.slice(0, maxLength) : '';
  }
  function safeCoordinate(value) {
    if (value === null || value === undefined || value === '') return null;
    const coordinate = Number(value);
    return Number.isFinite(coordinate) ? coordinate : null;
  }
  function boundedMobileStep(value) {
    const step = Number.parseInt(value, 10);
    return Number.isInteger(step) ? Math.max(0, Math.min(step, mobileSteps.length - 1)) : 0;
  }
  function quickCreateHistoryStep(state = window.history.state) {
    const quickCreateState = state && typeof state === 'object' ? state[QUICK_CREATE_HISTORY_KEY] : null;
    if (!quickCreateState || quickCreateState.path !== window.location.pathname) return null;
    return boundedMobileStep(quickCreateState.step);
  }
  function historyStateForStep(step) {
    const currentState = window.history.state && typeof window.history.state === 'object'
      ? window.history.state
      : {};
    return {
      ...currentState,
      [QUICK_CREATE_HISTORY_KEY]: { path: window.location.pathname, step: boundedMobileStep(step) }
    };
  }
  function persistQuickCreateDraft() {
    if (adminEditorMode) return;
    if (!mobileFlowEnabled()) return;
    const draft = {
      title: $('create-title').value,
      eventDate: $('create-date').value,
      startTime: $('create-start-time').value,
      locationSearch: $('create-location-search').value,
      manualAddress: $('create-location-manual-address').value,
      locationName: $('create-location-name').value,
      manualMode,
      step: mobileStep,
      location: {
        venueName: location.venueName,
        venueAddress: location.venueAddress,
        venueCity: location.venueCity,
        venueState: location.venueState,
        venueLatitude: location.venueLatitude,
        venueLongitude: location.venueLongitude,
        googlePlaceId: location.googlePlaceId,
        kind: location.kind
      }
    };
    try {
      window.sessionStorage.setItem(draftStorageKey, JSON.stringify(draft));
    } catch (_) {
      // Form recovery is a convenience; storage restrictions must not block creation.
    }
  }
  function restoreQuickCreateDraft() {
    if (adminEditorMode) {
      try { window.sessionStorage.removeItem(draftStorageKey); } catch (_) {}
      return;
    }
    if (!mobileFlowEnabled()) return;
    let draft;
    try {
      draft = JSON.parse(window.sessionStorage.getItem(draftStorageKey) || 'null');
    } catch (_) {
      return;
    }
    if (!draft || typeof draft !== 'object' || Array.isArray(draft)) return;

    $('create-title').value = safeText(draft.title, 140);
    $('create-date').value = safeText(draft.eventDate, 10);
    $('create-start-time').value = safeText(draft.startTime, 8);
    $('create-location-search').value = safeText(draft.locationSearch);
    $('create-location-manual-address').value = safeText(draft.manualAddress);
    $('create-location-name').value = safeText(draft.locationName, 140);

    const savedLocation = draft.location && typeof draft.location === 'object' && !Array.isArray(draft.location)
      ? draft.location
      : {};
    location.venueName = safeText(savedLocation.venueName, 140);
    location.venueAddress = safeText(savedLocation.venueAddress);
    location.venueCity = safeText(savedLocation.venueCity, 140);
    location.venueState = safeText(savedLocation.venueState, 80);
    location.venueLatitude = safeCoordinate(savedLocation.venueLatitude);
    location.venueLongitude = safeCoordinate(savedLocation.venueLongitude);
    location.googlePlaceId = safeText(savedLocation.googlePlaceId, 255);
    location.kind = savedLocation.kind === 'business' || savedLocation.kind === 'address'
      ? savedLocation.kind
      : null;
    manualMode = draft.manualMode === true;
    mobileStep = boundedMobileStep(draft.step);
    if (mobileStep > 0 && !$('create-title').value.trim()) mobileStep = 0;
    if (mobileStep > 1 && (
      !$('create-date').value
      || !$('create-start-time').value
      || !$('create-date').checkValidity()
      || !$('create-start-time').checkValidity()
    )) mobileStep = 1;
    $('create-location-search-mode').hidden = manualMode;
    $('create-location-manual-mode').hidden = !manualMode;
    renderLocation();
  }
  function initializeMobileHistory() {
    if (!mobileFlowEnabled() || mobileHistoryReady) return;
    const restoredStep = mobileStep;
    const stateStep = quickCreateHistoryStep();
    if (stateStep !== null) {
      mobileStep = stateStep;
      window.history.replaceState(historyStateForStep(mobileStep), '');
    } else {
      mobileStep = 0;
      window.history.replaceState(historyStateForStep(0), '');
      for (let step = 1; step <= restoredStep; step += 1) {
        window.history.pushState(historyStateForStep(step), '');
      }
      mobileStep = restoredStep;
    }
    mobileHistoryReady = true;
    persistQuickCreateDraft();
  }
  function pushMobileStep(step) {
    mobileStep = boundedMobileStep(step);
    window.history.pushState(historyStateForStep(mobileStep), '');
    persistQuickCreateDraft();
    renderMobileFlow({ focus: true });
  }
  async function leaveQuickCreate() {
    if (adminEditorMode) {
      try {
        await sgExitAdminEditorWorkspace();
      } catch (error) {
        $('quick-create-error').textContent = error.message || 'Could not exit event setup.';
      }
      return;
    }
    try {
      const referrer = new URL(document.referrer);
      if (referrer.origin === window.location.origin && referrer.pathname === '/events' && window.history.length > 1) {
        window.history.back();
        return;
      }
    } catch (_) {
      // A direct visit has no usable same-origin referrer.
    }
    window.location.replace('/events');
  }
  function clearQuickCreateDraft() {
    try {
      window.sessionStorage.removeItem(draftStorageKey);
    } catch (_) {
      // A successful request should still continue if storage is unavailable.
    }
    if (quickCreateHistoryStep() === null) return;
    const nextState = { ...window.history.state };
    delete nextState[QUICK_CREATE_HISTORY_KEY];
    window.history.replaceState(Object.keys(nextState).length ? nextState : null, '');
  }
  function submitLabel() {
    return mobileFlowEnabled() && mobileStep < mobileSteps.length - 1 ? 'Continue' : 'Continue to design';
  }
  function renderMobileFlow({ focus = false } = {}) {
    const enabled = mobileFlowEnabled();
    document.body.classList.toggle('quick-create-mobile-flow', enabled);
    mobileSteps.forEach((step, index) => { step.hidden = enabled && index !== mobileStep; });
    if (mobileProgress) mobileProgress.textContent = `Step ${mobileStep + 1} of ${mobileSteps.length}`;
    if (mobileBack) mobileBack.setAttribute('aria-label', mobileStep > 0
      ? 'Back to previous step'
      : (adminEditorMode ? 'Exit event setup' : 'Back to My Events'));
    if (footnote) footnote.hidden = enabled && mobileStep < mobileSteps.length - 1;
    if (!submitButton.disabled) submitButton.textContent = submitLabel();
    if (enabled && focus) {
      const heading = mobileSteps[mobileStep]?.querySelector('h1');
      heading?.focus({ preventScroll: true });
      window.scrollTo({ top: 0, behavior: reducedMotionQuery.matches ? 'auto' : 'smooth' });
    }
  }
  function reportField(input) {
    if (input.checkValidity()) return true;
    input.reportValidity();
    input.focus();
    return false;
  }
  function validateLocation() {
    const error = $('quick-create-error');
    if ((location.venueName || location.venueAddress) && (!manualMode || location.venueAddress)) return true;
    error.textContent = manualMode ? 'Add an address for this location.' : 'Choose a venue or address, or enter the location manually.';
    (manualMode ? $('create-location-manual-address') : $('create-location-search')).focus();
    return false;
  }
  function validateMobileStep(index) {
    $('quick-create-error').textContent = '';
    if (index === 0) return reportField($('create-title'));
    if (index === 1) return reportField($('create-date')) && reportField($('create-start-time'));
    return validateLocation();
  }
  function clearPlaceMeta() {
    location.venueCity = '';
    location.venueState = '';
    location.venueLatitude = null;
    location.venueLongitude = null;
    location.googlePlaceId = '';
  }
  function renderLocation() {
    const parts = LocationUtils.displayParts(location.venueName, location.venueAddress);
    $('create-location-selection').hidden = !parts.name;
    $('create-location-selection-name').textContent = parts.name;
    $('create-location-selection-address').textContent = parts.address;
    $('create-location-selection-address').hidden = !parts.address;
    $('create-location-name-field').hidden = location.kind !== 'address';
  }
  function syncManualLocation() {
    location.venueAddress = $('create-location-manual-address').value.trim();
    location.venueName = $('create-location-name').value.trim() || LocationUtils.addressFallback(location.venueAddress);
    location.kind = 'address';
    clearPlaceMeta();
    renderLocation();
    setStatus('');
  }
  function setManualMode(enabled, { focus = true } = {}) {
    manualMode = Boolean(enabled);
    $('create-location-search-mode').hidden = manualMode;
    $('create-location-manual-mode').hidden = !manualMode;
    if (manualMode) {
      const address = location.venueAddress || (!location.venueName ? $('create-location-search').value.trim() : '');
      $('create-location-manual-address').value = address;
      $('create-location-name').value = LocationUtils.isAddressFallback(location.venueName, address) ? '' : location.venueName;
      location.kind = 'address';
      syncManualLocation();
      if (focus) $('create-location-manual-address').focus();
    } else {
      $('create-location-search').value = location.venueAddress || location.venueName;
      if (focus) $('create-location-search').focus();
    }
    persistQuickCreateDraft();
  }
  function placeComponent(place, types, name = 'long_name') {
    const component = (place.address_components || []).find(part => types.some(type => part.types.includes(type)));
    return component ? component[name] : '';
  }
  function applySelectedPlace(place) {
    if (!place?.formatted_address && !place?.name) return;
    applyingPlace = true;
    const selected = LocationUtils.recordForPlace(place);
    location.venueName = selected.venueName;
    location.venueAddress = selected.venueAddress;
    location.kind = selected.addressOnly ? 'address' : 'business';
    location.venueCity = placeComponent(place, ['locality']) || placeComponent(place, ['postal_town']) || placeComponent(place, ['administrative_area_level_2']);
    location.venueState = placeComponent(place, ['administrative_area_level_1'], 'short_name');
    location.googlePlaceId = place.place_id || '';
    const point = place.geometry?.location;
    location.venueLatitude = point ? Number(point.lat()) : null;
    location.venueLongitude = point ? Number(point.lng()) : null;
    $('create-location-search').value = selected.addressOnly ? selected.venueAddress : selected.venueName;
    $('create-location-manual-address').value = selected.venueAddress;
    $('create-location-name').value = '';
    renderLocation();
    setStatus('');
    persistQuickCreateDraft();
    setTimeout(() => { applyingPlace = false; }, 0);
  }
  function loadPlaces(apiKey) {
    if (window.google?.maps?.places) return Promise.resolve();
    if (placesLoader) return placesLoader;
    placesLoader = new Promise((resolve, reject) => {
      window.__sgeInitCreatePlaces = resolve;
      const script = document.createElement('script');
      script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}&libraries=places&callback=__sgeInitCreatePlaces`;
      script.async = true;
      script.defer = true;
      script.onerror = reject;
      document.head.appendChild(script);
    });
    return placesLoader;
  }
  async function initPlaces() {
    try {
      setStatus('Loading location suggestions…');
      const { enabled, apiKey } = await api('/api/places/config');
      if (!enabled || !apiKey) return setStatus('Search suggestions are unavailable. Enter the location manually.');
      await loadPlaces(apiKey);
      const autocomplete = new google.maps.places.Autocomplete($('create-location-search'), {
        fields: ['name', 'formatted_address', 'address_components', 'geometry', 'place_id', 'types']
      });
      autocomplete.addListener('place_changed', () => applySelectedPlace(autocomplete.getPlace()));
      setStatus('');
    } catch (_) {
      setStatus('Search suggestions are unavailable. Enter the location manually.');
    }
  }

  $('create-location-search').addEventListener('input', () => {
    if (applyingPlace) return;
    location.venueName = '';
    location.venueAddress = '';
    location.kind = null;
    clearPlaceMeta();
    renderLocation();
    setStatus($('create-location-search').value.trim() ? 'Choose a suggestion or enter the address manually.' : '');
  });
  $('create-location-manual-address').addEventListener('input', syncManualLocation);
  $('create-location-name').addEventListener('input', syncManualLocation);
  $('create-location-manual-toggle').addEventListener('click', () => setManualMode(true));
  $('create-location-search-toggle').addEventListener('click', () => setManualMode(false));
  $('create-location-change').addEventListener('click', () => {
    const input = manualMode ? $('create-location-manual-address') : $('create-location-search');
    input.focus();
    input.select();
  });

  mobileBack?.addEventListener('click', () => {
    if (mobileStep > 0) {
      if (mobileHistoryReady && quickCreateHistoryStep() === mobileStep) {
        window.history.back();
      } else {
        mobileStep -= 1;
        window.history.replaceState(historyStateForStep(mobileStep), '');
        persistQuickCreateDraft();
        renderMobileFlow({ focus: true });
      }
      return;
    }
    leaveQuickCreate();
  });

  window.addEventListener('popstate', event => {
    if (!mobileFlowEnabled()) return;
    const nextStep = quickCreateHistoryStep(event.state);
    if (nextStep === null) return;
    mobileStep = nextStep;
    persistQuickCreateDraft();
    renderMobileFlow({ focus: true });
  });

  const handleMobileBreakpoint = () => {
    initializeMobileHistory();
    renderMobileFlow();
  };
  if (mobileFlowQuery.addEventListener) mobileFlowQuery.addEventListener('change', handleMobileBreakpoint);
  else mobileFlowQuery.addListener(handleMobileBreakpoint);

  document.addEventListener('sg:admin-editor-before-exit', event => {
    if (!adminEditorMode) return;
    if (quickCreateDirty && !window.confirm('Discard this unfinished event setup?')) {
      event.preventDefault();
      return;
    }
    clearQuickCreateDraft();
  });
  form.addEventListener('input', () => {
    quickCreateDirty = true;
    persistQuickCreateDraft();
  });
  form.addEventListener('change', () => {
    quickCreateDirty = true;
    persistQuickCreateDraft();
  });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    const error = $('quick-create-error');
    error.textContent = '';
    if (mobileFlowEnabled() && mobileStep < mobileSteps.length - 1) {
      if (!validateMobileStep(mobileStep)) return;
      pushMobileStep(mobileStep + 1);
      return;
    }
    if (!form.reportValidity()) return;
    if (!validateLocation()) return;
    const button = submitButton;
    button.disabled = true;
    button.textContent = 'Creating your draft…';
    try {
      const { event: created } = await api('/api/events', {
        method: 'POST',
        body: {
          status: 'draft',
          title: $('create-title').value.trim(),
          event_date: $('create-date').value,
          start_time: $('create-start-time').value,
          venue_name: location.venueName || LocationUtils.addressFallback(location.venueAddress),
          venue_address: location.venueAddress || null,
          venue_city: location.venueCity || null,
          venue_state: location.venueState || null,
          venue_latitude: location.venueLatitude,
          venue_longitude: location.venueLongitude,
          google_place_id: location.googlePlaceId || null,
          presentation_mode: 'standard',
          admission_type: 'free_rsvp',
          visibility: 'public'
        }
      });
      clearQuickCreateDraft();
      if (adminEditorMode) {
        window.location.assign(`/admin-editor/events/new?id=${encodeURIComponent(created.id)}&advanced=1`);
      } else {
        sessionStorage.setItem('sge-owner-editor-reopen', created.slug);
        window.location.assign(`/e/${encodeURIComponent(created.slug)}?edit=appearance`);
      }
    } catch (requestError) {
      error.textContent = requestError.message || 'The draft could not be created.';
      button.disabled = false;
      button.textContent = submitLabel();
    }
  });

  restoreQuickCreateDraft();
  initializeMobileHistory();
  renderMobileFlow();
  initPlaces();
})();
