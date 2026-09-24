/* Shared fetch helper + app shell for organizer pages */

function sgIsAdminEditorPath(pathname = location.pathname) {
  const normalized = String(pathname || '').replace(/\/+$/, '') || '/';
  return normalized === '/admin-editor' || normalized.startsWith('/admin-editor/');
}

function sgIsAdminPath(pathname = location.pathname) {
  const normalized = String(pathname || '').replace(/\/+$/, '') || '/';
  return normalized === '/admin' || normalized.startsWith('/admin/') || sgIsAdminEditorPath(normalized);
}

function sgRequestPath(path) {
  if (!sgIsAdminEditorPath() || typeof path !== 'string' || !path.startsWith('/api/')) return path;
  return `/admin-editor${path}`;
}

function sgAdminEditorRecoveryPath() {
  return '/admin/done-for-you';
}

async function api(path, opts = {}) {
  const res = await fetch(sgRequestPath(path), {
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  if (res.status === 401) {
    if (sgIsAdminEditorPath()) {
      window.location.replace(sgAdminEditorRecoveryPath());
      const error = new Error('Admin editor workspace is no longer available');
      error.status = 401;
      error.code = 'admin_editor_workspace_unavailable';
      throw error;
    }
    const returnTo = `${location.pathname}${location.search}`;
    const login = sgIsAdminPath() ? '/admin/login' : '/login';
    window.location.href = `${login}?next=${encodeURIComponent(returnTo)}`;
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

let sgAdminSessionPromise = null;

function getAdminSession({ force = false } = {}) {
  if (force) sgAdminSessionPromise = null;
  if (!sgAdminSessionPromise) {
    sgAdminSessionPromise = api('/api/admin/auth/me').catch(error => {
      sgAdminSessionPromise = null;
      throw error;
    });
  }
  return sgAdminSessionPromise;
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
  if (!organizer) return;
  const account = sgCurrentAccount || organizer;
  const displayName = String(account.name || account.org_name || account.email || 'Account').trim();
  document.querySelectorAll('.sg-account-menu').forEach(menu => {
    const name = menu.querySelector('.sg-account-menu-name');
    const plan = menu.querySelector('.sg-account-menu-plan');
    if (name) name.textContent = displayName;
    if (plan) plan.textContent = `${account.plan === 'pro' ? 'Pro' : 'Free'} plan`;
  });
  document.querySelectorAll('[data-sg-account-host]').forEach(link => {
    const label = link.querySelector('[data-sg-account-host-label]');
    if (account.public_slug) {
      link.href = `/h/${encodeURIComponent(account.public_slug)}`;
      if (label) label.textContent = 'Host Page';
    } else {
      link.href = '/settings/host-page';
      if (label) label.textContent = 'Create Host Page';
    }
  });
}

function sgAccountMenuMarkup(idPrefix = 'sg-account') {
  const popoverId = `${idPrefix}-popover`;
  return `
    <div class="sg-account-menu">
      <button class="sg-account-trigger" type="button" aria-label="Open account menu" aria-expanded="false" aria-haspopup="menu" aria-controls="${popoverId}">
        <span class="sg-account-avatar" data-sg-avatar aria-hidden="true"><span class="sg-account-avatar-fallback" data-sg-initials>SG</span><img class="sg-account-avatar-image" alt="" hidden></span>
        <span class="sg-account-trigger-name" data-sg-name>Account</span>
        <svg class="sg-account-trigger-chevron" viewBox="0 0 20 20" aria-hidden="true"><path d="m6 8 4 4 4-4"/></svg>
      </button>
      <div class="sg-account-popover" id="${popoverId}" role="menu" hidden>
        <div class="sg-account-menu-identity">
          <strong class="sg-account-menu-name">Account</strong>
          <span class="sg-account-menu-plan">Free plan</span>
        </div>
        <div class="sg-account-popover-group">
          <a href="/dashboard" role="menuitem">${menuIcon('dashboard')}<span>Dashboard</span></a>
          <a href="/events" role="menuitem">${menuIcon('events')}<span>My Events</span></a>
          <a class="sg-account-menu-create" href="/events/new" role="menuitem">${menuIcon('create')}<span>Create Event</span></a>
          <a href="/following" role="menuitem">${menuIcon('following')}<span>Hosts</span></a>
        </div>
        <div class="sg-account-popover-group">
          <a data-sg-account-host href="/settings/host-page" role="menuitem">${menuIcon('host')}<span data-sg-account-host-label>Create Host Page</span></a>
          <a href="/settings/messaging" role="menuitem">${menuIcon('messaging')}<span>Messaging</span></a>
        </div>
        <div class="sg-account-popover-group">
          <a href="/profile" role="menuitem">${menuIcon('profile')}<span>Profile</span></a>
          <a href="/settings" role="menuitem">${menuIcon('settings')}<span>Settings</span></a>
          <button type="button" role="menuitem" data-sg-account-feedback>${menuIcon('feedback')}<span>Send feedback</span></button>
        </div>
        <div class="sg-account-popover-group" data-sg-account-admin hidden>
          <a href="/admin" role="menuitem">${menuIcon('admin')}<span>Admin</span></a>
        </div>
        <div class="sg-account-popover-group sg-account-popover-signout">
          <button class="sg-account-menu-signout" type="button" role="menuitem">${menuIcon('signout')}<span>Sign out</span></button>
        </div>
      </div>
    </div>`;
}

function bindAccountMenu(menu, { beforeOpen, signOutDestination = '/login' } = {}) {
  if (!menu) return { close() {} };
  const trigger = menu.querySelector('.sg-account-trigger');
  const popover = menu.querySelector('.sg-account-popover');
  const visibleItems = () => [...popover.querySelectorAll('[role="menuitem"]')]
    .filter(item => !item.hidden && !item.closest('[hidden]'));
  const close = ({ restoreFocus = false } = {}) => {
    if (popover.hidden) return;
    popover.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    trigger.setAttribute('aria-label', 'Open account menu');
    if (restoreFocus) trigger.focus();
  };
  const open = () => {
    beforeOpen?.();
    popover.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    trigger.setAttribute('aria-label', 'Close account menu');
  };
  trigger.addEventListener('click', () => {
    if (popover.hidden) open();
    else close();
  });
  trigger.addEventListener('keydown', event => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    if (popover.hidden) open();
    const items = visibleItems();
    const target = event.key === 'ArrowDown' ? items[0] : items[items.length - 1];
    target?.focus();
  });
  popover.addEventListener('keydown', event => {
    const items = visibleItems();
    const index = items.indexOf(document.activeElement);
    let target = null;
    if (event.key === 'ArrowDown') target = items[(index + 1 + items.length) % items.length];
    else if (event.key === 'ArrowUp') target = items[(index - 1 + items.length) % items.length];
    else if (event.key === 'Home') target = items[0];
    else if (event.key === 'End') target = items[items.length - 1];
    else if (event.key === 'Escape') {
      event.preventDefault();
      close({ restoreFocus: true });
      return;
    }
    if (target) {
      event.preventDefault();
      target.focus();
    }
  });
  document.addEventListener('click', event => {
    if (!menu.contains(event.target)) close();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !popover.hidden) close({ restoreFocus: true });
  });
  menuSheetMedia.addEventListener('change', event => {
    const hadMenuFocus = menu.contains(document.activeElement);
    close();
    if (!hadMenuFocus || !event.matches) return;
    const mobileTrigger = document.querySelector('.sg-home-menu-toggle, .sg-nav-toggle');
    requestAnimationFrame(() => {
      if (mobileTrigger?.getClientRects().length) mobileTrigger.focus();
    });
  });
  menu.querySelector('[data-sg-account-feedback]')?.addEventListener('click', () => {
    close();
    document.getElementById('feedback-bubble')?.click();
  });
  menu.querySelector('.sg-account-menu-signout')?.addEventListener('click', async () => {
    try { await api('/api/auth/logout', { method: 'POST' }); } catch (_) {}
    window.location.href = signOutDestination;
  });
  return { close };
}

let sgAdminAccess = null;
let sgAdminAccessPromise = null;

function sgApplyAdminAccess(hasAccess) {
  sgAdminAccess = Boolean(hasAccess);
  document.querySelectorAll('[data-sg-account-admin], [data-menu-admin]').forEach(group => {
    group.hidden = !sgAdminAccess;
  });
}

function sgLoadAdminAccess() {
  if (!sgAdminAccessPromise) {
    sgAdminAccessPromise = fetch('/api/admin/auth/me', {
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { Accept: 'application/json' }
    }).then(response => response.ok).catch(() => false).then(hasAccess => {
      sgApplyAdminAccess(hasAccess);
      return hasAccess;
    });
  }
  return sgAdminAccessPromise;
}

function renderNav(active) {
  const el = document.getElementById('nav');
  if (!el) return;
  if (sgIsAdminEditorPath()) {
    renderAdminEditorNav(el);
    return;
  }
  if (sgIsAdminPath()) {
    renderAdminNav(el);
    return;
  }
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
      ${sgAccountMenuMarkup('sg-app-account')}
      <button class="sg-nav-toggle" type="button" aria-label="Open menu" aria-expanded="false">
        <span></span><span></span><span></span>
      </button>
    </div>`;

  const toggle = el.querySelector('.sg-nav-toggle');
  const closeMenu = () => {
    el.classList.remove('open');
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-label', 'Open menu');
  };
  const accountMenu = bindAccountMenu(el.querySelector('.sg-account-menu'), { beforeOpen: closeMenu });

  toggle.addEventListener('click', () => {
    if (usesMenuSheet()) {
      openMenuSheet(toggle);
      return;
    }
    accountMenu.close();
    const isOpen = el.classList.toggle('open');
    toggle.setAttribute('aria-expanded', String(isOpen));
    toggle.setAttribute('aria-label', isOpen ? 'Close menu' : 'Open menu');
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
    }
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      closeMenu();
    }
  });

  api('/api/auth/me').then(({ organizer }) => updateNavAccount(organizer)).catch(() => {});
  sgLoadAdminAccess();
  // The tab bar belongs only to the four top-level destinations. Focused
  // create, edit, manage, and Settings detail screens reuse the same nav key
  // but keep their own back navigation and bottom action docks.
  if (topLevelTabForPath(window.location.pathname) === active) mountTabBar(active);
}

async function sgExitAdminEditorWorkspace() {
  const beforeExit = new CustomEvent('sg:admin-editor-before-exit', { cancelable: true });
  if (!document.dispatchEvent(beforeExit)) return false;
  try {
    const result = await api('/admin-editor/api/workspace/exit', { method: 'POST' });
    window.location.href = result.redirect || sgAdminEditorRecoveryPath();
    return true;
  } catch (error) {
    if ([401, 403, 404, 409].includes(error.status)) {
      window.location.replace(sgAdminEditorRecoveryPath());
      return true;
    }
    throw error;
  }
}

function renderAdminEditorNav(el) {
  el.className = 'sg-nav sg-admin-editor-nav';
  document.body.classList.add('sg-app-page', 'sg-admin-page', 'sg-admin-editor-page');
  el.innerHTML = `
    <span class="sg-nav-brand">Silver Glider <span>Admin</span></span>
    <div class="sg-nav-actions">
      <span class="sg-admin-operator" data-admin-editor-context>Done For You event</span>
      <button class="sg-btn sg-btn-ghost sg-admin-signout" type="button" data-admin-editor-exit>Exit setup</button>
    </div>`;

  const exitButton = el.querySelector('[data-admin-editor-exit]');
  exitButton.addEventListener('click', async () => {
    exitButton.disabled = true;
    exitButton.textContent = 'Exiting…';
    try {
      const exiting = await sgExitAdminEditorWorkspace();
      if (exiting === false) {
        exitButton.disabled = false;
        exitButton.textContent = 'Exit setup';
      }
    } catch (error) {
      exitButton.disabled = false;
      exitButton.textContent = 'Exit setup';
      if (error.status !== 401) toast(error.message || 'Could not exit event setup');
    }
  });

  const paintMobileContext = text => {
    document.querySelectorAll('[data-admin-editor-mobile-context]').forEach(context => {
      context.textContent = text;
      context.hidden = false;
    });
  };
  paintMobileContext('Done For You');
  api('/admin-editor/api/workspace').then(({ host }) => {
    const hostName = String(host?.name || host?.org_name || '').trim();
    if (hostName) {
      el.querySelector('[data-admin-editor-context]').textContent = `Done For You · ${hostName}`;
      paintMobileContext(`For ${hostName}`);
    }
  }).catch(() => {});
}

function renderAdminNav(el) {
  el.className = 'sg-nav';
  document.body.classList.add('sg-app-page', 'sg-admin-page');
  el.innerHTML = `
    <a class="sg-nav-brand" href="/admin">Silver Glider <span>Admin</span></a>
    <div class="sg-nav-actions">
      <span class="sg-admin-operator" data-admin-operator>Admin operator</span>
      <button class="sg-btn sg-btn-ghost sg-admin-signout" type="button">Sign out</button>
    </div>`;
  const label = el.querySelector('[data-admin-operator]');
  el.querySelector('.sg-admin-signout').addEventListener('click', async () => {
    try { await api('/api/admin/auth/logout', { method:'POST' }); } catch (_) {}
    window.location.href = '/admin/login';
  });
  getAdminSession().then(({ operator }) => {
    const role = operator.role === 'super_admin' ? 'Super Admin' : 'Support';
    label.textContent = `${operator.email} · ${role}`;
  }).catch(() => {});
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
  dashboard: '<path d="M3 11.5 12 4l9 7.5"/><path d="M5.5 10v10h13V10"/><path d="M10 20v-5h4v5"/>',
  events: '<rect x="3.5" y="5" width="17" height="15" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  create: '<rect x="3.5" y="3.5" width="17" height="17" rx="5"/><path d="M12 8v8M8 12h8"/>',
  following: '<circle cx="9" cy="8" r="3.2"/><path d="M3.5 19.5a5.5 5.5 0 0 1 11 0"/><path d="M15.5 5.2a3 3 0 0 1 0 5.6M17 14.2a5 5 0 0 1 3.5 5.3"/>',
  host: '<path d="M4 20V9l8-5 8 5v11"/><path d="M9 20v-6h6v6"/>',
  messaging: '<path d="M4 5h16v11H9l-5 4z"/>',
  profile: '<circle cx="12" cy="8" r="4"/><path d="M4.5 21a7.5 7.5 0 0 1 15 0"/>',
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
  const homePrimaryLinks = document.body.classList.contains('sg-home-page')
    ? `<div class="sg-menu-group sg-menu-primary-group">
        <a class="sg-menu-row" href="/dashboard">${menuIcon('dashboard')}<span>Dashboard</span></a>
        <a class="sg-menu-row" href="/events">${menuIcon('events')}<span>My Events</span></a>
        <a class="sg-menu-row" href="/following">${menuIcon('following')}<span>Hosts</span></a>
      </div>`
    : '';
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
      ${homePrimaryLinks}
      <div class="sg-menu-group">
        <a class="sg-menu-row" data-menu-host href="/settings/host-page">${menuIcon('host')}<span>Host page</span><span class="sg-menu-value" data-menu-host-value></span></a>
        <a class="sg-menu-row" href="/settings/messaging">${menuIcon('messaging')}<span>Messaging</span><span class="sg-menu-value" data-menu-credits></span></a>
        <button class="sg-menu-row" type="button" data-menu-feedback>${menuIcon('feedback')}<span>Send feedback</span></button>
      </div>
      <div class="sg-menu-group">
        <a class="sg-menu-row" href="/settings">${menuIcon('settings')}<span>Settings</span></a>
      </div>
      <div class="sg-menu-group" data-menu-admin hidden><a class="sg-menu-row" href="/admin">${menuIcon('admin')}<span>Admin</span></a></div>
      <div class="sg-menu-group">
        <button class="sg-menu-row" type="button" data-menu-signout>${menuIcon('signout')}<span>Sign out</span></button>
      </div>
      <p class="sg-menu-legal"><a href="/privacy">Privacy Policy</a><span aria-hidden="true">·</span><a href="/terms">Terms</a></p>
    </div>`;
  document.body.appendChild(sheet);
  sgApplyAdminAccess(sgAdminAccess === true);

  sheet.querySelector('.sg-menu-close').addEventListener('click', closeMenuSheet);
  sheet.querySelector('[data-menu-feedback]').addEventListener('click', () => {
    closeMenuSheet();
    document.getElementById('feedback-bubble')?.click();
  });
  sheet.querySelector('[data-menu-signout]').addEventListener('click', async () => {
    try { await api('/api/auth/logout', { method: 'POST' }); } catch (_) {}
    window.location.href = document.body.classList.contains('sg-home-page') ? '/' : '/login';
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
    const visibleReturnFocus = menuSheetReturnFocus.getClientRects().length ? menuSheetReturnFocus : null;
    const desktopTrigger = document.querySelector('.sg-account-trigger');
    const visibleDesktopTrigger = desktopTrigger?.getClientRects().length ? desktopTrigger : null;
    const focusTarget = visibleReturnFocus || visibleDesktopTrigger;
    requestAnimationFrame(() => {
      if (focusTarget?.getClientRects().length) focusTarget.focus();
    });
  }
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  setTimeout(() => { if (!menuSheet.classList.contains('open')) menuSheet.hidden = true; }, reduced ? 0 : 220);
}
menuSheetMedia.addEventListener('change', () => { if (!menuSheetMedia.matches) closeMenuSheet(); });

// Inject the moving aurora background behind the page (once).
function mountAurora() {
  if (document.querySelector('.sg-aurora, .aurora')) return;
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
  if (sgIsAdminEditorPath()) return;
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
    const focusTarget = [bubble, document.querySelector('.sg-legal-feedback'), document.querySelector('.sg-nav-toggle'), document.querySelector('.sg-account-trigger')]
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

function autoMountFeedbackBubble() {
  if (!document.body.classList.contains('sg-home-page')) mountFeedbackBubble();
}
if (document.readyState !== 'loading') autoMountFeedbackBubble();
else document.addEventListener('DOMContentLoaded', autoMountFeedbackBubble);
