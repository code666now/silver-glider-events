const crypto = require('crypto');
const { buildImportedGuestInvitationEmail } = require('./mailer');
const { signOptout } = require('./followers');

const MAX_ROWS = 100;
const HOST_LIMIT = 200;
const GLOBAL_LIMIT = 2000;
const REVIEW_TTL_MS = 15 * 60 * 1000;
const PERMISSION_VERSION = 'guest-import-event-invitation-v1';
const BUDGET_LOCK = 'guest-import-budget-v1';

class GuestImportError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
function digest(value) { return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function secret() {
  const value = String(process.env.SESSION_SECRET || '').trim();
  if (!value) throw new Error('SESSION_SECRET is required');
  return value;
}
function validEmail(value) {
  if (value.length > 254 || /[\s\x00-\x1f\x7f]/.test(value)) return false;
  const parts = value.split('@');
  if (parts.length !== 2 || !parts[0] || parts[0].length > 64 ||
      !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/i.test(parts[0]) ||
      parts[0].startsWith('.') || parts[0].endsWith('.') || parts[0].includes('..')) return false;
  const labels = parts[1].split('.');
  return labels.length > 1 && labels.every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label));
}
function normalizeRows(input) {
  if (!Array.isArray(input) || !input.length || input.length > MAX_ROWS) {
    throw new GuestImportError(400, 'invalid_rows', `Add between 1 and ${MAX_ROWS} rows at a time.`);
  }
  const seen = new Set();
  return input.map((row, index) => {
    if (!row || typeof row !== 'object' || Array.isArray(row) ||
        typeof row.email !== 'string' || (row.name != null && typeof row.name !== 'string') ||
        row.email.length > 512 || (row.name || '').length > 300) {
      throw new GuestImportError(400, 'invalid_rows', 'Each row must contain a name and email with ordinary text.');
    }
    const name = (row.name || '').trim().replace(/\s+/g, ' ');
    const email = row.email.trim().toLowerCase();
    const invalid = !validEmail(email) || name.length > 120 || /[\x00-\x1f\x7f]/.test(row.name || '');
    const status = invalid ? 'invalid' : seen.has(email) ? 'duplicate' : 'ready';
    if (!invalid) seen.add(email);
    return { index, name, email, status, message: invalid ? 'Check the email and use a name under 120 characters.'
      : status === 'duplicate' ? 'Already included in this list.' : '' };
  });
}
function inputDigest(rows) { return digest(rows.map(({ name, email }) => ({ name, email }))); }
function audienceDigest(rows) { return digest(rows.filter(row => row.status === 'ready').map(({ name, email }) => ({ name, email }))); }
function signReview(data, now = Date.now()) {
  const body = Buffer.from(JSON.stringify({ ...data, nonce: crypto.randomBytes(16).toString('hex'), expires: now + REVIEW_TTL_MS })).toString('base64url');
  const signature = crypto.createHmac('sha256', secret()).update(`guest-import-v1:${body}`).digest('hex');
  return `${body}.${signature}`;
}
function readReview(token) {
  if (typeof token !== 'string' || token.length > 4096) return null;
  const [body, signature, extra] = token.split('.');
  if (!body || extra || !/^[0-9a-f]{64}$/.test(signature || '')) return null;
  const expected = crypto.createHmac('sha256', secret()).update(`guest-import-v1:${body}`).digest('hex');
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  try {
    const data = JSON.parse(Buffer.from(body, 'base64url').toString());
    return Number.isSafeInteger(data.expires) && Number.isSafeInteger(data.eventId) &&
      Number.isSafeInteger(data.organizerId) && /^[0-9a-f]{32}$/.test(data.nonce || '') ? data : null;
  } catch (_) { return null; }
}
async function loadContext(db, eventId, organizerId, { lock = false } = {}) {
  const event = (await db.query(
    `SELECT e.*, COALESCE(o.org_name,o.name,'Silver Glider Events') AS organizer_label,
            o.user_id AS host_user_id,u.account_status,
            ((e.event_date + e.start_time) AT TIME ZONE e.timezone > CURRENT_TIMESTAMP) AS is_future
       FROM events e JOIN organizers o ON o.id=e.organizer_id JOIN users u ON u.id=o.user_id
      WHERE e.id=$1 AND e.organizer_id=$2${lock ? ' FOR UPDATE OF e' : ''}`,
    [eventId, organizerId]
  )).rows[0];
  if (!event) throw new GuestImportError(404, 'event_not_found', 'Event not found.');
  if (event.account_status !== 'active') throw new GuestImportError(403, 'account_unavailable', 'This account cannot send invitations.');
  const emails = (await db.query(
    `SELECT normalized_value FROM user_identities WHERE user_id=$1 AND identity_type='email'
      AND revoked_at IS NULL AND verification_scope='account' AND verified_at IS NOT NULL
      ORDER BY id`, [event.host_user_id]
  )).rows.map(row => row.normalized_value);
  return { event, verifiedEmails: emails };
}
function requireEligible(context, { requireEmail = true } = {}) {
  const event = context.event;
  if (event.status !== 'published' || !event.is_future || event.archived_at || event.secret_show_enabled) {
    throw new GuestImportError(409, 'event_unavailable', 'Import invitations are available for upcoming published events only.');
  }
  if (requireEmail && !context.verifiedEmails.length) {
    throw new GuestImportError(403, 'email_verification_required', 'Verify your account email before inviting a guest list.');
  }
  return context;
}
function contextDigest(context) {
  // Hash exactly the rendered content, not unrelated event update timestamps.
  return digest(buildImportedGuestInvitationEmail({
    to: 'preview@example.invalid', recipientName: '', event: context.event,
    organizerLabel: context.event.organizer_label,
    unsubscribeUrl: `${baseUrl()}/unsubscribe?preview=guest-import`
  }));
}
function baseUrl() { return String(process.env.APP_URL || 'https://silvergliderevents.com').replace(/\/$/, ''); }
function renderInvitation(context, row, { preview = false } = {}) {
  return buildImportedGuestInvitationEmail({
    to: row.email, recipientName: row.name, event: context.event,
    organizerLabel: context.event.organizer_label,
    unsubscribeUrl: preview ? `${baseUrl()}/unsubscribe?preview=guest-import`
      : `${baseUrl()}/unsubscribe?token=${signOptout(context.event.organizer_id, row.email)}`
  });
}
async function classifyRows(db, rows, context, { excludeLogId = null } = {}) {
  const ready = rows.filter(row => row.status === 'ready');
  const emails = ready.map(row => row.email);
  if (!emails.length) return rows;
  const states = (await db.query(
    `WITH proven AS (
       SELECT LOWER(TRIM(r.email)) AS email,MIN(proof.user_id) AS user_id
         FROM rsvps r JOIN events e ON e.id=r.event_id JOIN organizers proof ON proof.id=r.account_id
        WHERE e.organizer_id=$2 AND proof.user_id IS NOT NULL AND (r.user_id IS NULL OR r.user_id=proof.user_id)
        GROUP BY LOWER(TRIM(r.email)) HAVING COUNT(DISTINCT proof.user_id)=1
     )
     SELECT input.email, identity.user_id AS linked_user_id,
            EXISTS (SELECT 1 FROM follower_optouts fo
                     WHERE fo.organizer_id=$2 AND (LOWER(TRIM(fo.email))=input.email
                       OR EXISTS (SELECT 1 FROM proven alias WHERE alias.email=LOWER(TRIM(fo.email)) AND alias.user_id=identity.user_id))) AS opted_out,
            EXISTS (SELECT 1 FROM rsvps r WHERE r.event_id=$1
                      AND r.status IN ('confirmed','cancelled') AND (LOWER(TRIM(r.email))=input.email
                        OR (identity.user_id IS NOT NULL AND (r.user_id=identity.user_id
                          OR EXISTS (SELECT 1 FROM organizers proof WHERE proof.id=r.account_id AND proof.user_id=identity.user_id)))))
            OR EXISTS (SELECT 1 FROM message_log ml WHERE ml.event_id=$1
                      AND (LOWER(TRIM(ml.recipient))=input.email OR ml.recipient_user_id=identity.user_id
                        OR EXISTS (SELECT 1 FROM proven alias WHERE alias.email=LOWER(TRIM(ml.recipient)) AND alias.user_id=identity.user_id))
                      AND ($4::bigint IS NULL OR ml.id<>$4)
                      AND ml.message_type IN ('previous_guest_invite','announcement')) AS connected
       FROM UNNEST($3::text[],$5::bigint[]) AS input(email,known_user_id)
       LEFT JOIN proven exact_proof ON exact_proof.email=input.email
       CROSS JOIN LATERAL (SELECT COALESCE(input.known_user_id,exact_proof.user_id) AS user_id) identity`,
    // known_user_id is server-resolved owned RSVP proof, or the frozen proven
    // recipient from a reviewed delivery. Raw import rows never supply it.
    [context.event.id, context.event.organizer_id, emails, excludeLogId, ready.map(row => row.linkedUserId || null)]
  )).rows;
  const byEmail = new Map(states.map(row => [row.email, row]));
  return rows.map(row => {
    if (row.status !== 'ready') return row;
    const state = byEmail.get(row.email);
    const linked = { ...row, linkedUserId: state?.linked_user_id || null };
    if (state?.opted_out) return { ...linked, status: 'opted_out', message: 'Cannot receive invitations from this host.' };
    if (state?.connected) return { ...linked, status: 'already_connected', message: 'Already invited or has answered this event.' };
    return linked;
  });
}
function summarize(rows) {
  const summary = { total: rows.length, ready: 0, invalid: 0, duplicate: 0, already_connected: 0, opted_out: 0, skipped: 0 };
  rows.forEach(row => { summary[row.status] += 1; });
  summary.skipped = summary.total - summary.ready;
  return summary;
}
function budgetIdentity(secretValue, type, value) {
  return crypto.createHmac('sha256', secretValue).update(`guest-import-budget-v1:${type}:${value}`).digest('hex');
}
async function budgetState(db, context, { create = false } = {}) {
  if (create) {
    await db.query(`INSERT INTO guest_import_budget_config(singleton,identity_hmac_key)
      VALUES (TRUE,$1) ON CONFLICT DO NOTHING`, [crypto.randomBytes(32).toString('hex')]);
  }
  const config = (await db.query('SELECT identity_hmac_key FROM guest_import_budget_config WHERE singleton=TRUE')).rows[0];
  const keys = config ? {
    accountKey: budgetIdentity(config.identity_hmac_key, 'account', context.event.host_user_id),
    emailKeys: context.verifiedEmails.map(email => budgetIdentity(config.identity_hmac_key, 'email', email.toLowerCase()))
  } : { accountKey: '', emailKeys: [] };
  const totals = (await db.query(
    `SELECT COALESCE(SUM(recipient_count),0)::int AS global_used,
            COALESCE(SUM(recipient_count) FILTER (WHERE account_key=$1 OR email_keys && $2::text[]),0)::int AS host_used
       FROM guest_import_budget WHERE approved_at > NOW() - INTERVAL '24 hours'`,
    [keys.accountKey, keys.emailKeys]
  )).rows[0];
  return { ...keys, hostRemaining: Math.max(0, HOST_LIMIT - totals.host_used), globalRemaining: Math.max(0, GLOBAL_LIMIT - totals.global_used) };
}
async function loadStatus(db, batchId, eventId, organizerId) {
  const row = (await db.query(
    `SELECT b.id,b.status,b.recipient_count,b.import_skipped_count,b.completed_at,
            COUNT(ml.id) FILTER (WHERE ml.import_delivery_state='accepted')::int AS accepted,
            COUNT(ml.id) FILTER (WHERE ml.import_delivery_state='failed')::int AS failed,
            COUNT(ml.id) FILTER (WHERE ml.import_delivery_state='skipped')::int AS delivery_skipped
       FROM previous_guest_invitation_batches b
       JOIN events e ON e.id=b.target_event_id AND e.organizer_id=$3
       LEFT JOIN message_log ml ON ml.previous_guest_invitation_batch_id=b.id
      WHERE b.id=$1 AND b.target_event_id=$2 AND b.source_kind='import'
      GROUP BY b.id`, [batchId, eventId, organizerId]
  )).rows[0];
  if (!row) throw new GuestImportError(404, 'batch_not_found', 'Invitation batch not found.');
  return { batchId: String(row.id), status: row.status, total: row.recipient_count,
    queued: row.recipient_count - row.accepted - row.failed - row.delivery_skipped,
    accepted: row.accepted, failed: row.failed, skipped: row.import_skipped_count + row.delivery_skipped,
    complete: Boolean(row.completed_at) };
}

