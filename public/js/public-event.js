const EVENT = JSON.parse(document.getElementById('event-data').textContent);
const $ = id => document.getElementById(id);
const ArtworkColor = window.SGArtworkColor;

const icsUrl = `/e/${EVENT.slug}/calendar.ics`;
$('cal-btn').href = icsUrl;

function mountVibeSwitchers() {
  document.querySelectorAll('[data-vibe-switcher]').forEach(section => {
    const buttons = Array.from(section.querySelectorAll('[data-vibe-choice]'));
    const player = section.querySelector('[data-vibe-player]');
    let activeIndex = 0;
    if (!buttons.length || !player) return;

    const activate = index => {
      const button = buttons[index];
      const template = section.querySelector(`[data-vibe-template="${index}"]`);
      if (!button || !template) return;
      buttons.forEach((choice, choiceIndex) => {
        const selected = choiceIndex === index;
        choice.classList.toggle('is-active', selected);
        choice.setAttribute('aria-selected', String(selected));
        choice.tabIndex = selected ? 0 : -1;
      });
      player.setAttribute('aria-labelledby', button.id);
      if (index !== activeIndex) player.innerHTML = template.innerHTML;
      activeIndex = index;
    };

    buttons.forEach((button, index) => {
      button.addEventListener('click', () => activate(index));
      button.addEventListener('keydown', event => {
        let nextIndex = index;
        if (event.key === 'ArrowRight') nextIndex = (index + 1) % buttons.length;
        else if (event.key === 'ArrowLeft') nextIndex = (index - 1 + buttons.length) % buttons.length;
        else if (event.key === 'Home') nextIndex = 0;
        else if (event.key === 'End') nextIndex = buttons.length - 1;
        else return;
        event.preventDefault();
        activate(nextIndex);
        buttons[nextIndex].focus();
      });
    });
  });
}

mountVibeSwitchers();

async function applyCoverPalette() {
  if (document.body.classList.contains('flyer-public-page')) return;
  if (!EVENT.coverImageUrl) return;
  try {
    const candidates = await ArtworkColor.extractPalette(EVENT.coverImageUrl);
    const colors = ArtworkColor.paletteForBackground(candidates);
    const hero = $('hero');
    if (hero) {
      hero.style.setProperty('--hero-bg-a', ArtworkColor.rgba(colors[0], .76));
      hero.style.setProperty('--hero-bg-b', ArtworkColor.rgba(colors[1], .62));
      hero.style.setProperty('--hero-bg-c', ArtworkColor.rgba(colors[2] || colors[0], .54));
      hero.classList.add('image-palette');
    }
    if (EVENT.adaptiveBackground) {
      const background = document.querySelector('.event-bg');
      if (background) {
        background.style.setProperty('--event-bg-a', ArtworkColor.rgba(colors[0], .82));
        background.style.setProperty('--event-bg-b', ArtworkColor.rgba(colors[1] || colors[0], .68));
        background.style.setProperty('--event-bg-c', ArtworkColor.rgba(colors[2] || colors[0], .52));
        background.classList.add('image-palette');
      }
    }
  } catch (_) {
    // Keep the organizer-selected background theme if image sampling is blocked.
  }
}

function applyStandardMobileCoverFit() {
  if (document.body.classList.contains('flyer-public-page')) return;
  const hero = $('hero');
  const img = hero && hero.querySelector('img');
  if (!img) return;
  const resolve = () => {
    if (!img.naturalWidth || !img.naturalHeight) return;
    const isPortrait = img.naturalHeight > img.naturalWidth;
    hero.classList.toggle('cover-image-portrait', isPortrait);
    if (EVENT.coverFitMode === 'auto') {
      hero.classList.toggle('cover-fit-resolved-cover', !isPortrait);
    }
  };
  if (img.complete) resolve();
  else img.addEventListener('load', resolve, { once: true });
}

applyStandardMobileCoverFit();
applyCoverPalette();

// TV static — a small canvas of noise, scaled up (chunky/retro) and redrawn ~15fps.
function mountStaticEffect() {
  if (EVENT.bgEffect !== 'static') return;
  const host = document.querySelector('.event-bg');
  if (!host) return;
  const canvas = document.createElement('canvas');
  canvas.className = 'fx-static-canvas';
  canvas.dataset.effectTheme = 'static';
  canvas.width = 220; canvas.height = 140;   // small; CSS stretches it
  host.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  function draw() {
    const img = ctx.createImageData(w, h), d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const v = Math.random() * 255 | 0;
      d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  }
  draw();
  if (!reduce) {
    let last = 0;
    (function loop(t) {
      if (t - last > 66) { draw(); last = t; }
      requestAnimationFrame(loop);
    })(0);
  }
}
mountStaticEffect();

