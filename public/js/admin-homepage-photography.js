(() => {
  'use strict';
  const endpoint = '/api/admin/homepage-photography';
  const get = id => document.getElementById(id);
  const list = get('hp-photos');
  if (!list) return;
  const add = get('hp-add'), addFields = get('hp-add-fields');
  const status = get('hp-status'), error = get('hp-error'), retry = get('hp-retry');
  const state = { photos: [], loaded: false, busy: false, uploads: false, maxPhotos: 12, maxBytes: 12 * 1024 * 1024 };

  function fields(form) {
    return {
      title: form.elements.title.value.trim(),
      altText: form.elements.altText.value.trim(),
      credit: form.elements.credit.value.trim(),
      active: form.elements.active.checked
    };
  }

  function supportedImage(input) {
    const file = input.files?.[0];
    if (!file || !/^image\/(?:jpeg|png|webp)$/.test(file.type)) throw new Error('Choose a still JPG, PNG, or WebP image.');
    if (file.size > state.maxBytes) throw new Error(`Choose an image of ${Math.floor(state.maxBytes / 1048576)} MB or less.`);
    return file;
  }

  function safePreview(url) {
    if (typeof url !== 'string') return '';
    if (/^\/images\/homepage-photography\/[a-z0-9_-]+\.(?:webp|avif|jpg|png)$/.test(url)) return url;
    try {
      const parsed = new URL(url);
      if (parsed.origin === 'https://res.cloudinary.com' && !parsed.username && !parsed.password &&
          !parsed.search && !parsed.hash && /^\/[\w-]+\/image\/upload\/v\d+\/sg-events(?:-dev)?\/homepage-photography\/[a-f0-9]{32}\.webp$/.test(parsed.pathname)) return parsed.href;
    } catch { /* A missing asset can still be fixed or removed. */ }
    return '';
  }

  async function request(suffix = '', method = 'GET', payload) {
    const form = payload instanceof FormData;
    const response = await fetch(endpoint + suffix, {
      method, credentials: 'same-origin', cache: 'no-store',
      ...(payload === undefined ? {} : form ? { body: payload } : {
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
      })
    });
    if (response.status === 204) return null;
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw Object.assign(new Error(typeof data.message === 'string' ? data.message : 'Couldn’t update the gallery. Try again.'), { code: data.error });
    }
    return data;
  }

  function syncControls() {
    addFields.disabled = !state.loaded || state.busy || !state.uploads || state.photos.length >= state.maxPhotos;
    list.querySelectorAll('fieldset, button').forEach(node => {
      const blocksUpload = node.dataset.form === 'replace' || node.closest('[data-form="replace"]');
      node.disabled = state.busy || node.dataset.edge === 'true' || Boolean(blocksUpload && !state.uploads);
    });
    list.setAttribute('aria-busy', String(state.busy));
  }

  function setPhotos(photos) {
    if (!Array.isArray(photos)) throw new Error('Couldn’t load the gallery. Try again.');
    state.photos = photos.slice().sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
  }

  function render({ resetId, focusId, focusAction } = {}) {
    const drafts = new Map(Array.from(list.children, row => {
      const details = row.querySelector('details');
      return [Number(row.dataset.id), { open: details.open, values: fields(row.querySelector('[data-form="edit"]')) }];
    }));
    const fragment = document.createDocumentFragment();
    const tpl = get('hp-photo-template');
    const visible = state.photos.filter(photo => photo.active).length;
    get('hp-count').textContent = `${visible} visible · ${state.photos.length} of ${state.maxPhotos} photos`;
    get('hp-empty').hidden = state.photos.length > 0;
    get('hp-upload-note').textContent = !state.uploads ? 'Uploads aren’t configured. You can still edit, hide, reorder, or remove existing photos.'
      : state.photos.length >= state.maxPhotos ? 'The gallery is full. Remove a photo to add another.'
        : `Choose a still JPG, PNG, or WebP up to ${Math.floor(state.maxBytes / 1048576)} MB.`;
    let nextFocus;
    state.photos.forEach((photo, index) => {
      const row = tpl.content.firstElementChild.cloneNode(true);
      row.dataset.id = String(photo.id);
      const field = name => row.querySelector(`[data-field="${name}"]`);
      const action = name => row.querySelector(`[data-action="${name}"]`);
      const picture = field('preview'), url = safePreview(photo.imageUrl);
      if (url) {
        picture.addEventListener('error', () => { picture.hidden = true; field('no-preview').hidden = false; }, { once: true });
        picture.hidden = false;
        field('no-preview').hidden = true;
        picture.src = url;
      }
      field('title').textContent = photo.title;
      field('credit').textContent = photo.credit;
      field('visibility').textContent = photo.active ? 'Visible on homepage' : 'Hidden from homepage';
      field('visibility').dataset.visible = String(photo.active);
      const draft = drafts.get(photo.id);
      row.querySelector('details').open = draft?.open || false;
      const edit = row.querySelector('[data-form="edit"]');
      const meta = resetId === photo.id ? photo : draft?.values || photo;
      for (const key of ['title', 'altText', 'credit']) edit.elements[key].value = meta[key];
      edit.elements.active.checked = meta.active;
      const replace = row.querySelector('[data-form="replace"]');
      replace.hidden = !state.uploads;
      for (const [key, label, shift] of [['up', 'Move up', -1], ['down', 'Move down', 1]]) {
        const button = action(key);
        button.setAttribute('aria-label', `${label}: ${photo.title}`);
        button.dataset.edge = String(index + shift < 0 || index + shift >= state.photos.length);
        button.addEventListener('click', () => mutate('Saving photo order…', async () => {
          const ids = state.photos.map(item => item.id);
          [ids[index], ids[index + shift]] = [ids[index + shift], ids[index]];
          setPhotos((await request('/order', 'PUT', { ids })).photos);
          return { message: 'Photo order saved.', focusId: photo.id, focusAction: key };
        }));
      }
      action('edit').setAttribute('aria-label', `Edit photo: ${photo.title}`);
      edit.addEventListener('submit', event => {
        event.preventDefault();
        mutate('Saving photo details…', async () => {
          const { photo: updated } = await request(`/${photo.id}`, 'PATCH', fields(edit));
          setPhotos(state.photos.map(item => item.id === updated.id ? updated : item));
          return { message: 'Photo details saved.', resetId: photo.id, focusId: photo.id, focusAction: 'save' };
        });
      });
      replace.addEventListener('submit', event => {
        event.preventDefault();
        mutate('Uploading replacement…', async () => {
          const data = new FormData();
          data.append('image', supportedImage(replace.elements.image));
          const { photo: updated } = await request(`/${photo.id}/image`, 'POST', data);
          setPhotos(state.photos.map(item => item.id === updated.id ? updated : item));
          return { message: 'Image replaced.', focusId: photo.id, focusAction: 'replace' };
        });
      });
      action('remove').addEventListener('click', () => {
        if (state.busy || !window.confirm(`Remove “${photo.title}” from the homepage gallery?`)) return;
        mutate('Removing photo…', async () => {
          await request(`/${photo.id}`, 'DELETE');
          setPhotos(state.photos.filter(item => item.id !== photo.id));
          const next = state.photos[Math.min(index, state.photos.length - 1)];
          return { message: 'Photo removed from gallery.', focusId: next?.id };
        });
      });
      if (focusId === photo.id) {
        const target = focusAction && action(focusAction);
        nextFocus = target && target.dataset.edge !== 'true' ? target : field('title');
      }
      fragment.append(row);
    });
    list.replaceChildren(fragment);
    syncControls();
    nextFocus?.focus();
  }

  async function mutate(label, work) {
    if (state.busy || !state.loaded) return;
    state.busy = true;
    status.textContent = label;
    error.hidden = true;
    retry.hidden = true;
    syncControls();
    try {
      const result = await work();
      state.busy = false;
      render(result);
      status.textContent = result.message;
    } catch (failure) {
      status.textContent = '';
      error.textContent = failure.message || 'Something went wrong. Try again.';
      error.hidden = false;
      retry.hidden = failure.code !== 'photo_order_changed' && failure.code !== 'photo_not_found' && failure.code !== 'admin_auth_required';
    } finally {
      state.busy = false;
      syncControls();
    }
  }

  async function load() {
    if (state.busy) return;
    state.busy = true;
    status.textContent = 'Loading photos…';
    error.hidden = retry.hidden = true;
    syncControls();
    try {
      const data = await request();
      setPhotos(data.photos);
      state.uploads = data.uploadsEnabled === true;
      state.maxPhotos = data.maxPhotos || 12;
      state.maxBytes = data.maxUploadBytes || 12 * 1024 * 1024;
      state.loaded = true;
      state.busy = false;
      render();
      status.textContent = '';
    } catch (failure) {
      status.textContent = '';
      error.textContent = failure.message || 'Couldn’t load the gallery.';
      error.hidden = retry.hidden = false;
    } finally {
      state.busy = false;
      syncControls();
    }
  }

  add.addEventListener('submit', event => {
    event.preventDefault();
    mutate('Uploading photo…', async () => {
      const form = new FormData();
      form.append('image', supportedImage(add.elements.image));
      for (const [key, value] of Object.entries(fields(add))) form.append(key, String(value));
      const { photo } = await request('', 'POST', form);
      setPhotos([...state.photos, photo]);
      add.reset();
      return { message: 'Photo added.', focusId: photo.id };
    });
  });
  retry.addEventListener('click', load);
  load();
})();
