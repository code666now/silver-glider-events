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
  $('familiar-faces-grid').innerHTML = '';
  $('no-guests').textContent = 'We could not load Familiar Faces. Try loading the page again.';
  $('no-guests').hidden = false;
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
  const smsEligibleCount = Number(event.sms_eligible_count) || 0;
  $('sms-audience').hidden = !event.sms_reminder_enabled;
  $('sms-audience-count').textContent = smsEligibleCount.toLocaleString('en-US');
  if (event.sms_reminder_enabled) {
    $('sms-audience-title').textContent = 'Day-before text reminder';
    $('sms-audience-copy').textContent = 'Checking opt-ins and texting balance…';
    $('share-event').querySelector('.promotion-action-description').textContent = 'Share the RSVP link so guests can opt in to the reminder.';
  }
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

const familiarFaceSelection = new Set();
let familiarFaceState = { faces: [], totalCount: 0, rsvpCount: 0, selectableCount: 0, canStartInvitation: false };
let familiarSelectionMode = false;
let familiarInviteState = { step: 'targets', preview: null, targetId: null };

function familiarInitials(name) {
  return String(name || '').trim().split(/\s+/).slice(0, 2).map(part => part[0] || '').join('').toUpperCase() || 'SG';
}

function familiarAvatar(face) {
  const photo = sgSafeHttpUrl(face.avatarUrl);
  return photo
    ? `<img src="${escapeHtml(photo)}" alt="" loading="lazy">`
    : `<span class="familiar-face-emoji" aria-hidden="true">${escapeHtml(face.avatarEmoji || familiarInitials(face.name))}</span>`;
}

function renderFamiliarFaces() {
  const grid = $('familiar-faces-grid');
  grid.innerHTML = familiarFaceState.faces.map(face => {
    const selected = familiarFaceSelection.has(face.id);
    const content = `<span class="familiar-face-avatar">${familiarAvatar(face)}</span>
      <span class="familiar-face-name">${escapeHtml(face.name)}</span>
      <span class="familiar-face-status">${escapeHtml(face.status)}</span>
      ${familiarSelectionMode && face.canInvite ? `<span class="familiar-face-check" aria-hidden="true">✓</span>` : ''}
      ${familiarSelectionMode && !face.canInvite && face.note ? `<span class="familiar-face-note">${escapeHtml(face.note)}</span>` : ''}`;
    if (face.canInvite && familiarFaceState.canStartInvitation) {
      return `<button class="familiar-face-card${selected ? ' is-selected' : ''}" type="button" data-familiar-face="${escapeHtml(face.id)}" aria-pressed="${selected}" aria-label="${selected ? 'Remove' : 'Select'} ${escapeHtml(face.name)} ${selected ? 'from' : 'for'} an invitation">${content}</button>`;
    }
    return `<article class="familiar-face-card${face.declined ? ' is-declined' : ''}">${content}</article>`;
  }).join('');
  $('no-guests').hidden = familiarFaceState.faces.length > 0;
}

function updateFamiliarSelection() {
  const count = familiarFaceSelection.size;
  $('familiar-selected-count').textContent = `${count} selected`;
  $('familiar-choose-event').disabled = count === 0;
  $('familiar-choose-event').textContent = count
    ? `Invite ${count} ${count === 1 ? 'person' : 'people'}`
    : 'Choose event';
  const shown = familiarFaceState.faces.filter(face => face.canInvite);
  const allShownSelected = shown.length > 0 && shown.every(face => familiarFaceSelection.has(face.id));
  $('familiar-select-all').textContent = allShownSelected ? 'Clear shown' : 'Select all';
  renderFamiliarFaces();
}

function startFamiliarSelection(initialFaceId = '') {
  familiarSelectionMode = true;
  if (initialFaceId) familiarFaceSelection.add(initialFaceId);
  $('familiar-faces-start').hidden = true;
  $('familiar-faces-selection').hidden = false;
  updateFamiliarSelection();
}

function stopFamiliarSelection() {
  familiarSelectionMode = false;
  familiarFaceSelection.clear();
  $('familiar-faces-selection').hidden = true;
  $('familiar-faces-start').hidden = !(familiarFaceState.canStartInvitation && familiarFaceState.selectableCount > 0);
  renderFamiliarFaces();
}

