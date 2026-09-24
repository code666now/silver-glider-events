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
let paymentBusy = false;
let identityState = {
  identities: [],
  capabilities: { canAddPhone: false, identityStepUpVerified: false, phoneLimit: 1 }
};
let identityDialogReturnFocus = null;
let identityDialogMode = '';
let pendingIdentityAction = null;
let identityDialogGeneration = 0;
const hostMobileFlowQuery = window.matchMedia('(max-width: 879px)');
const hostProfileForm = settingsElement('host-profile-form');
const hostMobileHistoryKey = 'sgeSettingsHostView';
const hostMobileHistoryContext = window.location.pathname;
let hostMobileSection = '';

function hostMobileHistoryEntry(state = window.history.state) {
  const entry = state?.[hostMobileHistoryKey];
  if (!entry || entry.context !== hostMobileHistoryContext) return null;
  return ['', 'basics', 'links', 'images'].includes(entry.section) ? entry : null;
}

function writeHostMobileHistory(section, mode = 'push') {
  if (requestedSettingsSection !== 'host-page' || !hostMobileFlowQuery.matches || mode === 'none') return;
  const current = hostMobileHistoryEntry();
  if (mode === 'push' && current?.section === section) return;
  const baseState = window.history.state && typeof window.history.state === 'object'
    ? window.history.state
    : {};
  window.history[mode === 'replace' ? 'replaceState' : 'pushState']({
    ...baseState,
    [hostMobileHistoryKey]: { context: hostMobileHistoryContext, section }
  }, '', window.location.href);
}

function clearHostMobileHistory() {
  if (!hostMobileHistoryEntry()) return;
  const nextState = { ...(window.history.state || {}) };
  delete nextState[hostMobileHistoryKey];
  window.history.replaceState(nextState, '', window.location.href);
}

function syncSettingsMobileStickyAction() {
  const hostSaveVisible = requestedSettingsSection === 'host-page' && !settingsElement('host-form-actions')?.hidden;
  const identityDialogOpen = document.body.classList.contains('identity-dialog-open');
  const persistentAction = !identityDialogOpen && (requestedSettingsSection === 'account' || requestedSettingsSection === 'messaging' || hostSaveVisible);
  document.body.classList.toggle('has-mobile-sticky-action', hostMobileFlowQuery.matches && persistentAction);
}

function renderHostMobileSection({ focus = false, historyMode = 'none' } = {}) {
  if (!hostProfileForm) return;
  if (!hostMobileFlowQuery.matches || !hostMobileSection) hostProfileForm.removeAttribute('data-host-mobile-section');
  else hostProfileForm.dataset.hostMobileSection = hostMobileSection;
  writeHostMobileHistory(hostMobileSection, historyMode);
  syncSettingsMobileStickyAction();
  if (!focus || !hostMobileFlowQuery.matches) return;
  const scrollBehavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
  if (hostMobileSection) {
    const panel = hostProfileForm.querySelector(`[data-host-mobile-panel="${hostMobileSection}"]`);
    panel?.scrollIntoView({ block: 'start', behavior: scrollBehavior });
    panel?.querySelector('[data-host-mobile-back]')?.focus({ preventScroll: true });
  } else {
    hostProfileForm.scrollIntoView({ block: 'start', behavior: scrollBehavior });
    hostProfileForm.querySelector('[data-host-mobile-open]')?.focus({ preventScroll: true });
  }
}

