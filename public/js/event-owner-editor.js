(() => {
  const root = document.getElementById('owner-edit-root');
  const dataNode = document.getElementById('owner-event-data');
  if (!root || !dataNode) return;

  const EVENT = JSON.parse(dataNode.textContent);
  const $ = id => document.getElementById(id);
  const editor = $('owner-editor');
  const form = $('owner-editor-form');
  const trigger = $('owner-edit-trigger');
  const saveButton = $('owner-editor-save');
  const saveStatus = $('owner-save-status');
  const toastNode = $('owner-editor-toast');
  const LocationUtils = window.SGLocation;
  const mobileEditorMedia = window.matchMedia('(max-width: 879px)');
  const mobileViews = {
    appearance: { title: 'Appearance', helper: 'Choose a page style and artwork that feels like your event.', panel: 'appearance' },
    designer: { title: 'Designer credit', helper: 'Give the artist behind your flyer an optional shoutout.', panel: 'appearance', appearanceSection: 'designer', parent: 'appearance' },
    effects: { title: 'Effects', helper: 'Choose the atmosphere guests see around your event.', panel: 'appearance', appearanceSection: 'effects', parent: 'appearance' },
    details: { title: 'Event details', helper: 'Keep the essentials clear so guests know where and when to arrive.', panel: 'details' },
    admission: { title: 'Admission', helper: 'Choose how guests reserve a spot or get tickets.', panel: 'settings', section: 'admission' },
    visibility: { title: 'Visibility', helper: 'Decide who can discover and open this event.', panel: 'settings', section: 'visibility' },
    capacity: { title: 'Capacity', helper: 'Set a guest limit, or leave it unlimited.', panel: 'settings', section: 'capacity', optional: true },
    guests: { title: 'Guest experience', helper: 'Choose how guests can participate after they RSVP.', panel: 'settings', section: 'guests', optional: true },
    more: { title: 'Links & advanced', helper: 'Open guest management, music, and the full event editor.', panel: 'settings', section: 'more' }
  };
  const themeKeys = ['midnight', 'aurora', 'sunset', 'ocean', 'halloween', 'liquid-stardust', 'color-static', 'last-guest', 'disco', 'fog', 'paper', 'static', 'saloon', 'adaptive'];
  const effectKeys = ['halloween', 'liquid-stardust', 'color-static', 'last-guest', 'disco', 'fog', 'paper', 'static', 'saloon'];
  const videoEffects = {
    halloween: 'sg-events/effects/halloween',
    'liquid-stardust': 'sg-events/effects/liquid-stardust',
    'color-static': 'sg-events/effects/color-static',
    'last-guest': 'sg-events/effects/the-last-guest',
    disco: 'sg-events/effects/disco',
    fog: 'sg-events/effects/fog'
  };
  const seamlessVideoEffects = new Set(['liquid-stardust', 'color-static']);
  const photoCategories = [
    ['🎃 Halloween', 'halloween pumpkins costumes haunted spooky'],
    ['🍂 Fall', 'autumn leaves cozy harvest warm'],
    ['⭐ Silver Glider Picks', 'nightlife live music crowd neon event'],
    ['📼 Nostalgia', 'vintage retro analog 90s nostalgic background'],
    ['🎨 Textures', 'concrete paper grain fabric texture background'],
    ['📐 Patterns', 'geometric repeating patterns graphic design background'],
    ['🎞️ Film', 'cinematic film moody lighting grain dramatic shadows'],
    ['🏙️ Urban', 'city architecture streets nightlife urban lights'],
    ['🌿 Nature', 'forest mountains plants sky natural light background'],
    ['✨ Abstract', 'abstract gradients shapes soft color background'],
    ['🌈 Colorful', 'vibrant colors neon rainbow bright abstract background'],
    ['🌙 Dark', 'black shadows low light dark moody background'],
    ['🖤 Minimal', 'clean simple negative space minimal background']
  ];

  const clone = value => JSON.parse(JSON.stringify(value));
  const dateValue = value => String(value || '').slice(0, 10);
  const timeValue = value => String(value || '').slice(0, 5);
  function cleanInstagramHandleInput(value) {
    let raw = String(value ?? '').trim();
    if (!raw) return { value: null, error: null };
    if (raw.length > 500) return { value: null, error: 'Instagram handle is too long' };

    let handle = raw;
    try {
      if (/instagram\.com\//i.test(raw)) {
        if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = `https://${raw}`;
        const url = new URL(raw);
        const hostname = url.hostname.toLowerCase().replace(/^www\./, '');
        const parts = url.pathname.split('/').filter(Boolean);
        if (!['http:', 'https:'].includes(url.protocol) || hostname !== 'instagram.com' || parts.length !== 1) throw new Error('profile');
        handle = decodeURIComponent(parts[0]);
      } else {
        handle = raw.replace(/^@/, '');
      }
    } catch (_) {
      return { value: null, error: 'Enter an Instagram handle like @silverglidertix' };
    }

    handle = handle.trim().toLowerCase();
    if (handle.length > 30 || !/^[a-z0-9._]+$/.test(handle) || handle.startsWith('.') || handle.endsWith('.') || handle.includes('..')) {
      return { value: null, error: 'Enter an Instagram handle like @silverglidertix' };
    }
    return { value: handle, error: null };
  }
  function comparableInstagramHandle(value) {
    const raw = String(value ?? '').trim();
    const parsed = cleanInstagramHandleInput(raw);
    return parsed.error ? `invalid:${raw}` : (parsed.value || '');
  }
  const normalized = source => ({
    ...source,
    eventDate: dateValue(source.eventDate),
    startTime: timeValue(source.startTime),
    endTime: timeValue(source.endTime),
    capacity: source.capacity === '' || source.capacity == null ? null : Number(source.capacity),
    venueCity: source.venueCity || '',
    venueState: source.venueState || '',
    venueLatitude: source.venueLatitude === '' || source.venueLatitude == null ? null : Number(source.venueLatitude),
    venueLongitude: source.venueLongitude === '' || source.venueLongitude == null ? null : Number(source.venueLongitude),
    googlePlaceId: source.googlePlaceId || '',
    coverImageUrl: source.coverImageUrl || '',
    flyerImageUrl: source.flyerImageUrl || '',
    flyerDesignerName: source.flyerDesignerName || '',
    flyerDesignerInstagramHandle: comparableInstagramHandle(source.flyerDesignerInstagramHandle),
    presentationMode: source.presentationMode === 'flyer' ? 'flyer' : 'standard',
    admissionType: ['free_rsvp', 'external_tickets', 'silver_glider_tickets'].includes(source.admissionType)
      ? source.admissionType
      : 'free_rsvp',
    ticketPrice: source.ticketPrice === '' || source.ticketPrice == null ? null : Number(source.ticketPrice),
    ticketUrl: source.ticketUrl || '',
    coverCreditName: source.coverCreditName || '',
    coverCreditLink: source.coverCreditLink || '',
    artworkAccentColor: source.artworkAccentColor || '',
    secretShowEnabled: source.secretShowEnabled === true,
    smsReminderEnabled: source.smsReminderEnabled === true,
    secretCode: String(source.secretCode || '').toUpperCase(),
    secretCodeConfirm: String(source.secretCodeConfirm || '').toUpperCase()
  });
  let saved = normalized(EVENT);
  let draft = clone(saved);
  let activeTab = 'appearance';
  let activeMobileView = 'hub';
  let mobileReturnFocus = null;
  let mobileNestedReturnFocus = null;
  let mobileGuidedFlow = false;
  const mobileDraftSequence = ['appearance', 'details', 'admission', 'visibility', 'capacity', 'guests'];
  let lastFocus = null;
  let toastTimer;
  let photoPage = 1;
  let photoTotalPages = 1;
  let photoQuery = photoCategories[0][1];
  let photoCategory = photoCategories[0][0];
  let photoLoading = false;
  let photosReady = false;
  let editorFieldSyncTimer;
  let applyingPlace = false;
  let placesLoader;
  let placesInitPromise;
  let locationKind = null;
  let manualLocationMode = false;
  let commerceConfigLoaded = false;
  let commerceEnabled = false;
  let commerceInterested = false;

  async function request(path, options = {}) {
    const response = await fetch(path, {
      credentials: 'same-origin',
      headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
      ...options,
      body: options.body ? JSON.stringify(options.body) : undefined
    });
    if (response.status === 401) {
      location.href = `/login?next=${encodeURIComponent(location.pathname + location.search)}`;
      throw new Error('Your session expired. Sign in again to continue.');
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'The event could not be updated.');
    return data;
  }

  function isDirty() {
    return JSON.stringify(normalized(draft)) !== JSON.stringify(normalized(saved));
  }

  function isDraftEvent() {
    return saved.status === 'draft';
  }

  function primaryActionLabel() {
    return isDraftEvent() ? 'Publish event' : 'Save changes';
  }

  function showToast(message) {
    toastNode.textContent = message;
    toastNode.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastNode.classList.remove('is-visible'), 2800);
  }

  function renderCommerceInterest() {
    const panel = $('owner-commerce-interest');
    const button = $('owner-commerce-interest-toggle');
    if (!panel || !button) return;
    panel.hidden = !commerceConfigLoaded || commerceEnabled || Boolean(saved.commerceEventId);
    panel.classList.toggle('is-confirmed', commerceInterested);
    button.setAttribute('aria-pressed', String(commerceInterested));
    button.textContent = commerceInterested ? 'Leave waitlist' : 'Join the waitlist';
    $('owner-commerce-interest-copy').innerHTML = commerceInterested
      ? '<span class="owner-commerce-interest-check" aria-hidden="true">✓</span><strong>You’re on the list</strong><span>We’ll contact you at your account email when ticketing is available.</span>'
      : '<strong>Sell with Silver Glider is coming soon.</strong><span>Join the waitlist using your account email.</span>';
  }

  function focusCommerceInterestConfirmation() {
    const confirmation = $('owner-commerce-interest-copy');
    if (!confirmation || !commerceInterested) return;
    confirmation.focus({ preventScroll: true });
  }

  function sensitiveChanges() {
    return ['eventDate', 'startTime', 'venueName', 'venueAddress']
      .some(key => String(draft[key] ?? '') !== String(saved[key] ?? ''));
  }

  function compactDate(value) {
    if (!value) return '';
    const date = new Date(`${value}T00:00:00`);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  function updateMobileSummaries() {
    const appearance = $('owner-mobile-summary-appearance');
    if (!appearance) return;
    const flyer = draft.presentationMode === 'flyer';
    const hasArtwork = Boolean(flyer ? draft.flyerImageUrl : draft.coverImageUrl);
    appearance.textContent = `${flyer ? 'Flyer' : 'Standard'} · ${hasArtwork ? 'Image added' : 'No image yet'}`;

    const missingDetails = [];
    if (!draft.title) missingDetails.push('title');
    if (!draft.eventDate) missingDetails.push('date');
    if (!draft.startTime) missingDetails.push('time');
    if (!draft.venueName && !draft.venueAddress) missingDetails.push('location');
    const locationParts = LocationUtils.displayParts(draft.venueName, draft.venueAddress);
    $('owner-mobile-summary-details').textContent = missingDetails.length
      ? `Add ${missingDetails.join(', ')}`
      : `${compactDate(draft.eventDate)} · ${locationParts.name}`;

    const admissionLabels = {
      free_rsvp: 'Free RSVP',
      external_tickets: 'External tickets',
      silver_glider_tickets: 'Silver Glider tickets'
    };
    $('owner-mobile-summary-admission').textContent = admissionLabels[draft.admissionType] || 'Free RSVP';
    $('owner-mobile-summary-visibility').textContent = draft.secretShowEnabled
      ? 'Secret Show · Code required'
      : (draft.visibility === 'private' ? 'Private link only' : 'Public');
    $('owner-mobile-summary-capacity').textContent = draft.capacity ? `${draft.capacity} guests` : 'Unlimited';

    const enabledGuestOptions = [draft.showGuestList, draft.allowGuests, draft.commentsEnabled].filter(Boolean).length;
    $('owner-mobile-summary-guests').textContent = enabledGuestOptions
      ? `${enabledGuestOptions} of 3 options on`
      : 'All optional settings off';
    $('owner-mobile-summary-designer').textContent = draft.flyerDesignerName || draft.flyerDesignerInstagramHandle
      ? 'Credit added'
      : 'Add an optional flyer credit';
    const selectedTheme = document.querySelector(`[data-owner-theme="${draft.backgroundTheme}"] span:last-child`);
    $('owner-mobile-summary-effects').textContent = selectedTheme?.textContent || 'Choose the page atmosphere';
  }

  function setMobileViewStatus(message = '') {
    const status = $('owner-mobile-view-status');
    status.textContent = message;
    status.hidden = !message;
  }

  function mobileViewForControl(control) {
    const section = control.closest('[data-owner-mobile-section]');
    if (section) return section.dataset.ownerMobileSection;
    const panel = control.closest('[data-owner-panel]')?.dataset.ownerPanel;
    return panel === 'settings' ? 'admission' : (panel || 'details');
  }

  function showEditorValidation(message, view, control, { report = false } = {}) {
    if (mobileEditorMedia.matches) openMobileView(view, { focus: false });
    else activateTab(mobileViews[view]?.panel || view);
    saveStatus.textContent = message;
    setMobileViewStatus(message);
    if (!(control instanceof HTMLElement)) return;
    setTimeout(() => {
      control.focus({ preventScroll: false });
      if (report && typeof control.reportValidity === 'function') control.reportValidity();
    }, 0);
  }

  function syncDirtyState() {
    const dirty = isDirty();
    saveButton.disabled = !dirty && !isDraftEvent();
    saveButton.textContent = primaryActionLabel();
    saveStatus.textContent = isDraftEvent()
      ? (dirty ? 'Unsaved draft changes' : 'Ready to publish')
      : (dirty ? 'Unsaved changes' : 'No unsaved changes');
    const warning = $('owner-rsvp-warning');
    const needsWarning = saved.rsvpCount > 0 && sensitiveChanges();
    warning.hidden = !needsWarning;
    warning.textContent = needsWarning
      ? `${saved.rsvpCount} ${saved.rsvpCount === 1 ? 'person has' : 'people have'} RSVP’d. This change may affect their plans.`
      : '';
    updateMobileSummaries();
  }

  function editorFieldsDifferFromDraft() {
    const capacity = $('owner-capacity').value ? Number($('owner-capacity').value) : null;
    const visibilityChoice = document.querySelector('input[name="owner_visibility"]:checked')?.value || saved.visibility;
    const visibility = visibilityChoice === 'secret' ? 'private' : visibilityChoice;
    const secretShowEnabled = mobileEditorMedia.matches ? visibilityChoice === 'secret' : draft.secretShowEnabled;
    return $('owner-title').value.trim() !== draft.title ||
      $('owner-description').value.trim() !== draft.description ||
      $('owner-date').value !== draft.eventDate ||
      $('owner-start-time').value !== draft.startTime ||
      $('owner-category').value !== draft.category ||
      capacity !== draft.capacity ||
      visibility !== draft.visibility ||
      secretShowEnabled !== draft.secretShowEnabled ||
      cleanSecretCode($('owner-secret-code').value) !== (draft.secretCode || '') ||
      cleanSecretCode($('owner-secret-code-confirm').value) !== (draft.secretCodeConfirm || '') ||
      $('owner-show-guests').checked !== draft.showGuestList ||
      $('owner-allow-guests').checked !== draft.allowGuests ||
      $('owner-comments').checked !== draft.commentsEnabled ||
      (document.querySelector('input[name="owner_presentation_mode"]:checked')?.value || saved.presentationMode) !== draft.presentationMode ||
      (document.querySelector('input[name="owner_admission"]:checked')?.value || saved.admissionType) !== draft.admissionType ||
      ($('owner-ticket-price').value ? Number($('owner-ticket-price').value) : null) !== draft.ticketPrice ||
      $('owner-ticket-url').value.trim() !== draft.ticketUrl ||
      (draft.presentationMode === 'flyer' && (
        $('owner-flyer-designer-name').value.trim() !== draft.flyerDesignerName ||
        comparableInstagramHandle($('owner-flyer-designer-instagram').value) !== comparableInstagramHandle(draft.flyerDesignerInstagramHandle)
      ));
  }

  function reconcileEditorFields() {
    if (editor.classList.contains('is-open') && editorFieldsDifferFromDraft()) readInputs();
  }

  function startEditorFieldSync() {
    window.clearInterval(editorFieldSyncTimer);
    editorFieldSyncTimer = window.setInterval(reconcileEditorFields, 200);
  }

  function stopEditorFieldSync() {
    window.clearInterval(editorFieldSyncTimer);
    editorFieldSyncTimer = undefined;
  }

  function previewGuestSettings() {
    const preview = window.SGEventPreview;
    if (!preview) return;
    preview.setGuestListVisible(draft.showGuestList);
    preview.setGuestFieldsVisible(draft.allowGuests);
    preview.setCommentsVisible(draft.commentsEnabled);
  }

  function formatTicketPrice(value) {
    const amount = Number(value);
    if (!Number.isFinite(amount) || amount <= 0) return 'Tickets';
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount);
  }

  function previewAdmission() {
    const note = document.querySelector('.ticket-note');
    if (note) {
      if (draft.admissionType === 'external_tickets') {
        note.innerHTML = `<span>${formatTicketPrice(draft.ticketPrice)}</span>${draft.ticketUrl ? '<a>Ticket link →</a>' : '<em>At the door</em>'}`;
      } else if (draft.admissionType === 'silver_glider_tickets') {
        note.innerHTML = '<span>Tickets</span><em>Sold by Silver Glider</em>';
      } else {
        note.innerHTML = '<span>Free</span><em>RSVP</em>';
      }
    }
    document.querySelectorAll('[data-primary-action]').forEach(action => {
      if (draft.admissionType === 'external_tickets' && draft.ticketUrl) action.textContent = 'Get Tickets';
      else if (draft.admissionType === 'silver_glider_tickets') action.textContent = 'Get Tickets';
      else action.textContent = 'RSVP';
    });
  }

  function formatDate(value) {
    if (!value) return 'Choose a date';
    const date = new Date(`${value}T00:00:00`);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  }

  function formatTime(value) {
    if (!value) return '';
    const [hourValue, minute = '00'] = value.split(':');
    const hour = Number(hourValue);
    if (!Number.isFinite(hour)) return value;
    return `${hour % 12 || 12}:${minute} ${hour >= 12 ? 'PM' : 'AM'}`;
  }

  function previewDetails() {
    const title = document.querySelector('.event-title');
    if (title) title.textContent = draft.title || saved.title;
    const category = document.querySelector('.cat, .detail-category strong');
    if (category) category.textContent = draft.category || '';
    const when = document.querySelector('.when');
    if (when) {
      const spans = when.querySelectorAll('span');
      if (spans[0]) spans[0].textContent = formatDate(draft.eventDate);
      if (spans[2]) spans[2].textContent = `${formatTime(draft.startTime)}${draft.endTime ? ` – ${formatTime(draft.endTime)}` : ''}`;
    }
    const venue = document.querySelector('.venue, .flyer-venue');
    if (venue) {
      const name = venue.querySelector('strong');
      const address = venue.querySelector('span');
      const maps = venue.querySelector('a');
      const activeName = draft.venueName || draft.venueAddress ? draft.venueName : saved.venueName;
      const activeAddress = draft.venueName || draft.venueAddress ? draft.venueAddress : saved.venueAddress;
      const parts = LocationUtils.displayParts(activeName, activeAddress);
      if (name) name.textContent = parts.name;
      if (address) {
        address.textContent = parts.address;
        address.hidden = !parts.address;
      }
      if (maps) maps.href = `https://maps.google.com/?q=${encodeURIComponent(LocationUtils.locationQuery(activeName, activeAddress))}`;
    }
    const description = document.querySelector('.desc');
    if (description) description.textContent = draft.description || '';
  }

  function setPlacesStatus(message) {
    $('owner-places-status').textContent = message || '';
  }

  function clearPlaceMeta() {
    draft.venueCity = '';
    draft.venueState = '';
    draft.venueLatitude = null;
    draft.venueLongitude = null;
    draft.googlePlaceId = '';
  }

  function renderOwnerLocation() {
    const parts = LocationUtils.displayParts(draft.venueName, draft.venueAddress);
    const selection = $('owner-location-selection');
    selection.hidden = !parts.name;
    $('owner-location-selection-name').textContent = parts.name;
    $('owner-location-selection-address').textContent = parts.address;
    $('owner-location-selection-address').hidden = !parts.address;
    $('owner-location-name-field').hidden = locationKind !== 'address';
  }

  function populateOwnerLocation() {
    const name = LocationUtils.clean(draft.venueName);
    const address = LocationUtils.clean(draft.venueAddress);
    const addressOnly = Boolean(address) && LocationUtils.isAddressFallback(name, address);
    locationKind = addressOnly ? 'address' : (name || address ? 'business' : null);
    manualLocationMode = false;
    $('owner-location-search-mode').hidden = false;
    $('owner-location-manual-mode').hidden = true;
    $('owner-location-search').value = addressOnly ? address : (name || address);
    $('owner-location-manual-address').value = address;
    $('owner-location-name').value = addressOnly ? '' : name;
    renderOwnerLocation();
  }

  function locationChanged() {
    renderOwnerLocation();
    previewDetails();
    syncDirtyState();
  }

  function syncOwnerManualLocation() {
    const address = $('owner-location-manual-address').value.trim();
    const locationName = $('owner-location-name').value.trim();
    locationKind = 'address';
    draft.venueAddress = address;
    draft.venueName = locationName || LocationUtils.addressFallback(address);
    clearPlaceMeta();
    setPlacesStatus('');
    locationChanged();
  }

  function setOwnerManualLocationMode(enabled, { focus = true } = {}) {
    manualLocationMode = Boolean(enabled);
    $('owner-location-search-mode').hidden = manualLocationMode;
    $('owner-location-manual-mode').hidden = !manualLocationMode;
    if (manualLocationMode) {
      const address = draft.venueAddress || (!draft.venueName ? $('owner-location-search').value.trim() : '');
      const currentName = LocationUtils.isAddressFallback(draft.venueName, address) ? '' : draft.venueName;
      locationKind = 'address';
      $('owner-location-manual-address').value = address;
      $('owner-location-name').value = currentName;
      renderOwnerLocation();
      setPlacesStatus('');
      if (focus) $('owner-location-manual-address').focus();
    } else {
      locationKind = LocationUtils.isAddressFallback(draft.venueName, draft.venueAddress) ? 'address' : (draft.venueName || draft.venueAddress ? 'business' : null);
      $('owner-location-search').value = draft.venueAddress || draft.venueName;
      renderOwnerLocation();
      if (focus) {
        $('owner-location-search').focus();
        $('owner-location-search').select();
      }
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
    locationKind = selected.addressOnly ? 'address' : 'business';
    manualLocationMode = false;
    draft.venueName = selected.venueName;
    draft.venueAddress = selected.venueAddress;
    draft.venueCity =
      placeComponent(place, ['locality']) ||
      placeComponent(place, ['postal_town']) ||
      placeComponent(place, ['administrative_area_level_2']);
    draft.venueState = placeComponent(place, ['administrative_area_level_1'], 'short_name');
    draft.googlePlaceId = place.place_id || '';
    const location = place.geometry?.location;
    draft.venueLatitude = location ? Number(location.lat()) : null;
    draft.venueLongitude = location ? Number(location.lng()) : null;
    $('owner-location-search-mode').hidden = false;
    $('owner-location-manual-mode').hidden = true;
    $('owner-location-search').value = selected.addressOnly ? selected.venueAddress : selected.venueName;
    $('owner-location-manual-address').value = selected.venueAddress;
    $('owner-location-name').value = '';
    setPlacesStatus('');
    locationChanged();
    setTimeout(() => { applyingPlace = false; }, 0);
  }

  function loadGooglePlaces(apiKey) {
    if (window.google?.maps?.places) return Promise.resolve();
    if (placesLoader) return placesLoader;
    placesLoader = new Promise((resolve, reject) => {
      window.__sgeInitOwnerPlaces = resolve;
      const script = document.createElement('script');
      script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}&libraries=places&callback=__sgeInitOwnerPlaces`;
      script.async = true;
      script.defer = true;
      script.onerror = reject;
      document.head.appendChild(script);
    });
    return placesLoader;
  }

  function initVenueAutocomplete() {
    if (placesInitPromise) return placesInitPromise;
    placesInitPromise = (async () => {
      try {
        setPlacesStatus('Loading location suggestions…');
        const { enabled, apiKey } = await request('/api/places/config');
        if (!enabled || !apiKey) {
          setPlacesStatus('');
          return;
        }
        await loadGooglePlaces(apiKey);
        const autocomplete = new google.maps.places.Autocomplete($('owner-location-search'), {
          fields: ['name', 'formatted_address', 'address_components', 'geometry', 'place_id', 'types']
        });
        autocomplete.addListener('place_changed', () => applySelectedPlace(autocomplete.getPlace()));
        setPlacesStatus('');
      } catch (_) {
        setPlacesStatus('Search suggestions are unavailable. Enter the location manually.');
      }
    })();
    return placesInitPromise;
  }

  function setCoverFit(mode) {
    draft.coverFitMode = ['contain', 'cover'].includes(mode) ? mode : 'auto';
    document.querySelectorAll('input[name="owner_cover_fit"]').forEach(input => { input.checked = input.value === draft.coverFitMode; });
    $('owner-image-card')?.classList.toggle('fit-contain', draft.coverFitMode === 'contain');
    const hero = $('hero');
    if (hero && draft.presentationMode === 'standard') {
      hero.classList.remove('cover-fit-auto', 'cover-fit-contain', 'cover-fit-cover');
      hero.classList.add(`cover-fit-${draft.coverFitMode}`);
      if (draft.coverFitMode !== 'auto') hero.classList.remove('cover-fit-resolved-cover');
    }
  }

  function defaultCoverFitFromImage(image) {
    if (draft.coverFitMode !== 'auto' || !image.naturalWidth || !image.naturalHeight) return;
    setCoverFit(image.naturalHeight > image.naturalWidth ? 'contain' : 'cover');
  }

  function updateOwnerImageCard(url) {
    const card = $('owner-image-card');
    const image = $('owner-image-preview');
    if (url) {
      image.src = url;
      card.classList.add('has-image');
    } else {
      image.removeAttribute('src');
      card.classList.remove('has-image');
      updateAdaptiveSwatch([]);
    }
    $('owner-remove-image').disabled = !url || draft.presentationMode === 'flyer';
    const showFlyerCredit = draft.presentationMode === 'flyer' && Boolean(url);
    $('owner-mobile-designer-row').hidden = !showFlyerCredit;
    if (!mobileEditorMedia.matches) $('owner-flyer-credit-fields').hidden = !showFlyerCredit;
    else if (activeMobileView === 'designer') $('owner-flyer-credit-fields').hidden = !showFlyerCredit;
    if (!showFlyerCredit) setOwnerFlyerDesignerError('');
  }

  function renderPresentationControls() {
    document.querySelectorAll('input[name="owner_presentation_mode"]').forEach(input => {
      input.checked = input.value === draft.presentationMode;
    });
    $('owner-browse-photos').hidden = draft.presentationMode === 'flyer';
    $('owner-upload-image').textContent = draft.presentationMode === 'flyer'
      ? (draft.flyerImageUrl ? 'Replace flyer' : 'Upload flyer')
      : (draft.coverImageUrl ? 'Replace image' : 'Upload image');
    $('owner-image-card').setAttribute('aria-label', draft.presentationMode === 'flyer'
      ? 'Upload a new event flyer'
      : 'Upload a new event image');
    $('owner-image-empty-title').textContent = draft.presentationMode === 'flyer'
      ? 'Add your flyer'
      : 'Add event image';
    $('owner-fit-field').hidden = draft.presentationMode === 'flyer' || !draft.coverImageUrl;
    document.querySelector('.owner-gradient-group').hidden = draft.presentationMode === 'flyer';
    document.querySelector('.owner-flyer-default').hidden = draft.presentationMode !== 'flyer';
    document.querySelector('[data-owner-theme="adaptive"]').hidden = draft.presentationMode === 'flyer';
    $('owner-mobile-designer-row').hidden = !(draft.presentationMode === 'flyer' && draft.flyerImageUrl);
  }

  function syncMobileAppearanceSections(viewName = activeMobileView) {
    const designer = $('owner-flyer-credit-fields');
    const effects = $('owner-theme-picker');
    if (!mobileEditorMedia.matches) {
      designer.hidden = !(draft.presentationMode === 'flyer' && draft.flyerImageUrl);
      effects.hidden = false;
      editor.removeAttribute('data-mobile-view');
      return;
    }
    editor.dataset.mobileView = viewName;
    designer.hidden = viewName !== 'designer' || !(draft.presentationMode === 'flyer' && draft.flyerImageUrl);
    effects.hidden = viewName !== 'effects';
  }

  function setPresentationMode(mode) {
    draft.presentationMode = mode === 'flyer' ? 'flyer' : 'standard';
    if (draft.presentationMode === 'flyer' && !draft.flyerImageUrl) {
      $('owner-upload-status').textContent = 'Upload your flyer to use the Flyer layout.';
    } else {
      $('owner-upload-status').textContent = '';
    }
    renderPresentationControls();
    previewPresentation();
    previewImage();
    previewTheme(draft.backgroundTheme);
    syncDirtyState();
  }

  function renderAdmissionControls() {
    document.querySelectorAll('input[name="owner_admission"]').forEach(input => {
      input.checked = input.value === draft.admissionType;
    });
    const external = draft.admissionType === 'external_tickets';
    $('owner-ticket-fields').hidden = !external;
    $('owner-ticket-price').required = external;
    previewAdmission();
  }

  function cleanSecretCode(value) {
    return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  }

  function renderVisibilityControls() {
    const selectedValue = mobileEditorMedia.matches && draft.secretShowEnabled ? 'secret' : draft.visibility;
    document.querySelectorAll('input[name="owner_visibility"]').forEach(input => {
      input.checked = input.value === selectedValue;
      input.disabled = !mobileEditorMedia.matches && (input.value === 'secret' || (input.value === 'public' && draft.secretShowEnabled));
    });
    $('owner-secret-note').hidden = !draft.secretShowEnabled;
    const secretFields = $('owner-secret-fields');
    const showSecretFields = mobileEditorMedia.matches && draft.secretShowEnabled;
    secretFields.hidden = !showSecretFields;
    const hasNewCode = Boolean($('owner-secret-code').value || $('owner-secret-code-confirm').value);
    const codeRequired = showSecretFields && (!saved.secretShowEnabled || hasNewCode);
    $('owner-secret-code').required = codeRequired;
    $('owner-secret-code-confirm').required = codeRequired;
    $('owner-secret-help').textContent = saved.secretShowEnabled
      ? 'A code is already set. Leave both fields blank to keep it, or enter a new code twice.'
      : 'Choose a six-character code. Guests will need it to open the event.';
  }

  function setVisibilityMode(value) {
    if (value === 'secret') {
      draft.visibility = 'private';
      draft.secretShowEnabled = true;
    } else {
      draft.visibility = value === 'private' ? 'private' : 'public';
      draft.secretShowEnabled = false;
      draft.secretCode = '';
      draft.secretCodeConfirm = '';
      $('owner-secret-code').value = '';
      $('owner-secret-code-confirm').value = '';
      $('owner-secret-code-confirm').setCustomValidity('');
    }
    renderVisibilityControls();
    syncDirtyState();
  }

  function setOwnerFlyerDesignerError(message) {
    const input = $('owner-flyer-designer-instagram');
    const error = $('owner-flyer-designer-instagram-error');
    input.setAttribute('aria-invalid', String(Boolean(message)));
    error.textContent = message || '';
    error.hidden = !message;
  }

  function validateOwnerFlyerDesignerHandle({ normalize = false } = {}) {
    const input = $('owner-flyer-designer-instagram');
    const parsed = cleanInstagramHandleInput(input.value);
    setOwnerFlyerDesignerError(parsed.error);
    if (!parsed.error && normalize) {
      input.value = parsed.value ? `@${parsed.value}` : '';
      draft.flyerDesignerInstagramHandle = parsed.value || '';
      previewFlyerDesignCredit();
      syncDirtyState();
    }
    return parsed;
  }

  function previewFlyerDesignCredit() {
    const existingCredit = document.querySelector('.flyer-design-credit');
    if (draft.presentationMode !== 'flyer') {
      if (existingCredit) existingCredit.hidden = true;
      return;
    }
    const poster = document.querySelector('.flyer-poster, .col-media');
    if (!poster) return;
    const parsed = cleanInstagramHandleInput(draft.flyerDesignerInstagramHandle);
    const designerName = String(draft.flyerDesignerName || '').trim();
    let credit = poster.querySelector('.flyer-design-credit');
    if (!credit && (parsed.value || designerName)) {
      credit = document.createElement('p');
      credit.className = 'flyer-design-credit';
      poster.appendChild(credit);
    }
    if (!credit) return;
    credit.replaceChildren();
    credit.hidden = !(parsed.value || designerName);
    if (parsed.value) {
      credit.append('Design by ');
      const link = document.createElement('a');
      link.href = `https://www.instagram.com/${encodeURIComponent(parsed.value)}/`;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = `@${parsed.value}`;
      credit.appendChild(link);
    } else if (designerName) {
      credit.textContent = `Design by ${designerName}`;
    }
  }

  function previewPresentation() {
    const flyer = draft.presentationMode === 'flyer';
    document.body.classList.toggle('owner-preview-flyer', flyer);
    document.body.classList.toggle('owner-preview-standard', !flyer);
    const hero = $('hero');
    if (hero) {
      hero.classList.toggle('flyer-hero', flyer);
      hero.classList.toggle('standard-hero', !flyer);
    }
    previewFlyerDesignCredit();
  }

  function updateAdaptiveSwatch(colors) {
    const swatch = document.querySelector('.owner-theme-adaptive');
    if (!swatch) return;
    if (!colors?.length) {
      ['--owner-adaptive-a', '--owner-adaptive-b', '--owner-adaptive-c'].forEach(property => swatch.style.removeProperty(property));
      return;
    }
    swatch.style.setProperty('--owner-adaptive-a', window.SGArtworkColor.rgba(colors[0], .82));
    swatch.style.setProperty('--owner-adaptive-b', window.SGArtworkColor.rgba(colors[1] || colors[0], .68));
    swatch.style.setProperty('--owner-adaptive-c', window.SGArtworkColor.rgba(colors[2] || colors[0], .52));
  }

  async function applyArtworkPalette(url, { pageBackground = draft.backgroundTheme === 'adaptive' } = {}) {
    if (!url || draft.presentationMode === 'flyer' || effectKeys.includes(draft.backgroundTheme) || !window.SGArtworkColor) return;
    try {
      const colors = window.SGArtworkColor.paletteForBackground(await window.SGArtworkColor.extractPalette(url));
      const activeUrl = draft.presentationMode === 'flyer' ? draft.flyerImageUrl : draft.coverImageUrl;
      if (url !== activeUrl) return;
      updateAdaptiveSwatch(colors);
      const hero = $('hero');
      if (hero) {
        hero.style.setProperty('--hero-bg-a', window.SGArtworkColor.rgba(colors[0], .76));
        hero.style.setProperty('--hero-bg-b', window.SGArtworkColor.rgba(colors[1], .62));
        hero.style.setProperty('--hero-bg-c', window.SGArtworkColor.rgba(colors[2] || colors[0], .54));
        hero.classList.add('image-palette');
      }
      if (pageBackground && draft.backgroundTheme === 'adaptive') {
        const background = document.querySelector('.event-bg');
        if (background) {
          background.style.setProperty('--event-bg-a', window.SGArtworkColor.rgba(colors[0], .82));
          background.style.setProperty('--event-bg-b', window.SGArtworkColor.rgba(colors[1] || colors[0], .68));
          background.style.setProperty('--event-bg-c', window.SGArtworkColor.rgba(colors[2] || colors[0], .52));
          background.classList.add('image-palette');
        }
      }
    } catch (_) {
      // The selected theme remains a reliable fallback if the image blocks sampling.
    }
  }

  function previewImage({ resolveAutoFit = false } = {}) {
    const url = draft.presentationMode === 'flyer' ? draft.flyerImageUrl : draft.coverImageUrl;
    const hero = $('hero');
    if (!hero) return;
    let image = hero.querySelector('img');
    if (url) {
      if (!image) {
        image = document.createElement('img');
        image.alt = draft.presentationMode === 'flyer' ? `${draft.title} flyer` : '';
        hero.appendChild(image);
      }
      image.src = url;
      hero.classList.remove('no-image');
      if (draft.presentationMode === 'standard') {
        const resolveShape = () => {
          if (resolveAutoFit) defaultCoverFitFromImage(image);
          const portrait = image.naturalHeight > image.naturalWidth;
          hero.classList.toggle('cover-image-portrait', portrait);
          hero.classList.toggle('cover-fit-resolved-cover', draft.coverFitMode === 'auto' && !portrait);
        };
        if (image.complete) resolveShape();
        else image.addEventListener('load', resolveShape, { once: true });
      }
      applyArtworkPalette(url);
    } else {
      image?.remove();
      hero.classList.add('no-image');
      if (draft.backgroundTheme === 'adaptive') document.querySelector('.event-bg')?.classList.remove('image-palette');
    }
    updateOwnerImageCard(url);
    const credit = document.querySelector('.photo-credit');
    if (credit) {
      credit.hidden = draft.presentationMode !== 'standard' || !draft.coverCreditName;
      if (draft.presentationMode === 'standard' && draft.coverCreditName) {
        credit.textContent = `Photo by ${draft.coverCreditName} on Unsplash`;
      }
    }
    previewFlyerDesignCredit();
  }

  function videoEffectUrl(publicId, format) {
    const transform = format === 'jpg'
      ? 'so_0,f_jpg,q_auto,w_1600'
      : 'f_mp4,vc_h264,q_auto:eco,w_1280,c_limit,fl_progressive';
    return `https://res.cloudinary.com/dhvavjgnw/video/upload/${transform}/${publicId}.${format}`;
  }

  function mountPreviewVideo(theme, background) {
    const publicId = videoEffects[theme];
    if (!publicId) return;

    let video = background.querySelector(`.fx-video-media[data-effect-theme="${theme}"]`);
    if (!video) {
      video = document.createElement('video');
      video.className = 'fx-video-media';
      video.dataset.effectTheme = theme;
      video.dataset.ownerPreview = 'true';
      video.autoplay = true;
      video.muted = true;
      video.defaultMuted = true;
      video.loop = true;
      video.playsInline = true;
      video.preload = 'auto';
      video.poster = videoEffectUrl(publicId, 'jpg');
      video.src = videoEffectUrl(publicId, 'mp4');
      video.setAttribute('aria-hidden', 'true');
      video.tabIndex = -1;
      background.appendChild(video);
    }

    video.hidden = false;
    video.muted = true;
    video.defaultMuted = true;
    const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const saveData = Boolean(navigator.connection?.saveData);
    if (reduceMotion || saveData) {
      video.pause();
      video.classList.remove('is-playing');
      return;
    }
    const seamlessLoop = seamlessVideoEffects.has(theme)
      ? window.SGSeamlessVideoLoop?.attach(video)
      : null;

    if (!video.dataset.ownerPlaybackBound) {
      const reveal = () => {
        if (draft.backgroundTheme === video.dataset.effectTheme && !video.hidden) video.classList.add('is-playing');
      };
      video.addEventListener('playing', reveal);
      video.addEventListener('loadeddata', () => { if (!video.paused) reveal(); });
      video.dataset.ownerPlaybackBound = 'true';
    }
    (seamlessLoop ? seamlessLoop.play() : video.play()).then(() => {
      if (draft.backgroundTheme === theme && video.isConnected) video.classList.add('is-playing');
    }).catch(() => {
      // The CSS poster remains visible if autoplay is blocked.
    });
  }

  function mountPreviewStatic(background) {
    let canvas = background.querySelector('.fx-static-canvas[data-effect-theme="static"]');
    if (canvas) {
      canvas.hidden = false;
      return;
    }

    canvas = document.createElement('canvas');
    canvas.className = 'fx-static-canvas';
    canvas.dataset.effectTheme = 'static';
    canvas.dataset.ownerPreview = 'true';
    canvas.width = 220;
    canvas.height = 140;
    background.appendChild(canvas);
    const context = canvas.getContext('2d');
    if (!context) return;
    const draw = () => {
      const image = context.createImageData(canvas.width, canvas.height);
      for (let index = 0; index < image.data.length; index += 4) {
        const value = Math.random() * 255 | 0;
        image.data[index] = image.data[index + 1] = image.data[index + 2] = value;
        image.data[index + 3] = 255;
      }
      context.putImageData(image, 0, 0);
    };
    draw();
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let lastFrame = 0;
    const animate = timestamp => {
      if (!canvas.isConnected || draft.backgroundTheme !== 'static') return;
      if (timestamp - lastFrame > 66) {
        draw();
        lastFrame = timestamp;
      }
      requestAnimationFrame(animate);
    };
    requestAnimationFrame(animate);
  }

  function syncEffectMedia(theme, background) {
    background.querySelectorAll('.fx-video-media').forEach(video => {
      const selected = video.dataset.effectTheme === theme;
      video.hidden = !selected;
      if (!selected) {
        video.pause();
        video.classList.remove('is-playing');
        if (video.dataset.ownerPreview) video.remove();
      }
    });
    background.querySelectorAll('.fx-static-canvas').forEach(canvas => {
      const selected = theme === 'static';
      canvas.hidden = !selected;
      if (!selected && canvas.dataset.ownerPreview) canvas.remove();
    });

    if (videoEffects[theme]) mountPreviewVideo(theme, background);
    else if (theme === 'static') mountPreviewStatic(background);
  }

  function previewTheme(theme) {
    draft.backgroundTheme = themeKeys.includes(theme) ? theme : 'midnight';
    const background = document.querySelector('.event-bg');
    if (background) {
      background.classList.remove('image-palette', ...themeKeys.flatMap(key => [`bg-${key}`, `fx-${key}`]));
      const themeClass = effectKeys.includes(draft.backgroundTheme) ? `fx-${draft.backgroundTheme}` : `bg-${draft.backgroundTheme}`;
      background.classList.add('bg-theme', themeClass);
      syncEffectMedia(draft.backgroundTheme, background);
    }
    const veil = $('event-fx-veil');
    if (veil) {
      veil.hidden = !effectKeys.includes(draft.backgroundTheme);
      veil.className = `fx-veil${draft.backgroundTheme === 'paper' ? ' fx-veil-soft' : ''}${draft.backgroundTheme === 'saloon' ? ' fx-veil-warm' : ''}`;
    }
    document.querySelectorAll('[data-owner-theme]').forEach(button => {
      button.setAttribute('aria-pressed', String(button.dataset.ownerTheme === draft.backgroundTheme));
    });
    if (draft.backgroundTheme === 'adaptive') applyArtworkPalette(draft.coverImageUrl, { pageBackground: true });
  }

  function populate() {
    $('owner-title').value = draft.title;
    $('owner-description').value = draft.description;
    $('owner-date').value = draft.eventDate;
    $('owner-start-time').value = draft.startTime;
    populateOwnerLocation();
    $('owner-category').value = draft.category;
    $('owner-capacity').value = draft.capacity == null ? '' : draft.capacity;
    $('owner-show-guests').checked = draft.showGuestList;
    $('owner-allow-guests').checked = draft.allowGuests;
    $('owner-comments').checked = draft.commentsEnabled;
    $('owner-ticket-price').value = draft.ticketPrice == null ? '' : draft.ticketPrice;
    $('owner-ticket-url').value = draft.ticketUrl;
    $('owner-flyer-designer-name').value = draft.flyerDesignerName;
    const flyerInstagram = cleanInstagramHandleInput(draft.flyerDesignerInstagramHandle).value;
    $('owner-flyer-designer-instagram').value = flyerInstagram ? `@${flyerInstagram}` : '';
    $('owner-secret-code').value = draft.secretCode || '';
    $('owner-secret-code-confirm').value = draft.secretCodeConfirm || '';
    setOwnerFlyerDesignerError('');
    renderPresentationControls();
    renderAdmissionControls();
    renderVisibilityControls();
    syncMobileAppearanceSections();
    setCoverFit(draft.coverFitMode);
    previewPresentation();
    previewDetails();
    previewImage();
    previewTheme(draft.backgroundTheme);
    previewGuestSettings();
    previewAdmission();
    syncDirtyState();
  }

  function renderActivePanel({ focus = false } = {}) {
    document.querySelectorAll('[data-owner-tab]').forEach(button => {
      const active = button.dataset.ownerTab === activeTab;
      button.setAttribute('aria-selected', String(active));
      button.tabIndex = active ? 0 : -1;
      if (active && focus) button.focus();
    });
    document.querySelectorAll('[data-owner-panel]').forEach(panel => { panel.hidden = panel.dataset.ownerPanel !== activeTab; });
    document.querySelector('.owner-editor-scroll').scrollTop = 0;
    if (activeTab === 'details') initVenueAutocomplete();
  }

  function openMobileView(name, { focus = true, returnFocus = null } = {}) {
    const view = mobileViews[name] || mobileViews.appearance;
    if (!mobileEditorMedia.matches) {
      activeTab = view.panel;
      renderActivePanel({ focus });
      return;
    }
    if (returnFocus) mobileReturnFocus = returnFocus;
    if (name !== 'appearance') closePhotoBrowser();
    setMobileViewStatus('');
    activeMobileView = mobileViews[name] ? name : 'appearance';
    activeTab = view.panel;
    $('owner-mobile-hub').hidden = true;
    $('owner-mobile-screen-head').hidden = false;
    $('owner-mobile-view-title').textContent = view.title;
    $('owner-mobile-view-helper').textContent = view.helper || '';
    const guidedIndex = mobileDraftSequence.indexOf(activeMobileView);
    const previousView = mobileGuidedFlow && guidedIndex > 0
      ? mobileViews[mobileDraftSequence[guidedIndex - 1]]
      : (view.parent ? mobileViews[view.parent] : null);
    $('owner-mobile-nav-back').setAttribute('aria-label', previousView ? `Back to ${previousView.title}` : 'Back to event setup');
    $('owner-mobile-view-eyebrow').textContent = mobileGuidedFlow && guidedIndex >= 0
      ? `Step ${guidedIndex + 1} of ${mobileDraftSequence.length}${view.optional ? ' · Optional' : ''}`
      : 'Edit event';
    $('owner-mobile-done').textContent = mobileGuidedFlow
      ? (guidedIndex === mobileDraftSequence.length - 1 ? 'Review event' : 'Next')
      : 'Done';
    $('owner-mobile-action').hidden = false;
    editor.classList.add('is-mobile-subview');
    document.querySelectorAll('[data-owner-tab]').forEach(button => {
      const active = button.dataset.ownerTab === activeTab;
      button.setAttribute('aria-selected', String(active));
      button.tabIndex = active ? 0 : -1;
    });
    document.querySelectorAll('[data-owner-panel]').forEach(panel => {
      panel.hidden = panel.dataset.ownerPanel !== activeTab;
    });
    document.querySelectorAll('[data-owner-mobile-section]').forEach(section => {
      section.hidden = activeTab === 'settings' && section.dataset.ownerMobileSection !== view.section;
    });
    if (activeMobileView === 'visibility') renderVisibilityControls();
    syncMobileAppearanceSections(activeMobileView);
    document.querySelector('.owner-editor-scroll').scrollTop = 0;
    if (activeTab === 'details') initVenueAutocomplete();
    if (focus) setTimeout(() => $('owner-mobile-view-title').focus({ preventScroll: true }), 0);
  }

  function showMobileHub({ focus = true } = {}) {
    if (!mobileEditorMedia.matches) return;
    mobileGuidedFlow = false;
    activeMobileView = 'hub';
    closePhotoBrowser();
    setMobileViewStatus('');
    renderVisibilityControls();
    updateMobileSummaries();
    $('owner-mobile-hub').hidden = false;
    $('owner-mobile-screen-head').hidden = true;
    $('owner-mobile-action').hidden = true;
    $('owner-mobile-nav-back').setAttribute('aria-label', 'Close event editor');
    editor.classList.remove('is-mobile-subview');
    editor.dataset.mobileView = 'hub';
    document.querySelectorAll('[data-owner-panel]').forEach(panel => { panel.hidden = true; });
    document.querySelectorAll('[data-owner-mobile-section]').forEach(section => { section.hidden = false; });
    document.querySelector('.owner-editor-scroll').scrollTop = 0;
    if (!focus) return;
    const target = mobileReturnFocus instanceof HTMLElement && mobileReturnFocus.isConnected && mobileReturnFocus.closest('#owner-mobile-hub')
      ? mobileReturnFocus
      : $('owner-mobile-hub-title');
    setTimeout(() => target.focus({ preventScroll: true }), 0);
  }

  function activateTab(name, { focus = false } = {}) {
    activeTab = ['appearance', 'details', 'settings'].includes(name) ? name : 'appearance';
    if (mobileEditorMedia.matches) {
      openMobileView(activeTab === 'settings' ? 'admission' : activeTab, { focus });
      return;
    }
    $('owner-mobile-hub').hidden = true;
    $('owner-mobile-screen-head').hidden = true;
    $('owner-mobile-action').hidden = true;
    editor.classList.remove('is-mobile-subview');
    editor.removeAttribute('data-mobile-view');
    document.querySelectorAll('[data-owner-mobile-section]').forEach(section => { section.hidden = false; });
    syncMobileAppearanceSections();
    renderActivePanel({ focus });
  }

  function resetPreviewPeek() {
    editor.classList.remove('is-peeking');
    editor.setAttribute('aria-modal', 'true');
    document.body.classList.remove('owner-editor-peeking');
    $('owner-editor-peek').textContent = 'Preview';
    $('owner-editor-peek').setAttribute('aria-expanded', 'true');
  }

  function openEditor() {
    lastFocus = document.activeElement;
    editor.classList.add('is-open');
    resetPreviewPeek();
    editor.setAttribute('aria-hidden', 'false');
    trigger.setAttribute('aria-expanded', 'true');
    document.body.classList.add('owner-editor-open');
    document.body.classList.remove('owner-editor-peeking');
    startEditorFieldSync();
    if (mobileEditorMedia.matches) {
      if (activeMobileView === 'hub') showMobileHub();
      else openMobileView(activeMobileView);
    } else {
      setTimeout(() => document.querySelector(`[data-owner-tab="${activeTab}"]`)?.focus(), 0);
    }
  }

  function restoreSavedPreview() {
    draft = clone(saved);
    populate();
    closePhotoBrowser();
  }

  function closeEditor({ confirmDiscard = true } = {}) {
    reconcileEditorFields();
    if (confirmDiscard && isDirty() && !window.confirm('Discard your unsaved event changes?')) return;
    if (isDirty()) restoreSavedPreview();
    stopEditorFieldSync();
    editor.classList.remove('is-open');
    resetPreviewPeek();
    editor.setAttribute('aria-hidden', 'true');
    trigger.setAttribute('aria-expanded', 'false');
    document.body.classList.remove('owner-editor-open', 'owner-editor-peeking');
    if (mobileEditorMedia.matches) {
      showMobileHub({ focus: false });
      mobileReturnFocus = null;
      mobileNestedReturnFocus = null;
    }
    (lastFocus instanceof HTMLElement ? lastFocus : trigger).focus({ preventScroll: true });
  }

  function openPhotoBrowser() {
    $('owner-photo-browser').hidden = false;
    $('owner-panel-appearance').classList.add('is-photo-browser');
    if (mobileEditorMedia.matches) {
      $('owner-mobile-view-title').textContent = 'Free photos';
      $('owner-mobile-view-helper').textContent = 'Choose an image, then return to finish the appearance.';
      $('owner-mobile-action').hidden = true;
      $('owner-mobile-nav-back').setAttribute('aria-label', 'Back to Appearance');
    }
    $('owner-photo-query').focus();
    if (!photosReady) {
      renderPhotoCategories();
      loadPhotos(photoQuery, { category: photoCategory });
    }
  }

  function closePhotoBrowser() {
    $('owner-photo-browser').hidden = true;
    $('owner-panel-appearance').classList.remove('is-photo-browser');
    if (mobileEditorMedia.matches && activeMobileView !== 'hub') {
      const view = mobileViews[activeMobileView] || mobileViews.appearance;
      $('owner-mobile-view-title').textContent = view.title;
      $('owner-mobile-view-helper').textContent = view.helper || '';
      $('owner-mobile-action').hidden = false;
    }
  }

  function renderPhotoCategories() {
    const host = $('owner-photo-categories');
    host.innerHTML = '';
    photoCategories.forEach(([label, query]) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'owner-photo-category';
      button.textContent = label;
      button.setAttribute('aria-pressed', String(label === photoCategory));
      button.addEventListener('click', () => loadPhotos(query, { category: label }));
      host.appendChild(button);
    });
  }

  function renderPhotos(photos, { append = false } = {}) {
    const grid = $('owner-photo-grid');
    if (!append) grid.innerHTML = '';
    photos.forEach(photo => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'owner-photo';
      button.setAttribute('aria-label', `Use photo by ${photo.credit_name}`);
      button.setAttribute('aria-pressed', String(photo.full === draft.coverImageUrl));
      const image = document.createElement('img');
      image.src = photo.thumb;
      image.alt = '';
      image.loading = 'lazy';
      button.appendChild(image);
      button.addEventListener('click', () => {
        draft.coverImageUrl = photo.full;
        draft.coverCreditName = photo.credit_name || '';
        draft.coverCreditLink = photo.credit_link || '';
        draft.artworkAccentColor = '';
        setCoverFit('auto');
        previewImage({ resolveAutoFit: true });
        syncDirtyState();
        closePhotoBrowser();
        request('/api/photos/track', { method: 'POST', body: { download_location: photo.download_location } }).catch(() => {});
      });
      grid.appendChild(button);
    });
  }

  async function loadPhotos(query, { category = '', page = 1, append = false } = {}) {
    if (photoLoading) return;
    photoLoading = true;
    photoQuery = query;
    photoCategory = category;
    photoPage = page;
    $('owner-photo-status').textContent = append ? 'Loading more photos…' : 'Loading photos…';
    $('owner-photo-more').disabled = true;
    document.querySelectorAll('.owner-photo-category').forEach(button => {
      button.setAttribute('aria-pressed', String(button.textContent === photoCategory));
    });
    try {
      const data = await request(`/api/photos/search?q=${encodeURIComponent(query)}&page=${page}&per_page=12`);
      const photos = data.results || [];
      photoTotalPages = data.totalPages || 1;
      renderPhotos(photos, { append });
      $('owner-photo-status').textContent = photos.length ? (category || `Results for “${query}”`) : 'No photos found. Try another search.';
      photosReady = true;
    } catch (error) {
      if (!append) $('owner-photo-grid').innerHTML = '';
      $('owner-photo-status').textContent = error.message;
      photoTotalPages = photoPage;
    } finally {
      photoLoading = false;
      $('owner-photo-more').hidden = photoPage >= photoTotalPages;
      $('owner-photo-more').disabled = false;
    }
  }

  async function uploadImage(file) {
    if (!file) return;
    const status = $('owner-upload-status');
    status.textContent = 'Uploading image…';
    const body = new FormData();
    body.append('image', file);
    try {
      const response = await fetch(draft.presentationMode === 'flyer' ? '/api/uploads/flyer' : '/api/uploads/cover', {
        method: 'POST', credentials: 'same-origin', body
      });
      if (response.status === 401) {
        location.href = `/login?next=${encodeURIComponent(location.pathname + location.search)}`;
        return;
      }
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Upload failed.');
      if (draft.presentationMode === 'flyer') draft.flyerImageUrl = data.url;
      else {
        draft.coverImageUrl = data.url;
        draft.coverCreditName = '';
        draft.coverCreditLink = '';
        setCoverFit('auto');
      }
      draft.artworkAccentColor = data.accentColor || '';
      previewImage({ resolveAutoFit: draft.presentationMode === 'standard' });
      $('owner-fit-field').hidden = draft.presentationMode === 'flyer' || !draft.coverImageUrl;
      status.textContent = 'Image ready to save.';
      syncDirtyState();
    } catch (error) {
      status.textContent = error.message;
    } finally {
      $('owner-image-input').value = '';
    }
  }

  function readInputs() {
    draft.presentationMode = document.querySelector('input[name="owner_presentation_mode"]:checked')?.value || saved.presentationMode;
    draft.title = $('owner-title').value.trim();
    draft.description = $('owner-description').value.trim();
    draft.eventDate = $('owner-date').value;
    draft.startTime = $('owner-start-time').value;
    draft.category = $('owner-category').value;
    draft.capacity = $('owner-capacity').value ? Number($('owner-capacity').value) : null;
    const visibilityChoice = document.querySelector('input[name="owner_visibility"]:checked')?.value || saved.visibility;
    if (mobileEditorMedia.matches) {
      draft.secretShowEnabled = visibilityChoice === 'secret';
      draft.visibility = visibilityChoice === 'public' ? 'public' : 'private';
    } else {
      draft.visibility = visibilityChoice === 'private' ? 'private' : 'public';
    }
    draft.secretCode = cleanSecretCode($('owner-secret-code').value);
    draft.secretCodeConfirm = cleanSecretCode($('owner-secret-code-confirm').value);
    draft.showGuestList = $('owner-show-guests').checked;
    draft.allowGuests = $('owner-allow-guests').checked;
    draft.commentsEnabled = $('owner-comments').checked;
    draft.admissionType = document.querySelector('input[name="owner_admission"]:checked')?.value || saved.admissionType;
    draft.ticketPrice = $('owner-ticket-price').value ? Number($('owner-ticket-price').value) : null;
    draft.ticketUrl = $('owner-ticket-url').value.trim();
    if (draft.presentationMode === 'flyer') {
      draft.flyerDesignerName = $('owner-flyer-designer-name').value.trim();
      const flyerInstagramRaw = $('owner-flyer-designer-instagram').value.trim();
      const flyerInstagram = cleanInstagramHandleInput(flyerInstagramRaw);
      draft.flyerDesignerInstagramHandle = flyerInstagram.error ? flyerInstagramRaw : (flyerInstagram.value || '');
      previewFlyerDesignCredit();
    }
    previewDetails();
    previewGuestSettings();
    renderAdmissionControls();
    renderVisibilityControls();
    syncDirtyState();
  }

  function payload() {
    const body = {
      title: draft.title,
      description: draft.description,
      event_date: draft.eventDate,
      start_time: draft.startTime,
      venue_name: draft.venueName,
      venue_address: draft.venueAddress,
      venue_city: draft.venueCity || null,
      venue_state: draft.venueState || null,
      venue_latitude: draft.venueLatitude,
      venue_longitude: draft.venueLongitude,
      google_place_id: draft.googlePlaceId || null,
      category: draft.category || null,
      capacity: draft.capacity,
      visibility: draft.visibility,
      secret_show_enabled: draft.secretShowEnabled,
      sms_reminder_enabled: draft.secretShowEnabled ? false : draft.smsReminderEnabled,
      show_guest_list: draft.showGuestList,
      allow_guests: draft.allowGuests,
      comments_enabled: draft.commentsEnabled,
      presentation_mode: draft.presentationMode,
      admission_type: draft.admissionType,
      ticket_price: draft.admissionType === 'external_tickets' ? draft.ticketPrice : null,
      ticket_url: draft.admissionType === 'external_tickets' ? (draft.ticketUrl || null) : null,
      commerce_event_id: draft.admissionType === 'silver_glider_tickets' ? (draft.commerceEventId || null) : null,
      background_theme: draft.backgroundTheme,
      artwork_accent_color: draft.artworkAccentColor || null
    };
    if (draft.secretShowEnabled && draft.secretCode) {
      body.secret_code = draft.secretCode;
      body.secret_code_confirm = draft.secretCodeConfirm;
    }
    if (draft.presentationMode === 'flyer') Object.assign(body, {
      flyer_image_url: draft.flyerImageUrl || null,
      flyer_designer_name: draft.flyerDesignerName || null,
      flyer_designer_instagram_handle: cleanInstagramHandleInput(draft.flyerDesignerInstagramHandle).value
    });
    else Object.assign(body, {
      cover_image_url: draft.coverImageUrl || null,
      cover_fit_mode: draft.coverFitMode,
      cover_credit_name: draft.coverCreditName || null,
      cover_credit_link: draft.coverCreditLink || null
    });
    return body;
  }

  trigger.addEventListener('click', openEditor);
  $('owner-editor-close').addEventListener('click', () => closeEditor());
  $('owner-editor-cancel').addEventListener('click', () => closeEditor({ confirmDiscard: false }));
  document.querySelectorAll('[data-owner-mobile-view]').forEach(button => {
    button.addEventListener('click', () => {
      const targetView = button.dataset.ownerMobileView;
      if (mobileViews[targetView]?.parent) {
        mobileNestedReturnFocus = button;
        openMobileView(targetView);
      } else {
        mobileGuidedFlow = false;
        openMobileView(targetView, { returnFocus: button });
      }
    });
  });
  function navigateMobileBack() {
    if (editor.classList.contains('is-peeking')) {
      resetPreviewPeek();
      const view = mobileViews[activeMobileView];
      $('owner-mobile-nav-back').setAttribute('aria-label', view ? 'Back to event setup' : 'Close event editor');
      return;
    }
    reconcileEditorFields();
    if (!$('owner-photo-browser').hidden) {
      closePhotoBrowser();
      const view = mobileViews[activeMobileView] || mobileViews.appearance;
      $('owner-mobile-view-title').textContent = view.title;
      $('owner-mobile-view-helper').textContent = view.helper || '';
      $('owner-mobile-action').hidden = false;
      $('owner-mobile-nav-back').setAttribute('aria-label', 'Back to event setup');
      return;
    }
    const currentIndex = mobileDraftSequence.indexOf(activeMobileView);
    if (mobileGuidedFlow && currentIndex > 0) {
      openMobileView(mobileDraftSequence[currentIndex - 1]);
      return;
    }
    const parentView = mobileViews[activeMobileView]?.parent;
    if (parentView) {
      const returnTarget = mobileNestedReturnFocus;
      mobileNestedReturnFocus = null;
      openMobileView(parentView, { focus: false });
      if (returnTarget instanceof HTMLElement) setTimeout(() => returnTarget.focus({ preventScroll: true }), 0);
      return;
    }
    if (activeMobileView !== 'hub') showMobileHub();
    else closeEditor();
  }
  $('owner-mobile-nav-back').addEventListener('click', navigateMobileBack);
  $('owner-mobile-done').addEventListener('click', () => {
    reconcileEditorFields();
    const currentIndex = mobileDraftSequence.indexOf(activeMobileView);
    if (mobileGuidedFlow && currentIndex >= 0 && currentIndex < mobileDraftSequence.length - 1) {
      openMobileView(mobileDraftSequence[currentIndex + 1]);
      return;
    }
    const parentView = mobileViews[activeMobileView]?.parent;
    if (parentView) {
      const returnTarget = mobileNestedReturnFocus;
      mobileNestedReturnFocus = null;
      openMobileView(parentView, { focus: false });
      if (returnTarget instanceof HTMLElement) setTimeout(() => returnTarget.focus({ preventScroll: true }), 0);
    }
    else showMobileHub();
  });
  $('owner-editor-peek').addEventListener('click', () => {
    const peeking = editor.classList.toggle('is-peeking');
    editor.setAttribute('aria-modal', String(!peeking));
    document.body.classList.toggle('owner-editor-peeking', peeking);
    $('owner-editor-peek').textContent = peeking ? 'Continue editing' : 'Preview';
    $('owner-editor-peek').setAttribute('aria-expanded', String(!peeking));
    if (mobileEditorMedia.matches) $('owner-mobile-nav-back').setAttribute('aria-label', peeking ? 'Return to editing' : (activeMobileView === 'hub' ? 'Close event editor' : 'Back to event setup'));
  });

  document.querySelectorAll('[data-owner-tab]').forEach((button, index, buttons) => {
    button.addEventListener('click', () => activateTab(button.dataset.ownerTab));
    button.addEventListener('keydown', event => {
      let next = index;
      if (event.key === 'ArrowRight') next = (index + 1) % buttons.length;
      else if (event.key === 'ArrowLeft') next = (index - 1 + buttons.length) % buttons.length;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = buttons.length - 1;
      else return;
      event.preventDefault();
      activateTab(buttons[next].dataset.ownerTab, { focus: true });
    });
  });

  form.addEventListener('input', readInputs);
  form.addEventListener('change', readInputs);
  $('owner-flyer-designer-instagram').addEventListener('input', () => setOwnerFlyerDesignerError(''));
  $('owner-flyer-designer-instagram').addEventListener('blur', () => validateOwnerFlyerDesignerHandle({ normalize: true }));
  $('owner-location-search').addEventListener('input', () => {
    if (applyingPlace) return;
    locationKind = null;
    draft.venueName = '';
    draft.venueAddress = '';
    $('owner-location-name').value = '';
    clearPlaceMeta();
    renderOwnerLocation();
    previewDetails();
    syncDirtyState();
    setPlacesStatus($('owner-location-search').value.trim() ? 'Choose a suggestion or enter the address manually.' : '');
  });
  $('owner-location-manual-address').addEventListener('input', syncOwnerManualLocation);
  $('owner-location-name').addEventListener('input', () => {
    if (locationKind !== 'address') return;
    draft.venueName = $('owner-location-name').value.trim() || LocationUtils.addressFallback(draft.venueAddress);
    locationChanged();
  });
  $('owner-location-manual-toggle').addEventListener('click', () => setOwnerManualLocationMode(true));
  $('owner-location-search-toggle').addEventListener('click', () => setOwnerManualLocationMode(false));
  $('owner-location-change').addEventListener('click', () => {
    if (manualLocationMode) {
      $('owner-location-manual-address').focus();
      $('owner-location-manual-address').select();
    } else {
      $('owner-location-search').focus();
      $('owner-location-search').select();
    }
  });
  document.querySelectorAll('[data-owner-theme]').forEach(button => button.addEventListener('click', () => {
    previewTheme(button.dataset.ownerTheme);
    syncDirtyState();
  }));
  document.querySelectorAll('input[name="owner_cover_fit"]').forEach(input => input.addEventListener('change', () => {
    setCoverFit(input.value);
    syncDirtyState();
  }));
  document.querySelectorAll('input[name="owner_presentation_mode"]').forEach(input => input.addEventListener('change', () => {
    setPresentationMode(input.value);
  }));
  document.querySelectorAll('input[name="owner_admission"]').forEach(input => input.addEventListener('change', () => {
    draft.admissionType = input.value;
    renderAdmissionControls();
    syncDirtyState();
  }));
  document.querySelectorAll('input[name="owner_visibility"]').forEach(input => input.addEventListener('change', () => {
    if (mobileEditorMedia.matches) setVisibilityMode(input.value);
  }));
  ['owner-secret-code', 'owner-secret-code-confirm'].forEach(id => {
    $(id).addEventListener('input', event => {
      const clean = cleanSecretCode(event.currentTarget.value);
      if (event.currentTarget.value !== clean) event.currentTarget.value = clean;
      draft.secretCode = cleanSecretCode($('owner-secret-code').value);
      draft.secretCodeConfirm = cleanSecretCode($('owner-secret-code-confirm').value);
      $('owner-secret-code-confirm').setCustomValidity(
        draft.secretCodeConfirm && draft.secretCode !== draft.secretCodeConfirm ? 'The two secret codes must match.' : ''
      );
      renderVisibilityControls();
      syncDirtyState();
    });
  });

  $('owner-upload-image').addEventListener('click', () => $('owner-image-input').click());
  const ownerImageCard = $('owner-image-card');
  ownerImageCard.addEventListener('click', () => $('owner-image-input').click());
  ownerImageCard.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); $('owner-image-input').click(); }
  });
  ownerImageCard.addEventListener('dragenter', event => {
    event.preventDefault();
    ownerImageCard.classList.add('is-dragging');
  });
  ownerImageCard.addEventListener('dragover', event => {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    ownerImageCard.classList.add('is-dragging');
  });
  ownerImageCard.addEventListener('dragleave', event => {
    if (!event.relatedTarget || !ownerImageCard.contains(event.relatedTarget)) {
      ownerImageCard.classList.remove('is-dragging');
    }
  });
  ownerImageCard.addEventListener('drop', event => {
    event.preventDefault();
    ownerImageCard.classList.remove('is-dragging');
    uploadImage(event.dataTransfer?.files?.[0]);
  });
  $('owner-image-input').addEventListener('change', () => uploadImage($('owner-image-input').files[0]));
  $('owner-remove-image').addEventListener('click', () => {
    if (draft.presentationMode === 'flyer') return;
    draft.coverImageUrl = '';
    draft.coverCreditName = '';
    draft.coverCreditLink = '';
    draft.artworkAccentColor = '';
    previewImage();
    $('owner-fit-field').hidden = true;
    syncDirtyState();
  });
  $('owner-browse-photos').addEventListener('click', openPhotoBrowser);
  $('owner-photo-back').addEventListener('click', closePhotoBrowser);
  $('owner-photo-search').addEventListener('click', () => {
    const query = $('owner-photo-query').value.trim();
    if (query) loadPhotos(query);
  });
  $('owner-photo-query').addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault();
      const query = event.currentTarget.value.trim();
      if (query) loadPhotos(query);
    }
  });
  $('owner-photo-more').addEventListener('click', () => loadPhotos(photoQuery, { category: photoCategory, page: photoPage + 1, append: true }));

  request('/api/commerce/config')
    .then(({ enabled, interest }) => {
      commerceEnabled = enabled === true;
      commerceConfigLoaded = true;
      commerceInterested = interest?.interested === true;
      renderCommerceInterest();
    })
    .catch(() => {});

  $('owner-commerce-interest-toggle')?.addEventListener('click', async event => {
    const button = event.currentTarget;
    const nextInterested = !commerceInterested;
    button.disabled = true;
    button.textContent = nextInterested ? 'Adding…' : 'Removing…';
    try {
      const { interest } = await request('/api/commerce/interest', {
        method: 'POST',
        body: { interested: nextInterested }
      });
      commerceInterested = interest?.interested === true;
      renderCommerceInterest();
      focusCommerceInterestConfirmation();
    } catch (error) {
      showToast(error.message || 'The waitlist could not be updated.');
      renderCommerceInterest();
    } finally {
      button.disabled = false;
    }
  });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    readInputs();
    setMobileViewStatus('');
    const publishing = isDraftEvent();
    if (draft.presentationMode === 'flyer') {
      const flyerInstagram = validateOwnerFlyerDesignerHandle({ normalize: true });
      if (flyerInstagram.error) {
        showEditorValidation(flyerInstagram.error, 'designer', $('owner-flyer-designer-instagram'));
        return;
      }
      if (!draft.flyerImageUrl) {
        showEditorValidation('Upload a flyer before saving the Flyer layout.', 'appearance', $('owner-upload-image'));
        return;
      }
    }
    if (draft.admissionType === 'external_tickets' && (!Number.isFinite(draft.ticketPrice) || draft.ticketPrice <= 0)) {
      showEditorValidation('Add the external ticket price before saving.', 'admission', $('owner-ticket-price'), { report: true });
      return;
    }
    if (draft.secretShowEnabled && draft.secretCode !== draft.secretCodeConfirm) {
      $('owner-secret-code-confirm').setCustomValidity('The two secret codes must match.');
      showEditorValidation('Enter the same secret code twice.', 'visibility', $('owner-secret-code-confirm'), { report: true });
      return;
    }
    if (!draft.title) {
      showEditorValidation('Add an event title before saving.', 'details', $('owner-title'));
      return;
    }
    const invalidControl = Array.from(form.elements).find(control => control.willValidate && !control.validity.valid);
    if (invalidControl) {
      const message = invalidControl.validationMessage || 'Check this field before saving.';
      showEditorValidation(message, mobileViewForControl(invalidControl), invalidControl, { report: true });
      return;
    }
    if ((!draft.venueName && !draft.venueAddress) || (manualLocationMode && !draft.venueAddress)) {
      const locationMessage = manualLocationMode
        ? 'Add an address for this location.'
        : 'Choose a venue or address, or enter the location manually.';
      const locationControl = manualLocationMode ? $('owner-location-manual-address') : $('owner-location-search');
      setPlacesStatus(locationMessage);
      showEditorValidation(locationMessage, 'details', locationControl);
      return;
    }
    saveButton.disabled = true;
    saveButton.textContent = publishing ? 'Publishing…' : 'Saving…';
    saveStatus.textContent = publishing ? 'Preparing your event…' : 'Saving changes…';
    try {
      let data = {};
      if (isDirty()) {
        const body = payload();
        if (saved.rsvpCount > 0) {
          const changes = window.SGEEventChanges.compare(saved, draft);
          if (changes.length) {
            saveButton.textContent = 'Review changes…';
            saveStatus.textContent = 'Choose whether to notify your guests.';
            const choice = await window.SGEEventChanges.confirmUpdate({ changes, count: saved.rsvpCount });
            if (choice === 'cancel') {
              syncDirtyState();
              return;
            }
            body.notify_attendees = choice === 'notify';
            saveButton.textContent = 'Saving…';
            saveStatus.textContent = 'Saving changes…';
          }
        }
        data = await request(`/api/events/${EVENT.id}`, { method: 'PUT', body });
        saved = clone(draft);
      }
      if (publishing) {
        saveButton.textContent = 'Publishing…';
        saveStatus.textContent = 'Publishing your event…';
        await request(`/api/events/${EVENT.id}/publish`, { method: 'POST' });
        window.location.assign(`/events/${encodeURIComponent(EVENT.id)}/manage?created=1`);
        return;
      }
      sessionStorage.setItem('sge-owner-editor-reopen', EVENT.slug);
      sessionStorage.setItem('sge-owner-editor-saved', data.notification?.queued
        ? `Event updated. We’re notifying ${data.notification.queued} ${data.notification.queued === 1 ? 'guest' : 'guests'}.`
        : 'Event updated');
      location.reload();
    } catch (error) {
      saveButton.disabled = false;
      saveButton.textContent = primaryActionLabel();
      saveStatus.textContent = error.message;
    }
  });

  document.addEventListener('keydown', event => {
    if (!editor.classList.contains('is-open')) return;
    if (event.key === 'Tab' && mobileEditorMedia.matches && !editor.classList.contains('is-peeking')) {
      const focusable = Array.from(editor.querySelectorAll('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'))
        .filter(node => !node.closest('[hidden]') && node.getClientRects().length > 0);
      if (!focusable.length) {
        event.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || !editor.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !editor.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
      return;
    }
    if (event.key !== 'Escape') return;
    if (mobileEditorMedia.matches) navigateMobileBack();
    else if (!$('owner-photo-browser').hidden) closePhotoBrowser();
    else closeEditor();
  });
  window.addEventListener('beforeunload', event => {
    reconcileEditorFields();
    if (!isDirty()) return;
    event.preventDefault();
    event.returnValue = '';
  });

  function syncResponsiveEditorMode() {
    const editorIsOpen = editor.classList.contains('is-open');
    resetPreviewPeek();
    if (mobileEditorMedia.matches) {
      showMobileHub({ focus: editorIsOpen });
      return;
    }
    activeMobileView = 'hub';
    mobileGuidedFlow = false;
    $('owner-mobile-hub').hidden = true;
    $('owner-mobile-screen-head').hidden = true;
    $('owner-mobile-action').hidden = true;
    editor.classList.remove('is-mobile-subview');
    editor.removeAttribute('data-mobile-view');
    document.querySelectorAll('[data-owner-mobile-section]').forEach(section => { section.hidden = false; });
    renderVisibilityControls();
    syncMobileAppearanceSections();
    renderActivePanel({ focus: editorIsOpen });
  }

  if (typeof mobileEditorMedia.addEventListener === 'function') {
    mobileEditorMedia.addEventListener('change', syncResponsiveEditorMode);
  } else if (typeof mobileEditorMedia.addListener === 'function') {
    mobileEditorMedia.addListener(syncResponsiveEditorMode);
  }

  const requestedTab = new URLSearchParams(window.location.search).get('edit');
  const initialTab = ['appearance', 'details', 'settings'].includes(requestedTab) ? requestedTab : 'appearance';
  const reopenRequested = sessionStorage.getItem('sge-owner-editor-reopen') === EVENT.slug;
  const savedMessage = sessionStorage.getItem('sge-owner-editor-saved');
  populate();
  if (mobileEditorMedia.matches) {
    if (requestedTab) openMobileView(initialTab === 'settings' ? 'admission' : initialTab, { focus: false });
    else showMobileHub({ focus: false });
  } else {
    activateTab(initialTab);
  }
  if (requestedTab || reopenRequested) {
    sessionStorage.removeItem('sge-owner-editor-reopen');
    if (mobileEditorMedia.matches && reopenRequested && (!requestedTab || requestedTab === 'appearance') && !savedMessage && isDraftEvent()) {
      mobileGuidedFlow = true;
      openMobileView('appearance', { focus: false });
    }
    openEditor();
    sessionStorage.removeItem('sge-owner-editor-saved');
    if (savedMessage) setTimeout(() => showToast(savedMessage), 180);
  }
})();
