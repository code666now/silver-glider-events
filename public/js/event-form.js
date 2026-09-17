renderNav('events');

const editId = new URLSearchParams(location.search).get('id');
let visibility = 'public';
let admissionType = 'free_rsvp';
let commerceEnabled = false;
let commerceConfigLoaded = false;
let commerceEventId = null;
let commerceInterested = false;
let presentationMode = 'standard';
let coverFitMode = 'auto';
let hasSavedSecretCode = false;
let savedEventDetails = null;
let savedRsvpCount = 0;

const $ = id => document.getElementById(id);
const ArtworkColor = window.SGArtworkColor;
const LocationUtils = window.SGLocation;
const artworkAccents = new Map();
let artworkAccentPromise = Promise.resolve(null);
const mobileFlowMedia = window.matchMedia('(max-width: 879px)');
const mobileFlowTitles = {
  design: 'Appearance',
  designer: 'Designer credit',
  effects: 'Effects',
  basics: 'Event details',
  description: 'Description',
  vibe: 'Event vibe',
  admission: 'Admission',
  visibility: 'Visibility',
  capacity: 'Capacity',
  guests: 'Guest experience',
  reminders: 'Reminders'
};
const mobileFlowSubtitles = {
  design: 'Customize how your event looks to guests.',
  designer: 'Give the person who made your flyer a visible credit.',
  effects: 'Choose the atmosphere behind your event page.',
  basics: 'Start with the basics. You can always edit these later.',
  description: 'Tell guests what makes this event worth showing up for.',
  vibe: 'Add up to three artists, photos, and music links.',
  admission: 'Choose how guests can join your event.',
  visibility: 'Choose who can find and open your event.',
  capacity: 'Set a category and an optional guest limit.',
  guests: 'Choose how guests can participate on the event page.',
  reminders: 'Decide whether confirmed guests receive a day-before text.'
};
const mobileFlowParentViews = { designer: 'design', effects: 'design' };
const mobileCreateSequence = ['basics', 'design', 'admission', 'visibility'];
let mobileFlowView = 'hub';
let mobileFlowLastTrigger = null;
let mobileMoreDetailsWasOpen = null;
let mobileFlowDirty = false;
let mobileFlowBaseline = null;

function mobileFlowStateSignature() {
  const fields = Array.from($('event-form').elements)
    .filter(field => field.id)
    .map(field => [field.id, field.type === 'checkbox' || field.type === 'radio' ? field.checked : field.value]);
  return JSON.stringify({ fields, visibility, admissionType, presentationMode, coverFitMode, commerceEventId });
}

function resetMobileFlowBaseline() {
  mobileFlowBaseline = mobileFlowStateSignature();
  mobileFlowDirty = false;
}

function mobileFlowHasChanges() {
  return mobileFlowDirty || (mobileFlowBaseline !== null && mobileFlowBaseline !== mobileFlowStateSignature());
}

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

function setFlyerDesignerError(message) {
  const input = $('flyer-designer-instagram');
  const error = $('flyer-designer-instagram-error');
  input.setAttribute('aria-invalid', String(Boolean(message)));
  error.textContent = message || '';
  error.hidden = !message;
}

function normalizeFlyerDesignerHandle({ focus = false } = {}) {
  const input = $('flyer-designer-instagram');
  const parsed = cleanInstagramHandleInput(input.value);
  setFlyerDesignerError(parsed.error);
  if (parsed.error) {
    if (focus) input.focus();
    return parsed;
  }
  input.value = parsed.value ? `@${parsed.value}` : '';
  return parsed;
}

function updateAdaptiveThemeSwatch(colors) {
  const swatch = document.querySelector('.sg-swatch.fx-adaptive');
  if (!swatch) return;
  if (!colors?.length) {
    ['--adaptive-a', '--adaptive-b', '--adaptive-c'].forEach(property => swatch.style.removeProperty(property));
    return;
  }
  swatch.style.setProperty('--adaptive-a', ArtworkColor.rgba(colors[0], .82));
  swatch.style.setProperty('--adaptive-b', ArtworkColor.rgba(colors[1] || colors[0], .68));
  swatch.style.setProperty('--adaptive-c', ArtworkColor.rgba(colors[2] || colors[0], .52));
}

if (editId) {
  $('event-form').inert = true;
  $('event-form').setAttribute('aria-busy', 'true');
  $('publish-btn').disabled = true;
}

function finishEditLoading() {
  document.documentElement.classList.remove('event-edit-loading');
  $('event-edit-skeleton').removeAttribute('aria-label');
  $('event-form').inert = false;
  $('event-form').setAttribute('aria-busy', 'false');
  $('publish-btn').disabled = false;
  refreshMobileFlowHub();
  updateMobilePreviewAvailability();
  resetMobileFlowBaseline();
}

function showEditLoadError() {
  $('event-form').setAttribute('aria-busy', 'false');
  $('event-edit-skeleton').removeAttribute('aria-label');
  $('event-edit-skeleton').innerHTML = `<div class="event-edit-load-error"><h2>We couldn't load this event.</h2><p>Your event has not been changed. Try loading the editor again.</p><a class="sg-btn sg-btn-ghost" href="/events/${encodeURIComponent(editId)}/edit">Try again</a></div>`;
}

function setSecondVibeVisible(visible) {
  const secondChoice = $('vibe-choice-two');
  secondChoice.hidden = !visible;
  if (!visible) {
    setThirdVibeVisible(false);
    $('event_vibe_label_2').value = '';
    $('event_vibe_url_2').value = '';
    setVibePhoto(2, '');
  }
  syncVibeActions();
}

function setThirdVibeVisible(visible) {
  const thirdChoice = $('vibe-choice-three');
  thirdChoice.hidden = !visible;
  if (!visible) {
    $('event_vibe_label_3').value = '';
    $('event_vibe_url_3').value = '';
    setVibePhoto(3, '');
  }
  syncVibeActions();
}

function syncVibeActions() {
  const hasSecond = !$('vibe-choice-two').hidden;
  const hasThird = !$('vibe-choice-three').hidden;
  $('add-vibe-choice').hidden = hasSecond;
  $('remove-vibe-choice').hidden = !hasSecond || hasThird;
  $('add-third-vibe-choice').hidden = !hasSecond || hasThird;
  $('remove-third-vibe-choice').hidden = !hasThird;
  $('add-vibe-choice').setAttribute('aria-expanded', String(hasSecond));
  $('add-third-vibe-choice').setAttribute('aria-expanded', String(hasThird));
}

function setVibePhoto(index, url) {
  const suffix = index === 1 ? '' : `_${index}`;
  const value = String(url || '');
  $(`event_vibe_image_url${suffix}`).value = value;
  const preview = $(`event-vibe-photo-preview-${index}`);
  const image = $(`event-vibe-photo-image-${index}`);
  const button = $(`event-vibe-photo-button-${index}`);
  if (value) {
    image.src = value;
    preview.hidden = false;
    button.hidden = true;
  } else {
    image.removeAttribute('src');
    preview.hidden = true;
    button.hidden = false;
  }
}

const VIBE_PHOTO_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const VIBE_PHOTO_MAX_BYTES = 5 * 1024 * 1024;

function vibePhotoFileError(file) {
  if (!file || !VIBE_PHOTO_TYPES.has(file.type)) return 'Choose a JPG, PNG, WebP, or GIF image.';
  if (file.size > VIBE_PHOTO_MAX_BYTES) return 'Image is too large (max 5 MB).';
  return '';
}

async function uploadVibePhoto(index, file) {
  const button = $(`event-vibe-photo-button-${index}`);
  const replaceButton = $(`event-vibe-photo-replace-${index}`);
  const status = $(`event-vibe-photo-status-${index}`);
  const fileError = vibePhotoFileError(file);
  if (fileError) {
    status.textContent = fileError;
    return;
  }
  const body = new FormData();
  body.append('image', file);
  button.disabled = true;
  replaceButton.disabled = true;
  button.setAttribute('aria-busy', 'true');
  status.textContent = 'Uploading photo…';
  try {
    const response = await fetch('/api/uploads/vibe-photo', { method: 'POST', body });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Upload failed');
    setVibePhoto(index, data.url);
    status.textContent = 'Photo added.';
  } catch (err) {
    status.textContent = err.message;
  } finally {
    button.disabled = false;
    replaceButton.disabled = false;
    button.setAttribute('aria-busy', 'false');
    $(`event-vibe-photo-input-${index}`).value = '';
  }
}

$('add-vibe-choice').addEventListener('click', () => {
  setSecondVibeVisible(true);
  $('event_vibe_label').focus();
});
$('remove-vibe-choice').addEventListener('click', () => setSecondVibeVisible(false));
$('add-third-vibe-choice').addEventListener('click', () => {
  setThirdVibeVisible(true);
  $('event_vibe_label_3').focus();
});
$('remove-third-vibe-choice').addEventListener('click', () => setThirdVibeVisible(false));

