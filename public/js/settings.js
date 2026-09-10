/* Responsive Settings sections, account profile, Host Page, and SMS credits. */

renderNav('settings');

const settingsElement = id => document.getElementById(id);
const settingsRoutes = new Map([
  ['/settings/account', 'account'],
  ['/settings/messaging', 'messaging'],
  ['/settings/host-page', 'host-page']
]);
const requestedSettingsSection = settingsRoutes.get(window.location.pathname) || 'index';
const desktopSettingsSection = requestedSettingsSection === 'index' ? 'account' : requestedSettingsSection;

document.body.dataset.settingsRoute = requestedSettingsSection;
document.querySelectorAll('[data-settings-section]').forEach(panel => {
  panel.hidden = panel.dataset.settingsSection !== desktopSettingsSection;
});
document.querySelectorAll('[data-settings-link]').forEach(link => {
  const active = link.dataset.settingsLink === desktopSettingsSection;
  link.classList.toggle('active', active);
  if (active) link.setAttribute('aria-current', 'page');
});

let currentOrganizer = null;
let savedAccountName = '';
let savedHostSnapshot = '';
let smsCreditState = null;
let selectedCreditPack = null;
let paypalSdkPromise = null;
let paypalSessionsPromise = null;
let paymentBusy = false;
let paymentSheetTrigger = null;
let paymentMethodsReady = false;

function settingsHostInitials(name) {
  return String(name || 'SG').trim().split(/\s+/).slice(0, 2)
    .map(part => part[0] || '').join('').toUpperCase() || 'SG';
}

function showAccountAvatarFallback() {
  settingsElement('account-avatar-image').hidden = true;
  settingsElement('account-avatar-fallback').hidden = false;
}

function renderAccountAvatar(organizer) {
  const image = settingsElement('account-avatar-image');
  if (organizer.avatar_url) {
    image.src = organizer.avatar_url;
    image.hidden = false;
    settingsElement('account-avatar-fallback').hidden = true;
    settingsElement('account-avatar-btn').textContent = 'Change photo';
    settingsElement('account-avatar-remove').hidden = false;
  } else {
    image.removeAttribute('src');
    showAccountAvatarFallback();
    settingsElement('account-avatar-btn').textContent = 'Add photo';
    settingsElement('account-avatar-remove').hidden = true;
  }
}

function updateAccountDirty() {
  if (!currentOrganizer) return;
  const dirty = settingsElement('name').value.trim() !== savedAccountName;
  settingsElement('account-save-btn').disabled = !dirty;
}

function populateAccount(organizer) {
  settingsElement('email-value').textContent = organizer.email || '';
  settingsElement('name').value = organizer.name || '';
  savedAccountName = settingsElement('name').value.trim();
  settingsElement('plan-badge').textContent = organizer.plan === 'pro' ? 'Pro' : 'Free';
  renderAccountAvatar(organizer);
  updateAccountDirty();
}

function renderHostMedia(organizer) {
  const logoImage = settingsElement('logo-preview');
  const headerImage = settingsElement('header-preview');
  if (organizer.logo_url) {
    logoImage.src = organizer.logo_url;
    logoImage.hidden = false;
    settingsElement('logo-preview-empty').hidden = true;
    settingsElement('logo-btn').textContent = 'Replace';
  } else {
    logoImage.removeAttribute('src');
    logoImage.hidden = true;
    settingsElement('logo-preview-empty').hidden = false;
    settingsElement('logo-preview-empty').textContent = settingsHostInitials(organizer.org_name || organizer.name);
    settingsElement('logo-btn').textContent = 'Add logo';
  }
  if (organizer.header_image_url) {
    headerImage.src = organizer.header_image_url;
    headerImage.hidden = false;
    settingsElement('header-preview-empty').hidden = true;
    settingsElement('header-btn').textContent = 'Replace';
  } else {
    headerImage.removeAttribute('src');
    headerImage.hidden = true;
    settingsElement('header-preview-empty').hidden = false;
    settingsElement('header-btn').textContent = 'Add image';
  }
  settingsElement('logo-btn').disabled = false;
  settingsElement('header-btn').disabled = !organizer.public_slug;
  if (!organizer.public_slug) {
    settingsElement('header-status').textContent = 'Save Basics before adding a header image.';
  } else if (settingsElement('header-status').textContent === 'Save Basics before adding a header image.') {
    settingsElement('header-status').textContent = '';
  }
}

