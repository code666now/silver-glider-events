const EVENT = JSON.parse(document.getElementById('event-data').textContent);
const $ = id => document.getElementById(id);

const icsUrl = `/e/${EVENT.slug}/calendar.ics`;
$('cal-btn').href = icsUrl;

function softenRgb({ r, g, b }) {
  const darken = 0.66;
  const desaturate = 0.18;
  const avg = (r + g + b) / 3;
  return {
    r: Math.round((avg * desaturate + r * (1 - desaturate)) * darken),
    g: Math.round((avg * desaturate + g * (1 - desaturate)) * darken),
    b: Math.round((avg * desaturate + b * (1 - desaturate)) * darken)
  };
}

function rgba({ r, g, b }, alpha) {
  return `rgba(${r},${g},${b},${alpha})`;
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

async function extractCoverPalette(url) {
  const img = await loadImageForPalette(url);
  const canvas = document.createElement('canvas');
  const size = 40;
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
    if (luminance < 0.06 || luminance > 0.95) continue;
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
    }));
  if (swatches.length < 2) throw new Error('Not enough cover color data');
  return swatches;
}

async function applyCoverPalette() {
  if (EVENT.bgEffect) return;   // an explicit effect overrides image-derived colors
  if (!EVENT.coverImageUrl) return;
  try {
    const colors = await extractCoverPalette(EVENT.coverImageUrl);
    const bg = document.querySelector('.event-bg');
    if (!bg) return;
    bg.style.setProperty('--event-bg-a', rgba(colors[0], .82));
    bg.style.setProperty('--event-bg-b', rgba(colors[1], .68));
    bg.style.setProperty('--event-bg-c', rgba(colors[2] || colors[0], .52));
    bg.classList.add('image-palette');
  } catch (_) {
    // Keep the organizer-selected background theme if image sampling is blocked.
  }
}

applyCoverPalette();

// TV static — a small canvas of noise, scaled up (chunky/retro) and redrawn ~15fps.
function mountStaticEffect() {
  if (EVENT.bgEffect !== 'static') return;
  const host = document.querySelector('.event-bg');
  if (!host) return;
  const canvas = document.createElement('canvas');
  canvas.className = 'fx-static-canvas';
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
  if (!['disco', 'fog'].includes(EVENT.bgEffect)) return;
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
    .forEach(id => { $(id).style.display = id === stateId ? 'block' : 'none'; });
  syncMobileRsvpDock();
}

if (EVENT.status === 'cancelled') show('cancelled-state');
else if (EVENT.isFull) show('full-state');

function openRsvpForm({ scrollToForm = false, trigger = null } = {}) {
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

document.querySelectorAll('[data-open-rsvp]').forEach(trigger => {
  trigger.setAttribute('aria-expanded', 'false');
  trigger.addEventListener('click', () => openRsvpForm({ scrollToForm: trigger === mobileRsvpCta, trigger }));
});
$('rsvp-close').addEventListener('click', closeRsvpForm);
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

$('rsvp-form').addEventListener('submit', async e => {
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
if (guestListToggle) {
  guestListToggle.addEventListener('click', () => {
    const expanded = guestListToggle.getAttribute('aria-expanded') === 'true';
    document.querySelectorAll('.guest-name-extra').forEach(item => { item.hidden = expanded; });
    guestListToggle.setAttribute('aria-expanded', String(!expanded));
    guestListToggle.textContent = expanded ? 'See everyone' : 'Show less';
  });
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
  if (!EVENT.commentsEnabled || !$('event-wall')) return;
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

if (EVENT.commentsEnabled && $('event-wall')) {
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
