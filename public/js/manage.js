renderNav('events');

const eventId = location.pathname.split('/')[2];
const $ = id => document.getElementById(id);
let eventData = null;
const LINE_NUMBER = '(844) 261-6758';
const desktopManageLayout = window.matchMedia('(min-width: 1024px)');

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

function renderNotificationStatus(notification) {
  const node = $('notification-status');
  if (!notification) {
    node.hidden = true;
    return;
  }
  const count = Number(notification.recipientCount) || 0;
  const sent = Number(notification.sentCount) || 0;
  const failed = Number(notification.failedCount) || 0;
  const label = notification.kind === 'event_cancelled' ? 'Cancellation notice' : 'Event update';
  node.classList.toggle('is-warning', failed > 0);
  if (notification.status === 'sent') {
    node.innerHTML = `<strong>${label} sent.</strong> ${sent} ${sent === 1 ? 'guest was' : 'guests were'} notified.`;
  } else if (notification.status === 'failed') {
    node.innerHTML = `<strong>${label} could not be delivered.</strong> We’ll keep the delivery record for review.`;
  } else if (notification.status === 'partial_failed' && failed > 0) {
    node.innerHTML = `<strong>${label} partly delivered.</strong> ${sent} sent · ${failed} retrying or failed.`;
  } else {
    node.innerHTML = `<strong>${label} queued.</strong> We’re notifying ${count} ${count === 1 ? 'guest' : 'guests'}.`;
  }
  node.hidden = false;
}

function positionGuestSection() {
  const section = $('manage-guest-section');
  if (eventData?.is_past && desktopManageLayout.matches) {
    $('manage-guest-desktop-slot').append(section);
  } else {
    $('manage-guest-home').after(section);
  }
}

desktopManageLayout.addEventListener('change', positionGuestSection);

function setManageReady() {
  $('manage-shell').removeAttribute('data-loading');
  $('manage-overview').setAttribute('aria-busy', 'false');
  $('manage-hero-skeleton').hidden = true;
  ['copy-link', 'share-event', 'download-qr', 'duplicate', 'cancel-event', 'delete-event'].forEach(id => {
    $(id).disabled = false;
  });
  ['view-link', 'edit-link'].forEach(id => {
    $(id).removeAttribute('aria-disabled');
    $(id).removeAttribute('tabindex');
  });
  $('more-menu').querySelector('summary').removeAttribute('aria-disabled');
}

function showManageLoadError() {
  $('manage-load-error').hidden = false;
  $('manage-overview').setAttribute('aria-busy', 'false');
  $('manage-guest-section').setAttribute('aria-busy', 'false');
  $('manage-hero-skeleton').hidden = true;
  $('manage-hero-placeholder').hidden = false;
  $('title').textContent = 'Event unavailable';
  $('meta').textContent = 'Try loading this page again.';
  ['stat-rsvps', 'stat-attendance', 'stat-guests', 'stat-comments'].forEach(id => { $(id).textContent = '—'; });
  $('guest-rows').innerHTML = '';
  $('guests').style.display = 'none';
}