function hostFormValue() {
  return {
    org_name: settingsElement('org_name').value,
    public_slug: settingsElement('public_slug').disabled ? '' : settingsElement('public_slug').value,
    bio: settingsElement('bio').value,
    instagram_handle: settingsElement('instagram_handle').value,
    website_url: settingsElement('website_url').value
  };
}

function updateHostDirty() {
  if (!currentOrganizer) return;
  settingsElement('host-form-actions').hidden = JSON.stringify(hostFormValue()) === savedHostSnapshot;
}

function populateHostFields(organizer) {
  settingsElement('org_name').value = organizer.org_name || '';
  settingsElement('public_slug').disabled = !organizer.public_slug;
  settingsElement('public_slug').value = organizer.public_slug || '';
  settingsElement('bio').value = organizer.bio || '';
  settingsElement('instagram_handle').value = organizer.instagram_handle ? `@${organizer.instagram_handle}` : '';
  settingsElement('website_url').value = organizer.website_url || '';
  settingsElement('host-url-prefix').textContent = `${window.location.host}/h/`;
  settingsElement('slug-help').textContent = organizer.public_slug
    ? 'Changing this address breaks host-page links you have already shared.'
    : 'Save a public host name to create your page address.';
  settingsElement('host-summary-view').hidden = !organizer.public_slug;
  if (organizer.public_slug) {
    settingsElement('host-summary-view').href = `/h/${encodeURIComponent(organizer.public_slug)}`;
  }
  renderHostMedia(organizer);
  savedHostSnapshot = JSON.stringify(hostFormValue());
  updateHostDirty();
}

function populateSettings(organizer) {
  currentOrganizer = organizer;
  populateAccount(organizer);
  populateHostFields(organizer);
  updateNavAccount(organizer);
}

function creditMoney(amountCents, includeCents = false) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: includeCents ? 2 : 0,
    maximumFractionDigits: includeCents ? 2 : 0
  }).format(Number(amountCents || 0) / 100);
}

function creditDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric'
  });
}

function transactionLabel(transaction) {
  if (transaction.kind === 'purchase') return 'Credit pack purchased';
  if (transaction.kind === 'refund') return 'Payment refunded';
  if (transaction.kind === 'reversal') return 'Payment reversed';
  if (transaction.kind === 'send') return 'SMS delivery';
  return 'Credit adjustment';
}

function renderCreditHistory(transactions) {
  const list = settingsElement('sms-credit-transactions');
  list.replaceChildren();
  if (!transactions.length) {
    const empty = document.createElement('p');
    empty.className = 'credits-empty';
    empty.textContent = 'No credit activity yet.';
    list.appendChild(empty);
    return;
  }
  transactions.forEach(transaction => {
    const row = document.createElement('div');
    row.className = 'credits-transaction';
    const copy = document.createElement('div');
    const label = document.createElement('strong');
    label.textContent = transactionLabel(transaction);
    const time = document.createElement('time');
    time.dateTime = transaction.createdAt;
    time.textContent = creditDate(transaction.createdAt);
    copy.append(label, time);

    const value = document.createElement('div');
    value.className = 'credits-transaction-value';
    const credits = document.createElement('strong');
    credits.className = transaction.creditsDelta < 0 ? 'negative' : '';
    credits.textContent = `${transaction.creditsDelta > 0 ? '+' : ''}${Number(transaction.creditsDelta).toLocaleString('en-US')} credits`;
    value.appendChild(credits);
    if (transaction.amountCentsDelta != null) {
      const amount = document.createElement('span');
      amount.textContent = creditMoney(Math.abs(transaction.amountCentsDelta), true);
      value.appendChild(amount);
    }
    row.append(copy, value);
    list.appendChild(row);
  });
}

function unitPrice(pack) {
  return `${(Number(pack.amountCents) / Number(pack.credits)).toFixed(1)}¢ each`;
}

function chooseCreditPack(pack) {
  if (!smsCreditState?.checkoutReady || paymentBusy) return;
  selectedCreditPack = pack;
  document.querySelectorAll('.credit-pack').forEach(button => {
    button.setAttribute('aria-pressed', String(button.dataset.packKey === pack.key));
  });
  settingsElement('sms-credit-continue').disabled = false;
  settingsElement('sms-credit-load-status').textContent = `${pack.credits.toLocaleString('en-US')} credits selected.`;
  settingsElement('sms-credit-result').hidden = true;
}

