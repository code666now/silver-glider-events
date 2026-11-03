const crypto = require('crypto');
const { slugify } = require('./slug');
const { cleanContactEmail, cleanInstagramHandle, cleanProfileUrl } = require('./host-profile');
const { createSignInChallenge } = require('./sign-in-challenges');
const { withActiveHostAccount } = require('./outbound-account-status');

const APPROVAL_VERSION = 'contributor-spotlight-v1';
const APPROVAL_TEXT = 'I approve this introduction and allow my name, role, photo, and links to appear in this event’s thank-you and on my public introduction page.';
const FOLLOW_VERSION = 'contributor-follow-v1';
const MAX_CONTRIBUTORS = 3;
const TOKEN_DAYS = 14;

class ContributorError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'ContributorError';
    this.status = status;
    this.code = code;
  }
}

function normalizeEmail(value) {
  const result = cleanContactEmail(value);
  if (result.error || !result.value) throw new ContributorError(400, 'invalid_email', 'Enter a valid email');
  return result.value;
}

function cleanText(value, max, label) {
  const text = String(value || '').trim().replace(/\s+/g, ' ');
  if (!text || text.length > max || /[\u0000-\u001f\u007f]/.test(text)) {
    throw new ContributorError(400, 'invalid_details', `${label} must be 1–${max} characters`);
  }
  return text;
}

