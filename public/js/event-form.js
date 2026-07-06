renderNav('events');

const editId = new URLSearchParams(location.search).get('id');
let visibility = 'public';

const $ = id => document.getElementById(id);

function setVisibility(v) {
  visibility = v;
  $('vis-public').classList.toggle('on', v === 'public');
  $('vis-private').classList.toggle('on', v === 'private');
}
$('vis-public').addEventListener('click', () => setVisibility('public'));
$('vis-private').addEventListener('click', () => setVisibility('private'));

// Cover upload — click or drag/drop
const drop = $('cover-drop');
const fileInput = $('cover-input');
drop.addEventListener('click', () => fileInput.click());
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
      $('cover_image_url').value = data.url;
      const img = $('cover-preview');
      img.src = data.url;
      img.style.display = 'block';
      drop.classList.add('has-image');
    } catch (err) {
      showError(err.message);
    }
  };
  xhr.onerror = () => { progress.style.width = '0%'; showError('Upload failed'); };
  xhr.send(form);
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
    visibility
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
    if (event.cover_image_url) {
      $('cover_image_url').value = event.cover_image_url;
      const img = $('cover-preview');
      img.src = event.cover_image_url;
      img.style.display = 'block';
      drop.classList.add('has-image');
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