function renderCreditPacks(packs, checkoutReady) {
  const container = settingsElement('sms-credit-packs');
  container.replaceChildren();
  packs.forEach(pack => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'credit-pack';
    button.dataset.packKey = pack.key;
    button.setAttribute('aria-pressed', String(selectedCreditPack?.key === pack.key));
    button.disabled = !checkoutReady;
    const amount = document.createElement('strong');
    amount.textContent = `${Number(pack.credits).toLocaleString('en-US')} credits`;
    const price = document.createElement('span');
    price.textContent = creditMoney(pack.amountCents);
    const unit = document.createElement('em');
    unit.textContent = unitPrice(pack);
    button.append(amount, price, unit);
    button.addEventListener('click', () => chooseCreditPack(pack));
    container.appendChild(button);
  });
}

function renderSmsCredits(state) {
  smsCreditState = state;
  const balance = Number(state.balance || 0).toLocaleString('en-US');
  settingsElement('sms-credit-balance').textContent = balance;
  settingsElement('settings-index-credit-balance').textContent = `${balance} credits`;
  settingsElement('settings-rail-credit-balance').textContent = balance;
  settingsElement('sms-credit-env').hidden = state.paypal?.environment !== 'sandbox';
  settingsElement('sms-credit-setup').hidden = !state.setupRequired;
  renderCreditPacks(state.packs || [], state.checkoutReady);
  renderCreditHistory(state.transactions || []);
  settingsElement('sms-credit-load-status').textContent = state.enabled
    ? (state.checkoutReady ? 'Choose a pack to continue.' : '')
    : 'SMS credits are not available for this account.';
  settingsElement('sms-credit-load-status').classList.toggle('error', !state.enabled);
  if (!state.checkoutReady) selectedCreditPack = null;
  settingsElement('sms-credit-continue').disabled = !state.checkoutReady || !selectedCreditPack;
}

async function loadSmsCredits() {
  try {
    const state = await api('/api/sms-credits');
    renderSmsCredits(state);
    return state;
  } catch (error) {
    settingsElement('sms-credit-load-status').textContent = 'Credit information could not be loaded. Reload this page to try again.';
    settingsElement('sms-credit-load-status').classList.add('error');
    return null;
  }
}

function loadPayPalSdk() {
  if (window.paypal?.createInstance) return Promise.resolve(window.paypal);
  if (paypalSdkPromise) return paypalSdkPromise;
  paypalSdkPromise = new Promise((resolve, reject) => {
    const environment = smsCreditState?.paypal?.environment;
    const expected = environment === 'live'
      ? 'https://www.paypal.com/web-sdk/v6/core'
      : 'https://www.sandbox.paypal.com/web-sdk/v6/core';
    if (smsCreditState?.paypal?.sdkUrl !== expected) {
      reject(new Error('Invalid PayPal configuration'));
      return;
    }
    const script = document.createElement('script');
    script.src = expected;
    script.async = true;
    script.addEventListener('load', () => resolve(window.paypal));
    script.addEventListener('error', () => reject(new Error('Payment options could not load')));
    document.head.appendChild(script);
  });
  return paypalSdkPromise;
}

function setPaymentProgress(percent, label, { hidden = false } = {}) {
  const progress = settingsElement('sms-payment-progress');
  const value = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
  progress.hidden = hidden;
  progress.setAttribute('aria-valuenow', String(value));
  settingsElement('sms-payment-progress-value').textContent = `${value}%`;
  settingsElement('sms-payment-progress-label').textContent = label;
  settingsElement('sms-payment-progress-bar').style.width = `${value}%`;
}

async function createCreditOrder(paymentMethod) {
  if (!selectedCreditPack) throw new Error('Choose a credit pack');
  const result = await api('/api/sms-credits/orders', {
    method: 'POST', body: { packKey: selectedCreditPack.key, paymentMethod }
  });
  return { orderId: result.orderId };
}

function closePaymentSheet({ restoreFocus = true } = {}) {
  if (paymentBusy) return;
  settingsElement('sms-payment-sheet').hidden = true;
  settingsElement('sms-payment-sheet').setAttribute('aria-hidden', 'true');
  document.body.classList.remove('payment-sheet-open');
  if (restoreFocus && paymentSheetTrigger) paymentSheetTrigger.focus();
}

function showCreditResult(message) {
  settingsElement('sms-credit-result').textContent = message;
  settingsElement('sms-credit-result').hidden = false;
}

