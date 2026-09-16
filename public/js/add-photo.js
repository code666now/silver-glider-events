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
const photoRemove = document.getElementById('add-photo-remove');
const photoSuccess = document.getElementById('add-photo-success');
const photoReturn = document.getElementById('add-photo-return');
const photoNote = document.getElementById('add-photo-note');
const returnUrl = photoCard.dataset.returnUrl || '/events?view=going';
let hasPhoto = false;

function initials(value) {
  return String(value || '').trim().split(/\s+/).slice(0, 2).map(part => part[0] || '').join('').toUpperCase() || 'SG';
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
  photoButton.disabled = true;
  photoButton.textContent = 'Working…';
  photoStatus.classList.remove('is-error');
  photoStatus.textContent = 'Optimizing your photo…';
  try {
    const uploadFile = await window.SGImageOptimizer.optimizeAvatar(file);
    const body = new FormData();
    body.append('image', uploadFile);
    photoStatus.textContent = 'Saving your photo…';
    const response = await fetch('/api/uploads/avatar', { method: 'POST', body, credentials: 'same-origin' });
    const data = await response.json().catch(() => ({}));
    if (response.status === 401) {
      location.href = `/login?next=${encodeURIComponent(location.pathname + location.search)}`;
      return;
    }
    if (!response.ok) throw new Error(data.error || 'Photo upload failed');
    showPhoto(data.url);
    photoStatus.textContent = 'Photo saved. Friends can now recognize you.';
    photoStatus.hidden = true;
    photoButton.hidden = true;
    photoRemove.hidden = true;
    photoSkip.hidden = true;
    photoNote.hidden = true;
    photoSuccess.hidden = false;
    photoSuccess.querySelector('h2').focus();
    setTimeout(() => location.assign(returnUrl), 2000);
  } catch (error) {
    photoStatus.textContent = error.message || 'Could not upload your photo. Try again.';
    photoStatus.classList.add('is-error');
  } finally {
    photoButton.disabled = false;
    photoButton.textContent = hasPhoto ? 'Replace photo' : 'Add photo';
    photoInput.value = '';
  }
}

photoSkip.href = returnUrl;
photoReturn.href = returnUrl;
photoButton.addEventListener('click', () => photoInput.click());
photoInput.addEventListener('change', () => uploadPhoto(photoInput.files?.[0]));
photoRemove.addEventListener('click', async () => {
  photoRemove.disabled = true;
  photoStatus.classList.remove('is-error');
  photoStatus.textContent = 'Removing your photo…';
  try {
    await api('/api/me/profile', { method: 'PATCH', body: { avatarUrl: null } });
    showPhoto(null);
    photoStatus.textContent = 'Photo removed.';
    photoRemove.hidden = true;
  } catch (error) {
    photoStatus.textContent = error.message || 'Could not remove your photo.';
    photoStatus.classList.add('is-error');
  } finally {
    photoRemove.disabled = false;
  }
});

api('/api/me').then(({ user, scope }) => {
  if (scope !== 'photo') renderNav('');
  photoFallback.textContent = initials(user.name || user.email);
  showPhoto(user.avatarUrl);
  photoRemove.hidden = scope === 'photo' || !user.avatarUrl;
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
