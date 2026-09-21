/* Done For You client provisioning. Identity ownership is always recipient-verified. */

renderNav('');

const dfyState = {
  clients: [],
  lookup: null,
  lookupInput: null,
  creating: false,
  returnFocus: null
};

const dfyList = document.getElementById('client-list');
const dfyEmpty = document.getElementById('client-empty');
const dfySearch = document.getElementById('client-search');
const dfyDialog = document.getElementById('client-dialog');
const dfyForm = document.getElementById('client-form');
const dfyFields = document.getElementById('client-fields');
const dfyPreflight = document.getElementById('client-preflight');
const dfyError = document.getElementById('client-form-error');
const dfyLookupButton = document.getElementById('lookup-client');
const dfyCreateButton = document.getElementById('create-client');
const dfyEditButton = document.getElementById('edit-client');

function dfyEsc(value) { return sgEscapeHtml(value); }
function dfyArray(value) { return Array.isArray(value) ? value : []; }

function dfyFirst(object, keys, fallback = null) {
  for (const key of keys) {
    if (object && object[key] !== undefined && object[key] !== null) return object[key];
  }
  return fallback;
}

function dfyNumber(object, keys, fallback = 0) {
  const value = Number(dfyFirst(object, keys, fallback));
  return Number.isFinite(value) ? value : fallback;
}

function dfyClientId(client) {
  return dfyFirst(client, ['id', 'clientId', 'client_id', 'doneForYouClientId', 'done_for_you_client_id']);
}

function dfyUserId(client) {
  return dfyFirst(client, ['targetUserId', 'target_user_id', 'userId', 'user_id', 'ownerUserId', 'owner_user_id']);
}

function dfyHostName(client) {
  return String(dfyFirst(client, ['hostName', 'host_name', 'orgName', 'org_name'], 'Untitled Host Page')).trim() || 'Untitled Host Page';
}

function dfyOwnerName(client) {
  const owner = client?.owner || client?.account || {};
  return String(dfyFirst(owner, ['name', 'displayName', 'display_name'], dfyFirst(client, ['contactName', 'contact_name', 'ownerName', 'owner_name'], 'Unnamed owner'))).trim() || 'Unnamed owner';
}

function dfyOwnerEmail(client) {
  const owner = client?.owner || client?.account || {};
  return String(dfyFirst(owner, ['primaryEmail', 'primary_email', 'email'], dfyFirst(client, ['email', 'primary_email'], 'No email available'))).trim() || 'No email available';
}

function dfyClaimed(client) {
  const owner = client?.owner || client?.account || {};
  return dfyFirst(client, ['claimed', 'isClaimed', 'is_claimed'], dfyFirst(owner, ['claimed', 'isClaimed', 'is_claimed'], false)) === true;
}

function dfyAccountStatus(client) {
  const owner = client?.owner || client?.account || {};
  return String(dfyFirst(owner, ['status', 'accountStatus', 'account_status'], dfyFirst(client, ['accountStatus', 'account_status', 'status'], 'active'))).toLowerCase();
}

function dfyStateLabel(client) {
  if (dfyAccountStatus(client) !== 'active') return { text: 'Inactive', className: 'inactive' };
  if (dfyClaimed(client)) return { text: 'Claimed', className: 'claimed' };
  return { text: 'Unclaimed', className: 'unclaimed' };
}

function dfyClientRow(client) {
  const id = dfyClientId(client);
  const userId = dfyUserId(client);
  const events = dfyNumber(client, ['eventCount', 'event_count', 'eventsCount', 'events_count']);
  const accountState = dfyStateLabel(client);
  return `<button class="dfy-client-row" type="button" data-client-id="${dfyEsc(id)}" aria-label="Open ${dfyEsc(dfyHostName(client))}">
    <span class="dfy-client-host"><strong>${dfyEsc(dfyHostName(client))}</strong><small>Global User ID ${dfyEsc(userId || '—')}</small></span>
    <span class="dfy-client-owner"><strong>${dfyEsc(dfyOwnerName(client))}</strong><small>${dfyEsc(dfyOwnerEmail(client))}</small></span>
    <span class="dfy-client-state"><span class="dfy-status-pill ${accountState.className}">${accountState.text}</span></span>
    <span class="dfy-client-events">${events} event${events === 1 ? '' : 's'}</span>
    <span class="dfy-row-arrow" aria-hidden="true">›</span>
  </button>`;
}

