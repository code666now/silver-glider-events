(function mountAdminShell() {
  const path = window.location.pathname.replace(/\/+$/, '') || '/admin';
  if (!path.startsWith('/admin') || path === '/admin/login') return;

  const sectionByPath = {
    '/admin': 'overview',
    '/admin/accounts': 'accounts',
    '/admin/done-for-you': 'done-for-you',
    '/admin/hosts': 'hosts',
    '/admin/events': 'events',
    '/admin/ticketing': 'ticketing',
    '/admin/feedback': 'feedback',
    '/admin/invitations': 'invitations',
    '/admin/team': 'team'
  };
  const links = [
    ['overview', '/admin', 'Overview'],
    ['accounts', '/admin/accounts', 'Accounts'],
    ['done-for-you', '/admin/done-for-you', 'Done For You'],
    ['hosts', '/admin/hosts', 'Hosts'],
    ['events', '/admin/events', 'Events'],
    ['ticketing', '/admin/ticketing', 'Ticketing'],
    ['feedback', '/admin/feedback', 'Feedback'],
    ['invitations', '/admin/invitations', 'Invitations'],
    ['team', '/admin/team', 'Team']
  ];

  const root = document.getElementById('nav')?.parentElement;
  if (!root || root.dataset.adminShellMounted === 'true') return;
  root.dataset.adminShellMounted = 'true';
  root.classList.add('admin-shell-root');

  const active = root.dataset.adminSection || document.body.dataset.adminSection || sectionByPath[path] || '';
  root.querySelector('.admin-section-nav')?.remove();

  const layout = document.createElement('div');
  layout.className = 'admin-shell-layout';
  const sidebar = document.createElement('aside');
  sidebar.className = 'admin-sidebar';
  sidebar.setAttribute('aria-label', 'Admin workspace');
  sidebar.innerHTML = `
    <span class="admin-sidebar-label">Workspace</span>
    <nav class="admin-sidebar-links">
      ${links.map(([key, href, label]) => `<a class="admin-sidebar-link" data-admin-link="${key}" href="${href}"${key === active ? ' aria-current="page"' : ''}${key === 'team' || key === 'done-for-you' ? ' hidden' : ''}>${label}</a>`).join('')}
    </nav>`;

  const content = document.createElement('div');
  content.className = 'admin-shell-main';
  const topNav = document.getElementById('nav');
  [...root.childNodes].forEach(node => {
    if (node !== topNav && node !== layout) content.appendChild(node);
  });
  layout.append(sidebar, content);
  root.appendChild(layout);

  if (window.matchMedia('(max-width: 960px)').matches) {
    sidebar.querySelector('[aria-current="page"]')?.scrollIntoView({
      block: 'nearest', inline: 'center', behavior: 'auto'
    });
  }

  const sessionRequest = typeof getAdminSession === 'function'
    ? getAdminSession()
    : Promise.reject(new Error('Admin session helper is unavailable'));
  window.adminShellSession = sessionRequest.then(data => {
    const operator = data?.operator || {};
    const capabilities = data?.capabilities || {};
    const canManageOperators = capabilities.manageOperators === true;
    const teamLink = sidebar.querySelector('[data-admin-link="team"]');
    if (teamLink) teamLink.hidden = !canManageOperators;
    const canManageDoneForYou = capabilities.manageDoneForYou === true;
    const doneForYouLink = sidebar.querySelector('[data-admin-link="done-for-you"]');
    if (doneForYouLink) doneForYouLink.hidden = !canManageDoneForYou;
    const detail = { data, operator, capabilities: { ...capabilities, manageOperators: canManageOperators, manageDoneForYou: canManageDoneForYou } };
    window.dispatchEvent(new CustomEvent('admin-shell:ready', { detail }));
    return detail;
  }).catch(error => {
    window.dispatchEvent(new CustomEvent('admin-shell:error', { detail: { error } }));
    return { error, operator: {}, capabilities: { manageOperators: false } };
  });
})();
