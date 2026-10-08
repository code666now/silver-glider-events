(function initFlyerPreview() {
  const tools = document.getElementById('flyer-preview-tools');
  const dialog = document.getElementById('flyer-preview-dialog');
  const body = document.getElementById('flyer-preview-dialog-body');
  if (!tools || !dialog || !body) return;

  let payload = null;
  const escapeHtml = value => String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');

  async function request(path, options = {}) {
    const response = await fetch(path, {
      credentials: 'same-origin',
      headers: options.body ? { 'content-type': 'application/json' } : undefined,
      ...options,
      body: options.body ? JSON.stringify(options.body) : undefined
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || 'Something went wrong. Try again.');
    return data;
  }

  async function load() {
    if (!payload) payload = await request('/api/flyer-preview');
    return payload;
  }

  function open(html) {
    body.innerHTML = `<div class="flyer-preview-dialog-inner">${html}</div>`;
    if (!dialog.open) dialog.showModal();
  }

  function message(text, error = false) {
    const root = document.getElementById('flyer-preview-message');
    if (!root) return;
    root.textContent = text;
    root.classList.toggle('is-error', error);
  }

  async function showLooks() {
    try {
      const data = await load();
      const options = data.looks.map(option => `<button class="flyer-preview-option${option.key === data.preview.backgroundTheme ? ' is-selected' : ''}" type="button" data-look="${escapeHtml(option.key)}"><strong>${escapeHtml(option.label)}</strong><br><small>${option.group === 'effect' ? 'Effect' : 'Background'}</small></button>`).join('');
      open(`<h2 id="flyer-preview-dialog-title">Change the look</h2><p>Try a background or effect on your real event page. Your flyer and event details stay untouched.</p><div class="flyer-preview-options">${options}</div><p class="flyer-preview-message" id="flyer-preview-message" role="status"></p>`);
      body.querySelectorAll('[data-look]').forEach(button => button.addEventListener('click', async () => {
        body.querySelectorAll('[data-look]').forEach(option => { option.disabled = true; });
        message('Applying the look…');
        try {
          await request('/api/flyer-preview/look', { method: 'POST', body: { backgroundTheme: button.dataset.look } });
          sessionStorage.setItem('sge-reopen-flyer-look', '1');
          location.reload();
        } catch (error) {
          body.querySelectorAll('[data-look]').forEach(option => { option.disabled = false; });
          message(error.message, true);
        }
      }));
    } catch (error) { open(`<h2 id="flyer-preview-dialog-title">Preview unavailable</h2><p>${escapeHtml(error.message)}</p>`); }
  }

  function showFix() {
    open(`<h2 id="flyer-preview-dialog-title">Request a fix</h2><p>Tell us the one thing that needs attention. We’ll update the draft and text you a fresh preview.</p><form id="flyer-preview-fix-form"><label class="flyer-preview-field"><span>What should we change?</span><textarea name="message" maxlength="1000" required placeholder="The venue time should be 8 PM…"></textarea></label><button class="flyer-preview-submit" type="submit">Send request</button><p class="flyer-preview-message" id="flyer-preview-message" role="status"></p></form>`);
    document.getElementById('flyer-preview-fix-form').addEventListener('submit', async event => {
      event.preventDefault();
      const button = event.currentTarget.querySelector('button');
      button.disabled = true;
      try {
        await request('/api/flyer-preview/fix', { method: 'POST', body: { message: new FormData(event.currentTarget).get('message') } });
        location.reload();
      } catch (error) { button.disabled = false; message(error.message, true); }
    });
  }

  async function showApproval() {
    open('<h2 id="flyer-preview-dialog-title">Looks good!</h2><p>We’ll text one verification code to the phone that sent this flyer. This confirms the approval came from the right person.</p><button class="flyer-preview-submit" id="flyer-preview-send-code" type="button">Text me a code</button><p class="flyer-preview-message" id="flyer-preview-message" role="status"></p>');
    document.getElementById('flyer-preview-send-code').addEventListener('click', async event => {
      event.currentTarget.disabled = true;
      message('Sending your code…');
      try {
        const result = await request('/api/flyer-preview/approve/start', { method: 'POST' });
        open(`<h2 id="flyer-preview-dialog-title">Enter the code</h2><p>We sent it to ${escapeHtml(result.phone)}. Approval does not create or sign into an account.</p><form id="flyer-preview-code-form"><label class="flyer-preview-field"><span>Verification code</span><input class="flyer-preview-code" name="code" inputmode="numeric" autocomplete="one-time-code" minlength="4" maxlength="10" required></label><button class="flyer-preview-submit" type="submit">Approve event</button><p class="flyer-preview-message" id="flyer-preview-message" role="status"></p></form>`);
        document.getElementById('flyer-preview-code-form').addEventListener('submit', verifyApproval);
      } catch (error) { event.currentTarget.disabled = false; message(error.message, true); }
    });
  }

  async function verifyApproval(event) {
    event.preventDefault();
    const button = event.currentTarget.querySelector('button');
    button.disabled = true;
    message('Confirming…');
    try {
      await request('/api/flyer-preview/approve/verify', { method: 'POST', body: { code: new FormData(event.currentTarget).get('code') } });
      open('<h2 id="flyer-preview-dialog-title">Approved 🎸</h2><p>Silver Glider has your approval. We’ll publish the page and text you the share link.</p><button class="flyer-preview-submit" type="button" data-preview-close>Back to your page</button>');
      tools.querySelector('.flyer-preview-status p').innerHTML = '<strong>Approved</strong><span>Silver Glider will publish it next.</span>';
      tools.querySelector('.flyer-preview-actions').innerHTML = '';
    } catch (error) { button.disabled = false; message(error.message, true); }
  }

  tools.addEventListener('click', event => {
    const action = event.target.closest('[data-preview-action]')?.dataset.previewAction;
    if (action === 'look') showLooks();
    if (action === 'fix') showFix();
    if (action === 'approve') showApproval();
  });
  document.addEventListener('click', event => {
    if (event.target.closest('[data-preview-close]')) dialog.close();
  });
  dialog.addEventListener('click', event => {
    if (event.target === dialog) dialog.close();
  });
  if (sessionStorage.getItem('sge-reopen-flyer-look') === '1') {
    sessionStorage.removeItem('sge-reopen-flyer-look');
    showLooks();
  }
})();
