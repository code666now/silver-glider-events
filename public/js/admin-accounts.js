/* Admin Accounts & Support — safe account lookup and audited support actions. */

renderNav('');

const state = {
  accounts: [],
  selectedId: null,
  selected: null,
  detail: null,
  nextCursor: null,
  requestId: 0,
  action: null,
  identityChangeType: null,
  canManageIdentities: false,
  identityChangeRequests: [],
  audit: [],
  deletion: null,
  deleteRequest: null
};

const list = document.getElementById('accounts-list');
const empty = document.getElementById('accounts-empty');
const detailDialog = document.getElementById('account-detail-dialog');
const actionDialog = document.getElementById('support-action-dialog');
const identityChangeDialog = document.getElementById('identity-change-dialog');
const invitationDialog = document.getElementById('invitation-dialog');
const deleteDialog = document.getElementById('delete-account-dialog');
const search = document.getElementById('account-search');
const kindFilter = document.getElementById('account-kind');
const statusFilter = document.getElementById('account-status');
const loadMoreButton = document.getElementById('accounts-load-more');
const dialogReturnFocus = new Map();

const initialFilters = new URLSearchParams(location.search);
const initialKind = initialFilters.get('type') || initialFilters.get('kind') || '';
const initialStatus = initialFilters.get('status') || '';
if ([...kindFilter.options].some(option => option.value === initialKind)) kindFilter.value = initialKind;
if ([...statusFilter.options].some(option => option.value === initialStatus)) statusFilter.value = initialStatus;
search.value = initialFilters.get('q') || '';

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

function displayEmail(value) {
  const raw = String(value || '').trim();
  return raw || 'No email on file';
}

function displayPhone(value) {
  const raw = String(value || '').trim();
  return raw || 'No phone on file';
}

function accountEmailValue(account) {
  return displayEmail(firstValue(account, [
    'primary_email', 'verified_email', 'email', 'contactEmail', 'contact_email',
    'primary_email_masked', 'email_masked'
  ]));
}