// Cloudinary video effects start only when motion is allowed. The host keeps a
// poster frame underneath if autoplay is blocked, the video fails, or the user
// has requested reduced motion.
function mountVideoEffect() {
  if (!['halloween', 'liquid-stardust', 'color-static', 'last-guest', 'disco', 'fog'].includes(EVENT.bgEffect)) return;
  const video = document.querySelector('.fx-video-media');
  const motionPreference = matchMedia('(prefers-reduced-motion: reduce)');
  const saveData = navigator.connection && navigator.connection.saveData;
  if (!video) return;
  video.muted = true;
  video.defaultMuted = true;
  if (motionPreference.matches || saveData) {
    video.pause();
    video.removeAttribute('autoplay');
    return;
  }
  const reveal = () => video.classList.add('is-playing');
  video.addEventListener('playing', reveal);
  video.addEventListener('loadeddata', () => { if (!video.paused) reveal(); });
  if (!video.paused && video.readyState >= 2) reveal();

  let interactionRetryArmed = false;
  const retryAfterInteraction = () => {
    video.play().then(reveal).catch(() => {});
    document.removeEventListener('touchstart', retryAfterInteraction);
    document.removeEventListener('pointerdown', retryAfterInteraction);
    interactionRetryArmed = false;
  };
  const armInteractionRetry = () => {
    if (interactionRetryArmed) return;
    interactionRetryArmed = true;
    document.addEventListener('touchstart', retryAfterInteraction, { once: true, passive: true });
    document.addEventListener('pointerdown', retryAfterInteraction, { once: true, passive: true });
  };
  const attemptPlay = () => video.play().then(reveal).catch(armInteractionRetry);
  const syncPlayback = () => {
    if (document.hidden || motionPreference.matches) video.pause();
    else attemptPlay();
  };
  document.addEventListener('visibilitychange', syncPlayback);
  motionPreference.addEventListener?.('change', syncPlayback);
  syncPlayback();
}
mountVideoEffect();

let activeRsvpState = 'cta-state';
let lastRsvpTrigger = null;
const mobileRsvpDock = $('mobile-rsvp-dock');
const mobileRsvpCta = $('mobile-rsvp-cta');
const mobileRsvpMedia = window.matchMedia('(max-width: 767px)');

function syncMobileRsvpDock() {
  if (!mobileRsvpDock || !mobileRsvpCta) return;
  const inlineCta = document.querySelector('[data-primary-action]');
  if (!inlineCta) return;
  const inlineCtaRect = inlineCta.getBoundingClientRect();
  const inlineCtaIsVisible = inlineCtaRect.bottom > 0 && inlineCtaRect.top < window.innerHeight;
  const footerTarget = document.querySelector('.sg-event-legal-footer') || document.querySelector('.flyer-attribution');
  const footerRect = footerTarget?.getBoundingClientRect();
  const footerIsNear = Boolean(footerRect && footerRect.bottom > 0 && footerRect.top < window.innerHeight * .88);
  const shouldShow = mobileRsvpMedia.matches && activeRsvpState === 'cta-state' && !inlineCtaIsVisible && !footerIsNear;
  mobileRsvpDock.hidden = !shouldShow;
  document.body.classList.toggle('has-mobile-rsvp-dock', shouldShow);
}

let mobileRsvpSyncQueued = false;
function queueMobileRsvpDockSync() {
  if (mobileRsvpSyncQueued) return;
  mobileRsvpSyncQueued = true;
  requestAnimationFrame(() => {
    mobileRsvpSyncQueued = false;
    syncMobileRsvpDock();
  });
}

function show(stateId) {
  activeRsvpState = stateId;
  ['cta-state', 'rsvp-form-box', 'success-state', 'full-state', 'cancelled-state']
    .forEach(id => {
      const element = $(id);
      if (element) element.style.display = id === stateId ? 'block' : 'none';
    });
  syncMobileRsvpDock();
}

if (EVENT.status === 'cancelled') show('cancelled-state');
else if (EVENT.rsvpEnabled !== false && !EVENT.isPast && EVENT.isFull) show('full-state');

function openRsvpForm({ scrollToForm = false, trigger = null } = {}) {
  if (EVENT.rsvpEnabled === false) return;
  lastRsvpTrigger = trigger;
  show('rsvp-form-box');
  document.querySelectorAll('[data-open-rsvp]').forEach(button => button.setAttribute('aria-expanded', 'true'));
  $('full_name').focus({ preventScroll: scrollToForm });
  if (scrollToForm) {
    $('rsvp-form-box').scrollIntoView({
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
      block: 'start'
    });
  }
}

