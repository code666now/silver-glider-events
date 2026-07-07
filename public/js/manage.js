renderNav('events');

const eventId = location.pathname.split('/')[2];
const $ = id => document.getElementById(id);
let eventData = null;

if (new URLSearchParams(location.search).get('created')) {
  $('created-note').style.display = 'block';
}

function eventUrl() {
  return `${location.origin}/e/${eventData.slug}`;
}

async function loadEvent() {
  const { event } = await api(`/api/events/${eventId}`);
  eventData = event;
  document.title = `${event.title} — Silver Glider Events`;

  $('title').textContent = event.title;
  const dateStr = new Date(event.event_date).toLocaleDateString('en-US',
    { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  $('meta').textContent = `${dateStr} · ${event.venue_name}`;

  if (event.cover_image_url) {
    $('hero').style.display = 'block';
    $('hero-img').src = event.cover_image_url;
  }

  const badge = $('status-badge');
  if (event.status === 'cancelled') { badge.className = 'sg-badge sg-badge-danger'; badge.textContent = 'Cancelled'; }
  else if (event.status === 'draft') { badge.className = 'sg-badge'; badge.textContent = 'Draft'; }
  else if (event.visibility === 'private') { badge.className = 'sg-badge'; badge.textContent = 'Private'; }
  else { badge.className = 'sg-badge sg-badge-accent'; badge.textContent = 'Live'; }

  $('stat-count').textContent = event.rsvp_count;
  if (event.capacity) {
    $('cap-bar').style.display = 'block';
    $('cap-fill').style.width = `${Math.min(100, (event.rsvp_count / event.capacity) * 100)}%`;
    $('stat-count').textContent = `${event.rsvp_count}/${event.capacity}`;
  }

  const days = Math.round((new Date(event.event_date) - new Date(new Date().toDateString())) / 86400000);
  if (days > 0) { $('stat-days').textContent = days; $('days-label').textContent = days === 1 ? 'Day away' : 'Days away'; }
  else if (days === 0) { $('stat-days').textContent = 'Today'; $('days-label').textContent = 'Event day'; }
  else { $('stat-days').textContent = `${-days}d`; $('days-label').textContent = 'Ago'; }

  $('view-link').href = eventUrl();
  $('edit-link').href = `/events/${eventId}/edit`;
  $('qr').src = `/e/${event.slug}/qr.png`;

  if (event.status === 'cancelled') {
    $('cancel-event').style.display = 'none';
    $('submit-line').style.display = 'none';
  }
}

async function loadLineStatus() {
  try {
    const { submission } = await api(`/api/events/${eventId}/line-status`);
    if (!submission) return;
    const btn = $('submit-line');
    btn.disabled = true;
    btn.textContent = submission.status === 'approved' ? 'Featured by Silver Glider'
      : submission.status === 'rejected' ? 'Not selected for feature'
      : 'Submitted for feature';
    if (submission.status === 'approved') { btn.style.color = 'var(--sg-accent)'; btn.style.borderColor = 'var(--sg-accent)'; }
  } catch (_) {}
}

async function loadGuests(search = '') {
  const { rsvps } = await api(`/api/events/${eventId}/rsvps${search ? `?search=${encodeURIComponent(search)}` : ''}`);
  const active = rsvps.filter(r => r.status === 'confirmed');
  const tbody = $('guest-rows');
  tbody.innerHTML = active.map(r => `
    <tr>
      <td>${r.first_name} ${r.last_name}</td>
      <td class="dim">${r.email}</td>
      <td class="dim">${r.phone || '—'}</td>
      <td class="dim">${new Date(r.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</td>
    </tr>`).join('');
  $('no-guests').style.display = active.length ? 'none' : 'block';
  $('guests').style.display = active.length ? 'table' : 'none';
}

$('copy-link').addEventListener('click', async () => {
  await navigator.clipboard.writeText(eventUrl());
  toast('Link copied');
});

$('export-csv').addEventListener('click', () => {
  window.location.href = `/api/events/${eventId}/rsvps.csv`;
});

$('duplicate').addEventListener('click', async () => {
  const { event } = await api(`/api/events/${eventId}/duplicate`, { method: 'POST' });
  window.location.href = `/events/${event.id}/edit`;
});

async function loadFollowers() {
  try {
    const { count, announcedAt, announcedCount, canAnnounce } = await api(`/api/events/${eventId}/followers`);
    const btn = $('announce');
    if (announcedAt && announcedCount > 0) {
      btn.style.display = '';
      btn.disabled = true;
      btn.textContent = `${announcedCount} ${announcedCount === 1 ? 'follower' : 'followers'} invited`;
      return;
    }
    if (!canAnnounce || count === 0) return; // hidden: private/draft/cancelled or no followers yet
    btn.style.display = '';
    btn.dataset.count = count;
    btn.textContent = `Invite ${count} ${count === 1 ? 'follower' : 'followers'}`;
  } catch (_) {}
}

$('announce').addEventListener('click', async () => {
  const count = $('announce').dataset.count || 'your';
  if (!confirm(`Send this event to ${count} ${count === '1' ? 'follower' : 'followers'} who asked to hear about future events? This can only be done once.`)) return;
  $('announce').disabled = true;
  $('announce').textContent = 'Sending…';
  try {
    const { sent } = await api(`/api/events/${eventId}/announce`, { method: 'POST' });
    toast(`${sent} ${sent === 1 ? 'follower' : 'followers'} invited`);
    $('announce').textContent = `${sent} ${sent === 1 ? 'follower' : 'followers'} invited`;
  } catch (err) {
    toast(err.message);
    $('announce').disabled = false;
    loadFollowers();
  }
});

$('submit-line').addEventListener('click', async () => {
  await api(`/api/events/${eventId}/submit-to-line`, { method: 'POST' });
  toast('Submitted for feature');
  loadLineStatus();
});

$('cancel-event').addEventListener('click', async () => {
  if (!confirm('Cancel this event? The public page will show it as cancelled.')) return;
  await api(`/api/events/${eventId}/cancel`, { method: 'POST' });
  toast('Event cancelled');
  loadEvent();
});

let searchTimer;
$('search').addEventListener('input', e => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => loadGuests(e.target.value.trim()), 250);
});

loadEvent().then(() => { loadGuests(); loadLineStatus(); loadFollowers(); });