async function loadGuests(search = '') {
  const data = await api(`/api/events/${eventId}/familiar-faces${search ? `?search=${encodeURIComponent(search)}` : ''}`);
  familiarFaceState = data;
  $('familiar-faces-summary').textContent = data.totalCount
    ? `${data.totalCount} ${data.totalCount === 1 ? 'person' : 'people'} · RSVP’d and invited`
    : 'RSVPs and invitations, together.';
  $('no-guests').textContent = search ? 'No people match that search.' : 'No faces yet. Share the event link to receive RSVPs.';
  $('export-csv').disabled = Number(data.rsvpCount) === 0;
  $('search').disabled = false;
  $('familiar-faces-start').hidden = familiarSelectionMode || !(data.canStartInvitation && Number(data.selectableCount) > 0);
  renderFamiliarFaces();
  $('manage-guest-section').setAttribute('aria-busy', 'false');
}

$('familiar-faces-grid').addEventListener('click', event => {
  const card = event.target.closest('[data-familiar-face]');
  if (!card) return;
  if (!familiarSelectionMode) return startFamiliarSelection(card.dataset.familiarFace);
  if (familiarFaceSelection.has(card.dataset.familiarFace)) familiarFaceSelection.delete(card.dataset.familiarFace);
  else familiarFaceSelection.add(card.dataset.familiarFace);
  updateFamiliarSelection();
});

$('familiar-invite-start').addEventListener('click', () => startFamiliarSelection());
$('familiar-selection-cancel').addEventListener('click', stopFamiliarSelection);
$('familiar-select-all').addEventListener('click', () => {
  const shown = familiarFaceState.faces.filter(face => face.canInvite);
  const allShownSelected = shown.length > 0 && shown.every(face => familiarFaceSelection.has(face.id));
  for (const face of shown) {
    if (allShownSelected) familiarFaceSelection.delete(face.id);
    else familiarFaceSelection.add(face.id);
  }
  updateFamiliarSelection();
});

function familiarTargetDate(target) {
  const date = new Date(`${String(target.eventDate).slice(0, 10)}T00:00:00Z`);
  const dateLabel = Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC'
  });
  const time = String(target.startTime || '').slice(0, 5).split(':').map(Number);
  const timeLabel = Number.isFinite(time[0])
    ? `${time[0] % 12 || 12}:${String(time[1] || 0).padStart(2, '0')} ${time[0] >= 12 ? 'PM' : 'AM'}`
    : '';
  return [dateLabel, timeLabel].filter(Boolean).join(' · ');
}

function familiarTargetArt(target) {
  const photo = sgSafeHttpUrl(target.thumbnailUrl);
  return photo
    ? `<img src="${escapeHtml(photo)}" alt="" loading="lazy">`
    : `<span aria-hidden="true">${escapeHtml(familiarInitials(target.title))}</span>`;
}

function renderFamiliarTargets() {
  familiarInviteState.step = 'targets';
  const preview = familiarInviteState.preview;
  $('familiar-invite-title').textContent = 'Invite them to…';
  $('familiar-invite-intro').textContent = `Choose an upcoming event for ${preview.selectedCount} ${preview.selectedCount === 1 ? 'person' : 'people'}.`;
  $('familiar-invite-back').textContent = 'Cancel';
  $('familiar-invite-next').textContent = 'Review invitation';
  $('familiar-invite-next').disabled = !familiarInviteState.targetId;
  if (!preview.events.length) {
    $('familiar-invite-content').innerHTML = '<div class="familiar-invite-empty">You do not have an upcoming published event yet.<br><a class="sg-btn sg-btn-ghost" href="/events/new">Create an event</a></div>';
    return;
  }
  $('familiar-invite-content').innerHTML = `<div class="familiar-target-list">${preview.events.map(target => {
    const selected = Number(familiarInviteState.targetId) === Number(target.id);
    const unavailable = Number(target.eligibleCount) === 0;
    const exclusions = [
      target.alreadyRsvpdCount ? `${target.alreadyRsvpdCount} already RSVP’d` : '',
      target.alreadyInvitedCount ? `${target.alreadyInvitedCount} already invited` : ''
    ].filter(Boolean).join(' · ');
    return `<button class="familiar-target-card${selected ? ' is-selected' : ''}" type="button" data-familiar-target="${target.id}" ${unavailable ? 'disabled' : ''} aria-pressed="${selected}">
      <span class="familiar-target-art">${familiarTargetArt(target)}</span>
      <span class="familiar-target-copy"><strong>${escapeHtml(target.title)}</strong><span>${escapeHtml(familiarTargetDate(target))}</span>${exclusions ? `<span>${escapeHtml(exclusions)}</span>` : ''}</span>
      <span class="familiar-target-count">${target.eligibleCount ? `${target.eligibleCount} can invite` : 'Already reached'}</span>
    </button>`;
  }).join('')}</div>`;
}

