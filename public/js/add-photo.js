// Opened either with a full account session or with the photo-only grant from
// an RSVP confirmation email. The account nav is rendered only for the former;
// its /api/auth/me call would send a photo-only visitor to sign in.
const photoCard = document.querySelector('.add-photo-card');
const photoImage = document.getElementById('add-photo-image');
const photoFallback = document.getElementById('add-photo-fallback');
const photoStatus = document.getElementById('add-photo-status');
const photoInput = document.getElementById('add-photo-input');
const photoButton = document.getElementById('add-photo-button');
const photoSkip = document.getElementById('add-photo-skip');
let hasPhoto = false;

function initials(value) {
  return String(value || '').trim().split(/\s+/).slice(0, 2).map(part => part[0] || '').join('').toUpperCase() || 'SG';
}

function safeEventDestination(fallback = '/dashboard') {
  const slug = String(new URLSearchParams(location.search).get('event') || '').trim();
  return /^[a-z0-9-]{1,180}$/.test(slug) ? `/e/${encodeURIComponent(slug)}` : fallback;
}

function showPhoto(url) {
  const safeUrl = sgSafeHttpUrl(url);
  hasPhoto = Boolean(safeUrl);
  if (safeUrl) {
    photoImage.src = safeUrl;
    photoImage.hidden = false;
    photoFallback.hidden = true;
  } else {
    photoImage.removeAttribute('src');
    photoImage.hidden = true;
    photoFallback.hidden = false;
  }
  photoButton.textContent = hasPhoto ? 'Replace photo' : 'Add photo';
}

async function uploadPhoto(file) {
  if (!file) return;
  if (!/^image\/(jpeg|png|webp|gif)$/.test(file.type)) {
    photoStatus.textContent = 'Choose a JPG, PNG, WebP, or GIF image.';
    photoStatus.classList.add('is-error');
    return;
  }
  if (file.size > 5 * 1024 * 1024) {
    photoStatus.textContent = 'That image is larger than 5 MB.';
    photoStatus.classList.add('is-error');
    return;
  }
  photoButton.disabled = true;
  photoButton.textContent = 'Uploading…';
  photoStatus.classList.remove('is-error');
  photoStatus.textContent = 'Saving your photo…';
  try {
    const body = new FormData();
    body.append('image', file);
    const response = await fetch('/api/uploads/avatar', { method: 'POST', body, credentials: 'same-origin' });
    const data = await response.json().catch(() => ({}));
    if (response.status === 401) {
      location.href = `/login?next=${encodeURIComponent(location.pathname + location.search)}`;
      return;
    }
    if (!response.ok) throw new Error(data.error || 'Photo upload failed');
    showPhoto(data.url);
    photoStatus.textContent = 'Photo saved. Friends can now recognize you.';
  } catch (error) {
    photoStatus.textContent = error.message || 'Could not upload your photo. Try again.';
    photoStatus.classList.add('is-error');
  } finally {
    photoButton.disabled = false;
    photoButton.textContent = hasPhoto ? 'Replace photo' : 'Add photo';
    photoInput.value = '';
  }
}

photoSkip.href = safeEventDestination();
photoButton.addEventListener('click', () => photoInput.click());
photoInput.addEventListener('change', () => uploadPhoto(photoInput.files?.[0]));

api('/api/me').then(({ user, scope }) => {
  if (scope === 'photo') photoSkip.href = safeEventDestination('/');
  else renderNav('');
  photoFallback.textContent = initials(user.name || user.email);
  showPhoto(user.avatarUrl);
  photoStatus.textContent = user.avatarUrl
    ? 'Your photo is already saved. You can replace it anytime.'
    : 'This photo will be reused anywhere your verified guest identity appears.';
  photoButton.disabled = false;
  photoCard.setAttribute('aria-busy', 'false');
}).catch(error => {
  photoStatus.textContent = error.message || 'Could not load your profile.';
  photoStatus.classList.add('is-error');
  photoCard.setAttribute('aria-busy', 'false');
});
