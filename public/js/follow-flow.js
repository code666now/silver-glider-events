(() => {
  const PHONE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="2" width="10" height="20" rx="2"></rect><path d="M10 18h4"></path></svg>';
  const EMAIL_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6.5h18v12H3zM3.5 7l8.5 6 8.5-6"></path></svg>';
  let activeController = null;

  function esc(value) {
    return String(value || '').replace(/[&<>'"]/g, character => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
    })[character]);
  }

  function cleanReturnPath({ sourceEventSlug = '' } = {}) {
    const url = new URL(window.location.href);
    ['follow', 'followed', 'after_rsvp'].forEach(key => url.searchParams.delete(key));
    url.searchParams.set('follow', '1');
    if (sourceEventSlug) url.searchParams.set('after_rsvp', '1');
    return `${url.pathname}${url.search}${url.hash}`;
  }

  async function request(url, options = {}) {
    const response = await fetch(url, {
      credentials: 'same-origin',
      ...options,
      headers: {
        Accept: 'application/json',
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(options.headers || {})
      }
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.message || data.error || 'Please try again.');
      error.code = data.error || '';
      error.status = response.status;
      throw error;
    }
    return data;
  }

  function dialogMarkup() {
    return `<dialog class="sg-follow-dialog" aria-labelledby="sg-follow-title">
      <div class="sg-follow-shell">
        <div class="sg-follow-head">
          <div class="sg-follow-head-copy">
            <p class="sg-follow-eyebrow" data-follow-eyebrow>Stay in the loop</p>
            <h2 class="sg-follow-title" id="sg-follow-title" data-follow-title></h2>
            <p class="sg-follow-copy" data-follow-copy></p>
          </div>
          <button class="sg-follow-close" type="button" aria-label="Close">×</button>
        </div>
        <div class="sg-follow-body" data-follow-body></div>
      </div>
    </dialog>`;
  }

  function createController(options) {
    const hostSlug = String(options.hostSlug || '').trim();
    const hostName = String(options.hostName || 'this host').trim();
    const sourceEventSlug = String(options.sourceEventSlug || '').trim();
    const returnPath = cleanReturnPath({ sourceEventSlug });
    const wrapper = document.createElement('div');
    wrapper.innerHTML = dialogMarkup();
    const dialog = wrapper.firstElementChild;
    document.body.appendChild(dialog);
    const body = dialog.querySelector('[data-follow-body]');
    const title = dialog.querySelector('[data-follow-title]');
    const copy = dialog.querySelector('[data-follow-copy]');
    const eyebrow = dialog.querySelector('[data-follow-eyebrow]');
    const closeButton = dialog.querySelector('.sg-follow-close');
    let priorFocus = null;
    let state = null;
    let identities = [];
    let rememberedGuest = undefined;
    let pendingPreferences = null;
    let pendingPhone = '';
    let pendingAfterStepUp = null;

    function setHeader({ label = 'Stay in the loop', heading, description }) {
      eyebrow.textContent = label;
      title.textContent = heading;
      copy.textContent = description;
    }

    function showError(message) {
      const old = body.querySelector('.sg-follow-error');
      old?.remove();
      if (!message) return;
      const error = document.createElement('p');
      error.className = 'sg-follow-error';
      error.setAttribute('role', 'alert');
      error.textContent = message;
      body.prepend(error);
    }

    function busy(button, value, label) {
      if (!button) return;
      if (value) button.dataset.originalLabel = button.textContent;
      button.disabled = value;
      button.setAttribute('aria-busy', String(value));
      button.textContent = value ? label : (button.dataset.originalLabel || button.textContent);
    }

    async function loadRememberedGuest() {
      if (rememberedGuest !== undefined) return rememberedGuest;
      rememberedGuest = await fetch('/api/public/guest-session', {
        headers: { Accept: 'application/json' }, credentials: 'same-origin'
      }).then(response => response.ok ? response.json() : null).catch(() => null);
      return rememberedGuest;
    }

    async function loadAccountState() {
      try {
        const [follow, identityState] = await Promise.all([
          request(`/api/hosts/${encodeURIComponent(hostSlug)}/follow`),
          request('/api/me/identities')
        ]);
        state = { signedIn: true, ...follow };
        identities = Array.isArray(identityState.identities) ? identityState.identities : [];
        return state;
      } catch (error) {
        if (error.status === 401) {
          state = { signedIn: false, following: false, emailOn: false, textOn: false };
          identities = [];
          return state;
        }
        throw error;
      }
    }

    function emailIdentity() {
      return identities.find(identity => identity.type === 'email' && identity.isPrimary) ||
        identities.find(identity => identity.type === 'email') || null;
    }

    function phoneIdentity() {
      return identities.find(identity => identity.type === 'phone') || null;
    }

    function channelSummary(nextState = state) {
      const channels = [];
      if (nextState?.emailOn) channels.push('email');
      if (nextState?.textOn) channels.push('text');
      if (!channels.length) return 'Notifications are off.';
      return `${channels.map(value => value[0].toUpperCase() + value.slice(1)).join(' and ')} notifications are on.`;
    }

    function renderSignedOutChoice() {
      setHeader({
        label: `Follow ${hostName}`,
        heading: `Sign in once to follow ${hostName}`,
        description: 'We’ll remember your information and notification preferences on this device.'
      });
      const mobileFirst = matchMedia('(max-width: 879px)').matches;
      body.innerHTML = `<div class="sg-follow-methods">
        <button class="sg-follow-method ${mobileFirst ? 'primary' : ''}" type="button" data-method="phone">${PHONE_ICON}<span>Continue with phone</span></button>
        <button class="sg-follow-method ${mobileFirst ? '' : 'primary'}" type="button" data-method="email">${EMAIL_ICON}<span>Continue with email</span></button>
      </div>`;
      body.querySelector('[data-method="phone"]').addEventListener('click', renderPhoneEntry);
      body.querySelector('[data-method="email"]').addEventListener('click', renderEmailEntry);
      requestAnimationFrame(() => body.querySelector('.sg-follow-method.primary')?.focus());
    }

    async function renderEmailEntry() {
      setHeader({
        label: `Follow ${hostName}`,
        heading: 'Continue with email',
        description: 'We’ll email a 6-digit code. You only need to verify this address once.'
      });
      const guest = await loadRememberedGuest();
      body.innerHTML = guest?.recognized
        ? `<div class="sg-follow-remembered"><strong>Continue as ${esc(guest.firstName)}</strong><p>We’ll send a code to ${esc(guest.maskedEmail)}.</p><button class="sg-btn sg-btn-primary sg-btn-block" type="button" data-remembered>Send my code</button></div><button class="sg-follow-secondary" type="button" data-different>Use a different email</button><button class="sg-follow-secondary" type="button" data-switch>Use phone instead</button>`
        : `<form data-email-form><div class="sg-field"><label for="sg-follow-email">Email address</label><input class="sg-input" id="sg-follow-email" type="email" autocomplete="email" required placeholder="you@example.com"></div><button class="sg-btn sg-btn-primary sg-btn-block" type="submit">Email me a code</button></form><button class="sg-follow-secondary" type="button" data-switch>Use phone instead</button>`;

      body.querySelector('[data-switch]')?.addEventListener('click', renderPhoneEntry);
      body.querySelector('[data-different]')?.addEventListener('click', async () => {
        await fetch('/api/public/guest-session/forget', { method: 'POST', credentials: 'same-origin' }).catch(() => {});
        rememberedGuest = null;
        renderEmailEntry();
      });
      body.querySelector('[data-remembered]')?.addEventListener('click', async event => {
        const button = event.currentTarget;
        busy(button, true, 'Sending…');
        try {
          await request('/api/auth/guest-magic-link', {
            method: 'POST', body: JSON.stringify({ next: returnPath })
          });
          renderEmailCode({ label: guest.maskedEmail, resend: () => request('/api/auth/guest-magic-link', { method: 'POST', body: JSON.stringify({ next: returnPath }) }) });
        } catch (error) { showError(error.message);busy(button, false); }
      });
      body.querySelector('[data-email-form]')?.addEventListener('submit', async event => {
        event.preventDefault();
        const button = event.currentTarget.querySelector('button');
        const email = event.currentTarget.querySelector('input').value.trim();
        busy(button, true, 'Sending…');
        try {
          await request('/api/auth/magic-link', {
            method: 'POST', body: JSON.stringify({ email, next: returnPath })
          });
          renderEmailCode({ label: email, resend: () => request('/api/auth/magic-link', { method: 'POST', body: JSON.stringify({ email, next: returnPath }) }) });
        } catch (error) { showError(error.message);busy(button, false); }
      });
      requestAnimationFrame(() => (body.querySelector('[data-remembered]') || body.querySelector('input'))?.focus());
    }

    function renderEmailCode({ label, resend }) {
      setHeader({
        label: 'Confirm your email',
        heading: 'Enter your code',
        description: `We sent a 6-digit code to ${label}.`
      });
      body.innerHTML = `<form data-email-code-form><div class="sg-field"><label for="sg-follow-email-code">Email code</label><input class="sg-input sg-follow-code" id="sg-follow-email-code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]*" data-email-code></div><button class="sg-btn sg-btn-primary sg-btn-block" type="submit">Verify and continue</button></form><button class="sg-follow-secondary" type="button" data-resend>Send a new code</button>`;
      const form = body.querySelector('form');
      const input = form.querySelector('input');
      let verifying = false;
      async function verify() {
        const code = input.value.replace(/\D/g, '');
        if (verifying || code.length !== 6) return;
        verifying = true;
        const button = form.querySelector('button');
        busy(button, true, 'Checking…');
        try {
          const result = await request('/api/auth/verify-code', {
            method: 'POST', body: JSON.stringify({ code })
          });
          window.location.assign(result.redirect || returnPath);
        } catch (error) {
          showError(error.message);input.select();busy(button, false);verifying = false;
        }
      }
      form.addEventListener('submit', event => { event.preventDefault();verify(); });
      input.addEventListener('input', () => {
        input.value = input.value.replace(/\D/g, '').slice(0, 6);
        if (input.value.length === 6) verify();
      });
      body.querySelector('[data-resend]').addEventListener('click', async event => {
        const button = event.currentTarget;
        busy(button, true, 'Sending…');
        try { await resend();input.value = '';input.focus();setTimeout(() => busy(button, false), 30000); }
        catch (error) { showError(error.message);busy(button, false); }
      });
      input.focus();
    }

    function renderPhoneEntry() {
      setHeader({
        label: `Follow ${hostName}`,
        heading: 'Continue with phone',
        description: 'We’ll text a 6-digit code and remember you on this device.'
      });
      body.innerHTML = `<form data-phone-form><div class="sg-field"><label for="sg-follow-phone-signin">Mobile number</label><input class="sg-input" id="sg-follow-phone-signin" type="tel" autocomplete="tel" inputmode="tel" required placeholder="+1 415 555 0123"></div><button class="sg-btn sg-btn-primary sg-btn-block" type="submit">Text me a code</button></form><button class="sg-follow-secondary" type="button" data-switch>Use email instead</button>`;
      body.querySelector('[data-switch]').addEventListener('click', renderEmailEntry);
      body.querySelector('form').addEventListener('submit', async event => {
        event.preventDefault();
        const button = event.currentTarget.querySelector('button');
        const phone = event.currentTarget.querySelector('input').value.trim();
        busy(button, true, 'Sending…');
        try {
          await request('/api/auth/phone/start', { method: 'POST', body: JSON.stringify({ phone, next: returnPath }) });
          renderPhoneCode({ phone });
        } catch (error) { showError(error.message);busy(button, false); }
      });
      body.querySelector('input').focus();
    }

    function renderPhoneCode({ phone }) {
      setHeader({ label: 'Verify your phone', heading: 'Enter your code', description: `We sent a 6-digit code to ${phone}.` });
      body.innerHTML = `<form data-phone-code-form><div class="sg-field"><label for="sg-follow-phone-code">Text message code</label><input class="sg-input sg-follow-code" id="sg-follow-phone-code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]*"></div><button class="sg-btn sg-btn-primary sg-btn-block" type="submit">Verify phone</button></form><button class="sg-follow-secondary" type="button" data-email>Use email instead</button>`;
      const form = body.querySelector('form');
      const input = form.querySelector('input');
      let verifying = false;
      async function verify() {
        const code = input.value.replace(/\D/g, '');
        if (verifying || code.length !== 6) return;
        verifying = true;
        const button = form.querySelector('button');
        busy(button, true, 'Checking…');
        try {
          const result = await request('/api/auth/phone/verify', { method: 'POST', body: JSON.stringify({ code }) });
          if (result.redirect) return window.location.assign(result.redirect);
          if (result.needsEmail) return renderPhoneEmail();
          throw new Error('We couldn’t finish signing you in. Try again.');
        } catch (error) { showError(error.message);input.select();busy(button, false);verifying = false; }
      }
      form.addEventListener('submit', event => { event.preventDefault();verify(); });
      input.addEventListener('input', () => { input.value = input.value.replace(/\D/g, '').slice(0, 6);if (input.value.length === 6) verify(); });
      body.querySelector('[data-email]').addEventListener('click', renderEmailEntry);
      input.focus();
    }

    function renderPhoneEmail() {
      setHeader({ label: 'One last detail', heading: 'Add your email', description: 'We’ll verify it once so you can recover your account and sign in on any device.' });
      body.innerHTML = `<form data-phone-email-form><div class="sg-field"><label for="sg-follow-phone-email">Email address</label><input class="sg-input" id="sg-follow-phone-email" type="email" autocomplete="email" required placeholder="you@example.com"></div><button class="sg-btn sg-btn-primary sg-btn-block" type="submit">Continue</button></form>`;
      body.querySelector('form').addEventListener('submit', async event => {
        event.preventDefault();
        const button = event.currentTarget.querySelector('button');
        const email = event.currentTarget.querySelector('input').value.trim();
        busy(button, true, 'Sending…');
        try {
          await request('/api/auth/phone/email', { method: 'POST', body: JSON.stringify({ email }) });
          renderEmailCode({ label: email, resend: () => request('/api/auth/phone/email', { method: 'POST', body: JSON.stringify({ email }) }) });
        } catch (error) { showError(error.message);busy(button, false); }
      });
      body.querySelector('input').focus();
    }

    function renderPreferences() {
      const phone = phoneIdentity();
      const email = emailIdentity();
      const emailChecked = state.following ? state.emailOn : Boolean(email);
      const textChecked = state.following ? state.textOn : Boolean(phone);
      setHeader({
        label: state.following ? 'Notification preferences' : `Follow ${hostName}`,
        heading: state.following ? `Following ${hostName}` : 'How should we notify you?',
        description: `Pick how you want to hear about new events from ${hostName}.`
      });
      body.innerHTML = `<div class="sg-follow-choice-list">
        <label class="sg-follow-choice"><input type="checkbox" data-channel="text" ${textChecked ? 'checked' : ''}><span class="sg-follow-choice-copy"><strong>Text notifications</strong><small>${phone ? `Sent to your verified number ending in ${esc(String(phone.value).slice(-4))}.` : 'Add and verify a mobile number next.'} Message and data rates may apply. Reply STOP to opt out.</small></span></label>
        <label class="sg-follow-choice"><input type="checkbox" data-channel="email" ${emailChecked ? 'checked' : ''}><span class="sg-follow-choice-copy"><strong>Email notifications</strong><small>${email ? `Sent to ${esc(email.value)}.` : 'Sent to your verified account email.'} Unsubscribe anytime.</small></span></label>
      </div>
      <button class="sg-btn sg-btn-primary sg-btn-block" type="button" data-save>${state.following ? 'Save preferences' : `Follow ${esc(hostName)}`}</button>
      ${state.following ? `<button class="sg-follow-secondary" type="button" data-unfollow>Unfollow ${esc(hostName)}</button>` : ''}
      <p class="sg-follow-fine-print">Following controls future-event announcements. Your RSVP confirmations and event reminders stay separate.</p>`;
      body.querySelector('[data-save]').addEventListener('click', async event => {
        const emailEnabled = body.querySelector('[data-channel="email"]').checked;
        const textEnabled = body.querySelector('[data-channel="text"]').checked;
        if (!emailEnabled && !textEnabled && !window.confirm(`Unfollow ${hostName}? You’ll stop receiving future-event announcements.`)) return;
        pendingPreferences = { email: emailEnabled, text: textEnabled };
        if (textEnabled && !phoneIdentity()) return renderAddPhoneEntry();
        await savePreferences(event.currentTarget);
      });
      body.querySelector('[data-unfollow]')?.addEventListener('click', async event => {
        if (!window.confirm(`Unfollow ${hostName}? You’ll stop receiving email and text announcements.`)) return;
        pendingPreferences = { email: false, text: false };
        await savePreferences(event.currentTarget);
      });
      requestAnimationFrame(() => body.querySelector('[data-channel="text"]')?.focus());
    }

    async function savePreferences(button) {
      busy(button, true, 'Saving…');
      try {
        state = { signedIn: true, ...(await request(`/api/hosts/${encodeURIComponent(hostSlug)}/follow`, {
          method: 'PATCH',
          body: JSON.stringify({ ...pendingPreferences, sourceEventSlug: sourceEventSlug || undefined })
        })) };
        pendingPreferences = null;
        options.onChange?.(state);
        renderSuccess();
      } catch (error) { showError(error.message);busy(button, false); }
    }

    function renderSuccess() {
      const unfollowed = !state.following;
      setHeader({
        label: unfollowed ? 'Preferences saved' : 'You’re all set',
        heading: unfollowed ? `You’re no longer following ${hostName}` : `You’re following ${hostName}`,
        description: unfollowed ? 'You can follow again whenever you like.' : channelSummary()
      });
      body.innerHTML = `<div class="sg-follow-success"><div class="sg-follow-success-mark" aria-hidden="true">✓</div><h3>${unfollowed ? 'Notifications off' : 'Preferences saved'}</h3><p>${unfollowed ? 'Future-event announcements have stopped.' : 'We’ll use only the channels you selected.'}</p></div><button class="sg-btn sg-btn-primary sg-btn-block" type="button" data-done>Done</button>`;
      body.querySelector('[data-done]').addEventListener('click', close);
      body.querySelector('[data-done]').focus();
    }

    function renderAddPhoneEntry() {
      setHeader({ label: 'Text notifications', heading: 'Add your mobile number', description: 'We’ll verify this number once, then remember it everywhere on Silver Glider.' });
      body.innerHTML = `<form data-add-phone-form><div class="sg-field"><label for="sg-follow-add-phone">Mobile number</label><input class="sg-input" id="sg-follow-add-phone" type="tel" autocomplete="tel" inputmode="tel" required placeholder="+1 415 555 0123" value="${esc(pendingPhone)}"></div><button class="sg-btn sg-btn-primary sg-btn-block" type="submit">Text me a code</button></form><button class="sg-follow-secondary" type="button" data-back>Back to preferences</button>`;
      body.querySelector('[data-back]').addEventListener('click', renderPreferences);
      body.querySelector('form').addEventListener('submit', async event => {
        event.preventDefault();
        pendingPhone = event.currentTarget.querySelector('input').value.trim();
        await startAddPhone(event.currentTarget.querySelector('button'));
      });
      body.querySelector('input').focus();
    }

    async function startAddPhone(button) {
      busy(button, true, 'Sending…');
      try {
        await request('/api/me/identities/phone/start', { method: 'POST', body: JSON.stringify({ phone: pendingPhone }) });
        renderAddPhoneCode();
      } catch (error) {
        if (error.code === 'identity_step_up_required') {
          pendingAfterStepUp = () => startAddPhone(null);
          return startStepUp();
        }
        showError(error.message);busy(button, false);
      }
    }

    async function startStepUp() {
      try {
        const result = await request('/api/me/identities/step-up/start', { method: 'POST', body: '{}' });
        setHeader({ label: 'Confirm your account', heading: 'Check your email', description: `Enter the code sent to ${result.maskedEmail} before adding a new sign-in number.` });
        body.innerHTML = `<form data-step-up-form><div class="sg-field"><label for="sg-follow-step-up-code">Email code</label><input class="sg-input sg-follow-code" id="sg-follow-step-up-code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]*" data-email-code></div><button class="sg-btn sg-btn-primary sg-btn-block" type="submit">Confirm account</button></form>`;
        const form = body.querySelector('form');
        const input = form.querySelector('input');
        form.addEventListener('submit', async event => {
          event.preventDefault();
          const button = form.querySelector('button');
          busy(button, true, 'Checking…');
          try {
            const verified = await request('/api/auth/verify-code', { method: 'POST', body: JSON.stringify({ code: input.value.replace(/\D/g, '') }) });
            if (verified.kind !== 'identity_step_up') throw new Error('Account confirmation could not be completed.');
            const next = pendingAfterStepUp;pendingAfterStepUp = null;
            if (next) await next();
          } catch (error) { showError(error.message);input.select();busy(button, false); }
        });
        input.focus();
      } catch (error) { renderAddPhoneEntry();showError(error.message); }
    }

    function renderAddPhoneCode() {
      setHeader({ label: 'Verify your phone', heading: 'Enter your code', description: `We sent a 6-digit code to ${pendingPhone}.` });
      body.innerHTML = `<form data-add-phone-code-form><div class="sg-field"><label for="sg-follow-add-phone-code">Text message code</label><input class="sg-input sg-follow-code" id="sg-follow-add-phone-code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]*"></div><button class="sg-btn sg-btn-primary sg-btn-block" type="submit">Verify and follow</button></form>`;
      const form = body.querySelector('form');
      const input = form.querySelector('input');
      form.addEventListener('submit', async event => {
        event.preventDefault();
        const button = form.querySelector('button');
        busy(button, true, 'Verifying…');
        try {
          const identityState = await request('/api/me/identities/phone/verify', { method: 'POST', body: JSON.stringify({ code: input.value.replace(/\D/g, '') }) });
          identities = Array.isArray(identityState.identities) ? identityState.identities : identities;
          pendingPhone = '';
          await savePreferences(button);
        } catch (error) { showError(error.message);input.select();busy(button, false); }
      });
      input.focus();
    }

    async function open() {
      if (activeController && activeController !== controller) activeController.close();
      activeController = controller;
      priorFocus = document.activeElement;
      if (!dialog.open) dialog.showModal();
      document.body.classList.add('sg-follow-open');
      setHeader({ label: `Follow ${hostName}`, heading: 'Loading…', description: 'Checking your preferences.' });
      body.innerHTML = '<p class="sg-follow-copy">One moment…</p>';
      try {
        const nextState = await loadAccountState();
        if (nextState.signedIn) renderPreferences();
        else renderSignedOutChoice();
      } catch (error) {
        setHeader({ label: `Follow ${hostName}`, heading: 'Couldn’t load your preferences', description: 'Your account was not changed.' });
        body.innerHTML = '<button class="sg-btn sg-btn-primary sg-btn-block" type="button" data-retry>Try again</button>';
        showError(error.message);
        body.querySelector('[data-retry]').addEventListener('click', open);
      }
    }

    function close() {
      if (dialog.open) dialog.close();
      document.body.classList.remove('sg-follow-open');
      activeController = null;
      const focus = priorFocus;
      priorFocus = null;
      focus?.focus?.({ preventScroll: true });
    }

    async function status() {
      return loadAccountState();
    }

    closeButton.addEventListener('click', close);
    dialog.addEventListener('cancel', event => { event.preventDefault();close(); });
    dialog.addEventListener('click', event => {
      if (event.target !== dialog) return;
      const bounds = dialog.getBoundingClientRect();
      const outside = event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom;
      if (outside) close();
    });

    const controller = { open, close, status, getState: () => state };
    return controller;
  }

  function mount(options = {}) {
    if (!options.hostSlug) return null;
    const controller = createController(options);
    options.trigger?.addEventListener('click', controller.open);
    return controller;
  }

  window.SGFollowFlow = { mount };
})();
