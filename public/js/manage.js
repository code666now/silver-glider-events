renderNav('events');

const eventId = location.pathname.split('/')[2];
const $ = id => document.getElementById(id);
let eventData = null;
let postEventExperience = null;
const LINE_NUMBER = '(844) 261-6758';
const desktopManageLayout = window.matchMedia('(min-width: 1024px)');
const mobileManageLayout = window.matchMedia('(max-width: 879px)');
const mobileManageViews = {
  overview: {
    title: 'Overview',
    subtitle: 'Artwork, status, and attendance at a glance.'
  },
  guests: {
    title: 'Guests',
    subtitle: 'See RSVPs, search people, and send invitations.'
  },
  promote: {
    title: 'Promote',
    subtitle: 'Share the event, download its QR code, or reach your audience.'
  },
  photos: {
    title: 'Photos',
    subtitle: 'Request, review, and manage photos shared by guests.'
  },
  actions: {
    title: 'Event actions',
    subtitle: 'Duplicate, cancel, or permanently delete this event.'
  }
};
const mobileManageHistoryKey = 'sgeMobileManageView';
const mobileManageHistoryContext = `${location.pathname}${location.search}`;
let activeMobileManageView = 'home';
let mobilePreviewMarker = null;
let mobileEditMarker = null;
let postEventDeepLinkHandled = false;
let publishBusy = false;
let publishReturnFocus = null;

function mobileManageHistoryEntry() {
  const entry = history.state?.[mobileManageHistoryKey];
  if (!entry || entry.context !== mobileManageHistoryContext) return null;
  if (entry.view !== 'home' && !mobileManageViews[entry.view]) return null;
  return entry;
}

function writeMobileManageHistory(view, mode, fromView) {
  if (mode === 'none') return;
  const current = mobileManageHistoryEntry();
  if (mode === 'push' && current?.view === view) return;
  const baseState = history.state && typeof history.state === 'object' ? history.state : {};
  const entry = {
    context: mobileManageHistoryContext,
    view,
    fromView: mode === 'push'
      ? (fromView || null)
      : (current?.view === view ? current.fromView : null)
  };
  history[mode === 'replace' ? 'replaceState' : 'pushState']({
    ...baseState,
    [mobileManageHistoryKey]: entry
  }, '', location.href);
}

function clearMobileManageHistory() {
  if (!mobileManageHistoryEntry()) return;
  const nextState = { ...(history.state || {}) };
  delete nextState[mobileManageHistoryKey];
  history.replaceState(nextState, '', location.href);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const createdFromEventFlow = Boolean(new URLSearchParams(location.search).get('created'));
let hostPageSuccessMarkedSeen = false;

function safeHostPageUrl(value) {
  try {
    const url = new URL(String(value || ''), location.origin);
    if (url.origin !== location.origin || !/^\/h\/[a-z0-9-]+\/?$/.test(url.pathname)) return '';
    return `${url.pathname}${url.search}${url.hash}`;
  } catch (_) {
    return '';
  }
}

function markHostPageSuccessSeen() {
  if (hostPageSuccessMarkedSeen) return;
  hostPageSuccessMarkedSeen = true;
  fetch('/api/host-onboarding/seen', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    keepalive: true,
    body: '{}'
  }).catch(() => {});
}

function closeHostPageSuccess() {
  const dialog = $('host-page-success-dialog');
  if (dialog.open) dialog.close();
}

async function showHostPageSuccessIfNeeded() {
  try {
    const state = await api('/api/host-onboarding');
    const hostPageUrl = safeHostPageUrl(state.hostPageUrl);
    if (!state.showHostPageSuccess || !hostPageUrl) return;

    $('host-page-success-view').href = hostPageUrl;
    if (state.profileComplete) {
      $('host-page-success-copy').textContent = 'Your events now have one place people can visit and follow. Your page is ready to share whenever you want people to see what’s next.';
      $('host-page-success-personalize').textContent = 'Edit my page';
    }
    $('host-page-success-dialog').showModal();
    $('host-page-success-title').focus();
  } catch (_) {
    // Event management remains fully usable if onboarding state cannot load.
  }
}

async function showPublishedWelcome() {
  if (!createdFromEventFlow || eventData?.status !== 'published') return;
  $('created-note').style.display = 'block';
  api('/api/auth/me').then(({ organizer }) => {
    if (!organizer.public_slug) return;
    $('created-host-note').innerHTML = ` Your public page is also live. <a href="/h/${encodeURIComponent(organizer.public_slug)}" target="_blank" rel="noopener">View it</a> or <a href="/settings/host-page">personalize it</a>.`;
  }).catch(() => {});
  const welcome = window.SgeWelcomeTexts?.create($('published-welcome-texts'), {
    context: 'publication', eventId,
    onClaim: result => {
      api('/api/auth/me').then(({ organizer }) => updateNavAccount({ ...organizer, sms_credits: result.balance })).catch(() => {});
      loadSmsPreview().catch(() => {});
    }
  });
  const welcomeVisible = await welcome?.load();
  // One success experience: the inline gift includes sharing, so don't stack an onboarding dialog.
  if (welcomeVisible) {
    $('created-note').style.display = 'none';
    markHostPageSuccessSeen();
  } else showHostPageSuccessIfNeeded();
}

$('host-page-success-close').addEventListener('click', closeHostPageSuccess);
$('host-page-success-later').addEventListener('click', closeHostPageSuccess);
$('host-page-success-dialog').addEventListener('close', markHostPageSuccessSeen);
$('host-page-success-personalize').addEventListener('click', markHostPageSuccessSeen);
$('host-page-success-view').addEventListener('click', markHostPageSuccessSeen);

function eventUrl() {
  return `${location.origin}/e/${eventData.slug}`;
}

function mobileManageReady() {
  return Boolean(eventData) && !$('manage-shell').hasAttribute('data-loading');
}

function mobileManageViewAvailable(view) {
  if (view === 'promote') {
    return !$('line-card').hidden && $('line-card').style.display !== 'none';
  }
  if (view === 'photos') return !$('collect-photos-card').hidden;
  return Boolean(mobileManageViews[view]);
}

function updateMobileManageSummaries() {
  if (!eventData) return;
  const status = $('status-badge').textContent || 'Event';
  const rsvps = Number(eventData.rsvp_count) || 0;
  $('manage-mobile-summary-overview').textContent = `${status} · ${rsvps} RSVP${rsvps === 1 ? '' : 's'}`;

  // The number a host checks most, at the top of the phone hub.
  const going = Number(eventData.total_attendance) || 0;
  const capacity = Number(eventData.capacity) || 0;
  const headcount = $('manage-mobile-headcount');
  headcount.replaceChildren();
  if (going) {
    const count = document.createElement('strong');
    count.textContent = capacity ? `${going} of ${capacity}` : String(going);
    headcount.append(count, isPostEventEligible() ? ' RSVP’d going' : ' going');
  } else {
    headcount.textContent = eventData.status === 'draft'
      ? 'Your draft is private. Publish when you’re ready to share it.'
      : isPostEventEligible()
      ? 'No one RSVP’d going to this event.'
      : 'No RSVPs yet. Share your link to get the first one.';
  }

  // The proof line: how much of tonight's room already knows this host.
  const returning = Number(eventData.returning_count) || 0;
  const fromInvites = Number(eventData.invited_returning_count) || 0;
  const returningLine = $('manage-mobile-returning');
  if (returning) {
    const verb = isPostEventEligible() ? 'had been' : returning === 1 ? 'has been' : 'have been';
    returningLine.textContent = fromInvites
      ? `${returning} of them ${verb} to one of your events before. ${fromInvites} came from your invites.`
      : `${returning} of them ${verb} to one of your events before.`;
    returningLine.hidden = false;
  } else {
    returningLine.hidden = true;
  }

  const connected = Number(familiarFaceState?.totalCount);
  const guestCount = Number.isFinite(connected) && connected > 0 ? connected : rsvps;
  $('manage-mobile-summary-guests').textContent = guestCount
    ? `${guestCount} ${guestCount === 1 ? 'person' : 'people'} connected`
    : peopleState.canBrowsePastGuests && (peopleState.total > 0 || peopleState.plusOnes.length > 0)
      ? 'Browse people from your past events'
      : 'No RSVPs or invitations yet';
  const lifecycleVariant = currentLifecycleVariant();
  const lifecycleCopy = {
    'new-event': ['Promote', eventData.visibility === 'private' ? 'Share the private link or QR code' : 'Share the link and start building your audience'],
    'reminder-funded': ['Promote', 'Reminder funded · Keep sharing the event'],
    'reminder-needs-credits': ['Promote', 'Text reminders need credits · Email stays free'],
    'follower-outreach': ['Promote', 'Reach guests, followers, and Familiar Faces'],
    tonight: ['Tonight', 'Last call and recorded reminder delivery'],
    ended: ['Recap', 'Remember the night, see your guests, and thank them']
  }[lifecycleVariant] || ['Promote', 'Share, QR code, followers, and The Line'];
  $('manage-mobile-promote-label').textContent = lifecycleCopy[0];
  $('manage-mobile-summary-promote').textContent = lifecycleCopy[1];
  mobileManageViews.promote.title = lifecycleCopy[0];
  mobileManageViews.promote.subtitle = lifecycleCopy[1];
  if (activeMobileManageView === 'promote') {
    $('manage-mobile-nav-label').textContent = lifecycleCopy[0];
    $('manage-mobile-screen-title').textContent = lifecycleCopy[0];
    $('manage-mobile-screen-subtitle').textContent = lifecycleCopy[1];
  }

  const photoCount = Number($('photo-count').textContent) || 0;
  $('manage-mobile-summary-photos').textContent = photoCount
    ? `${photoCount} photo${photoCount === 1 ? '' : 's'} received`
    : 'Collect and review event photos';
}

