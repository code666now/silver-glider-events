const crypto = require('crypto');
const { EVENT_EMAIL_CONSENT_VERSION } = require('./event-email-consent');

const SUBJECT_MAX = 160;
const MESSAGE_MAX = 4000;
const PREVIEW_TTL_SECONDS = 15 * 60;

class PostEventError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'PostEventError';
    this.status = status;
    this.code = code;
  }
}

function eventEndAtSql(alias = 'e') {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) throw new Error('Invalid SQL alias');
  return `(
    (${alias}.event_date + COALESCE(${alias}.end_time,${alias}.start_time)
      + CASE
          WHEN ${alias}.end_time IS NULL THEN INTERVAL '2 hours'
          WHEN ${alias}.end_time <= ${alias}.start_time THEN INTERVAL '1 day'
          ELSE INTERVAL '0'
        END)
    AT TIME ZONE ${alias}.timezone
  )`;
}

function normalizeDraft(input = {}) {
  const subject = String(input.subject || '').trim();
  const message = String(input.message || '').replace(/\r\n?/g, '\n').trim();
  if (!subject || subject.length > SUBJECT_MAX || /[\r\n]/.test(subject)) {
    throw new PostEventError(400, 'invalid_subject', `Subject must be 1–${SUBJECT_MAX} characters on one line`);
  }
  if (!message || message.length > MESSAGE_MAX) {
    throw new PostEventError(400, 'invalid_message', `Message must be 1–${MESSAGE_MAX} characters`);
  }
  return { subject, message, includeFollow: input.includeFollow === true };
}

function defaultThankYouDraft(event, host) {
  const eventTitle = String(event?.title || 'your event').replace(/\s+/g, ' ').trim();
  const hostName = String(host?.org_name || host?.name || 'Your host').replace(/\s+/g, ' ').trim();
  return normalizeDraft({
    subject: `Thanks for being part of ${eventTitle}`.slice(0, SUBJECT_MAX),
    message: `Thanks for being part of ${eventTitle}. It meant a lot to bring everyone together.\n\n— ${hostName}`,
    includeFollow: Boolean(host?.public_slug)
  });
}

