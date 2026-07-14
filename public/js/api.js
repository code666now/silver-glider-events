/* Shared fetch helper + app shell for organizer pages */

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  if (res.status === 401) {
    const returnTo = `${location.pathname}${location.search}`;
    window.location.href = `/login?next=${encodeURIComponent(returnTo)}`;
    throw new Error('Not signed in');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function renderNav(active) {
  const el = document.getElementById('nav');
  if (!el) return;
  const links = [
    ['dashboard', '/dashboard', 'Home'],
    ['events', '/events', 'My Events'],
    ['settings', '/settings', 'Settings']
  ];
  el.className = 'sg-nav';
  el.innerHTML = `
    <a class="sg-nav-brand" href="/dashboard">Silver Glider <span>Events</span></a>
    <button class="sg-nav-toggle" type="button" aria-label="Open menu" aria-expanded="false">
      <span></span><span></span><span></span>
    </button>
    <div class="sg-nav-links">
      ${links.map(([key, href, label]) =>
        `<a href="${href}" class="${key === active ? 'active' : ''}">${label}</a>`).join('')}
    </div>`;

  const toggle = el.querySelector('.sg-nav-toggle');
  const closeMenu = () => {
    el.classList.remove('open');
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-label', 'Open menu');
  };

  toggle.addEventListener('click', () => {
    const isOpen = el.classList.toggle('open');
    toggle.setAttribute('aria-expanded', String(isOpen));
    toggle.setAttribute('aria-label', isOpen ? 'Close menu' : 'Open menu');
  });
  el.querySelector('.sg-nav-links').addEventListener('click', e => {
    if (e.target.closest('a')) closeMenu();
  });
  document.addEventListener('click', e => {
    if (!el.contains(e.target)) closeMenu();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeMenu();
  });
}

// Inject the moving aurora background behind the page (once).
function mountAurora() {
  if (document.querySelector('.sg-aurora')) return;
  const aurora = document.createElement('div');
  aurora.className = 'sg-aurora';
  aurora.setAttribute('aria-hidden', 'true');
  const veil = document.createElement('div');
  veil.className = 'sg-aurora-veil';
  veil.setAttribute('aria-hidden', 'true');
  document.body.prepend(veil);
  document.body.prepend(aurora);
}
if (document.readyState !== 'loading') mountAurora();
else document.addEventListener('DOMContentLoaded', mountAurora);

let _toastTimer;
function toast(msg) {
  let el = document.querySelector('.sg-toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'sg-toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  requestAnimationFrame(() => el.classList.add('show'));
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

function mountFeedbackBubble() {
  if (document.getElementById('feedback-bubble')) return;
  const draftKey = 'sge_feedback_draft';
  const root = document.createElement('div');
  root.id = 'feedback-widget';
  root.innerHTML = `
    <button class="feedback-bubble" id="feedback-bubble" type="button">Feedback</button>
    <div class="feedback-modal" id="feedback-modal" aria-hidden="true">
      <div class="feedback-modal-card" role="dialog" aria-modal="true" aria-labelledby="feedback-title">
        <div class="feedback-modal-head">
          <div><h2 id="feedback-title">Send feedback</h2><p>Found a bug or have an idea? Let us know.</p></div>
          <button class="feedback-modal-close" id="feedback-close" type="button" aria-label="Close feedback form">×</button>
        </div>
        <form id="feedback-form">
          <div class="sg-field">
            <label for="feedback-type">Type</label>
            <select class="sg-select" id="feedback-type" required>
              <option value="bug">Bug</option>
              <option value="suggestion">Suggestion</option>
              <option value="other">Other</option>
            </select>
          </div>
          <div class="sg-field">
            <label for="feedback-message">Message</label>
            <textarea class="sg-textarea" id="feedback-message" maxlength="4000" required placeholder="What happened, or what would make this better?"></textarea>
          </div>
          <p class="feedback-form-error" id="feedback-error"></p>
          <button class="sg-btn sg-btn-primary sg-btn-block" id="feedback-submit" type="submit">Submit feedback</button>
        </form>
      </div>
    </div>`;
  document.body.appendChild(root);

  const modal = document.getElementById('feedback-modal');
  const type = document.getElementById('feedback-type');
  const message = document.getElementById('feedback-message');
  const error = document.getElementById('feedback-error');
  const submit = document.getElementById('feedback-submit');
  let restoredDraft = false;

  function currentPath() { return `${location.pathname}${location.search}`; }
  function currentEventId() {
    const pathMatch = location.pathname.match(/^\/events\/(\d+)(?:\/|$)/);
    if (pathMatch) return Number(pathMatch[1]);
    if (location.pathname === '/events/new') {
      const id = Number(new URLSearchParams(location.search).get('id'));
      return Number.isInteger(id) && id > 0 ? id : null;
    }
    return null;
  }
  function openFeedback() {
    modal.classList.add('open');
    modal.setAttribute('aria-hidden', 'false');
    setTimeout(() => message.focus(), 0);
  }
  function closeFeedback() {
    modal.classList.remove('open');
    modal.setAttribute('aria-hidden', 'true');
    if (restoredDraft) {
      localStorage.removeItem(draftKey);
      restoredDraft = false;
    }
    document.getElementById('feedback-bubble').focus();
  }

  document.getElementById('feedback-bubble').addEventListener('click', openFeedback);
  document.getElementById('feedback-close').addEventListener('click', closeFeedback);
  modal.addEventListener('click', e => { if (e.target === modal) closeFeedback(); });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && modal.classList.contains('open')) closeFeedback();
  });

  document.getElementById('feedback-form').addEventListener('submit', async e => {
    e.preventDefault();
    error.style.display = 'none';
    const body = {
      type: type.value,
      message: message.value.trim(),
      page_url: location.href,
      route: location.pathname,
      event_id: currentEventId()
    };
    localStorage.setItem(draftKey, JSON.stringify({ ...body, returnTo: currentPath() }));
    submit.disabled = true;
    submit.textContent = 'Submitting…';
    try {
      await api('/api/feedback', { method: 'POST', body });
      localStorage.removeItem(draftKey);
      restoredDraft = false;
      message.value = '';
      type.value = 'bug';
      closeFeedback();
      toast('Feedback sent. Thank you.');
    } catch (err) {
      error.textContent = err.message;
      error.style.display = 'block';
    } finally {
      submit.disabled = false;
      submit.textContent = 'Submit feedback';
    }
  });

  try {
    const saved = JSON.parse(localStorage.getItem(draftKey) || 'null');
    if (saved && saved.returnTo === currentPath()) {
      type.value = ['bug', 'suggestion', 'other'].includes(saved.type) ? saved.type : 'bug';
      message.value = String(saved.message || '').slice(0, 4000);
      restoredDraft = true;
      openFeedback();
    }
  } catch (_) {
    localStorage.removeItem(draftKey);
  }
}

if (document.readyState !== 'loading') mountFeedbackBubble();
else document.addEventListener('DOMContentLoaded', mountFeedbackBubble);
