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
  if (!res.ok) {
    const error = new Error(data.message || data.error || 'Request failed');
    error.code = data.error || 'request_failed';
    error.status = res.status;
    error.data = data;
    throw error;
  }
  return data;
}

function sgEscapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function sgSafeHttpUrl(value) {
  try {
    const candidate = String(value || '').trim();
    if (!candidate) return '';
    const url = new URL(candidate, location.origin);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
  } catch (_) {
    return '';
  }
}

function sgAccountDisplayName(organizer) {
  return String(organizer?.name || organizer?.org_name || organizer?.email || 'Account').trim();
}

function sgAccountInitials(organizer) {
  return sgAccountDisplayName(organizer).split(/\s+/).slice(0, 2).map(part => part[0] || '').join('').toUpperCase() || 'SG';
}

// Paints a photo-or-initials avatar: <span data-sg-avatar><span data-sg-initials></span><img hidden></span>
function sgPaintAvatar(el, organizer) {
  const initials = el.querySelector('[data-sg-initials]');
  const image = el.querySelector('img');
  if (initials) initials.textContent = sgAccountInitials(organizer);
  const url = sgSafeHttpUrl(organizer?.avatar_url);
  if (image && url) {
    image.hidden = true;
    if (initials) initials.hidden = false;
    image.onload = () => {
      image.hidden = false;
      if (initials) initials.hidden = true;
    };
    image.onerror = () => {
      image.removeAttribute('src');
      image.hidden = true;
      if (initials) initials.hidden = false;
    };
    image.src = url;
  } else if (image) {
    image.onload = null;
    image.onerror = null;
    image.removeAttribute('src');
    image.hidden = true;
    if (initials) initials.hidden = false;
  }
}

let sgCurrentAccount = null;

function updateNavAccount(organizer) {
  if (organizer) {
    // Merge: some responses (e.g. a photo upload) carry only part of the account.
    sgCurrentAccount = sgCurrentAccount && sgCurrentAccount.id === organizer.id ? { ...sgCurrentAccount, ...organizer } : organizer;
    document.querySelectorAll('[data-sg-avatar]').forEach(el => sgPaintAvatar(el, sgCurrentAccount));
    document.querySelectorAll('[data-sg-name]').forEach(el => { el.textContent = sgAccountDisplayName(sgCurrentAccount); });
    // The menu can be opened before the account request finishes. Hydrate every
    // value as soon as the response arrives instead of requiring a close/reopen.
    if (menuSheet) fillMenuSheet(menuSheet, sgCurrentAccount);
  }
  const menu = document.querySelector('.sg-account-menu');
  if (!menu || !organizer) return;
  const account = sgCurrentAccount || organizer;
  const displayName = String(account.name || account.org_name || account.email || 'Account').trim();
  const initials = displayName.split(/\s+/).slice(0, 2).map(part => part[0] || '').join('').toUpperCase() || 'SG';
  const name = menu.querySelector('.sg-account-menu-name');
  const plan = menu.querySelector('.sg-account-menu-plan');
  const fallback = menu.querySelector('.sg-account-avatar-fallback');
  const image = menu.querySelector('.sg-account-avatar-image');
  name.textContent = displayName;
  plan.textContent = `${account.plan === 'pro' ? 'Pro' : 'Free'} plan`;
  fallback.textContent = initials;
  if (account.avatar_url) {
    image.src = account.avatar_url;
    image.hidden = false;
    fallback.hidden = true;
  } else {
    image.removeAttribute('src');
    image.hidden = true;
    fallback.hidden = false;
  }
}