async function loadEvent() {
  const { event } = await api(`/api/events/${eventId}`);
  eventData = event;
  $('manage-shell').classList.toggle('is-past-event', event.is_past);
  positionGuestSection();
  document.title = `${event.title} — Silver Glider Events`;

  $('title').textContent = event.title;
  const dateStr = new Date(event.event_date).toLocaleDateString('en-US',
    { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  $('meta').textContent = `${dateStr} · ${event.venue_name}`;

  const manageImage = event.presentation_mode === 'flyer' ? event.flyer_image_url : event.cover_image_url;
  $('manage-hero-skeleton').hidden = true;
  if (manageImage) {
    $('manage-hero-placeholder').hidden = true;
    $('hero').style.display = 'block';
    $('hero').classList.toggle('flyer', event.presentation_mode === 'flyer');
    $('hero-img').src = manageImage;
    $('hero-img').alt = `${event.title} artwork`;
    $('hero-link').href = manageImage;
    $('hero-link').setAttribute('aria-label', `View full artwork for ${event.title}`);
  } else {
    $('manage-hero-placeholder').hidden = false;
  }

  const badge = $('status-badge');
  if (event.status === 'cancelled') { badge.className = 'sg-badge sg-badge-danger'; badge.textContent = 'Cancelled'; }
  else if (event.status === 'draft') { badge.className = 'sg-badge'; badge.textContent = 'Draft'; }
  else if (event.secret_show_enabled) { badge.className = 'sg-badge'; badge.textContent = 'Secret Show'; }
  else if (event.visibility === 'private') { badge.className = 'sg-badge'; badge.textContent = 'Private — Link Only'; }
  else { badge.className = 'sg-badge sg-badge-accent'; badge.textContent = 'Live'; }

  document.querySelectorAll('[data-private-metric]').forEach(card => {
    card.hidden = event.visibility !== 'private';
  });
  document.querySelector('.stat-row').classList.toggle('private-metrics', event.visibility === 'private');
  $('stat-rsvps').textContent = event.rsvp_count;
  $('stat-attendance').textContent = event.total_attendance;
  $('stat-guests').textContent = event.guest_count;
  $('stat-comments').textContent = event.comment_count;
  renderNotificationStatus(event.latest_notification);
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
    $('collect-photos-card').hidden = true;
  } else if (event.is_past) {
    $('line-card').style.display = 'none';
    $('collect-photos-card').hidden = !event.collect_photos_enabled;
  } else if (event.visibility === 'private') {
    $('promotion-copy').textContent = 'Share your private event link or download its QR code.';
    $('line-feature').style.display = 'none';
  }
}

function renderPhotos(photos) {
  $('photo-count').textContent = photos.length;
  $('view-photos-title').textContent = photos.length
    ? `View ${photos.length} photo${photos.length === 1 ? '' : 's'}`
    : 'View photos';
  $('view-photos').disabled = photos.length === 0;
  $('photo-empty').style.display = photos.length ? 'none' : 'block';
  $('photo-grid').innerHTML = photos.map(photo => {
    const featureAction = photo.public_feature_consent
      ? `<button type="button" data-feature-photo="${photo.id}" data-featured="${photo.is_featured ? 'true' : 'false'}">${photo.is_featured ? 'Remove from page' : 'Feature on page'}</button>`
      : '<span class="photo-card-private">Private only</span>';
    return `
    <article class="photo-card${photo.is_featured ? ' is-featured' : ''}">
      <img src="${escapeHtml(photo.image_url)}" alt="Photo shared after ${escapeHtml(eventData.title)}" loading="lazy">
      <div class="photo-card-body">
        <div class="photo-card-meta"><span class="photo-card-name">${escapeHtml(photo.contributor_name || 'Anonymous guest')}</span>${photo.is_featured ? '<span class="photo-card-featured">On event page</span>' : ''}</div>
        <div class="photo-card-actions">
          <a href="/api/events/${eventId}/photos/${photo.id}/download">Download</a>
          ${featureAction}
          <button type="button" data-delete-photo="${photo.id}">Delete</button>
        </div>
      </div>
    </article>`;
  }).join('');
}

async function loadPhotoCollection() {
  const data = await api(`/api/events/${eventId}/photos`);
  $('collect-photos-card').dataset.collectionUrl = data.collectionUrl;
  $('copy-photo-link').disabled = false;
  if (data.requestSentAt) {
    $('ask-rsvps').disabled = true;
    $('ask-rsvps-title').textContent = `${data.requestSentCount} ${data.requestSentCount === 1 ? 'guest' : 'guests'} asked`;
    $('ask-rsvps-copy').textContent = 'The one-time photo request has been sent.';
  } else if (data.eligibleCount > 0) {
    $('ask-rsvps').disabled = false;
    $('ask-rsvps').dataset.count = data.eligibleCount;
    $('ask-rsvps-title').textContent = `Ask ${data.eligibleCount} RSVP${data.eligibleCount === 1 ? '' : 's'}`;
    $('ask-rsvps-copy').textContent = 'Send one photo request to attendees who accepted updates.';
  } else {
    $('ask-rsvps').disabled = true;
    $('ask-rsvps-title').textContent = 'No eligible RSVPs';
    $('ask-rsvps-copy').textContent = 'Copy the photo link to request photos directly.';
  }
  renderPhotos(data.photos);
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
    if (!submission) {
      $('submit-line').disabled = false;
      return;
    }
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
  } catch (_) {
    $('submit-line').disabled = false;
  }
}

