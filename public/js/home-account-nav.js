/* Optional account entry point for the public homepage. */

(() => {
  const shell = document.querySelector('[data-home-account-shell]');
  const signIn = document.querySelector('[data-home-signin]');
  const authenticated = document.querySelector('[data-home-authenticated]');
  if (!shell || !signIn || !authenticated) return;

  const finishLoading = () => {
    shell.dataset.loading = 'false';
    shell.removeAttribute('aria-busy');
  };
  const showSignedOut = () => {
    authenticated.hidden = true;
    signIn.hidden = false;
    finishLoading();
  };
  const showSignedIn = organizer => {
    signIn.hidden = true;
    authenticated.innerHTML = `
      ${sgAccountMenuMarkup('sg-home-account', { includePrimaryLinks: true })}
      <div class="sg-home-mobile-controls">
        <a class="sg-home-mobile-profile" href="/profile" aria-label="Open your profile" data-sg-avatar>
          <span data-sg-initials>SG</span><img alt="" hidden>
        </a>
        <button class="sg-nav-toggle sg-home-menu-toggle" type="button" aria-label="Open menu" aria-expanded="false">
          <span></span><span></span><span></span>
        </button>
      </div>`;
    authenticated.hidden = false;
    updateNavAccount(organizer);
    bindAccountMenu(authenticated.querySelector('.sg-account-menu'), { signOutDestination: '/' });
    const menuToggle = authenticated.querySelector('.sg-home-menu-toggle');
    menuToggle.addEventListener('click', () => openMenuSheet(menuToggle));
    mountFeedbackBubble();
    sgLoadAdminAccess();
    finishLoading();
  };

  shell.setAttribute('aria-busy', 'true');
  fetch('/api/auth/me', {
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { Accept: 'application/json' }
  }).then(async response => {
    if (!response.ok) return null;
    const data = await response.json().catch(() => null);
    return data?.organizer || null;
  }).then(organizer => {
    if (organizer) showSignedIn(organizer);
    else showSignedOut();
  }).catch(showSignedOut);
})();
