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

const $ = id => document.getElementById(id);
const ArtworkColor = window.SGArtworkColor;
const artworkAccents = new Map();
let artworkAccentPromise = Promise.resolve(null);

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
}

function showEditLoadError() {
  $('event-form').setAttribute('aria-busy', 'false');
  $('event-edit-skeleton').removeAttribute('aria-label');
  $('event-edit-skeleton').innerHTML = `<div class="event-edit-load-error"><h2>We couldn't load this event.</h2><p>Your event has not been changed. Try loading the editor again.</p><a class="sg-btn sg-btn-ghost" href="/events/${encodeURIComponent(editId)}/edit">Try again</a></div>`;
}

function setSecondVibeVisible(visible) {
  const singleLink = $('vibe-single-link');
  const firstChoice = $('vibe-choice-one');
  const secondChoice = $('vibe-choice-two');
  if (visible) {
    $('event_vibe_url_labeled').value = $('event_vibe_url_labeled').value || $('event_vibe_url').value;
    singleLink.hidden = true;
    firstChoice.hidden = false;
    secondChoice.hidden = false;
    $('add-vibe-choice').hidden = true;
    $('remove-vibe-choice').hidden = false;
  } else {
    $('event_vibe_url').value = $('event_vibe_url_labeled').value || $('event_vibe_url').value;
    $('event_vibe_label').value = '';
    $('event_vibe_url_labeled').value = '';
    $('event_vibe_label_2').value = '';
    $('event_vibe_url_2').value = '';
    singleLink.hidden = false;
    firstChoice.hidden = true;
    secondChoice.hidden = true;
    $('add-vibe-choice').hidden = false;
    $('remove-vibe-choice').hidden = true;
  }
}

$('add-vibe-choice').addEventListener('click', () => {
  setSecondVibeVisible(true);
  $('event_vibe_label').focus();
});
$('remove-vibe-choice').addEventListener('click', () => setSecondVibeVisible(false));

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
  refreshActiveArtworkAccent();
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
  button.setAttribute('aria-pressed', String(commerceInterested));
  button.textContent = commerceInterested ? 'Remove me' : 'Notify me';
  $('commerce-interest-copy').innerHTML = commerceInterested
    ? '<strong>You’re on the list.</strong><span>We’ll email you when Silver Glider Tickets is ready.</span>'
    : '<strong>Want to know when Silver Glider Tickets launches?</strong><span>We’ll send you one email when it’s ready.</span>';
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

function setVisibility(v) {
  const secretShowWasDisabled = v === 'public' && $('secret_show_enabled').checked;
  if (secretShowWasDisabled) setSecretShow(false);
  visibility = v;
  $('vis-public').classList.toggle('on', v === 'public');
  $('vis-private').classList.toggle('on', v === 'private');
  $('vis-public').setAttribute('aria-pressed', String(v === 'public'));
  $('vis-private').setAttribute('aria-pressed', String(v === 'private'));
  $('private-settings').classList.toggle('show', v === 'private');
  if (secretShowWasDisabled) toast('Secret Show Mode was turned off for this public event');
  return true;
}
$('vis-public').addEventListener('click', () => setVisibility('public'));
$('vis-private').addEventListener('click', () => setVisibility('private'));