hostProfileForm?.querySelectorAll('[data-host-mobile-open]').forEach(button => {
  button.addEventListener('click', () => {
    hostMobileSection = button.dataset.hostMobileOpen;
    renderHostMobileSection({ focus: true, historyMode: 'push' });
  });
});
hostProfileForm?.querySelectorAll('[data-host-mobile-back]').forEach(button => {
  button.addEventListener('click', () => {
    if (hostMobileHistoryEntry()?.section === hostMobileSection) window.history.back();
    else {
      hostMobileSection = '';
      renderHostMobileSection({ focus: true, historyMode: 'replace' });
    }
  });
});
window.addEventListener('popstate', event => {
  if (requestedSettingsSection !== 'host-page' || !hostMobileFlowQuery.matches) return;
  const entry = hostMobileHistoryEntry(event.state);
  if (!entry) return;
  hostMobileSection = entry.section;
  renderHostMobileSection({ focus: true, historyMode: 'none' });
});
const handleHostMobileBreakpoint = () => {
  if (!hostMobileFlowQuery.matches) {
    clearHostMobileHistory();
    hostMobileSection = '';
    renderHostMobileSection();
    return;
  }
  const entry = hostMobileHistoryEntry();
  hostMobileSection = entry?.section || '';
  renderHostMobileSection({ historyMode: 'replace' });
};
if (hostMobileFlowQuery.addEventListener) hostMobileFlowQuery.addEventListener('change', handleHostMobileBreakpoint);
else hostMobileFlowQuery.addListener(handleHostMobileBreakpoint);
if (hostMobileFlowQuery.matches && requestedSettingsSection === 'host-page') {
  hostMobileSection = hostMobileHistoryEntry()?.section || '';
  renderHostMobileSection({ historyMode: 'replace' });
} else renderHostMobileSection();

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
  syncSettingsMobileStickyAction();
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
  const followShare = settingsElement('host-follow-share');
  followShare.hidden = !organizer.public_slug;
  if (organizer.public_slug) {
    const followUrl = `${window.location.origin}/h/${encodeURIComponent(organizer.public_slug)}?follow=1`;
    settingsElement('host-follow-share-url').value = followUrl;
    settingsElement('host-follow-share-copy').textContent = Number(organizer.sms_credits || 0) > 0
      ? 'Fans get email updates and can optionally add text updates.'
      : 'Fans can follow for new-event emails.';
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

function identityTypeLabel(type) {
  return type === 'phone' ? 'Mobile number' : 'Email';
}

function identityDisplayValue(identity) {
  const value = String(identity.value || identity.normalizedValue || '');
  if (identity.type !== 'phone') return value;
  const digits = value.replace(/\D/g, '');
  return digits.length >= 4 ? `••• ••• ${digits.slice(-4)}` : value;
}

function setIdentityStatus(message = '', isError = false) {
  const status = settingsElement('identity-status');
  status.textContent = message;
  status.classList.toggle('error', isError);
}

function setIdentityDialogStatus(message = '', isError = true) {
  const status = settingsElement('identity-dialog-status');
  status.textContent = message;
  status.classList.toggle('success', Boolean(message) && !isError);
}

function identityActionButton(label, action, className = '') {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `identity-row-action ${className}`.trim();
  button.textContent = label;
  button.addEventListener('click', action);
  return button;
}

function renderAccountIdentities(state) {
  identityState = state;
  const list = settingsElement('identity-list');
  list.replaceChildren();
  list.setAttribute('aria-busy', 'false');

  (state.identities || []).forEach(identity => {
    const row = document.createElement('article');
    row.className = 'identity-row';

    const copy = document.createElement('div');
    copy.className = 'identity-row-copy';
    const heading = document.createElement('div');
    heading.className = 'identity-row-heading';
    const type = document.createElement('strong');
    type.textContent = identityTypeLabel(identity.type);
    const verified = document.createElement('span');
    verified.className = 'identity-verified';
    verified.textContent = 'Verified';
    heading.append(type, verified);
    const value = document.createElement('span');
    value.className = 'identity-row-value';
    value.textContent = identityDisplayValue(identity);
    const note = document.createElement('span');
    note.className = 'identity-row-note';
    note.textContent = identity.isPrimary
      ? `Primary ${identity.type === 'phone' ? 'phone' : 'email'}`
      : 'Can be used to sign in';
    copy.append(heading, value, note);

    const actions = document.createElement('div');
    actions.className = 'identity-row-actions';
    if (identity.type === 'email' && !identity.isPrimary) {
      actions.append(identityActionButton('Make primary', () => makeIdentityPrimary(identity)));
    }
    if (!(identity.type === 'email' && identity.isPrimary)) {
      actions.append(identityActionButton('Remove', () => removeIdentity(identity), 'danger'));
    }
    row.append(copy, actions);
    list.appendChild(row);
  });

  if (!state.identities?.length) {
    const empty = document.createElement('p');
    empty.className = 'identity-empty';
    empty.textContent = 'No verified sign-in methods were found. Contact support before signing out.';
    list.appendChild(empty);
  }

  const hasPhone = state.identities?.some(identity => identity.type === 'phone');
  settingsElement('identity-actions').hidden = false;
  settingsElement('identity-add-phone').hidden = !state.capabilities?.canAddPhone;
  settingsElement('identity-add-phone').textContent = hasPhone ? 'Change mobile number' : 'Add mobile number';
  settingsElement('identity-admin-note').hidden = Boolean(state.capabilities?.canAddPhone);
}

async function loadAccountIdentities({ announce = false } = {}) {
  const list = settingsElement('identity-list');
  list.setAttribute('aria-busy', 'true');
  try {
    const state = await api('/api/me/identities');
    renderAccountIdentities(state);
    if (announce) setIdentityStatus('Sign-in methods updated.');
    return state;
  } catch (error) {
    list.setAttribute('aria-busy', 'false');
    list.replaceChildren();
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'identity-retry';
    retry.textContent = 'Couldn’t load sign-in methods. Try again';
    retry.addEventListener('click', () => loadAccountIdentities());
    list.appendChild(retry);
    settingsElement('identity-actions').hidden = true;
    setIdentityStatus(error.message || 'Sign-in methods could not be loaded.', true);
    return null;
  }
}

function setIdentityDialogBusy(busy, button) {
  settingsElement('identity-dialog-close').disabled = busy;
  if (button) {
    button.disabled = busy;
    button.setAttribute('aria-busy', String(busy));
  }
}

function identityDialogFlowIsCurrent(generation) {
  return generation === identityDialogGeneration;
}

function resetIdentityDialogControls() {
  settingsElement('identity-dialog-close').disabled = false;
  const entryButton = settingsElement('identity-entry-submit');
  entryButton.disabled = false;
  entryButton.setAttribute('aria-busy', 'false');
  entryButton.textContent = 'Send code';
  const codeButton = settingsElement('identity-code-submit');
  codeButton.disabled = false;
  codeButton.setAttribute('aria-busy', 'false');
  codeButton.textContent = 'Verify';
}

function restoreIdentityDialogFocus() {
  let target = identityDialogReturnFocus;
  if (!target?.isConnected || target.disabled || target.hidden) {
    target = settingsElement('identity-add-email');
  }
  target?.focus();
  identityDialogReturnFocus = null;
}

function showIdentityDialog() {
  const dialog = settingsElement('identity-dialog');
  if (!dialog.open) {
    identityDialogGeneration += 1;
    identityDialogReturnFocus = document.activeElement;
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
  }
  document.body.classList.add('identity-dialog-open');
  syncSettingsMobileStickyAction();
}

function configureIdentityDialog({ eyebrow = 'Account security', title, copy, entry = null, codeHelp = '' }) {
  showIdentityDialog();
  settingsElement('identity-dialog-eyebrow').textContent = eyebrow;
  settingsElement('identity-dialog-title').textContent = title;
  settingsElement('identity-dialog-copy').textContent = copy;
  settingsElement('identity-entry-form').hidden = !entry;
  settingsElement('identity-code-form').hidden = Boolean(entry);
  setIdentityDialogStatus('');
  const codeInput = settingsElement('identity-code');
  codeInput.value = '';
  codeInput.toggleAttribute('data-email-code', identityDialogMode !== 'add-phone');

  if (entry) {
    const input = settingsElement('identity-entry');
    settingsElement('identity-entry-label').textContent = entry.label;
    settingsElement('identity-entry-submit').textContent = entry.button;
    input.value = '';
    input.type = entry.type;
    input.inputMode = entry.inputMode;
    input.autocomplete = entry.autocomplete;
    input.placeholder = entry.placeholder;
    window.requestAnimationFrame(() => input.focus());
  } else {
    settingsElement('identity-code-help').textContent = codeHelp;
    window.requestAnimationFrame(() => settingsElement('identity-code').focus());
  }
}

function closeIdentityDialog({ cancelled = true } = {}) {
  const dialog = settingsElement('identity-dialog');
  if (dialog.open) identityDialogGeneration += 1;
  if (dialog.open && typeof dialog.close === 'function') dialog.close();
  else dialog.removeAttribute('open');
  document.body.classList.remove('identity-dialog-open');
  identityDialogMode = '';
  if (cancelled) pendingIdentityAction = null;
  settingsElement('identity-entry-form').reset();
  settingsElement('identity-code-form').reset();
  resetIdentityDialogControls();
  setIdentityDialogStatus('');
  syncSettingsMobileStickyAction();
  restoreIdentityDialogFocus();
}

async function startIdentityStepUp(action) {
  pendingIdentityAction = action;
  identityDialogMode = 'step-up';
  const button = settingsElement('identity-code-submit');
  configureIdentityDialog({
    title: 'Confirm it’s you',
    copy: 'Before changing sign-in methods, enter the code sent to your primary email.',
    codeHelp: 'Sending a fresh code…'
  });
  const generation = identityDialogGeneration;
  setIdentityDialogBusy(true, button);
  try {
    const result = await api('/api/me/identities/step-up/start', { method: 'POST' });
    if (!identityDialogFlowIsCurrent(generation)) return;
    settingsElement('identity-code-help').textContent = `We sent a code to ${result.maskedEmail}.`;
  } catch (error) {
    if (!identityDialogFlowIsCurrent(generation)) return;
    setIdentityDialogStatus(error.message || 'A confirmation code could not be sent.');
  } finally {
    if (identityDialogFlowIsCurrent(generation)) setIdentityDialogBusy(false, button);
  }
}

function withIdentityStepUp(action) {
  if (identityState.capabilities?.identityStepUpVerified) return action();
  return startIdentityStepUp(action);
}

function openIdentityEntry(type) {
  identityDialogMode = type === 'phone' ? 'add-phone' : 'add-email';
  configureIdentityDialog({
    eyebrow: 'Sign-in & recovery',
    title: type === 'phone' ? 'Add a mobile number' : 'Add an email',
    copy: type === 'phone'
      ? 'We’ll verify this number before it replaces your current phone sign-in.'
      : 'We’ll verify this address before connecting it to your account.',
    entry: type === 'phone'
      ? { label: 'Mobile number', button: 'Send code', type: 'tel', inputMode: 'tel', autocomplete: 'tel', placeholder: '(415) 555-0123' }
      : { label: 'Email address', button: 'Send code', type: 'email', inputMode: 'email', autocomplete: 'email', placeholder: 'you@example.com' }
  });
}

async function makeIdentityPrimary(identity) {
  if (!confirm(`Make ${identity.value || identity.normalizedValue} your primary email?`)) return;
  return withIdentityStepUp(() => executeMakeIdentityPrimary(identity));
}

async function executeMakeIdentityPrimary(identity) {
  const generation = identityDialogGeneration;
  setIdentityStatus('Updating primary email…');
  try {
    const state = await api(`/api/me/identities/${identity.id}/primary`, { method: 'PATCH' });
    if (state.primaryEmail && currentOrganizer) {
      currentOrganizer.email = state.primaryEmail;
      updateNavAccount(currentOrganizer);
    }
    renderAccountIdentities(state);
    if (!identityDialogFlowIsCurrent(generation)) return;
    setIdentityStatus('Primary email updated.');
    closeIdentityDialog({ cancelled: false });
  } catch (error) {
    if (!identityDialogFlowIsCurrent(generation)) return;
    if (error.code === 'identity_step_up_required') {
      identityState.capabilities.identityStepUpVerified = false;
      return startIdentityStepUp(() => executeMakeIdentityPrimary(identity));
    }
    setIdentityStatus(error.message, true);
    setIdentityDialogStatus(error.message);
  }
}

async function removeIdentity(identity) {
  const label = identity.type === 'phone' ? 'mobile number' : 'email';
  if (!confirm(`Remove this ${label} from your account?`)) return;
  return withIdentityStepUp(() => executeRemoveIdentity(identity));
}

async function executeRemoveIdentity(identity) {
  const label = identity.type === 'phone' ? 'mobile number' : 'email';
  const generation = identityDialogGeneration;
  setIdentityStatus(`Removing ${label}…`);
  try {
    const state = await api(`/api/me/identities/${identity.id}`, { method: 'DELETE' });
    renderAccountIdentities(state);
    if (!identityDialogFlowIsCurrent(generation)) return;
    setIdentityStatus(`${identityTypeLabel(identity.type)} removed.`);
    closeIdentityDialog({ cancelled: false });
  } catch (error) {
    if (!identityDialogFlowIsCurrent(generation)) return;
    if (error.code === 'identity_step_up_required') {
      identityState.capabilities.identityStepUpVerified = false;
      return startIdentityStepUp(() => executeRemoveIdentity(identity));
    }
    setIdentityStatus(error.message, true);
    setIdentityDialogStatus(error.message);
  }
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
  packs.forEach((pack, index) => {
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
    if (index === 1) {
      const badge = document.createElement('small');
      badge.className = 'credit-pack-badge';
      badge.textContent = 'MOST POPULAR';
      button.appendChild(badge);
    }
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
  settingsElement('sms-credit-env').hidden = state.environment !== 'sandbox';
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

function showCreditResult(message) {
  settingsElement('sms-credit-result').textContent = message;
  settingsElement('sms-credit-result').hidden = false;
}

function setCheckoutBusy(busy) {
  paymentBusy = busy;
  document.querySelectorAll('.credit-pack').forEach(button => {
    button.disabled = busy || !smsCreditState?.checkoutReady;
  });
  const continueButton = settingsElement('sms-credit-continue');
  continueButton.disabled = busy || !smsCreditState?.checkoutReady || !selectedCreditPack;
  continueButton.setAttribute('aria-busy', String(busy));
  continueButton.textContent = busy ? 'Opening secure checkout…' : 'Continue to payment';
}

async function startStripeCheckout() {
  const pack = selectedCreditPack;
  if (!pack || paymentBusy || !smsCreditState?.checkoutReady) return;
  setCheckoutBusy(true);
  settingsElement('sms-credit-load-status').textContent = 'Opening Stripe’s secure checkout…';
  settingsElement('sms-credit-load-status').classList.remove('error');
  try {
    const result = await api('/api/sms-credits/checkout-sessions', {
      method: 'POST', body: { packKey: pack.key }
    });
    const destination = new URL(result.checkoutUrl);
    if (destination.protocol !== 'https:' || destination.hostname !== 'checkout.stripe.com') {
      throw new Error('Checkout returned an invalid destination.');
    }
    window.location.assign(destination.toString());
  } catch (error) {
    setCheckoutBusy(false);
    settingsElement('sms-credit-load-status').textContent = error.message || 'Checkout could not be opened. Try again.';
    settingsElement('sms-credit-load-status').classList.add('error');
  }
}

function showCheckoutReturn() {
  const params = new URLSearchParams(window.location.search);
  const checkout = params.get('checkout');
  if (checkout === 'success') {
    showCreditResult('Checkout returned. Your balance includes only payments Stripe has confirmed. If it has not updated yet, refresh in a moment.');
    settingsElement('sms-credit-result').focus();
  } else if (checkout === 'cancelled') {
    showCreditResult('Checkout cancelled. No charge was made.');
    settingsElement('sms-credit-result').focus();
  }
  if (checkout) window.history.replaceState({}, '', window.location.pathname);
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

settingsElement('identity-add-email').addEventListener('click', () => {
  withIdentityStepUp(() => openIdentityEntry('email'));
});
settingsElement('identity-add-phone').addEventListener('click', () => {
  withIdentityStepUp(() => openIdentityEntry('phone'));
});

settingsElement('identity-entry-form').addEventListener('submit', async event => {
  event.preventDefault();
  const mode = identityDialogMode;
  const isPhone = mode === 'add-phone';
  if (!['add-email', 'add-phone'].includes(mode)) return;
  const input = settingsElement('identity-entry');
  const button = settingsElement('identity-entry-submit');
  const value = input.value.trim();
  if (!value) {
    setIdentityDialogStatus(`Enter ${isPhone ? 'a mobile number' : 'an email address'}.`);
    input.focus();
    return;
  }
  const generation = identityDialogGeneration;
  setIdentityDialogBusy(true, button);
  button.textContent = 'Sending…';
  setIdentityDialogStatus('');
  try {
    const result = await api(`/api/me/identities/${isPhone ? 'phone' : 'email'}/start`, {
      method: 'POST',
      body: isPhone ? { phone: value } : { email: value }
    });
    if (!identityDialogFlowIsCurrent(generation)) return;
    identityDialogMode = mode;
    configureIdentityDialog({
      eyebrow: 'Sign-in & recovery',
      title: isPhone ? 'Verify your number' : 'Verify this email',
      copy: isPhone
        ? 'Enter the text message code to finish changing your phone sign-in.'
        : 'Enter the email code to connect this address to your account.',
      codeHelp: isPhone ? 'We sent a code by text message.' : `We sent a code to ${result.maskedEmail}.`
    });
  } catch (error) {
    if (!identityDialogFlowIsCurrent(generation)) return;
    if (error.code === 'identity_step_up_required') {
      identityState.capabilities.identityStepUpVerified = false;
      return startIdentityStepUp(() => openIdentityEntry(isPhone ? 'phone' : 'email'));
    }
    setIdentityDialogStatus(error.message || 'A verification code could not be sent.');
  } finally {
    if (identityDialogFlowIsCurrent(generation)) {
      setIdentityDialogBusy(false, button);
      button.textContent = 'Send code';
    }
  }
});

settingsElement('identity-code-form').addEventListener('submit', async event => {
  event.preventDefault();
  const code = settingsElement('identity-code').value.trim();
  const button = settingsElement('identity-code-submit');
  if (!/^\d{6}$/.test(code)) {
    setIdentityDialogStatus('Enter the 6-digit code.');
    settingsElement('identity-code').focus();
    return;
  }
  const generation = identityDialogGeneration;
  setIdentityDialogBusy(true, button);
  button.textContent = 'Verifying…';
  setIdentityDialogStatus('');
  try {
    if (identityDialogMode === 'step-up') {
      const result = await api('/api/auth/verify-code', { method: 'POST', body: { code } });
      if (!identityDialogFlowIsCurrent(generation)) return;
      if (result.kind !== 'identity_step_up') throw new Error('Account confirmation could not be completed.');
      identityState.capabilities.identityStepUpVerified = true;
      const action = pendingIdentityAction;
      pendingIdentityAction = null;
      if (action) await action();
      else closeIdentityDialog({ cancelled: false });
      return;
    }
    if (identityDialogMode === 'add-email') {
      const result = await api('/api/auth/verify-code', { method: 'POST', body: { code } });
      if (!identityDialogFlowIsCurrent(generation)) return;
      if (result.kind !== 'identity') throw new Error('Email verification could not be completed.');
      closeIdentityDialog({ cancelled: false });
      await loadAccountIdentities();
      setIdentityStatus('Email added. You can now use it to sign in.');
      return;
    }
    if (identityDialogMode === 'add-phone') {
      const state = await api('/api/me/identities/phone/verify', { method: 'POST', body: { code } });
      if (!identityDialogFlowIsCurrent(generation)) return;
      renderAccountIdentities(state);
      closeIdentityDialog({ cancelled: false });
      setIdentityStatus('Mobile number verified and ready for sign-in.');
    }
  } catch (error) {
    if (!identityDialogFlowIsCurrent(generation)) return;
    setIdentityDialogStatus(error.message || 'That code could not be verified.');
  } finally {
    if (identityDialogFlowIsCurrent(generation)) {
      setIdentityDialogBusy(false, button);
      button.textContent = 'Verify';
    }
  }
});

settingsElement('identity-dialog-close').addEventListener('click', () => closeIdentityDialog());
settingsElement('identity-dialog').addEventListener('cancel', event => {
  event.preventDefault();
  closeIdentityDialog();
});
settingsElement('identity-dialog').addEventListener('click', event => {
  const dialog = event.currentTarget;
  if (event.target !== dialog) return;
  const bounds = dialog.getBoundingClientRect();
  const outside = event.clientX < bounds.left || event.clientX > bounds.right ||
    event.clientY < bounds.top || event.clientY > bounds.bottom;
  if (outside) closeIdentityDialog();
});

api('/api/auth/me').then(({ organizer }) => {
  populateSettings(organizer);
  showSettings();
  loadAccountIdentities();
  if (organizer.avatar_url) api('/api/me/link-rsvps', { method: 'POST' }).catch(() => {});
  if (organizer.is_admin) {
    const nav = document.querySelector('.sg-nav-links');
    nav.insertAdjacentHTML('beforeend', '<a href="/admin">Admin</a>');
  }
  loadSmsCredits().then(showCheckoutReturn);
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
  button.disabled = true;
  status.textContent = 'Optimizing your photo…';
  try {
    const uploadFile = await window.SGImageOptimizer.optimizeAvatar(file);
    const form = new FormData();
    form.append('image', uploadFile);
    status.textContent = 'Saving your photo…';
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

const hostFollowShareDialog = settingsElement('host-follow-share-dialog');
const hostFollowNativeShareMedia = typeof window.matchMedia === 'function'
  ? window.matchMedia('(hover: none) and (pointer: coarse)')
  : { matches: false };
let hostFollowShareReturnFocus = null;

function hostFollowShareDetails() {
  const url = settingsElement('host-follow-share-url').value;
  const hostName = currentOrganizer?.org_name || currentOrganizer?.name || 'my events';
  const title = `Follow ${hostName}`;
  const message = `Follow ${hostName} on Silver Glider Events for new-event updates.`;
  return { url, title, message };
}

async function copyHostFollowLink({ selectOnFailure = true } = {}) {
  const { url } = hostFollowShareDetails();
  if (!url) return false;
  let copied = false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(url);
      copied = true;
    }
  } catch (_) {}
  if (!copied) {
    const fallback = document.createElement('textarea');
    fallback.value = url;
    fallback.setAttribute('readonly', '');
    fallback.style.position = 'fixed';
    fallback.style.opacity = '0';
    document.body.appendChild(fallback);
    fallback.select();
    try { copied = document.execCommand('copy'); } catch (_) {}
    fallback.remove();
  }
  if (copied) {
    settingsElement('host-follow-share-status').textContent = 'Follow link copied.';
  } else if (selectOnFailure) {
    settingsElement('host-follow-share-url').select();
    settingsElement('host-follow-share-status').textContent = 'Link selected. Copy it from the field.';
  }
  return copied;
}

function prepareHostFollowShareDialog() {
  const { url, title, message } = hostFollowShareDetails();
  const encodedUrl = encodeURIComponent(url);
  const encodedMessage = encodeURIComponent(message);
  const mediaUrl = currentOrganizer?.header_image_url || currentOrganizer?.logo_url || '';
  settingsElement('host-follow-share-email').href = `mailto:?subject=${encodeURIComponent(title)}&body=${encodeURIComponent(`${message}\n\n${url}`)}`;
  settingsElement('host-follow-share-pinterest').href = `https://www.pinterest.com/pin/create/button/?url=${encodedUrl}&description=${encodedMessage}${mediaUrl ? `&media=${encodeURIComponent(mediaUrl)}` : ''}`;
  settingsElement('host-follow-share-facebook').href = `https://www.facebook.com/sharer/sharer.php?u=${encodedUrl}`;
  settingsElement('host-follow-share-x').href = `https://twitter.com/intent/tweet?text=${encodedMessage}&url=${encodedUrl}`;
}

function openHostFollowShareDialog() {
  if (!hostFollowShareDetails().url) return;
  if (typeof hostFollowShareDialog.showModal !== 'function') {
    copyHostFollowLink();
    return;
  }
  prepareHostFollowShareDialog();
  hostFollowShareReturnFocus = document.activeElement;
  try {
    hostFollowShareDialog.showModal();
  } catch (_) {
    hostFollowShareReturnFocus = null;
    copyHostFollowLink();
    return;
  }
  document.body.classList.add('host-share-dialog-open');
  settingsElement('host-follow-share-dialog-close').focus();
}

function closeHostFollowShareDialog() {
  if (!hostFollowShareDialog.open) return;
  hostFollowShareDialog.close();
}

settingsElement('host-follow-copy').addEventListener('click', () => copyHostFollowLink());
settingsElement('host-follow-share-copy-dialog').addEventListener('click', async () => {
  const copied = await copyHostFollowLink({ selectOnFailure: false });
  closeHostFollowShareDialog();
  if (!copied) {
    window.requestAnimationFrame(() => {
      settingsElement('host-follow-share-url').focus();
      settingsElement('host-follow-share-url').select();
      settingsElement('host-follow-share-status').textContent = 'Link selected. Copy it from the field.';
    });
  }
});
settingsElement('host-follow-native-share').addEventListener('click', async () => {
  const { url, title } = hostFollowShareDetails();
  if (!url) return;
  const shareData = { title, url };
  const canUseNativeShare = hostFollowNativeShareMedia.matches
    && typeof navigator.share === 'function'
    && (typeof navigator.canShare !== 'function' || navigator.canShare(shareData));
  if (!canUseNativeShare) return openHostFollowShareDialog();
  try { await navigator.share(shareData); }
  catch (error) { if (error.name !== 'AbortError') openHostFollowShareDialog(); }
});
settingsElement('host-follow-share-dialog-close').addEventListener('click', closeHostFollowShareDialog);
hostFollowShareDialog.addEventListener('close', () => {
  document.body.classList.remove('host-share-dialog-open');
  hostFollowShareReturnFocus?.focus();
  hostFollowShareReturnFocus = null;
});
hostFollowShareDialog.addEventListener('click', event => {
  if (event.target !== hostFollowShareDialog) return;
  const bounds = hostFollowShareDialog.getBoundingClientRect();
  const outside = event.clientX < bounds.left || event.clientX > bounds.right
    || event.clientY < bounds.top || event.clientY > bounds.bottom;
  if (outside) closeHostFollowShareDialog();
});
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || !hostFollowShareDialog.open) return;
  event.preventDefault();
  closeHostFollowShareDialog();
});
hostFollowShareDialog.querySelectorAll('a').forEach(link => {
  link.addEventListener('click', closeHostFollowShareDialog);
});

settingsElement('sms-credit-continue').addEventListener('click', startStripeCheckout);

document.querySelectorAll('.settings-logout').forEach(button => {
  button.addEventListener('click', async () => {
    try { await api('/api/auth/logout', { method: 'POST' }); } catch (_) {}
    window.location.href = '/login';
  });
});

document.getElementById('logout-all-btn')?.addEventListener('click', async event => {
  if (!confirm('Sign out on every device and remove phone sign-in? You can verify your phone again next time.')) return;
  const button = event.currentTarget;
  button.disabled = true;
  button.textContent = 'Signing out…';
  try { await api('/api/auth/logout-all', { method: 'POST' }); } catch (_) {}
  window.location.href = '/login';
});