function normalizeContributor(body = {}) {
  const instagram = cleanInstagramHandle(body.instagram_handle);
  const website = cleanProfileUrl(body.website_url, 'website');
  if (instagram.error || website.error) throw new ContributorError(400, 'invalid_link', instagram.error || website.error);
  return {
    name: cleanText(body.name, 100, 'Name'),
    email: normalizeEmail(body.email),
    role: cleanText(body.role, 80, 'Role'),
    instagramHandle: instagram.value,
    websiteUrl: website.value
  };
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function deliveryKey() {
  const secret = String(process.env.SESSION_SECRET || '').trim();
  if (!secret) throw new Error('SESSION_SECRET is required');
  return crypto.createHash('sha256').update(`contributor-delivery-v1:${secret}`).digest();
}

function sealPayload(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', deliveryKey(), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map(part => part.toString('base64url')).join('.');
}

function openPayload(value) {
  const [iv, tag, data] = String(value).split('.').map(part => Buffer.from(part, 'base64url'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', deliveryKey(), iv);
  decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8'));
}

function baseUrl() {
  return String(process.env.APP_URL || 'http://localhost:3100').replace(/\/$/, '');
}

function profilePath(profile) {
  const path = `/people/${encodeURIComponent(profile.slug)}`;
  return /^[a-f0-9]{24}$/.test(String(profile.public_ref || '')) ? `${path}?intro=${profile.public_ref}` : path;
}

async function transaction(db, fn) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

async function ownerEvent(db, eventId, organizerId, { lock = false, editable = false } = {}) {
  const { eventEndAtSql } = require('./post-event');
  const result = await db.query(
    `SELECT e.*,COALESCE(NULLIF(BTRIM(o.org_name),''),NULLIF(BTRIM(o.name),''),'Your host') AS host_name,
            (e.status='published' AND NOW() >= ${eventEndAtSql('e')}) AS ended
       FROM events e JOIN organizers o ON o.id=e.organizer_id
       JOIN users u ON u.id=o.user_id AND u.account_status='active'
      WHERE e.id=$1 AND e.organizer_id=$2 ${lock ? 'FOR UPDATE OF e' : ''}`,
    [eventId, organizerId]
  );
  const row = result.rows[0];
  if (!row) throw new ContributorError(404, 'event_not_found', 'Event not found');
  if (!row.ended) throw new ContributorError(409, 'event_not_ended', 'Introductions are available after a published event ends');
  if (editable && (await db.query(
    'SELECT 1 FROM post_event_thank_you_batches WHERE event_id=$1 AND approved_at IS NOT NULL', [eventId]
  )).rows.length) throw new ContributorError(409, 'thank_you_approved', 'This thank-you has already been approved');
  return row;
}

function ownerContributor(row) {
  return {
    id: Number(row.id), name: row.name, email: row.email, role: row.role,
    status: row.status, selected: row.selected, version: Number(row.version),
    photoUrl: row.photo_url || null,
    profileUrl: row.status === 'approved' ? profilePath(row) : null,
    invitationSentAt: row.invitation_sent_at || null
  };
}

async function listContributors(db, eventId, organizerId) {
  const event = await ownerEvent(db, eventId, organizerId);
  const { rows } = await db.query(
    `SELECT c.*,p.slug FROM event_contributors c JOIN contributor_profiles p ON p.id=c.profile_id
      WHERE c.event_id=$1 AND c.organizer_id=$2 AND c.status<>'revoked' ORDER BY c.slot,c.id`,
    [eventId, organizerId]
  );
  const suggestions = [1, 2, 3].map(slot => {
    const suffix = slot === 1 ? '' : `_${slot}`;
    return { name: event[`event_vibe_label${suffix}`], role: 'Artist', slot };
  }).filter(item => item.name);
  return { contributors: rows.map(ownerContributor), suggestions, max: MAX_CONTRIBUTORS, maxContributors: MAX_CONTRIBUTORS };
}

async function inviteContributor(db, { eventId, organizerId, body }) {
  const data = normalizeContributor(body);
  const id = await transaction(db, async client => {
    const event = await ownerEvent(client, eventId, organizerId, { lock: true, editable: true });
    if ((await client.query('SELECT 1 FROM follower_optouts WHERE organizer_id=$1 AND LOWER(BTRIM(email))=$2',
      [organizerId, data.email])).rows.length) {
      throw new ContributorError(409, 'recipient_opted_out', 'This person has opted out of emails from you');
    }
    const current = (await client.query(
      `SELECT id,slot,email FROM event_contributors WHERE event_id=$1 AND status<>'revoked' ORDER BY slot FOR UPDATE`, [eventId]
    )).rows;
    const existing = current.find(row => row.email === data.email);
    if (existing) return existing.id;
    const slot = [1, 2, 3].find(value => !current.some(row => Number(row.slot) === value));
    if (!slot) throw new ContributorError(409, 'contributor_limit', 'You can introduce up to three people');
    const profile = (await client.query(
      `INSERT INTO contributor_profiles(email,slug,name,role) VALUES($1,$2,$3,$4)
       ON CONFLICT(email) DO UPDATE SET email=EXCLUDED.email RETURNING id`,
      [data.email, `${slugify(data.name) || 'person'}-${crypto.randomBytes(6).toString('hex')}`, data.name, data.role]
    )).rows[0];
    const token = crypto.randomBytes(32).toString('base64url');
    const payload = sealPayload({ to: data.email, hostName: event.host_name, eventTitle: event.title,
      intakeUrl: `${baseUrl()}/contributors/intake/${token}` });
    const inserted = await client.query(
      `INSERT INTO event_contributors(event_id,organizer_id,profile_id,slot,email,name,role,token_hash,token_expires_at,invitation_payload,public_ref)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,NOW()+make_interval(days=>$9),$10,$11) RETURNING id`,
      [eventId, organizerId, profile.id, slot, data.email, data.name, data.role, tokenHash(token), TOKEN_DAYS, payload,
        crypto.randomBytes(12).toString('hex')]
    );
    return inserted.rows[0].id;
  });
  const invitationSent = await deliverContributorEmail(db, id, 'invitation');
  const row = (await db.query(
    'SELECT c.*,p.slug FROM event_contributors c JOIN contributor_profiles p ON p.id=c.profile_id WHERE c.id=$1', [id]
  )).rows[0];
  return { contributor: ownerContributor(row), invitationSent };
}

// Frozen payload plus provider idempotency protects retries after an ambiguous
// transport result. There is no automatic scheduler or guest-list send here.
async function deliverContributorEmail(db, id, kind) {
  if (!['invitation', 'claim'].includes(kind)) throw new Error('Invalid contributor delivery kind');
  const owner = (await db.query('SELECT organizer_id FROM event_contributors WHERE id=$1', [id])).rows[0];
  if (!owner) return false;
  const guarded = await withActiveHostAccount(db, owner.organizer_id, async client => {
    const lock = `contributor-email:${id}:${kind}`;
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [lock]);
    try {
      const row = (await client.query(
        `SELECT c.* FROM event_contributors c
          WHERE c.id=$1 AND c.status<>'revoked'
            AND NOT EXISTS (SELECT 1 FROM follower_optouts f
              WHERE f.organizer_id=c.organizer_id AND LOWER(BTRIM(f.email))=c.email)`, [id]
      )).rows[0];
      if (!row || !row[`${kind}_payload`]) return false;
      if (row[`${kind}_sent_at`]) return true;
      const started = row[`${kind}_attempted_at`];
      if (Number(row[`${kind}_attempts`]) >= 3 || (started && Date.now() - new Date(started).getTime() > 23 * 3600000)) return false;
      await client.query(
        `UPDATE event_contributors SET ${kind}_attempts=${kind}_attempts+1,
          ${kind}_attempted_at=COALESCE(${kind}_attempted_at,NOW()) WHERE id=$1`, [id]
      );
      const payload = openPayload(row[`${kind}_payload`]);
      const mailer = require('./mailer');
      const send = kind === 'invitation' ? mailer.sendContributorInvitation : mailer.sendContributorClaim;
      await send({ ...payload, idempotencyKey: `contributor-${kind}-v1-${id}` });
      await client.query(`UPDATE event_contributors SET ${kind}_sent_at=NOW() WHERE id=$1`, [id]);
      return true;
    } finally { await client.query('SELECT pg_advisory_unlock(hashtext($1))', [lock]); }
  });
  return guarded.allowed && guarded.result === true;
}

async function loadIntake(db, token, { lock = false } = {}) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(String(token || ''))) throw new ContributorError(404, 'invitation_not_found', 'This invitation is unavailable or expired');
  const { rows } = await db.query(
    `SELECT c.*,p.slug,p.owner_user_id,e.title AS event_title,
            COALESCE(NULLIF(BTRIM(o.org_name),''),NULLIF(BTRIM(o.name),''),'Your host') AS host_name
       FROM event_contributors c JOIN contributor_profiles p ON p.id=c.profile_id
       JOIN events e ON e.id=c.event_id AND e.organizer_id=c.organizer_id
       JOIN organizers o ON o.id=c.organizer_id JOIN users u ON u.id=o.user_id AND u.account_status='active'
      WHERE c.token_hash=$1 AND c.token_expires_at>NOW() AND c.status<>'revoked'
      ${lock ? 'FOR UPDATE OF c' : ''}`, [tokenHash(token)]
  );
  if (!rows[0]) throw new ContributorError(404, 'invitation_not_found', 'This invitation is unavailable or expired');
  return rows[0];
}