async function finishCreditPurchase(data) {
  const pack = selectedCreditPack;
  if (!pack || !data?.orderId) throw new Error('PayPal did not return an order');
  paymentBusy = true;
  settingsElement('sms-credit-status').textContent = 'Confirming your credits…';
  settingsElement('sms-credit-status').classList.remove('error');
  try {
    await api(`/api/sms-credits/orders/${encodeURIComponent(data.orderId)}/capture`, { method: 'POST' });
    selectedCreditPack = null;
    await loadSmsCredits();
    paymentBusy = false;
    closePaymentSheet({ restoreFocus: false });
    showCreditResult(`${pack.credits.toLocaleString('en-US')} credits were added to your balance.`);
    settingsElement('sms-credit-result').focus();
  } catch (error) {
    settingsElement('sms-credit-status').textContent = error.message || 'Payment could not be confirmed. Check your activity before trying again.';
    settingsElement('sms-credit-status').classList.add('error');
    throw error;
  } finally {
    paymentBusy = false;
  }
}

async function startPayPalSession(session, paymentMethod) {
  if (!session || paymentBusy || !selectedCreditPack) return;
  paymentBusy = true;
  settingsElement('sms-credit-status').textContent = 'Opening payment…';
  settingsElement('sms-credit-status').classList.remove('error');
  try {
    await session.start({ presentationMode: 'auto' }, createCreditOrder(paymentMethod));
  } catch (error) {
    settingsElement('sms-credit-status').textContent = error.message || 'Payment could not be opened. Try again.';
    settingsElement('sms-credit-status').classList.add('error');
  } finally {
    paymentBusy = false;
  }
}

async function initializePayPalPayments() {
  if (paypalSessionsPromise) {
    if (paymentMethodsReady) setPaymentProgress(100, 'Payment options ready', { hidden: true });
    return paypalSessionsPromise;
  }
  paypalSessionsPromise = (async () => {
    setPaymentProgress(20, 'Connecting securely');
    const sdk = await loadPayPalSdk();
    if (!sdk?.createInstance) throw new Error('Payment options could not load');
    setPaymentProgress(50, 'Secure connection ready');
    const instance = await sdk.createInstance({
      clientId: smsCreditState.paypal.clientId,
      components: ['paypal-payments', 'venmo-payments'],
      pageType: 'checkout'
    });
    setPaymentProgress(70, 'Checking payment methods');
    const methods = await instance.findEligibleMethods({ currencyCode: 'USD' });
    setPaymentProgress(85, 'Preparing payment buttons');
    const options = {
      onApprove: finishCreditPurchase,
      onCancel: () => {
        paymentBusy = false;
        closePaymentSheet();
        showCreditResult('Payment was cancelled. Your credit pack is still selected.');
      },
      onError: () => {
        paymentBusy = false;
        settingsElement('sms-credit-status').textContent = 'Payment could not be completed. Try again or choose another payment method.';
        settingsElement('sms-credit-status').classList.add('error');
      }
    };
    let paypalSession = null;
    let venmoSession = null;
    if (methods.isEligible('paypal')) {
      paypalSession = await instance.createPayPalOneTimePaymentSession(options);
    }
    if (methods.isEligible('venmo')) {
      venmoSession = await instance.createVenmoOneTimePaymentSession(options);
    }
    const available = Number(Boolean(paypalSession)) + Number(Boolean(venmoSession));
    if (paypalSession) {
      settingsElement('sms-paypal-button').hidden = false;
      settingsElement('sms-paypal-button').addEventListener('click', () => startPayPalSession(paypalSession, 'paypal'));
    }
    if (venmoSession) {
      settingsElement('sms-venmo-button').hidden = false;
      settingsElement('sms-venmo-button').addEventListener('click', () => startPayPalSession(venmoSession, 'venmo'));
    }
    paymentMethodsReady = available > 0;
    setPaymentProgress(100, available ? 'Payment options ready' : 'Payment check complete', { hidden: true });
    settingsElement('sms-credit-status').textContent = available
      ? 'Choose PayPal or Venmo to continue.'
      : 'PayPal and Venmo are not available in this browser.';
    settingsElement('sms-credit-status').classList.toggle('error', !available);
  })().catch(error => {
    paypalSessionsPromise = null;
    paymentMethodsReady = false;
    setPaymentProgress(0, 'Payment options could not load', { hidden: true });
    settingsElement('sms-credit-status').textContent = error.message || 'Payment options could not load. Close this sheet and try again.';
    settingsElement('sms-credit-status').classList.add('error');
  });
  return paypalSessionsPromise;
}