function accountPhoneValue(account) {
  return displayPhone(firstValue(account, [
    'primary_phone', 'verified_phone', 'phone', 'contactPhone', 'contact_phone',
    'primary_phone_masked', 'phone_masked'
  ]));
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
  const email = accountEmailValue(account);
  const phone = accountPhoneValue(account);
  const emailLabel = firstValue(account, ['emailLabel', 'email_label'], email === 'No email on file' ? 'No email on file' : 'Email');
  const phoneLabel = firstValue(account, ['phoneLabel', 'phone_label'], phone === 'No phone on file' ? 'No phone on file' : 'Phone');
  return `<button class="accounts-row" type="button" data-account-id="${esc(id)}" aria-label="Open ${esc(accountName(account))} account">
    <span class="accounts-row-person"><strong>${esc(accountName(account))}</strong><span>User ID ${esc(id)}</span></span>
    <span class="accounts-row-account"><strong aria-label="${esc(`${emailLabel}: ${email}`)}">${esc(email)}</strong><span aria-label="${esc(`${phoneLabel}: ${phone}`)}">${esc(phone)}</span></span>
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
  const hasExplicitIdentities = Array.isArray(data.identities) || Array.isArray(account.identities);
  const verified = hasExplicitIdentities
    ? asArray(data.identities || account.identities)
    : [
      ...asArray(data.emails || account.emails).map(item => typeof item === 'string' ? { type:'email', value:item, verifiedForSignIn:true } : { type:'email', ...item }),
      ...asArray(data.phones || account.phones).map(item => typeof item === 'string' ? { type:'phone', value:item, verifiedForSignIn:true } : { type:'phone', ...item })
    ];

  if (!hasExplicitIdentities) {
    const verifiedEmail = firstValue(account, ['primary_email', 'verified_email', 'email'], null);
    const verifiedPhone = firstValue(account, ['primary_phone', 'verified_phone', 'phone'], null);
    if (verifiedEmail) verified.push({ type:'email', value:verifiedEmail, verifiedForSignIn:true, isPrimary:true });
    if (verifiedPhone) verified.push({ type:'phone', value:verifiedPhone, verifiedForSignIn:true, isPrimary:true });
  }

  const contacts = asArray(data.contactMethods || data.contact_methods || account.contactMethods).map(item => ({
    verifiedForSignIn:false,
    ...item
  }));
  const contactEmail = firstValue(account, ['contactEmail', 'contact_email', 'rsvpEmail', 'rsvp_email'], null);
  const contactPhone = firstValue(account, ['contactPhone', 'contact_phone', 'rsvpPhone', 'rsvp_phone'], null);
  if (contactEmail) contacts.push({ type:'email', value:contactEmail, label:'Contact/RSVP email (not verified for sign-in)', verifiedForSignIn:false });
  if (contactPhone) contacts.push({ type:'phone', value:contactPhone, label:'Contact/RSVP phone (not verified for sign-in)', verifiedForSignIn:false });

  const seen = new Set();
  const items = [...verified, ...contacts].filter(identity => {
    const type = identityType(identity);
    const value = identityValue(identity);
    if (!value) return false;
    const normalized = type === 'email' ? value.toLowerCase() : value.replace(/\D/g, '');
    const key = `${type}:${normalized || value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const summary = data.contactSummary || data.contact_summary || {};
  for (const type of ['email', 'phone']) {
    if (items.some(identity => identityType(identity) === type)) continue;
    const item = summary[type] || {};
    const value = firstValue(item, ['value'], '');
    items.push({
      type,
      value,
      label:firstValue(item, ['label'], `No ${type} on file`),
      unavailable:!value,
      verifiedForSignIn:Boolean(firstValue(item, ['verifiedForSignIn', 'verified_for_sign_in'], false))
    });
  }
  return items;
}

function identityType(identity) {
  return String(firstValue(identity, ['type', 'identity_type', 'kind'], 'email')).toLowerCase().includes('phone') ? 'phone' : 'email';
}

function identityValue(identity) {
  return String(firstValue(identity, [
    'value', 'normalized_value', 'normalizedValue', 'full_value', 'fullValue',
    'display_value', 'displayValue', 'masked_value', 'maskedValue'
  ], '') || '').trim();
}

function identityVerifiedForSignIn(identity) {
  const explicit = firstValue(identity, [
    'verifiedForSignIn', 'verified_for_sign_in', 'verified', 'is_verified', 'isVerified'
  ], null);
  if (explicit !== null) return Boolean(explicit);
  return Boolean(identity.verified_at || identity.verifiedAt || identity.verification_scope === 'account' || identity.verificationScope === 'account');
}

function renderIdentities(identities, account) {
  const items = identities.length ? identities : [
    { type:'email', value:'', label:'No email on file', unavailable:true },
    { type:'phone', value:'', label:'No phone on file', unavailable:true }
  ];
  const emailIcon = '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="5" width="18" height="14" rx="2"></rect><path d="m4 7 8 6 8-6"></path></svg>';
  const phoneIcon = '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="7" y="2.5" width="10" height="19" rx="2.5"></rect><path d="M10.5 18.5h3"></path></svg>';
  document.getElementById('account-identities').innerHTML = items.length ? items.map(identity => {
    const type = identityType(identity);
    const value = identityValue(identity);
    const unavailable = Boolean(identity.unavailable) || !value;
    const verified = !unavailable && identityVerifiedForSignIn(identity);
    const helper = firstValue(identity, ['label'], unavailable
      ? `No ${type} on file`
      : (verified
        ? `Verified sign-in ${type}`
        : `Contact/RSVP ${type} (not verified for sign-in)`));
    const stateLabel = unavailable ? '' : (verified ? 'Verified' : 'Contact only');
    const stateClass = unavailable ? 'unavailable' : (verified ? 'verified' : 'contact');
    return `<div class="accounts-identity-row">
      <span class="accounts-identity-icon">${type === 'phone' ? phoneIcon : emailIcon}</span>
      <span class="accounts-identity-copy"><strong>${esc(unavailable ? helper : value)}</strong>${unavailable ? '' : `<span>${esc(helper)}</span>`}</span>
      ${stateLabel ? `<span class="accounts-identity-state ${stateClass}">${esc(stateLabel)}</span>` : ''}
    </div>`;
  }).join('') : '<p class="accounts-muted-empty">No verified sign-in methods are available.</p>';
}

function identityChangeStatus(request) {
  return String(firstValue(request, ['status'], 'pending') || 'pending').trim().toLowerCase();
}

function identityChangeId(request) {
  return firstValue(request, ['id', 'changeId', 'change_id'], '');
}

function identityChangeValue(request) {
  return String(firstValue(request, ['value', 'newValue', 'new_value', 'target'], '') || '').trim();
}

function identityChangeType(request) {
  return String(firstValue(request, ['type', 'identityType', 'identity_type'], 'email')).toLowerCase() === 'phone'
    ? 'phone'
    : 'email';
}

function identityChangeStatusLabel(status) {
  return {
    pending: 'Waiting for verification',
    sent: 'Waiting for verification',
    delivery_failed: 'Delivery failed',
    conflict: 'Needs attention',
    expired: 'Expired'
  }[status] || 'Waiting for verification';
}

function identityChangeTiming(request, status) {
  const createdAt = firstValue(request, ['createdAt', 'created_at'], null);
  const expiresAt = firstValue(request, ['expiresAt', 'expires_at'], null);
  if (status === 'delivery_failed') return 'The verification message could not be delivered. Review the value before resending.';
  if (status === 'conflict') return 'This value may already belong to another account. The recipient has not been verified.';
  if (status === 'expired') return `Expired${expiresAt ? ` ${formatDate(expiresAt, true)}` : ''}. Resend only after confirming the recipient still wants this change.`;
  const sent = createdAt ? `Requested ${formatDate(createdAt, true)}` : 'Verification requested';
  return `${sent}${expiresAt ? ` · Expires ${formatDate(expiresAt, true)}` : ''}`;
}

function renderIdentityChanges(requests) {
  const section = document.getElementById('account-pending-identities');
  const list = document.getElementById('account-pending-identity-list');
  const actions = document.getElementById('account-identity-actions');
  const trustNote = document.getElementById('account-identity-trust-note');
  actions.hidden = !state.canManageIdentities;
  trustNote.hidden = !state.canManageIdentities;
  if (!state.canManageIdentities) {
    section.hidden = true;
    list.replaceChildren();
    document.getElementById('request-email-change').disabled = true;
    document.getElementById('request-phone-change').disabled = true;
    return;
  }
  const openRequests = asArray(requests).filter(request => !['verified', 'cancelled', 'canceled', 'superseded'].includes(identityChangeStatus(request)));
  const activeTypes = new Set(openRequests
    .filter(request => {
      const status = identityChangeStatus(request);
      return ['pending', 'sent'].includes(status) || (
        ['delivery_failed', 'conflict'].includes(status)
        && firstValue(request, ['canCancel', 'can_cancel'], false) === true
      );
    })
    .map(identityChangeType));
  const emailButton = document.getElementById('request-email-change');
  const phoneButton = document.getElementById('request-phone-change');
  emailButton.disabled = activeTypes.has('email');
  phoneButton.disabled = activeTypes.has('phone');
  emailButton.title = emailButton.disabled ? 'Resolve the current email request first.' : '';
  phoneButton.title = phoneButton.disabled ? 'Resolve the current phone request first.' : '';
  section.hidden = openRequests.length === 0;
  list.innerHTML = openRequests.map(request => {
    const id = identityChangeId(request);
    const type = identityChangeType(request);
    const value = identityChangeValue(request);
    const status = identityChangeStatus(request);
    const canResend = firstValue(request, ['canResend', 'can_resend'], false) === true;
    const canCancel = firstValue(request, ['canCancel', 'can_cancel'], false) === true;
    return `<article class="accounts-pending-identity" data-identity-change-id="${esc(id)}">
      <div class="accounts-pending-identity-copy">
        <strong>${esc(value || `New ${type}`)}</strong>
        <span>${esc(identityChangeStatusLabel(status))}</span>
        <time>${esc(identityChangeTiming(request, status))}</time>
      </div>
      ${(canResend || canCancel) ? `<div class="accounts-pending-identity-actions">
        ${canResend ? `<button class="sg-btn sg-btn-ghost" type="button" data-identity-request-action="resend" data-identity-change-id="${esc(id)}" aria-label="Resend verification to ${esc(value || type)}">Resend</button>` : ''}
        ${canCancel ? `<button class="sg-btn sg-btn-ghost accounts-quiet-danger" type="button" data-identity-request-action="cancel" data-identity-change-id="${esc(id)}" aria-label="Cancel verification request for ${esc(value || type)}">Cancel request</button>` : ''}
      </div>` : ''}
    </article>`;
  }).join('');
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
  const visibleAudit = state.canManageIdentities
    ? audit
    : audit.filter(item => !String(firstValue(item, ['action_type','actionType','action','event','label'], ''))
      .toLowerCase()
      .replace(/[\s-]+/g, '_')
      .includes('identity_change'));
  document.getElementById('account-audit').innerHTML = visibleAudit.length ? visibleAudit.map(item => {
    const rawAction = firstValue(item, ['label','action_label','action','event'], 'Account updated');
    const action = String(rawAction).replace(/_/g, ' ').replace(/^./, character => character.toUpperCase());
    const actor = firstValue(item, ['actor_name','admin_name','actor'], 'Silver Glider');
    const reason = firstValue(item, ['reason','details','description'], '');
    const date = formatDate(firstValue(item, ['created_at','createdAt','timestamp']), true);
    return `<li class="accounts-timeline-item"><strong>${esc(action)}</strong><p>${esc(`${actor} · ${date}${reason ? ` · ${reason}` : ''}`)}</p></li>`;
  }).join('') : '<li class="accounts-muted-empty">No support actions have been recorded yet.</li>';
}

function deletionAllowed(deletion) {
  return firstValue(deletion, ['allowed', 'eligible', 'canDelete', 'can_delete'], true) !== false;
}

function deletionConfirmation(deletion) {
  return String(firstValue(
    deletion,
    ['confirmationText', 'confirmation_text'],
    `DELETE USER ${state.selectedId}`
  )).trim();
}

function deletionWarningLabel(warning) {
  if (typeof warning === 'string') return warning;
  const label = firstValue(warning, ['label', 'message', 'description', 'code'], 'Review this account before deletion.');
  const count = Number(firstValue(warning, ['count'], 0));
  return count > 0 && !String(label).includes(String(count)) ? `${label} (${count})` : String(label);
}

function deletionSummaryEntries(summary) {
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) return [];
  const labels = {
    events: 'Hosted events', event_count: 'Hosted events', eventCount: 'Hosted events',
    rsvps: 'RSVPs', rsvp_count: 'RSVPs', rsvpCount: 'RSVPs',
    identities: 'Sign-in methods', identity_count: 'Sign-in methods', identityCount: 'Sign-in methods',
    follows: 'Host follows', follow_count: 'Host follows', followCount: 'Host follows', following: 'Host follows',
    followers: 'Followers', follower_count: 'Followers', followerCount: 'Followers',
    photos: 'Photos', photo_count: 'Photos', photoCount: 'Photos', uploadedPhotos: 'Uploaded photos',
    sessions: 'Sessions', session_count: 'Sessions', sessionCount: 'Sessions',
    messages: 'Message records', purchases: 'Purchases', smsCredits: 'Text credits'
  };
  const seen = new Set();
  return Object.entries(summary).flatMap(([key, value]) => {
    if (!['string', 'number'].includes(typeof value) || value === '') return [];
    const label = labels[key] || String(key).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ').replace(/^./, letter => letter.toUpperCase());
    const normalized = label.toLowerCase();
    if (seen.has(normalized)) return [];
    seen.add(normalized);
    return [{ label, value }];
  }).slice(0, 12);
}

