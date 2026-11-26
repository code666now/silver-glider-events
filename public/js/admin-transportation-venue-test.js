(function initVenueTest() {
  'use strict';
  renderNav('');
  addSkipLink();
  const base = '/api/admin/transportation/venue-test';
  const el = id => document.getElementById(`venue-test-${id}`);
  const form = el('form');
  const input = el('search');
  const submit = el('submit');
  const retry = el('retry');
  const status = el('status');
  let choice = null;
  let busy = false;
  let initialized = false;
  let placesLoading = false;

  function show(message, { loading = false, error = false } = {}) {
    status.textContent = message;
    status.dataset.loading = String(loading);
    status.classList.toggle('is-error', error);
  }

  function loadPlaces(apiKey) {
    if (window.google?.maps?.places) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      const callback = '__sgeInitVenueTesterPlaces';
      const timeout = setTimeout(() => finish(false), 12_000);
      const finish = ok => {
        clearTimeout(timeout);
        delete window[callback];
        if (ok) resolve();
        else {
          script.remove();
          reject(new Error('Places unavailable'));
        }
      };
      window[callback] = () => finish(Boolean(window.google?.maps?.places));
      script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}&libraries=places&callback=${callback}`;
      script.async = true;
      script.onerror = () => finish(false);
      document.head.appendChild(script);
    });
  }

  function selectedPlace(place) {
    const component = (type, key = 'long_name') => place.address_components?.find(item => item.types?.includes(type))?.[key] || '';
    const record = SGLocation.recordForPlace(place);
    const point = place.geometry?.location;
    const candidate = { name: record.venueName, address: record.venueAddress, placeId: place.place_id,
      city: component('locality') || component('postal_town') || component('administrative_area_level_2'),
      state: component('administrative_area_level_1', 'short_name'), lat: point?.lat(), lng: point?.lng() };
    if (!candidate.address || !candidate.name || !candidate.placeId || !Number.isFinite(candidate.lat) || !Number.isFinite(candidate.lng)
        || candidate.city.toLowerCase() !== 'san francisco' || candidate.state !== 'CA') {
      choice = null;
      submit.disabled = true;
      show('Choose a public San Francisco venue from the suggestions.', { error: true });
      return;
    }
    choice = candidate;
    input.value = record.addressOnly ? record.venueAddress : record.venueName;
    submit.disabled = false;
    show(`Selected: ${record.addressOnly ? record.venueAddress : `${record.venueName} · ${record.venueAddress}`}`);
  }

  async function initialize() {
    if (initialized || placesLoading) return;
    placesLoading = true;
    retry.hidden = true;
    show('Loading venue suggestions…', { loading: true });
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 10_000);
    try {
      const { enabled, apiKey } = await api(`${base}/places/config`, { cache: 'no-store', signal: abort.signal });
      if (!enabled || !apiKey || !window.SGLocation) throw new Error('Places unavailable');
      await loadPlaces(apiKey);
      const autocomplete = new window.google.maps.places.Autocomplete(input, {
        fields: ['name', 'formatted_address', 'address_components', 'geometry', 'place_id', 'types'],
        bounds: { south: 37.68, west: -122.53, north: 37.84, east: -122.34 },
        componentRestrictions: { country: 'us' }
      });
      autocomplete.addListener('place_changed', () => selectedPlace(autocomplete.getPlace() || {}));
      initialized = true;
      input.disabled = false;
      show('');
    } catch {
      show('Venue suggestions couldn’t be loaded.', { error: true });
      retry.hidden = false;
    } finally {
      clearTimeout(timeout);
      placesLoading = false;
    }
  }

  input.addEventListener('input', () => {
    choice = null;
    submit.disabled = true;
    show(input.value.trim() ? 'Choose a suggestion to set the venue.' : '');
  });
  retry.addEventListener('click', initialize);
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (!choice || busy) return;
    busy = true;
    form.setAttribute('aria-busy', 'true');
    input.disabled = submit.disabled = true;
    submit.textContent = 'Finding routes…';
    show('Finding nearby buses and trains…', { loading: true });
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 60_000);
    try {
      await api(`${base}/prepare`, { method: 'POST', body: choice, signal: abort.signal });
      window.location.assign('/admin/transportation/venue-test/plan');
    } catch (error) {
      show(error.data?.message || 'Couldn’t check transit for this venue. Try again.', { error: true });
    } finally {
      clearTimeout(timeout);
      busy = false;
      form.setAttribute('aria-busy', 'false');
      input.disabled = false;
      submit.disabled = !choice;
      submit.textContent = 'Find nearby routes';
    }
  });
  initialize();
})();
