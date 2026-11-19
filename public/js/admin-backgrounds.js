(function initAdminBackgrounds() {
  renderNav('');
  addSkipLink();
  const grid = document.getElementById('backgrounds-grid');
  const summary = document.getElementById('backgrounds-summary');
  const errorPanel = document.getElementById('backgrounds-error');
  const errorMessage = document.getElementById('backgrounds-error-message');
  const retry = document.getElementById('backgrounds-retry');
  const catalog = window.SGEventBackgrounds;
  const states = new Map();
  let loading = false;

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function updateSummary() {
    const active = [...states.values()].filter(state => state.background.active).length;
    summary.textContent = `${active} of ${states.size} backgrounds available to hosts`;
  }

  function paint(state) {
    const { background, toggle, badge } = state;
    badge.textContent = background.active ? 'Active' : 'Inactive';
    badge.dataset.active = String(background.active);
    if (toggle) {
      toggle.setAttribute('aria-checked', String(background.active));
      toggle.setAttribute('aria-disabled', String(state.busy));
    }
    state.card.setAttribute('aria-busy', String(state.busy));
  }

  async function save(state, active) {
    if (state.busy || state.background.alwaysAvailable) return;
    state.busy = true;
    state.retry.hidden = true;
    state.status.classList.remove('is-error');
    state.status.setAttribute('role', 'status');
    state.status.textContent = 'Saving…';
    paint(state); // Keep the last confirmed switch state until the server accepts it.
    try {
      const result = await api(`/api/admin/backgrounds/${encodeURIComponent(state.background.key)}`, { method: 'PATCH', body: { active } });
      if (result.background?.key !== state.background.key || typeof result.background.active !== 'boolean') throw new Error('Unconfirmed save');
      state.background = { ...state.background, ...result.background };
      state.status.textContent = state.background.active ? 'Saved. Available for new selections.' : 'Saved. Existing events keep this background.';
    } catch (_) {
      state.status.setAttribute('role', 'alert');
      state.status.classList.add('is-error');
      state.status.textContent = 'We couldn’t confirm this change. Try again.';
      state.retry.hidden = false;
      state.pendingActive = active;
    } finally {
      state.busy = false;
      paint(state);
      updateSummary();
    }
  }

  function cardFor(background) {
    const card = element('article', 'background-card');
    const thumbnail = element('div', 'background-thumbnail');
    thumbnail.dataset.theme = background.key;
    thumbnail.setAttribute('aria-hidden', 'true');
    const poster = catalog.options.find(option => option.key === background.key)?.thumbnail || '';
    if (poster) {
      const image = element('img');
      image.src = poster;
      image.alt = '';
      image.loading = 'lazy';
      image.decoding = 'async';
      thumbnail.appendChild(image);
    }
    const body = element('div', 'background-card-body');
    const heading = element('div', 'background-card-heading');
    const title = element('h2', '', background.label);
    title.id = `background-title-${background.key}`;
    const badge = element('span', 'background-state');
    heading.append(title, badge);
    const row = element('div', 'background-switch-row');
    const label = element('span', '', background.alwaysAvailable ? 'Always available' : 'Available to hosts');
    label.id = `background-label-${background.key}`;
    row.appendChild(label);
    const status = element('p', 'background-save-status', background.alwaysAvailable ? 'Core default' : '');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    const retryButton = element('button', 'background-retry', 'Try again');
    retryButton.type = 'button';
    retryButton.hidden = true;
    retryButton.setAttribute('aria-label', `Retry ${background.label} availability change`);
    const state = { background, card, badge, status, retry: retryButton, toggle: null, busy: false };
    if (!background.alwaysAvailable) {
      const toggle = element('button', 'background-switch sg-switch-button');
      toggle.type = 'button';
      toggle.setAttribute('role', 'switch');
      toggle.setAttribute('aria-labelledby', `${title.id} ${label.id}`);
      const track = element('span', 'background-switch-track sg-switch-track');
      track.setAttribute('aria-hidden', 'true');
      toggle.appendChild(track);
      toggle.addEventListener('click', () => save(state, !state.background.active));
      row.appendChild(toggle);
      state.toggle = toggle;
    }
    retryButton.addEventListener('click', () => {
      state.toggle?.focus();
      save(state, state.pendingActive);
    });
    body.append(heading, row, status, retryButton);
    card.append(thumbnail, body);
    paint(state);
    states.set(background.key, state);
    return card;
  }

  async function load() {
    if (loading) return;
    loading = true;
    retry.disabled = true;
    if (document.activeElement === retry) {
      summary.setAttribute('tabindex', '-1');
      summary.focus();
    }
    errorPanel.hidden = true;
    grid.setAttribute('aria-busy', 'true');
    summary.textContent = 'Loading backgrounds…';
    try {
      const session = await (window.adminShellSession || getAdminSession());
      if (session.capabilities?.manageBackgrounds !== true) throw new Error('Only Super Admins can manage backgrounds.');
      const data = await api('/api/admin/backgrounds');
      if (!Array.isArray(data.backgrounds) || data.backgrounds.length !== catalog.options.length || data.backgrounds.some(item => !catalog.keys.includes(item.key) || typeof item.active !== 'boolean')) throw new Error('Background availability is unavailable. Try again.');
      const seen = new Set(data.backgrounds.map(item => item.key));
      if (seen.size !== catalog.options.length) throw new Error('Background availability is unavailable. Try again.');
      states.clear();
      grid.replaceChildren(...data.backgrounds.map(cardFor));
      updateSummary();
    } catch (error) {
      errorPanel.hidden = false;
      errorMessage.textContent = error.message || 'We couldn’t load backgrounds. Try again.';
      summary.textContent = 'Backgrounds unavailable';
    } finally {
      loading = false;
      retry.disabled = false;
      grid.setAttribute('aria-busy', 'false');
    }
  }
  retry.addEventListener('click', load);
  load();
})();