function deletionSummaryMarkup(summary) {
  const entries = deletionSummaryEntries(summary);
  return entries.length ? entries.map(item => `<span><strong>${esc(item.value)}</strong>${esc(item.label)}</span>`).join('') : '';
}

function renderDeletion(deletion) {
  const zone = document.getElementById('account-delete-zone');
  state.deletion = deletion && typeof deletion === 'object' ? deletion : {};
  zone.hidden = false;
  const allowed = deletionAllowed(state.deletion);
  const blockers = asArray(firstValue(state.deletion, ['blockers'], []));
  const warnings = asArray(firstValue(state.deletion, ['warnings'], []));
  const summary = firstValue(state.deletion, ['summary', 'counts', 'deleteSummary', 'delete_summary'], {});
  const summaryElement = document.getElementById('account-delete-summary');
  summaryElement.innerHTML = deletionSummaryMarkup(summary);
  summaryElement.hidden = !summaryElement.innerHTML;

  const warningList = document.getElementById('account-delete-warnings');
  const visibleWarnings = allowed ? warnings : [...warnings, ...blockers].slice(0, 3);
  warningList.innerHTML = visibleWarnings.map(warning => `<li>${esc(deletionWarningLabel(warning))}</li>`).join('');
  warningList.hidden = visibleWarnings.length === 0;

  const verificationNote = document.getElementById('account-delete-verification-note');
  const requiresFreshVerification = firstValue(state.deletion, ['requiresFreshVerification', 'requires_fresh_verification'], true) !== false;
  verificationNote.hidden = !requiresFreshVerification;

  const button = document.getElementById('delete-account-action');
  button.disabled = !allowed;
  button.textContent = allowed ? 'Delete account' : 'This account cannot be deleted';
  button.setAttribute('aria-describedby', [
    'account-delete-description',
    summaryElement.innerHTML ? 'account-delete-summary' : '',
    visibleWarnings.length ? 'account-delete-warnings' : '',
    requiresFreshVerification ? 'account-delete-verification-note' : ''
  ].filter(Boolean).join(' '));
}