function renderFamiliarReview() {
  const target = familiarInviteState.preview.events.find(event => Number(event.id) === Number(familiarInviteState.targetId));
  if (!target) return renderFamiliarTargets();
  familiarInviteState.step = 'review';
  $('familiar-invite-title').textContent = 'Ready to invite';
  $('familiar-invite-intro').textContent = 'Silver Glider will send one artwork-led email with one RSVP button.';
  $('familiar-invite-back').textContent = 'Back';
  $('familiar-invite-next').disabled = false;
  $('familiar-invite-next').textContent = `Send ${target.eligibleCount} ${target.eligibleCount === 1 ? 'invitation' : 'invitations'}`;
  const skipped = Number(target.selectedCount) - Number(target.eligibleCount);
  $('familiar-invite-content').innerHTML = `<div class="familiar-invite-review">
    <div class="familiar-invite-review-card"><span class="familiar-target-art">${familiarTargetArt(target)}</span><div><h3>${escapeHtml(target.title)}</h3><p>${escapeHtml(familiarTargetDate(target))}</p><p><strong>${target.eligibleCount}</strong> ${target.eligibleCount === 1 ? 'person will receive' : 'people will receive'} this invitation.</p></div></div>
    ${skipped ? `<p class="familiar-invite-notice">${skipped} ${skipped === 1 ? 'person is' : 'people are'} already RSVP’d or already invited and will be skipped.</p>` : ''}
    <p class="familiar-invite-notice">Consent and eligibility are checked again when you send. Guests can unsubscribe from future invitations.</p>
  </div>`;
}

function closeFamiliarInviteDialog() {
  $('familiar-invite-dialog').close();
  familiarInviteState = { step: 'targets', preview: null, targetId: null };
}

$('familiar-choose-event').addEventListener('click', async () => {
  const faceIds = [...familiarFaceSelection];
  if (!faceIds.length) return;
  familiarInviteState = { step: 'targets', preview: null, targetId: null };
  $('familiar-invite-title').textContent = 'Invite them to…';
  $('familiar-invite-intro').textContent = 'Checking your upcoming events…';
  $('familiar-invite-content').innerHTML = '<div class="familiar-invite-loading">Finding eligible events…</div>';
  $('familiar-invite-next').disabled = true;
  $('familiar-invite-dialog').showModal();
  try {
    familiarInviteState.preview = await api(`/api/events/${eventId}/familiar-faces/preview`, {
      method: 'POST', body: { faceIds }
    });
    renderFamiliarTargets();
  } catch (error) {
    $('familiar-invite-content').innerHTML = `<p class="familiar-invite-empty">${escapeHtml(error.message || 'Could not load upcoming events.')}</p>`;
  }
});

$('familiar-invite-content').addEventListener('click', event => {
  const card = event.target.closest('[data-familiar-target]');
  if (!card) return;
  familiarInviteState.targetId = Number(card.dataset.familiarTarget);
  renderFamiliarTargets();
});

$('familiar-invite-next').addEventListener('click', async () => {
  if (familiarInviteState.step === 'targets') return renderFamiliarReview();
  const button = $('familiar-invite-next');
  if (button.dataset.busy === 'true') return;
  button.dataset.busy = 'true';
  button.disabled = true;
  button.textContent = 'Queuing invitations…';
  try {
    const result = await api(`/api/events/${eventId}/familiar-faces/invite`, {
      method: 'POST',
      body: { targetEventId: familiarInviteState.targetId, faceIds: [...familiarFaceSelection] }
    });
    closeFamiliarInviteDialog();
    stopFamiliarSelection();
    toast(`${result.queued} ${result.queued === 1 ? 'invitation' : 'invitations'} queued`);
  } catch (error) {
    toast(error.message || 'Could not send invitations');
    renderFamiliarReview();
  } finally {
    delete button.dataset.busy;
  }
});