[1, 2, 3].forEach(index => {
  const dropzone = $(`event-vibe-photo-button-${index}`);
  const input = $(`event-vibe-photo-input-${index}`);
  const openPicker = () => input.click();
  let dragDepth = 0;
  dropzone.addEventListener('click', openPicker);
  $(`event-vibe-photo-replace-${index}`).addEventListener('click', openPicker);
  input.addEventListener('change', event => {
    const file = event.target.files[0];
    if (file) uploadVibePhoto(index, file);
  });
  dropzone.addEventListener('dragenter', event => {
    event.preventDefault();
    dragDepth += 1;
    dropzone.classList.add('is-dragging');
  });
  dropzone.addEventListener('dragover', event => {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  });
  dropzone.addEventListener('dragleave', event => {
    event.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) dropzone.classList.remove('is-dragging');
  });
  dropzone.addEventListener('drop', event => {
    event.preventDefault();
    dragDepth = 0;
    dropzone.classList.remove('is-dragging');
    const file = event.dataTransfer?.files?.[0];
    if (file) uploadVibePhoto(index, file);
  });
  $(`event-vibe-photo-remove-${index}`).addEventListener('click', () => {
    setVibePhoto(index, '');
    $(`event-vibe-photo-status-${index}`).textContent = 'Photo removed.';
  });
});
syncVibeActions();

function activeArtworkUrl() {
  return presentationMode === 'flyer' ? $('flyer_image_url').value : $('cover_image_url').value;
}

function queueArtworkPalette(artworkUrl, { sampleUrl = artworkUrl, knownAccent = null, updatePicker = false } = {}) {
  if (!artworkUrl) {
    updateAdaptiveThemeSwatch([]);
    artworkAccentPromise = Promise.resolve(null);
    return artworkAccentPromise;
  }
  const saved = ArtworkColor.normalizeHex(knownAccent);
  if (saved) {
    artworkAccents.set(artworkUrl, saved);
    const savedRgb = ArtworkColor.hexToRgb(saved);
    updateAdaptiveThemeSwatch([savedRgb, savedRgb, savedRgb]);
    if (!updatePicker) {
      artworkAccentPromise = Promise.resolve(saved);
      return artworkAccentPromise;
    }
  }
  const existing = artworkAccents.get(artworkUrl);
  if (existing && !updatePicker) {
    artworkAccentPromise = Promise.resolve(existing);
    return artworkAccentPromise;
  }
  artworkAccentPromise = ArtworkColor.extractPalette(sampleUrl).then(candidates => {
    const accent = saved || ArtworkColor.selectAccentColor(candidates, { fallback: null });
    if (accent) artworkAccents.set(artworkUrl, accent);
    updateAdaptiveThemeSwatch(ArtworkColor.paletteForBackground(candidates));
    if (updatePicker) {
      const colors = ArtworkColor.paletteForBackground(candidates, { darken: 0.56, desaturate: 0.34 })
        .map(ArtworkColor.rgbToHex);
      applyPickerBackground({ colors: [colors[0], colors[1], colors[2] || colors[0]] }, 'picker-bg-photo');
    }
    return accent;
  }).catch(() => {
    if (updatePicker) {
      const fallback = IMAGE_CATEGORIES.find(category => category.label === activeImageCategory) || IMAGE_CATEGORIES[0];
      applyPickerBackground(fallback);
    }
    return artworkAccents.get(artworkUrl) || null;
  });
  return artworkAccentPromise;
}

function refreshActiveArtworkAccent(options = {}) {
  return queueArtworkPalette(activeArtworkUrl(), options);
}

function setPresentationMode(mode) {
  presentationMode = mode === 'flyer' ? 'flyer' : 'standard';
  const standard = presentationMode === 'standard';
  $('presentation-standard').checked = standard;
  $('presentation-flyer').checked = !standard;
  $('page-style-help').textContent = standard
    ? 'Cover image, background, and full event details.'
    : 'Put your uploaded flyer first and keep the page focused.';
  $('standard-media').hidden = !standard;
  $('flyer-media').hidden = standard;
  $('event-mobile-designer-row').hidden = standard || !$('flyer_image_url').value;
  refreshActiveArtworkAccent();
  refreshMobileFlowHub();
}

$('presentation-standard').addEventListener('change', () => setPresentationMode('standard'));
$('presentation-flyer').addEventListener('change', () => setPresentationMode('flyer'));

function applyOrganizerProfile(organizer) {
  const input = $('presenter_name');
  const help = $('presenter-help');
  input.value = organizer.org_name || '';

  if (organizer.public_slug) {
    input.readOnly = true;
    help.innerHTML = `Used across your events · <a href="/h/${encodeURIComponent(organizer.public_slug)}" target="_blank" rel="noopener">View host page</a> · <a href="/settings">Manage in Settings</a>`;
  } else if (editId) {
    input.readOnly = true;
    help.innerHTML = 'Host identity is shared across events. <a href="/settings">Set it up in Settings</a>.';
  }
}

const organizerProfileReady = api('/api/auth/me')
  .then(({ organizer }) => applyOrganizerProfile(organizer))
  .catch(() => {});

function renderCommerceInterest() {
  const panel = $('commerce-interest');
  const button = $('commerce-interest-toggle');
  panel.hidden = !commerceConfigLoaded || commerceEnabled || Boolean(commerceEventId);
  panel.classList.toggle('is-confirmed', commerceInterested);
  button.setAttribute('aria-pressed', String(commerceInterested));
  button.textContent = commerceInterested ? 'Leave waitlist' : 'Join the waitlist';
  $('commerce-interest-copy').innerHTML = commerceInterested
    ? '<span class="commerce-interest-check" aria-hidden="true">✓</span><strong>You’re on the list</strong><span>We’ll contact you at your account email when ticketing is available.</span>'
    : '<strong>Sell with Silver Glider is coming soon.</strong><span>Join the waitlist using your account email.</span>';
}

function focusCommerceInterestConfirmation() {
  const confirmation = $('commerce-interest-copy');
  if (!confirmation || !commerceInterested) return;
  confirmation.focus({ preventScroll: true });
}

const commerceConfigReady = api('/api/commerce/config')
  .then(({ enabled, interest }) => {
    commerceEnabled = enabled === true;
    commerceConfigLoaded = true;
    commerceInterested = interest?.interested === true;
    $('admission-commerce').disabled = !commerceEnabled;
    $('admission-commerce-status').hidden = commerceEnabled;
    renderCommerceInterest();
    if (admissionType === 'silver_glider_tickets') setAdmission(admissionType, { force: true });
  })
  .catch(() => {});

$('commerce-interest-toggle').addEventListener('click', async event => {
  const button = event.currentTarget;
  const nextInterested = !commerceInterested;
  button.disabled = true;
  button.textContent = nextInterested ? 'Adding…' : 'Removing…';
  try {
    const { interest } = await api('/api/commerce/interest', {
      method: 'POST', body: { interested: nextInterested }
    });
    commerceInterested = interest.interested === true;
    renderCommerceInterest();
    focusCommerceInterestConfirmation();
    toast(commerceInterested ? 'You’re on the ticketing list' : 'Ticketing notification removed');
  } catch (error) {
    renderCommerceInterest();
    toast(error.message);
  } finally {
    button.disabled = false;
  }
});

document.querySelectorAll('[data-picker-target]').forEach(button => {
  button.addEventListener('click', () => {
    const input = $(button.dataset.pickerTarget);
    if (!input) return;
    input.focus({ preventScroll: true });
    try {
      if (typeof input.showPicker === 'function') input.showPicker();
      else input.click();
    } catch (_) {
      input.focus();
    }
  });
});

function renderVisibilityState() {
  const secret = visibility === 'private' && $('secret_show_enabled').checked;
  const mobileSecretChoice = mobileFlowMedia.matches && secret;
  $('vis-public').classList.toggle('on', visibility === 'public');
  $('vis-private').classList.toggle('on', visibility === 'private' && !mobileSecretChoice);
  $('vis-secret').classList.toggle('on', mobileSecretChoice);
  $('vis-public').setAttribute('aria-pressed', String(visibility === 'public'));
  $('vis-private').setAttribute('aria-pressed', String(visibility === 'private' && !mobileSecretChoice));
  $('vis-secret').setAttribute('aria-pressed', String(mobileSecretChoice));
  $('private-settings').classList.toggle('show', visibility === 'private');
  $('private-settings').classList.toggle('secret-enabled', secret);
}

