(function contributorsModule(root, factory) {
  const moduleApi = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = moduleApi;
  if (root) root.SgeContributors = moduleApi;
  if (typeof document !== 'undefined') {
    const start = () => moduleApi.boot();
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
    else start();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function createContributorsModule() {
  const APPROVAL_VERSION = 'contributor-spotlight-v1';
  const FOLLOW_VERSION = 'contributor-follow-v1';
  const STATUSES = new Set(['invited', 'approved', 'declined', 'revoked']);

  function safeLink(value) {
    try {
      const raw = String(value || '').trim();
      if (!raw) return '';
      const origin = typeof location !== 'undefined' && location.origin ? location.origin : 'https://silvergliderevents.com';
      const parsed = new URL(raw, origin);
      return ['https:', 'http:'].includes(parsed.protocol) ? parsed.href : '';
    } catch (_) { return ''; }
  }

  function normalizeContributor(value = {}) {
    return {
      id: String(value.id || ''), name: String(value.name || ''), email: String(value.email || ''),
      role: String(value.role || ''), status: STATUSES.has(value.status) ? value.status : 'invited',
      selected: Boolean(value.selected), profileUrl: safeLink(value.profileUrl),
      photoUrl: safeLink(value.photoUrl), invitationSentAt: value.invitationSentAt || null
    };
  }

  function followMessage({ following = false, pending = false } = {}) {
    if (pending) return 'Your follow is saved. Event emails can start only after this person claims their page. You can unfollow any time.';
    if (following) return 'You’re following. You can unfollow or unsubscribe whenever you like.';
    return 'Choose to hear about their future events. Following is optional and your email is never displayed on this page.';
  }

  function text(id, value) {
    const node = document.getElementById(id);
    if (node) node.textContent = value;
  }

  function element(tag, className, value) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (value != null) node.textContent = value;
    return node;
  }

  function feedback(id, message) {
    const node = document.getElementById(id);
    if (!node) return;
    node.textContent = message || '';
    node.hidden = !message;
  }

  function busy(button, value, label) {
    if (!button) return;
    if (value) {
      button.dataset.readyLabel = button.textContent;
      button.textContent = label || 'Saving…';
      button.disabled = true;
      button.setAttribute('aria-busy', 'true');
    } else {
      button.textContent = button.dataset.readyLabel || button.textContent;
      button.disabled = false;
      button.removeAttribute('aria-busy');
    }
  }

  function paintPhoto(id, url, name) {
    const node = document.getElementById(id);
    if (!node) return;
    node.replaceChildren();
    const fallback = element('span', 'contributor-photo-fallback', String(name || 'SG').trim().slice(0, 1).toUpperCase());
    fallback.setAttribute('aria-hidden', 'true');
    node.append(fallback);
    const source = safeLink(url);
    if (source) {
      const image = element('img');
      image.alt = '';
      image.src = source;
      image.addEventListener('error', () => image.remove(), { once: true });
      node.append(image);
    }
  }

  function createHost({ eventId, request, onChange } = {}) {
    const byId = id => document.getElementById(id);
    if (!byId('post-event-contributors') || typeof request !== 'function') return null;
    const endpoint = `/api/events/${encodeURIComponent(eventId)}/contributors`;
    let records = [];
    let max = 3;
    let refreshing = null;
    const selectionWrites = new Set();

    function render(result) {
      records = (Array.isArray(result.contributors) ? result.contributors : []).map(normalizeContributor);
      max = Math.min(3, Math.max(1, Number(result.max) || 3));
      const list = byId('post-event-contributors-list');
      list.replaceChildren();
      for (const person of records) {
        const card = element('div', 'post-event-contributor-card');
        const identity = element('div');
        identity.append(element('strong', '', person.name || 'Contributor'));
        identity.append(element('small', '', [person.role, person.email].filter(Boolean).join(' · ')));
        card.append(identity);
        if (!['revoked', 'declined'].includes(person.status)) {
          const remove = element('button', 'post-event-contributor-remove', 'Remove');
          remove.type = 'button';
          remove.setAttribute('aria-label', `Remove ${person.name || 'contributor'}`);
          remove.addEventListener('click', async () => {
            busy(remove, true, 'Removing…');
            try {
              await request(`${endpoint}/${encodeURIComponent(person.id)}`, { method: 'PATCH', body: { revoked: true } });
              onChange?.();
              await refresh();
              feedback('post-event-contributors-status', 'Introduction removed. Their invitation can no longer be used.');
            } catch (error) { feedback('post-event-contributors-error', error.message || 'Could not remove this introduction.'); }
            finally { busy(remove, false); }
          });
          card.append(remove);
        }
        if (person.status === 'approved') {
          const label = element('label', 'post-event-contributor-selection');
          const input = element('input');
          input.type = 'checkbox';
          input.checked = person.selected;
          input.addEventListener('change', async () => {
            const previous = person.selected;
            input.disabled = true;
            const update = request(`${endpoint}/${encodeURIComponent(person.id)}`, { method: 'PATCH', body: { selected: input.checked } });
            selectionWrites.add(update);
            try {
              await update;
              person.selected = input.checked;
              onChange?.();
              feedback('post-event-contributors-error', '');
            } catch (error) {
              input.checked = previous;
              feedback('post-event-contributors-error', error.message || 'Could not update the spotlight.');
            } finally { selectionWrites.delete(update); input.disabled = false; }
          });
          label.append(input, element('span', '', 'Include their approved spotlight in this thank-you'));
          card.append(label);
        } else {
          const statusCopy = {
            invited: person.invitationSentAt
              ? 'Invited · Waiting for their approval. Your thank-you can go ahead without them.'
              : 'Invitation saved · The email has not been delivered. Retry the invitation below.',
            declined: 'Declined · This person will not appear in the thank-you.',
            revoked: 'Removed · This invitation is no longer active.'
          };
          card.append(element('p', 'post-event-contributor-status', statusCopy[person.status]));
          if (person.status === 'invited' && !person.invitationSentAt) {
            const retry = element('button', 'post-event-contributor-retry', 'Retry invitation email');
            retry.type = 'button';
            retry.addEventListener('click', async () => {
              busy(retry, true, 'Retrying…');
              feedback('post-event-contributors-error', '');
              try {
                const result = await request(endpoint, { method: 'POST', body: {
                  name: person.name, email: person.email, role: person.role
                } });
                await refresh();
                feedback('post-event-contributors-status', result.invitationSent === false
                  ? 'The invitation is saved, but its email could not be delivered. You can retry here later.'
                  : 'Invitation email sent. No guests were contacted.');
              } catch (error) { feedback('post-event-contributors-error', error.message || 'The invitation email could not be sent.'); }
              finally { busy(retry, false); }
            });
            card.append(retry);
          }
        }
        list.append(card);
      }
      const filled = records.filter(person => !['revoked', 'declined'].includes(person.status)).length >= max;
      byId('post-event-contributor-invite-fields').hidden = filled;
      byId('post-event-contributors-limit').hidden = !filled;
      const suggestions = Array.isArray(result.suggestions) ? result.suggestions : [];
      const suggestionList = byId('post-event-contributor-suggestion-list');
      suggestionList.replaceChildren();
      for (const suggestion of suggestions.slice(0, 8)) {
        const name = String(suggestion.name || suggestion.artistName || '');
        if (!name) continue;
        const button = element('button', 'post-event-contributor-suggestion', name);
        button.type = 'button';
        button.addEventListener('click', () => {
          byId('post-event-contributor-name').value = name;
          byId('post-event-contributor-role').value = String(suggestion.role || 'Artist');
          byId('post-event-contributor-email').focus();
        });
        suggestionList.append(button);
      }
      byId('post-event-contributor-suggestions').hidden = filled || !suggestionList.childElementCount;
      byId('post-event-contributors-loading').hidden = true;
    }

    async function refresh() {
      if (refreshing) return refreshing;
      refreshing = (async () => {
        try {
          render(await request(endpoint));
          feedback('post-event-contributors-error', '');
        } catch (error) {
          byId('post-event-contributors-loading').hidden = true;
          feedback('post-event-contributors-error', error.message || 'Introductions could not load. You can still preview your thank-you.');
        } finally { refreshing = null; }
      })();
      return refreshing;
    }

    byId('post-event-contributors-refresh').addEventListener('click', refresh);
    byId('post-event-contributor-invite-form')?.addEventListener('submit', event => {
      event.preventDefault();
      byId('post-event-contributor-invite').click();
    });
    byId('post-event-contributor-invite').addEventListener('click', async () => {
      const fields = ['name', 'email', 'role'].map(key => byId(`post-event-contributor-${key}`));
      for (const field of fields) {
        field.setCustomValidity(field.value.trim() ? '' : 'Add this information before sending their invitation.');
        if (!field.reportValidity()) return;
      }
      const button = byId('post-event-contributor-invite');
      busy(button, true, 'Sending invitation…');
      feedback('post-event-contributors-error', '');
      feedback('post-event-contributors-status', '');
      try {
        const result = await request(endpoint, { method: 'POST', body: {
          name: fields[0].value.trim(), email: fields[1].value.trim(), role: fields[2].value.trim()
        } });
        onChange?.();
        await refresh();
        if (result.invitationSent === false) {
          feedback('post-event-contributors-status', 'Invitation saved, but the email was not delivered. Try again with the same details. No guests were contacted.');
        } else {
          fields.forEach(field => { field.value = ''; field.setCustomValidity(''); });
          feedback('post-event-contributors-status', 'Invitation sent to your contributor. No guests were contacted.');
        }
      } catch (error) { feedback('post-event-contributors-error', error.message || 'The invitation could not be sent.'); }
      finally { busy(button, false); }
    });
    for (const key of ['name', 'email', 'role']) {
      byId(`post-event-contributor-${key}`).addEventListener('input', event => event.target.setCustomValidity(''));
    }
    return {
      refresh,
      async preparePreview() {
        await Promise.allSettled([...selectionWrites]);
        if (refreshing) await refreshing;
        await refresh();
      }
    };
  }

  async function intake(request, token) {
    const endpoint = `/api/contributors/intake/${encodeURIComponent(token)}`;
    const form = document.getElementById('contributor-intake-form');
    let approved = false;
    let approvalVersion = APPROVAL_VERSION;
    function approvalBody() {
      return {
        name: document.getElementById('contributor-name').value.trim(),
        email: document.getElementById('contributor-email').value.trim(),
        role: document.getElementById('contributor-role').value.trim(),
        instagram_handle: document.getElementById('contributor-instagram').value.trim(),
        website_url: document.getElementById('contributor-website').value.trim(),
        approval: document.getElementById('contributor-approval').checked || approved,
        approvalVersion
      };
    }
    function claimAction(result) {
      document.getElementById('contributor-claim-retry').hidden = !approved
        || result.claimRequired === false || result.claimEmailSent !== false;
    }
    try {
      const result = await request(endpoint);
      const person = result.contributor || result;
      approvalVersion = result.approvalVersion || APPROVAL_VERSION;
      if (result.approvalText) text('contributor-approval-text', result.approvalText);
      text('contributor-invitation-heading', `${result.hostName || 'Your host'} would love to introduce your work.`);
      text('contributor-invitation-copy', `You helped make ${result.eventTitle || 'their event'} special. Add your introduction, then choose whether to be included.`);
      for (const [id, key] of [['name', 'name'], ['email', 'email'], ['role', 'role'], ['instagram', 'instagramHandle'], ['website', 'websiteUrl']]) {
        document.getElementById(`contributor-${id}`).value = person[key] || '';
      }
      paintPhoto('contributor-intake-photo', person.photoUrl, person.name);
      approved = person.status === 'approved' || result.approved === true;
      if (approved) {
        feedback('contributor-status', result.claimRequired === false
          ? 'Your introduction is already approved, and your page is claimed.'
          : result.claimEmailSent === false
            ? 'Your introduction is approved, but the claim email has not been sent. Use “Retry claim email” below. No information needs to be entered again.'
            : 'Your introduction is already approved. It is ready for the host’s thank-you. Check your email for the secure link to claim your page.');
        form.hidden = true;
        document.getElementById('contributor-intake-success').hidden = false;
        const link = document.getElementById('contributor-view-page');
        link.href = safeLink(result.profileUrl || person.profileUrl) || '#';
      } else form.hidden = false;
      claimAction(result);
      document.getElementById('contributor-decline').hidden = false;
      document.getElementById('contributor-decline-note').hidden = false;
      document.getElementById('contributor-loading').hidden = true;
    } catch (error) {
      document.getElementById('contributor-loading').hidden = true;
      feedback('contributor-error', error.message || 'This invitation is unavailable. Ask the host for a new invitation.');
      return;
    }

    document.getElementById('contributor-claim-retry').addEventListener('click', async event => {
      const button = event.currentTarget;
      busy(button, true, 'Retrying claim email…');
      feedback('contributor-error', '');
      try {
        const result = await request(endpoint, { method: 'POST', body: approvalBody() });
        claimAction(result);
        feedback('contributor-status', result.claimRequired === false
          ? 'Your page is already claimed. You can open it below.'
          : result.claimEmailSent
            ? 'Your secure claim email is ready. Check the invitation email inbox to claim this same prepared page.'
            : 'Your introduction is still approved, but the claim email could not be sent. You can retry here later.');
      } catch (error) { feedback('contributor-error', error.message || 'The claim email could not be sent. Your approved introduction is safe.'); }
      finally { busy(button, false); }
    });

    document.getElementById('contributor-decline').addEventListener('click', async event => {
      const button = event.currentTarget;
      busy(button, true, 'Withdrawing your spotlight…');
      feedback('contributor-error', '');
      try {
        await request(endpoint, { method: 'DELETE' });
        approved = true;
        form.hidden = true;
        document.getElementById('contributor-intake-success').hidden = true;
        document.getElementById('contributor-decline-note').hidden = true;
        document.getElementById('contributor-claim-retry').hidden = true;
        button.hidden = true;
        text('contributor-invitation-heading', 'Your choice is respected.');
        text('contributor-invitation-copy', 'This introduction has been withdrawn. No account or further action is needed.');
        feedback('contributor-status', 'Your spotlight will not be included in future thank-you sends. Emails already sent cannot be recalled.');
      } catch (error) { feedback('contributor-error', error.message || 'Your spotlight could not be withdrawn. Please try again.'); }
      finally { busy(button, false); }
    });

    document.getElementById('contributor-photo-button').addEventListener('click', () => {
      document.getElementById('contributor-photo-file').click();
    });
    document.getElementById('contributor-photo-file').addEventListener('change', async event => {
      const file = event.target.files?.[0];
      if (!file || approved) return;
      const allowed = new Set(['image/jpeg', 'image/png', 'image/webp']);
      if (!allowed.has(file.type) || file.size > 5 * 1024 * 1024) {
        feedback('contributor-error', 'Choose a JPG, PNG, or WebP image up to 5 MB.');
        event.target.value = '';
        return;
      }
      const button = document.getElementById('contributor-photo-button');
      const submit = document.getElementById('contributor-approve');
      busy(button, true, 'Uploading…');
      submit.disabled = true;
      feedback('contributor-error', '');
      try {
        const data = new FormData();
        data.append('image', file);
        // The shared JSON helper cannot serialize multipart image bodies.
        const response = await fetch(`${endpoint}/photo`, { method: 'POST', credentials: 'same-origin', body: data });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(result.message || result.error || 'Your photo could not upload.');
        paintPhoto('contributor-intake-photo', result.url, document.getElementById('contributor-name').value);
        feedback('contributor-status', 'Photo uploaded. Review your information before approving the spotlight.');
      } catch (error) { feedback('contributor-error', error.message || 'Your photo could not upload. You can continue without one.'); }
      finally { busy(button, false); submit.disabled = false; event.target.value = ''; }
    });

    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (!form.reportValidity() || approved) return;
      const button = document.getElementById('contributor-approve');
      busy(button, true, 'Approving your introduction…');
      feedback('contributor-error', '');
      try {
        const result = await request(endpoint, { method: 'POST', body: approvalBody() });
        approved = true;
        form.hidden = true;
        document.getElementById('contributor-intake-success').hidden = false;
        document.getElementById('contributor-view-page').href = safeLink(result.profileUrl) || '#';
        claimAction(result);
        feedback('contributor-status', result.claimRequired === false
          ? 'Your introduction is approved, and your page is already claimed. You can open it below.'
          : result.claimEmailSent
            ? 'Your introduction is approved. Check your email to verify ownership and claim this same page—nothing to fill out again.'
            : 'Your introduction is approved, but the claim email could not be sent. Use “Retry claim email” below—nothing to fill out again.');
        document.getElementById('contributor-intake-success').focus({ preventScroll: true });
      } catch (error) { feedback('contributor-error', error.message || 'Your introduction could not be approved. Please try again.'); }
      finally { busy(button, false); }
    });
  }

  async function publicProfile(request, slug) {
    const profileEndpoint = `/api/people/${encodeURIComponent(slug)}`;
    const intro = new URLSearchParams(window.location.search).get('intro');
    if (intro !== null && !/^[A-Za-z0-9_-]{16,64}$/.test(intro)) {
      document.getElementById('contributor-loading').hidden = true;
      feedback('contributor-error', 'This introduction link is not valid. Open the link from your event email again.');
      return;
    }
    const attribution = intro ? `?intro=${encodeURIComponent(intro)}` : '';
    const endpoint = `${profileEndpoint}${attribution}`;
    const followEndpoint = `${profileEndpoint}/follow${attribution}`;
    let state;
    const action = document.getElementById('contributor-follow-button');
    const consent = document.getElementById('contributor-follow-consent');
    async function refresh() {
      state = await request(endpoint);
      const profile = state.profile || {};
      document.title = `${profile.name || 'Meet the contributor'} — Silver Glider Events`;
      text('contributor-public-name', profile.name || 'Meet the contributor');
      text('contributor-public-role', profile.role || 'Part of a good night');
      paintPhoto('contributor-public-photo', profile.photoUrl, profile.name);
      const links = document.getElementById('contributor-public-links');
      links.replaceChildren();
      const instagram = String(profile.instagramHandle || '').replace(/^@/, '');
      if (/^[a-zA-Z0-9_.]{1,30}$/.test(instagram)) {
        const link = element('a', 'contributor-social-link', `Instagram · @${instagram}`);
        link.href = `https://www.instagram.com/${encodeURIComponent(instagram)}/`;
        link.target = '_blank'; link.rel = 'noopener noreferrer';
        links.append(link);
      }
      const website = safeLink(profile.websiteUrl);
      if (website) {
        const link = element('a', 'contributor-social-link', 'Visit website ↗');
        link.href = website; link.target = '_blank'; link.rel = 'noopener noreferrer';
        links.append(link);
      }
      const following = Boolean(state.following || state.pending);
      text('contributor-follow-copy', followMessage(state));
      text('contributor-follow-consent-text', `Email me about future events from ${profile.name || 'this person'}. Unsubscribe anytime.`);
      action.textContent = following ? 'Unfollow' : state.signedIn ? 'Follow their work' : 'Sign in to follow';
      action.classList.toggle('sg-btn-ghost', following);
      action.classList.toggle('sg-btn-primary', !following);
      document.getElementById('contributor-follow-consent-label').hidden = following || !state.signedIn;
      consent.checked = false;
      document.getElementById('contributor-public-unclaimed').hidden = Boolean(profile.claimed);
      const hostLink = document.getElementById('contributor-host-page');
      const hostUrl = safeLink(profile.profileUrl);
      hostLink.hidden = !profile.claimed || !hostUrl;
      if (hostUrl) hostLink.href = hostUrl;
      document.getElementById('contributor-public-content').hidden = false;
      document.getElementById('contributor-loading').hidden = true;
    }
    try { await refresh(); }
    catch (error) {
      document.getElementById('contributor-loading').hidden = true;
      feedback('contributor-error', error.message || 'This page is not available.');
      return;
    }
    action.addEventListener('click', async () => {
      feedback('contributor-error', '');
      if (!state.signedIn) {
        window.location.assign(`/login?next=${encodeURIComponent(`${window.location.pathname}${window.location.search}`)}`);
        return;
      }
      const following = Boolean(state.following || state.pending);
      if (!following && !consent.checked) {
        feedback('contributor-error', 'Choose the email permission above if you would like to follow.');
        consent.focus();
        return;
      }
      busy(action, true, following ? 'Unfollowing…' : 'Following…');
      try {
        await request(followEndpoint, following
          ? { method: 'DELETE' }
          : { method: 'POST', body: { emailConsent: true, consentVersion: state.consentVersion || FOLLOW_VERSION } });
        await refresh();
      } catch (error) { feedback('contributor-error', error.message || 'Your follow could not be updated.'); }
      finally { action.disabled = false; action.removeAttribute('aria-busy'); }
    });
  }

  async function claim(request, id) {
    const endpoint = `/api/contributors/claim/${encodeURIComponent(id)}`;
    let context;
    const button = document.getElementById('contributor-claim-button');
    function renderClaimed(result) {
      const count = Math.max(0, Number(result.followersCount) || 0);
      text('contributor-claim-heading', 'Your page. Your next chapter.');
      text('contributor-claim-copy', count
        ? `${count.toLocaleString('en-US')} ${count === 1 ? 'person' : 'people'}${result.eventTitle ? ` from ${result.eventTitle}` : ''} chose to follow your work. Give them something to look forward to.`
        : 'Your introduction is ready. Share your page, make it yours, and give people something to look forward to.');
      document.getElementById('contributor-claim-ready').hidden = false;
      document.getElementById('contributor-claim-prompt').hidden = true;
      const page = document.getElementById('contributor-claimed-page');
      page.href = safeLink(result.profileUrl) || '/settings/host-page';
      feedback('contributor-status', 'Your page is claimed. Only people who chose to follow are connected—no event guest list was subscribed.');
    }
    try {
      context = await request(endpoint);
      text('contributor-claim-heading', 'Make this page yours.');
      text('contributor-claim-copy', context.hostName
        ? `${context.hostName} introduced your work. You’ve verified your email; claim the page you already prepared, with no repeated form.`
        : 'You’ve verified your email. Claim the page you already prepared, with no repeated form.');
      document.getElementById('contributor-loading').hidden = true;
      if (context.claimed) renderClaimed(context);
      else document.getElementById('contributor-claim-prompt').hidden = false;
    } catch (error) {
      document.getElementById('contributor-loading').hidden = true;
      feedback('contributor-error', error.message || 'This claim is not available to this account. Sign in using the email that received the invitation.');
      return;
    }
    button.addEventListener('click', async () => {
      busy(button, true, 'Claiming your page…');
      feedback('contributor-error', '');
      try { renderClaimed(await request(endpoint, { method: 'POST', body: {} })); }
      catch (error) { feedback('contributor-error', error.message || 'Your page could not be claimed. Please try again.'); }
      finally { busy(button, false); }
    });
  }

  function boot() {
    const page = document.body?.dataset.contributorPage;
    if (!page || typeof api !== 'function') return;
    const parts = window.location.pathname.split('/').filter(Boolean);
    const id = parts[parts.length - 1] || '';
    if (page === 'intake') intake(api, id);
    else if (page === 'public') publicProfile(api, id);
    else if (page === 'claim') claim(api, id);
  }

  return { APPROVAL_VERSION, FOLLOW_VERSION, safeLink, normalizeContributor, followMessage, createHost, boot };
});