function dfyRenderClients() {
  const query = dfySearch.value.trim().toLowerCase();
  const clients = query
    ? dfyState.clients.filter(client => [
      dfyHostName(client), dfyOwnerName(client), dfyOwnerEmail(client), dfyUserId(client)
    ].join(' ').toLowerCase().includes(query))
    : dfyState.clients;
  dfyList.classList.remove('admin-skeleton-stack');
  dfyList.innerHTML = clients.map(dfyClientRow).join('');
  dfyEmpty.hidden = clients.length > 0;
  dfyList.querySelectorAll('[data-client-id]').forEach(row => row.addEventListener('click', () => {
    location.href = `/admin/done-for-you/${encodeURIComponent(row.dataset.clientId)}`;
  }));
}

function dfyLoadingRows() {
  return `<div class="admin-skeleton-card admin-skeleton-row" aria-hidden="true"><span class="admin-skeleton-copy"><span class="sg-skeleton admin-skeleton-title"></span><span class="sg-skeleton admin-skeleton-meta"></span></span><span class="sg-skeleton admin-skeleton-action"></span></div><div class="admin-skeleton-card admin-skeleton-row" aria-hidden="true"><span class="admin-skeleton-copy"><span class="sg-skeleton admin-skeleton-title"></span><span class="sg-skeleton admin-skeleton-meta"></span></span><span class="sg-skeleton admin-skeleton-action"></span></div>`;
}

async function dfyLoadClients() {
  dfyList.classList.add('admin-skeleton-stack');
  dfyList.setAttribute('aria-busy', 'true');
  dfyList.innerHTML = dfyLoadingRows();
  dfyEmpty.hidden = true;
  dfySearch.disabled = true;
  try {
    const data = await api('/api/admin/done-for-you');
    dfyState.clients = dfyArray(data.clients || data.results || data.doneForYouClients);
    dfyRenderClients();
    dfySearch.disabled = false;
  } catch (error) {
    dfyList.classList.remove('admin-skeleton-stack');
    dfyList.innerHTML = `<div class="admin-load-error"><strong>We couldn’t load Done For You clients.</strong><p>${dfyEsc(error.message)}</p><button class="sg-btn sg-btn-ghost" id="retry-dfy-clients" type="button">Try again</button></div>`;
    document.getElementById('retry-dfy-clients').addEventListener('click', dfyLoadClients);
  } finally {
    dfyList.setAttribute('aria-busy', 'false');
  }
}

function dfyReadForm() {
  return {
    hostName: document.getElementById('client-host-name').value.trim(),
    contactName: document.getElementById('client-contact-name').value.trim(),
    email: document.getElementById('client-email').value.trim(),
    phone: document.getElementById('client-phone').value.trim() || null
  };
}

function dfySameInput(left, right) {
  return Boolean(left && right) && ['hostName', 'contactName', 'email', 'phone'].every(key => (left[key] || null) === (right[key] || null));
}

function dfyResetPreflight() {
  dfyState.lookup = null;
  dfyState.lookupInput = null;
  dfyPreflight.hidden = true;
  dfyPreflight.className = 'dfy-preflight';
  dfyPreflight.innerHTML = '';
  dfyCreateButton.hidden = true;
  dfyEditButton.hidden = true;
  dfyLookupButton.hidden = false;
  dfyLookupButton.textContent = 'Check account';
  dfyFields.disabled = false;
  dfyError.textContent = '';
}

function dfyOpenDialog(trigger) {
  dfyState.returnFocus = trigger instanceof HTMLElement ? trigger : null;
  dfyForm.reset();
  dfyResetPreflight();
  if (!dfyDialog.open) dfyDialog.showModal();
  requestAnimationFrame(() => document.getElementById('client-host-name').focus());
}

function dfyCloseDialog() {
  if (dfyState.creating) return;
  dfyDialog.close();
}