function closeRsvpForm() {
  show('cta-state');
  document.querySelectorAll('[data-open-rsvp]').forEach(button => button.setAttribute('aria-expanded', 'false'));
  if (lastRsvpTrigger?.isConnected) lastRsvpTrigger.focus({ preventScroll: true });
}

if (EVENT.rsvpEnabled !== false) {
  document.querySelectorAll('[data-open-rsvp]').forEach(trigger => {
    trigger.setAttribute('aria-expanded', 'false');
    trigger.addEventListener('click', () => openRsvpForm({ scrollToForm: trigger === mobileRsvpCta, trigger }));
  });
  $('rsvp-close').addEventListener('click', closeRsvpForm);
}
window.addEventListener('scroll', queueMobileRsvpDockSync, { passive: true });
window.addEventListener('resize', queueMobileRsvpDockSync);
mobileRsvpMedia.addEventListener?.('change', queueMobileRsvpDockSync);
queueMobileRsvpDockSync();

const guestFields = $('guest-fields');
if (guestFields) {
  document.querySelectorAll('input[name="party_size"]').forEach(input => {
    input.addEventListener('change', () => {
      const bringingGuest = document.querySelector('input[name="party_size"]:checked')?.value === 'guest';
      guestFields.hidden = !bringingGuest;
      $('guest_name').required = bringingGuest;
      if (!bringingGuest) {
        $('guest_name').value = '';
        $('guest_email').value = '';
      }
    });
  });
}

