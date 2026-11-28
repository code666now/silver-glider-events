(function initFlyerPreview() {
  const tools = document.getElementById('flyer-preview-tools');
  const dialog = document.getElementById('flyer-preview-dialog');
  const body = document.getElementById('flyer-preview-dialog-body');
  const closeButton = dialog?.querySelector('[data-preview-close]');
  if (!tools || !dialog || !body || !closeButton) return;

  let payload = null;
  let confettiTimer = 0;
  let savingVibe = false;
  const escapeHtml = value => String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');

  async function request(path, options = {}) {
    let response;
    try {
      response = await fetch(path, {
        credentials: 'same-origin',
        headers: options.body ? { 'content-type': 'application/json' } : undefined,
        ...options,
        body: options.body ? JSON.stringify(options.body) : undefined
      });
    } catch (_) {
      const error = new Error('We could not reach Silver Glider. Check your connection and try again.');
      error.status = 0;
      error.code = 'network_error';
      throw error;
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.message || 'Something went wrong. Try again.');
      error.status = response.status;
      error.code = data.error || 'request_failed';
      error.data = data;
      throw error;
    }
    return data;
  }

  async function load(fresh = false) {
    if (fresh) payload = null;
    if (!payload) payload = await request('/api/flyer-preview');
    return payload;
  }

  function previewState(data = {}) {
    const preview = data.preview || {};
    const status = data.status || preview.status || '';
    const rawUrl = data.event?.url || data.eventUrl || preview.eventUrl || '';
    let eventUrl = '';
    if (rawUrl) {
      try {
        const parsed = new URL(rawUrl, window.location.origin);
        if (['http:', 'https:'].includes(parsed.protocol)) eventUrl = parsed.href;
      } catch (_) {}
    }
    return {
      status,
      published: data.published === true || preview.published === true || status === 'published',
      eventUrl,
      eventTitle: data.event?.title || preview.eventTitle || document.title || 'Silver Glider event'
    };
  }

  function open(html, { completion = false, dismissible = true, locked = false } = {}) {
    window.clearTimeout(confettiTimer);
    dialog.classList.toggle('is-completion', completion);
    dialog.dataset.dismissible = String(dismissible);
    dialog.dataset.locked = String(locked);
    closeButton.hidden = !dismissible;
    body.innerHTML = `<div class="flyer-preview-dialog-inner">${html}</div>`;
    if (!dialog.open) dialog.showModal();
    requestAnimationFrame(() => body.querySelector('h2,[tabindex="-1"]')?.focus({ preventScroll: true }));
  }

  function setLocked(locked) {
    dialog.dataset.locked = String(locked);
    closeButton.hidden = locked || dialog.dataset.dismissible === 'false';
  }

  function close() {
    if (dialog.dataset.dismissible !== 'true' || dialog.dataset.locked === 'true') return;
    dialog.close();
  }

  function message(text, error = false) {
    const root = document.getElementById('flyer-preview-message');
    if (!root) return;
    root.textContent = text;
    root.classList.toggle('is-error', error);
  }

  function markPublished() {
    tools.dataset.previewStatus = 'published';
    document.getElementById('flyer-preview-intro')?.remove();
    document.getElementById('flyer-preview-looks')?.remove();
    const status = tools.querySelector('.flyer-preview-status p');
    const actions = tools.querySelector('.flyer-preview-actions');
    if (status) status.innerHTML = '<strong>Published</strong><span>Your event is live and ready to share.</span>';
    if (actions) actions.innerHTML = '';
  }

  function confettiHtml() {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return '';
    return `<div class="flyer-publish-confetti" aria-hidden="true">${'<i></i>'.repeat(24)}</div>`;
  }

  async function copyText(value) {
    if (navigator.clipboard && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(value);
        return;
      } catch (_) {
        // Some embedded browsers expose the Clipboard API but reject it.
        // Fall through to the legacy copy path before showing an error.
      }
    }
    const textarea = document.createElement('textarea');
    textarea.value = value;
    textarea.setAttribute('readonly', '');
    textarea.className = 'flyer-preview-copy-helper';
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand('copy');
    textarea.remove();
    if (!copied) throw new Error('Copy did not work. Press and hold the link to copy it.');
  }

  function showShare(data, { celebrate = false } = {}) {
    const state = previewState(data);
    if (!state.published || !state.eventUrl) {
      showPublishRetry('Your event is live, but we could not load its share link yet.');
      return;
    }
    payload = data;
    markPublished();
    const safeUrl = escapeHtml(state.eventUrl);
    const displayUrl = escapeHtml(state.eventUrl.replace(/^https?:\/\//i, ''));
    open(`<section class="flyer-publish-step flyer-publish-share" aria-labelledby="flyer-preview-dialog-title">
      ${celebrate ? confettiHtml() : ''}
      <div class="flyer-publish-share-mark" aria-hidden="true">
        <svg viewBox="0 0 24 24"><path d="m4 22 4.4-12.7 6.3 6.3L4 22Z"/><path d="m8.4 9.3 6.3 6.3M14 4l.7-2M18.2 7.2l2-.8M17 2.5l1.5-1.5M20.5 12l2 .7M11.5 5.5 10 4"/></svg>
      </div>
      <h2 id="flyer-preview-dialog-title" tabindex="-1">Share your event</h2>
      <p>Your event is live. Here’s your link!</p>
      <div class="flyer-publish-url">
        <span>Your event link</span>
        <a href="${safeUrl}" target="_blank" rel="noopener">${displayUrl}</a>
      </div>
      <div class="flyer-publish-share-actions">
        <button class="flyer-preview-submit is-secondary" type="button" id="flyer-copy-event-link">
          <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>
          <span>Copy link</span>
        </button>
        <button class="flyer-preview-submit" type="button" id="flyer-share-event">
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="18" cy="5" r="2.5"/><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="19" r="2.5"/><path d="m8.2 10.8 7.6-4.5M8.2 13.2l7.6 4.5"/></svg>
          <span>Share event</span>
        </button>
      </div>
      <p class="flyer-preview-message" id="flyer-preview-message" role="status" aria-live="polite"></p>
      <p class="flyer-publish-confirmation">Your event is published and ready to share.</p>
    </section>`, { completion: true, dismissible: false });

    const confetti = body.querySelector('.flyer-publish-confetti');
    if (confetti) confettiTimer = window.setTimeout(() => confetti.remove(), 1800);

    const copyButton = document.getElementById('flyer-copy-event-link');
    const copyLabel = copyButton.querySelector('span');
    const shareButton = document.getElementById('flyer-share-event');
    copyButton.addEventListener('click', async () => {
      try {
        await copyText(state.eventUrl);
        copyLabel.textContent = 'Copied!';
        message('Event link copied.');
        window.setTimeout(() => { if (copyButton.isConnected) copyLabel.textContent = 'Copy link'; }, 2200);
      } catch (error) { message(error.message, true); }
    });
    shareButton.addEventListener('click', async () => {
      if (navigator.share) {
        try {
          await navigator.share({ title: state.eventTitle, text: `Come to ${state.eventTitle}`, url: state.eventUrl });
          message('Share menu opened.');
          return;
        } catch (error) {
          if (error?.name === 'AbortError') return;
        }
      }
      try {
        await copyText(state.eventUrl);
        message('Event link copied. Paste it anywhere you want to share it.');
      } catch (error) { message(error.message, true); }
    });
  }

  function showPublishRetry(reason) {
    open(`<section class="flyer-publish-retry" aria-labelledby="flyer-preview-dialog-title">
      <p class="flyer-publish-kicker">Almost there</p>
      <h2 id="flyer-preview-dialog-title" tabindex="-1">We couldn’t publish yet</h2>
      <p>Your approval is saved. Try again—you won’t need another verification code.</p>
      <button class="flyer-preview-submit" type="button" id="flyer-publish-retry">Try publishing again</button>
      <p class="flyer-preview-message is-error" id="flyer-preview-message" role="status" aria-live="polite">${escapeHtml(reason || '')}</p>
    </section>`, { dismissible: true });
    document.getElementById('flyer-publish-retry').addEventListener('click', retryPublication);
  }

  async function retryPublication(eventOrButton) {
    const button = eventOrButton?.currentTarget || eventOrButton;
    button.disabled = true;
    setLocked(true);
    message('Publishing your event…');
    try {
      const result = await request('/api/flyer-preview/publish', { method: 'POST' });
      const state = previewState(result);
      if (!state.published || !state.eventUrl) throw new Error('Publication is still processing. Please try again.');
      showShare(result, { celebrate: true });
    } catch (error) {
      button.disabled = false;
      setLocked(false);
      message(error.message, true);
    }
  }

  function initVibe() {
    const picker = document.getElementById('flyer-preview-looks');
    const track = document.getElementById('flyer-vibe-track');
    const status = document.getElementById('flyer-vibe-status');
    const stage = picker?.querySelector('.flyer-vibe-stage');
    const motionButton = picker?.querySelector('[data-vibe-motion]');
    if (!picker || !track || !status || !stage || !motionButton) return;

    // The API owns availability and labels; the catalog supplies still art only.
    // The actual event background owns playback, never the cards on the line.
    const catalog = new Map((window.SGEventBackgrounds?.options || []).map(option => [option.key, option]));
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const scrollKey = `sge-flyer-vibe-scroll:${window.location.pathname}${window.location.search}`;
    const retry = document.createElement('button');
    retry.className = 'flyer-vibe-retry';
    retry.type = 'button';
    retry.textContent = 'Try again';
    retry.hidden = true;
    status.after(retry);

    let options = [];
    let currentKey = '';
    let cards = [];
    let copies = [];
    let loading = false;
    let blockedActions = [];
    let showAll = false;
    let heldPointer = null;
    let releaseTimer = 0;

    function announce(text, error = false) {
      status.textContent = text;
      status.classList.toggle('is-error', error);
    }

    function updateMotion() {
      const canDrift = !motion.matches && options.length > 1;
      picker.classList.toggle('is-drifting', canDrift && !showAll);
      motionButton.hidden = !canDrift;
      motionButton.textContent = showAll ? 'Resume motion' : 'Show all backgrounds';
    }

    function changeSelection(key) {
      currentKey = key;
      [...cards, ...copies].forEach(card => {
        const current = (card.dataset.look || card.dataset.vibeCopy) === key;
        if (card.dataset.look) card.setAttribute('aria-pressed', String(current));
        card.classList.toggle('is-current', current);
        card.querySelector('.flyer-vibe-current').hidden = !current;
      });
    }

    function render(looks, key) {
      // Start with photographic choices without reshuffling the line when the
      // selected look changes. The plain swatches are still in the same strip.
      options = looks.filter(option => typeof option?.key === 'string' && /^[a-z][a-z0-9-]*$/.test(option.key) &&
        (option.active === true || option.key === key))
        .sort((left, right) => Number(Boolean(catalog.get(right.key)?.thumbnail)) -
          Number(Boolean(catalog.get(left.key)?.thumbnail)));
      cards = [];
      copies = [];
      const fragment = document.createDocumentFragment();
      function addPrint(option, index, copy) {
        const item = document.createElement('li');
        item.className = 'flyer-vibe-item';
        item.style.setProperty('--vibe-angle', ['-1.2deg', '1.4deg', '-.5deg'][index % 3]);
        const card = document.createElement(copy ? 'span' : 'button');
        card.className = 'flyer-vibe-card';
        if (copy) {
          item.classList.add('flyer-vibe-copy');
          item.setAttribute('aria-hidden', 'true');
          card.dataset.vibeCopy = option.key;
          copies.push(card);
        } else {
          card.type = 'button';
          card.dataset.look = option.key;
          card.setAttribute('aria-disabled', String(savingVibe));
          cards.push(card);
        }

        const media = document.createElement('span');
        media.className = 'flyer-vibe-media';
        media.dataset.theme = option.key;
        media.setAttribute('aria-hidden', 'true');
        const thumbnail = catalog.get(option.key)?.thumbnail;
        if (thumbnail) {
          const image = document.createElement('img');
          image.alt = '';
          image.loading = 'lazy';
          image.decoding = 'async';
          image.addEventListener('error', () => image.remove(), { once: true });
          image.src = thumbnail;
          media.append(image);
        }

        const label = document.createElement('span');
        label.className = 'flyer-vibe-label';
        label.textContent = option.label || catalog.get(option.key)?.label || option.key;
        const badge = document.createElement('span');
        badge.className = 'flyer-vibe-current';
        badge.setAttribute('aria-hidden', 'true');
        badge.textContent = '✓ Current';
        card.append(media, label, badge);
        item.append(card);
        fragment.append(item);
      }

      // Start at the real buttons and move right by one full set. Additional
      // visual sets let that same loop fill the panel even for a small catalog.
      const addCopySet = () => options.forEach((option, index) => addPrint(option, index, true));
      if (options.length > 1) addCopySet();
      options.forEach((option, index) => addPrint(option, index, false));
      // Eight places cover the widest stage even at the minimum print width.
      for (let count = options.length; options.length > 1 && count < 8; count += options.length) {
        addCopySet();
      }
      track.replaceChildren(fragment);
      track.style.setProperty('--vibe-count', options.length);
      track.style.setProperty('--vibe-duration', `${options.length * 4.8}s`);
      changeSelection(key);
      updateMotion();
    }

    function currentLabel() {
      return options.find(option => option.key === currentKey)?.label || '';
    }

    function savePositionAndReload(key) {
      try {
        window.sessionStorage.setItem(scrollKey, JSON.stringify({
          top: window.scrollY,
          showAll,
          time: Date.now(),
          focus: !picker.classList.contains('is-drifting') && track.contains(document.activeElement) ? key : null
        }));
      } catch (_) {} // The saved choice must still load if storage is blocked.
      window.location.reload();
    }

    function restorePosition() {
      let saved;
      try {
        const value = window.sessionStorage.getItem(scrollKey);
        if (value == null) return;
        window.sessionStorage.removeItem(scrollKey);
        saved = JSON.parse(value);
      } catch (_) { return; }
      if (!saved || !Number.isFinite(saved.top) || !Number.isFinite(saved.time) ||
          Math.abs(Date.now() - saved.time) > 60000) return;
      showAll = saved.showAll === true;
      updateMotion();
      requestAnimationFrame(() => {
        cards.find(card => card.dataset.look === saved.focus)?.focus({ preventScroll: true });
        window.scrollTo({ top: saved.top, behavior: 'instant' });
      });
    }

    async function requestVibe(path, settings = {}) {
      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), 15000);
      try { return await request(path, { ...settings, signal: controller.signal }); }
      finally { window.clearTimeout(timer); }
    }

    async function refreshLooks() {
      const data = await requestVibe('/api/flyer-preview');
      const key = data.preview?.backgroundTheme;
      if (!Array.isArray(data.looks) || !key) throw new Error('We couldn’t load the backgrounds. Try again.');
      payload = data;
      return { looks: data.looks, key };
    }

    async function populate() {
      if (loading || savingVibe) return;
      loading = true;
      const returnFocus = document.activeElement === retry;
      retry.hidden = true;
      track.setAttribute('aria-busy', 'true');
      announce('Loading backgrounds…');
      try {
        const { looks, key } = await refreshLooks();
        render(looks, key);
        announce(currentLabel() ? `Current background: ${currentLabel()}` : 'Choose an available background.');
        restorePosition();
        if (returnFocus) cards[0]?.focus({ preventScroll: true });
      } catch (error) {
        announce(error.message, true);
        retry.hidden = false;
        if (returnFocus) retry.focus({ preventScroll: true });
      } finally {
        loading = false;
        track.removeAttribute('aria-busy');
      }
    }

    function setSaving(saving) {
      savingVibe = saving;
      if (saving) {
        track.setAttribute('aria-busy', 'true');
        blockedActions = Array.from(tools.querySelectorAll('button[data-preview-action]:not(:disabled)'));
        blockedActions.forEach(button => { button.disabled = true; });
      } else {
        track.removeAttribute('aria-busy');
        blockedActions.forEach(button => { button.disabled = false; });
        blockedActions = [];
      }
      cards.forEach(card => card.setAttribute('aria-disabled', String(saving)));
    }

    async function choose(key) {
      if (savingVibe || loading || key === currentKey || !options.some(option => option.key === key && option.active === true)) return;
      setSaving(true);
      announce('Saving background…');
      let reloading = false;
      try {
        const result = await requestVibe('/api/flyer-preview/look', {
          method: 'POST', body: { backgroundTheme: key }
        });
        if (result.ok !== true || result.backgroundTheme !== key) throw new Error('We couldn’t confirm the background was saved. Try again.');
        let applied = false;
        try { applied = window.SGFlyerPreviewBackground?.apply(result.appearance) === true; } catch (_) {}
        if (!applied) {
          savePositionAndReload(key);
          reloading = true;
          return;
        }
        if (payload?.preview) payload.preview.backgroundTheme = key;
        // A previously saved inactive option stops being available after switching away.
        if (options.some(option => option.active === false && option.key !== key)) {
          const focusedKey = document.activeElement?.dataset.look;
          render(options, key);
          cards.find(card => card.dataset.look === focusedKey)?.focus({ preventScroll: true });
        } else changeSelection(key);
        announce(`${currentLabel() || key} saved to your draft.`);
      } catch (error) {
        if (error.code === 'background_unavailable') {
          const focusedIndex = cards.indexOf(document.activeElement);
          let looks = options.filter(option => option.key !== key);
          try {
            const fresh = await refreshLooks();
            if (fresh.key !== currentKey) {
              savePositionAndReload(fresh.key);
              reloading = true;
              return;
            }
            looks = fresh.looks;
          } catch (_) {}
          render(looks, currentKey);
          const replacement = cards[Math.min(focusedIndex, cards.length - 1)];
          replacement?.focus({ preventScroll: true });
        } else if (error.status === 0 || error.status >= 500 || !error.status) {
          // The connection may have dropped after the draft was committed. Read
          // the saved state before asking the host to try the mutation again.
          try {
            const fresh = await refreshLooks();
            if (fresh.key !== currentKey) {
              savePositionAndReload(fresh.key);
              reloading = true;
              return;
            }
          } catch (_) {}
        }
        announce(error.message, true);
      } finally {
        if (!reloading) setSaving(false);
      }
    }

    retry.addEventListener('click', populate);
    motionButton.addEventListener('click', () => {
      showAll = !showAll;
      updateMotion();
    });
    motion.addEventListener?.('change', updateMotion);
    track.addEventListener('click', event => {
      const card = event.target.closest('[data-look], [data-vibe-copy]');
      if (!card) return;
      // Some assistive technology activates a button without moving DOM focus.
      if (event.detail === 0 && card.dataset.look && picker.classList.contains('is-drifting')) {
        showAll = true;
        updateMotion();
      }
      choose(card.dataset.look || card.dataset.vibeCopy);
    });
    track.addEventListener('focusin', event => {
      if (!picker.classList.contains('is-drifting') || !event.target.matches('[data-look]:focus-visible')) return;
      showAll = true;
      updateMotion();
      event.target.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
    });
    stage.addEventListener('pointerdown', event => {
      if (event.pointerType === 'mouse') return;
      heldPointer = event.pointerId;
      window.clearTimeout(releaseTimer);
      picker.classList.add('is-vibe-pressed');
    }, { passive: true });
    function releasePointer(event) {
      if (heldPointer !== event.pointerId) return;
      heldPointer = null;
      // Let a tap's click land on the same print before the line can move again.
      releaseTimer = window.setTimeout(() => picker.classList.remove('is-vibe-pressed'), 180);
    }
    window.addEventListener('pointerup', releasePointer, { passive: true });
    window.addEventListener('pointercancel', releasePointer, { passive: true });
    if ('IntersectionObserver' in window) {
      picker.classList.add('is-vibe-offscreen');
      const observer = new IntersectionObserver(([entry]) =>
        picker.classList.toggle('is-vibe-offscreen', !entry.isIntersecting));
      observer.observe(stage);
    }

    updateMotion();
    populate();
  }

  function showFix() {
    open(`<h2 id="flyer-preview-dialog-title" tabindex="-1">Request a fix</h2><p>Tell us the one thing that needs attention. We’ll update the draft and text you a fresh preview.</p><form id="flyer-preview-fix-form"><label class="flyer-preview-field"><span>What should we change?</span><textarea name="message" maxlength="1000" required placeholder="The venue time should be 8 PM…"></textarea></label><button class="flyer-preview-submit" type="submit">Send request</button><p class="flyer-preview-message" id="flyer-preview-message" role="status" aria-live="polite"></p></form>`);
    document.getElementById('flyer-preview-fix-form').addEventListener('submit', async event => {
      event.preventDefault();
      const button = event.currentTarget.querySelector('button');
      button.disabled = true;
      try {
        await request('/api/flyer-preview/fix', { method: 'POST', body: { message: new FormData(event.currentTarget).get('message') } });
        window.location.reload();
      } catch (error) { button.disabled = false; message(error.message, true); }
    });
  }

  async function showApproval() {
    open('<h2 id="flyer-preview-dialog-title" tabindex="-1">Approve and publish</h2><p>We’ll text one verification code to the phone that sent this flyer. This confirms the approval came from the right person before the event goes live.</p><button class="flyer-preview-submit" id="flyer-preview-send-code" type="button">Text me a code</button><p class="flyer-preview-message" id="flyer-preview-message" role="status" aria-live="polite"></p>');
    document.getElementById('flyer-preview-send-code').addEventListener('click', async event => {
      event.currentTarget.disabled = true;
      message('Sending your code…');
      try {
        const result = await request('/api/flyer-preview/approve/start', { method: 'POST' });
        open(`<h2 id="flyer-preview-dialog-title" tabindex="-1">Enter the code</h2><p>We sent it to ${escapeHtml(result.phone)}. Once verified, your event will go live. This does not sign you into an account.</p><form id="flyer-preview-code-form"><label class="flyer-preview-field"><span>Verification code</span><input class="flyer-preview-code" name="code" inputmode="numeric" autocomplete="one-time-code" minlength="4" maxlength="10" required></label><button class="flyer-preview-submit" type="submit">Approve and publish</button><p class="flyer-preview-message" id="flyer-preview-message" role="status" aria-live="polite"></p></form>`);
        document.getElementById('flyer-preview-code-form').addEventListener('submit', verifyApproval);
      } catch (error) { event.currentTarget.disabled = false; message(error.message, true); }
    });
  }

  async function recoverApproval(error, form, button) {
    if (error.code === 'flyer_publication_failed' || error.data?.retryable === true ||
        error.data?.status === 'promoter_approved') {
      showPublishRetry(error.message);
      return;
    }
    if (error.status > 0 && error.status < 500) {
      button.disabled = false;
      setLocked(false);
      message(error.message, true);
      return;
    }
    try {
      const current = await load(true);
      const state = previewState(current);
      if (state.published) return showShare(current, { celebrate: true });
      if (state.status === 'promoter_approved') return showPublishRetry(error.message);
    } catch (_) {}
    button.disabled = false;
    setLocked(false);
    form.querySelector('.flyer-preview-code')?.focus();
    message(`${error.message} Your code was not cleared; try again.`, true);
  }

  async function verifyApproval(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector('button');
    const code = new FormData(form).get('code');
    button.disabled = true;
    setLocked(true);
    message('Approving and publishing…');
    try {
      const result = await request('/api/flyer-preview/approve/verify', { method: 'POST', body: { code } });
      const state = previewState(result);
      if (state.published && state.eventUrl) showShare(result, { celebrate: true });
      else if (state.status === 'promoter_approved') showPublishRetry('Your approval is saved. Finish publishing your event.');
      else throw new Error('We could not confirm publication. Please try again.');
    } catch (error) { await recoverApproval(error, form, button); }
  }

  tools.addEventListener('click', event => {
    if (savingVibe) return;
    const trigger = event.target.closest('[data-preview-action]');
    const action = trigger?.dataset.previewAction;
    if (action === 'fix') showFix();
    if (action === 'approve') showApproval();
    if (action === 'retry') {
      showPublishRetry('');
      retryPublication(document.getElementById('flyer-publish-retry'));
    }
  });
  document.addEventListener('click', event => {
    if (event.target.closest('[data-preview-close]')) close();
  });
  dialog.addEventListener('click', event => {
    if (event.target === dialog) close();
  });
  dialog.addEventListener('cancel', event => {
    if (dialog.dataset.dismissible !== 'true' || dialog.dataset.locked === 'true') event.preventDefault();
  });

  initVibe();
  if (tools.dataset.previewStatus === 'published') {
    load(true).then(showShare).catch(error => showPublishRetry(error.message));
  } else if (tools.dataset.previewStatus === 'promoter_approved') {
    showPublishRetry('Your approval is saved. Finish publishing your event.');
  }
})();
