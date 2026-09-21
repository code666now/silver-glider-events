(function createAdminStepUp() {
  let active = null;

  function ensureDialog() {
    let dialog = document.getElementById('admin-step-up-dialog');
    if (dialog) return dialog;
    dialog = document.createElement('dialog');
    dialog.className = 'admin-step-up-dialog';
    dialog.id = 'admin-step-up-dialog';
    dialog.setAttribute('aria-labelledby', 'admin-step-up-title');
    dialog.setAttribute('aria-describedby', 'admin-step-up-copy');
    dialog.innerHTML = `
      <article class="admin-step-up-card">
        <p class="admin-step-up-eyebrow">Security check</p>
        <h2 id="admin-step-up-title">Confirm it’s you</h2>
        <p class="admin-step-up-copy" id="admin-step-up-copy">Enter the six-digit code sent to your administrator email.</p>
        <form id="admin-step-up-form">
          <div class="sg-field">
            <label for="admin-step-up-code">Confirmation code</label>
            <input class="sg-input admin-step-up-code" id="admin-step-up-code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required>
          </div>
          <p class="admin-step-up-status" id="admin-step-up-status" role="status" aria-live="polite"></p>
          <div class="admin-step-up-actions">
            <button class="sg-btn sg-btn-ghost" id="admin-step-up-cancel" type="button">Cancel</button>
            <button class="sg-btn sg-btn-primary" id="admin-step-up-submit" type="submit">Verify</button>
          </div>
        </form>
      </article>`;
    document.body.appendChild(dialog);

    dialog.querySelector('#admin-step-up-cancel').addEventListener('click', () => dialog.close('cancel'));
    dialog.addEventListener('cancel', event => {
      event.preventDefault();
      dialog.close('cancel');
    });
    dialog.addEventListener('close', () => {
      if (!active) return;
      const pending = active;
      active = null;
      pending.returnFocus?.focus();
      if (dialog.returnValue !== 'verified') {
        const error = new Error('Verification cancelled');
        error.code = 'step_up_cancelled';
        pending.reject(error);
      }
    });
    dialog.querySelector('#admin-step-up-form').addEventListener('submit', async event => {
      event.preventDefault();
      if (!active) return;
      const code = dialog.querySelector('#admin-step-up-code').value.replace(/\D/g, '').slice(0, 6);
      const status = dialog.querySelector('#admin-step-up-status');
      const submit = dialog.querySelector('#admin-step-up-submit');
      status.classList.remove('error');
      if (code.length !== 6) {
        status.textContent = 'Enter the six-digit code.';
        status.classList.add('error');
        return;
      }
      submit.disabled = true;
      submit.textContent = 'Verifying…';
      try {
        const result = await api('/api/admin/auth/step-up/complete', { method: 'POST', body: { code } });
        const pending = active;
        active = null;
        dialog.close('verified');
        pending.returnFocus?.focus();
        pending.resolve(result);
      } catch (error) {
        status.textContent = error.message || 'That code could not be verified.';
        status.classList.add('error');
        dialog.querySelector('#admin-step-up-code').select();
      } finally {
        submit.disabled = false;
        submit.textContent = 'Verify';
      }
    });
    return dialog;
  }

  async function run({ action, targetUserId = null, targetKey = null, title = 'Confirm it’s you', description = '' } = {}) {
    if (active) throw new Error('Another verification is already open');
    const dialog = ensureDialog();
    const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.querySelector('#admin-step-up-title').textContent = title;
    dialog.querySelector('#admin-step-up-copy').textContent = description || 'Enter the six-digit code sent to your administrator email.';
    dialog.querySelector('#admin-step-up-code').value = '';
    const status = dialog.querySelector('#admin-step-up-status');
    status.textContent = 'Sending a fresh code…';
    status.classList.remove('error');
    dialog.showModal();

    const promise = new Promise((resolve, reject) => { active = { resolve, reject, returnFocus }; });
    try {
      const body = { action };
      if (targetUserId != null) body.targetUserId = Number(targetUserId);
      if (targetKey) body.targetKey = String(targetKey);
      const result = await api('/api/admin/auth/step-up/start', { method: 'POST', body });
      status.textContent = result.maskedEmail
        ? `Code sent to ${result.maskedEmail}.`
        : 'Code sent to your administrator email.';
      requestAnimationFrame(() => dialog.querySelector('#admin-step-up-code').focus());
    } catch (error) {
      const pending = active;
      active = null;
      dialog.close('error');
      pending?.reject(error);
    }
    return promise;
  }

  window.adminStepUp = { run };
})();