function syncMobileManageAvailability() {
  const ready = mobileManageReady();
  document.querySelectorAll('[data-manage-mobile-open]').forEach(button => {
    button.disabled = !ready || !mobileManageViewAvailable(button.dataset.manageMobileOpen);
  });
  $('manage-mobile-task-promote').hidden = Boolean(eventData) && !mobileManageViewAvailable('promote');
  $('manage-mobile-task-photos').hidden = !eventData || !mobileManageViewAvailable('photos');
  $('manage-mobile-share').hidden = eventData?.status !== 'published' || currentLifecycleVariant() === 'ended';
  $('manage-mobile-share').disabled = !ready || $('share-event').disabled;
  $('manage-mobile-publish').hidden = eventData?.status !== 'draft';
  $('manage-mobile-publish').disabled = !ready || publishBusy;
  updateMobileManageSummaries();

  if (mobileManageLayout.matches && activeMobileManageView !== 'home' && !mobileManageViewAvailable(activeMobileManageView)) {
    setMobileManageView('home', { focus: false, historyMode: 'replace' });
  }
}

function setMobileManageView(requestedView, { focus = true, historyMode = 'none' } = {}) {
  if (!mobileManageLayout.matches) return;
  const view = requestedView === 'home' || mobileManageViewAvailable(requestedView) ? requestedView : 'home';
  const previousView = activeMobileManageView;
  writeMobileManageHistory(view, historyMode, previousView);
  activeMobileManageView = view;
  $('manage-shell').dataset.mobileView = view;
  $('manage-mobile-hub').hidden = view !== 'home';
  $('manage-mobile-screen-intro').hidden = view === 'home';
  $('manage-mobile-nav-label').textContent = view === 'home' ? 'Manage event' : mobileManageViews[view].title;
  $('manage-mobile-back').setAttribute('aria-label', view === 'home' ? 'Back to My Events' : 'Back to event management sections');

  if (view !== 'home') {
    $('manage-mobile-screen-title').textContent = mobileManageViews[view].title;
    $('manage-mobile-screen-subtitle').textContent = mobileManageViews[view].subtitle;
  }
  if (view === 'actions') $('more-menu').setAttribute('open', '');
  else $('more-menu').removeAttribute('open');
  syncFamiliarMobileChrome();

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  window.scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' });
  if (focus) {
    window.requestAnimationFrame(() => {
      const focusTarget = view === 'home'
        ? $('title')
        : view === 'actions'
          ? $('more-menu-panel')
          : $('manage-mobile-screen-intro');
      focusTarget.focus({ preventScroll: true });
    });
  }
}

function syncMobileManageLayout() {
  const viewLink = $('view-link');
  document.body.classList.toggle('manage-mobile-custom-nav', mobileManageLayout.matches);
  if (mobileManageLayout.matches) {
    $('manage-mobile-nav').hidden = false;
    viewLink.textContent = 'Preview';
    $('manage-mobile-preview-slot').append(viewLink);
    $('manage-mobile-edit-slot').append($('edit-link'));
    $('title').setAttribute('tabindex', '-1');
    const historyView = mobileManageHistoryEntry()?.view;
    setMobileManageView(historyView || activeMobileManageView, { focus: false, historyMode: 'replace' });
  } else {
    clearMobileManageHistory();
    $('manage-mobile-nav').hidden = true;
    $('manage-mobile-hub').hidden = true;
    $('manage-mobile-screen-intro').hidden = true;
    $('manage-shell').dataset.mobileView = 'home';
    activeMobileManageView = 'home';
    viewLink.textContent = eventData?.status === 'draft' ? 'Preview' : 'View page';
    if (mobilePreviewMarker?.parentNode) mobilePreviewMarker.parentNode.insertBefore(viewLink, mobilePreviewMarker.nextSibling);
    if (mobileEditMarker?.parentNode) mobileEditMarker.parentNode.insertBefore($('edit-link'), mobileEditMarker.nextSibling);
    $('more-menu').removeAttribute('open');
    $('title').removeAttribute('tabindex');
  }
}

function initializeMobileManage() {
  const viewLink = $('view-link');
  mobilePreviewMarker = document.createComment('mobile preview link location');
  viewLink.before(mobilePreviewMarker);
  const editLink = $('edit-link');
  mobileEditMarker = document.createComment('mobile edit link location');
  editLink.before(mobileEditMarker);
  document.querySelectorAll('[data-manage-mobile-open]').forEach(button => {
    button.addEventListener('click', () => setMobileManageView(button.dataset.manageMobileOpen, { historyMode: 'push' }));
  });
  $('manage-mobile-back').addEventListener('click', () => {
    if (activeMobileManageView !== 'home') {
      const current = mobileManageHistoryEntry();
      if (current?.view === activeMobileManageView && current.fromView) history.back();
      else setMobileManageView('home', { historyMode: 'replace' });
    }
    else window.location.assign('/events?view=hosting');
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && ($('post-event-thank-dialog')?.open || $('publish-event-dialog').open || $('guest-import-dialog')?.open)) return;
    if (event.key === 'Escape' && mobileManageLayout.matches && activeMobileManageView !== 'home') {
      event.preventDefault();
      const current = mobileManageHistoryEntry();
      if (current?.view === activeMobileManageView && current.fromView) history.back();
      else setMobileManageView('home', { historyMode: 'replace' });
    }
  });
  window.addEventListener('popstate', () => {
    if (!mobileManageLayout.matches) {
      clearMobileManageHistory();
      return;
    }
    const entry = mobileManageHistoryEntry();
    if (!entry) return;
    setMobileManageView(entry.view, { historyMode: 'none' });
  });
  mobileManageLayout.addEventListener('change', syncMobileManageLayout);
  syncMobileManageLayout();
  syncMobileManageAvailability();
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
  if (isPostEventEligible() && desktopManageLayout.matches) {
    $('manage-guest-desktop-slot').append(section);
  } else {
    $('manage-guest-home').after(section);
  }
}

function openPostEventGuests() {
  const title = $('familiar-faces-title');
  title.setAttribute('tabindex', '-1');
  const reveal = () => {
    $('manage-guest-section').scrollIntoView({
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
      block: 'start'
    });
    title.focus({ preventScroll: true });
  };
  if (mobileManageLayout.matches) {
    setMobileManageView('guests', { focus: false, historyMode: 'push' });
    window.requestAnimationFrame(() => window.requestAnimationFrame(reveal));
  } else {
    reveal();
  }
}

function openPostEventDeepLink() {
  if (postEventDeepLinkHandled || !postEventExperience) return;
  const destination = new URLSearchParams(location.search).get('postEvent');
  if (destination !== 'recap' && destination !== 'thank-you') return;
  postEventDeepLinkHandled = true;

  if (mobileManageLayout.matches) {
    setMobileManageView('promote', { focus: false, historyMode: 'replace' });
  } else if (destination === 'recap') {
    const recap = $('lifecycle-recap');
    recap.setAttribute('tabindex', '-1');
    recap.scrollIntoView({
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
      block: 'start'
    });
    recap.focus({ preventScroll: true });
  }
  if (destination === 'thank-you') postEventExperience.openDialog();
}

async function loadPostEventExperience() {
  try {
    await postEventExperience.load(eventData);
    openPostEventDeepLink();
  } catch (_) {
    postEventExperience.renderUnavailable(eventData);
  }
}

