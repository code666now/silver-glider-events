/* Done For You client detail. Admin work stays separate from recipient identity proof. */

renderNav('');

const dfyDetailState = {
  id: location.pathname.split('/').filter(Boolean).pop(),
  client: null,
  owner: null,
  host: null,
  contacts: [],
  events: [],
  invitation: null
};

const dfyDetailRoot = document.getElementById('client-detail');
const dfyDetailLoading = document.getElementById('client-detail-loading');
const dfyDetailError = document.getElementById('client-detail-error');

function dfyDetailEsc(value) { return sgEscapeHtml(value); }
function dfyDetailArray(value) { return Array.isArray(value) ? value : []; }

function dfyDetailFirst(object, keys, fallback = null) {
  for (const key of keys) {
    if (object && object[key] !== undefined && object[key] !== null) return object[key];
  }
  return fallback;
}

function dfyDetailOwn(object, keys, fallback = null) {
  for (const key of keys) {
    if (object && Object.prototype.hasOwnProperty.call(object, key)) return object[key];
  }
  return fallback;
}

function dfyDetailFormatDate(value, includeTime = false) {
  if (!value) return 'Not yet';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Unknown';
  return date.toLocaleString('en-US', includeTime
    ? { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }
    : { month: 'short', day: 'numeric', year: 'numeric' });
}

function dfyDetailHostId() {
  return dfyDetailFirst(dfyDetailState.host, ['id', 'organizerId', 'organizer_id'],
    dfyDetailFirst(dfyDetailState.client, ['organizerId', 'organizer_id', 'hostId', 'host_id']));
}

function dfyDetailUserId() {
  return dfyDetailFirst(dfyDetailState.owner, ['id', 'userId', 'user_id'],
    dfyDetailFirst(dfyDetailState.client, ['targetUserId', 'target_user_id', 'userId', 'user_id', 'ownerUserId', 'owner_user_id']));
}

function dfyDetailHostName() {
  return String(dfyDetailFirst(dfyDetailState.host, ['name', 'orgName', 'org_name', 'hostName', 'host_name'],
    dfyDetailFirst(dfyDetailState.client, ['hostName', 'host_name'], 'Host Page'))).trim() || 'Host Page';
}

function dfyDetailOwnerName() {
  return String(dfyDetailFirst(dfyDetailState.owner, ['name', 'displayName', 'display_name'],
    dfyDetailFirst(dfyDetailState.client, ['contactName', 'contact_name'], 'Unnamed owner'))).trim() || 'Unnamed owner';
}

function dfyDetailClaimed() {
  return dfyDetailFirst(dfyDetailState.client, ['claimed', 'isClaimed', 'is_claimed'],
    dfyDetailFirst(dfyDetailState.owner, ['claimed', 'isClaimed', 'is_claimed'], false)) === true;
}

function dfyDetailAccountStatus() {
  return String(dfyDetailFirst(dfyDetailState.owner, ['status', 'accountStatus', 'account_status'],
    dfyDetailFirst(dfyDetailState.client, ['accountStatus', 'account_status', 'status'], 'active'))).toLowerCase();
}

function dfyDetailContactType(contact) {
  return String(dfyDetailFirst(contact, ['identityType', 'identity_type', 'type'], '')).toLowerCase();
}

function dfyDetailContactValue(contact) {
  return String(dfyDetailFirst(contact, ['value', 'displayValue', 'display_value', 'email', 'phone'], '')).trim();
}

function dfyDetailContactVerified(contact) {
  const scope = String(dfyDetailFirst(contact, ['verificationScope', 'verification_scope'], '')).toLowerCase();
  return contact?.verified === true || Boolean(dfyDetailFirst(contact, ['verifiedAt', 'verified_at'])) || scope === 'account';
}