function renderNav(active) {
  const el = document.getElementById('nav');
  if (!el) return;
  const links = [
    ['dashboard', '/dashboard', 'Home'],
    ['events', '/events', 'My Events'],
    ['following', '/following', 'Following'],
    ['settings', '/settings', 'Settings']
  ];
  el.className = 'sg-nav';
  // On phones, signed-in pages keep Feedback and the legal links inside this menu
  // instead of a floating pill and a footer below every screen.
  document.body.classList.add('sg-app-page');
  el.innerHTML = `
    <a class="sg-nav-brand" href="/dashboard">Silver Glider <span>Events</span></a>
    <div class="sg-nav-links">
      ${links.map(([key, href, label]) =>
        `<a href="${href}" class="${key === active ? 'active' : ''}${key === 'settings' ? ' sg-nav-settings-link' : ''}">${label}</a>`).join('')}
      <button class="sg-nav-feedback" type="button">Send feedback</button>
      <p class="sg-nav-legal"><a href="/privacy">Privacy</a><span aria-hidden="true">·</span><a href="/terms">Terms</a></p>
    </div>
    <div class="sg-nav-actions">
      <div class="sg-account-menu">
        <button class="sg-account-avatar" type="button" aria-label="Open account menu" aria-expanded="false" aria-haspopup="menu">
          <span class="sg-account-avatar-fallback" aria-hidden="true">SG</span>
          <img class="sg-account-avatar-image" alt="" hidden>
        </button>
        <div class="sg-account-popover" role="menu" hidden>
          <div class="sg-account-menu-identity">
            <strong class="sg-account-menu-name">Account</strong>
            <span class="sg-account-menu-plan">Free plan</span>
          </div>
          <a href="/profile" role="menuitem">Profile</a>
          <a href="/settings/account" role="menuitem">Settings</a>
          <button class="sg-account-menu-signout" type="button" role="menuitem">Sign out</button>
        </div>
      </div>
      <button class="sg-nav-toggle" type="button" aria-label="Open menu" aria-expanded="false">
        <span></span><span></span><span></span>
      </button>
    </div>`;

  const toggle = el.querySelector('.sg-nav-toggle');
  const accountButton = el.querySelector('.sg-account-avatar');
  const accountPopover = el.querySelector('.sg-account-popover');
  const closeAccountMenu = () => {
    accountPopover.hidden = true;
    accountButton.setAttribute('aria-expanded', 'false');
    accountButton.setAttribute('aria-label', 'Open account menu');
  };
  const closeMenu = () => {
    el.classList.remove('open');
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-label', 'Open menu');
  };

  toggle.addEventListener('click', () => {
    if (usesMenuSheet()) {
      openMenuSheet(toggle);
      return;
    }
    closeAccountMenu();
    const isOpen = el.classList.toggle('open');
    toggle.setAttribute('aria-expanded', String(isOpen));
    toggle.setAttribute('aria-label', isOpen ? 'Close menu' : 'Open menu');
  });
  accountButton.addEventListener('click', () => {
    closeMenu();
    const willOpen = accountPopover.hidden;
    accountPopover.hidden = !willOpen;
    accountButton.setAttribute('aria-expanded', String(willOpen));
    accountButton.setAttribute('aria-label', willOpen ? 'Close account menu' : 'Open account menu');
  });
  el.querySelector('.sg-nav-links').addEventListener('click', e => {
    if (e.target.closest('a')) closeMenu();
  });
  el.querySelector('.sg-nav-feedback').addEventListener('click', () => {
    closeMenu();
    document.getElementById('feedback-bubble')?.click();
  });
  document.addEventListener('click', e => {
    if (!el.contains(e.target)) {
      closeMenu();
      closeAccountMenu();
    } else if (!e.target.closest('.sg-account-menu')) {
      closeAccountMenu();
    }
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      closeMenu();
      closeAccountMenu();
    }
  });
  el.querySelector('.sg-account-menu-signout').addEventListener('click', async () => {
    try { await api('/api/auth/logout', { method: 'POST' }); } catch (_) {}
    window.location.href = '/login';
  });

  api('/api/auth/me').then(({ organizer }) => updateNavAccount(organizer)).catch(() => {});
  // The tab bar belongs only to the four top-level destinations. Focused
  // create, edit, manage, and Settings detail screens reuse the same nav key
  // but keep their own back navigation and bottom action docks.
  if (topLevelTabForPath(window.location.pathname) === active) mountTabBar(active);
}

// Phones: Home, Events, Create, Hosts and You sit in a bottom tab bar, within
// thumb reach. The ☰ then opens a full-screen menu panel instead of the dropdown.
const TAB_BAR_KEYS = ['dashboard', 'events', 'following', 'profile', 'settings'];
const TAB_BAR_TABS = [
  ['dashboard', '/dashboard', 'Home', '<path d="M3 11.5 12 4l9 7.5"/><path d="M5.5 10v10h13V10"/><path d="M10 20v-5h4v5"/>'],
  ['events', '/events', 'Events', '<rect x="3.5" y="5" width="17" height="15" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/>'],
  ['create', '/events/new', 'Create', '<rect x="3.5" y="3.5" width="17" height="17" rx="5"/><path d="M12 8v8M8 12h8"/>'],
  ['following', '/following', 'Hosts', '<circle cx="9" cy="8" r="3.2"/><path d="M3.5 19.5a5.5 5.5 0 0 1 11 0"/><path d="M15.5 5.2a3 3 0 0 1 0 5.6M17 14.2a5 5 0 0 1 3.5 5.3"/>'],
  ['profile', '/profile', 'You', null]
];

// Settings is reached from the ☰ panel, not a tab, but its top-level screen
// still shows the bar (with no tab highlighted).
function topLevelTabForPath(pathname) {
  const normalized = String(pathname || '').replace(/\/+$/, '') || '/';
  if (normalized === '/settings') return 'settings';
  const tab = TAB_BAR_TABS.find(([, href]) => href === normalized)?.[0] || null;
  return TAB_BAR_KEYS.includes(tab) ? tab : null;
}

