(function mountLegalFooter() {
  function mount() {
    if (document.querySelector('[data-sg-legal-footer]')) return;
    const footer = document.createElement('footer');
    footer.className = 'sg-global-footer';
    footer.setAttribute('data-sg-legal-footer', '');
    footer.setAttribute('aria-label', 'Legal');
    footer.innerHTML = `
      <nav class="sg-legal-links" aria-label="Legal links">
        <a class="sg-legal-link" href="/privacy">Privacy Policy</a>
        <span aria-hidden="true">·</span>
        <a class="sg-legal-link" href="/terms">Terms</a>
      </nav>
      <p>© ${new Date().getFullYear()} Silver Glider Entertainment Inc.</p>`;
    document.body.appendChild(footer);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