function dfyDetailContacts(data) {
  const explicit = dfyDetailArray(data.contacts || data.identities || data.owner?.contacts || data.owner?.identities);
  if (explicit.length) return explicit;
  const email = dfyDetailFirst(data.owner, ['primaryEmail', 'primary_email', 'email'],
    dfyDetailFirst(data.client, ['email', 'contactEmail', 'contact_email']));
  const phone = dfyDetailFirst(data.owner, ['primaryPhone', 'primary_phone', 'phone'],
    dfyDetailFirst(data.client, ['phone', 'contactPhone', 'contact_phone']));
  return [
    { type: 'email', value: email || '', verified: Boolean(dfyDetailFirst(data.owner, ['emailVerified', 'email_verified'], false)) },
    { type: 'phone', value: phone || '', verified: Boolean(dfyDetailFirst(data.owner, ['phoneVerified', 'phone_verified'], false)) }
  ];
}

function dfyDetailNormalize(data) {
  dfyDetailState.client = data.client || data.doneForYouClient || data.done_for_you_client || data;
  dfyDetailState.owner = data.owner || data.account || dfyDetailState.client.owner || dfyDetailState.client.account || {};
  dfyDetailState.host = data.host || data.hostPage || data.host_page || dfyDetailState.client.host || {};
  dfyDetailState.contacts = dfyDetailContacts({ ...data, client: dfyDetailState.client, owner: dfyDetailState.owner });
  dfyDetailState.events = dfyDetailArray(data.events || dfyDetailState.client.events);
  dfyDetailState.invitation = data.claimInvitation || data.claim_invitation || data.invitation || dfyDetailState.client.claimInvitation || null;
}

function dfyDetailRenderContacts() {
  const byType = new Map([['email', []], ['phone', []]]);
  const seen = new Set();
  for (const contact of dfyDetailState.contacts) {
    const type = dfyDetailContactType(contact);
    const value = dfyDetailContactValue(contact);
    const key = `${type}:${value.toLowerCase()}`;
    if (byType.has(type) && value && !seen.has(key)) {
      seen.add(key);
      byType.get(type).push(contact);
    }
  }
  const rows = [];
  for (const type of ['email', 'phone']) {
    const contacts = byType.get(type);
    if (!contacts.length) contacts.push(null);
    contacts.forEach((contact, index) => {
      const value = contact ? dfyDetailContactValue(contact) : '';
      const verified = contact ? dfyDetailContactVerified(contact) : false;
      const primary = contact?.primary === true || contact?.isPrimary === true || contact?.is_primary === true;
      const trustText = !value ? 'Not available' : verified ? 'Verified sign-in method' : 'Unverified contact';
      const helper = !value
        ? `No ${type === 'email' ? 'email address' : 'mobile number'} is available.`
        : verified
          ? 'The recipient proved ownership of this value.'
          : 'Contact or RSVP information. It cannot sign in until the recipient verifies it.';
      rows.push(`<div class="dfy-contact">
      <div class="dfy-contact-copy"><small class="dfy-contact-kind">${type === 'email' ? 'Email' : 'Mobile'}${contacts.length > 1 ? ` ${index + 1}` : ''}${primary ? ' · Primary' : ''}</small><strong>${dfyDetailEsc(value || (type === 'email' ? 'No email' : 'No mobile number'))}</strong><span>${dfyDetailEsc(helper)}</span></div>
      <span class="dfy-trust-label ${!value ? '' : verified ? 'verified' : 'unverified'}">${dfyDetailEsc(trustText)}</span>
    </div>`);
    });
  }
  document.getElementById('owner-contacts').innerHTML = rows.join('');
}

function dfyDetailApplyHostResponse(payload) {
  const current = dfyDetailState.host || {};
  const raw = payload?.host || payload?.organizer || payload || {};
  dfyDetailState.host = {
    organizerId: dfyDetailOwn(raw, ['organizerId', 'organizer_id', 'id'], dfyDetailHostId()),
    name: dfyDetailOwn(raw, ['orgName', 'org_name'], dfyDetailFirst(current, ['name', 'orgName', 'org_name'])),
    slug: dfyDetailOwn(raw, ['publicSlug', 'public_slug', 'slug'], dfyDetailFirst(current, ['slug', 'publicSlug', 'public_slug'])),
    logoUrl: dfyDetailOwn(raw, ['logoUrl', 'logo_url'], dfyDetailFirst(current, ['logoUrl', 'logo_url'])),
    headerImageUrl: dfyDetailOwn(raw, ['headerImageUrl', 'header_image_url'], dfyDetailFirst(current, ['headerImageUrl', 'header_image_url'])),
    bio: dfyDetailOwn(raw, ['bio'], dfyDetailFirst(current, ['bio'])),
    websiteUrl: dfyDetailOwn(raw, ['websiteUrl', 'website_url'], dfyDetailFirst(current, ['websiteUrl', 'website_url'])),
    instagramHandle: dfyDetailOwn(raw, ['instagramHandle', 'instagram_handle'], dfyDetailFirst(current, ['instagramHandle', 'instagram_handle'])),
    contactEmail: dfyDetailOwn(raw, ['contactEmail', 'contact_email'], dfyDetailFirst(current, ['contactEmail', 'contact_email']))
  };
}