function detailCollections(data, account) {
  const ownership = { ...(data.ownership || data.property || data.owned || {}) };
  const sessions = asArray(data.sessions || data.active_sessions);
  if (ownership.active_session_count === undefined) ownership.active_session_count = numberValue(data, ['active_session_count','session_count'], sessions.length);
  if (ownership.identity_conflict_count === undefined) ownership.identity_conflict_count = numberValue(data, ['identity_conflict_count','conflict_count'], 0);
  return {
    identities: normalizeIdentities(data, account),
    identityChangeRequests: asArray(data.identityChangeRequests || data.identity_change_requests),
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
  document.getElementById('account-identity-status').textContent = '';
  renderIdentities(collections.identities, account);
  state.identityChangeRequests = collections.identityChangeRequests;
  renderIdentityChanges(state.identityChangeRequests);
  renderOwnership(collections.ownership, account);
  renderNotes(collections.notes);
  state.audit = collections.audit;
  renderAudit(state.audit);
  renderDeletion(data.deletion || null);
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

function configureIdentityChangeDialog(type, trigger) {
  if (!state.canManageIdentities) return;
  if (!state.selectedId) return;
  const phone = type === 'phone';
  state.identityChangeType = phone ? 'phone' : 'email';
  const form = document.getElementById('identity-change-form');
  form.reset();
  const input = document.getElementById('identity-change-value');
  input.type = phone ? 'tel' : 'email';
  input.inputMode = phone ? 'tel' : 'email';
  input.autocomplete = 'off';
  input.placeholder = phone ? '+1 415 555 0123' : 'name@example.com';
  input.maxLength = phone ? 32 : 254;
  document.getElementById('identity-change-value-label').textContent = phone ? 'New mobile number' : 'New email address';
  document.getElementById('identity-change-title').textContent = phone ? 'Change mobile number' : 'Change sign-in email';
  document.getElementById('identity-change-description').textContent = phone
    ? 'We’ll text a verification request to the new number. The account will not change until its recipient enters the code.'
    : 'We’ll send a private verification link to the new address. The account will not change until its recipient reviews and confirms it.';
  setFormError('identity-change-error', '');
  showDialog(identityChangeDialog, trigger);
  requestAnimationFrame(() => input.focus());
}

function closeIdentityChangeDialog() {
  if (identityChangeDialog.open) identityChangeDialog.close();
}

async function refreshSelectedAccount() {
  if (!state.selectedId) return;
  renderDetail(await fetchAccount(state.selectedId));
}

async function submitIdentityChange(event) {
  event.preventDefault();
  if (!state.canManageIdentities) return;
  if (!state.selectedId || !state.identityChangeType) return;
  const valueField = document.getElementById('identity-change-value');
  const reasonField = document.getElementById('identity-change-reason');
  const value = valueField.value.trim();
  const reason = reasonField.value.trim();
  if (!value) {
    setFormError('identity-change-error', `Enter the new ${state.identityChangeType === 'phone' ? 'mobile number' : 'email address'}.`);
    valueField.focus();
    return;
  }
  if (state.identityChangeType === 'email' && !valueField.validity.valid) {
    setFormError('identity-change-error', 'Enter a valid email address.');
    valueField.focus();
    return;
  }
  if (reason.length < 8) {
    setFormError('identity-change-error', 'Add a short reason for the permanent audit record.');
    reasonField.focus();
    return;
  }
  const button = document.getElementById('submit-identity-change');
  button.disabled = true;
  button.textContent = 'Sending…';
  setFormError('identity-change-error', '');
  try {
    await api(`/api/admin/accounts/${encodeURIComponent(state.selectedId)}/identity-changes`, {
      method:'POST',
      body:{ type:state.identityChangeType, value, reason }
    });
    identityChangeDialog.close();
    toast('Verification request sent to the recipient');
    await Promise.all([loadAccounts(), refreshSelectedAccount()]);
  } catch (error) {
    setFormError('identity-change-error', error.message || 'The verification request could not be sent.');
  } finally {
    button.disabled = false;
    button.textContent = 'Send verification request';
  }
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
  confirm.className = `sg-btn ${state.action.tone === 'primary' || action === 'reactivate' ? 'sg-btn-primary' : 'sg-btn-danger'}`;
  setFormError('support-action-error', '');
  showDialog(actionDialog);
  requestAnimationFrame(() => document.getElementById('support-action-reason').focus());
}

function openIdentityRequestAction(action, changeId, trigger) {
  if (!state.canManageIdentities) return;
  const requests = asArray(state.detail?.identityChangeRequests || state.detail?.identity_change_requests);
  const request = requests.find(item => String(identityChangeId(item)) === String(changeId));
  if (!request || !state.selectedId) return;
  const value = identityChangeValue(request) || identityChangeType(request);
  const resend = action === 'resend';
  state.action = {
    action:resend ? 'identityResend' : 'identityCancel',
    title:resend ? 'Resend this verification?' : 'Cancel this verification request?',
    description:resend
      ? `A fresh verification message will be sent to ${value}. Only its recipient can complete the change.`
      : `${value} will no longer be able to complete this request. The account’s current sign-in method will remain unchanged.`,
    button:resend ? 'Resend verification' : 'Cancel request',
    path:`/api/admin/accounts/${encodeURIComponent(state.selectedId)}/identity-changes/${encodeURIComponent(changeId)}/${resend ? 'resend' : 'cancel'}`,
    method:'POST',
    tone:resend ? 'primary' : 'danger',
    success:resend ? 'Verification resent to the recipient' : 'Verification request cancelled'
  };
  document.getElementById('support-action-title').textContent = state.action.title;
  document.getElementById('support-action-description').textContent = state.action.description;
  document.getElementById('support-action-reason').value = '';
  const confirm = document.getElementById('confirm-support-action');
  confirm.textContent = state.action.button;
  confirm.className = `sg-btn ${resend ? 'sg-btn-primary' : 'sg-btn-danger'}`;
  setFormError('support-action-error', '');
  showDialog(actionDialog, trigger);
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
    const path = state.action.path || `/api/admin/accounts/${encodeURIComponent(state.selectedId)}/${state.action.endpoint}`;
    await api(path, { method:state.action.method,body:{ reason } });
    actionDialog.close();
    toast(state.action.success || `${original} complete`);
    await Promise.all([loadAccounts(), refreshSelectedAccount()]);
  } catch (error) {
    setFormError('support-action-error', error.message);
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

function resetDeleteDialog() {
  document.getElementById('delete-account-form').reset();
  document.getElementById('delete-account-step-up-form').reset();
  document.getElementById('delete-account-review').hidden = false;
  document.getElementById('delete-account-step-up').hidden = true;
  document.getElementById('delete-account-code-help').textContent = 'Sending a fresh code…';
  setFormError('delete-account-error', '');
  setFormError('delete-account-step-up-error', '');
  deleteDialog.setAttribute('aria-labelledby', 'delete-account-title');
  deleteDialog.setAttribute('aria-describedby', 'delete-account-description');
  state.deleteRequest = null;
}

function openDeleteAccount(trigger) {
  if (!state.selectedId || !state.deletion) return;
  if (!deletionAllowed(state.deletion)) return;
  resetDeleteDialog();
  const name = accountName(state.selected || {});
  const confirmation = deletionConfirmation(state.deletion);
  const summary = firstValue(state.deletion, ['summary', 'counts', 'deleteSummary', 'delete_summary'], {});
  const warnings = asArray(firstValue(state.deletion, ['warnings'], []));
  document.getElementById('delete-account-title').textContent = `Delete ${name}?`;
  document.getElementById('delete-account-description').textContent = `${name} and the account data attached to User ID ${state.selectedId} will be permanently removed. Required financial and audit records may be anonymized and retained.`;
  document.getElementById('delete-account-required-text').textContent = confirmation;
  const dialogSummary = document.getElementById('delete-account-dialog-summary');
  dialogSummary.innerHTML = deletionSummaryMarkup(summary);
  dialogSummary.hidden = !dialogSummary.innerHTML;
  const dialogWarnings = document.getElementById('delete-account-dialog-warnings');
  dialogWarnings.innerHTML = warnings.map(warning => `<li>${esc(deletionWarningLabel(warning))}</li>`).join('');
  dialogWarnings.hidden = warnings.length === 0;
  showDialog(deleteDialog, trigger);
  requestAnimationFrame(() => document.getElementById('delete-account-reason').focus());
}

function deleteRequestBody() {
  return {
    reason: document.getElementById('delete-account-reason').value.trim(),
    confirmation: document.getElementById('delete-account-confirmation').value.trim()
  };
}

function setDeleteButtonsBusy(busy, label = '') {
  const confirm = document.getElementById('submit-delete-account');
  const verify = document.getElementById('verify-delete-account');
  const cancel = document.getElementById('cancel-delete-account');
  const cancelStepUp = document.getElementById('cancel-delete-step-up');
  [confirm, verify, cancel, cancelStepUp].forEach(button => { button.disabled = busy; });
  confirm.textContent = busy && label ? label : 'Continue to email confirmation';
  verify.textContent = busy && label ? label : 'Verify and delete';
}

async function startDeleteStepUp() {
  setDeleteButtonsBusy(true, 'Sending code…');
  setFormError('delete-account-error', '');
  try {
    const result = await api('/api/admin/auth/step-up/start', {
      method:'POST',
      body:{ action:'account_delete', targetUserId:Number(state.selectedId) }
    });
    const destination = firstValue(result, ['maskedEmail', 'masked_email'], 'your primary email');
    document.getElementById('delete-account-review').hidden = true;
    document.getElementById('delete-account-step-up').hidden = false;
    deleteDialog.setAttribute('aria-labelledby', 'delete-account-step-up-title');
    deleteDialog.setAttribute('aria-describedby', 'delete-account-step-up-description delete-account-code-help');
    document.getElementById('delete-account-code-help').textContent = `We sent a code to ${destination}.`;
    document.getElementById('delete-account-step-up-description').textContent = 'Enter the six-digit code sent to your admin email before deleting this account.';
    requestAnimationFrame(() => document.getElementById('delete-account-code').focus());
  } catch (error) {
    setFormError('delete-account-error', error.message || 'A confirmation code could not be sent.');
  } finally {
    setDeleteButtonsBusy(false);
  }
}

async function finishAccountDeletion(result = {}) {
  const deletedName = accountName(state.selected || {});
  if (deleteDialog.open) deleteDialog.close();
  if (detailDialog.open) detailDialog.close();
  state.selectedId = null;
  state.selected = null;
  state.detail = null;
  state.deletion = null;
  state.deleteRequest = null;
  await loadAccounts();
  const queued = Number(firstValue(result, ['mediaCleanupQueued', 'media_cleanup_queued'], 0)) || 0;
  toast(`${deletedName} was permanently deleted${queued ? `; ${queued} media cleanup job${queued === 1 ? '' : 's'} queued` : ''}`);
  if (search?.isConnected) requestAnimationFrame(() => search.focus());
}

async function performAccountDeletion({ allowStepUp = true } = {}) {
  if (!state.selectedId || !state.deleteRequest) return;
  setDeleteButtonsBusy(true, 'Deleting…');
  setFormError('delete-account-error', '');
  setFormError('delete-account-step-up-error', '');
  try {
    const result = await api(`/api/admin/accounts/${encodeURIComponent(state.selectedId)}/delete-account`, {
      method:'POST',
      body:state.deleteRequest
    });
    await finishAccountDeletion(result);
  } catch (error) {
    if (allowStepUp && error.code === 'admin_step_up_required') {
      setDeleteButtonsBusy(false);
      await startDeleteStepUp();
      return;
    }
    const changedDeletion = error.data?.deletion || (Array.isArray(error.data?.blockers)
      ? { ...state.deletion, allowed:false, blockers:error.data.blockers }
      : null);
    if (changedDeletion) {
      renderDeletion(changedDeletion);
      if (!deletionAllowed(changedDeletion)) deleteDialog.close();
    }
    const errorTarget = document.getElementById('delete-account-step-up').hidden
      ? 'delete-account-error'
      : 'delete-account-step-up-error';
    setFormError(errorTarget, error.message || 'This account could not be deleted.');
  } finally {
    setDeleteButtonsBusy(false);
  }
}

async function submitDeleteAccount(event) {
  event.preventDefault();
  if (!state.deletion || !deletionAllowed(state.deletion)) return;
  const reason = document.getElementById('delete-account-reason').value.trim();
  const confirmation = document.getElementById('delete-account-confirmation').value.trim();
  const requiredConfirmation = deletionConfirmation(state.deletion);
  setFormError('delete-account-error', '');
  if (reason.length < 8) {
    setFormError('delete-account-error', 'Add a reason of at least 8 characters for the permanent audit record.');
    document.getElementById('delete-account-reason').focus();
    return;
  }
  if (confirmation !== requiredConfirmation) {
    setFormError('delete-account-error', `Type ${requiredConfirmation} exactly to continue.`);
    document.getElementById('delete-account-confirmation').focus();
    return;
  }
  state.deleteRequest = deleteRequestBody();
  const requiresFreshVerification = firstValue(state.deletion, ['requiresFreshVerification', 'requires_fresh_verification'], true) !== false;
  if (requiresFreshVerification) await startDeleteStepUp();
  else await performAccountDeletion();
}

async function submitDeleteStepUp(event) {
  event.preventDefault();
  const codeField = document.getElementById('delete-account-code');
  const code = codeField.value.trim();
  setFormError('delete-account-step-up-error', '');
  if (!/^\d{6}$/.test(code)) {
    setFormError('delete-account-step-up-error', 'Enter the 6-digit code.');
    codeField.focus();
    return;
  }
  setDeleteButtonsBusy(true, 'Verifying…');
  try {
    const result = await api('/api/admin/auth/step-up/complete', { method:'POST',body:{ code } });
    if (result.kind !== 'admin_action_proof' || result.action !== 'account_delete' ||
        Number(result.targetUserId) !== Number(state.selectedId)) {
      throw new Error('Account confirmation could not be completed.');
    }
  } catch (error) {
    setFormError('delete-account-step-up-error', error.message || 'That code could not be verified.');
    setDeleteButtonsBusy(false);
    return;
  }
  await performAccountDeletion({ allowStepUp:false });
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
document.getElementById('request-email-change').addEventListener('click', event => configureIdentityChangeDialog('email', event.currentTarget));
document.getElementById('request-phone-change').addEventListener('click', event => configureIdentityChangeDialog('phone', event.currentTarget));
document.getElementById('cancel-identity-change').addEventListener('click', closeIdentityChangeDialog);
document.getElementById('identity-change-form').addEventListener('submit', submitIdentityChange);
document.getElementById('account-pending-identity-list').addEventListener('click', event => {
  const button = event.target.closest('[data-identity-request-action]');
  if (!button) return;
  openIdentityRequestAction(button.dataset.identityRequestAction, button.dataset.identityChangeId, button);
});
document.getElementById('account-sign-out-all').addEventListener('click', () => openSupportAction('signOut'));
document.getElementById('account-status-action').addEventListener('click', event => openSupportAction(event.currentTarget.dataset.action));
document.getElementById('delete-account-action').addEventListener('click', event => openDeleteAccount(event.currentTarget));
document.getElementById('cancel-support-action').addEventListener('click', () => actionDialog.close());
document.getElementById('support-action-form').addEventListener('submit', submitSupportAction);
document.getElementById('cancel-delete-account').addEventListener('click', () => deleteDialog.close());
document.getElementById('cancel-delete-step-up').addEventListener('click', () => deleteDialog.close());
document.getElementById('delete-account-form').addEventListener('submit', submitDeleteAccount);
document.getElementById('delete-account-step-up-form').addEventListener('submit', submitDeleteStepUp);
document.getElementById('account-note-form').addEventListener('submit', submitNote);
document.getElementById('account-profile-form').addEventListener('submit', submitAccountProfile);
document.getElementById('host-profile-form').addEventListener('submit', submitHostProfile);

[detailDialog, actionDialog, identityChangeDialog, invitationDialog, deleteDialog].forEach(dialog => {
  dialog.addEventListener('click', event => {
    if (event.target === dialog) dialog.close();
  });
  dialog.addEventListener('close', () => restoreDialogFocus(dialog));
});

identityChangeDialog.addEventListener('close', () => {
  state.identityChangeType = null;
  document.getElementById('identity-change-form').reset();
  setFormError('identity-change-error', '');
});
deleteDialog.addEventListener('close', resetDeleteDialog);

window.adminShellSession.then(session => {
  state.canManageIdentities = session?.capabilities?.manageIdentities === true;
  renderIdentityChanges(state.identityChangeRequests);
  renderAudit(state.audit);
}).catch(() => {
  state.canManageIdentities = false;
  renderIdentityChanges([]);
  renderAudit(state.audit);
});

loadAccounts();
