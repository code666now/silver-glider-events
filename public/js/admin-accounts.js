/* Admin Accounts & Support — safe account lookup and audited support actions. */

renderNav('');

const state = {
  accounts: [],
  selectedId: null,
  selected: null,
  detail: null,
  nextCursor: null,
  requestId: 0,
  action: null
};

const list = document.getElementById('accounts-list');
const empty = document.getElementById('accounts-empty');
const detailDialog = document.getElementById('account-detail-dialog');
const actionDialog = document.getElementById('support-action-dialog');
const invitationDialog = document.getElementById('invitation-dialog');
const search = document.getElementById('account-search');
const kindFilter = document.getElementById('account-kind');
const statusFilter = document.getElementById('account-status');
const loadMoreButton = document.getElementById('accounts-load-more');
const dialogReturnFocus = new Map();

function showDialog(dialog, trigger = document.activeElement) {
  if (!dialog.open) {
    if (trigger instanceof HTMLElement) dialogReturnFocus.set(dialog, trigger);
    dialog.showModal();
  }
}

function restoreDialogFocus(dialog) {
  let target = dialogReturnFocus.get(dialog);
  dialogReturnFocus.delete(dialog);
  if ((!target || !target.isConnected) && dialog === detailDialog && state.selectedId != null) {
    target = Array.from(list.querySelectorAll('[data-account-id]')).find(row => String(row.dataset.accountId) === String(state.selectedId));
  }
  if (target?.isConnected) requestAnimationFrame(() => target.focus());
}

function esc(value) { return sgEscapeHtml(value); }

function asArray(value) { return Array.isArray(value) ? value : []; }

function firstValue(object, keys, fallback = null) {
  for (const key of keys) {
    if (object && object[key] !== undefined && object[key] !== null) return object[key];
  }
  return fallback;
}

function numberValue(object, keys, fallback = 0) {
  const value = Number(firstValue(object, keys, fallback));
  return Number.isFinite(value) ? value : fallback;
}