function intakeDto(row) {
  return { name: row.name, email: row.email, role: row.role, photoUrl: row.photo_url || null,
    instagramHandle: row.instagram_handle || null, websiteUrl: row.website_url || null,
    hostName: row.host_name, eventTitle: row.event_title, approved: row.status === 'approved',
    approvalVersion: APPROVAL_VERSION, approvalText: APPROVAL_TEXT,
    claimRequired: !row.owner_user_id, claimEmailSent: Boolean(row.claim_sent_at),
    profileUrl: row.status === 'approved' ? profilePath(row) : null };
}

async function approveContributor(db, token, body) {
  if (body.approval !== true || body.approvalVersion !== APPROVAL_VERSION) {
    throw new ContributorError(400, 'approval_required', 'Approve this introduction to be included');
  }
  const data = normalizeContributor(body);
  const row = await transaction(db, async client => {
    const invitation = await loadIntake(client, token, { lock: true });
    if (data.email !== invitation.email) throw new ContributorError(400, 'email_mismatch', 'Use the email address this invitation was sent to');
    if (invitation.status === 'approved') return invitation;
    const challenge = await createSignInChallenge(client, {
      email: invitation.email, intent: 'sign_in', returnPath: `/contributors/claim/${invitation.id}`,
      withCode: false, ttlMinutes: 60 * 24 * TOKEN_DAYS
    });
    const payload = sealPayload({ to: invitation.email, hostName: invitation.host_name, eventTitle: invitation.event_title,
      name: data.name, claimUrl: `${baseUrl()}/auth/verify?token=${challenge.token}` });
    await client.query(
      `UPDATE event_contributors SET name=$2,role=$3,instagram_handle=$4,website_url=$5,
        status='approved',approved_at=NOW(),approval_version=$6,approval_text=$7,version=version+1,
        claim_payload=$8,updated_at=NOW() WHERE id=$1`,
      [invitation.id, data.name, data.role, data.instagramHandle, data.websiteUrl, APPROVAL_VERSION, APPROVAL_TEXT, payload]
    );
    // Approval may prepare an unclaimed page, but cannot overwrite an existing
    // canonical user's Host Page or any claimed staging profile.
    await client.query(
      `UPDATE contributor_profiles SET name=$2,role=$3,photo_url=$4,instagram_handle=$5,website_url=$6,updated_at=NOW()
        WHERE id=$1 AND owner_user_id IS NULL`,
      [invitation.profile_id, data.name, data.role, invitation.photo_url, data.instagramHandle, data.websiteUrl]
    );
    return { ...invitation, status: 'approved' };
  });
  let claimEmailSent = false;
  try { claimEmailSent = await deliverContributorEmail(db, row.id, 'claim'); } catch (_) { /* Explicit retry preserves the frozen email. */ }
  return { approved: true, profileUrl: profilePath(row), claimEmailSent, claimRequired: !row.owner_user_id };
}

