const EVENT = JSON.parse(document.getElementById('event-data').textContent);
const $ = id => document.getElementById(id);

const icsUrl = `/e/${EVENT.slug}/calendar.ics`;
$('cal-btn').href = icsUrl;
$('success-cal').href = icsUrl;
$('qr-img').src = `/e/${EVENT.slug}/qr.png`;

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
  if (!video || motionPreference.matches || saveData) return;
  video.muted = true;
  video.addEventListener('playing', () => video.classList.add('is-playing'), { once: true });
  const syncPlayback = () => {
    if (document.hidden || motionPreference.matches) video.pause();
    else video.play().catch(() => {});
  };
  document.addEventListener('visibilitychange', syncPlayback);
  motionPreference.addEventListener?.('change', syncPlayback);
  syncPlayback();
}
mountVideoEffect();

function show(stateId) {
  ['cta-state', 'rsvp-form-box', 'success-state', 'full-state', 'cancelled-state']
    .forEach(id => { $(id).style.display = id === stateId ? 'block' : 'none'; });
  // Success card has its own share/calendar buttons — drop the page-level pair
  document.querySelector('.wrap > .actions').style.display =
    stateId === 'success-state' ? 'none' : 'flex';
}

if (EVENT.status === 'cancelled') show('cancelled-state');
else if (EVENT.isFull) show('full-state');

$('rsvp-cta').addEventListener('click', () => {
  show('rsvp-form-box');
  $('full_name').focus();
});

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
        wants_reminders: $('wants_reminders').checked,
        organizer_optin: $('organizer_optin').checked
      })
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 409 && data.error === 'full') return show('full-state');
    if (!res.ok) throw new Error(data.error || 'Something went wrong');
    if (data.alreadyRsvpd) $('success-sub').textContent = "You were already on the list — we've re-sent your confirmation.";
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
$('success-share').addEventListener('click', share);
