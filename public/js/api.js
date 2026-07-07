/* Shared fetch helper + app shell for organizer pages */

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  if (res.status === 401) {
    window.location.href = '/login';
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
    <div class="sg-nav-links">
      ${links.map(([key, href, label]) =>
        `<a href="${href}" class="${key === active ? 'active' : ''}">${label}</a>`).join('')}
    </div>`;
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