async function loadApprovedContributorSpotlights(db, { eventId, organizerId }) {
  const { rows } = await db.query(
    `SELECT c.*,p.slug FROM event_contributors c JOIN contributor_profiles p ON p.id=c.profile_id
       JOIN events e ON e.id=c.event_id AND e.organizer_id=c.organizer_id
      WHERE c.event_id=$1 AND c.organizer_id=$2 AND c.status='approved'
        AND c.approved_at IS NOT NULL AND c.revoked_at IS NULL AND c.selected=TRUE
        AND (p.owner_user_id IS NULL OR EXISTS (
          SELECT 1 FROM users u WHERE u.id=p.owner_user_id AND u.account_status='active'))
      ORDER BY c.slot,c.id LIMIT 3`, [eventId, organizerId]
  );
  return rows.map(row => ({ id: Number(row.id), profileId: Number(row.profile_id), name: row.name,
    role: row.role, photoUrl: row.photo_url || null, profileUrl: profilePath(row),
    approvalVersion: `${row.approval_version}:${row.version}`, updatedAt: row.updated_at }));
}

async function contributorSpotlightsStillApproved(db, { eventId, organizerId, spotlights }) {
  if (!Array.isArray(spotlights) || spotlights.length > 3) return false;
  const current = await loadApprovedContributorSpotlights(db, { eventId, organizerId });
  return spotlights.every(item => current.some(row => row.id === Number(item.id) &&
    row.profileId === Number(item.profileId) && row.approvalVersion === item.approvalVersion));
}

async function verifiedAccount(db, userId, email = null) {
  const { rows } = await db.query(
    `SELECT o.id,o.user_id,o.email FROM organizers o JOIN users u ON u.id=o.user_id AND u.account_status='active'
      WHERE o.user_id=$1 AND o.id=$1 AND EXISTS (
        SELECT 1 FROM user_identities i WHERE i.user_id=o.user_id AND i.identity_type='email'
          AND i.verification_scope='account' AND i.verified_at IS NOT NULL AND i.revoked_at IS NULL
          AND i.normalized_value=COALESCE($2,LOWER(BTRIM(o.email))))`, [userId, email]
  );
  return rows[0] || null;
}

async function loadPublicProfile(db, slug, intro = null) {
  const { rows } = await db.query(
    `SELECT p.*,o.public_slug AS host_slug,o.org_name AS host_public_name,o.logo_url AS host_logo,
            o.instagram_handle AS host_instagram,o.website_url AS host_website
       FROM contributor_profiles p LEFT JOIN organizers o ON o.user_id=p.owner_user_id
       LEFT JOIN users u ON u.id=p.owner_user_id
      WHERE p.slug=$1 AND ((p.owner_user_id IS NOT NULL AND u.account_status='active') OR
        (p.owner_user_id IS NULL AND EXISTS (
          SELECT 1 FROM event_contributors c JOIN organizers h ON h.id=c.organizer_id
          JOIN users hu ON hu.id=h.user_id AND hu.account_status='active'
          WHERE c.profile_id=p.id AND c.status='approved' AND c.revoked_at IS NULL)))`, [String(slug || '')]
  );
  if (!rows[0]) throw new ContributorError(404, 'profile_not_found', 'This introduction is unavailable');
  const profile = { ...rows[0], source_event_id: null };
  if (intro !== null && intro !== undefined) {
    if (typeof intro !== 'string' || !/^[a-f0-9]{24}$/.test(intro)) {
      throw new ContributorError(404, 'introduction_not_found', 'This introduction is unavailable');
    }
    const association = (await db.query(
      `SELECT c.event_id FROM event_contributors c JOIN organizers h ON h.id=c.organizer_id
        JOIN users u ON u.id=h.user_id AND u.account_status='active'
        JOIN events e ON e.id=c.event_id AND e.organizer_id=c.organizer_id
        WHERE c.public_ref=$1 AND c.profile_id=$2 AND c.status='approved'
          AND c.approved_at IS NOT NULL AND c.revoked_at IS NULL`, [intro, profile.id]
    )).rows[0];
    if (!association) throw new ContributorError(404, 'introduction_not_found', 'This introduction is unavailable');
    profile.source_event_id = association.event_id;
  }
  return profile;
}