function openPaymentSheet() {
  if (!selectedCreditPack || !smsCreditState?.checkoutReady) return;
  paymentSheetTrigger = document.activeElement;
  settingsElement('sms-credit-selection').textContent = `${selectedCreditPack.credits.toLocaleString('en-US')} credits · ${creditMoney(selectedCreditPack.amountCents)}`;
  settingsElement('sms-credit-status').textContent = paymentMethodsReady ? 'Choose PayPal or Venmo to continue.' : '';
  settingsElement('sms-credit-status').classList.remove('error');
  setPaymentProgress(paymentMethodsReady ? 100 : 10, paymentMethodsReady ? 'Payment options ready' : 'Starting secure payment', { hidden: paymentMethodsReady });
  settingsElement('sms-payment-sheet').hidden = false;
  settingsElement('sms-payment-sheet').setAttribute('aria-hidden', 'false');
  document.body.classList.add('payment-sheet-open');
  settingsElement('sms-payment-close').focus();
  initializePayPalPayments();
}

function showSettings() {
  settingsElement('settings-loading').hidden = true;
  settingsElement('settings-ui').hidden = false;
  settingsElement('settings-content').setAttribute('aria-busy', 'false');
  settingsElement('name').disabled = false;
  settingsElement('account-avatar-btn').disabled = false;
}

function showSettingsError() {
  settingsElement('settings-ui').hidden = true;
  settingsElement('settings-loading').removeAttribute('aria-label');
  settingsElement('settings-loading').innerHTML = `<div></div><div class="settings-load-error"><h2>Settings could not be loaded</h2><p>Your account has not been changed. Reload this page to try again.</p><a class="sg-btn sg-btn-ghost" href="${window.location.pathname}">Reload settings</a></div>`;
}

api('/api/auth/me').then(({ organizer }) => {
  populateSettings(organizer);
  showSettings();
  if (organizer.avatar_url) api('/api/me/link-rsvps', { method: 'POST' }).catch(() => {});
  if (organizer.is_admin) {
    const nav = document.querySelector('.sg-nav-links');
    nav.insertAdjacentHTML('beforeend', '<a href="/admin/line">The Line</a><a href="/admin/hosts">Hosts</a><a href="/admin/ticketing">Ticketing</a><a href="/admin/feedback">Feedback</a><a href="/admin/invitations">Invitations</a>');
  }
  loadSmsCredits();
}).catch(showSettingsError);

settingsElement('name').addEventListener('input', updateAccountDirty);
settingsElement('account-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!currentOrganizer || settingsElement('account-save-btn').disabled) return;
  const button = settingsElement('account-save-btn');
  button.disabled = true;
  button.textContent = 'Saving…';
  settingsElement('account-status').textContent = '';
  settingsElement('account-status').classList.remove('error');
  try {
    const { organizer } = await api('/api/me/profile', {
      method: 'PATCH',
      body: { name: settingsElement('name').value }
    });
    currentOrganizer = organizer;
    populateAccount(organizer);
    updateNavAccount(organizer);
    settingsElement('account-status').textContent = 'Changes saved.';
  } catch (error) {
    settingsElement('account-status').textContent = error.message;
    settingsElement('account-status').classList.add('error');
  } finally {
    button.textContent = 'Save changes';
    updateAccountDirty();
  }
});

document.querySelectorAll('#host-profile-form input,#host-profile-form textarea').forEach(field => {
  field.addEventListener('input', updateHostDirty);
});
settingsElement('host-profile-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!currentOrganizer) return;
  const button = settingsElement('host-save-btn');
  button.disabled = true;
  button.textContent = 'Saving…';
  settingsElement('host-status').textContent = '';
  settingsElement('host-status').classList.remove('error');
  try {
    const body = {
      name: currentOrganizer.name || '',
      org_name: settingsElement('org_name').value,
      bio: settingsElement('bio').value,
      instagram_handle: settingsElement('instagram_handle').value,
      website_url: settingsElement('website_url').value
    };
    if (!settingsElement('public_slug').disabled) body.public_slug = settingsElement('public_slug').value;
    const { organizer } = await api('/api/settings', { method: 'PUT', body });
    currentOrganizer = organizer;
    populateHostFields(organizer);
    updateNavAccount(organizer);
    settingsElement('host-status').textContent = 'Changes saved.';
  } catch (error) {
    settingsElement('host-status').textContent = error.message;
    settingsElement('host-status').classList.add('error');
  } finally {
    button.disabled = false;
    button.textContent = 'Save changes';
  }
});
settingsElement('host-discard-btn').addEventListener('click', () => {
  if (currentOrganizer) populateHostFields(currentOrganizer);
  settingsElement('host-status').textContent = '';
});