function normalizeSelection(body) {
  const faceIds = body?.faceIds || [];
  const contactIds = body?.contactIds || [];
  if (!Array.isArray(faceIds) || !Array.isArray(contactIds) || faceIds.length + contactIds.length > 600 ||
      faceIds.some(id => typeof id !== 'string' || !/^rsvp:[1-9]\d{0,9}$/.test(id)) ||
      contactIds.some(id => !/^[1-9]\d{0,17}$/.test(String(id)))) {
    throw new GuestImportError(400, 'invalid_selection', 'Choose no more than 500 people and 100 new contacts at a time.');
  }
  return { faceIds: [...new Set(faceIds)].sort(), contactIds: [...new Set(contactIds.map(String))].sort() };
}
async function resolveSelection(db, context, selection) {
  const { invitationSelectionKey } = require('./invitation-selection-key');
  const { resolveGuestImportPastFaces } = require('../routes/events');
  const past = selection.faceIds.length ? await resolveGuestImportPastFaces(db, {
    eventId: context.event.id, organizerId: context.event.organizer_id, faceIds: selection.faceIds
  }) : [];
  const contacts = selection.contactIds.length ? (await db.query(
    `SELECT id,name,email FROM host_invitation_contacts WHERE organizer_id=$1 AND id=ANY($2::bigint[]) ORDER BY id`,
    [context.event.organizer_id, selection.contactIds]
  )).rows : [];
  if (contacts.length !== selection.contactIds.length) {
    throw new GuestImportError(400, 'invalid_selection', 'Some contacts are no longer available. Refresh your selection.');
  }
  const unique = new Map();
  for (const person of past) {
    const email = String(person.email).trim().toLowerCase();
    if (!unique.has(email)) unique.set(email, { id: person.id, name: person.name || `${person.first_name || ''} ${person.last_name || ''}`.trim(),
      email, linkedUserId: person.proven_user_id || null, status: 'ready', source: 'face',
      selectionKey: invitationSelectionKey(context.event.organizer_id, email, person.proven_user_id), message: '' });
  }
  for (const person of contacts) {
    if (!unique.has(person.email)) unique.set(person.email, { id: String(person.id), name: person.name,
      email: person.email, status: 'ready', source: 'contact', selectionKey: invitationSelectionKey(context.event.organizer_id, person.email), message: '' });
  }
  if (unique.size > 500) throw new GuestImportError(400, 'invalid_selection', 'Choose no more than 500 people at a time.');
  const classified = await classifyRows(db, [...unique.values()], context);
  const byPerson = new Map();
  for (const row of classified) {
    const key = row.linkedUserId ? `user:${row.linkedUserId}` : `email:${row.email}`;
    if (!byPerson.has(key)) byPerson.set(key, { ...row,
      selectionKey: invitationSelectionKey(context.event.organizer_id, row.email, row.linkedUserId) });
  }
  const rows = [...byPerson.values()];
  const importedCount = rows.filter(row => row.source === 'contact' && row.status === 'ready').length;
  if (importedCount > MAX_ROWS) throw new GuestImportError(400, 'invalid_selection', `Choose no more than ${MAX_ROWS} new contacts at a time.`);
  const summary = summarize(rows);
  summary.duplicate = past.length + contacts.length - rows.length;
  summary.already_connected += selection.faceIds.length - past.length;
  summary.total = selection.faceIds.length + selection.contactIds.length;
  summary.skipped = summary.total - summary.ready;
  return { rows, summary, importedCount };
}

module.exports = { MAX_ROWS, HOST_LIMIT, GLOBAL_LIMIT, REVIEW_TTL_MS, PERMISSION_VERSION, BUDGET_LOCK,
  GuestImportError, digest, validEmail, normalizeRows, inputDigest, audienceDigest, signReview, readReview,
  loadContext, requireEligible, contextDigest, renderInvitation, classifyRows, summarize, budgetState, loadStatus,
  normalizeSelection, resolveSelection };