function setVisibility(mode) {
  const nextMode = mode === 'secret' ? 'secret' : (mode === 'private' ? 'private' : 'public');
  // On phones, Private and Secret Show are peer choices, so moving from Secret
  // to Private intentionally removes the code. Desktop keeps the established
  // nested Secret Show switch inside Private; reselecting Private there must
  // not silently turn an existing Secret Show off.
  const secretShowWasDisabled = $('secret_show_enabled').checked
    && (nextMode === 'public' || (mobileFlowMedia.matches && nextMode === 'private'));
  if (secretShowWasDisabled) setSecretShow(false);
  visibility = nextMode === 'public' ? 'public' : 'private';
  if (nextMode === 'secret') setSecretShow(true);
  renderVisibilityState();
  if (secretShowWasDisabled && nextMode === 'public') toast('Secret Show Mode was turned off for this public event');
  refreshMobileFlowHub();
  return true;
}
$('vis-public').addEventListener('click', () => setVisibility('public'));
$('vis-private').addEventListener('click', () => setVisibility('private'));
$('vis-secret').addEventListener('click', () => setVisibility('secret'));

function setSecretShow(enabled, { focus = false } = {}) {
  if (enabled) visibility = 'private';
  $('secret_show_enabled').checked = enabled;
  $('sms_reminder_enabled').disabled = enabled;
  if (enabled) $('sms_reminder_enabled').checked = false;
  $('sms-reminder-help').textContent = enabled
    ? 'Day-before text reminders are not available for Secret Shows yet.'
    : 'Uses your texting balance. The cost depends on how many guests opt in.';
  $('secret-code-fields').classList.toggle('show', enabled);
  const requiresCode = enabled && !hasSavedSecretCode;
  $('secret_code').required = requiresCode;
  $('secret_code_confirm').required = requiresCode;
  if (!enabled) {
    $('secret_code').value = '';
    $('secret_code_confirm').value = '';
  }
  renderVisibilityState();
  refreshMobileFlowHub();
  if (focus) window.setTimeout(() => $('secret_code').focus(), 0);
}

$('secret_show_enabled').addEventListener('change', event => setSecretShow(event.target.checked, { focus: event.target.checked }));
$('create-secret-show').addEventListener('click', () => {
  setSecretShow(true, { focus: true });
});
['secret_code','secret_code_confirm'].forEach(id => $(id).addEventListener('input', event => {
  event.target.value = event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
}));

function setAdmission(v, { force = false } = {}) {
  const normalized = v === 'paid' || v === 'external_tickets'
    ? 'external_tickets'
    : v === 'silver_glider_tickets'
      ? 'silver_glider_tickets'
      : 'free_rsvp';
  if (normalized === 'silver_glider_tickets' && !force && !commerceEnabled && !commerceEventId) {
    toast('Silver Glider ticket setup is not connected yet');
    return;
  }
  admissionType = normalized;
  $('admission-free').classList.toggle('on', admissionType === 'free_rsvp');
  $('admission-commerce').classList.toggle('on', admissionType === 'silver_glider_tickets');
  $('admission-paid').classList.toggle('on', admissionType === 'external_tickets');
  $('admission-free').setAttribute('aria-pressed', String(admissionType === 'free_rsvp'));
  $('admission-commerce').setAttribute('aria-pressed', String(admissionType === 'silver_glider_tickets'));
  $('admission-paid').setAttribute('aria-pressed', String(admissionType === 'external_tickets'));
  $('ticket-fields').classList.toggle('show', admissionType === 'external_tickets');
  $('commerce-admission-note').classList.toggle('show', admissionType === 'silver_glider_tickets');
  $('commerce-admission-note').textContent = commerceEventId
    ? 'Connected to Silver Glider Commerce. Pricing, inventory, orders, and ticket delivery are managed there.'
    : 'Silver Glider ticket setup will be available after the Commerce connection is configured.';
  $('ticket_price').required = admissionType === 'external_tickets';
  $('ticket_url').required = false;
  renderCommerceInterest();
}
$('admission-free').addEventListener('click', () => setAdmission('free_rsvp'));
$('admission-commerce').addEventListener('click', () => setAdmission('silver_glider_tickets'));
$('admission-paid').addEventListener('click', () => setAdmission('external_tickets'));

// Background picker — gradients + generative/photo/video effects
const GRADIENTS = ['midnight', 'aurora', 'sunset', 'ocean'];
const EFFECTS = ['halloween', 'last-guest', 'disco', 'fog', 'paper', 'static', 'liquid-stardust', 'color-static', 'saloon', 'adaptive'];
const THEMES = [...GRADIENTS, ...EFFECTS];
const THEME_LABELS = {
  midnight: 'Midnight', aurora: 'Aurora', sunset: 'Sunset', ocean: 'Ocean',
  adaptive: 'Match Photo',
  halloween: 'Halloween', 'liquid-stardust': 'Liquid Stardust', 'color-static': 'Color Static',
  'last-guest': 'The Last Guest',
  static: 'TV static', paper: 'Kraft paper', disco: 'Disco', fog: 'Fog',
  saloon: 'After Hours Saloon'
};
function setTheme(key) {
  $('background_theme').value = key;
  document.querySelectorAll('#theme-picker .sg-swatch').forEach(s => {
    const selected = s.dataset.theme === key;
    s.classList.toggle('on', selected);
    s.setAttribute('aria-pressed', String(selected));
  });
  $('theme-selected-name').textContent = `Selected: ${THEME_LABELS[key] || key}`;
  refreshMobileFlowHub();
}
THEMES.forEach(key => {
  const sw = document.createElement('button');
  sw.type = 'button';
  sw.className = 'sg-swatch ' + (EFFECTS.includes(key) ? 'fx-' : 'bg-') + key;
  sw.dataset.theme = key;
  sw.title = THEME_LABELS[key];
  sw.setAttribute('aria-label', `Use ${THEME_LABELS[key]} background`);
  const name = document.createElement('span');
  name.className = 'sg-swatch-name';
  name.textContent = THEME_LABELS[key];
  sw.appendChild(name);
  sw.addEventListener('click', () => setTheme(key));
  $(EFFECTS.includes(key) ? 'effect-picker' : 'gradient-picker').appendChild(sw);
});
setTheme('midnight');

// ── Unified location search: venues and normal addresses share one flow ──
const placeFields = ['venue_city', 'venue_state', 'venue_latitude', 'venue_longitude', 'google_place_id'];
let applyingPlace = false;
let placesLoader;
let locationKind = null;
let manualLocationMode = false;

function setPlacesStatus(message) {
  const el = $('places-status');
  if (el) el.textContent = message || '';
}

function clearPlaceMeta() {
  placeFields.forEach(id => { $(id).value = ''; });
}

function setStoredLocation(venueName, venueAddress) {
  $('venue_name').value = LocationUtils.clean(venueName).slice(0, 140);
  $('venue_address').value = LocationUtils.clean(venueAddress);
}

function publishLocationState() {
  const venueName = $('venue_name').value.trim();
  const venueAddress = $('venue_address').value.trim();
  if (!venueName && !venueAddress) {
    return { valid: false, error: 'Choose a venue or address, or enter the location manually', venueName, venueAddress };
  }
  if (manualLocationMode && !venueAddress) {
    return { valid: false, error: 'Add an address for this location', venueName, venueAddress };
  }
  return { valid: true, error: null, venueName, venueAddress };
}

function renderLocationSelection() {
  const parts = LocationUtils.displayParts($('venue_name').value, $('venue_address').value);
  const selection = $('location-selection');
  selection.hidden = !parts.name;
  $('location-selection-name').textContent = parts.name;
  $('location-selection-address').textContent = parts.address;
  $('location-selection-address').hidden = !parts.address;
  $('location-name-field').hidden = locationKind !== 'address';
}

function populateLocationEditor(venueName, venueAddress) {
  const name = LocationUtils.clean(venueName);
  const address = LocationUtils.clean(venueAddress);
  const addressOnly = Boolean(address) && LocationUtils.isAddressFallback(name, address);
  locationKind = addressOnly ? 'address' : (name || address ? 'business' : null);
  manualLocationMode = false;
  $('location-search-mode').hidden = false;
  $('location-manual-mode').hidden = true;
  setStoredLocation(name, address);
  $('location_search').value = addressOnly ? address : (name || address);
  $('location_manual_address').value = address;
  $('location_name').value = addressOnly ? '' : name;
  renderLocationSelection();
}

function syncManualLocation() {
  const address = $('location_manual_address').value.trim();
  const locationName = $('location_name').value.trim();
  locationKind = 'address';
  setStoredLocation(locationName || LocationUtils.addressFallback(address), address);
  clearPlaceMeta();
  renderLocationSelection();
  setPlacesStatus('');
}