function dfyOwnerLinks(error) {
  const details = error?.data || {};
  const ids = [
    ...(Array.isArray(details.ownerUserIds) ? details.ownerUserIds : []),
    ...(Array.isArray(details.owner_user_ids) ? details.owner_user_ids : []),
    details.emailOwnerUserId,
    details.email_owner_user_id,
    details.phoneOwnerUserId,
    details.phone_owner_user_id,
    details.actualUserId,
    details.actual_user_id
  ].map(Number).filter(Number.isFinite);
  return [...new Set(ids)].map(id => `<a href="/admin/accounts?q=${encodeURIComponent(id)}">Open User ID ${dfyEsc(id)}</a>`).join('');
}

function dfyIsCollision(error) {
  return [
    'split_identity_owners',
    'identity_projection_conflict',
    'done_for_you_lookup_changed',
    'unverified_phone_requires_manual_review',
    'ambiguous_canonical_email',
    'ambiguous_canonical_phone',
    'ambiguous_verified_phone',
    'ambiguous_unverified_phone',
    'ambiguous_legacy_email',
    'ambiguous_legacy_phone'
  ].includes(error?.code);
}

function dfyShowCollision(error) {
  dfyEditButton.hidden = true;
  dfyPreflight.hidden = false;
  dfyPreflight.className = 'dfy-preflight blocked';
  const links = dfyOwnerLinks(error);
  dfyPreflight.innerHTML = `<strong>Account review required</strong><p>${dfyEsc(error.message)} Nothing was created or merged.</p>${links ? `<div class="dfy-preflight-links">${links}</div>` : ''}`;
  dfyLookupButton.textContent = 'Check again';
  dfyFields.disabled = false;
}

function dfyFocusPreflight() {
  dfyPreflight.tabIndex = -1;
  requestAnimationFrame(() => dfyPreflight.focus({ preventScroll: true }));
}

function dfyRenderLookup(data) {
  const account = data.account || data.user || null;
  const expectedUserId = dfyFirst(data, ['expectedUserId', 'expected_user_id'], account ? dfyUserId(account) : null);
  const matched = data.matched === true || expectedUserId != null;
  dfyPreflight.hidden = false;
  dfyPreflight.className = 'dfy-preflight success';
  if (matched) {
    const status = String(dfyFirst(account, ['status', 'accountStatus', 'account_status'], 'active'));
    const host = dfyFirst(account, ['hostName', 'host_name', 'orgName', 'org_name'], 'No Host Page yet');
    const claimed = dfyFirst(account, ['claimed', 'isClaimed', 'is_claimed'], false) === true ? 'Claimed' : 'Unclaimed';
    if (status.toLowerCase() !== 'active') {
      dfyPreflight.className = 'dfy-preflight blocked';
      dfyPreflight.innerHTML = `<strong>This account is ${dfyEsc(status)}</strong><p>Reactivate User ID ${dfyEsc(expectedUserId)} from the account record before preparing its Host Page.</p><div class="dfy-preflight-links"><a href="/admin/accounts?q=${encodeURIComponent(expectedUserId)}">Open User ID ${dfyEsc(expectedUserId)}</a></div>`;
      dfyFields.disabled = true;
      dfyLookupButton.hidden = true;
      dfyEditButton.hidden = false;
      dfyCreateButton.hidden = true;
      return;
    }
    dfyPreflight.innerHTML = `<strong>Exact account match found</strong>
      <p>Review the permanent owner before continuing. This action will reuse the account; it will not merge or sign in as the client.</p>
      <dl><dt>Global User ID</dt><dd>${dfyEsc(expectedUserId)}</dd><dt>Owner</dt><dd>${dfyEsc(dfyFirst(account, ['name', 'displayName', 'display_name'], 'Unnamed account'))}</dd><dt>Host Page</dt><dd>${dfyEsc(host)}</dd><dt>State</dt><dd>${dfyEsc(`${claimed} · ${status}`)}</dd></dl>`;
    dfyCreateButton.textContent = `Use User ID ${expectedUserId} and create Host Page`;
  } else {
    dfyPreflight.innerHTML = `<strong>No existing account found</strong><p>Continuing creates an unclaimed account and Host Page. The email and mobile number remain unverified until the recipient claims access.</p>`;
    dfyCreateButton.textContent = 'Create unclaimed account and Host Page';
  }
  dfyFields.disabled = true;
  dfyLookupButton.hidden = true;
  dfyEditButton.hidden = false;
  dfyCreateButton.hidden = false;
}