function mountTabBar(active) {
  if (document.querySelector('.sg-tab-bar')) return;
  const bar = document.createElement('nav');
  bar.className = 'sg-tab-bar';
  bar.setAttribute('aria-label', 'Main');
  bar.innerHTML = TAB_BAR_TABS.map(([key, href, label, icon]) => {
    const glyph = icon
      ? `<svg viewBox="0 0 24 24" aria-hidden="true">${icon}</svg>`
      : '<span class="sg-tab-avatar" data-sg-avatar aria-hidden="true"><span data-sg-initials>SG</span><img alt="" hidden></span>';
    return `<a class="sg-tab sg-tab-${key}" href="${href}"${key === active ? ' aria-current="page"' : ''}>${glyph}<span>${label}</span></a>`;
  }).join('');
  document.body.appendChild(bar);
  document.body.classList.add('has-tab-bar');
  if (sgCurrentAccount) updateNavAccount(sgCurrentAccount);
}

const menuSheetMedia = window.matchMedia('(max-width: 879px)');
function usesMenuSheet() {
  return document.body.classList.contains('has-tab-bar') && menuSheetMedia.matches;
}

const MENU_ICONS = {
  host: '<path d="M4 20V9l8-5 8 5v11"/><path d="M9 20v-6h6v6"/>',
  messaging: '<path d="M4 5h16v11H9l-5 4z"/>',
  feedback: '<path d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z"/><path d="M8.5 10h.01M15.5 10h.01M8.5 14.5c1.9 1.6 5.1 1.6 7 0"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/>',
  admin: '<path d="M12 3 4 6v6c0 4.5 3.4 8.3 8 9 4.6-.7 8-4.5 8-9V6z"/>',
  signout: '<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3"/><path d="M10 16l-4-4 4-4M6 12h10"/>'
};
const menuIcon = name => `<svg class="sg-menu-icon" viewBox="0 0 24 24" aria-hidden="true">${MENU_ICONS[name]}</svg>`;

let menuSheet = null;
let menuSheetReturnFocus = null;
let menuSheetArtLoaded = false;

function buildMenuSheet() {
  const sheet = document.createElement('div');
  sheet.className = 'sg-menu-sheet';
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-modal', 'true');
  sheet.setAttribute('aria-label', 'Menu');
  sheet.hidden = true;
  sheet.innerHTML = `
    <div class="sg-menu-sheet-inner">
      <button class="sg-menu-close" type="button" aria-label="Close menu"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg></button>
      <a class="sg-menu-profile" href="/profile">
        <span class="sg-menu-avatar" data-sg-avatar aria-hidden="true"><span data-sg-initials>SG</span><img alt="" hidden></span>
        <span class="sg-menu-profile-copy"><strong data-sg-name>Account</strong><small>See your profile</small></span>
        <span class="sg-menu-chevron" aria-hidden="true">›</span>
      </a>
      <a class="sg-menu-new" href="/events/new">
        <span class="sg-menu-new-label"><span aria-hidden="true">+</span> New event</span>
        <span class="sg-menu-new-art" aria-hidden="true" hidden><img alt=""></span>
      </a>
      <div class="sg-menu-group">
        <a class="sg-menu-row" data-menu-host href="/settings/host-page">${menuIcon('host')}<span>Host page</span><span class="sg-menu-value" data-menu-host-value></span></a>
        <a class="sg-menu-row" href="/settings/messaging">${menuIcon('messaging')}<span>Messaging</span><span class="sg-menu-value" data-menu-credits></span></a>
        <button class="sg-menu-row" type="button" data-menu-feedback>${menuIcon('feedback')}<span>Send feedback</span></button>
      </div>
      <div class="sg-menu-group">
        <a class="sg-menu-row" href="/settings">${menuIcon('settings')}<span>Settings</span></a>
      </div>
      <div class="sg-menu-group" data-menu-admin hidden></div>
      <div class="sg-menu-group">
        <button class="sg-menu-row" type="button" data-menu-signout>${menuIcon('signout')}<span>Sign out</span></button>
      </div>
      <p class="sg-menu-legal"><a href="/privacy">Privacy Policy</a><span aria-hidden="true">·</span><a href="/terms">Terms</a></p>
    </div>`;
  document.body.appendChild(sheet);

  sheet.querySelector('.sg-menu-close').addEventListener('click', closeMenuSheet);
  sheet.querySelector('[data-menu-feedback]').addEventListener('click', () => {
    closeMenuSheet();
    document.getElementById('feedback-bubble')?.click();
  });
  sheet.querySelector('[data-menu-signout]').addEventListener('click', async () => {
    try { await api('/api/auth/logout', { method: 'POST' }); } catch (_) {}
    window.location.href = '/login';
  });
  sheet.addEventListener('keydown', event => {
    if (event.key === 'Escape') closeMenuSheet();
    if (event.key !== 'Tab') return;
    const focusable = [...sheet.querySelectorAll('a[href],button:not([disabled])')].filter(el => el.offsetParent);
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });
  return sheet;
}