if (EVENT.rsvpEnabled !== false) $('rsvp-form')?.addEventListener('submit', async e => {
  e.preventDefault();
  const btn = $('rsvp-submit');
  btn.disabled = true;
  btn.textContent = 'Confirming…';
  try {
    const res = await fetch(`/api/public/events/${EVENT.slug}/rsvp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        full_name: $('full_name').value.trim(),
        email: $('email').value.trim(),
        phone: $('phone').value.trim() || null,
        bringing_guest: document.querySelector('input[name="party_size"]:checked')?.value === 'guest',
        guest_name: $('guest_name')?.value.trim() || null,
        guest_email: $('guest_email')?.value.trim() || null,
        wants_reminders: $('wants_reminders').checked,
        organizer_optin: $('organizer_optin').checked
      })
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 409 && data.error === 'full') return show('full-state');
    if (res.status === 409 && data.error === 'party_full') throw new Error(data.message || 'There is not enough room for a guest.');
    if (!res.ok) throw new Error(data.error || 'Something went wrong');
    if (data.alreadyRsvpd) $('success-sub').textContent = "You were already on the list — we've re-sent your confirmation.";
    else if (EVENT.commentsEnabled) {
      $('success-sub').textContent = 'Confirmation and calendar invite are on the way. You can join the comments below.';
      await loadComments();
    }
    show('success-state');
  } catch (err) {
    const el = $('rsvp-error');
    el.textContent = err.message;
    el.style.display = 'block';
    btn.disabled = false;
    btn.textContent = 'Confirm RSVP';
  }
});

async function share() {
  const url = location.origin + `/e/${EVENT.slug}`;
  if (navigator.share) {
    try { await navigator.share({ title: EVENT.title, url }); return; } catch (_) { /* cancelled */ }
  } else {
    await navigator.clipboard.writeText(url);
    const btn = $('share-btn');
    const orig = btn.textContent;
    btn.textContent = 'Link copied';
    setTimeout(() => { btn.textContent = orig; }, 2000);
  }
}
$('share-btn').addEventListener('click', share);

const guestListToggle = $('guest-list-toggle');
const guestListModal = $('guest-list-modal');
const guestListModalClose = $('guest-list-modal-close');
const guestListInline = $('guest-list-inline');
const guestListPreview = $('guest-avatar-preview');
const guestListMobileMedia = window.matchMedia('(max-width: 599px)');
if (guestListToggle && guestListModal && guestListModalClose && guestListInline && guestListPreview) {
  const modalCard = guestListModal.querySelector('.guest-list-modal-card');
  let previousFocus = null;

  function setGuestListToggle(expanded) {
    guestListToggle.setAttribute('aria-expanded', String(expanded));
    guestListToggle.innerHTML = expanded && guestListMobileMedia.matches
      ? 'Show less <span aria-hidden="true">↑</span>'
      : 'See everyone <span aria-hidden="true">→</span>';
  }

  function toggleInlineGuestList() {
    const expanded = guestListToggle.getAttribute('aria-expanded') === 'true';
    guestListInline.hidden = expanded;
    guestListPreview.hidden = !expanded;
    setGuestListToggle(!expanded);
  }

  function openGuestList() {
    previousFocus = document.activeElement;
    guestListModal.hidden = false;
    setGuestListToggle(true);
    document.body.classList.add('guest-list-modal-open');
    modalCard.focus();
  }

  function closeGuestList({ restoreFocus = true } = {}) {
    guestListModal.hidden = true;
    setGuestListToggle(false);
    document.body.classList.remove('guest-list-modal-open');
    if (restoreFocus && previousFocus instanceof HTMLElement) previousFocus.focus();
  }

  function resetGuestListForViewport() {
    guestListInline.hidden = true;
    guestListPreview.hidden = false;
    if (!guestListModal.hidden) closeGuestList({ restoreFocus: false });
    else setGuestListToggle(false);
  }

  guestListToggle.addEventListener('click', () => {
    if (guestListMobileMedia.matches) toggleInlineGuestList();
    else openGuestList();
  });
  guestListModalClose.addEventListener('click', closeGuestList);
  guestListModal.addEventListener('click', event => {
    if (event.target === guestListModal) closeGuestList();
  });
  document.addEventListener('keydown', event => {
    if (guestListModal.hidden) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      closeGuestList();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = Array.from(guestListModal.querySelectorAll('button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])'));
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && (document.activeElement === first || document.activeElement === modalCard)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === modalCard)) {
      event.preventDefault();
      first.focus();
    }
  });
  guestListMobileMedia.addEventListener?.('change', resetGuestListForViewport);
}

function formatCommentTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function makeCommentCard(comment) {
  const card = document.createElement('article');
  card.className = 'comment-card';

  const meta = document.createElement('div');
  meta.className = 'comment-meta';
  const name = document.createElement('strong');
  name.textContent = comment.first_name;
  const time = document.createElement('span');
  time.textContent = formatCommentTime(comment.created_at);
  meta.append(name, time);

  const message = document.createElement('p');
  message.textContent = comment.message;
  card.append(meta, message);

  if (comment.can_delete) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'comment-delete';
    button.textContent = 'Delete';
    button.addEventListener('click', async () => {
      if (!confirm('Delete this comment?')) return;
      const res = await fetch(`/api/public/events/${EVENT.slug}/comments/${comment.id}`, { method: 'DELETE' });
      if (res.ok) loadComments();
    });
    card.appendChild(button);
  }
  return card;
}

async function loadComments() {
  if ((!EVENT.commentsEnabled && !EVENT.ownerPreview) || !$('event-wall')) return;
  const res = await fetch(`/api/public/events/${EVENT.slug}/comments`);
  if (!res.ok) return;
  const data = await res.json();
  const list = $('comment-list');
  list.replaceChildren();
  if (!data.comments.length) {
    const empty = document.createElement('p');
    empty.className = 'section-empty';
    empty.textContent = 'No comments yet.';
    list.appendChild(empty);
  } else {
    data.comments.forEach(comment => list.appendChild(makeCommentCard(comment)));
  }
  $('comment-count').textContent = data.comments.length;
  $('comment-form').hidden = !data.canComment;
  $('comment-locked').hidden = data.canComment;
}

if ((EVENT.commentsEnabled || EVENT.ownerPreview) && $('event-wall')) {
  const message = $('comment-message');
  message.addEventListener('input', () => { $('comment-length').textContent = `${message.value.length}/300`; });
  $('comment-form').addEventListener('submit', async event => {
    event.preventDefault();
    const button = $('comment-submit');
    const error = $('comment-error');
    error.style.display = 'none';
    button.disabled = true;
    button.textContent = 'Posting…';
    try {
      const res = await fetch(`/api/public/events/${EVENT.slug}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: message.value })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Could not post comment');
      message.value = '';
      $('comment-length').textContent = '0/300';
      await loadComments();
    } catch (err) {
      error.textContent = err.message;
      error.style.display = 'block';
    } finally {
      button.disabled = false;
      button.textContent = 'Post';
    }
  });
  loadComments();
}

if (EVENT.ownerPreview) {
  window.SGEventPreview = {
    setGuestListVisible(visible) {
      const section = $('owner-preview-guest-list');
      if (section) section.hidden = !visible;
      if (!visible) {
        if (guestListModal) guestListModal.hidden = true;
        if (guestListInline) guestListInline.hidden = true;
        if (guestListPreview) guestListPreview.hidden = false;
        if (guestListToggle) guestListToggle.setAttribute('aria-expanded', 'false');
        document.body.classList.remove('guest-list-modal-open');
      }
    },
    setGuestFieldsVisible(visible) {
      const fields = $('owner-preview-guest-fields');
      if (fields) fields.hidden = !visible;
    },
    setCommentsVisible(visible) {
      const wall = $('event-wall');
      if (!wall) return;
      wall.hidden = !visible;
      if (visible) loadComments();
    }
  };
}
