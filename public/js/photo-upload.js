(() => {
  const form = document.getElementById('photo-form');
  const input = document.getElementById('images');
  const selection = document.getElementById('selection');
  const status = document.getElementById('photo-status');
  const submit = document.getElementById('submit-photos');
  const success = document.getElementById('photo-success');
  const allowed = new Set(['image/jpeg', 'image/png', 'image/webp']);
  const maxBytes = 5 * 1024 * 1024;

  function validateFiles() {
    const files = [...input.files];
    if (!files.length) return 'Choose at least one photo.';
    if (files.length > 5) return 'Choose up to five photos.';
    if (files.some(file => !allowed.has(file.type))) return 'Choose JPG, PNG, or WebP images.';
    if (files.some(file => file.size > maxBytes)) return 'Each photo must be 5 MB or smaller.';
    return '';
  }

  input.addEventListener('change', () => {
    const count = input.files.length;
    selection.textContent = count ? `${count} photo${count === 1 ? '' : 's'} selected.` : 'No photos selected.';
    status.textContent = validateFiles();
  });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    const error = validateFiles();
    if (error) {
      status.textContent = error;
      input.focus();
      return;
    }

    status.textContent = '';
    submit.disabled = true;
    submit.textContent = 'Sharing…';
    try {
      const response = await fetch(form.action, { method: 'POST', body: new FormData(form) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Photos could not be shared. Please try again.');
      form.hidden = true;
      success.hidden = false;
      success.focus();
    } catch (error) {
      status.textContent = error.message;
      submit.disabled = false;
      submit.textContent = 'Share photos';
    }
  });
})();
