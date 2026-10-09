(() => {
  const loading = document.getElementById('flyer-intake-loading');
  const closed = document.getElementById('flyer-intake-closed');
  const workspace = document.getElementById('flyer-intake-workspace');
  const success = document.getElementById('flyer-intake-success');
  const form = document.getElementById('flyer-intake-form');
  const fileInput = document.getElementById('flyer-file');
  const previewCard = document.querySelector('.flyer-intake-preview-card');
  const chooseButton = document.getElementById('choose-flyer');
  const previewImage = document.getElementById('flyer-preview-image');
  const previewEmpty = document.getElementById('flyer-preview-empty');
  const errorNode = document.getElementById('flyer-intake-error');
  const submitButton = document.getElementById('flyer-intake-submit');
  let previewUrl = '';

  function showAvailability(isOpen) {
    loading.hidden = true;
    closed.hidden = isOpen;
    workspace.hidden = !isOpen;
  }

  function setError(message, focus = false) {
    errorNode.textContent = message || '';
    if (focus && message) errorNode.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  function clearPreview() {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = '';
    previewImage.removeAttribute('src');
    previewImage.hidden = true;
    previewEmpty.hidden = false;
    previewCard.classList.remove('has-file');
    chooseButton.textContent = 'Choose flyer';
  }

  function showPreview(file) {
    clearPreview();
    if (!file) return;
    if (!/^image\/(jpeg|png|webp|gif)$/.test(file.type)) {
      fileInput.value = '';
      setError('Choose a JPG, PNG, WebP, or GIF flyer.');
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      fileInput.value = '';
      setError('Choose an image smaller than 5 MB.');
      return;
    }
    previewUrl = URL.createObjectURL(file);
    previewImage.src = previewUrl;
    previewImage.hidden = false;
    previewEmpty.hidden = true;
    previewCard.classList.add('has-file');
    chooseButton.textContent = 'Replace flyer';
    setError('');
  }

  async function loadAvailability() {
    try {
      const response = await fetch('/api/flyer-intake', { credentials: 'same-origin' });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.message || 'Could not check flyer submissions.');
      showAvailability(data.acceptingSubmissions === true);
    } catch (_) {
      loading.innerHTML = '<strong>We couldn’t check flyer submissions.</strong> <button class="sg-btn sg-btn-ghost" id="retry-flyer-intake" type="button">Try again</button>';
      document.getElementById('retry-flyer-intake').addEventListener('click', () => {
        loading.textContent = 'Checking availability…';
        loadAvailability();
      });
    }
  }

  previewEmpty.addEventListener('click', () => fileInput.click());
  chooseButton.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => showPreview(fileInput.files[0]));

  form.addEventListener('submit', async event => {
    event.preventDefault();
    setError('');
    if (!fileInput.files[0]) {
      setError('Choose your flyer before sending.', true);
      previewEmpty.focus();
      return;
    }
    if (!form.reportValidity()) return;

    submitButton.disabled = true;
    submitButton.textContent = 'Sending…';
    try {
      const body = new FormData(form);
      const response = await fetch('/api/flyer-intake', {
        method: 'POST',
        credentials: 'same-origin',
        body
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = new Error(data.message || 'We couldn’t send your flyer. Try again.');
        error.code = data.error;
        throw error;
      }
      workspace.hidden = true;
      success.hidden = false;
      success.focus({ preventScroll: true });
      success.scrollIntoView({ block: 'start', behavior: 'smooth' });
      clearPreview();
      form.reset();
    } catch (error) {
      if (error.code === 'flyer_intake_closed') {
        workspace.hidden = true;
        closed.hidden = false;
        closed.scrollIntoView({ block: 'start', behavior: 'smooth' });
      } else {
        setError(error.message, true);
      }
    } finally {
      submitButton.disabled = false;
      submitButton.textContent = 'Send My Flyer';
    }
  });

  window.addEventListener('pagehide', () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
  });

  loadAvailability();
})();