function publicProfileDto(row) {
  return { name: row.owner_user_id ? row.host_public_name || row.name : row.name,
    role: row.role, photoUrl: row.owner_user_id ? row.host_logo || row.photo_url : row.photo_url,
    instagramHandle: row.owner_user_id ? row.host_instagram || null : row.instagram_handle,
    websiteUrl: row.owner_user_id ? row.host_website || null : row.website_url,
    claimed: Boolean(row.owner_user_id), profileUrl: row.host_slug ? `/h/${encodeURIComponent(row.host_slug)}` : profilePath(row) };
}

async function followState(db, profile, followerId) {
  if (!followerId) return { following: false, pending: false };
  if (profile.owner_user_id) {
    const active = (await db.query(
      `SELECT 1 FROM host_follows f WHERE f.host_organizer_id=$1 AND f.follower_user_id=$2
        AND f.unsubscribed_at IS NULL AND f.email_opted_in_at IS NOT NULL
        AND NOT EXISTS(SELECT 1 FROM follower_optouts x JOIN organizers o ON o.user_id=$2
          WHERE x.organizer_id=f.host_organizer_id AND LOWER(BTRIM(x.email))=LOWER(BTRIM(o.email)))`,
      [profile.owner_user_id, followerId]
    )).rows.length > 0;
    return { following: active, pending: false };
  }
  const active = (await db.query(
    'SELECT 1 FROM contributor_follow_intents WHERE profile_id=$1 AND follower_user_id=$2 AND withdrawn_at IS NULL',
    [profile.id, followerId]
  )).rows.length > 0;
  return { following: active, pending: active };
}

async function activateFollow(client, profile, intent, { explicit = false } = {}) {
  const follower = await verifiedAccount(client, intent.follower_user_id);
  if (!follower || Number(follower.user_id) === Number(profile.owner_user_id)) return false;
  const existing = (await client.query(
    'SELECT * FROM host_follows WHERE follower_organizer_id=$1 AND host_organizer_id=$2 FOR UPDATE',
    [follower.id, profile.owner_user_id]
  )).rows[0];
  const optedOut = (await client.query(
    'SELECT 1 FROM follower_optouts WHERE organizer_id=$1 AND LOWER(BTRIM(email))=LOWER(BTRIM($2))',
    [profile.owner_user_id, follower.email]
  )).rows.length > 0;
  // A new affirmative action may restore email; claiming a page must never
  // resurrect an older unsubscribe or alter the independently chosen SMS state.
  if (!explicit && (optedOut || existing?.unsubscribed_at)) return false;
  await client.query(
    `INSERT INTO host_follows(follower_organizer_id,follower_user_id,host_organizer_id,source_event_id,
       email_opted_in_at,email_consent_source,email_consent_version,email_consent_text)
     VALUES($1,$2,$3,$4,$5,'contributor_page',$6,$7)
     ON CONFLICT(follower_organizer_id,host_organizer_id) DO UPDATE SET
       follower_user_id=EXCLUDED.follower_user_id,unsubscribed_at=NULL,
       email_opted_in_at=COALESCE(host_follows.email_opted_in_at,EXCLUDED.email_opted_in_at),
       email_consent_source=CASE WHEN host_follows.email_opted_in_at IS NULL THEN EXCLUDED.email_consent_source ELSE host_follows.email_consent_source END,
       email_consent_version=CASE WHEN host_follows.email_opted_in_at IS NULL THEN EXCLUDED.email_consent_version ELSE host_follows.email_consent_version END,
       email_consent_text=CASE WHEN host_follows.email_opted_in_at IS NULL THEN EXCLUDED.email_consent_text ELSE host_follows.email_consent_text END,
       source_event_id=COALESCE(host_follows.source_event_id,EXCLUDED.source_event_id),updated_at=NOW()`,
    [follower.id, follower.user_id, profile.owner_user_id, intent.source_event_id,
      intent.email_consent_at, intent.consent_version, intent.consent_text]
  );
  if (explicit) await client.query('DELETE FROM follower_optouts WHERE organizer_id=$1 AND LOWER(BTRIM(email))=LOWER(BTRIM($2))',
    [profile.owner_user_id, follower.email]);
  await client.query('UPDATE contributor_follow_intents SET activated_at=COALESCE(activated_at,NOW()),updated_at=NOW() WHERE id=$1', [intent.id]);
  return true;
}