async function loadGuests(search = '') {
  const { rsvps } = await api(`/api/events/${eventId}/rsvps${search ? `?search=${encodeURIComponent(search)}` : ''}`);
  const active = rsvps.filter(r => r.status === 'confirmed');
  const tbody = $('guest-rows');
  tbody.innerHTML = active.map(r => `
    <tr>
      <td>${escapeHtml(`${r.first_name} ${r.last_name}`.trim())}<span class="guest-inline-email">${escapeHtml(r.email)}</span></td>
      <td class="dim guest-email-column">${escapeHtml(r.email)}</td>
      <td>${r.guest_first_name ? `${escapeHtml(`${r.guest_first_name} ${r.guest_last_name || ''}`.trim())}<span class="guest-inline-email">${escapeHtml(r.guest_email || 'No email')}</span>` : '—'}</td>
      <td class="dim guest-email-column">${escapeHtml(r.guest_email || '—')}</td>
      <td class="dim">${new Date(r.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</td>
    </tr>`).join('');
  $('no-guests').style.display = active.length ? 'none' : 'block';
  $('guests').style.display = active.length ? 'table' : 'none';
  $('export-csv').disabled = active.length === 0;
  $('search').disabled = false;
  $('manage-guest-section').setAttribute('aria-busy', 'false');
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

$('copy-photo-link').addEventListener('click', async () => {
  const url = $('collect-photos-card').dataset.collectionUrl;
  if (!url) return;
  await navigator.clipboard.writeText(url);
  toast('Photo link copied');
});

$('ask-rsvps').addEventListener('click', async () => {
  const count = Number($('ask-rsvps').dataset.count || 0);
  if (!count || !confirm(`Send one photo request to ${count} eligible RSVP${count === 1 ? '' : 's'}? This can only be sent once.`)) return;
  $('ask-rsvps').disabled = true;
  $('ask-rsvps-title').textContent = 'Sending…';
  $('ask-rsvps-copy').textContent = 'Emailing eligible attendees.';
  try {
    const { sent } = await api(`/api/events/${eventId}/photo-request`, { method: 'POST' });
    toast(`Photo request sent to ${sent} ${sent === 1 ? 'guest' : 'guests'}`);
    await loadPhotoCollection();
  } catch (err) {
    toast(err.message);
    await loadPhotoCollection().catch(() => {});
  }
});

$('view-photos').addEventListener('click', () => {
  $('photo-collection-summary').scrollIntoView({ behavior: 'smooth', block: 'start' });
  $('photo-collection-summary').focus({ preventScroll: true });
});

$('photo-grid').addEventListener('click', async event => {
  const featureButton = event.target.closest('[data-feature-photo]');
  if (featureButton) {
    const featured = featureButton.dataset.featured !== 'true';
    featureButton.disabled = true;
    try {
      await api(`/api/events/${eventId}/photos/${featureButton.dataset.featurePhoto}/feature`, {
        method: 'PATCH', body: { featured }
      });
      toast(featured ? 'Photo featured on the event page' : 'Photo removed from the event page');
      await loadPhotoCollection();
    } catch (err) {
      toast(err.message);
      featureButton.disabled = false;
    }
    return;
  }
  const button = event.target.closest('[data-delete-photo]');
  if (!button || !confirm('Delete this photo from the event collection?')) return;
  button.disabled = true;
  try {
    await api(`/api/events/${eventId}/photos/${button.dataset.deletePhoto}`, { method: 'DELETE' });
    toast('Photo deleted');
    await loadPhotoCollection();
  } catch (err) {
    toast(err.message);
    button.disabled = false;
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
  const button = $('duplicate');
  if (button.dataset.busy === 'true') return;

  button.dataset.busy = 'true';
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  button.textContent = 'Duplicating…';
  $('more-menu').removeAttribute('open');

  try {
    const { event } = await api(`/api/events/${eventId}/duplicate`, { method: 'POST' });
    if (!event?.id) throw new Error('The duplicate was created without an editable event');
    window.location.assign(`/events/new?id=${encodeURIComponent(event.id)}`);
  } catch (err) {
    delete button.dataset.busy;
    button.disabled = false;
    button.removeAttribute('aria-busy');
    button.textContent = 'Duplicate event';
    toast(err.message || 'Could not duplicate this event');
  }
});

async function loadFollowers() {
  try {
    const { count, announcedAt, announcedCount, canAnnounce } = await api(`/api/events/${eventId}/followers`);
    const btn = $('announce');
    if (announcedAt && announcedCount > 0) {
      btn.style.display = '';
      btn.disabled = true;
      $('announce-title').textContent = `${announcedCount} ${announcedCount === 1 ? 'follower' : 'followers'} invited`;
      $('announce-copy').textContent = 'Invitation sent. This action can only be used once.';
      return;
    }
    if (!canAnnounce || count === 0) return; // hidden: private/draft/cancelled or no followers yet
    btn.style.display = '';
    btn.disabled = false;
    btn.dataset.count = count;
    $('announce-title').textContent = `Invite ${count} ${count === 1 ? 'follower' : 'followers'}`;
    $('announce-copy').textContent = 'Send this event once to people following your host page.';
  } catch (_) {}
}

$('announce').addEventListener('click', async () => {
  const count = $('announce').dataset.count || 'your';
  if (!confirm(`Send this event to ${count} ${count === '1' ? 'follower' : 'followers'} who asked to hear about future events? This can only be done once.`)) return;
  $('announce').disabled = true;
  $('announce-title').textContent = 'Sending…';
  $('announce-copy').textContent = 'Emailing your followers.';
  try {
    const { sent } = await api(`/api/events/${eventId}/announce`, { method: 'POST' });
    toast(`${sent} ${sent === 1 ? 'follower' : 'followers'} invited`);
    $('announce-title').textContent = `${sent} ${sent === 1 ? 'follower' : 'followers'} invited`;
    $('announce-copy').textContent = 'Invitation sent. This action can only be used once.';
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
  const choice = await window.SGEEventChanges.confirmCancellation({ count: Number(eventData.rsvp_count) || 0 });
  if (choice === 'cancel') return;
  const button = $('cancel-event');
  button.disabled = true;
  button.textContent = 'Cancelling…';
  try {
    const data = await api(`/api/events/${eventId}/cancel`, {
      method: 'POST', body: { notify_attendees: choice === 'notify' }
    });
    toast(data.notification?.queued
      ? `Event cancelled. We’re notifying ${data.notification.queued} ${data.notification.queued === 1 ? 'guest' : 'guests'}.`
      : 'Event cancelled');
    await loadEvent();
  } catch (error) {
    button.disabled = false;
    button.textContent = 'Cancel event';
    toast(error.message || 'Could not cancel this event');
  }
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

async function initializeManagePage() {
  try {
    const savedMessage = sessionStorage.getItem('sge-manage-message');
    sessionStorage.removeItem('sge-manage-message');
    await loadEvent();
    setManageReady();
    if (savedMessage) toast(savedMessage);
    const secondaryTasks = eventData.is_past
      ? (eventData.collect_photos_enabled ? [loadPhotoCollection()] : [])
      : [loadLineStatus(), loadFollowers()];
    const [guests] = await Promise.allSettled([loadGuests(), ...secondaryTasks]);
    if (guests.status === 'rejected') {
      $('manage-guest-section').setAttribute('aria-busy', 'false');
      $('guest-rows').innerHTML = '';
      $('guests').style.display = 'none';
      $('no-guests').textContent = 'We could not load the guest list. Try loading the page again.';
      $('no-guests').style.display = 'block';
    }
  } catch (_) {
    showManageLoadError();
  }
}

initializeManagePage();
