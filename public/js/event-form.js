renderNav('events');

const editId = new URLSearchParams(location.search).get('id');
let visibility = 'public';
let admissionType = 'free_rsvp';

const $ = id => document.getElementById(id);

function setVisibility(v) {
  visibility = v;
  $('vis-public').classList.toggle('on', v === 'public');
  $('vis-private').classList.toggle('on', v === 'private');
}
$('vis-public').addEventListener('click', () => setVisibility('public'));
$('vis-private').addEventListener('click', () => setVisibility('private'));

function setAdmission(v) {
  admissionType = v === 'paid' ? 'paid' : 'free_rsvp';
  $('admission-free').classList.toggle('on', admissionType === 'free_rsvp');
  $('admission-paid').classList.toggle('on', admissionType === 'paid');
  $('ticket-fields').classList.toggle('show', admissionType === 'paid');
  $('ticket_price').required = admissionType === 'paid';
  $('ticket_url').required = false;
  if (admissionType === 'free_rsvp') {
    $('ticket_price').value = '';
    $('ticket_url').value = '';
  }
}
$('admission-free').addEventListener('click', () => setAdmission('free_rsvp'));
$('admission-paid').addEventListener('click', () => setAdmission('paid'));

// Background picker — gradients + generative effects
const THEMES = ['midnight', 'aurora', 'sunset', 'ocean', 'violet', 'ember', 'static', 'vhs'];
const EFFECTS = ['static', 'vhs'];
const THEME_LABELS = { static: 'TV static', vhs: 'VHS' };
function setTheme(key) {
  $('background_theme').value = key;
  document.querySelectorAll('#theme-picker .sg-swatch').forEach(s => s.classList.toggle('on', s.dataset.theme === key));
}
THEMES.forEach(key => {
  const sw = document.createElement('div');
  sw.className = 'sg-swatch ' + (EFFECTS.includes(key) ? 'fx-' : 'bg-') + key;
  sw.dataset.theme = key;
  sw.title = THEME_LABELS[key] || (key.charAt(0).toUpperCase() + key.slice(1));
  sw.addEventListener('click', () => setTheme(key));
  $('theme-picker').appendChild(sw);
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
let activeImageCategory = '⭐ Featured';
let lastPhotos = [];
let searchTimer;
let currentPhotoQuery = '';
let currentPhotoCategory = '';
let currentPhotoPage = 0;
let currentPhotoTotalPages = 1;
let photoLoading = false;
let photoScrollBound = false;
let lastPhotoLoadAt = 0;
const IMAGE_BG_CLASSES = [];
let pickerBgTimer;

// User-facing visual themes stay simple; hidden queries are tuned for
// inspirational event backgrounds rather than literal event-type matches.
const IMAGE_CATEGORIES = [
  { label: '⭐ Featured', query: 'concert nightlife festival live event atmospheric background', bgClass: 'picker-bg-featured', colors: ['#155b5a', '#30255f', '#75511f'] },
  { label: '🎞️ Film', query: 'cinematic film moody lighting grain dramatic shadows', bgClass: 'picker-bg-film', colors: ['#243142', '#4b3345', '#8a5f31'] },
  { label: '🌿 Nature', query: 'forest mountains plants sky natural light background', bgClass: 'picker-bg-nature', colors: ['#164c3a', '#17495b', '#546629'] },
  { label: '✨ Abstract', query: 'abstract gradients shapes soft color background', bgClass: 'picker-bg-abstract', colors: ['#2b3c7b', '#6e3277', '#167577'] },
  { label: '🎨 Textures', query: 'concrete paper grain fabric texture background', bgClass: 'picker-bg-textures', colors: ['#4a443e', '#272c35', '#5a4930'] },
  { label: '📐 Patterns', query: 'geometric repeating patterns graphic design background', bgClass: 'picker-bg-patterns', colors: ['#153f47', '#352d63', '#5d5d5f'] },
  { label: '🌈 Colorful', query: 'vibrant colors neon rainbow bright abstract background', bgClass: 'picker-bg-colorful', colors: ['#196b72', '#6a3574', '#7c4f1c'] },
  { label: '🌙 Dark', query: 'black shadows low light dark moody background', bgClass: 'picker-bg-dark', colors: ['#0c1625', '#21152f', '#331c32'] },
  { label: '☀️ Summer', query: 'sunshine beach warm colors golden light background', bgClass: 'picker-bg-summer', colors: ['#6c5017', '#88472c', '#1d6470'] },
  { label: '📼 Nostalgia', query: 'vintage retro analog 90s nostalgic background', bgClass: 'picker-bg-nostalgia', colors: ['#5b3c57', '#765132', '#244c5d'] },
  { label: '🏙️ Urban', query: 'city architecture streets nightlife urban lights', bgClass: 'picker-bg-urban', colors: ['#142b42', '#3a345e', '#6c4d21'] },
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

function softenRgb({ r, g, b }) {
  const darken = 0.56;
  const desaturate = 0.34;
  const avg = (r + g + b) / 3;
  return {
    r: Math.round((avg * desaturate + r * (1 - desaturate)) * darken),
    g: Math.round((avg * desaturate + g * (1 - desaturate)) * darken),
    b: Math.round((avg * desaturate + b * (1 - desaturate)) * darken)
  };
}

function rgbToHex({ r, g, b }) {
  return '#' + [r, g, b].map(value => value.toString(16).padStart(2, '0')).join('');
}

function loadImageForPalette(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

async function extractImagePalette(url) {
  const img = await loadImageForPalette(url);
  const canvas = document.createElement('canvas');
  const size = 36;
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, size, size);
  const data = ctx.getImageData(0, 0, size, size).data;
  const buckets = new Map();
  for (let i = 0; i < data.length; i += 16) {
    const alpha = data[i + 3];
    if (alpha < 128) continue;
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    if (luminance < 0.08 || luminance > 0.93) continue;
    const key = [r, g, b].map(value => Math.round(value / 32) * 32).join(',');
    const bucket = buckets.get(key) || { r: 0, g: 0, b: 0, count: 0 };
    bucket.r += r;
    bucket.g += g;
    bucket.b += b;
    bucket.count += 1;
    buckets.set(key, bucket);
  }
  const swatches = [...buckets.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, 3)
    .map(bucket => softenRgb({
      r: Math.round(bucket.r / bucket.count),
      g: Math.round(bucket.g / bucket.count),
      b: Math.round(bucket.b / bucket.count)
    }))
    .map(rgbToHex);
  if (swatches.length < 2) throw new Error('Not enough image color data');
  return swatches;
}

async function applySelectedImagePalette(url) {
  try {
    const colors = await extractImagePalette(url);
    applyPickerBackground({ colors: [colors[0], colors[1], colors[2] || colors[0]] }, 'picker-bg-photo');
  } catch (_) {
    const fallback = IMAGE_CATEGORIES.find(category => category.label === activeImageCategory) || IMAGE_CATEGORIES[0];
    applyPickerBackground(fallback);
  }
}

function setCover(url, creditName, creditLink) {
  $('cover_image_url').value = url || '';
  $('cover_credit_name').value = creditName || '';
  $('cover_credit_link').value = creditLink || '';
  const img = $('cover-preview');
  const fallbackBackground = $('fallback-background-field');
  if (fallbackBackground) fallbackBackground.style.display = url ? 'none' : '';
  if (url) {
    img.src = url;
    img.style.display = 'block';
    drop.classList.add('has-image');
    $('btn-clear-cover').style.display = '';
    markSelectedPhoto(url);
  } else {
    img.style.display = 'none';
    drop.classList.remove('has-image');
    $('btn-clear-cover').style.display = 'none';
    markSelectedPhoto('');
  }
}

function openImageModal() {
  imageModal.classList.add('open');
  imageModal.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
  const theme = IMAGE_CATEGORIES.find(category => category.label === activeImageCategory) || IMAGE_CATEGORIES[0];
  applyPickerBackground(theme);
  if (photosEnabled) loadCategory('⭐ Featured');
}

function closeImageModal() {
  imageModal.classList.remove('open');
  imageModal.setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';
}

drop.addEventListener('click', openImageModal);
$('btn-upload').addEventListener('click', openImageModal);
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
      applySelectedImagePalette(data.url);
      closeImageModal();
    } catch (err) {
      showError(err.message);
    }
  };
  xhr.onerror = () => { progress.style.width = '0%'; showError('Upload failed'); };
  xhr.send(form);
}

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