async function setContributorFollow(db, { slug, intro = null, userId, body = {}, remove = false }) {
  return transaction(db, async client => {
    let profile = await loadPublicProfile(client, slug, intro);
    await client.query('SELECT id FROM contributor_profiles WHERE id=$1 FOR UPDATE', [profile.id]);
    profile = await loadPublicProfile(client, slug, intro);
    // Re-read ownership after acquiring the common claim/follow lock.
    const current = (await client.query('SELECT * FROM contributor_profiles WHERE id=$1', [profile.id])).rows[0];
    const account = await verifiedAccount(client, userId);
    if (!account) throw new ContributorError(403, 'verified_email_required', 'Sign in with a verified email to follow');
    if (Number(current.owner_user_id) === Number(userId)) throw new ContributorError(400, 'cannot_follow_self', 'You cannot follow your own page');
    if (remove) {
      await client.query('UPDATE contributor_follow_intents SET withdrawn_at=NOW(),updated_at=NOW() WHERE profile_id=$1 AND follower_user_id=$2', [profile.id, userId]);
      if (current.owner_user_id) await require('./host-follows').unfollowHost(client, account.id, current.owner_user_id);
      return { following: false, pending: false };
    }
    if (body.emailConsent !== true || body.consentVersion !== FOLLOW_VERSION) {
      throw new ContributorError(400, 'follow_consent_required', 'Choose email updates before following');
    }
    const text = `Email me about future events from ${publicProfileDto(profile).name}. Unsubscribe anytime.`;
    const intent = (await client.query(
      `INSERT INTO contributor_follow_intents(profile_id,follower_user_id,source_event_id,consent_version,consent_text)
       VALUES($1,$2,$3,$4,$5) ON CONFLICT(profile_id,follower_user_id) DO UPDATE SET
         email_consent_at=NOW(),consent_version=EXCLUDED.consent_version,consent_text=EXCLUDED.consent_text,
         withdrawn_at=NULL,updated_at=NOW() RETURNING *`,
      [profile.id, userId, profile.source_event_id, FOLLOW_VERSION, text]
    )).rows[0];
    if (current.owner_user_id) await activateFollow(client, current, intent, { explicit: true });
    return { following: true, pending: !current.owner_user_id };
  });
}