$('familiar-invite-back').addEventListener('click', () => {
  if (familiarInviteState.step === 'review') renderFamiliarTargets();
  else closeFamiliarInviteDialog();
});
$('familiar-invite-close').addEventListener('click', closeFamiliarInviteDialog);
$('familiar-invite-form').addEventListener('submit', event => event.preventDefault());

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

let smsPreviewState = null;

function shortEventDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC'
  });
}

// ---- Invite your people ---------------------------------------------------
// Upcoming events list everyone from the host's past events as faces. The
// shared search box filters both grids; tapping selects; the bar reviews and
// sends. Nothing is pre-selected.
const peopleSelection = new Map();
let peopleState = { canInvite: false, people: [], plusOnes: [], total: 0, hasMore: false, sources: [] };
let peopleSearch = '';
let peopleConfirming = false;
let peopleRequest = 0;

function renderPeople() {
  const cards = peopleState.people.map(face => {
    const selected = peopleSelection.has(face.id);
    return `<button class="familiar-face-card${selected ? ' is-selected' : ''}" type="button" data-person="${escapeHtml(face.id)}" data-name="${escapeHtml(face.name)}" aria-pressed="${selected}" aria-label="${selected ? 'Remove' : 'Select'} ${escapeHtml(face.name)}">
      <span class="familiar-face-avatar">${familiarAvatar(face)}</span>
      <span class="familiar-face-name">${escapeHtml(face.name)}</span>
      <span class="familiar-face-status">${escapeHtml(face.detail)}</span>
      <span class="familiar-face-check" aria-hidden="true">✓</span>
    </button>`;
  });
  const plusOnes = peopleState.plusOnes.map(face => `<article class="familiar-face-card is-plus-one">
      <span class="familiar-face-avatar">${familiarAvatar(face)}</span>
      <span class="familiar-face-name">${escapeHtml(face.name)}</span>
      <span class="familiar-face-status">${escapeHtml(face.detail)}</span>
      <button class="familiar-face-share" type="button" data-share-person="${escapeHtml(face.name)}">Share link</button>
    </article>`);
  $('familiar-people-grid').innerHTML = [...cards, ...plusOnes].join('');
  const empty = !cards.length && !plusOnes.length;
  $('familiar-people-empty').hidden = !empty;
  $('familiar-people-empty').textContent = peopleSearch
    ? 'No one from your past events matches that search.'
    : 'Everyone from your past events is already here.';
  $('familiar-people-more').hidden = !peopleState.hasMore;
  const unsubscribed = Number(peopleState.unsubscribedCount) || 0;
  $('familiar-people-note').hidden = !unsubscribed;
  $('familiar-people-note').textContent = unsubscribed
    ? `${unsubscribed} ${unsubscribed === 1 ? 'person' : 'people'} unsubscribed from your invitations and ${unsubscribed === 1 ? 'isn’t' : 'aren’t'} shown.`
    : '';
  renderPeopleBar();
}

function renderPeopleBar() {
  const count = peopleSelection.size;
  $('familiar-people-bar').hidden = count === 0;
  if (!count) peopleConfirming = false;
  const people = `${count} ${count === 1 ? 'person' : 'people'}`;
  if (peopleConfirming) {
    $('familiar-people-count').textContent = `Invite ${people} to ${eventData.title}?`;
    $('familiar-people-hint').textContent = 'Each gets one email with an RSVP button. They can unsubscribe anytime.';
    $('familiar-people-secondary').textContent = 'Back';
    $('familiar-people-send').textContent = `Send ${count} ${count === 1 ? 'invitation' : 'invitations'}`;
  } else {
    $('familiar-people-count').textContent = `${count} selected`;
    $('familiar-people-hint').textContent = 'Tap faces to add or remove them.';
    $('familiar-people-secondary').textContent = 'Clear';
    $('familiar-people-send').textContent = `Invite ${people}`;
  }
}

function renderPeopleAction() {
  const button = $('invite-previous-guests');
  const available = peopleState.canInvite && (peopleState.total > 0 || peopleState.plusOnes.length > 0 || Boolean(peopleSearch));
  button.style.display = available ? '' : 'none';
  button.disabled = !available;
}

