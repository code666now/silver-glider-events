/* One optional, server-authorized welcome gift. Sharing never depends on claiming. */
(() => {
  'use strict';
  const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  function localLink(value, prefix) {
    try {
      if (!value) return '';
      const url = new URL(value, window.location.origin);
      return url.origin === window.location.origin && url.pathname.startsWith(prefix) ? url.href : '';
    } catch (_) { return ''; }
  }
  function visibleState(state, options) {
    if (!state?.enabled || !['eligible', 'needs_verification', 'claimed', 'unavailable'].includes(state.state)) return false;
    if (options.context !== 'publication') return true;
    return String(state.firstPublishedEventId) === String(options.eventId)
      && state.firstEventRecentlyPublished === true;
  }
  async function request(path, options = {}) {
    const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json' }, ...options,
      body: options.body ? JSON.stringify(options.body) : undefined });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.message || data.error || 'Please try again in a moment.');
      error.data = data;
      throw error;
    }
    return data;
  }
  async function copy(value) {
    try { if (navigator.clipboard) { await navigator.clipboard.writeText(value); return; } } catch (_) {}
    const input = document.createElement('textarea');
    input.value = value;
    input.setAttribute('readonly', '');
    input.style.cssText = 'position:fixed;left:-9999px;top:0';
    document.body.appendChild(input);
    input.select();
    const copied = document.execCommand('copy');
    input.remove();
    if (!copied) throw new Error('Copy is unavailable. Open the event link below and copy its address.');
  }
  function create(container, options = {}) {
    if (!container) return null;
    let state = null;
    let claiming = false;
    let claimedThisVisit = false;
    const notify = (text, error = false) => {
      const status = container.querySelector('[data-welcome-status]');
      if (status) { status.textContent = text; status.classList.toggle('is-error', error); }
    };
    function render() {
      container.hidden = !visibleState(state, options)
        || (options.context !== 'publication' && state.state === 'claimed' && !claimedThisVisit);
      if (container.hidden) { container.replaceChildren(); return false; }
      const claimed = state.state === 'claimed' || claimedThisVisit;
      const publication = options.context === 'publication';
      const eventUrl = localLink(state.shareEventUrl, '/e/');
      const hostUrl = localLink(state.hostPageUrl, '/h/');
      const reminders = Array.isArray(state.pendingReminders) ? state.pendingReminders : [];
      const count = Number(state.credits) || 50;
      const cost = Math.max(0, Number(state.pendingReminderCredits) || 0);
      const confirmId = `${container.id || 'welcome-texts'}-confirm`;
      const missing = (state.missingVerification || []).filter(type => ['email', 'phone'].includes(type));
      const verification = missing.map(type => type === 'phone' ? 'mobile number' : 'email').join(' and ');
      container.className = `welcome-texts${claimedThisVisit ? ' is-celebrating' : ''}`;
      container.innerHTML = `
        <div class="welcome-texts-top"><span class="welcome-texts-mark" aria-hidden="true">${claimed ? '✓' : '✦'}</span><p class="welcome-texts-eyebrow">${publication ? 'Your first event is live!' : 'A welcome gift for your events'}</p></div>
        <h3>${claimed ? 'Your welcome texts are ready.' : state.state === 'unavailable' ? 'Email keeps your guests in the loop.' : `Your first ${count} texts are on us.`}</h3>
        <p class="welcome-texts-copy">Keep guests in the loop with event reminders and new-event announcements to people who choose text updates.</p>
        <p class="welcome-texts-email"><strong>Email reminders and event updates are included at no extra cost.</strong> Texts are an optional extra for guests and followers who choose them.</p>
        ${!claimed && reminders.length ? `<div class="welcome-texts-reminders"><strong>You already have text reminders enabled</strong><ul>${reminders.map(reminder => `<li>${escape(reminder.title)} <span>About ${Math.max(0, Number(reminder.creditCost) || 0)} credits</span></li>`).join('')}</ul><p>Estimated total: ${cost} credits. Adding this gift can fund those scheduled reminders. The total can change as guests RSVP.</p>${state.state === 'eligible' ? `<label for="${confirmId}"><input id="${confirmId}" data-welcome-confirm type="checkbox"><span>I understand these credits can fund my enabled reminders.</span></label>` : ''}</div>` : ''}
        <div class="welcome-texts-claim">
          ${claimed ? `<span class="welcome-texts-claimed" role="status">✓ ${count} complimentary texts added</span>`
            : state.state === 'needs_verification' ? `<p>Verify your ${escape(verification || 'sign-in details')} to claim your one-time gift.</p><a class="sg-btn sg-btn-primary" href="/settings/account?welcome=texts">Verify and claim</a>`
            : state.state === 'unavailable' ? '<p>The welcome gift is not available right now. Your included email reminders are unaffected.</p>'
            : `<button class="sg-btn sg-btn-primary" type="button" data-welcome-claim ${reminders.length ? 'disabled' : ''}>Claim my ${count} complimentary texts</button>`}
          ${!claimed && state.state !== 'unavailable' ? '<small>One-time welcome gift for verified hosts. No purchase required. Complimentary texts are for US recipients. Claiming does not turn reminders on or subscribe anyone.</small>' : ''}
        </div>
        ${eventUrl ? `<div class="welcome-texts-share"><h4>Now invite your people.</h4><p>Share your event so guests can RSVP and choose a text reminder.</p><div class="welcome-texts-share-actions"><button class="sg-btn ${claimed ? 'sg-btn-primary' : 'sg-btn-ghost'}" type="button" data-welcome-share>Share event</button><button class="welcome-texts-link" type="button" data-welcome-copy>Copy event link</button><a class="welcome-texts-link" href="${escape(eventUrl)}" target="_blank" rel="noopener">View event ↗</a></div>${hostUrl ? `<p class="welcome-texts-host">Want people to hear about future events? <button class="welcome-texts-link" type="button" data-welcome-host>Share your Host Page</button></p>` : ''}</div>` : ''}
        <p class="welcome-texts-status" data-welcome-status role="status" aria-live="polite"></p>`;
      const checkbox = container.querySelector('[data-welcome-confirm]');
      checkbox?.addEventListener('change', () => { container.querySelector('[data-welcome-claim]').disabled = claiming || !checkbox.checked; });
      container.querySelector('[data-welcome-claim]')?.addEventListener('click', claim);
      container.querySelector('[data-welcome-copy]')?.addEventListener('click', () => share(eventUrl, true));
      container.querySelector('[data-welcome-share]')?.addEventListener('click', () => share(eventUrl));
      container.querySelector('[data-welcome-host]')?.addEventListener('click', () => share(hostUrl));
      return true;
    }
    async function share(url, copyOnly = false) {
      try {
        if (!copyOnly && navigator.share) { await navigator.share({ title: 'Silver Glider Events', url }); return; }
        await copy(url);
        notify('Link copied. Paste it wherever you want to share it.');
      } catch (error) { if (error.name !== 'AbortError') notify(error.message, true); }
    }
    async function claim() {
      if (claiming || state?.state !== 'eligible') return;
      const checkbox = container.querySelector('[data-welcome-confirm]');
      if (checkbox && !checkbox.checked) return;
      claiming = true;
      const button = container.querySelector('[data-welcome-claim]');
      button.disabled = true;
      button.setAttribute('aria-busy', 'true');
      button.textContent = 'Adding your welcome texts…';
      notify('');
      try {
        const result = await request('/api/sms-credits/welcome/claim', {
          method: 'POST', body: { confirm: true, previewFingerprint: state.previewFingerprint }
        });
        state = result.welcome;
        claimedThisVisit = result.claimed === true;
        render();
        notify(result.duplicate ? 'Your welcome gift was already added. Nothing was added twice.' : 'Your 50 welcome texts were added. Email reminders remain included.');
        container.querySelector('[data-welcome-share]')?.focus({ preventScroll: true });
        options.onClaim?.(result);
      } catch (error) {
        if (error.data?.welcome) { state = error.data.welcome; render(); }
        notify(error.data?.code === 'welcome_preview_changed' ? 'Your reminder estimate changed. Review it before claiming.' : error.message, true);
      } finally {
        claiming = false;
        const current = container.querySelector('[data-welcome-claim]');
        if (current) {
          current.removeAttribute('aria-busy');
          current.textContent = 'Claim my 50 complimentary texts';
          current.disabled = Boolean(container.querySelector('[data-welcome-confirm]') && !container.querySelector('[data-welcome-confirm]').checked);
        }
      }
    }
    async function load(providedState) {
      try {
        state = providedState || await request('/api/sms-credits/welcome');
        return render();
      } catch (_) { container.hidden = true; return false; }
    }
    return { load };
  }
  window.SgeWelcomeTexts = { create };
})();