async function dfyLookup(event) {
  event.preventDefault();
  if (!dfyForm.reportValidity()) return;
  const input = dfyReadForm();
  dfyError.textContent = '';
  dfyLookupButton.disabled = true;
  dfyLookupButton.textContent = 'Checking…';
  try {
    const data = await api('/api/admin/done-for-you/lookup', {
      method: 'POST',
      body: { email: input.email, phone: input.phone }
    });
    dfyState.lookup = data;
    dfyState.lookupInput = input;
    dfyRenderLookup(data);
    dfyFocusPreflight();
  } catch (error) {
    if (dfyIsCollision(error)) {
      dfyShowCollision(error);
      dfyFocusPreflight();
    }
    else dfyError.textContent = error.message;
  } finally {
    dfyLookupButton.disabled = false;
    if (!dfyState.lookup) dfyLookupButton.textContent = 'Check account';
  }
}

async function dfyCreateClient() {
  const input = dfyReadForm();
  if (!dfyState.lookup || !dfySameInput(input, dfyState.lookupInput)) {
    dfyResetPreflight();
    dfyError.textContent = 'Client details changed. Check the account again before creating anything.';
    return;
  }
  const account = dfyState.lookup.account || dfyState.lookup.user || null;
  const expectedUserId = dfyFirst(dfyState.lookup, ['expectedUserId', 'expected_user_id'], account ? dfyUserId(account) : null);
  dfyState.creating = true;
  dfyCreateButton.disabled = true;
  dfyCreateButton.textContent = 'Creating…';
  dfyError.textContent = '';
  try {
    const data = await api('/api/admin/done-for-you', {
      method: 'POST',
      body: { ...input, expectedUserId: expectedUserId == null ? null : Number(expectedUserId) }
    });
    const client = data.client || data.doneForYouClient || data;
    const id = dfyClientId(client);
    if (!id) throw new Error('The client was created, but its detail link was not returned. Refresh the client list.');
    location.href = `/admin/done-for-you/${encodeURIComponent(id)}`;
  } catch (error) {
    if (dfyIsCollision(error)) {
      dfyState.lookup = null;
      dfyShowCollision(error);
      dfyCreateButton.hidden = true;
      dfyLookupButton.hidden = false;
    } else {
      dfyError.textContent = error.message;
      dfyCreateButton.disabled = false;
      dfyCreateButton.textContent = expectedUserId == null
        ? 'Create unclaimed account and Host Page'
        : `Use User ID ${expectedUserId} and create Host Page`;
    }
  } finally {
    dfyState.creating = false;
  }
}

document.getElementById('open-client-dialog').addEventListener('click', event => dfyOpenDialog(event.currentTarget));
document.getElementById('empty-add-client').addEventListener('click', event => dfyOpenDialog(event.currentTarget));
document.getElementById('close-client-dialog').addEventListener('click', dfyCloseDialog);
document.getElementById('cancel-client').addEventListener('click', dfyCloseDialog);
dfyEditButton.addEventListener('click', () => {
  dfyResetPreflight();
  document.getElementById('client-host-name').focus();
});
dfyDialog.addEventListener('cancel', event => { if (dfyState.creating) event.preventDefault(); });
dfyDialog.addEventListener('close', () => { if (dfyState.returnFocus?.isConnected) dfyState.returnFocus.focus(); });
dfyForm.addEventListener('submit', dfyLookup);
dfyCreateButton.addEventListener('click', dfyCreateClient);
dfyFields.addEventListener('input', () => { if (dfyState.lookup) dfyResetPreflight(); });
dfySearch.addEventListener('input', dfyRenderClients);

window.adminShellSession.then(session => {
  if (session?.capabilities?.manageDoneForYou !== true) {
    location.replace('/admin');
    return;
  }
  dfyLoadClients();
}).catch(() => {});