desktopManageLayout.addEventListener('change', positionGuestSection);

function setManageReady() {
  $('manage-shell').removeAttribute('data-loading');
  $('manage-overview').setAttribute('aria-busy', 'false');
  $('manage-hero-skeleton').hidden = true;
  ['copy-link', 'share-event', 'download-qr', 'duplicate', 'lifecycle-next-event', 'cancel-event', 'delete-event'].forEach(id => {
    $(id).disabled = false;
  });
  ['view-link', 'edit-link'].forEach(id => {
    $(id).removeAttribute('aria-disabled');
    $(id).removeAttribute('tabindex');
  });
  $('more-menu').querySelector('summary').removeAttribute('aria-disabled');
  syncPublicationActions();
  syncMobileManageAvailability();
}

function syncPublicationActions() {
  const draft = eventData?.status === 'draft';
  const published = eventData?.status === 'published';
  $('publish-event').hidden = !draft;
  $('publish-event').disabled = !mobileManageReady() || publishBusy;
  $('copy-link').hidden = !published || isPostEventEligible();
  $('copy-link').disabled = !published;
  $('share-event').disabled = !published;
  $('download-qr').disabled = !published;
  $('view-link').textContent = draft || mobileManageLayout.matches ? 'Preview' : 'View page';
}

function closePublishDialog() {
  if (!publishBusy) $('publish-event-dialog').close();
}

function openPublishDialog(trigger) {
  if (!mobileManageReady() || eventData.status !== 'draft' || publishBusy) return;
  publishReturnFocus = trigger;
  $('publish-event-name').textContent = eventData.title;
  const timeParts = /^(\d{2}):(\d{2})/.exec(eventData.start_time || '');
  const hour = timeParts ? Number(timeParts[1]) : 0;
  const startTime = timeParts ? `${hour % 12 || 12}:${timeParts[2]} ${hour >= 12 ? 'PM' : 'AM'}` : '';
  const timing = [startTime, eventData.timezone?.replace(/_/g, ' ')].filter(Boolean).join(' · ');
  $('publish-event-details').textContent = [$('meta').textContent, timing].filter(Boolean).join(' · ');
  $('publish-event-visibility').textContent = eventData.secret_show_enabled
    ? 'Secret Show: guests will need your access code.'
    : eventData.visibility === 'private'
      ? 'Private — Link Only: only people with the link can open your event.'
      : 'Public: your event will be visible on your public Host Page.';
  $('publish-event-error').hidden = true;
  $('publish-event-edit').hidden = true;
  $('publish-event-edit').href = `/events/${encodeURIComponent(eventData.id)}/edit`;
  $('publish-event-dialog').showModal();
  $('publish-event-title').focus();
}

$('publish-event').addEventListener('click', () => openPublishDialog($('publish-event')));
$('manage-mobile-publish').addEventListener('click', () => openPublishDialog($('manage-mobile-publish')));
$('publish-event-cancel').addEventListener('click', closePublishDialog);
$('publish-event-close').addEventListener('click', closePublishDialog);
$('publish-event-dialog').addEventListener('cancel', event => {
  if (publishBusy) event.preventDefault();
});
$('publish-event-dialog').addEventListener('close', () => {
  publishReturnFocus?.focus({ preventScroll: true });
});
$('publish-event-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (publishBusy || !$('publish-event-dialog').open || eventData?.status !== 'draft') return;
  publishBusy = true;
  const button = $('publish-event-confirm');
  button.disabled = true;
  button.textContent = 'Publishing…';
  $('publish-event-form').setAttribute('aria-busy', 'true');
  $('publish-event-cancel').disabled = true;
  $('publish-event-close').disabled = true;
  $('publish-event-error').hidden = true;
  $('publish-event-edit').hidden = true;
  syncPublicationActions();
  syncMobileManageAvailability();
  try {
    const result = await api(`/api/events/${eventId}/publish`, { method: 'POST' });
    if (result?.event?.status !== 'published') throw new Error('Publication could not be confirmed. Refresh the page to check your event.');
    // Reuse the existing publication success journey; no invitations are sent here.
    eventData = result.event;
    window.location.replace(`/events/${encodeURIComponent(eventId)}/manage?created=1`);
  } catch (error) {
    $('publish-event-error').textContent = error.message || 'Publication could not be confirmed. Refresh the page to check your event.';
    $('publish-event-error').hidden = false;
    $('publish-event-edit').hidden = false;
    $('publish-event-error').focus();
    publishBusy = false;
    button.disabled = false;
    button.textContent = 'Publish event';
    $('publish-event-cancel').disabled = false;
    $('publish-event-close').disabled = false;
    $('publish-event-form').removeAttribute('aria-busy');
    syncPublicationActions();
    syncMobileManageAvailability();
  }
});

function showManageLoadError() {
  $('manage-load-error').hidden = false;
  $('manage-overview').setAttribute('aria-busy', 'false');
  $('manage-guest-section').setAttribute('aria-busy', 'false');
  $('manage-hero-skeleton').hidden = true;
  $('manage-hero-placeholder').hidden = false;
  $('title').textContent = 'Event unavailable';
  $('meta').textContent = 'Try loading this page again.';
  ['stat-rsvps', 'stat-attendance', 'stat-returning', 'stat-guests', 'stat-comments'].forEach(id => { $(id).textContent = '—'; });
  $('familiar-faces-grid').innerHTML = '';
  $('no-guests').textContent = 'We could not load Familiar Faces. Try loading the page again.';
  $('no-guests').hidden = false;
}

async function loadEvent() {
  const { event } = await api(`/api/events/${eventId}`);
  eventData = event;
  $('manage-shell').classList.toggle('is-past-event', isPostEventEligible());
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
  else if (event.lifecycle_phase === 'tonight') { badge.className = 'sg-badge sg-badge-accent'; badge.textContent = 'Tonight'; }
  else if (event.lifecycle_phase === 'ended') { badge.className = 'sg-badge'; badge.textContent = 'Ended'; }
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
  const returningStat = Number(event.returning_count) || 0;
  const invitedStat = Number(event.invited_returning_count) || 0;
  $('stat-returning').textContent = returningStat;
  $('stat-returning-note').textContent = invitedStat
    ? `${invitedStat} from your invites`
    : 'Guests who came before';
  if (isPostEventEligible()) {
    $('familiar-faces-title').textContent = 'Your guests, remembered';
  }
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
  $('edit-link').href = `/events/${encodeURIComponent(event.id)}/edit`;
  syncPublicationActions();

  if (event.status === 'cancelled') {
    $('cancel-event').style.display = 'none';
    $('line-card').style.display = 'none';
    $('collect-photos-card').hidden = true;
  } else if (isPostEventEligible()) {
    $('line-card').style.display = '';
    $('collect-photos-card').hidden = !event.collect_photos_enabled;
  } else if (event.visibility === 'private') {
    $('promotion-copy').textContent = 'Share your private event link or download its QR code.';
    $('line-feature').style.display = 'none';
  }
  renderLifecycleCard();
  syncMobileManageAvailability();
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
  updateMobileManageSummaries();
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
  const badge = photo && face.avatarBadge === '👰'
    ? '<i class="familiar-face-badge" aria-hidden="true">👰</i>'
    : '';
  return photo
    ? `<img src="${escapeHtml(photo)}" alt="" loading="lazy">${badge}`
    : `<span class="familiar-face-emoji" aria-hidden="true">${escapeHtml(face.avatarEmoji || familiarInitials(face.name))}</span>`;
}

function familiarFaceCard(face) {
  const selected = familiarFaceSelection.has(face.id);
  const selectionLabel = `${selected ? 'Remove' : 'Select'} ${face.name}${face.status ? `, ${face.status}` : ''} ${selected ? 'from' : 'for'} an invitation`;
  const content = `<span class="familiar-face-avatar">${familiarAvatar(face)}</span>
    <span class="familiar-face-name">${escapeHtml(face.name)}</span>
    <span class="familiar-face-status">${escapeHtml(face.status)}</span>
    ${face.visitLabel ? `<span class="familiar-face-visits${face.visitCount > 1 ? ' is-returning' : ''}">${escapeHtml(face.visitLabel)}</span>` : ''}
    ${familiarSelectionMode && face.canInvite ? `<span class="familiar-face-check" aria-hidden="true">✓</span>` : ''}
    ${familiarSelectionMode && !face.canInvite && face.note ? `<span class="familiar-face-note">${escapeHtml(face.note)}</span>` : ''}`;
  const classes = ['familiar-face-card', `is-${face.group || 'going'}`];
  if (face.plusOne) classes.push('is-plus-one');
  if (face.declined) classes.push('is-declined');
  if (selected) classes.push('is-selected');
  if (face.canInvite && familiarFaceState.canStartInvitation) {
    return `<button class="${classes.join(' ')}" type="button" data-familiar-face="${escapeHtml(face.id)}" aria-pressed="${selected}" aria-label="${escapeHtml(selectionLabel)}">${content}</button>`;
  }
  return `<article class="${classes.join(' ')}">${content}</article>`;
}