function digest(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function draftDigest(draft) {
  const clean = normalizeDraft(draft);
  return digest(JSON.stringify([clean.subject, clean.message, clean.includeFollow]));
}

function audienceDigest(recipients) {
  const stable = (Array.isArray(recipients) ? recipients : [])
    .map(recipient => [
      Number(recipient.rsvpId),
      Number(recipient.userId) || null,
      String(recipient.email || '').trim().toLowerCase(),
      Boolean(recipient.alreadyFollowing),
      String(recipient.consentSource || ''),
      String(recipient.consentScope || 'host')
    ])
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return digest(JSON.stringify(stable));
}

function emailRenderSnapshot(event, host) {
  return {
    event: {
      id: Number(event?.id),
      title: String(event?.title || ''),
      event_date: event?.event_date || null,
      presentation_mode: event?.presentation_mode || null,
      flyer_image_url: event?.flyer_image_url || null,
      cover_image_url: event?.cover_image_url || null,
      artwork_accent_color: event?.artwork_accent_color || null
    },
    host: {
      id: Number(host?.id),
      email: String(host?.email || ''),
      name: host?.name || null,
      org_name: host?.org_name || null,
      public_slug: host?.public_slug || null,
      logo_url: host?.logo_url || null
    }
  };
}

function renderSnapshotDigest(snapshot) {
  return digest(JSON.stringify(snapshot));
}

function previewSecret() {
  const secret = String(process.env.SESSION_SECRET || '').trim();
  if (!secret) throw new Error('SESSION_SECRET is required');
  return secret;
}

function signPreviewToken({ eventId, batchId, draftHash, audienceHash, renderHash, now = Date.now() }) {
  const payload = Buffer.from(JSON.stringify({
    v: 1,
    eventId: Number(eventId),
    batchId: String(batchId),
    draftHash,
    audienceHash,
    renderHash,
    exp: Math.floor(now / 1000) + PREVIEW_TTL_SECONDS
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', previewSecret()).update(payload).digest('hex');
  return `${payload}.${signature}`;
}

function verifyPreviewToken(token, { now = Date.now() } = {}) {
  const [payload, signature, extra] = String(token || '').split('.');
  if (!payload || !signature || extra) return null;
  if (!/^[a-f0-9]{64}$/.test(signature)) return null;
  const expected = crypto.createHmac('sha256', previewSecret()).update(payload).digest('hex');
  if (signature.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  let parsed;
  try { parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch (_) { return null; }
  if (parsed?.v !== 1 || !Number.isInteger(parsed.eventId) || !parsed.batchId ||
      !/^[a-f0-9]{64}$/.test(parsed.draftHash || '') ||
      !/^[a-f0-9]{64}$/.test(parsed.audienceHash || '') ||
      !/^[a-f0-9]{64}$/.test(parsed.renderHash || '') ||
      !Number.isFinite(parsed.exp) || parsed.exp < Math.floor(now / 1000)) return null;
  return parsed;
}

async function loadPostEventContext(db, { eventId, organizerId, lock = false }) {
  const endSql = eventEndAtSql('e');
  const { rows } = await db.query(
    `SELECT e.*,
            o.id AS post_host_id,o.user_id AS post_host_user_id,o.email AS post_host_email,
            o.name AS post_host_name,o.org_name AS post_host_org_name,
            o.public_slug AS post_host_public_slug,o.logo_url AS post_host_logo_url,
            ${endSql} AS post_event_ends_at,
            (e.status='published' AND NOW() >= ${endSql}) AS post_ended
       FROM events e
       JOIN organizers o ON o.id=e.organizer_id
      WHERE e.id=$1 AND e.organizer_id=$2
      ${lock ? 'FOR UPDATE OF e' : ''}`,
    [eventId, organizerId]
  );
  const row = rows[0];
  if (!row) return null;

  const { rows: statRows } = await db.query(
    `WITH target AS (
       SELECT id,organizer_id,event_date,start_time FROM events WHERE id=$1
     ), current_people AS (
       SELECT DISTINCT ON (
                COALESCE('user:' || current.user_id::text,
                         'email:' || LOWER(BTRIM(current.email)))
              )
              current.id,current.user_id,current.email,current.created_at
         FROM rsvps current
        WHERE current.event_id=$1 AND current.status='confirmed'
        ORDER BY COALESCE('user:' || current.user_id::text,
                          'email:' || LOWER(BTRIM(current.email))),
                 current.created_at DESC,current.id DESC
     ), people AS (
       SELECT current.*,
              EXISTS (
                SELECT 1
                  FROM rsvps prior
                  JOIN events prior_event ON prior_event.id=prior.event_id
                  CROSS JOIN target
                 WHERE prior_event.organizer_id=$2
                   AND prior.status='confirmed'
                   AND (prior_event.event_date < target.event_date
                        OR (prior_event.event_date=target.event_date
                            AND prior_event.start_time < target.start_time)
                        OR (prior_event.event_date=target.event_date
                            AND prior_event.start_time=target.start_time
                            AND prior_event.id < target.id))
                   AND ((current.user_id IS NOT NULL AND prior.user_id=current.user_id)
                        OR ((current.user_id IS NULL OR prior.user_id IS NULL)
                            AND LOWER(BTRIM(prior.email))=LOWER(BTRIM(current.email))))
              ) AS is_returning
         FROM current_people current
     )
     SELECT
       (SELECT COUNT(*)::int FROM rsvps WHERE event_id=$1 AND status='confirmed') AS rsvp_submissions,
       (SELECT COUNT(*)::int FROM rsvps
         WHERE event_id=$1 AND status='confirmed'
           AND NULLIF(BTRIM(guest_first_name),'') IS NOT NULL) AS additional_guests,
       (SELECT COUNT(*)::int FROM people WHERE is_returning) AS returning_count,
       (SELECT COUNT(*)::int FROM people WHERE NOT is_returning) AS new_faces,
       (SELECT COUNT(*)::int FROM event_comments WHERE event_id=$1) AS comments`,
    [eventId, organizerId]
  );
  const stat = statRows[0] || {};
  const stats = {
    rsvpSubmissions: Number(stat.rsvp_submissions || 0),
    additionalGuests: Number(stat.additional_guests || 0),
    markedGoing: Number(stat.rsvp_submissions || 0) + Number(stat.additional_guests || 0),
    returning: Number(stat.returning_count || 0),
    newFaces: Number(stat.new_faces || 0),
    comments: Number(stat.comments || 0)
  };

  const event = { ...row };
  for (const key of Object.keys(event)) if (key.startsWith('post_')) delete event[key];
  const host = {
    id: row.post_host_id,
    user_id: row.post_host_user_id,
    email: row.post_host_email,
    name: row.post_host_name,
    org_name: row.post_host_org_name,
    public_slug: row.post_host_public_slug,
    logo_url: row.post_host_logo_url
  };
  return {
    event,
    host,
    ended: Boolean(row.post_ended),
    eventEndsAt: row.post_event_ends_at,
    stats
  };
}

async function eligibleThankYouAudience(db, { eventId, organizerId, rsvpId = null }) {
  const { rows } = await db.query(
    `WITH candidates AS (
       SELECT r.id AS rsvp_id,r.user_id,r.first_name,r.last_name,
              LOWER(BTRIM(r.email)) AS email,r.created_at,
              COALESCE('user:' || r.user_id::text,
                       'email:' || LOWER(BTRIM(r.email))) AS person_key,
              (
                EXISTS (
                  SELECT 1 FROM user_identities identity
                   WHERE identity.user_id=r.user_id
                     AND identity.identity_type='email'
                     AND identity.normalized_value=LOWER(BTRIM(r.email))
                     AND identity.verification_scope='account'
                     AND identity.verified_at IS NOT NULL
                     AND identity.revoked_at IS NULL
                )
                OR EXISTS (
                  SELECT 1
                    FROM guest_sessions session
                    JOIN organizers guest_identity ON guest_identity.id=session.identity_id
                   WHERE session.id=r.guest_session_id
                     AND session.verified_at IS NOT NULL
                     AND session.revoked_at IS NULL
                     AND (session.verified_event_id IS NULL OR session.verified_event_id=r.event_id)
                     AND LOWER(BTRIM(guest_identity.email))=LOWER(BTRIM(r.email))
                )
              ) AS email_verified,
              EXISTS (
                SELECT 1 FROM host_follows follow
                 WHERE follow.host_organizer_id=$2
                   AND follow.follower_user_id=r.user_id
                   AND follow.unsubscribed_at IS NULL
                   AND follow.email_opted_in_at IS NOT NULL
              ) AS follow_email_consent,
              EXISTS (
                SELECT 1 FROM host_follows follow
                 WHERE follow.host_organizer_id=$2
                   AND follow.follower_user_id=r.user_id
                   AND follow.unsubscribed_at IS NULL
              ) AS already_following,
              r.organizer_optin,r.wants_reminders,
              (r.event_email_optin AND r.event_email_consent_version=$4
                AND r.event_email_consent_at IS NOT NULL) AS event_email_consent
         FROM rsvps r
        WHERE r.event_id=$1 AND r.status='confirmed'
          AND NULLIF(BTRIM(r.email),'') IS NOT NULL
     ), ranked AS (
       SELECT candidate.*,
              ROW_NUMBER() OVER (
                PARTITION BY candidate.person_key
                ORDER BY candidate.created_at DESC,candidate.rsvp_id DESC
              ) AS person_rank
         FROM candidates candidate
     )
     SELECT ranked.*
       FROM ranked
      WHERE ranked.person_rank=1
        AND ranked.wants_reminders=TRUE
        AND ($3::int IS NULL OR ranked.rsvp_id=$3)
        AND ranked.email_verified
        AND (ranked.organizer_optin OR ranked.follow_email_consent OR ranked.event_email_consent)
        AND NOT EXISTS (
          SELECT 1 FROM follower_optouts optout
           WHERE optout.organizer_id=$2 AND LOWER(BTRIM(optout.email))=ranked.email
        )
      ORDER BY ranked.rsvp_id`,
    [eventId, organizerId, rsvpId, EVENT_EMAIL_CONSENT_VERSION]
  );
  const { rows: countRows } = await db.query(
    `SELECT COUNT(*)::int AS total
       FROM rsvps
      WHERE event_id=$1 AND status='confirmed'
        AND ($2::int IS NULL OR id=$2)`,
    [eventId, rsvpId]
  );
  const recipients = rows.map(row => ({
    rsvpId: Number(row.rsvp_id),
    userId: row.user_id == null ? null : Number(row.user_id),
    email: row.email,
    firstName: row.first_name || '',
    lastName: row.last_name || '',
    name: `${row.first_name || ''} ${row.last_name || ''}`.trim() || null,
    consentSource: row.follow_email_consent ? 'host_follow'
      : row.organizer_optin ? 'rsvp_host_email' : 'rsvp_event_email',
    consentScope: row.follow_email_consent || row.organizer_optin ? 'host' : 'event',
    alreadyFollowing: Boolean(row.already_following)
  }));
  const totalConfirmed = Number(countRows[0]?.total || 0);
  return {
    recipients,
    eligibleCount: recipients.length,
    skippedCount: Math.max(0, totalConfirmed - recipients.length),
    audienceHash: audienceDigest(recipients)
  };
}

async function loadTurnout(db, eventId) {
  const { rows } = await db.query(
    `SELECT estimated_turnout,updated_at
       FROM event_turnout_estimates WHERE event_id=$1`,
    [eventId]
  );
  if (!rows.length) return null;
  return {
    estimatedTurnout: Number(rows[0].estimated_turnout),
    updatedAt: rows[0].updated_at
  };
}

async function loadThankYouBatch(db, eventId, { lock = false } = {}) {
  const { rows } = await db.query(
    `SELECT * FROM post_event_thank_you_batches WHERE event_id=$1${lock ? ' FOR UPDATE' : ''}`,
    [eventId]
  );
  return rows[0] || null;
}

function serializeThankYou({ batch, draft, audience, host }) {
  const source = batch || {};
  const clean = batch ? {
    subject: batch.subject,
    message: batch.message,
    includeFollow: Boolean(batch.include_follow)
  } : normalizeDraft(draft);
  const finalStatus = source.status || 'draft';
  const approved = finalStatus !== 'draft';
  return {
    subject: clean.subject,
    message: clean.message,
    includeFollow: clean.includeFollow,
    eligibleCount: approved ? Number(source.recipient_count || 0) : Number(audience?.eligibleCount || 0),
    canIncludeFollow: Boolean(host?.public_slug && audience?.recipients?.some(recipient =>
      recipient.consentScope === 'host' && !recipient.alreadyFollowing)),
    status: finalStatus,
    batchId: source.id == null ? null : Number(source.id),
    sentCount: Number(source.sent_count || 0),
    failedCount: Number(source.failed_count || 0),
    skippedCount: Number(source.skipped_count ?? audience?.skippedCount ?? 0),
    recipientCount: Number(source.recipient_count || 0),
    completedAt: source.completed_at || null
  };
}

function requireEndedPublished(context) {
  if (!context) throw new PostEventError(404, 'event_not_found', 'Event not found');
  if (context.event.status !== 'published') {
    throw new PostEventError(409, 'event_not_published', 'Post-event tools are available for published events');
  }
  if (!context.ended) {
    throw new PostEventError(409, 'event_not_ended', 'Post-event tools are available after the event ends');
  }
  return context;
}

module.exports = {
  MESSAGE_MAX,
  PREVIEW_TTL_SECONDS,
  SUBJECT_MAX,
  PostEventError,
  audienceDigest,
  defaultThankYouDraft,
  draftDigest,
  emailRenderSnapshot,
  eligibleThankYouAudience,
  eventEndAtSql,
  loadPostEventContext,
  loadThankYouBatch,
  loadTurnout,
  normalizeDraft,
  renderSnapshotDigest,
  requireEndedPublished,
  serializeThankYou,
  signPreviewToken,
  verifyPreviewToken
};