function setSecretShow(enabled, { focus = false } = {}) {
  if (enabled) setVisibility('private');
  $('secret_show_enabled').checked = enabled;
  $('secret-code-fields').classList.toggle('show', enabled);
  const requiresCode = enabled && !hasSavedSecretCode;
  $('secret_code').required = requiresCode;
  $('secret_code_confirm').required = requiresCode;
  if (!enabled) {
    $('secret_code').value = '';
    $('secret_code_confirm').value = '';
  }
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
const EFFECTS = ['adaptive', 'halloween', 'last-guest', 'disco', 'fog', 'paper', 'static', 'saloon'];
const THEMES = [...GRADIENTS, ...EFFECTS];
const THEME_LABELS = {
  midnight: 'Midnight', aurora: 'Aurora', sunset: 'Sunset', ocean: 'Ocean',
  adaptive: 'Default wall',
  halloween: 'Halloween', 'last-guest': 'The Last Guest',
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

// ── Venue autocomplete: optional Google Places helper, manual flow remains intact ──
const placeFields = ['venue_city', 'venue_state', 'venue_latitude', 'venue_longitude', 'google_place_id'];
let applyingPlace = false;
let placesLoader;

function setPlacesStatus(message) {
  const el = $('places-status');
  if (el) el.textContent = message || '';
}

function clearPlaceMeta() {
  placeFields.forEach(id => { $(id).value = ''; });
}

function placeComponent(place, types, name = 'long_name') {
  const component = (place.address_components || []).find(part => types.some(type => part.types.includes(type)));
  return component ? component[name] : '';
}

function applySelectedPlace(place) {
  if (!place) return;
  applyingPlace = true;
  const venueName = place.name || $('venue_name').value.trim();
  const address = place.formatted_address || '';
  $('venue_name').value = venueName;
  if (address) $('venue_address').value = address;
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

async function initVenueAutocomplete() {
  try {
    setPlacesStatus('Loading venue suggestions...');
    const { enabled, apiKey } = await api('/api/places/config');
    if (!enabled || !apiKey) {
      setPlacesStatus('');
      return;
    }
    await loadGooglePlaces(apiKey);
    const autocomplete = new google.maps.places.Autocomplete($('venue_name'), {
      fields: ['name', 'formatted_address', 'address_components', 'geometry', 'place_id'],
      types: ['establishment']
    });
    autocomplete.addListener('place_changed', () => applySelectedPlace(autocomplete.getPlace()));
    setPlacesStatus('');
  } catch (_) {
    setPlacesStatus('Venue suggestions unavailable. You can enter the venue manually.');
  }
}

$('venue_name').addEventListener('input', () => {
  if (!applyingPlace) clearPlaceMeta();
});
$('venue_address').addEventListener('input', () => {
  if (!applyingPlace) clearPlaceMeta();
});
initVenueAutocomplete();

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

function showError(msg) {
  const el = $('error');
  el.textContent = msg;
  el.style.display = 'block';
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function collect() {
  const hasSecondVibe = !$('vibe-choice-two').hidden;
  const body = {
    title: $('title').value.trim(),
    description: $('description').value.trim(),
    event_vibe_url: (hasSecondVibe ? $('event_vibe_url_labeled') : $('event_vibe_url')).value.trim() || null,
    event_vibe_label: hasSecondVibe ? ($('event_vibe_label').value.trim() || null) : null,
    event_vibe_url_2: hasSecondVibe ? ($('event_vibe_url_2').value.trim() || null) : null,
    event_vibe_label_2: hasSecondVibe ? ($('event_vibe_label_2').value.trim() || null) : null,
    cover_image_url: $('cover_image_url').value || null,
    cover_fit_mode: coverFitMode,
    presentation_mode: presentationMode,
    flyer_image_url: $('flyer_image_url').value || null,
    artwork_accent_color: artworkAccents.get(activeArtworkUrl()) || null,
    event_date: $('event_date').value,
    start_time: $('start_time').value,
    venue_name: $('venue_name').value.trim(),
    venue_address: $('venue_address').value.trim(),
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
  document.title = 'Edit Event — Silver Glider Events';
  $('page-title').textContent = 'Edit Event';
  document.querySelector('.sg-page-sub').textContent = 'Changes go live as soon as you save.';
  $('publish-btn').textContent = 'Save Changes';
  $('secret-shortcut').hidden = true;
  api(`/api/events/${editId}`).then(({ event }) => {
    $('title').value = event.title;
    $('description').value = event.description || '';
    $('event_vibe_url').value = event.event_vibe_url || '';
    if (event.event_vibe_url_2) {
      setSecondVibeVisible(true);
      $('event_vibe_label').value = event.event_vibe_label || '';
      $('event_vibe_url_labeled').value = event.event_vibe_url || '';
      $('event_vibe_label_2').value = event.event_vibe_label_2 || '';
      $('event_vibe_url_2').value = event.event_vibe_url_2 || '';
    }
    $('event_date').value = event.event_date.slice(0, 10);
    $('start_time').value = String(event.start_time).slice(0, 5);
    $('venue_name').value = event.venue_name;
    $('venue_address').value = event.venue_address || '';
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
    commerceEventId = event.commerce_event_id || null;
    $('commerce_event_id').value = commerceEventId || '';
    setAdmission(event.admission_type === 'silver_glider_tickets'
      ? 'silver_glider_tickets'
      : (event.admission_type === 'paid' || event.admission_type === 'external_tickets')
        ? 'external_tickets'
        : 'free_rsvp', { force: true });
    $('ticket_price').value = event.ticket_price || '';
    $('ticket_url').value = event.ticket_url || '';
    $('more-details').open = Boolean(event.description || event.event_vibe_url || event.event_vibe_url_2);
    if (event.cover_image_url) {
      setCover(event.cover_image_url, event.cover_credit_name, event.cover_credit_link, { preserveFit: true });
    }
    refreshActiveArtworkAccent({ knownAccent: event.artwork_accent_color });
    finishEditLoading();
  }).catch(showEditLoadError);
}

$('event-form').addEventListener('submit', async e => {
  e.preventDefault();
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
    const data = editId
      ? await api(`/api/events/${editId}`, { method: 'PUT', body })
      : await api('/api/events', { method: 'POST', body });
    window.location.href = `/events/${data.event.id}/manage${editId ? '' : '?created=1'}`;
  } catch (err) {
    showError(err.message);
    btn.disabled = false;
    btn.textContent = editId ? 'Save Changes' : 'Publish Event';
  }
});