// Going gets the big faces; invited is a quieter row under its own title;
// can't make it folds away at the bottom.
const FAMILIAR_GROUPS = [
  { key: 'going', title: 'Going' },
  { key: 'invited', title: 'Invited, no answer yet' },
  { key: 'declined', title: 'Can’t make it', collapsed: true }
];

// Past events reveal the same Familiar Faces records through a more useful
// lens. Nothing is copied into a second list: primary RSVPs use their existing
// visit history, while +1s remain visibly separate because they have no
// independent identity or attendance history.
const PAST_FAMILIAR_GROUPS = [
  { key: 'returning', title: 'Familiar faces marked going again', matches: face => (face.group || 'going') === 'going' && !face.plusOne && Number(face.visitCount) > 1 },
  { key: 'new', title: 'New faces marked going', matches: face => (face.group || 'going') === 'going' && !face.plusOne && Number(face.visitCount) === 1 },
  { key: 'additional', title: 'Additional guests marked going', matches: face => (face.group || 'going') === 'going' && face.plusOne },
  { key: 'going', title: 'Other RSVPs marked going', matches: face => (face.group || 'going') === 'going' && !face.plusOne && Number(face.visitCount) < 1 },
  { key: 'invited', title: 'Invited, no answer yet', matches: face => face.group === 'invited' },
  { key: 'declined', title: 'Can’t make it', collapsed: true, matches: face => face.group === 'declined' }
];

function renderFamiliarFaces() {
  const grid = $('familiar-faces-grid');
  // The grid is rebuilt on every change, so a keyboard user who just pressed
  // a card would land at the top of the page. Put them back on the same face.
  const focusedFace = grid.contains(document.activeElement)
    ? document.activeElement.closest('[data-familiar-face]')?.dataset.familiarFace
    : '';
  const openGroups = new Set([...grid.querySelectorAll('details[open]')].map(group => group.dataset.group));
  // Each section brings its own grid, so the outer one stops being a grid.
  grid.classList.add('is-grouped');
  const groups = isPostEventEligible() ? PAST_FAMILIAR_GROUPS : FAMILIAR_GROUPS;
  grid.innerHTML = groups.map(group => {
    const faces = familiarFaceState.faces.filter(group.matches || (face => (face.group || 'going') === group.key));
    if (!faces.length) return '';
    const heading = `${escapeHtml(group.title)} <span class="familiar-faces-group-count">${faces.length}</span>`;
    const cards = `<div class="familiar-faces-grid familiar-faces-group-grid">${faces.map(familiarFaceCard).join('')}</div>`;
    return group.collapsed
      ? `<details class="familiar-faces-group is-${group.key}" data-group="${group.key}"${openGroups.has(group.key) ? ' open' : ''}><summary class="familiar-faces-group-title">${heading}</summary>${cards}</details>`
      : `<section class="familiar-faces-group is-${group.key}"><h3 class="familiar-faces-group-title">${heading}</h3>${cards}</section>`;
  }).join('');
  if (focusedFace) {
    [...grid.querySelectorAll('[data-familiar-face]')]
      .find(card => card.dataset.familiarFace === focusedFace)?.focus();
  }
  $('no-guests').hidden = familiarFaceState.faces.length > 0;
}

function familiarFacesSummary(data) {
  if (isPostEventEligible()) {
    const returning = data.faces.filter(face => (face.group || 'going') === 'going' && !face.plusOne && Number(face.visitCount) > 1).length;
    const firstTime = data.faces.filter(face => (face.group || 'going') === 'going' && !face.plusOne && Number(face.visitCount) === 1).length;
    const additional = data.faces.filter(face => (face.group || 'going') === 'going' && face.plusOne).length;
    const parts = [];
    if (returning) parts.push(`${returning} returning`);
    if (firstTime) parts.push(`${firstTime} first-time`);
    if (additional) parts.push(`${additional} additional ${additional === 1 ? 'guest' : 'guests'}`);
    return parts.length ? `${parts.join(' · ')} — all marked going.` : 'RSVPs and invitations, together.';
  }
  const parts = [];
  if (data.goingCount) parts.push(`${data.goingCount} going`);
  if (data.invitedCount) parts.push(`${data.invitedCount} invited`);
  if (data.declinedCount) parts.push(`${data.declinedCount} can’t make it`);
  return parts.length ? parts.join(' · ') : 'RSVPs and invitations, together.';
}

function syncFamiliarMobileChrome() {
  const actionVisible = mobileManageLayout.matches && activeMobileManageView === 'guests'
    && (!$('familiar-faces-selection').hidden || !$('familiar-people-bar').hidden);
  document.body.classList.toggle('has-familiar-mobile-action', actionVisible);
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
  syncFamiliarMobileChrome();
}

function startFamiliarSelection(initialFaceId = '') {
  familiarSelectionMode = true;
  if (initialFaceId) familiarFaceSelection.add(initialFaceId);
  $('familiar-faces-start').hidden = true;
  $('familiar-faces-selection').hidden = false;
  updateFamiliarSelection();
  // The Invite button just hid itself; start the keyboard on the first face.
  if (!initialFaceId) $('familiar-faces-grid').querySelector('[data-familiar-face]')?.focus();
}

function stopFamiliarSelection() {
  familiarSelectionMode = false;
  familiarFaceSelection.clear();
  $('familiar-faces-selection').hidden = true;
  $('familiar-faces-start').hidden = !(familiarFaceState.canStartInvitation && familiarFaceState.selectableCount > 0);
  renderFamiliarFaces();
  syncFamiliarMobileChrome();
  // Cancel just hid itself; hand focus back to where selecting began.
  const start = $('familiar-invite-start');
  if (!$('familiar-faces-start').hidden && start) start.focus();
  else $('search')?.focus();
}