async function uploadAccountAvatar() {
  const input = settingsElement('account-avatar-input');
  const button = settingsElement('account-avatar-btn');
  const status = settingsElement('account-avatar-status');
  const file = input.files[0];
  if (!file) return;
  if (!/^image\/(jpeg|png|webp|gif)$/.test(file.type)) {
    status.textContent = 'Choose a JPG, PNG, WebP, or GIF image.';
    input.value = '';
    return;
  }
  if (file.size > 5 * 1024 * 1024) {
    status.textContent = 'That image is larger than 5 MB.';
    input.value = '';
    return;
  }
  const form = new FormData();
  form.append('image', file);
  button.disabled = true;
  status.textContent = 'Uploading…';
  try {
    const response = await fetch('/api/uploads/avatar', { method: 'POST', body: form });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Upload failed');
    currentOrganizer = data.organizer;
    renderAccountAvatar(currentOrganizer);
    updateNavAccount(currentOrganizer);
    status.textContent = 'Photo saved.';
  } catch (error) {
    status.textContent = error.message;
  } finally {
    button.disabled = false;
    input.value = '';
  }
}

settingsElement('account-avatar-image').addEventListener('error', showAccountAvatarFallback);
settingsElement('account-avatar-btn').addEventListener('click', () => settingsElement('account-avatar-input').click());
settingsElement('account-avatar-input').addEventListener('change', uploadAccountAvatar);
settingsElement('account-avatar-remove').addEventListener('click', async () => {
  const button = settingsElement('account-avatar-remove');
  button.disabled = true;
  settingsElement('account-avatar-status').textContent = 'Removing…';
  try {
    const { organizer } = await api('/api/me/profile', { method: 'PATCH', body: { avatarUrl: null } });
    currentOrganizer = organizer;
    renderAccountAvatar(currentOrganizer);
    updateNavAccount(currentOrganizer);
    settingsElement('account-avatar-status').textContent = 'Photo removed.';
  } catch (error) {
    settingsElement('account-avatar-status').textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

async function uploadProfileImage(kind) {
  const input = settingsElement(`${kind}-input`);
  const button = settingsElement(`${kind}-btn`);
  const status = settingsElement(`${kind}-status`);
  const file = input.files[0];
  if (!file) return;
  const form = new FormData();
  form.append('image', file);
  button.disabled = true;
  status.textContent = 'Uploading…';
  try {
    const path = kind === 'logo' ? '/api/uploads/host-logo' : '/api/uploads/host-header';
    const response = await fetch(path, { method: 'POST', body: form });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Upload failed');
    currentOrganizer = data.organizer;
    renderHostMedia(currentOrganizer);
    updateNavAccount(currentOrganizer);
    status.textContent = `${kind === 'logo' ? 'Logo' : 'Header'} saved.`;
  } catch (error) {
    status.textContent = error.message;
  } finally {
    button.disabled = kind === 'header' && !currentOrganizer.public_slug;
    input.value = '';
  }
}

settingsElement('logo-btn').addEventListener('click', () => settingsElement('logo-input').click());
settingsElement('logo-input').addEventListener('change', () => uploadProfileImage('logo'));
settingsElement('header-btn').addEventListener('click', () => settingsElement('header-input').click());
settingsElement('header-input').addEventListener('change', () => uploadProfileImage('header'));

settingsElement('sms-credit-continue').addEventListener('click', openPaymentSheet);
settingsElement('sms-payment-close').addEventListener('click', () => closePaymentSheet());
settingsElement('sms-payment-sheet').addEventListener('click', event => {
  if (event.target === settingsElement('sms-payment-sheet')) closePaymentSheet();
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !settingsElement('sms-payment-sheet').hidden) closePaymentSheet();
  if (event.key === 'Tab' && !settingsElement('sms-payment-sheet').hidden) {
    const focusable = [...settingsElement('sms-payment-sheet').querySelectorAll(
      'button:not([disabled]),paypal-button:not([hidden]),venmo-button:not([hidden])'
    )];
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
});

document.querySelectorAll('.settings-logout').forEach(button => {
  button.addEventListener('click', async () => {
    try { await api('/api/auth/logout', { method: 'POST' }); } catch (_) {}
    window.location.href = '/login';
  });
});
