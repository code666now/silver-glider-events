(() => {
  const form = document.getElementById('quick-create-form');
  if (!form) return;
  renderNav('events');

  const $ = id => document.getElementById(id);
  const LocationUtils = window.SGLocation;
  const location = {
    venueName: '', venueAddress: '', venueCity: '', venueState: '',
    venueLatitude: null, venueLongitude: null, googlePlaceId: '', kind: null
  };
  let manualMode = false;
  let applyingPlace = false;
  let placesLoader;

  const today = new Date();
  const localToday = new Date(today.getTime() - today.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  $('create-date').min = localToday;

  function setStatus(message) { $('create-places-status').textContent = message || ''; }
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

  form.addEventListener('submit', async event => {
    event.preventDefault();
    const error = $('quick-create-error');
    error.textContent = '';
    if (!form.reportValidity()) return;
    if ((!location.venueName && !location.venueAddress) || (manualMode && !location.venueAddress)) {
      error.textContent = manualMode ? 'Add an address for this location.' : 'Choose a venue or address, or enter the location manually.';
      (manualMode ? $('create-location-manual-address') : $('create-location-search')).focus();
      return;
    }
    const button = $('quick-create-submit');
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
      sessionStorage.setItem('sge-owner-editor-reopen', created.slug);
      window.location.assign(`/e/${encodeURIComponent(created.slug)}?edit=appearance`);
    } catch (requestError) {
      error.textContent = requestError.message || 'The draft could not be created.';
      button.disabled = false;
      button.textContent = 'Continue to design';
    }
  });

  initPlaces();
})();