function dfyDetailInvitationStatus(invitation) {
  if (!invitation) return 'not_sent';
  if (invitation.claimedAt || invitation.claimed_at) return 'claimed';
  if (invitation.revokedAt || invitation.revoked_at) return 'cancelled';
  if (invitation.deliveryFailedAt || invitation.delivery_failed_at) return 'delivery_failed';
  const expires = dfyDetailFirst(invitation, ['expiresAt', 'expires_at']);
  if (expires && new Date(expires).getTime() <= Date.now()) return 'expired';
  return String(dfyDetailFirst(invitation, ['status'], 'pending')).toLowerCase();
}

function dfyDetailEmailContacts() {
  const seen = new Set();
  return dfyDetailState.contacts.filter(contact => {
    if (dfyDetailContactType(contact) !== 'email') return false;
    const value = dfyDetailContactValue(contact).toLowerCase();
    if (!value || seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

function dfyDetailPreferredClaimEmail(emails) {
  const invitationEmail = String(dfyDetailFirst(dfyDetailState.invitation, ['email'], '')).toLowerCase();
  const primary = contact => contact?.primary === true || contact?.isPrimary === true || contact?.is_primary === true;
  return emails.find(contact => dfyDetailContactValue(contact).toLowerCase() === invitationEmail)
    || emails.find(contact => primary(contact) && dfyDetailContactVerified(contact))
    || emails.find(primary)
    || emails.find(dfyDetailContactVerified)
    || emails[0]
    || null;
}

function dfyDetailRenderClaim() {
  const state = document.getElementById('claim-state');
  const accountStatus = dfyDetailAccountStatus();
  const invitationStatus = dfyDetailInvitationStatus(dfyDetailState.invitation);
  if (accountStatus !== 'active') {
    state.innerHTML = `<p class="dfy-claim-copy">This account is ${dfyDetailEsc(accountStatus)}. Reactivate it from the account record before sending a claim invitation.</p>`;
    return;
  }
  if (dfyDetailClaimed()) {
    const claimedAt = dfyDetailFirst(dfyDetailState.client, ['claimedAt', 'claimed_at'],
      dfyDetailFirst(dfyDetailState.owner, ['claimedAt', 'claimed_at', 'lastLoginAt', 'last_login_at']));
    state.innerHTML = `<div class="dfy-claim-meta"><strong>Recipient verified</strong><span>${claimedAt ? `Claimed ${dfyDetailEsc(dfyDetailFormatDate(claimedAt, true))}.` : 'This account has recipient-owned verification.'}</span></div><p class="dfy-claim-copy">The client can now use their verified sign-in method. Admin access remains separate.</p>`;
    return;
  }
  const emailContacts = dfyDetailEmailContacts();
  if (!emailContacts.length) {
    state.innerHTML = '<p class="dfy-claim-copy">No email is attached to this prepared client. Add an email from the account record before sending a claim invitation.</p>';
    return;
  }
  const selectedEmail = dfyDetailContactValue(dfyDetailPreferredClaimEmail(emailContacts));
  const hasInvitation = dfyDetailState.invitation && !['not_sent', 'cancelled'].includes(invitationStatus);
  const expiresAt = dfyDetailFirst(dfyDetailState.invitation, ['expiresAt', 'expires_at']);
  const failure = invitationStatus === 'delivery_failed' ? 'The last delivery failed. Check the email and resend.' : '';
  const recipientControl = emailContacts.length > 1
    ? `<label class="dfy-claim-recipient" for="claim-recipient-email"><span>Send invitation to</span><select class="sg-select" id="claim-recipient-email">${emailContacts.map(contact => {
      const value = dfyDetailContactValue(contact);
      const trust = dfyDetailContactVerified(contact) ? 'verified sign-in' : 'unverified contact';
      return `<option value="${dfyDetailEsc(value)}"${value.toLowerCase() === selectedEmail.toLowerCase() ? ' selected' : ''}>${dfyDetailEsc(`${value} — ${trust}`)}</option>`;
    }).join('')}</select><small>Choose the exact attached email that should receive the secure claim link.</small></label>`
    : `<div class="dfy-claim-meta"><strong>Send invitation to</strong><span>${dfyDetailEsc(selectedEmail)} · ${dfyDetailContactVerified(emailContacts[0]) ? 'Verified sign-in method' : 'Unverified contact'}</span></div>`;
  state.innerHTML = `<p class="dfy-claim-copy">Only the recipient can verify ownership and claim this prepared account.</p>
    ${recipientControl}
    ${hasInvitation ? `<div class="dfy-claim-meta"><strong>${dfyDetailEsc(invitationStatus === 'pending' ? 'Invitation pending' : `Invitation ${invitationStatus.replace(/_/g, ' ')}`)}</strong><span>${dfyDetailEsc(failure || (expiresAt ? `Expires ${dfyDetailFormatDate(expiresAt, true)}.` : 'The recipient has not claimed access yet.'))}</span></div>` : ''}
    <button class="sg-btn sg-btn-primary" id="send-claim-invitation" type="button" data-default-email="${dfyDetailEsc(selectedEmail)}">${hasInvitation ? 'Resend claim invitation' : 'Send claim invitation'}</button>`;
  document.getElementById('send-claim-invitation').addEventListener('click', dfyDetailSendClaim);
}

function dfyDetailRenderMediaPreview(elementId, urlValue, emptyText) {
  const element = document.getElementById(elementId);
  const url = sgSafeHttpUrl(urlValue);
  element.innerHTML = url ? `<img src="${dfyDetailEsc(url)}" alt="">` : `<span>${dfyDetailEsc(emptyText)}</span>`;
}

function dfyDetailRenderEvents() {
  const list = document.getElementById('client-events');
  if (!dfyDetailState.events.length) {
    list.innerHTML = '<p class="dfy-events-empty">No events belong to this Host Page yet.</p>';
    return;
  }
  list.innerHTML = dfyDetailState.events.map(event => {
    const status = String(dfyDetailFirst(event, ['status'], 'draft'));
    const title = dfyDetailFirst(event, ['title'], 'Untitled event');
    const date = dfyDetailFirst(event, ['eventDate', 'event_date', 'date']);
    const venue = dfyDetailFirst(event, ['venueName', 'venue_name'], 'Location not added');
    const slug = dfyDetailFirst(event, ['slug']);
    const open = status === 'published' && slug
      ? `<a href="/e/${encodeURIComponent(slug)}" target="_blank" rel="noopener">Open event</a>`
      : '';
    return `<article class="dfy-event-row"><div><h3>${dfyDetailEsc(title)}</h3><p>${dfyDetailEsc(`${dfyDetailFormatDate(date)} · ${venue} · ${status}`)}</p></div>${open}</article>`;
  }).join('');
}

function dfyDetailRender() {
  const userId = dfyDetailUserId();
  const accountStatus = dfyDetailAccountStatus();
  const claimed = dfyDetailClaimed();
  const badge = document.getElementById('detail-claim-badge');
  const badgeState = accountStatus !== 'active' ? 'inactive' : claimed ? 'claimed' : 'unclaimed';
  badge.className = `dfy-status-pill ${badgeState}`;
  badge.textContent = badgeState === 'inactive' ? 'Inactive' : claimed ? 'Claimed' : 'Unclaimed';
  document.getElementById('detail-host-name').textContent = dfyDetailHostName();
  document.getElementById('detail-owner-summary').textContent = `${dfyDetailOwnerName()} · Global User ID ${userId || '—'}`;
  document.title = `${dfyDetailHostName()} — Done For You — Admin — Silver Glider Events`;

  const accountLink = document.getElementById('open-account-link');
  accountLink.href = `/admin/accounts?q=${encodeURIComponent(userId || '')}`;
  const createdAt = dfyDetailFirst(dfyDetailState.client, ['createdAt', 'created_at']);
  document.getElementById('owner-facts').innerHTML = [
    ['Global User ID', userId || 'Unavailable'],
    ['Account state', accountStatus],
    ['Access', claimed ? 'Claimed by recipient' : 'Not claimed'],
    ['Prepared', dfyDetailFormatDate(createdAt, true)]
  ].map(([term, value]) => `<div><dt>${dfyDetailEsc(term)}</dt><dd>${dfyDetailEsc(value)}</dd></div>`).join('');
  dfyDetailRenderContacts();
  dfyDetailRenderClaim();

  const host = dfyDetailState.host;
  const hostSlug = dfyDetailFirst(host, ['publicSlug', 'public_slug', 'slug']);
  const hostLink = document.getElementById('open-host-page');
  if (hostSlug) {
    hostLink.href = `/h/${encodeURIComponent(hostSlug)}`;
    hostLink.hidden = false;
  } else {
    hostLink.hidden = true;
  }
  document.getElementById('host-name').value = dfyDetailFirst(host, ['name', 'orgName', 'org_name', 'hostName', 'host_name'], '');
  document.getElementById('host-website').value = dfyDetailFirst(host, ['websiteUrl', 'website_url'], '');
  const instagram = dfyDetailFirst(host, ['instagramHandle', 'instagram_handle'], '');
  document.getElementById('host-instagram').value = instagram ? `@${String(instagram).replace(/^@/, '')}` : '';
  document.getElementById('host-contact-email').value = dfyDetailFirst(host, ['contactEmail', 'contact_email'], '');
  document.getElementById('host-bio').value = dfyDetailFirst(host, ['bio'], '');
  dfyDetailRenderMediaPreview('host-logo-preview', dfyDetailFirst(host, ['logoUrl', 'logo_url']), 'No logo');
  dfyDetailRenderMediaPreview('host-header-preview', dfyDetailFirst(host, ['headerImageUrl', 'header_image_url']), 'No header');
  document.getElementById('upload-logo-button').textContent = dfyDetailFirst(host, ['logoUrl', 'logo_url']) ? 'Replace logo' : 'Upload logo';
  document.getElementById('upload-header-button').textContent = dfyDetailFirst(host, ['headerImageUrl', 'header_image_url']) ? 'Replace header' : 'Upload header';

  const actions = [];
  if (hostSlug) actions.push(`<a class="sg-btn sg-btn-ghost" href="/h/${encodeURIComponent(hostSlug)}" target="_blank" rel="noopener">Preview Host Page</a>`);
  document.getElementById('detail-head-actions').innerHTML = actions.join('');
  dfyDetailRenderEvents();
}

async function dfyDetailLoad() {
  dfyDetailRoot.hidden = true;
  dfyDetailError.hidden = true;
  dfyDetailLoading.hidden = false;
  dfyDetailLoading.setAttribute('aria-busy', 'true');
  try {
    const data = await api(`/api/admin/done-for-you/${encodeURIComponent(dfyDetailState.id)}`);
    dfyDetailNormalize(data);
    dfyDetailRender();
    dfyDetailRoot.hidden = false;
  } catch (error) {
    document.getElementById('client-detail-error-copy').textContent = error.message;
    dfyDetailError.hidden = false;
  } finally {
    dfyDetailLoading.hidden = true;
    dfyDetailLoading.setAttribute('aria-busy', 'false');
  }
}

async function dfyDetailSendClaim() {
  const button = document.getElementById('send-claim-invitation');
  const email = document.getElementById('claim-recipient-email')?.value || button.dataset.defaultEmail;
  const status = document.getElementById('claim-status');
  if (!email) {
    status.className = 'dfy-action-status error';
    status.textContent = 'Choose an attached client email before sending.';
    return;
  }
  button.disabled = true;
  button.textContent = 'Sending…';
  status.className = 'dfy-action-status';
  status.textContent = '';
  try {
    const data = await api(`/api/admin/done-for-you/${encodeURIComponent(dfyDetailState.id)}/claim-invitation`, {
      method: 'POST', body: { email }
    });
    dfyDetailState.invitation = data.claimInvitation || data.claim_invitation || data.invitation || data;
    status.textContent = 'Claim invitation sent. The recipient must verify ownership before access is granted.';
    dfyDetailRenderClaim();
  } catch (error) {
    status.className = 'dfy-action-status error';
    status.textContent = error.message;
    button.disabled = false;
    button.textContent = 'Try sending again';
  }
}

document.getElementById('host-profile-form').addEventListener('submit', async event => {
  event.preventDefault();
  const hostId = dfyDetailHostId();
  const button = document.getElementById('save-host-profile');
  const status = document.getElementById('profile-status');
  if (!hostId) {
    status.className = 'dfy-action-status error';
    status.textContent = 'This client does not have a Host Page record.';
    return;
  }
  button.disabled = true;
  button.textContent = 'Saving…';
  status.className = 'dfy-action-status';
  status.textContent = '';
  try {
    const data = await api(`/api/admin/hosts/${encodeURIComponent(hostId)}/profile`, {
      method: 'PUT',
      body: {
        org_name: document.getElementById('host-name').value.trim(),
        website_url: document.getElementById('host-website').value.trim(),
        instagram_handle: document.getElementById('host-instagram').value.trim(),
        contact_email: document.getElementById('host-contact-email').value.trim(),
        bio: document.getElementById('host-bio').value.trim()
      }
    });
    dfyDetailApplyHostResponse(data);
    status.textContent = 'Host Page saved.';
    dfyDetailRender();
  } catch (error) {
    status.className = 'dfy-action-status error';
    status.textContent = error.message;
  } finally {
    button.disabled = false;
    button.textContent = 'Save Host Page';
  }
});

async function dfyDetailUpload(kind) {
  const hostId = dfyDetailHostId();
  const input = document.getElementById(`upload-${kind}-input`);
  const button = document.getElementById(`upload-${kind}-button`);
  const status = document.getElementById('media-status');
  if (!hostId || !input.files?.[0]) return;
  const body = new FormData();
  body.append('image', input.files[0]);
  button.disabled = true;
  button.textContent = 'Uploading…';
  status.className = 'dfy-action-status';
  status.textContent = '';
  try {
    const response = await fetch(`/api/admin/uploads/hosts/${encodeURIComponent(hostId)}/${kind}`, {
      method: 'POST', credentials: 'same-origin', body
    });
    if (response.status === 401) {
      location.href = `/admin/login?next=${encodeURIComponent(location.pathname)}`;
      return;
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || data.error || 'Upload failed');
    dfyDetailApplyHostResponse(data);
    status.textContent = `${kind === 'logo' ? 'Logo' : 'Header image'} saved.`;
    dfyDetailRender();
  } catch (error) {
    status.className = 'dfy-action-status error';
    status.textContent = error.message;
  } finally {
    input.value = '';
    button.disabled = false;
    button.textContent = dfyDetailFirst(dfyDetailState.host, kind === 'logo' ? ['logoUrl', 'logo_url'] : ['headerImageUrl', 'header_image_url'])
      ? `Replace ${kind === 'logo' ? 'logo' : 'header'}`
      : `Upload ${kind === 'logo' ? 'logo' : 'header'}`;
  }
}

document.getElementById('upload-logo-button').addEventListener('click', () => document.getElementById('upload-logo-input').click());
document.getElementById('upload-header-button').addEventListener('click', () => document.getElementById('upload-header-input').click());
document.getElementById('upload-logo-input').addEventListener('change', () => dfyDetailUpload('logo'));
document.getElementById('upload-header-input').addEventListener('change', () => dfyDetailUpload('header'));
document.getElementById('retry-client-detail').addEventListener('click', dfyDetailLoad);

window.adminShellSession.then(session => {
  if (session?.capabilities?.manageDoneForYou !== true) {
    location.replace('/admin');
    return;
  }
  dfyDetailLoad();
}).catch(() => {});
