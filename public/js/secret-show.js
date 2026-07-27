(() => {
  const form = document.getElementById('secret-form');
  const input = document.getElementById('secret-code');
  const entry = document.getElementById('code-entry');
  const slots = Array.from(document.querySelectorAll('.code-slot'));
  const error = document.getElementById('secret-error');
  const submit = document.getElementById('secret-submit');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function clean(value) {
    return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, slots.length);
  }

  function render() {
    const value = clean(input.value);
    if (input.value !== value) input.value = value;
    slots.forEach((slot, index) => {
      slot.textContent = value[index] || '';
      slot.classList.toggle('filled', index < value.length);
      slot.classList.toggle('active', document.activeElement === input && index === Math.min(value.length, slots.length - 1));
    });
    submit.disabled = value.length !== slots.length;
  }

  entry.addEventListener('click', () => input.focus());
  input.addEventListener('focus', render);
  input.addEventListener('blur', render);
  input.addEventListener('input', () => {
    error.textContent = '';
    render();
  });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    const code = clean(input.value);
    if (code.length !== slots.length) {
      error.textContent = 'Enter the complete six-character code.';
      input.focus();
      return;
    }

    submit.disabled = true;
    submit.textContent = 'CHECKING…';
    error.textContent = '';
    try {
      const slug = location.pathname.split('/').filter(Boolean).pop();
      const response = await fetch(`/api/public/events/${encodeURIComponent(slug)}/unlock`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ code })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'That code does not open this event.');
      document.body.classList.add('unlocking');
      window.setTimeout(() => location.reload(), reduceMotion ? 0 : 520);
    } catch (err) {
      error.textContent = err.message;
      input.value = '';
      submit.textContent = 'UNLOCK EVENT';
      submit.disabled = true;
      render();
      input.focus();
    }
  });

  render();
  window.setTimeout(() => input.focus(), 120);
})();
