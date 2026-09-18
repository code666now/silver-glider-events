(function mountLegalFooter() {
  function mount() {
    if (document.querySelector('[data-sg-legal-footer]')) return;
    const eventPageMount = document.querySelector('#event-data')
      ? (document.querySelector('.col-details .wrap') || document.querySelector('.flyer-details'))
      : null;
    const footer = document.createElement('footer');
    footer.className = eventPageMount
      ? 'sg-global-footer sg-event-legal-footer'
      : 'sg-global-footer';
    footer.setAttribute('data-sg-legal-footer', '');
    footer.setAttribute('aria-label', 'Legal');
    const appPage = document.body.classList.contains('sg-app-page');
    footer.innerHTML = `
      <nav class="sg-legal-links" aria-label="Legal links">
        ${appPage ? '<button class="sg-legal-feedback" type="button">Send feedback</button><span class="sg-legal-feedback-separator" aria-hidden="true">·</span>' : ''}
        <a class="sg-legal-link" href="/privacy">Privacy Policy</a>
        <span aria-hidden="true">·</span>
        <a class="sg-legal-link" href="/terms">Terms</a>
      </nav>
      ${eventPageMount ? '' : `<p>© ${new Date().getFullYear()} Silver Glider Entertainment Inc.</p>`}`;
    (eventPageMount || document.body).appendChild(footer);
    footer.querySelector('.sg-legal-feedback')?.addEventListener('click', () => {
      document.getElementById('feedback-bubble')?.click();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