async function searchPhotos(q, { category = null, page = 1, append = false } = {}) {
  if (photoLoading) return;
  photoLoading = true;
  currentPhotoQuery = q;
  currentPhotoCategory = category || '';
  currentPhotoPage = page;
  const status = $('unsplash-status');
  const grid = $('unsplash-results');
  status.textContent = append ? 'Loading more images...' : 'Loading images...';
  updateLoadMore();
  if (!append) grid.innerHTML = '<div class="picker-empty" style="grid-column:1/-1">Loading images...</div>';
  try {
    const { results, totalPages } = await api(`/api/photos/search?q=${encodeURIComponent(q)}&page=${page}`);
    currentPhotoTotalPages = totalPages || 1;
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
  searchPhotos(item.query, { category: item.label });
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
$('unsplash-q').addEventListener('input', e => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    const q = e.target.value.trim();
    if (q) runSearch();
    else loadCategory(activeImageCategory || '⭐ Featured');
  }, 350);
});

function pickPhoto(photo) {
  setCover(photo.full, photo.credit_name, photo.credit_link);
  applySelectedImagePalette(photo.thumb || photo.full);
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
  return {
    title: $('title').value.trim(),
    description: $('description').value.trim(),
    event_vibe_url: $('event_vibe_url').value.trim() || null,
    cover_image_url: $('cover_image_url').value || null,
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
    background_theme: $('background_theme').value,
    admission_type: admissionType,
    ticket_price: admissionType === 'paid' ? ($('ticket_price').value || null) : null,
    ticket_url: admissionType === 'paid' ? ($('ticket_url').value.trim() || null) : null,
    cover_credit_name: $('cover_credit_name').value || null,
    cover_credit_link: $('cover_credit_link').value || null
  };
}

// Edit mode — prefill
if (editId) {
  document.title = 'Edit Event — Silver Glider Events';
  $('page-title').textContent = 'Edit Event';
  document.querySelector('.sg-page-sub').textContent = 'Changes go live as soon as you save.';
  $('publish-btn').textContent = 'Save Changes';
  api(`/api/events/${editId}`).then(({ event }) => {
    $('title').value = event.title;
    $('description').value = event.description || '';
    $('event_vibe_url').value = event.event_vibe_url || '';
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
    setVisibility(event.visibility);
    setTheme(event.background_theme || 'midnight');
    setAdmission(event.admission_type === 'paid' ? 'paid' : 'free_rsvp');
    $('ticket_price').value = event.ticket_price || '';
    $('ticket_url').value = event.ticket_url || '';
    if (event.cover_image_url) {
      setCover(event.cover_image_url, event.cover_credit_name, event.cover_credit_link);
    }
  }).catch(err => showError(err.message));
}

$('event-form').addEventListener('submit', async e => {
  e.preventDefault();
  const btn = $('publish-btn');
  btn.disabled = true;
  btn.textContent = editId ? 'Saving…' : 'Publishing…';
  try {
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
