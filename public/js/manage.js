renderNav('events');

const eventId = location.pathname.split('/')[2];
const $ = id => document.getElementById(id);
let eventData = null;
const LINE_NUMBER = '(844) 261-6758';

function escapeHtml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

if (new URLSearchParams(location.search).get('created')) {
  $('created-note').style.display = 'block';
  api('/api/auth/me').then(({ organizer }) => {
    if (!organizer.public_slug) return;
    $('created-host-note').innerHTML = ` Your host page is also live. <a href="/h/${encodeURIComponent(organizer.public_slug)}" target="_blank" rel="noopener">View it</a> or <a href="/settings">add a logo</a>.`;
  }).catch(() => {});
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
  else if (event.visibility === 'private') { badge.className = 'sg-badge'; badge.textContent = 'Private — Link Only'; }
  else { badge.className = 'sg-badge sg-badge-accent'; badge.textContent = 'Live'; }

  $('stat-rsvps').textContent = event.rsvp_count;
  $('stat-attendance').textContent = event.total_attendance;
  $('stat-guests').textContent = event.guest_count;
  $('stat-comments').textContent = event.comment_count;
  if (event.capacity) {
    $('cap-bar').style.display = 'block';
    $('cap-fill').style.width = `${Math.min(100, (event.total_attendance / event.capacity) * 100)}%`;
    $('stat-attendance').textContent = `${event.total_attendance}/${event.capacity}`;
  }

  $('view-link').href = eventUrl();
  $('edit-link').href = `/events/${eventId}/edit`;

  if (event.status === 'cancelled') {
    $('cancel-event').style.display = 'none';
    $('line-card').style.display = 'none';
  } else if (event.visibility === 'private') {
    $('promotion-copy').textContent = 'Share your private event link or download its QR code.';
    $('submit-line').style.display = 'none';
    $('line-status').style.display = 'none';
  }
}

function setLineCard({ title, copy, button, disabled, selected }) {
  $('line-title').textContent = title;
  $('line-copy').textContent = copy;
  $('submit-line').textContent = button;
  $('submit-line').disabled = !!disabled;
  $('submit-line').style.color = selected ? 'var(--sg-accent)' : '';
  $('submit-line').style.borderColor = selected ? 'var(--sg-accent)' : '';
}

async function loadLineStatus() {
  try {
    const { submission } = await api(`/api/events/${eventId}/line-status`);
    if (!submission) return;
    if (submission.status === 'approved') {
      setLineCard({
        title: 'You were selected',
        copy: `Your event is in this week's picks. Call The Line: ${LINE_NUMBER}`,
        button: 'You were selected',
        disabled: true,
        selected: true
      });
    } else if (submission.status === 'rejected') {
      setLineCard({
        title: 'Not selected this week',
        copy: 'You can keep sharing your event link directly.',
        button: 'Not selected this week',
        disabled: true
      });
    } else {
      setLineCard({
        title: 'Submitted to The Line',
        copy: "We'll review it for this week's picks.",
        button: 'Submitted to The Line',
        disabled: true
      });
    }
  } catch (_) {}
}

async function loadGuests(search = '') {
  const { rsvps } = await api(`/api/events/${eventId}/rsvps${search ? `?search=${encodeURIComponent(search)}` : ''}`);
  const active = rsvps.filter(r => r.status === 'confirmed');
  const tbody = $('guest-rows');
  tbody.innerHTML = active.map(r => `
    <tr>
      <td>${escapeHtml(`${r.first_name} ${r.last_name}`.trim())}</td>
      <td class="dim">${escapeHtml(r.email)}</td>
      <td>${r.guest_first_name ? escapeHtml(`${r.guest_first_name} ${r.guest_last_name || ''}`.trim()) : '—'}</td>
      <td class="dim">${escapeHtml(r.guest_email || '—')}</td>
      <td class="dim">${new Date(r.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</td>
    </tr>`).join('');
  $('no-guests').style.display = active.length ? 'none' : 'block';
  $('guests').style.display = active.length ? 'table' : 'none';
  $('export-csv').disabled = active.length === 0;
}

$('copy-link').addEventListener('click', async () => {
  await navigator.clipboard.writeText(eventUrl());
  toast('Link copied');
});

$('share-event').addEventListener('click', async () => {
  const shareData = { title: eventData.title, url: eventUrl() };
  try {
    if (navigator.share) {
      await navigator.share(shareData);
    } else {
      await navigator.clipboard.writeText(eventUrl());
      toast('Event link copied');
    }
  } catch (err) {
    if (err.name !== 'AbortError') toast('Could not share this event');
  }
});

$('download-qr').addEventListener('click', async () => {
  const button = $('download-qr');
  button.disabled = true;
  try {
    const response = await fetch(`/e/${eventData.slug}/qr.png`);
    if (!response.ok) throw new Error('Could not download QR code');
    const objectUrl = URL.createObjectURL(await response.blob());
    const link = document.createElement('a');
    link.href = objectUrl;
    link.download = `${eventData.slug}-qr-code.png`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(objectUrl);
    toast('QR code downloaded');
  } catch (err) {
    toast(err.message || 'Could not download QR code');
  } finally {
    button.disabled = false;
  }
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
  if (!confirm('Submit this event to The Line for a chance to be selected this week?')) return;
  await api(`/api/events/${eventId}/submit-to-line`, { method: 'POST' });
  toast('Submitted to The Line');
  loadLineStatus();
});

$('delete-event').addEventListener('click', async () => {
  const name = eventData ? `"${eventData.title}"` : 'this event';
  if (!confirm(`Delete ${name} permanently? This removes the event AND its entire guest list. This can't be undone.`)) return;
  if (!confirm('Last check — are you sure? Guest emails and RSVPs will be gone forever.')) return;
  try {
    await api(`/api/events/${eventId}`, { method: 'DELETE' });
    window.location.href = '/events';
  } catch (err) { toast(err.message); }
});

$('cancel-event').addEventListener('click', async () => {
  if (!confirm('Cancel this event? The public page will show it as cancelled.')) return;
  await api(`/api/events/${eventId}/cancel`, { method: 'POST' });
  toast('Event cancelled');
  loadEvent();
});

document.addEventListener('click', event => {
  const menu = $('more-menu');
  if (menu.open && !menu.contains(event.target)) menu.removeAttribute('open');
});

let searchTimer;
$('search').addEventListener('input', e => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => loadGuests(e.target.value.trim()), 250);
});

loadEvent().then(() => { loadGuests(); loadLineStatus(); loadFollowers(); });
