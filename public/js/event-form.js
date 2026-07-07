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

// Background theme picker
const THEMES = ['midnight', 'aurora', 'sunset', 'ocean', 'violet', 'ember'];
function setTheme(key) {
  $('background_theme').value = key;
  document.querySelectorAll('#theme-picker .sg-swatch').forEach(s => s.classList.toggle('on', s.dataset.theme === key));
}
THEMES.forEach(key => {
  const sw = document.createElement('div');
  sw.className = 'sg-swatch bg-' + key;
  sw.dataset.theme = key;
  sw.title = key.charAt(0).toUpperCase() + key.slice(1);
  sw.addEventListener('click', () => setTheme(key));
  $('theme-picker').appendChild(sw);
});
setTheme('midnight');

// ── Cover image: upload, Unsplash search, or none ──
const drop = $('cover-drop');
const fileInput = $('cover-input');

function setCover(url, creditName, creditLink) {
  $('cover_image_url').value = url || '';
  $('cover_credit_name').value = creditName || '';
  $('cover_credit_link').value = creditLink || '';
  const img = $('cover-preview');
  if (url) {
    img.src = url;
    img.style.display = 'block';
    drop.classList.add('has-image');
    $('btn-clear-cover').style.display = '';
  } else {
    img.style.display = 'none';
    drop.classList.remove('has-image');
    $('btn-clear-cover').style.display = 'none';
  }
}

drop.addEventListener('click', () => fileInput.click());
$('btn-upload').addEventListener('click', () => fileInput.click());
$('btn-clear-cover').addEventListener('click', () => { setCover(''); });
drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('dragover'); });
drop.addEventListener('dragleave', () => drop.classList.remove('dragover'));
drop.addEventListener('drop', e => {
  e.preventDefault();
  drop.classList.remove('dragover');
  if (e.dataTransfer.files[0]) uploadCover(e.dataTransfer.files[0]);
});
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
      $('unsplash-panel').style.display = 'none';
    } catch (err) {
      showError(err.message);
    }
  };
  xhr.onerror = () => { progress.style.width = '0%'; showError('Upload failed'); };
  xhr.send(form);
}

// Unsplash search — only shown if the server has an access key configured
$('btn-search').addEventListener('click', () => {
  const p = $('unsplash-panel');
  p.style.display = p.style.display === 'none' ? 'block' : 'none';
  if (p.style.display === 'block') $('unsplash-q').focus();
});
api('/api/photos/enabled').then(({ enabled }) => {
  if (enabled) $('btn-search').style.display = '';
}).catch(() => {});

async function runSearch() {
  const q = $('unsplash-q').value.trim();
  if (!q) return;
  const status = $('unsplash-status');
  const grid = $('unsplash-results');
  status.textContent = 'Searching…';
  grid.innerHTML = '';
  try {
    const { results } = await api(`/api/photos/search?q=${encodeURIComponent(q)}`);
    status.textContent = results.length ? '' : 'No photos found. Try another word.';
    results.forEach(photo => {
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.style.cssText = 'padding:0;border:1px solid var(--sg-border);border-radius:10px;overflow:hidden;cursor:pointer;aspect-ratio:1;background:var(--sg-surface)';
      cell.title = `Photo by ${photo.credit_name}`;
      cell.innerHTML = `<img src="${photo.thumb}" alt="" style="width:100%;height:100%;object-fit:cover;display:block">`;
      cell.addEventListener('click', () => pickPhoto(photo));
      grid.appendChild(cell);
    });
  } catch (err) {
    status.textContent = err.message;
  }
}
$('unsplash-go').addEventListener('click', runSearch);
$('unsplash-q').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); runSearch(); } });

function pickPhoto(photo) {
  setCover(photo.full, photo.credit_name, photo.credit_link);
  $('unsplash-panel').style.display = 'none';
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
    cover_image_url: $('cover_image_url').value || null,
    event_date: $('event_date').value,
    start_time: $('start_time').value,
    venue_name: $('venue_name').value.trim(),
    venue_address: $('venue_address').value.trim(),
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
    $('event_date').value = event.event_date.slice(0, 10);
    $('start_time').value = String(event.start_time).slice(0, 5);
    $('venue_name').value = event.venue_name;
    $('venue_address').value = event.venue_address || '';
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