async function loadPeople({ append = false } = {}) {
  const request = ++peopleRequest;
  const params = new URLSearchParams();
  if (peopleSearch) params.set('search', peopleSearch);
  if ($('familiar-people-source').value) params.set('sourceEventId', $('familiar-people-source').value);
  if (append) params.set('offset', String(peopleState.people.length));
  const data = await api(`/api/events/${eventId}/familiar-faces/people?${params}`);
  if (request !== peopleRequest) return;
  if (append) {
    peopleState = { ...data, people: [...peopleState.people, ...data.people], plusOnes: peopleState.plusOnes };
  } else {
    peopleState = data;
  }
  $('familiar-people').hidden = !data.canInvite || (!data.sources.length && !peopleSearch);
  const select = $('familiar-people-source');
  if (select.options.length === 1 && data.sources.length) {
    select.insertAdjacentHTML('beforeend', data.sources.map(source =>
      `<option value="${source.id}">${escapeHtml(source.title)} — ${escapeHtml(shortEventDate(source.eventDate))}</option>`
    ).join(''));
  }
  renderPeople();
  renderPeopleAction();
}

$('familiar-people-grid').addEventListener('click', async event => {
  const share = event.target.closest('[data-share-person]');
  if (share) {
    try {
      await navigator.clipboard.writeText(eventUrl());
      toast(`Event link copied. Send it to ${share.dataset.sharePerson}.`);
    } catch (_) {
      toast(eventUrl());
    }
    return;
  }
  const card = event.target.closest('[data-person]');
  if (!card) return;
  // Update the tapped card in place (no grid re-render), so keyboard focus
  // stays on it and quick taps never land on replaced elements.
  const selected = !peopleSelection.has(card.dataset.person);
  if (selected) peopleSelection.set(card.dataset.person, card.dataset.name);
  else peopleSelection.delete(card.dataset.person);
  card.classList.toggle('is-selected', selected);
  card.setAttribute('aria-pressed', String(selected));
  card.setAttribute('aria-label', `${selected ? 'Remove' : 'Select'} ${card.dataset.name}`);
  peopleConfirming = false;
  renderPeopleBar();
});

$('familiar-people-source').addEventListener('change', () => loadPeople().catch(error => toast(error.message)));
$('familiar-people-more').addEventListener('click', () => loadPeople({ append: true }).catch(error => toast(error.message)));

$('familiar-people-secondary').addEventListener('click', () => {
  if (peopleConfirming) {
    peopleConfirming = false;
    renderPeopleBar();
  } else {
    peopleSelection.clear();
    renderPeople();
  }
});

$('familiar-people-send').addEventListener('click', async () => {
  const button = $('familiar-people-send');
  if (!peopleConfirming) {
    peopleConfirming = true;
    renderPeopleBar();
    button.focus();
    return;
  }
  if (button.dataset.busy === 'true') return;
  button.dataset.busy = 'true';
  button.disabled = true;
  button.textContent = 'Sending…';
  try {
    const data = await api(`/api/events/${eventId}/familiar-faces/people/invite`, {
      method: 'POST',
      body: { faceIds: [...peopleSelection.keys()] }
    });
    peopleSelection.clear();
    peopleConfirming = false;
    toast(`${data.queued} ${data.queued === 1 ? 'invitation is' : 'invitations are'} on the way`);
    await Promise.allSettled([loadGuests(peopleSearch), loadPeople()]);
  } catch (error) {
    toast(error.message || 'Could not send invitations');
    await loadPeople().catch(() => {});
  } finally {
    delete button.dataset.busy;
    button.disabled = false;
    renderPeopleBar();
  }
});

$('invite-previous-guests').addEventListener('click', () => {
  $('familiar-people').scrollIntoView({
    behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
    block: 'start'
  });
  $('search').focus({ preventScroll: true });
});