function formatDate(value, includeTime = false) {
  if (!value) return 'Never';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Unknown';
  return date.toLocaleString('en-US', includeTime
    ? { month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit' }
    : { month:'short',day:'numeric',year:'numeric' });
}

function accountId(account) {
  return firstValue(account, ['user_id', 'userId', 'id']);
}

function accountName(account) {
  return String(firstValue(account, ['name', 'display_name', 'displayName', 'org_name'], 'Unnamed account')).trim() || 'Unnamed account';
}

function alreadyMasked(value) {
  return /[•*]/.test(String(value || ''));
}

function maskEmail(value) {
  const raw = String(value || '').trim();
  if (!raw) return 'No email';
  if (alreadyMasked(raw)) return raw;
  const at = raw.lastIndexOf('@');
  if (at < 1) return 'Email on file';
  const local = raw.slice(0, at);
  const domain = raw.slice(at + 1);
  const visible = local.length > 1 ? local[0] : '';
  return `${visible}${visible ? '•••' : '••••'}@${domain}`;
}

function maskPhone(value) {
  const raw = String(value || '').trim();
  if (!raw) return 'No mobile number';
  if (alreadyMasked(raw)) return raw;
  const digits = raw.replace(/\D/g, '');
  return digits.length >= 4 ? `••• ••• ${digits.slice(-4)}` : 'Mobile number on file';
}

function maskedAccountEmail(account) {
  return maskEmail(firstValue(account, ['primary_email_masked', 'email_masked', 'primary_email', 'email']));
}

function maskedAccountPhone(account) {
  return maskPhone(firstValue(account, ['primary_phone_masked', 'phone_masked', 'primary_phone', 'phone']));
}

function statusOf(account) {
  const explicit = String(firstValue(account, ['status', 'account_status'], '')).toLowerCase();
  if (explicit === 'suspended' || account?.suspended_at) return 'suspended';
  if (explicit === 'invited' || explicit === 'pending' || account?.claimed_at === null || account?.is_claimed === false) return 'invited';
  if (explicit === 'inactive') return 'inactive';
  return 'active';
}

function statusLabel(account) {
  const status = statusOf(account);
  return status === 'suspended' ? 'Suspended' : status === 'invited' ? 'Invited' : status === 'inactive' ? 'Inactive' : 'Active';
}

function kindOf(account) {
  if (account?.is_admin || String(account?.role || '').toLowerCase() === 'admin') return 'Administrator';
  if (account?.has_host_page || account?.public_slug || numberValue(account, ['event_count', 'events_count']) > 0) return 'Host';
  return 'Guest';
}

function hostPageName(account) {
  return firstValue(account, ['host_page_name', 'org_name', 'host_name'], null);
}

function setSummary(summary = {}, accounts = []) {
  const values = {
    total: numberValue(summary, ['total', 'total_accounts', 'account_count'], accounts.length),
    active: numberValue(summary, ['active_30_days', 'active_in_30_days', 'recently_active'], accounts.filter(account => {
      const value = firstValue(account, ['last_login_at', 'last_active_at']);
      return value && new Date(value).getTime() >= Date.now() - (30 * 86400000);
    }).length),
    hosts: numberValue(summary, ['host_pages', 'hosts', 'host_count'], accounts.filter(account => kindOf(account) === 'Host').length),
    suspended: numberValue(summary, ['suspended', 'suspended_accounts'], accounts.filter(account => statusOf(account) === 'suspended').length)
  };
  document.getElementById('summary-total').textContent = values.total.toLocaleString();
  document.getElementById('summary-active').textContent = values.active.toLocaleString();
  document.getElementById('summary-hosts').textContent = values.hosts.toLocaleString();
  document.getElementById('summary-suspended').textContent = values.suspended.toLocaleString();
  document.querySelector('.accounts-summary').setAttribute('aria-busy', 'false');
}

function accountRow(account) {
  const id = accountId(account);
  const events = numberValue(account, ['event_count', 'events_count']);
  const rsvps = numberValue(account, ['rsvp_count', 'rsvps_count']);
  const page = hostPageName(account);
  const status = statusOf(account);
  const lastActive = firstValue(account, ['last_login_at', 'last_active_at']);
  return `<button class="accounts-row" type="button" data-account-id="${esc(id)}" aria-label="Open ${esc(accountName(account))} account">
    <span class="accounts-row-person"><strong>${esc(accountName(account))}</strong><span>User ID ${esc(id)}</span></span>
    <span class="accounts-row-account"><strong>${esc(maskedAccountEmail(account))}</strong><span>${esc(maskedAccountPhone(account))}</span></span>
    <span class="accounts-row-activity"><strong>${esc(lastActive ? formatDate(lastActive) : 'No sign-in yet')}</strong><span>${rsvps} RSVP${rsvps === 1 ? '' : 's'}</span></span>
    <span class="accounts-row-property"><strong>${esc(page || kindOf(account))}</strong><span>${events} event${events === 1 ? '' : 's'}</span></span>
    <span class="accounts-row-status"><span class="accounts-status-badge ${status}">${esc(statusLabel(account))}</span></span>
    <span class="accounts-row-arrow"><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="m9 18 6-6-6-6"></path></svg></span>
  </button>`;
}

function bindAccountRows() {
  list.querySelectorAll('[data-account-id]').forEach(row => row.addEventListener('click', () => openAccount(row.dataset.accountId, row)));
}

function renderAccounts() {
  empty.hidden = state.accounts.length > 0;
  list.classList.remove('admin-skeleton-stack');
  list.innerHTML = state.accounts.map(accountRow).join('');
  document.getElementById('accounts-result-count').textContent = `${state.accounts.length.toLocaleString()} shown`;
  loadMoreButton.hidden = !state.nextCursor;
  bindAccountRows();
}

function loadingRows() {
  return `<div class="admin-skeleton-card admin-skeleton-row" aria-hidden="true"><span class="admin-skeleton-copy"><span class="sg-skeleton admin-skeleton-title"></span><span class="sg-skeleton admin-skeleton-meta"></span></span><span class="sg-skeleton admin-skeleton-action"></span></div><div class="admin-skeleton-card admin-skeleton-row" aria-hidden="true"><span class="admin-skeleton-copy"><span class="sg-skeleton admin-skeleton-title"></span><span class="sg-skeleton admin-skeleton-meta"></span></span><span class="sg-skeleton admin-skeleton-action"></span></div><div class="admin-skeleton-card admin-skeleton-row" aria-hidden="true"><span class="admin-skeleton-copy"><span class="sg-skeleton admin-skeleton-title"></span><span class="sg-skeleton admin-skeleton-meta"></span></span><span class="sg-skeleton admin-skeleton-action"></span></div>`;
}

async function loadAccounts({ append = false } = {}) {
  const requestId = ++state.requestId;
  const params = new URLSearchParams({ limit: '50' });
  if (search.value.trim()) params.set('q', search.value.trim());
  if (kindFilter.value) params.set('type', kindFilter.value);
  if (statusFilter.value) params.set('status', statusFilter.value);
  if (append && state.nextCursor) params.set('cursor', state.nextCursor);

  if (!append) {
    list.classList.add('admin-skeleton-stack');
    list.setAttribute('aria-busy', 'true');
    list.innerHTML = loadingRows();
    empty.hidden = true;
    loadMoreButton.hidden = true;
  } else {
    loadMoreButton.disabled = true;
    loadMoreButton.textContent = 'Loading…';
  }

  try {
    const data = await api(`/api/admin/accounts?${params}`);
    if (requestId !== state.requestId) return;
    const accounts = asArray(data.accounts || data.users || data.results);
    state.accounts = append ? [...state.accounts, ...accounts] : accounts;
    state.nextCursor = firstValue(data, ['nextCursor', 'next_cursor', 'cursor'], null);
    setSummary(data.summary || data.counts || {}, state.accounts);
    renderAccounts();
    [search, kindFilter, statusFilter].forEach(control => { control.disabled = false; });
  } catch (error) {
    if (requestId !== state.requestId) return;
    if (!append) {
      ['summary-total','summary-active','summary-hosts','summary-suspended'].forEach(id => { document.getElementById(id).textContent = '—'; });
      document.querySelector('.accounts-summary').setAttribute('aria-busy', 'false');
      list.innerHTML = `<div class="admin-load-error"><strong>We couldn't load accounts.</strong><p>${esc(error.message)}</p><button class="sg-btn sg-btn-ghost" id="retry-accounts" type="button">Try again</button></div>`;
      document.getElementById('retry-accounts').addEventListener('click', () => loadAccounts());
    } else {
      toast(error.message);
    }
  } finally {
    if (requestId === state.requestId) {
      list.setAttribute('aria-busy', 'false');
      loadMoreButton.disabled = false;
      loadMoreButton.textContent = 'Load more';
    }
  }
}

function normalizeIdentities(data, account) {
  if (Array.isArray(data.identities)) return data.identities;
  if (Array.isArray(account.identities)) return account.identities;
  return [
    ...asArray(data.emails || account.emails).map(item => typeof item === 'string' ? { type:'email', value:item, verified:true } : { type:'email', ...item }),
    ...asArray(data.phones || account.phones).map(item => typeof item === 'string' ? { type:'phone', value:item, verified:true } : { type:'phone', ...item })
  ];
}

function identityType(identity) {
  return String(firstValue(identity, ['type', 'identity_type', 'kind'], 'email')).toLowerCase().includes('phone') ? 'phone' : 'email';
}

function identityMaskedValue(identity) {
  const type = identityType(identity);
  const value = firstValue(identity, ['masked_value', 'maskedValue', 'display_value', 'value', 'normalized_value'], '');
  return type === 'phone' ? maskPhone(value) : maskEmail(value);
}

function renderIdentities(identities, account) {
  const items = identities.length ? identities : [
    { type:'email', value:firstValue(account, ['primary_email_masked','email_masked','primary_email','email']), is_primary:true, verified:true },
    ...(firstValue(account, ['primary_phone_masked','phone_masked','primary_phone','phone']) ? [{ type:'phone', value:firstValue(account, ['primary_phone_masked','phone_masked','primary_phone','phone']), is_primary:true, verified:true }] : [])
  ];
  const emailIcon = '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="5" width="18" height="14" rx="2"></rect><path d="m4 7 8 6 8-6"></path></svg>';
  const phoneIcon = '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="7" y="2.5" width="10" height="19" rx="2.5"></rect><path d="M10.5 18.5h3"></path></svg>';
  document.getElementById('account-identities').innerHTML = items.length ? items.map(identity => {
    const type = identityType(identity);
    const primary = Boolean(firstValue(identity, ['is_primary', 'isPrimary', 'primary'], false));
    const verified = firstValue(
      identity,
      ['verified', 'is_verified', 'isVerified'],
      Boolean(identity.verified_at || identity.verifiedAt || identity.verification_scope === 'account' || identity.verificationScope === 'account')
    );
    const helper = `${primary ? 'Primary' : 'Recovery'} ${type === 'phone' ? 'mobile number' : 'email'}`;
    return `<div class="accounts-identity-row">
      <span class="accounts-identity-icon">${type === 'phone' ? phoneIcon : emailIcon}</span>
      <span class="accounts-identity-copy"><strong>${esc(identityMaskedValue(identity))}</strong><span>${esc(helper)}</span></span>
      <span class="accounts-identity-state">${verified === false ? 'Unverified' : 'Verified'}</span>
    </div>`;
  }).join('') : '<p class="accounts-muted-empty">No verified sign-in methods are available.</p>';
}

function ownershipValue(ownership, account, keys, fallback = 0) {
  return firstValue(ownership, keys, firstValue(account, keys, fallback));
}

function normalizeHostPage(ownership, account) {
  return ownership.host_page || ownership.hostPage || account.host_page || (account.public_slug || account.org_name ? account : null);
}

function renderOwnership(ownership, account) {
  const hostPage = normalizeHostPage(ownership, account);
  const events = Number(ownershipValue(ownership, account, ['event_count','events_count'], asArray(ownership.events).length)) || 0;
  const rsvps = Number(ownershipValue(ownership, account, ['rsvp_count','rsvps_count'], 0)) || 0;
  const followers = Number(ownershipValue(ownership, account, ['follower_count','followers_count'], 0)) || 0;
  const photos = Number(ownershipValue(ownership, account, ['photo_count','photos_count'], 0)) || 0;
  const rawSessions = ownershipValue(
    ownership,
    account,
    ['active_session_count','session_count','sessions_count'],
    null
  );
  const sessions = rawSessions == null
    ? 'Not individually tracked'
    : (Number(rawSessions) || 0);
  const conflicts = Number(ownershipValue(ownership, account, ['identity_conflict_count','conflict_count'], 0)) || 0;
  const property = [
    ['Host Page', hostPage ? firstValue(hostPage, ['org_name','name','host_name'], 'Created') : 'None', hostPage?.public_slug ? `/h/${hostPage.public_slug}` : ''],
    ['Hosted events', events, ''],
    ['Guest RSVPs', rsvps, ''],
    ['Followers', followers, ''],
    ['Photos', photos, ''],
    ['Signed-in devices', sessions, ''],
    ['Identity review', conflicts ? `${conflicts} flagged` : 'Clear', ''],
    ['Plan', String(firstValue(account, ['plan'], 'free')).replace(/^./, char => char.toUpperCase()), '']
  ];
  document.getElementById('account-property').innerHTML = property.map(([label,value,path]) => `<div class="accounts-property-card"><span>${esc(label)}</span><strong>${path ? `<a href="${esc(path)}" target="_blank" rel="noopener">${esc(value)}</a>` : esc(value)}</strong>${path ? '<small>Open public page</small>' : ''}</div>`).join('');
  configureHostProfile(hostPage, account);
}

function hostOrganizerId(hostPage, account) {
  return firstValue(hostPage, ['organizer_id','organizerId'], firstValue(account, ['organizer_id','organizerId','host_organizer_id'], null));
}

function configureHostProfile(hostPage, account) {
  const details = document.getElementById('host-profile-details');
  const organizerId = hostOrganizerId(hostPage, account);
  if (!hostPage || !organizerId) {
    details.hidden = true;
    details.dataset.organizerId = '';
    return;
  }
  details.hidden = false;
  details.dataset.organizerId = organizerId;
  document.getElementById('host-profile-name').value = firstValue(hostPage, ['org_name','name','host_name'], '');
  document.getElementById('host-profile-website').value = firstValue(hostPage, ['website_url','websiteUrl'], '');
  document.getElementById('host-profile-bio').value = firstValue(hostPage, ['bio'], '');
  const instagram = firstValue(hostPage, ['instagram_handle','instagramHandle'], '');
  document.getElementById('host-profile-instagram').value = instagram ? `@${String(instagram).replace(/^@/, '')}` : '';
  document.getElementById('host-profile-status').textContent = '';
}

function renderNotes(notes) {
  document.getElementById('account-notes').innerHTML = notes.length ? notes.map(note => {
    const text = firstValue(note, ['note','body','message'], '');
    const author = firstValue(note, ['admin_name','actor_name','created_by_name','actor'], 'Administrator');
    return `<article class="accounts-note-card"><p>${esc(text)}</p><footer>${esc(author)} · ${esc(formatDate(firstValue(note, ['created_at','createdAt']), true))}</footer></article>`;
  }).join('') : '<p class="accounts-muted-empty">No internal notes yet.</p>';
}

function renderAudit(audit) {
  document.getElementById('account-audit').innerHTML = audit.length ? audit.map(item => {
    const rawAction = firstValue(item, ['label','action_label','action','event'], 'Account updated');
    const action = String(rawAction).replace(/_/g, ' ').replace(/^./, character => character.toUpperCase());
    const actor = firstValue(item, ['actor_name','admin_name','actor'], 'Silver Glider');
    const reason = firstValue(item, ['reason','details','description'], '');
    const date = formatDate(firstValue(item, ['created_at','createdAt','timestamp']), true);
    return `<li class="accounts-timeline-item"><strong>${esc(action)}</strong><p>${esc(`${actor} · ${date}${reason ? ` · ${reason}` : ''}`)}</p></li>`;
  }).join('') : '<li class="accounts-muted-empty">No support actions have been recorded yet.</li>';
}

function detailCollections(data, account) {
  const ownership = { ...(data.ownership || data.property || data.owned || {}) };
  const sessions = asArray(data.sessions || data.active_sessions);
  if (ownership.active_session_count === undefined) ownership.active_session_count = numberValue(data, ['active_session_count','session_count'], sessions.length);
  if (ownership.identity_conflict_count === undefined) ownership.identity_conflict_count = numberValue(data, ['identity_conflict_count','conflict_count'], 0);
  return {
    identities: normalizeIdentities(data, account),
    ownership,
    notes: asArray(data.notes || data.support_notes || account.notes),
    audit: asArray(data.audit || data.audit_log || data.activity || data.history)
  };
}

function renderDetail(data) {
  const account = data.account || data.user || data.organizer || data;
  const collections = detailCollections(data, account);
  state.selected = account;
  state.detail = data;
  state.selectedId = accountId(account);
  document.getElementById('account-detail-title').textContent = accountName(account);
  document.getElementById('account-detail-meta').textContent = `${kindOf(account)} · User ID ${state.selectedId}`;
  document.getElementById('account-detail-kicker').textContent = 'Account support';
  const badge = document.getElementById('account-detail-status');
  badge.className = `accounts-status-badge ${statusOf(account)}`;
  badge.textContent = statusLabel(account);
  renderIdentities(collections.identities, account);
  renderOwnership(collections.ownership, account);
  renderNotes(collections.notes);
  renderAudit(collections.audit);
  document.getElementById('account-display-name').value = accountName(account);
  document.getElementById('account-profile-reason').value = '';
  document.getElementById('account-profile-status').textContent = '';

  const statusAction = document.getElementById('account-status-action');
  const suspended = statusOf(account) === 'suspended';
  statusAction.textContent = suspended ? 'Reactivate account' : 'Suspend account';
  statusAction.className = `sg-btn ${suspended ? 'sg-btn-ghost' : 'sg-btn-danger'}`;
  statusAction.dataset.action = suspended ? 'reactivate' : 'suspend';
  statusAction.disabled = account.can_suspend === false && !suspended;
  document.getElementById('account-sign-out-all').disabled = account.can_sign_out === false;
  document.getElementById('account-detail-loading').hidden = true;
  document.getElementById('account-detail-error').hidden = true;
  document.getElementById('account-detail-body').hidden = false;
}

async function fetchAccount(id) {
  return api(`/api/admin/accounts/${encodeURIComponent(id)}`);
}

async function openAccount(id, trigger) {
  state.selectedId = id;
  document.getElementById('account-detail-body').hidden = true;
  document.getElementById('account-detail-error').hidden = true;
  document.getElementById('account-detail-loading').hidden = false;
  document.getElementById('account-detail-title').textContent = 'Loading account…';
  document.getElementById('account-detail-meta').textContent = '';
  showDialog(detailDialog, trigger);
  try {
    renderDetail(await fetchAccount(id));
  } catch (error) {
    document.getElementById('account-detail-loading').hidden = true;
    const panel = document.getElementById('account-detail-error');
    panel.hidden = false;
    panel.innerHTML = `<strong>We couldn't open this account.</strong><p>${esc(error.message)}</p>`;
  }
}

function closeDetail() {
  if (detailDialog.open) detailDialog.close();
}

function openSupportAction(action) {
  if (!state.selectedId) return;
  const name = accountName(state.selected || {});
  const copy = {
    signOut: {
      title: 'Sign out every device?',
      description: `${name} will need to verify a sign-in method before accessing the account again.`,
      button: 'Sign out everywhere',
      endpoint: 'sign-out-all',
      method: 'POST'
    },
    suspend: {
      title: 'Suspend this account?',
      description: `${name} will lose access immediately. Their events and Host Page stay preserved while support reviews the account.`,
      button: 'Suspend account',
      endpoint: 'suspend',
      method: 'POST'
    },
    reactivate: {
      title: 'Reactivate this account?',
      description: `${name} can sign in again after this change. Existing property remains attached to the same user ID.`,
      button: 'Reactivate account',
      endpoint: 'reactivate',
      method: 'POST'
    }
  }[action];
  if (!copy) return;
  state.action = { action, ...copy };
  document.getElementById('support-action-title').textContent = copy.title;
  document.getElementById('support-action-description').textContent = copy.description;
  document.getElementById('support-action-reason').value = '';
  const confirm = document.getElementById('confirm-support-action');
  confirm.textContent = copy.button;
  confirm.className = `sg-btn ${action === 'reactivate' ? 'sg-btn-primary' : 'sg-btn-danger'}`;
  setFormError('support-action-error', '');
  showDialog(actionDialog);
  requestAnimationFrame(() => document.getElementById('support-action-reason').focus());
}

function setFormError(id, message) {
  const el = document.getElementById(id);
  el.textContent = message || '';
  el.classList.toggle('visible', Boolean(message));
}

async function submitSupportAction(event) {
  event.preventDefault();
  if (!state.action || !state.selectedId) return;
  const reason = document.getElementById('support-action-reason').value.trim();
  if (reason.length < 8) {
    setFormError('support-action-error', 'Please add a short reason for the permanent audit record.');
    return;
  }
  const button = document.getElementById('confirm-support-action');
  const original = button.textContent;
  button.disabled = true;
  button.textContent = 'Saving…';
  try {
    await api(`/api/admin/accounts/${encodeURIComponent(state.selectedId)}/${state.action.endpoint}`, { method:state.action.method,body:{ reason } });
    actionDialog.close();
    toast(`${original} complete`);
    await Promise.all([loadAccounts(), openAccount(state.selectedId)]);
  } catch (error) {
    setFormError('support-action-error', error.message);
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

async function submitNote(event) {
  event.preventDefault();
  if (!state.selectedId) return;
  const field = document.getElementById('account-note');
  const note = field.value.trim();
  if (note.length < 3) return;
  const button = document.getElementById('save-account-note');
  button.disabled = true;
  button.textContent = 'Saving…';
  try {
    await api(`/api/admin/accounts/${encodeURIComponent(state.selectedId)}/notes`, { method:'POST',body:{ note } });
    field.value = '';
    toast('Support note added');
    renderDetail(await fetchAccount(state.selectedId));
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
    button.textContent = 'Add note';
  }
}

async function submitHostProfile(event) {
  event.preventDefault();
  const details = document.getElementById('host-profile-details');
  const organizerId = details.dataset.organizerId;
  if (!organizerId) return;
  const button = document.getElementById('save-host-profile');
  const status = document.getElementById('host-profile-status');
  button.disabled = true;
  status.textContent = 'Saving…';
  try {
    await api(`/api/admin/hosts/${encodeURIComponent(organizerId)}/profile`, {
      method:'PUT',
      body:{
        org_name:document.getElementById('host-profile-name').value,
        website_url:document.getElementById('host-profile-website').value,
        bio:document.getElementById('host-profile-bio').value,
        instagram_handle:document.getElementById('host-profile-instagram').value
      }
    });
    status.textContent = 'Public profile saved.';
    toast('Host Page updated');
    await Promise.all([loadAccounts(), openAccount(state.selectedId)]);
  } catch (error) {
    status.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

async function submitAccountProfile(event) {
  event.preventDefault();
  if (!state.selectedId) return;
  const name = document.getElementById('account-display-name').value.trim();
  const reason = document.getElementById('account-profile-reason').value.trim();
  const button = document.getElementById('save-account-profile');
  const status = document.getElementById('account-profile-status');
  if (!name) return;
  if (reason.length < 8) {
    status.textContent = 'Add a short reason for the audit record.';
    document.getElementById('account-profile-reason').focus();
    return;
  }
  button.disabled = true;
  status.textContent = 'Saving…';
  try {
    await api(`/api/admin/accounts/${encodeURIComponent(state.selectedId)}/profile`, { method:'PATCH',body:{ name,reason } });
    status.textContent = 'Display name saved.';
    toast('Account name updated');
    await Promise.all([loadAccounts(), openAccount(state.selectedId)]);
  } catch (error) {
    status.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

function openInvitation() {
  document.getElementById('invitation-form').reset();
  setFormError('invitation-error', '');
  showDialog(invitationDialog);
  requestAnimationFrame(() => document.getElementById('invitation-name').focus());
}

async function submitInvitation(event) {
  event.preventDefault();
  const button = document.getElementById('send-invitation');
  const body = {
    name:document.getElementById('invitation-name').value.trim(),
    email:document.getElementById('invitation-email').value.trim(),
    prepareHostPage:document.getElementById('invitation-host-page').checked,
    prepare_host_page:document.getElementById('invitation-host-page').checked
  };
  button.disabled = true;
  button.textContent = 'Sending…';
  setFormError('invitation-error', '');
  try {
    await api('/api/admin/accounts/invitations', { method:'POST',body });
    invitationDialog.close();
    toast('Secure setup invitation sent');
    await loadAccounts();
  } catch (error) {
    setFormError('invitation-error', error.message);
  } finally {
    button.disabled = false;
    button.textContent = 'Send secure invitation';
  }
}

let filterTimer = null;
function scheduleSearch() {
  clearTimeout(filterTimer);
  filterTimer = setTimeout(() => loadAccounts(), 250);
}

search.addEventListener('input', scheduleSearch);
kindFilter.addEventListener('change', () => loadAccounts());
statusFilter.addEventListener('change', () => loadAccounts());
loadMoreButton.addEventListener('click', () => loadAccounts({ append:true }));
document.getElementById('open-invitation').addEventListener('click', openInvitation);
document.getElementById('cancel-invitation').addEventListener('click', () => invitationDialog.close());
document.getElementById('invitation-form').addEventListener('submit', submitInvitation);
document.getElementById('close-account-detail').addEventListener('click', closeDetail);
document.getElementById('account-sign-out-all').addEventListener('click', () => openSupportAction('signOut'));
document.getElementById('account-status-action').addEventListener('click', event => openSupportAction(event.currentTarget.dataset.action));
document.getElementById('cancel-support-action').addEventListener('click', () => actionDialog.close());
document.getElementById('support-action-form').addEventListener('submit', submitSupportAction);
document.getElementById('account-note-form').addEventListener('submit', submitNote);
document.getElementById('account-profile-form').addEventListener('submit', submitAccountProfile);
document.getElementById('host-profile-form').addEventListener('submit', submitHostProfile);

[detailDialog, actionDialog, invitationDialog].forEach(dialog => {
  dialog.addEventListener('click', event => {
    if (event.target === dialog) dialog.close();
  });
  dialog.addEventListener('close', () => restoreDialogFocus(dialog));
});

loadAccounts();
