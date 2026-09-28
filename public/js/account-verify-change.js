(function accountIdentityVerification() {
  const params = new URLSearchParams(window.location.search);
  const token = String(params.get('token') || '').trim();
  if (token) window.history.replaceState({}, '', '/account/verify-change');

  const panels = [
    'identity-verify-loading',
    'identity-verify-email',
    'identity-verify-phone',
    'identity-verify-success',
    'identity-verify-error'
  ];
  let requestState = null;

  function firstValue(object, keys, fallback = null) {
    for (const key of keys) {
      if (object && object[key] !== undefined && object[key] !== null) return object[key];
    }
    return fallback;
  }

  function showPanel(id, focusId = '') {
    panels.forEach(panelId => { document.getElementById(panelId).hidden = panelId !== id; });
    if (focusId) requestAnimationFrame(() => document.getElementById(focusId)?.focus());
  }

  function errorMessage(data, fallback) {
    return String(firstValue(data, ['message', 'error'], fallback));
  }

  async function request(path, options = {}) {
    const response = await fetch(path, {
      method:options.method || 'GET',
      headers:options.body ? { 'Content-Type':'application/json' } : undefined,
      credentials:'same-origin',
      body:options.body ? JSON.stringify(options.body) : undefined
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(errorMessage(data, 'This verification request could not be completed.'));
      error.code = firstValue(data, ['error', 'code'], 'request_failed');
      throw error;
    }
    return data;
  }

  function showTerminalError(message) {
    document.getElementById('identity-error-copy').textContent = message || 'The verification request may have expired, been cancelled, or already been used.';
    showPanel('identity-verify-error', 'identity-error-title');
  }

  function verificationErrorCopy(error) {
    const code = String(error?.code || '').toLowerCase();
    if (code.includes('expired')) return 'This private verification request has expired. Ask support to send a new one.';
    if (code.includes('cancel')) return 'This verification request was cancelled. Ask support to send a new one if the change is still needed.';
    if (code.includes('delivery')) return 'The verification message could not be delivered. Ask support to review the new email or phone and send another request.';
    if (code.includes('conflict') || code.includes('owner')) return 'This email or phone is already connected to another account. Support will need to review it.';
    if (code.includes('not_found') || code.includes('invalid_token') || code.includes('invalid_request') || code.includes('unavailable')) return 'This private verification link is not active. Use the newest link sent to you or ask support to resend it.';
    return error?.message || 'This verification request could not be completed.';
  }

  function isTerminalVerificationError(error) {
    const code = String(error?.code || '').toLowerCase();
    return ['expired', 'cancel', 'conflict', 'owner', 'delivery', 'not_found', 'invalid_token', 'invalid_request', 'unavailable']
      .some(fragment => code.includes(fragment));
  }

  function showSuccess(type) {
    document.getElementById('identity-success-copy').textContent = type === 'phone'
      ? 'The verified mobile number now belongs to the account.'
      : 'The verified email now belongs to the account.';
    showPanel('identity-verify-success', 'identity-success-title');
  }

  function normalizeState(data) {
    return data.identityChangeRequest || data.identity_change_request || data.request || data;
  }

  function stateType(data) {
    return String(firstValue(data, ['type', 'identityType', 'identity_type'], token ? 'email' : 'phone')).toLowerCase() === 'phone'
      ? 'phone'
      : 'email';
  }

  function stateStatus(data) {
    return String(firstValue(data, ['status'], 'pending')).toLowerCase();
  }

  function renderRequest(data) {
    requestState = normalizeState(data);
    const status = stateStatus(requestState);
    if (status === 'verified') {
      showSuccess(stateType(requestState));
      return;
    }
    if (['expired', 'cancelled', 'canceled', 'conflict', 'delivery_failed', 'superseded'].includes(status)) {
      showTerminalError(errorMessage(requestState, 'This request is no longer active. Ask support to send a new verification request.'));
      return;
    }
    if (stateType(requestState) === 'phone') {
      document.getElementById('identity-phone-target').textContent = firstValue(
        requestState,
        ['maskedValue', 'masked_value', 'value'],
        'your mobile number'
      );
      showPanel('identity-verify-phone', 'identity-phone-title');
      return;
    }
    const target = firstValue(requestState, ['maskedValue', 'masked_value', 'value'], 'your email');
    document.getElementById('identity-email-target').textContent = target;
    showPanel('identity-verify-email', 'identity-email-title');
  }

  async function loadRequest() {
    if (!token) {
      showTerminalError('Open the private verification link sent directly to your new email or phone.');
      return;
    }
    try {
      renderRequest(await request(`/api/account/identity-change?token=${encodeURIComponent(token)}`));
    } catch (error) {
      showTerminalError(verificationErrorCopy(error));
    }
  }

  document.getElementById('identity-email-confirm').addEventListener('click', async event => {
    const button = event.currentTarget;
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    button.textContent = 'Confirming…';
    document.getElementById('identity-email-error').textContent = '';
    try {
      await request('/api/account/identity-change/verify', { method:'POST',body:{ token } });
      showSuccess('email');
    } catch (error) {
      if (isTerminalVerificationError(error)) showTerminalError(verificationErrorCopy(error));
      else document.getElementById('identity-email-error').textContent = verificationErrorCopy(error);
    } finally {
      button.disabled = false;
      button.setAttribute('aria-busy', 'false');
      button.textContent = 'Confirm email';
    }
  });

  document.getElementById('identity-phone-form').addEventListener('submit', async event => {
    event.preventDefault();
    const codeField = document.getElementById('identity-phone-code');
    const code = codeField.value.trim();
    const errorElement = document.getElementById('identity-phone-error');
    if (!/^\d{6}$/.test(code)) {
      errorElement.textContent = 'Enter the six-digit code from the text message.';
      codeField.focus();
      return;
    }
    const button = document.getElementById('identity-phone-confirm');
    errorElement.textContent = '';
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    button.textContent = 'Verifying…';
    try {
      await request('/api/account/identity-change/verify', { method:'POST',body:{ token, code } });
      showSuccess('phone');
    } catch (error) {
      if (isTerminalVerificationError(error)) showTerminalError(verificationErrorCopy(error));
      else errorElement.textContent = verificationErrorCopy(error);
    } finally {
      button.disabled = false;
      button.setAttribute('aria-busy', 'false');
      button.textContent = 'Verify mobile number';
    }
  });

  loadRequest();
})();