async function loadGuests(search = '') {
  const data = await api(`/api/events/${eventId}/familiar-faces${search ? `?search=${encodeURIComponent(search)}` : ''}`);
  familiarFaceState = data;
  $('familiar-faces-summary').textContent = familiarFacesSummary(data);
  $('no-guests').textContent = search ? 'No people match that search.'
    : eventData?.status === 'draft' ? 'No RSVPs for this draft yet. Publish before sharing or inviting.'
      : 'No faces yet. Share the event link to receive RSVPs.';
  $('export-csv').disabled = Number(data.totalCount) === 0;
  $('search').disabled = false;
  $('familiar-faces-start').hidden = familiarSelectionMode || !(data.canStartInvitation && Number(data.selectableCount) > 0);
  renderFamiliarFaces();
  $('manage-guest-section').setAttribute('aria-busy', 'false');
  updateMobileManageSummaries();
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

$('copy-link').addEventListener('click', () => $('share-event').click());

$('share-event').addEventListener('click', async () => {
  if (eventData?.status !== 'published') return;
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

// Same share sheet as Promote → Share event; the click stays inside the tap so
// the phone still allows the native share sheet.
$('manage-mobile-share').addEventListener('click', () => $('share-event').click());

$('lifecycle-next-event').addEventListener('click', () => duplicateEvent($('lifecycle-next-event'), { repeat: true }));

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
  if (eventData?.status !== 'published') return;
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

async function duplicateEvent(button, { repeat = false } = {}) {
  if (button.dataset.busy === 'true') return;

  const previousHtml = button.innerHTML;
  button.dataset.busy = 'true';
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  button.textContent = repeat ? 'Creating your draft…' : 'Duplicating…';
  $('duplicate').disabled = true;
  $('lifecycle-next-event').disabled = true;
  if (!mobileManageLayout.matches || activeMobileManageView !== 'actions') $('more-menu').removeAttribute('open');

  try {
    const { event } = await api(`/api/events/${eventId}/duplicate`, { method: 'POST' });
    if (!event?.id) throw new Error('The duplicate was created without an editable event');
    if (!event.slug) throw new Error('The duplicate was created without an event page');
    window.location.assign(`/e/${encodeURIComponent(event.slug)}?edit=${repeat ? 'details&repeat=1' : 'appearance'}`);
  } catch (err) {
    delete button.dataset.busy;
    button.disabled = false;
    button.removeAttribute('aria-busy');
    button.innerHTML = previousHtml;
    $('duplicate').disabled = false;
    $('lifecycle-next-event').disabled = false;
    toast(err.message || 'Could not duplicate this event');
  }
}

$('duplicate').addEventListener('click', () => duplicateEvent($('duplicate')));

let smsPreviewState = null;
let followerPreviewState = null;

function currentLifecycleVariant() {
  if (!eventData || !window.SgeEventLifecycle) return 'new-event';
  return window.SgeEventLifecycle.variantFor({
    event: eventData,
    smsPreview: smsPreviewState,
    followerPreview: followerPreviewState
  });
}

function isPostEventEligible() {
  return Boolean(eventData && window.SgeEventLifecycle?.isPostEventEligible(eventData));
}

function setPromotionActionVisible(id, visible) {
  const node = $(id);
  node.hidden = !visible;
  if (!visible) node.style.display = 'none';
  else if (id !== 'invite-previous-guests' && id !== 'announce') node.style.display = '';
}

function renderReminderReceipt() {
  const receipt = window.SgeEventLifecycle.deliveryReceipt(eventData);
  const node = $('lifecycle-receipt');
  node.hidden = false;
  if (!receipt.hasRecordedSend) {
    $('lifecycle-receipt-title').textContent = 'No day-before reminder was sent';
    $('lifecycle-receipt-copy').textContent = 'There are no recorded text or email deliveries for this event.';
    return;
  }

  $('lifecycle-receipt-title').textContent = 'Reminder sent yesterday';
  const parts = [
    `${receipt.textDelivered} delivered by text`,
    `${receipt.emailSent} sent by email`
  ];
  if (receipt.textPending) parts.push(`${receipt.textPending} text ${receipt.textPending === 1 ? 'status' : 'statuses'} pending`);
  if (receipt.textFailed || receipt.emailFailed) {
    parts.push(`${receipt.textFailed + receipt.emailFailed} failed`);
  }
  $('lifecycle-receipt-copy').textContent = `${parts.join(' · ')}.`;
}

function renderLifecycleCard() {
  if (!eventData) return;
  const card = $('line-card');
  if (eventData.status === 'cancelled' || eventData.status === 'draft') {
    card.style.display = 'none';
    syncPublicationActions();
    return;
  }

  const variant = currentLifecycleVariant();
  card.dataset.lifecycleVariant = variant;
  card.style.display = '';
  $('copy-link').hidden = variant === 'ended';
  $('lifecycle-recap').hidden = variant !== 'ended';
  $('lifecycle-receipt').hidden = variant !== 'tonight';
  $('promotion-action-list').hidden = variant === 'ended';
  $('get-word-out-label').hidden = variant === 'tonight' || variant === 'ended';
  $('reach-guests-label').hidden = variant === 'tonight' || variant === 'ended';

  if (variant === 'ended') {
    $('lifecycle-card-title').textContent = 'Your night';
    $('promotion-copy').textContent = 'A private record of the RSVPs, familiar faces, and turnout estimate behind this event.';
    $('line-feature').style.display = 'none';
    updateMobileManageSummaries();
    return;
  }

  $('lifecycle-recap').hidden = true;
  $('promotion-action-list').hidden = false;
  if (variant === 'tonight') {
    const receipt = window.SgeEventLifecycle.deliveryReceipt(eventData);
    $('lifecycle-card-title').textContent = 'Tonight';
    $('promotion-copy').textContent = receipt.hasRecordedSend
      ? 'Your guests have their reminder. One last push for anyone still deciding.'
      : 'One last push for anyone still deciding before doors.';
    setPromotionActionVisible('share-event', true);
    setPromotionActionVisible('download-qr', false);
    renderPeopleAction();
    setPromotionActionVisible('sms-audience', false);
    setPromotionActionVisible('announce', false);
    $('share-event').querySelector('.promotion-action-title').textContent = 'Last call';
    $('share-event').querySelector('.promotion-action-description').textContent = 'Share your event link one more time before doors.';
    $('line-feature').style.display = 'none';
    renderReminderReceipt();
    updateMobileManageSummaries();
    return;
  }

  $('lifecycle-card-title').textContent = 'Promote your event';
  $('promotion-copy').textContent = eventData.duplicated_from_id
    ? 'Your new event is ready to share. Guests and messages were not copied. Choose whom to invite with Familiar Faces; review before anything is sent.'
    : variant === 'new-event'
      ? 'Start sharing. Reminder signups and followers will appear here.'
      : 'Spread the word and keep your guests in the loop.';
  $('get-word-out-label').hidden = false;
  $('reach-guests-label').hidden = false;
  setPromotionActionVisible('share-event', true);
  setPromotionActionVisible('download-qr', true);
  $('share-event').querySelector('.promotion-action-title').textContent = 'Share event';
  $('share-event').querySelector('.promotion-action-description').textContent = eventData.sms_reminder_enabled
    ? 'Share the RSVP link so guests can opt in to the reminder.'
    : 'Send or post your event link.';
  if (eventData.sms_reminder_enabled && smsPreviewState) renderSmsAction(smsPreviewState);
  renderPeopleAction();
  if (followerPreviewState) renderFollowerAction(followerPreviewState);
  $('line-feature').style.display = eventData.visibility === 'public' && eventData.status === 'published' ? '' : 'none';
  updateMobileManageSummaries();
}

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
let peopleState = { canBrowsePastGuests: false, canInvite: false, people: [], plusOnes: [], total: 0, hasMore: false, sources: [] };
let peopleSearch = '';
let peopleGroup = 'all';
// A whole group being invited in one tap ("Invite everyone (87)"), which the
// server resolves so it also covers people past the first page.
let peopleBulk = null;
let peopleConfirming = false;
let peopleRequest = 0;
let peopleTab = 'familiar';
let contactsState = { contacts: [], total: 0, matchingTotal: 0, eligibleCount: 0, hasMore: false };
let contactsRequest = 0;
let contactsSearch = '';
let contactsSearchTimer;

function personSelectionKey(person) { return person.selectionKey || person.id; }
function canSelectPeople() { return eventData?.status === 'published' && !eventData.is_past && !eventData.archived_at && !eventData.secret_show_enabled && !isPostEventEligible(); }

function setPeopleTab(tab, { focus = false } = {}) {
  peopleTab = tab === 'contacts' ? 'contacts' : 'familiar';
  for (const name of ['familiar', 'contacts']) {
    const selected = peopleTab === name;
    $(`people-tab-${name}`).setAttribute('aria-selected', String(selected));
    $(`people-tab-${name}`).tabIndex = selected ? 0 : -1;
    $(`people-panel-${name}`).hidden = !selected;
  }
  $('familiar-people-source-label').hidden = peopleTab !== 'familiar';
  if (focus) $(`people-tab-${peopleTab}`).focus();
  if (peopleTab === 'contacts') loadContacts().catch(showContactsError);
  renderPeopleBar();
}

function showContactsError(error) {
  $('people-contacts-error').hidden = false;
  $('people-contacts-error').textContent = error.message || 'Could not load your contacts. Try again.';
}

function renderContacts() {
  $('people-contacts-count').textContent = contactsState.total;
  $('people-contacts-grid').innerHTML = contactsState.contacts.map(contact => {
    const selected = peopleSelection.has(personSelectionKey(contact));
    return `<button type="button" class="people-contact${selected ? ' is-selected' : ''}" data-contact-id="${escapeHtml(contact.id)}" aria-pressed="${selected}"${contact.eligible ? '' : ' disabled'}><span class="people-contact-check" aria-hidden="true">✓</span><span><strong>${escapeHtml(contact.name || contact.email)}</strong>${contact.name ? `<small>${escapeHtml(contact.email)}</small>` : ''}${!contact.eligible ? `<small class="people-contact-reason">${escapeHtml(contact.reason || 'Not eligible for this event')}</small>` : ''}</span></button>`;
  }).join('');
  $('people-contacts-empty').hidden = contactsState.contacts.length > 0;
  $('people-contacts-empty').textContent = contactsSearch ? 'No contacts match that search.' : 'Bring your people. Import a CSV or paste emails to get started.';
  $('people-contacts-all').hidden = !contactsState.eligibleCount;
  $('people-contacts-all').textContent = `Select all eligible (${contactsState.eligibleCount})`;
  $('people-contacts-more').hidden = !contactsState.hasMore;
  $('people-contacts-context').textContent = contactsSearch ? `${contactsState.matchingTotal} matching contacts` : 'Your private contacts, ready for this event and the next.';
  renderPeopleBar();
}

async function loadContacts({ append = false } = {}) {
  if (!canSelectPeople()) return;
  const request = ++contactsRequest;
  const params = new URLSearchParams();
  if (contactsSearch) params.set('search', contactsSearch);
  if (append) params.set('offset', contactsState.contacts.length);
  const data = await api(`/api/events/${eventId}/guest-import/contacts?${params}`);
  if (request !== contactsRequest) return;
  $('people-contacts-error').hidden = true;
  contactsState = append ? { ...data, contacts: [...contactsState.contacts, ...data.contacts] } : data;
  renderContacts();
}

function renderPeople() {
  const canInvite = peopleState.canInvite && eventData?.status === 'published';
  $('familiar-people-title').textContent = canInvite ? 'Invite your people' : 'People from your past events';
  $('familiar-people-intro').textContent = canInvite
    ? 'Choose Familiar Faces or your contacts. Nothing sends until you review and confirm.'
    : 'These are past guests, not RSVPs for this event. Publish your event before inviting them.';
  const cards = peopleState.people.map(face => {
    if (!canInvite) return `<article class="familiar-face-card is-readonly">
      <span class="familiar-face-avatar">${familiarAvatar(face)}</span>
      <span class="familiar-face-name">${escapeHtml(face.name)}</span>
      <span class="familiar-face-status">${escapeHtml(face.detail)}</span>
    </article>`;
    const selected = peopleSelection.has(personSelectionKey(face));
    const selectionLabel = `${selected ? 'Remove' : 'Select'} ${face.name}${face.detail ? `, ${face.detail}` : ''}`;
    return `<button class="familiar-face-card${selected ? ' is-selected' : ''}" type="button" data-person="${escapeHtml(face.id)}" data-name="${escapeHtml(face.name)}" data-detail="${escapeHtml(face.detail || '')}" aria-pressed="${selected}" aria-label="${escapeHtml(selectionLabel)}">
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
      ${canInvite ? `<button class="familiar-face-share" type="button" data-share-person="${escapeHtml(face.name)}">Share link</button>` : ''}
    </article>`);
  $('familiar-people-grid').innerHTML = [...cards, ...plusOnes].join('');
  const empty = !cards.length && !plusOnes.length;
  $('familiar-people-empty').hidden = !empty;
  $('familiar-people-empty').textContent = peopleSearch
    ? 'No one from your past events matches that search.'
    : peopleGroup !== 'all' || $('familiar-people-source').value
      ? 'No past guests match this filter.'
      : canInvite ? (peopleState.sources?.length ? 'Everyone from your past events is already here.' : 'No past guests yet. Open Contacts to bring your own list.') : 'No eligible past guests to show yet.';
  renderPeopleGroups();
  $('familiar-people-more').hidden = !peopleState.hasMore;
  const unsubscribed = Number(peopleState.unsubscribedCount) || 0;
  $('familiar-people-note').hidden = !unsubscribed;
  $('familiar-people-note').textContent = unsubscribed
    ? `${unsubscribed} ${unsubscribed === 1 ? 'person' : 'people'} unsubscribed from your invitations and ${unsubscribed === 1 ? 'isn’t' : 'aren’t'} shown.`
    : '';
  renderPeopleBar();
}

// "Your crowd" chips, and the one-tap invite for public events.
function renderPeopleGroups() {
  const groups = (peopleState.groups || []).filter(group => group.key === 'all' || group.count > 0);
  const chips = $('familiar-people-groups');
  chips.hidden = groups.length < 2;
  chips.innerHTML = groups.map(group =>
    `<button class="familiar-people-group" type="button" data-group="${escapeHtml(group.key)}" aria-pressed="${group.key === peopleGroup}">${escapeHtml(group.label)} <span>${group.count}</span></button>`
  ).join('');

  // A promoter filling a public room can send to the whole group in one tap.
  // A private event starts with nobody selected, so the host picks.
  const active = groups.find(group => group.key === peopleGroup);
  const count = active?.count || 0;
  const bulkAvailable = peopleState.canInvite && eventData?.status === 'published'
    && eventData.visibility === 'public' && count > 0;
  $('familiar-people-bulk').hidden = !bulkAvailable;
  if (bulkAvailable) {
    $('familiar-people-bulk-btn').textContent = `Select ${active.label?.toLowerCase() || 'everyone'} (${count})`;
  }
}

function renderPeopleBar() {
  if (!canSelectPeople()) {
    peopleSelection.clear();
    peopleBulk = null;
    peopleConfirming = false;
  }
  const count = peopleSelection.size;
  $('familiar-people-bar').hidden = count === 0;
  if (!count) peopleConfirming = false;
  $('familiar-people-bar').classList.remove('is-confirming');
  $('familiar-people-count').textContent = `${count} selected`;
  $('familiar-people-hint').textContent = 'Selections stay with you across both tabs. Each person is counted once.';
  $('familiar-people-secondary').textContent = 'Clear';
  $('familiar-people-send').textContent = 'Review Invitations';
  syncFamiliarMobileChrome();
}

function renderPeopleAction() {
  const button = $('invite-previous-guests');
  const available = eventData?.status === 'published' && !eventData.is_past
    && !eventData.archived_at && !eventData.secret_show_enabled && !isPostEventEligible();
  button.hidden = !available;
  button.style.display = available ? '' : 'none';
  button.disabled = !available;
  $('invite-previous-guests-title').textContent = 'Invite guests';
  $('invite-previous-guests-copy').textContent = 'Choose past guests or bring your own list.';
}

async function loadPeople({ append = false } = {}) {
  const request = ++peopleRequest;
  const params = new URLSearchParams();
  if (peopleSearch) params.set('search', peopleSearch);
  if ($('familiar-people-source').value) params.set('sourceEventId', $('familiar-people-source').value);
  if (peopleGroup !== 'all') params.set('group', peopleGroup);
  if (append) params.set('offset', String(peopleState.people.length));
  const data = await api(`/api/events/${eventId}/familiar-faces/people?${params}`);
  if (request !== peopleRequest) return;
  if (append) {
    peopleState = { ...data, people: [...peopleState.people, ...data.people], plusOnes: peopleState.plusOnes };
  } else {
    peopleState = data;
  }
  $('familiar-people').hidden = !data.canInvite && (!(data.canBrowsePastGuests) || (!data.sources.length && !peopleSearch));
  $('people-source-tabs').hidden = !data.canInvite;
  const select = $('familiar-people-source');
  if (select.options.length === 1 && data.sources.length) {
    select.insertAdjacentHTML('beforeend', data.sources.map(source =>
      `<option value="${source.id}">${escapeHtml(source.title)} — ${escapeHtml(shortEventDate(source.eventDate))}</option>`
    ).join(''));
  }
  renderPeople();
  renderPeopleAction();
  updateMobileManageSummaries();
}

$('familiar-people-grid').addEventListener('click', async event => {
  if (!peopleState.canInvite || eventData?.status !== 'published') return;
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
  const face = peopleState.people.find(person => person.id === card.dataset.person);
  if (!face) return;
  const key = personSelectionKey(face);
  const selected = !peopleSelection.has(key);
  if (selected) peopleSelection.set(key, { ...face, source: 'face' });
  else peopleSelection.delete(key);
  card.classList.toggle('is-selected', selected);
  card.setAttribute('aria-pressed', String(selected));
  card.setAttribute('aria-label', `${selected ? 'Remove' : 'Select'} ${card.dataset.name}${card.dataset.detail ? `, ${card.dataset.detail}` : ''}`);
  peopleConfirming = false;
  peopleBulk = null;
  renderPeopleBar();
});

$('familiar-people-groups').addEventListener('click', event => {
  const chip = event.target.closest('[data-group]');
  if (!chip || chip.dataset.group === peopleGroup) return;
  peopleGroup = chip.dataset.group;
  peopleBulk = null;
  peopleConfirming = false;
  loadPeople().catch(error => toast(error.message));
});

$('familiar-people-bulk-btn').addEventListener('click', async () => {
  if (!peopleState.canInvite || eventData?.status !== 'published') return;
  const active = (peopleState.groups || []).find(group => group.key === peopleGroup);
  if (!active?.count) return;
  const button = $('familiar-people-bulk-btn');
  if (button.disabled) return;
  button.disabled = true;
  try {
    const data = await api(`/api/events/${eventId}/guest-import/past-selection`, { method: 'POST', body: { group: peopleGroup, sourceEventId: $('familiar-people-source').value ? Number($('familiar-people-source').value) : null, search: peopleSearch } });
    for (const face of data.people) if (!peopleSelection.has(personSelectionKey(face))) peopleSelection.set(personSelectionKey(face), { ...face, source: 'face' });
    renderPeople(); renderContacts(); $('familiar-people-send').focus();
  } catch (error) { toast(error.message || 'Could not select this group.'); }
  finally { button.disabled = false; }
});

$('familiar-people-source').addEventListener('change', () => loadPeople().catch(error => toast(error.message)));
$('familiar-people-more').addEventListener('click', () => loadPeople({ append: true }).catch(error => toast(error.message)));

$('familiar-people-secondary').addEventListener('click', () => {
  peopleSelection.clear(); peopleBulk = null; peopleConfirming = false;
  renderPeople(); renderContacts();
});

$('familiar-people-send').addEventListener('click', () => {
  if (!canSelectPeople() || !peopleSelection.size) return;
  const selected = [...peopleSelection.values()];
  guestImport?.openInvitations({ faceIds: selected.filter(person => person.source === 'face').map(person => person.id), contactIds: selected.filter(person => person.source === 'contact').map(person => person.id) }, $('familiar-people-send'));
});

async function openPastGuestPicker() {
  if (!peopleState.canInvite) {
    try { await loadPeople(); }
    catch (error) { toast(error.message || 'Could not load past guests. Try again.'); return; }
  }
  const familiarPeople = $('familiar-people');
  familiarPeople.hidden = false;
  if (!peopleState.people.length && !peopleState.plusOnes.length) {
    $('familiar-people-empty').hidden = false;
    $('familiar-people-empty').textContent = 'No eligible past guests yet. Open Contacts to bring your own list.';
  }
  const openPicker = () => {
    familiarPeople.scrollIntoView({
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
      block: 'start'
    });
    (mobileManageLayout.matches ? familiarPeople : $('search')).focus({ preventScroll: true });
  };

  if (mobileManageLayout.matches) {
    setMobileManageView('guests', { focus: false, historyMode: 'push' });
    // Wait until the Guests task is visible and has a measurable position.
    window.requestAnimationFrame(() => window.requestAnimationFrame(openPicker));
    return;
  }
  openPicker();
}

const guestImport = window.SGGuestImport?.create({
  eventId,
  api,
  canOpen: () => !$('invite-previous-guests').disabled,
  onPastGuests: openPastGuestPicker,
  onQueued: selection => {
    const faceIds = new Set((selection?.faceIds || []).map(String));
    const contactIds = new Set((selection?.contactIds || []).map(String));
    for (const [key, person] of peopleSelection) if (person.source === 'face' ? faceIds.has(String(person.id)) : contactIds.has(String(person.id))) peopleSelection.delete(key);
    peopleBulk = null; peopleConfirming = false;
    return Promise.allSettled([loadGuests(peopleSearch), loadPeople(), loadContacts()]);
  },
  onSelectionRemove: key => { peopleSelection.delete(key); renderPeople(); renderContacts(); },
  onImported: async result => {
    const selected = new Set(result.selectedContactIds.map(String));
    for (const contact of result.contacts) {
      if (selected.has(String(contact.id)) && contact.eligible && !peopleSelection.has(personSelectionKey(contact))) peopleSelection.set(personSelectionKey(contact), { ...contact, source: 'contact' });
    }
    await loadContacts().catch(showContactsError); renderPeople(); setPeopleTab('contacts');
    toast('Contacts added. Review your selected people when you’re ready to invite.');
  }
});
$('invite-previous-guests').addEventListener('click', () => {
  if ($('invite-previous-guests').disabled) return;
  openPastGuestPicker();
});

for (const tab of ['familiar', 'contacts']) {
  $(`people-tab-${tab}`).addEventListener('click', () => setPeopleTab(tab));
  $(`people-tab-${tab}`).addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    setPeopleTab(event.key === 'Home' ? 'familiar' : event.key === 'End' ? 'contacts' : tab === 'familiar' ? 'contacts' : 'familiar', { focus: true });
  });
}
$('people-contacts-csv').addEventListener('click', () => guestImport?.openImport('upload', $('people-contacts-csv')));
$('people-contacts-paste').addEventListener('click', () => guestImport?.openImport('paste', $('people-contacts-paste')));
$('people-contacts-search').addEventListener('input', event => {
  contactsSearch = event.target.value.trim();
  clearTimeout(contactsSearchTimer);
  contactsSearchTimer = setTimeout(() => loadContacts().catch(showContactsError), 200);
});
$('people-contacts-more').addEventListener('click', () => loadContacts({ append: true }).catch(showContactsError));
$('people-contacts-grid').addEventListener('click', event => {
  const button = event.target.closest('[data-contact-id]');
  if (!button || !canSelectPeople()) return;
  const contact = contactsState.contacts.find(item => String(item.id) === button.dataset.contactId);
  if (!contact?.eligible) return;
  const key = personSelectionKey(contact);
  const selected = !peopleSelection.has(key);
  if (selected) peopleSelection.set(key, { ...contact, source: 'contact' });
  else peopleSelection.delete(key);
  button.classList.toggle('is-selected', selected);
  button.setAttribute('aria-pressed', String(selected));
  renderPeopleBar(); renderPeople();
});
$('people-contacts-all').addEventListener('click', async () => {
  const button = $('people-contacts-all');
  if (button.disabled || !canSelectPeople()) return;
  button.disabled = true;
  try {
    const params = new URLSearchParams({ all: '1' });
    if (contactsSearch) params.set('search', contactsSearch);
    const data = await api(`/api/events/${eventId}/guest-import/contacts?${params}`);
    for (const contact of data.contacts) if (contact.eligible && !peopleSelection.has(personSelectionKey(contact))) peopleSelection.set(personSelectionKey(contact), { ...contact, source: 'contact' });
    renderContacts(); renderPeople();
  } catch (error) { showContactsError(error); }
  finally { button.disabled = false; }
});

function renderSmsAction(preview) {
  const button = $('sms-audience');
  const count = Number(preview.recipientCount) || 0;
  const usableBalance = Number(preview.usableBalance ?? preview.balance) || 0;
  const creditsNeeded = Number(preview.creditsNeeded ?? Math.max(0, Number(preview.creditCost) - usableBalance)) || 0;
  button.classList.remove('promotion-action-ready');
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
      $('sms-audience-copy').textContent = `${batch.creditCost - batch.refundedCredits} texting ${batch.creditCost - batch.refundedCredits === 1 ? 'credit' : 'credits'} used.`;
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
  } else if (preview.templateVersion && preview.segmentCount !== 1) {
    button.disabled = true;
    $('sms-audience-copy').textContent = preview.reason || 'This text cannot be sent safely yet. Email reminders remain included.';
  } else if (!count) {
    button.disabled = true;
    button.classList.add('promotion-action-ready');
    $('sms-audience-count').textContent = 'ON';
    $('sms-audience-copy').textContent = 'Ready · Guests can opt in when they RSVP.';
  } else if (preview.needsFunds) {
    button.disabled = false;
    button.dataset.needsFunds = 'true';
    $('sms-audience-count').textContent = 'Add credits';
    $('sms-audience-copy').textContent = `${count} opted in · ${preview.creditCost} credits total · ${usableBalance} usable for this audience. Add ${creditsNeeded} paid ${creditsNeeded === 1 ? 'credit' : 'credits'}. Complimentary texts cover US numbers only; email stays included.`;
  } else {
    button.disabled = true;
    const sendDate = window.SgeEventLifecycle.reminderDateLabel(eventData?.event_date);
    $('sms-audience-copy').textContent = `${count} opted in · ${preview.creditCost} ${preview.creditCost === 1 ? 'credit' : 'credits'} · ${usableBalance} usable for this audience. Sends ${sendDate} at 4 PM.`;
  }
}

async function loadSmsPreview() {
  try {
    smsPreviewState = await api(`/api/events/${eventId}/sms/tomorrow-preview`);
    renderSmsAction(smsPreviewState);
    renderLifecycleCard();
    return smsPreviewState;
  } catch (_) {
    $('sms-audience').disabled = true;
    $('sms-audience-copy').textContent = 'Text reminder status is temporarily unavailable.';
    renderLifecycleCard();
    return null;
  }
}

$('sms-audience').addEventListener('click', () => {
  if (smsPreviewState?.needsFunds) {
    window.location.assign(`/settings/messaging?return=${encodeURIComponent(location.pathname)}`);
  }
});

function renderFollowerAction(preview) {
  const { count, emailCount, textCount, textCreditCost, textBalance, canIncludeTexts,
    needsTextFunds, fingerprint, announcedAt, announcedCount, announcedTextCount, canAnnounce,
    hostPageUrl } = preview;
  const textUsableBalance = Number(preview.textUsableBalance ?? textBalance) || 0;
  const textCreditsNeeded = Number(preview.textCreditsNeeded ?? Math.max(0, Number(textCreditCost) - textUsableBalance)) || 0;
  const btn = $('announce');
  btn.hidden = false;
  btn.style.display = '';
  for (const key of ['action', 'count', 'emailCount', 'textCount', 'textCreditCost', 'textBalance',
    'includeTexts', 'needsTextFunds', 'fingerprint', 'hostPageUrl']) delete btn.dataset[key];

  if (announcedAt) {
    btn.disabled = true;
    const total = announcedCount + Number(announcedTextCount || 0);
    $('announce-title').textContent = `${total} ${total === 1 ? 'update' : 'updates'} sent`;
    $('announce-copy').textContent = `${announcedCount} email${announcedCount === 1 ? '' : 's'} · ${Number(announcedTextCount || 0)} text${Number(announcedTextCount || 0) === 1 ? '' : 's'}. This action can only be used once.`;
    return;
  }

  if (!canAnnounce || count === 0) {
    btn.disabled = false;
    btn.dataset.action = hostPageUrl ? 'share-host' : 'setup-host';
    if (hostPageUrl) btn.dataset.hostPageUrl = hostPageUrl;
    $('announce-title').textContent = hostPageUrl ? 'Copy and share your public page' : 'Set up your public page';
    $('announce-copy').textContent = hostPageUrl
      ? 'Followers get updates whenever you publish a public event.'
      : 'Give people one place to follow every event you host.';
    return;
  }

  btn.disabled = false;
  btn.dataset.action = 'announce';
  btn.dataset.count = count;
  btn.dataset.emailCount = emailCount;
  btn.dataset.textCount = textCount;
  btn.dataset.textCreditCost = textCreditCost;
  btn.dataset.textBalance = textBalance;
  btn.dataset.includeTexts = String(canIncludeTexts);
  btn.dataset.needsTextFunds = String(needsTextFunds);
  btn.dataset.fingerprint = fingerprint;
  if (emailCount === 0 && preview.textReason) {
    btn.disabled = true;
    $('announce-title').textContent = 'Text update unavailable';
    $('announce-copy').textContent = preview.textReason;
    return;
  }
  if (emailCount === 0 && needsTextFunds) {
    $('announce-title').textContent = `Add credits to update ${textCount} ${textCount === 1 ? 'follower' : 'followers'}`;
    $('announce-copy').textContent = `${textCount} opted into texts · ${textCreditCost} credits total · ${textUsableBalance} usable for this audience. Add ${textCreditsNeeded} paid ${textCreditsNeeded === 1 ? 'credit' : 'credits'}; complimentary texts cover US numbers only.`;
    return;
  }
  const recipientsToNotify = canIncludeTexts ? count : emailCount;
  $('announce-title').textContent = `Update ${recipientsToNotify} ${recipientsToNotify === 1 ? 'follower' : 'followers'}`;
  if (canIncludeTexts) {
    $('announce-copy').textContent = `${emailCount} email${emailCount === 1 ? '' : 's'} · ${textCount} text${textCount === 1 ? '' : 's'} · Uses ${textCreditCost} texting ${textCreditCost === 1 ? 'credit' : 'credits'} · ${Math.max(0, Number(textBalance) - Number(textCreditCost))} left afterward.`;
  } else if (needsTextFunds) {
    $('announce-copy').textContent = `${emailCount} email${emailCount === 1 ? '' : 's'} now, at no extra cost. Texts are not included in this send: ${textCount} opted in, but ${textCreditsNeeded} more paid credits are needed. Complimentary texts cover US numbers only.`;
  } else {
    $('announce-copy').textContent = `${emailCount} email${emailCount === 1 ? '' : 's'} · No paid texts.`;
  }
}

async function loadFollowers() {
  try {
    followerPreviewState = await api(`/api/events/${eventId}/followers`);
    renderFollowerAction(followerPreviewState);
    renderLifecycleCard();
    return followerPreviewState;
  } catch (_) {
    followerPreviewState = null;
    return null;
  }
}

$('announce').addEventListener('click', async () => {
  const button = $('announce');
  if (button.dataset.action === 'setup-host') {
    window.location.assign('/settings/host-page');
    return;
  }
  if (button.dataset.action === 'share-host') {
    const url = new URL(button.dataset.hostPageUrl, location.origin).href;
    try {
      if (navigator.share) await navigator.share({ title: 'Follow my events', url });
      else {
        await navigator.clipboard.writeText(url);
        toast('Page link copied');
      }
    } catch (err) {
      if (err.name !== 'AbortError') toast('Could not share your public page');
    }
    return;
  }
  const count = button.dataset.count || 'your';
  const emailCount = Number(button.dataset.emailCount || 0);
  const textCount = Number(button.dataset.textCount || 0);
  const includeTexts = button.dataset.includeTexts === 'true';
  const textCreditCost = Number(button.dataset.textCreditCost || 0);
  if (emailCount === 0 && button.dataset.needsTextFunds === 'true') {
    window.location.assign(`/settings/messaging?return=${encodeURIComponent(location.pathname)}`);
    return;
  }
  const delivery = includeTexts
    ? `${emailCount} email${emailCount === 1 ? '' : 's'} and ${textCount} text${textCount === 1 ? '' : 's'} (${textCreditCost} texting ${textCreditCost === 1 ? 'credit' : 'credits'})`
    : `${emailCount} email${emailCount === 1 ? '' : 's'}`;
  const deliveryCount = includeTexts ? Number(count) : emailCount;
  const remaining = includeTexts ? ` Your balance afterward: ${Math.max(0, Number(button.dataset.textBalance || 0) - textCreditCost)} credits.` : '';
  if (!confirm(`Send this event to ${deliveryCount} ${deliveryCount === 1 ? 'follower' : 'followers'} as ${delivery}?${remaining} This can only be done once.`)) return;
  button.disabled = true;
  $('announce-title').textContent = 'Sending…';
  $('announce-copy').textContent = includeTexts ? 'Emailing and texting your followers.' : 'Emailing your followers.';
  try {
    const { sent, textsQueued } = await api(`/api/events/${eventId}/announce`, {
      method: 'POST', body: {
        confirm: 'SEND_FOLLOWER_UPDATE', includeTexts, fingerprint: button.dataset.fingerprint
      }
    });
    toast(`Sent ${sent} email${sent === 1 ? '' : 's'}${textsQueued ? ` and queued ${textsQueued} text${textsQueued === 1 ? '' : 's'}` : ''}`);
    $('announce-title').textContent = 'Follower update sent';
    $('announce-copy').textContent = 'Invitation sent. This action can only be used once.';
  } catch (err) {
    toast(err.message);
    button.disabled = false;
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
  if (mobileManageLayout.matches && activeMobileManageView === 'actions') return;
  if (menu.open && !menu.contains(event.target)) menu.removeAttribute('open');
});

let searchTimer;
$('search').addEventListener('input', e => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    const query = e.target.value.trim();
    loadGuests(query);
    // One search box filters both grids: people connected here and your people.
    if (peopleState.canBrowsePastGuests || peopleState.canInvite) {
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
    showPublishedWelcome();
    const eventEnded = isPostEventEligible();
    if (eventEnded) {
      postEventExperience = window.SgePostEvent?.create({
        eventId,
        request: api,
        notify: toast,
        openGuests: openPostEventGuests
      });
    }
    if (savedMessage) toast(savedMessage);
    const secondaryTasks = eventEnded
      ? [
          ...(eventData.collect_photos_enabled ? [loadPhotoCollection()] : []),
          ...(postEventExperience ? [loadPostEventExperience()] : [])
        ]
      : eventData.status === 'published' && eventData.lifecycle_phase === 'tonight'
        ? [loadPeople(), loadContacts()]
        : [loadLineStatus(), loadPeople(), loadFollowers(), loadSmsPreview(), loadContacts()];
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

initializeMobileManage();
initializeManagePage();

window.setInterval(() => {
  if (document.visibilityState === 'visible' && eventData?.sms_reminder_enabled && eventData.lifecycle_phase === 'upcoming') {
    loadSmsPreview();
  }
}, 60000);