function setManualLocationMode(enabled, { focus = true } = {}) {
  manualLocationMode = Boolean(enabled);
  $('location-search-mode').hidden = manualLocationMode;
  $('location-manual-mode').hidden = !manualLocationMode;
  if (manualLocationMode) {
    const address = $('venue_address').value || (!$('venue_name').value ? $('location_search').value.trim() : '');
    const currentName = LocationUtils.isAddressFallback($('venue_name').value, address) ? '' : $('venue_name').value;
    locationKind = 'address';
    $('location_manual_address').value = address;
    $('location_name').value = currentName;
    renderLocationSelection();
    setPlacesStatus('');
    if (focus) $('location_manual_address').focus();
  } else {
    locationKind = LocationUtils.isAddressFallback($('venue_name').value, $('venue_address').value) ? 'address' : ($('venue_name').value || $('venue_address').value ? 'business' : null);
    $('location_search').value = $('venue_address').value || $('venue_name').value;
    renderLocationSelection();
    if (focus) {
      $('location_search').focus();
      $('location_search').select();
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
  setStoredLocation(selected.venueName, selected.venueAddress);
  $('location-search-mode').hidden = false;
  $('location-manual-mode').hidden = true;
  $('location_search').value = selected.addressOnly ? selected.venueAddress : selected.venueName;
  $('location_manual_address').value = selected.venueAddress;
  $('location_name').value = '';
  $('venue_city').value =
    placeComponent(place, ['locality']) ||
    placeComponent(place, ['postal_town']) ||
    placeComponent(place, ['administrative_area_level_2']);
  $('venue_state').value = placeComponent(place, ['administrative_area_level_1'], 'short_name');
  $('google_place_id').value = place.place_id || '';
  const location = place.geometry && place.geometry.location;
  $('venue_latitude').value = location ? String(location.lat()) : '';
  $('venue_longitude').value = location ? String(location.lng()) : '';
  setPlacesStatus('');
  renderLocationSelection();
  window.setTimeout(() => { applyingPlace = false; }, 0);
}

function loadGooglePlaces(apiKey) {
  if (window.google && window.google.maps && window.google.maps.places) return Promise.resolve();
  if (placesLoader) return placesLoader;
  placesLoader = new Promise((resolve, reject) => {
    window.__sgeInitPlaces = () => resolve();
    const script = document.createElement('script');
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}&libraries=places&callback=__sgeInitPlaces`;
    script.async = true;
    script.defer = true;
    script.onerror = reject;
    document.head.appendChild(script);
  });
  return placesLoader;
}

async function initLocationAutocomplete() {
  try {
    setPlacesStatus('Loading location suggestions…');
    const { enabled, apiKey } = await api('/api/places/config');
    if (!enabled || !apiKey) {
      setPlacesStatus('Search suggestions are unavailable. Enter the location manually.');
      return;
    }
    await loadGooglePlaces(apiKey);
    const autocomplete = new google.maps.places.Autocomplete($('location_search'), {
      fields: ['name', 'formatted_address', 'address_components', 'geometry', 'place_id', 'types']
    });
    autocomplete.addListener('place_changed', () => applySelectedPlace(autocomplete.getPlace()));
    setPlacesStatus('');
  } catch (_) {
    setPlacesStatus('Search suggestions are unavailable. Enter the location manually.');
  }
}

$('location_search').addEventListener('input', () => {
  if (applyingPlace) return;
  locationKind = null;
  $('location_name').value = '';
  setStoredLocation('', '');
  clearPlaceMeta();
  renderLocationSelection();
  setPlacesStatus($('location_search').value.trim() ? 'Choose a suggestion or enter the address manually.' : '');
});
$('location_manual_address').addEventListener('input', syncManualLocation);
$('location_name').addEventListener('input', () => {
  if (locationKind !== 'address') return;
  const address = $('venue_address').value;
  setStoredLocation($('location_name').value.trim() || LocationUtils.addressFallback(address), address);
  renderLocationSelection();
});
$('location-manual-toggle').addEventListener('click', () => setManualLocationMode(true));
$('location-search-toggle').addEventListener('click', () => setManualLocationMode(false));
$('location-change').addEventListener('click', () => {
  const input = manualLocationMode ? $('location_manual_address') : $('location_search');
  input.focus();
  input.select();
});
populateLocationEditor('', '');
initLocationAutocomplete();

// ── Cover image: upload, Unsplash search, or none ──
const drop = $('cover-drop');
const fileInput = $('cover-input');
const imageModal = $('image-modal');
const pickerUpload = $('picker-upload');
let photosEnabled = false;
let activeImageCategory = '🎃 Halloween';
let lastPhotos = [];
let currentPhotoQuery = '';
let currentPhotoQueries = [];
let currentPhotoCategory = '';
let currentPhotoPage = 0;
let currentPhotoTotalPages = 1;
let photoLoading = false;
let photoScrollBound = false;
let lastPhotoLoadAt = 0;

function setCoverFitMode(mode) {
  coverFitMode = ['contain', 'cover'].includes(mode) ? mode : 'auto';
  $('cover-fit-contain').checked = coverFitMode === 'contain';
  $('cover-fit-cover').checked = coverFitMode === 'cover';
  drop.classList.toggle('fit-contain', coverFitMode === 'contain');
}

function defaultCoverFitFromImage(img) {
  if (coverFitMode !== 'auto' || !img.naturalWidth || !img.naturalHeight) return;
  setCoverFitMode(img.naturalHeight > img.naturalWidth ? 'contain' : 'cover');
}

$('cover-fit-contain').addEventListener('change', () => setCoverFitMode('contain'));
$('cover-fit-cover').addEventListener('change', () => setCoverFitMode('cover'));
const IMAGE_BG_CLASSES = [];
let pickerBgTimer;

// User-facing visual themes stay simple; hidden queries are tuned for
// inspirational event backgrounds rather than literal event-type matches.
const IMAGE_CATEGORIES = [
  {
    label: '🎃 Halloween',
    query: 'halloween pumpkins costumes haunted spooky',
    bgClass: 'picker-bg-halloween',
    colors: ['#4f210d', '#321143', '#151810']
  },
  {
    label: '🍂 Fall',
    query: 'autumn leaves cozy harvest warm',
    bgClass: 'picker-bg-fall',
    colors: ['#6d3518', '#7a541d', '#29341f']
  },
  {
    label: '⭐ Silver Glider Picks',
    query: 'nightlife live music crowd neon event',
    bgClass: 'picker-bg-featured',
    colors: ['#155b5a', '#30255f', '#75511f']
  },
  { label: '📼 Nostalgia', query: 'vintage retro analog 90s nostalgic background', bgClass: 'picker-bg-nostalgia', colors: ['#5b3c57', '#765132', '#244c5d'] },
  { label: '🎨 Textures', query: 'concrete paper grain fabric texture background', bgClass: 'picker-bg-textures', colors: ['#4a443e', '#272c35', '#5a4930'] },
  { label: '📐 Patterns', query: 'geometric repeating patterns graphic design background', bgClass: 'picker-bg-patterns', colors: ['#153f47', '#352d63', '#5d5d5f'] },
  { label: '🎞️ Film', query: 'cinematic film moody lighting grain dramatic shadows', bgClass: 'picker-bg-film', colors: ['#243142', '#4b3345', '#8a5f31'] },
  { label: '🏙️ Urban', query: 'city architecture streets nightlife urban lights', bgClass: 'picker-bg-urban', colors: ['#142b42', '#3a345e', '#6c4d21'] },
  { label: '🌿 Nature', query: 'forest mountains plants sky natural light background', bgClass: 'picker-bg-nature', colors: ['#164c3a', '#17495b', '#546629'] },
  { label: '✨ Abstract', query: 'abstract gradients shapes soft color background', bgClass: 'picker-bg-abstract', colors: ['#2b3c7b', '#6e3277', '#167577'] },
  { label: '🌈 Colorful', query: 'vibrant colors neon rainbow bright abstract background', bgClass: 'picker-bg-colorful', colors: ['#196b72', '#6a3574', '#7c4f1c'] },
  { label: '🌙 Dark', query: 'black shadows low light dark moody background', bgClass: 'picker-bg-dark', colors: ['#0c1625', '#21152f', '#331c32'] },
  { label: '🖤 Minimal', query: 'clean simple negative space minimal background', bgClass: 'picker-bg-minimal', colors: ['#1f2428', '#333236', '#0f3f42'] }
];
IMAGE_CATEGORIES.forEach(category => IMAGE_BG_CLASSES.push(category.bgClass));

function applyPickerBackground(item, className = item.bgClass) {
  if (!imageModal || !item) return;
  const update = () => {
    imageModal.classList.remove(...IMAGE_BG_CLASSES, 'picker-bg-photo');
    imageModal.classList.add(className);
    const [a, b, c] = item.colors;
    imageModal.style.setProperty('--picker-bg-a', a);
    imageModal.style.setProperty('--picker-bg-b', b);
    imageModal.style.setProperty('--picker-bg-c', c || a);
    window.clearTimeout(pickerBgTimer);
    pickerBgTimer = window.setTimeout(() => imageModal.classList.remove('picker-bg-updating'), 420);
  };
  if (imageModal.classList.contains('open')) {
    imageModal.classList.add('picker-bg-updating');
    window.requestAnimationFrame(update);
  } else {
    update();
    imageModal.classList.remove('picker-bg-updating');
  }
}

function setCover(url, creditName, creditLink, { preserveFit = false } = {}) {
  const previousUrl = $('cover_image_url').value;
  if (previousUrl && previousUrl !== url) artworkAccents.delete(previousUrl);
  if (!preserveFit) setCoverFitMode('auto');
  $('cover_image_url').value = url || '';
  $('cover_credit_name').value = creditName || '';
  $('cover_credit_link').value = creditLink || '';
  const img = $('cover-preview');
  if (url) {
    $('cover-fit-control').hidden = false;
    img.onload = () => defaultCoverFitFromImage(img);
    img.src = url;
    img.style.display = 'block';
    drop.classList.add('has-image');
    $('btn-clear-cover').style.display = '';
    markSelectedPhoto(url);
    if (img.complete) defaultCoverFitFromImage(img);
  } else {
    $('cover-fit-control').hidden = true;
    img.onload = null;
    setCoverFitMode('auto');
    img.style.display = 'none';
    drop.classList.remove('has-image');
    $('btn-clear-cover').style.display = 'none';
    markSelectedPhoto('');
    updateAdaptiveThemeSwatch([]);
  }
}

function openImageModal() {
  imageModal.classList.add('open');
  imageModal.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
  const theme = IMAGE_CATEGORIES.find(category => category.label === activeImageCategory) || IMAGE_CATEGORIES[0];
  applyPickerBackground(theme);
  if (photosEnabled) loadCategory(activeImageCategory || '🎃 Halloween');
}

function closeImageModal() {
  imageModal.classList.remove('open');
  imageModal.setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';
}

drop.addEventListener('click', event => {
  if (event.target !== fileInput) fileInput.click();
});
$('btn-upload').addEventListener('click', () => fileInput.click());
$('image-modal-close').addEventListener('click', closeImageModal);
$('image-modal-done').addEventListener('click', closeImageModal);
imageModal.addEventListener('click', e => { if (e.target === imageModal) closeImageModal(); });
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && imageModal.classList.contains('open')) closeImageModal();
});
pickerUpload.addEventListener('click', () => fileInput.click());
$('btn-clear-cover').addEventListener('click', () => { setCover(''); });
function handleImageDragover(e) {
  e.preventDefault();
  e.currentTarget.classList.add('dragover');
}
function handleImageDragleave(e) {
  e.currentTarget.classList.remove('dragover');
}
function handleImageDrop(e) {
  e.preventDefault();
  e.currentTarget.classList.remove('dragover');
  if (e.dataTransfer.files[0]) uploadCover(e.dataTransfer.files[0]);
}
drop.addEventListener('dragover', handleImageDragover);
drop.addEventListener('dragleave', handleImageDragleave);
drop.addEventListener('drop', handleImageDrop);
pickerUpload.addEventListener('dragover', handleImageDragover);
pickerUpload.addEventListener('dragleave', handleImageDragleave);
pickerUpload.addEventListener('drop', handleImageDrop);
fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) uploadCover(fileInput.files[0]);
});

function uploadCover(file) {
  const progress = $('cover-progress');
  progress.style.width = '30%';
  const form = new FormData();
  form.append('image', file);
  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/api/uploads/cover');
  xhr.upload.onprogress = e => {
    if (e.lengthComputable) progress.style.width = `${Math.round((e.loaded / e.total) * 90)}%`;
  };
  xhr.onload = () => {
    progress.style.width = '0%';
    try {
      const data = JSON.parse(xhr.responseText);
      if (xhr.status !== 200) throw new Error(data.error || 'Upload failed');
      setCover(data.url); // own upload → no credit
      queueArtworkPalette(data.url, { knownAccent: data.accentColor, updatePicker: true });
      closeImageModal();
    } catch (err) {
      showError(err.message);
    }
  };
  xhr.onerror = () => { progress.style.width = '0%'; showError('Upload failed'); };
  xhr.send(form);
}

const flyerDrop = $('flyer-drop');
const flyerInput = $('flyer-input');

function setFlyer(url) {
  const previousUrl = $('flyer_image_url').value;
  if (previousUrl && previousUrl !== url) artworkAccents.delete(previousUrl);
  $('flyer_image_url').value = url || '';
  const preview = $('flyer-preview');
  if (url) {
    preview.src = url;
    flyerDrop.classList.add('has-image');
    $('btn-clear-flyer').style.display = '';
  } else {
    preview.removeAttribute('src');
    flyerDrop.classList.remove('has-image');
    $('btn-clear-flyer').style.display = 'none';
  }
  $('flyer-credit-fields').hidden = !url;
  $('event-mobile-designer-row').hidden = !url || presentationMode !== 'flyer';
  if (!url) setFlyerDesignerError('');
  refreshMobileFlowHub();
}

function uploadFlyer(file) {
  const progress = $('flyer-progress');
  progress.style.width = '30%';
  const form = new FormData();
  form.append('image', file);
  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/api/uploads/flyer');
  xhr.upload.onprogress = e => {
    if (e.lengthComputable) progress.style.width = `${Math.round((e.loaded / e.total) * 90)}%`;
  };
  xhr.onload = () => {
    progress.style.width = '0%';
    try {
      const data = JSON.parse(xhr.responseText);
      if (xhr.status !== 200) throw new Error(data.error || 'Upload failed');
      setFlyer(data.url);
      queueArtworkPalette(data.url, { knownAccent: data.accentColor });
    } catch (err) {
      showError(err.message);
    }
  };
  xhr.onerror = () => { progress.style.width = '0%'; showError('Upload failed'); };
  xhr.send(form);
}

flyerDrop.addEventListener('click', () => flyerInput.click());
$('btn-flyer-upload').addEventListener('click', () => flyerInput.click());
$('btn-clear-flyer').addEventListener('click', () => setFlyer(''));
$('flyer-designer-instagram').addEventListener('input', () => setFlyerDesignerError(''));
$('flyer-designer-instagram').addEventListener('blur', () => normalizeFlyerDesignerHandle());
flyerDrop.addEventListener('dragover', handleImageDragover);
flyerDrop.addEventListener('dragleave', handleImageDragleave);
flyerDrop.addEventListener('drop', event => {
  event.preventDefault();
  event.currentTarget.classList.remove('dragover');
  if (event.dataTransfer.files[0]) uploadFlyer(event.dataTransfer.files[0]);
});
flyerInput.addEventListener('change', () => {
  if (flyerInput.files[0]) uploadFlyer(flyerInput.files[0]);
});

// Unsplash search — only shown if the server has an access key configured
$('btn-search').addEventListener('click', openImageModal);
api('/api/photos/enabled').then(({ enabled }) => {
  photosEnabled = enabled;
  if (enabled) {
    $('btn-search').style.display = '';
    renderImageCategories();
  } else {
    $('unsplash-panel').innerHTML = '<div class="picker-empty">Free photo search is not set up yet.</div>';
  }
}).catch(() => {});

function renderImageCategories() {
  const wrap = $('image-categories');
  wrap.innerHTML = '';
  IMAGE_CATEGORIES.forEach(({ label }) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'picker-cat';
    chip.textContent = label;
    chip.dataset.category = label;
    chip.addEventListener('click', () => loadCategory(label));
    wrap.appendChild(chip);
  });
  markActiveCategory();
  setupPhotoInfiniteScroll();
}

function markActiveCategory() {
  document.querySelectorAll('.picker-cat').forEach(chip => {
    chip.classList.toggle('on', chip.dataset.category === activeImageCategory);
  });
}

function markSelectedPhoto(url) {
  document.querySelectorAll('.picker-photo').forEach(cell => {
    cell.classList.toggle('selected', !!url && cell.dataset.full === url);
  });
}

function updateLoadMore() {
  const btn = $('photo-load-more');
  const hasMore = currentPhotoPage < currentPhotoTotalPages;
  btn.hidden = !hasMore || !currentPhotoQuery;
  btn.disabled = photoLoading;
  btn.textContent = photoLoading ? 'Loading...' : 'Load more photos';
}

function setupPhotoInfiniteScroll() {
  const scroller = document.querySelector('.image-modal-body');
  if (!photoScrollBound && scroller) {
    photoScrollBound = true;
    scroller.addEventListener('scroll', () => {
      const remaining = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
      if (remaining < 700) loadMorePhotos();
    }, { passive: true });
  }
}

function interleavePhotoResults(groups, existing = []) {
  const mixed = [];
  const seen = new Set(existing.map(photo => photo.id || photo.full));
  const longest = Math.max(0, ...groups.map(group => group.length));
  for (let index = 0; index < longest; index += 1) {
    groups.forEach(group => {
      const photo = group[index];
      const key = photo && (photo.id || photo.full);
      if (photo && !seen.has(key)) {
        seen.add(key);
        mixed.push(photo);
      }
    });
  }
  return mixed;
}

async function searchPhotos(q, { category = null, queries = null, page = 1, append = false } = {}) {
  if (photoLoading) return;
  photoLoading = true;
  currentPhotoQuery = q;
  currentPhotoQueries = Array.isArray(queries) && queries.length ? queries : [q];
  currentPhotoCategory = category || '';
  currentPhotoPage = page;
  const status = $('unsplash-status');
  const grid = $('unsplash-results');
  status.textContent = append ? 'Loading more images...' : 'Loading images...';
  updateLoadMore();
  if (!append) grid.innerHTML = '<div class="picker-empty" style="grid-column:1/-1">Loading images...</div>';
  try {
    const perPage = Math.ceil(24 / currentPhotoQueries.length);
    const responses = await Promise.all(currentPhotoQueries.map(query => (
      api(`/api/photos/search?q=${encodeURIComponent(query)}&page=${page}&per_page=${perPage}`)
    )));
    const results = interleavePhotoResults(
      responses.map(response => response.results || []),
      append ? lastPhotos : []
    );
    currentPhotoTotalPages = Math.min(...responses.map(response => response.totalPages || 1));
    lastPhotos = append ? lastPhotos.concat(results) : results;
    status.textContent = lastPhotos.length ? (currentPhotoCategory || '') : '';
    renderPhotoGrid(results, { append });
  } catch (err) {
    if (!append) grid.innerHTML = '';
    currentPhotoTotalPages = currentPhotoPage;
    status.textContent = err.message;
  } finally {
    photoLoading = false;
    updateLoadMore();
  }
}

function renderPhotoGrid(results, { append = false } = {}) {
  const grid = $('unsplash-results');
  if (!append) grid.innerHTML = '';
  if (!results.length && !append) {
    grid.innerHTML = '<div class="picker-empty" style="grid-column:1/-1">No photos found. Try another search.</div>';
    return;
  }
  results.forEach(photo => {
    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = 'picker-photo';
    cell.dataset.full = photo.full;
    cell.title = `Photo by ${photo.credit_name}`;
    cell.innerHTML = `<img src="${photo.thumb}" alt="">`;
    cell.addEventListener('click', () => pickPhoto(photo));
    grid.appendChild(cell);
  });
  markSelectedPhoto($('cover_image_url').value);
}

function loadMorePhotos() {
  if (photoLoading || !currentPhotoQuery || currentPhotoPage >= currentPhotoTotalPages) return;
  const now = Date.now();
  if (now - lastPhotoLoadAt < 900) return;
  lastPhotoLoadAt = now;
  searchPhotos(currentPhotoQuery, {
    category: currentPhotoCategory,
    queries: currentPhotoQueries,
    page: currentPhotoPage + 1,
    append: true
  });
}

function loadCategory(label) {
  const item = IMAGE_CATEGORIES.find(category => category.label === label) || IMAGE_CATEGORIES[0];
  activeImageCategory = item.label;
  applyPickerBackground(item);
  markActiveCategory();
  $('unsplash-q').value = '';
  searchPhotos(item.query, { category: item.label, queries: item.queries });
}

async function runSearch() {
  const q = $('unsplash-q').value.trim();
  if (!q) return loadCategory(activeImageCategory);
  activeImageCategory = '';
  markActiveCategory();
  searchPhotos(q);
}
$('unsplash-go').addEventListener('click', runSearch);
$('unsplash-q').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); runSearch(); } });
$('photo-load-more').addEventListener('click', loadMorePhotos);

function pickPhoto(photo) {
  setCover(photo.full, photo.credit_name, photo.credit_link);
  queueArtworkPalette(photo.full, { sampleUrl: photo.thumb || photo.full, updatePicker: true });
  closeImageModal();
  // Required by Unsplash: register the download when a photo is chosen
  api('/api/photos/track', { method: 'POST', body: { download_location: photo.download_location } }).catch(() => {});
}

function formatMobileFlowDate(value) {
  if (!value) return '';
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function formatMobileFlowTime(value) {
  if (!value) return '';
  const [hourValue, minute = '00'] = String(value).split(':');
  const hour = Number(hourValue);
  if (!Number.isFinite(hour)) return value;
  return `${hour % 12 || 12}:${minute} ${hour >= 12 ? 'PM' : 'AM'}`;
}

function refreshMobileFlowHub() {
  if (!$('event-mobile-flow')) return;
  const designImage = presentationMode === 'flyer' ? $('flyer_image_url').value : $('cover_image_url').value;
  $('event-mobile-summary-design').textContent = `${presentationMode === 'flyer' ? 'Flyer' : 'Standard'} · ${designImage ? 'Image added' : 'No image'}`;
  $('event-mobile-summary-designer').textContent = $('flyer-designer-name').value.trim() || $('flyer-designer-instagram').value.trim() || 'Add who designed this flyer';
  $('event-mobile-summary-effects').textContent = THEME_LABELS[$('background_theme').value] || 'Midnight';

  const basics = [formatMobileFlowDate($('event_date').value), formatMobileFlowTime($('start_time').value)].filter(Boolean);
  const locationName = $('venue_name').value || $('location_search').value.trim();
  if (locationName) basics.push(locationName);
  $('event-mobile-summary-basics').textContent = basics.length ? basics.join(' · ') : ($('title').value.trim() || 'Title, date, time, and location');

  const artistFields = [
    ['event_vibe_label', 'event_vibe_url', 'event_vibe_image_url'],
    ['event_vibe_label_2', 'event_vibe_url_2', 'event_vibe_image_url_2'],
    ['event_vibe_label_3', 'event_vibe_url_3', 'event_vibe_image_url_3']
  ];
  const artistCount = artistFields.filter(ids => ids.some(id => String($(id).value || '').trim())).length;
  const hasDescription = Boolean($('description').value.trim());
  $('event-mobile-summary-description').textContent = hasDescription ? 'Description added' : 'Optional · Not added';
  $('event-mobile-summary-vibe').textContent = artistCount
    ? `${artistCount} ${artistCount === 1 ? 'artist' : 'artists'}`
    : 'Optional · No artists';

  const admissionLabel = admissionType === 'external_tickets'
    ? 'External tickets'
    : (admissionType === 'silver_glider_tickets' ? 'Silver Glider tickets' : 'Free RSVP');
  $('event-mobile-summary-admission').textContent = admissionLabel;
  $('event-mobile-summary-visibility').textContent = $('secret_show_enabled').checked
    ? 'Secret Show'
    : (visibility === 'private' ? 'Private link only' : 'Public');
  const capacitySummary = $('capacity').value ? `${$('capacity').value} guests` : 'Unlimited';
  $('event-mobile-summary-capacity').textContent = $('category').value
    ? `${$('category').value} · ${capacitySummary}`
    : capacitySummary;
  $('event-mobile-summary-guests').textContent = [
    `Guest list ${$('show_guest_list').checked ? 'on' : 'off'}`,
    `+1s ${$('allow_guests').checked ? 'on' : 'off'}`,
    `Comments ${$('comments_enabled').checked ? 'on' : 'off'}`
  ].join(' · ');
  $('event-mobile-summary-reminders').textContent = $('secret_show_enabled').checked
    ? 'Unavailable for Secret Shows'
    : `Day-before text ${$('sms_reminder_enabled').checked ? 'on' : 'off'}`;
}

function mobileFlowPanelForElement(element) {
  return element?.closest?.('[data-mobile-flow-panel]')?.dataset.mobileFlowPanel || null;
}

function validateRequiredFields() {
  const firstInvalid = $('event-form').querySelector(':invalid');
  if (!firstInvalid) return true;
  if (mobileFlowMedia.matches) {
    const panel = mobileFlowPanelForElement(firstInvalid) || 'basics';
    openMobileFlowView(panel, { focus: false });
    const mobileError = $('event-mobile-flow-error');
    mobileError.textContent = firstInvalid.validationMessage || 'Complete the required fields to continue.';
    mobileError.hidden = false;
  }
  requestAnimationFrame(() => {
    firstInvalid.focus({ preventScroll: true });
    firstInvalid.reportValidity();
  });
  return false;
}

function clearMobileFlowError() {
  const error = $('event-mobile-flow-error');
  if (!error) return;
  error.textContent = '';
  error.hidden = true;
}

function openMobileFlowView(view, { focus = true, trigger = null } = {}) {
  if (!mobileFlowMedia.matches || !$('event-mobile-flow')) return;
  const nextView = view === 'hub' || mobileFlowTitles[view] ? view : 'hub';
  mobileFlowView = nextView;
  if (trigger) mobileFlowLastTrigger = trigger;
  $('event-form').dataset.mobileView = nextView;
  $('event-mobile-flow-hub').hidden = nextView !== 'hub';
  $('event-mobile-screen-intro').hidden = nextView === 'hub';
  $('event-mobile-flow-title').textContent = editId ? 'Edit event' : 'Create event';
  if (nextView !== 'hub') {
    $('event-mobile-screen-kicker').textContent = editId ? 'Edit event' : 'Create event';
    $('event-mobile-screen-title').textContent = mobileFlowTitles[nextView];
    $('event-mobile-screen-subtitle').textContent = mobileFlowSubtitles[nextView];
  }
  const createStep = !editId ? mobileCreateSequence.indexOf(nextView) : -1;
  const previousCreateView = createStep > 0 ? mobileFlowTitles[mobileCreateSequence[createStep - 1]] : null;
  $('event-mobile-flow-back').setAttribute('aria-label', previousCreateView
    ? `Back to ${previousCreateView}`
    : (nextView === 'hub' ? 'Leave event editor' : `Back from ${mobileFlowTitles[nextView]}`));
  $('event-mobile-flow-done').textContent = createStep === mobileCreateSequence.length - 1 ? 'Review event' : 'Done';

  if (nextView === 'description' || nextView === 'vibe') {
    if (mobileMoreDetailsWasOpen == null) mobileMoreDetailsWasOpen = $('more-details').open;
    $('more-details').open = true;
  }
  clearMobileFlowError();
  refreshMobileFlowHub();
  window.scrollTo({ top: 0, behavior: 'auto' });
  if (focus) {
    const heading = nextView === 'hub' ? $('event-mobile-flow-title') : $('event-mobile-screen-title');
    heading.setAttribute('tabindex', '-1');
    requestAnimationFrame(() => heading.focus({ preventScroll: true }));
  }
}

function returnToMobileFlowHub({ focus = true } = {}) {
  const previousView = mobileFlowParentViews[mobileFlowView] || mobileFlowView;
  const hubTrigger = document.querySelector(`#event-mobile-flow-hub [data-mobile-flow-open="${previousView}"]`);
  const returnFocus = hubTrigger || mobileFlowLastTrigger;
  openMobileFlowView('hub', { focus: false });
  if (!focus) return;
  const target = returnFocus instanceof HTMLElement && returnFocus.isConnected
    ? returnFocus
    : $('event-mobile-flow-title');
  requestAnimationFrame(() => target.focus({ preventScroll: true }));
}

function revealMobileFlowError(message) {
  if (!mobileFlowMedia.matches) return;
  const text = String(message || '').toLowerCase();
  let panel = mobileFlowView === 'hub' ? 'basics' : mobileFlowView;
  if (/instagram|designer/.test(text)) panel = 'designer';
  else if (/flyer|image/.test(text)) panel = 'design';
  else if (/location|address|title|date|time/.test(text)) panel = 'basics';
  else if (/ticket|admission|price/.test(text)) panel = 'admission';
  else if (/secret|access code|visibility/.test(text)) panel = 'visibility';
  else if (/capacity|category/.test(text)) panel = 'capacity';
  else if (/reminder|texting/.test(text)) panel = 'reminders';
  openMobileFlowView(panel, { focus: false });
}

function updateMobilePreviewAvailability() {
  const preview = $('event-mobile-flow-preview');
  if (!preview) return;
  const available = Boolean(savedEventDetails?.slug);
  preview.disabled = !available;
  preview.setAttribute('aria-label', available ? 'Preview event in a new tab' : 'Preview is available after the event is saved');
}

function leaveMobileEventEditor() {
  if (mobileFlowHasChanges() && !window.confirm('Discard your unsaved changes?')) return;
  window.location.href = editId ? `/events/${encodeURIComponent(editId)}/manage` : '/events';
}

function syncMobileFlowMode() {
  if (!$('event-mobile-flow')) return;
  if (mobileFlowMedia.matches) {
    document.body.classList.add('event-mobile-flow-enabled');
    if (!$('event-form').dataset.mobileView) mobileFlowView = editId ? 'hub' : 'basics';
    renderVisibilityState();
    updateMobilePreviewAvailability();
    openMobileFlowView(mobileFlowView, { focus: false });
    return;
  }
  document.body.classList.remove('event-mobile-flow-enabled');
  $('event-form').removeAttribute('data-mobile-view');
  $('event-mobile-flow-hub').hidden = false;
  $('event-mobile-screen-intro').hidden = true;
  renderVisibilityState();
  clearMobileFlowError();
  if (mobileMoreDetailsWasOpen != null) {
    $('more-details').open = mobileMoreDetailsWasOpen;
    mobileMoreDetailsWasOpen = null;
  }
}

function initMobileEventFlow() {
  if (!$('event-mobile-flow')) return;
  document.querySelectorAll('[data-mobile-flow-open]').forEach(button => {
    button.addEventListener('click', () => openMobileFlowView(button.dataset.mobileFlowOpen, { trigger: button }));
  });
  $('event-mobile-flow-back').addEventListener('click', () => {
    if (mobileFlowView === 'hub') return leaveMobileEventEditor();
    if (mobileFlowParentViews[mobileFlowView]) return openMobileFlowView(mobileFlowParentViews[mobileFlowView]);
    if (!editId) {
      const index = mobileCreateSequence.indexOf(mobileFlowView);
      if (index > 0) return openMobileFlowView(mobileCreateSequence[index - 1]);
    }
    returnToMobileFlowHub();
  });
  $('event-mobile-flow-done').addEventListener('click', () => {
    if (mobileFlowParentViews[mobileFlowView]) return openMobileFlowView(mobileFlowParentViews[mobileFlowView]);
    if (!editId) {
      const index = mobileCreateSequence.indexOf(mobileFlowView);
      if (index >= 0 && index < mobileCreateSequence.length - 1) return openMobileFlowView(mobileCreateSequence[index + 1]);
    }
    returnToMobileFlowHub();
  });
  $('event-form').addEventListener('input', () => {
    mobileFlowDirty = true;
    clearMobileFlowError();
    refreshMobileFlowHub();
  });
  $('event-form').addEventListener('change', () => {
    mobileFlowDirty = true;
    clearMobileFlowError();
    refreshMobileFlowHub();
  });
  $('event-form').addEventListener('click', event => {
    if (event.target.closest('button, input, label, select, textarea')) clearMobileFlowError();
    setTimeout(refreshMobileFlowHub, 0);
  });
  $('event-mobile-flow-preview').addEventListener('click', () => {
    if (!savedEventDetails?.slug) return;
    window.open(`/e/${encodeURIComponent(savedEventDetails.slug)}`, '_blank', 'noopener');
  });
  $('event-form').addEventListener('invalid', event => {
    if (!mobileFlowMedia.matches) return;
    const panel = mobileFlowPanelForElement(event.target);
    if (panel && panel !== mobileFlowView) openMobileFlowView(panel, { focus: false });
  }, true);
  if (typeof mobileFlowMedia.addEventListener === 'function') mobileFlowMedia.addEventListener('change', syncMobileFlowMode);
  else mobileFlowMedia.addListener(syncMobileFlowMode);
  syncMobileFlowMode();
  if (!editId) {
    resetMobileFlowBaseline();
    Promise.allSettled([organizerProfileReady, commerceConfigReady]).then(() => {
      if (!mobileFlowDirty) resetMobileFlowBaseline();
    });
  }
}

function showError(msg) {
  if (mobileFlowMedia.matches && $('event-mobile-flow-error')) {
    revealMobileFlowError(msg);
    const mobileError = $('event-mobile-flow-error');
    mobileError.textContent = msg;
    mobileError.hidden = false;
    window.scrollTo({ top: 0, behavior: 'smooth' });
    requestAnimationFrame(() => mobileError.focus({ preventScroll: true }));
    return;
  }
  const el = $('error');
  el.textContent = msg;
  el.style.display = 'block';
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function collect() {
  const hasSecondVibe = !$('vibe-choice-two').hidden;
  const hasThirdVibe = !$('vibe-choice-three').hidden;
  const locationState = publishLocationState();
  if (!locationState.valid) throw new Error(locationState.error);
  const { venueName, venueAddress } = locationState;
  const flyerInstagram = presentationMode === 'flyer'
    ? normalizeFlyerDesignerHandle({ focus: true })
    : { value: null, error: null };
  if (flyerInstagram.error) throw new Error(flyerInstagram.error);
  const body = {
    title: $('title').value.trim(),
    description: $('description').value.trim(),
    event_vibe_url: $('event_vibe_url').value.trim() || null,
    event_vibe_label: $('event_vibe_label').value.trim() || null,
    event_vibe_image_url: $('event_vibe_image_url').value || null,
    event_vibe_url_2: hasSecondVibe ? ($('event_vibe_url_2').value.trim() || null) : null,
    event_vibe_label_2: hasSecondVibe ? ($('event_vibe_label_2').value.trim() || null) : null,
    event_vibe_image_url_2: hasSecondVibe ? ($('event_vibe_image_url_2').value || null) : null,
    event_vibe_url_3: hasThirdVibe ? ($('event_vibe_url_3').value.trim() || null) : null,
    event_vibe_label_3: hasThirdVibe ? ($('event_vibe_label_3').value.trim() || null) : null,
    event_vibe_image_url_3: hasThirdVibe ? ($('event_vibe_image_url_3').value || null) : null,
    cover_image_url: $('cover_image_url').value || null,
    cover_fit_mode: coverFitMode,
    presentation_mode: presentationMode,
    flyer_image_url: $('flyer_image_url').value || null,
    flyer_designer_name: presentationMode === 'flyer' ? ($('flyer-designer-name').value.trim() || null) : null,
    flyer_designer_instagram_handle: flyerInstagram.value,
    artwork_accent_color: artworkAccents.get(activeArtworkUrl()) || null,
    event_date: $('event_date').value,
    start_time: $('start_time').value,
    venue_name: venueName || LocationUtils.addressFallback(venueAddress),
    venue_address: venueAddress,
    venue_city: $('venue_city').value || null,
    venue_state: $('venue_state').value || null,
    venue_latitude: $('venue_latitude').value || null,
    venue_longitude: $('venue_longitude').value || null,
    google_place_id: $('google_place_id').value || null,
    category: $('category').value || null,
    capacity: $('capacity').value || null,
    visibility,
    show_guest_list: $('show_guest_list').checked,
    allow_guests: $('allow_guests').checked,
    comments_enabled: $('comments_enabled').checked,
    sms_reminder_enabled: $('sms_reminder_enabled').checked,
    secret_show_enabled: visibility === 'private' && $('secret_show_enabled').checked,
    secret_code: $('secret_show_enabled').checked ? $('secret_code').value : '',
    secret_code_confirm: $('secret_show_enabled').checked ? $('secret_code_confirm').value : '',
    background_theme: $('background_theme').value,
    admission_type: admissionType,
    ticket_price: admissionType === 'external_tickets' ? ($('ticket_price').value || null) : null,
    ticket_url: admissionType === 'external_tickets' ? ($('ticket_url').value.trim() || null) : null,
    commerce_event_id: admissionType === 'silver_glider_tickets' ? commerceEventId : null,
    cover_credit_name: $('cover_credit_name').value || null,
    cover_credit_link: $('cover_credit_link').value || null
  };
  if (!editId) body.presenter_name = $('presenter_name').value.trim() || null;
  return body;
}

// Edit mode — prefill
if (editId) {
  document.title = 'Music & Advanced Settings — Silver Glider Events';
  $('page-title').textContent = 'Music & advanced settings';
  document.querySelector('.sg-page-sub').textContent = 'Fine-tune the optional parts of your event.';
  $('publish-btn').textContent = 'Save Changes';
  $('secret-shortcut').hidden = true;
  api(`/api/events/${editId}`).then(({ event }) => {
    savedEventDetails = event;
    savedRsvpCount = Number(event.rsvp_count) || 0;
    $('title').value = event.title;
    $('description').value = event.description || '';
    $('event_vibe_url').value = event.event_vibe_url || '';
    $('event_vibe_label').value = event.event_vibe_label || '';
    setVibePhoto(1, event.event_vibe_image_url || '');
    if (event.event_vibe_url_2 || event.event_vibe_label_2 || event.event_vibe_image_url_2) {
      setSecondVibeVisible(true);
      $('event_vibe_label_2').value = event.event_vibe_label_2 || '';
      $('event_vibe_url_2').value = event.event_vibe_url_2 || '';
      setVibePhoto(2, event.event_vibe_image_url_2 || '');
    }
    if (event.event_vibe_url_3 || event.event_vibe_label_3 || event.event_vibe_image_url_3) {
      setThirdVibeVisible(true);
      $('event_vibe_label_3').value = event.event_vibe_label_3 || '';
      $('event_vibe_url_3').value = event.event_vibe_url_3 || '';
      setVibePhoto(3, event.event_vibe_image_url_3 || '');
    }
    $('event_date').value = event.event_date.slice(0, 10);
    $('start_time').value = String(event.start_time).slice(0, 5);
    populateLocationEditor(event.venue_name, event.venue_address || '');
    $('venue_city').value = event.venue_city || '';
    $('venue_state').value = event.venue_state || '';
    $('venue_latitude').value = event.venue_latitude || '';
    $('venue_longitude').value = event.venue_longitude || '';
    $('google_place_id').value = event.google_place_id || '';
    $('category').value = event.category || '';
    $('capacity').value = event.capacity || '';
    $('show_guest_list').checked = event.show_guest_list === true;
    $('allow_guests').checked = event.allow_guests === true;
    $('comments_enabled').checked = event.comments_enabled === true;
    $('sms_reminder_enabled').checked = event.sms_reminder_enabled === true;
    setVisibility(event.visibility);
    hasSavedSecretCode = event.secret_show_enabled === true;
    setSecretShow(hasSavedSecretCode);
    if (hasSavedSecretCode) {
      $('secret-code-help').textContent = 'The current code is protected. Leave both fields blank to keep it, or enter a new matching code to replace it.';
    }
    setTheme(THEMES.includes(event.background_theme) ? event.background_theme : 'midnight');
    setPresentationMode(event.presentation_mode === 'flyer' ? 'flyer' : 'standard');
    setCoverFitMode(event.cover_fit_mode || 'auto');
    if (event.flyer_image_url) setFlyer(event.flyer_image_url);
    $('flyer-designer-name').value = event.flyer_designer_name || '';
    $('flyer-designer-instagram').value = event.flyer_designer_instagram_handle ? `@${event.flyer_designer_instagram_handle}` : '';
    commerceEventId = event.commerce_event_id || null;
    $('commerce_event_id').value = commerceEventId || '';
    setAdmission(event.admission_type === 'silver_glider_tickets'
      ? 'silver_glider_tickets'
      : (event.admission_type === 'paid' || event.admission_type === 'external_tickets')
        ? 'external_tickets'
        : 'free_rsvp', { force: true });
    $('ticket_price').value = event.ticket_price || '';
    $('ticket_url').value = event.ticket_url || '';
    $('more-details').open = Boolean(event.description || event.event_vibe_url || event.event_vibe_image_url || event.event_vibe_url_2 || event.event_vibe_image_url_2 || event.event_vibe_url_3 || event.event_vibe_image_url_3);
    if (event.cover_image_url) {
      setCover(event.cover_image_url, event.cover_credit_name, event.cover_credit_link, { preserveFit: true });
    }
    refreshActiveArtworkAccent({ knownAccent: event.artwork_accent_color });
    finishEditLoading();
  }).catch(showEditLoadError);
}

$('event-form').addEventListener('submit', async e => {
  e.preventDefault();
  if (!validateRequiredFields()) return;
  const btn = $('publish-btn');
  btn.disabled = true;
  btn.textContent = editId ? 'Saving…' : 'Publishing…';
  try {
    await organizerProfileReady;
    await commerceConfigReady;
    if (presentationMode === 'flyer' && !$('flyer_image_url').value) {
      throw new Error('Upload a flyer before publishing this event');
    }
    await refreshActiveArtworkAccent();
    const body = collect();
    if (editId && savedEventDetails && savedRsvpCount > 0) {
      const changes = window.SGEEventChanges.compare(savedEventDetails, body);
      if (changes.length) {
        btn.textContent = 'Review changes…';
        const choice = await window.SGEEventChanges.confirmUpdate({ changes, count: savedRsvpCount });
        if (choice === 'cancel') {
          btn.disabled = false;
          btn.textContent = 'Save Changes';
          return;
        }
        body.notify_attendees = choice === 'notify';
        btn.textContent = 'Saving…';
      }
    }
    const data = editId
      ? await api(`/api/events/${editId}`, { method: 'PUT', body })
      : await api('/api/events', { method: 'POST', body });
    if (data.notification?.queued) {
      sessionStorage.setItem('sge-manage-message', `Event updated. We’re notifying ${data.notification.queued} ${data.notification.queued === 1 ? 'guest' : 'guests'}.`);
    } else if (editId) {
      sessionStorage.setItem('sge-manage-message', 'Event updated.');
    }
    window.location.href = `/events/${data.event.id}/manage${editId ? '' : '?created=1'}`;
  } catch (err) {
    showError(err.message);
    btn.disabled = false;
    btn.textContent = editId ? 'Save Changes' : 'Publish Event';
  }
});

initMobileEventFlow();