async function claimContext(db, contributorId, userId, { lock = false } = {}) {
  const { rows } = await db.query(
    `SELECT c.id,c.email,c.status,c.event_id,c.profile_id,c.name,c.role,c.photo_url,c.instagram_handle,c.website_url,
            p.slug,p.owner_user_id,e.title AS event_title,
            COALESCE(NULLIF(BTRIM(h.org_name),''),NULLIF(BTRIM(h.name),''),'Your host') AS host_name
       FROM event_contributors c JOIN contributor_profiles p ON p.id=c.profile_id
       JOIN events e ON e.id=c.event_id JOIN organizers h ON h.id=c.organizer_id
       JOIN users u ON u.id=h.user_id AND u.account_status='active'
      WHERE c.id=$1 AND c.status='approved' AND c.revoked_at IS NULL
      ${lock ? 'FOR UPDATE OF p' : ''}`, [contributorId]
  );
  const row = rows[0];
  if (!row) throw new ContributorError(404, 'claim_not_found', 'This introduction is unavailable');
  if (!await verifiedAccount(db, userId, row.email) || (row.owner_user_id && Number(row.owner_user_id) !== Number(userId))) {
    throw new ContributorError(403, 'claim_email_mismatch', 'Sign in with the verified email this invitation was sent to');
  }
  const host = (await db.query('SELECT public_slug FROM organizers WHERE user_id=$1 AND id=$1', [userId])).rows[0];
  const counts = (await db.query(
    `SELECT COUNT(*)::int AS count FROM contributor_follow_intents i
      JOIN users f ON f.id=i.follower_user_id AND f.account_status='active'
      WHERE i.profile_id=$1 AND i.source_event_id=$4 AND i.withdrawn_at IS NULL
        AND i.consent_version=$2 AND i.follower_user_id<>$3
        AND EXISTS(SELECT 1 FROM user_identities identity JOIN organizers follower ON follower.user_id=i.follower_user_id
          WHERE identity.user_id=i.follower_user_id AND identity.identity_type='email'
            AND identity.verification_scope='account' AND identity.verified_at IS NOT NULL
            AND identity.revoked_at IS NULL AND identity.normalized_value=LOWER(BTRIM(follower.email)))
        AND NOT EXISTS(SELECT 1 FROM follower_optouts x JOIN organizers o ON o.user_id=i.follower_user_id
          WHERE x.organizer_id=$3 AND LOWER(BTRIM(x.email))=LOWER(BTRIM(o.email)))
        AND NOT EXISTS(SELECT 1 FROM host_follows x WHERE x.host_organizer_id=$3
          AND x.follower_user_id=i.follower_user_id AND x.unsubscribed_at IS NOT NULL)`,
    [row.profile_id, FOLLOW_VERSION, userId, row.event_id]
  )).rows[0];
  return { row, profileUrl: host?.public_slug ? `/h/${encodeURIComponent(host.public_slug)}` : profilePath(row), followersCount: Number(counts?.count || 0),
    eventTitle: row.event_title, hostName: row.host_name, claimed: Boolean(row.owner_user_id), name: row.name };
}

async function claimContributor(db, contributorId, userId) {
  return transaction(db, async client => {
    const context = await claimContext(client, contributorId, userId, { lock: true });
    const row = context.row;
    const organizer = (await client.query('SELECT * FROM organizers WHERE id=$1 AND user_id=$1 FOR UPDATE', [userId])).rows[0];
    if (!organizer.public_slug) {
      const publicSlug = `${slugify(organizer.org_name || row.name) || 'host'}-${crypto.randomBytes(4).toString('hex')}`;
      await client.query(
        `UPDATE organizers SET public_slug=$2,org_name=COALESCE(NULLIF(BTRIM(org_name),''),$3),
          logo_url=COALESCE(logo_url,$4),instagram_handle=COALESCE(instagram_handle,$5),
          website_url=COALESCE(website_url,$6),host_page_created_at=COALESCE(host_page_created_at,NOW()),updated_at=NOW()
          WHERE id=$1`, [userId, publicSlug, row.name, row.photo_url, row.instagram_handle, row.website_url]
      );
    }
    await client.query('UPDATE contributor_profiles SET owner_user_id=$2,claimed_at=COALESCE(claimed_at,NOW()),updated_at=NOW() WHERE id=$1', [row.profile_id, userId]);
    const profile = { id: row.profile_id, owner_user_id: userId };
    const intents = (await client.query(
      `SELECT * FROM contributor_follow_intents WHERE profile_id=$1 AND withdrawn_at IS NULL AND consent_version=$2 FOR UPDATE`,
      [row.profile_id, FOLLOW_VERSION]
    )).rows;
    for (const intent of intents) await activateFollow(client, profile, intent);
    const result = await claimContext(client, contributorId, userId);
    delete result.row;
    return result;
  });
}

module.exports = {
  APPROVAL_VERSION, APPROVAL_TEXT, FOLLOW_VERSION, MAX_CONTRIBUTORS, ContributorError,
  normalizeEmail, normalizeContributor, tokenHash, sealPayload, openPayload,
  transaction, ownerEvent, ownerContributor, listContributors, inviteContributor,
  deliverContributorEmail, loadIntake, intakeDto, approveContributor,
  loadApprovedContributorSpotlights, contributorSpotlightsStillApproved,
  verifiedAccount, loadPublicProfile, publicProfileDto, followState,
  setContributorFollow, claimContext, claimContributor
};