function renderSmsAction(preview) {
  const button = $('sms-audience');
  const count = Number(preview.recipientCount) || 0;
  $('sms-audience-count').textContent = count.toLocaleString('en-US');
  button.hidden = !preview.reminderEnabled && !preview.batch;
  if (button.hidden) {
    button.disabled = true;
    return;
  }
  delete button.dataset.needsFunds;
  if (preview.batch) {
    const batch = preview.batch;
    button.disabled = true;
    if (batch.status === 'sent') {
      $('sms-audience-title').textContent = `${batch.acceptedCount} ${batch.acceptedCount === 1 ? 'text' : 'texts'} sent`;
      $('sms-audience-copy').textContent = `${batch.creditCost - batch.refundedCredits} paid SMS ${batch.creditCost - batch.refundedCredits === 1 ? 'credit' : 'credits'} used.`;
    } else if (batch.status === 'failed') {
      $('sms-audience-title').textContent = 'Tomorrow text failed';
      $('sms-audience-copy').textContent = `${batch.refundedCredits} ${batch.refundedCredits === 1 ? 'credit was' : 'credits were'} returned.`;
    } else if (batch.status === 'partial_failed') {
      $('sms-audience-title').textContent = `${batch.acceptedCount} of ${batch.recipientCount} texts accepted`;
      $('sms-audience-copy').textContent = 'Delivery details are saved. Failed unaccepted texts are refunded.';
    } else {
      $('sms-audience-title').textContent = `${batch.recipientCount} ${batch.recipientCount === 1 ? 'text' : 'texts'} queued`;
      $('sms-audience-copy').textContent = 'Silver Glider is sending the tomorrow reminder.';
    }
    return;
  }
  $('sms-audience-title').textContent = 'Day-before text reminder';
  if (!preview.reminderEnabled) {
    button.disabled = true;
    $('sms-audience-copy').textContent = 'This reminder is turned off.';
  } else if (preview.eventStatus !== 'published') {
    button.disabled = true;
    $('sms-audience-copy').textContent = 'On · Publish the event before reminders can send.';
  } else if (preview.secretShowEnabled) {
    button.disabled = true;
    $('sms-audience-copy').textContent = 'Text reminders are not available for Secret Shows yet.';
  } else if (!count) {
    button.disabled = true;
    $('sms-audience-copy').textContent = 'On · No guests have opted in to text reminders yet.';
  } else if (preview.needsFunds) {
    button.disabled = false;
    button.dataset.needsFunds = 'true';
    $('sms-audience-count').textContent = 'Add funds';
    $('sms-audience-copy').textContent = `${count} opted in · ${preview.creditCost} ${preview.creditCost === 1 ? 'credit' : 'credits'} needed · ${preview.balance} available. Add funds before it sends.`;
  } else {
    button.disabled = true;
    $('sms-audience-copy').textContent = `${count} opted in · About ${preview.creditCost} ${preview.creditCost === 1 ? 'credit' : 'credits'} · ${preview.balance} available. Sends automatically at 4 PM the day before.`;
  }
}

async function loadSmsPreview() {
  try {
    smsPreviewState = await api(`/api/events/${eventId}/sms/tomorrow-preview`);
    renderSmsAction(smsPreviewState);
    return smsPreviewState;
  } catch (_) {
    $('sms-audience').disabled = true;
    $('sms-audience-copy').textContent = 'Text reminder status is temporarily unavailable.';
    return null;
  }
}

$('sms-audience').addEventListener('click', () => {
  if (smsPreviewState?.needsFunds) {
    window.location.assign(`/settings/messaging?return=${encodeURIComponent(location.pathname)}`);
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
  searchTimer = setTimeout(() => {
    const query = e.target.value.trim();
    loadGuests(query);
    // One search box filters both grids: people connected here and your people.
    if (peopleState.canInvite) {
      peopleSearch = query;
      loadPeople().catch(() => {});
    }
  }, 250);
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
      : [loadLineStatus(), loadPeople(), loadFollowers(), loadSmsPreview()];
    const [guests] = await Promise.allSettled([loadGuests(), ...secondaryTasks]);
    if (guests.status === 'rejected') {
      $('manage-guest-section').setAttribute('aria-busy', 'false');
      $('familiar-faces-grid').innerHTML = '';
      $('no-guests').textContent = 'We could not load the guest list. Try loading the page again.';
      $('no-guests').hidden = false;
    }
  } catch (_) {
    showManageLoadError();
  }
}

initializeManagePage();

window.setInterval(() => {
  if (document.visibilityState === 'visible' && eventData?.sms_reminder_enabled && !eventData.is_past) {
    loadSmsPreview();
  }
}, 60000);