function fillMenuSheet(sheet, organizer) {
  if (!organizer) return;
  sheet.querySelectorAll('[data-sg-avatar]').forEach(el => sgPaintAvatar(el, organizer));
  sheet.querySelector('[data-sg-name]').textContent = sgAccountDisplayName(organizer);
  const host = sheet.querySelector('[data-menu-host]');
  if (organizer.public_slug) {
    host.href = `/h/${encodeURIComponent(organizer.public_slug)}`;
    sheet.querySelector('[data-menu-host-value]').textContent = 'View';
  } else {
    host.href = '/settings/host-page';
    sheet.querySelector('[data-menu-host-value]').textContent = 'Set up';
  }
  const credits = Number(organizer.sms_credits) || 0;
  sheet.querySelector('[data-menu-credits]').textContent = `${credits.toLocaleString('en-US')} credit${credits === 1 ? '' : 's'}`;
  const admin = sheet.querySelector('[data-menu-admin]');
  admin.hidden = !organizer.is_admin;
  // One row; the admin pages have their own section tabs.
  if (organizer.is_admin && !admin.children.length) {
    admin.innerHTML = `<a class="sg-menu-row" href="/admin/hosts">${menuIcon('admin')}<span>Admin</span></a>`;
  }
}

// The New event card shows the host's latest artwork, so it feels like theirs.
function loadMenuSheetArt(sheet) {
  if (menuSheetArtLoaded) return;
  menuSheetArtLoaded = true;
  api('/api/events').then(({ events }) => {
    const artworkUrls = (events || []).map(ev => sgSafeHttpUrl(
      ev.presentation_mode === 'flyer'
        ? (ev.flyer_image_url || ev.cover_image_url)
        : (ev.cover_image_url || ev.flyer_image_url)
    )).filter(Boolean);
    if (!artworkUrls.length) return;
    const art = sheet.querySelector('.sg-menu-new-art');
    const image = art.querySelector('img');
    const tryArtwork = () => {
      const url = artworkUrls.shift();
      if (!url) {
        art.hidden = true;
        image.removeAttribute('src');
        return;
      }
      image.onload = () => { art.hidden = false; };
      image.onerror = () => {
        art.hidden = true;
        image.removeAttribute('src');
        tryArtwork();
      };
      image.src = url;
    };
    tryArtwork();
  }).catch(() => {});
}

function openMenuSheet(trigger) {
  menuSheet = menuSheet || buildMenuSheet();
  menuSheetReturnFocus = trigger || null;
  fillMenuSheet(menuSheet, sgCurrentAccount);
  loadMenuSheetArt(menuSheet);
  menuSheet.hidden = false;
  document.documentElement.classList.add('sg-menu-sheet-open');
  if (trigger) trigger.setAttribute('aria-expanded', 'true');
  requestAnimationFrame(() => {
    menuSheet.classList.add('open');
    menuSheet.querySelector('.sg-menu-close').focus();
  });
}

function closeMenuSheet() {
  if (!menuSheet || menuSheet.hidden) return;
  menuSheet.classList.remove('open');
  document.documentElement.classList.remove('sg-menu-sheet-open');
  if (menuSheetReturnFocus) {
    menuSheetReturnFocus.setAttribute('aria-expanded', 'false');
    menuSheetReturnFocus.focus();
  }
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  setTimeout(() => { if (!menuSheet.classList.contains('open')) menuSheet.hidden = true; }, reduced ? 0 : 220);
}
menuSheetMedia.addEventListener('change', () => { if (!menuSheetMedia.matches) closeMenuSheet(); });

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
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  el.setAttribute('aria-atomic', 'true');
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
    const bubble = document.getElementById('feedback-bubble');
    // On phones the bubble is hidden and Feedback opens from the menu.
    const focusTarget = [bubble, document.querySelector('.sg-legal-feedback'), document.querySelector('.sg-nav-toggle')]
      .find(candidate => {
        if (!candidate || candidate.hidden || !candidate.getClientRects().length) return false;
        const style = window.getComputedStyle(candidate);
        return style.display !== 'none' && style.visibility !== 'hidden';
      }) || bubble;
    focusTarget?.focus();
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
