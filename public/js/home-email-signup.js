/* Public homepage signup for Silver Glider Recs. */

(() => {
  function initializeSilverGliderForms() {
    document.querySelectorAll('[data-sg-email-signup]').forEach(root => {
      if (root.dataset.sgReady === 'true') return;
      root.dataset.sgReady = 'true';

      const form = root.querySelector('.sg-recs-form');
      const button = root.querySelector('.sg-recs-submit');
      const buttonLabel = root.querySelector('[data-sg-button-label]');
      const status = root.querySelector('[data-sg-status]');
      const endpoint = root.dataset.endpoint;
      if (!form || !button || !buttonLabel || !status || !endpoint) return;

      const defaultButtonText = buttonLabel.textContent;
      const showStatus = (message, kind = 'success') => {
        status.textContent = message;
        status.dataset.kind = kind;
      };

      form.addEventListener('input', () => {
        if (status.dataset.kind === 'error') showStatus('');
      });

      form.addEventListener('submit', async event => {
        event.preventDefault();
        if (!form.reportValidity()) return;

        const fields = new FormData(form);
        button.disabled = true;
        buttonLabel.textContent = 'JOINING\u2026';
        root.setAttribute('aria-busy', 'true');
        showStatus('');

        const controller = new AbortController();
        const timeout = window.setTimeout(() => controller.abort(), 12000);

        try {
          const response = await fetch(endpoint, {
            method: 'POST',
            mode: 'cors',
            credentials: 'omit',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({
              email: String(fields.get('email') || '').trim(),
              audience: String(fields.get('audience') || ''),
              consent: true,
              website: String(fields.get('website') || '')
            }),
            signal: controller.signal
          });
          const result = await response.json().catch(() => ({}));
          if (!response.ok) {
            throw new Error(response.status === 429
              ? 'Too many attempts. Please wait and try again.'
              : result.error || 'We couldn\u2019t add you right now. Please try again.');
          }
          form.reset();
          showStatus(result.message || "Check your good ol' email to confirm!");
        } catch (error) {
          showStatus(error.name === 'AbortError'
            ? 'Signup took too long. Please try again.'
            : error.message || 'We couldn\u2019t add you right now. Please try again.', 'error');
        } finally {
          window.clearTimeout(timeout);
          button.disabled = false;
          buttonLabel.textContent = defaultButtonText;
          root.removeAttribute('aria-busy');
        }
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeSilverGliderForms, { once: true });
  } else {
    initializeSilverGliderForms();
  }
})();
