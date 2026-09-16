const {
  FOLLOW_EMAIL_CONSENT_SOURCE,
  FOLLOW_EMAIL_CONSENT_VERSION,
  FOLLOW_SMS_CONSENT_VERSION,
  followEmailConsentCopy,
  prepareFollowSmsConsent
} = require('./follow-consent');

async function findPublicHost(db, slug) {
  const value = String(slug || '').trim();
  if (!value) return null;
  const { rows } = await db.query(
    `SELECT id, org_name, public_slug, logo_url, header_image_url, sms_credits
       FROM organizers
      WHERE LOWER(public_slug)=LOWER($1)
        AND org_name IS NOT NULL
        AND public_slug IS NOT NULL`,
    [value]
  );
  return rows[0] || null;
}

async function followHost(db, followerOrganizerId, hostOrganizerId, sourceEventId = null) {
  if (Number(followerOrganizerId) === Number(hostOrganizerId)) {
    const err = new Error('You cannot follow your own Host Page');
    err.statusCode = 400;
    throw err;
  }
  const { rows: identityRows } = await db.query(
    `SELECT follower.email, COALESCE(host.org_name,host.name,'this host') AS host_name
       FROM organizers follower CROSS JOIN organizers host
      WHERE follower.id=$1 AND host.id=$2`,
    [followerOrganizerId, hostOrganizerId]
  );
  if (!identityRows.length) throw new Error('Follow identity is no longer available');
  const consentText = followEmailConsentCopy(identityRows[0].host_name);
  const { rows } = await db.query(
    `INSERT INTO host_follows
       (follower_organizer_id, host_organizer_id, source_event_id,
        email_opted_in_at,email_consent_source,email_consent_version,email_consent_text)
     VALUES ($1,$2,$3,NOW(),$4,$5,$6)
     ON CONFLICT (follower_organizer_id, host_organizer_id)
     DO UPDATE SET unsubscribed_at=NULL,
                   source_event_id=COALESCE(host_follows.source_event_id, EXCLUDED.source_event_id),
                   email_opted_in_at=NOW(),
                   email_consent_source=EXCLUDED.email_consent_source,
                   email_consent_version=EXCLUDED.email_consent_version,
                   email_consent_text=EXCLUDED.email_consent_text,
                   updated_at=NOW()
     RETURNING id, created_at, unsubscribed_at`,
    [followerOrganizerId, hostOrganizerId, sourceEventId,
     FOLLOW_EMAIL_CONSENT_SOURCE, FOLLOW_EMAIL_CONSENT_VERSION, consentText]
  );
  await db.query(
    `DELETE FROM follower_optouts
      WHERE organizer_id=$1 AND LOWER(email)=LOWER($2)`,
    [hostOrganizerId, identityRows[0].email]
  );
  return rows[0];
}

async function enableFollowSms(db, followerOrganizerId, hostOrganizerId, phone) {
  const host = (await db.query(
    `SELECT COALESCE(org_name,name,'this host') AS host_name,sms_credits
       FROM organizers WHERE id=$1`, [hostOrganizerId]
  )).rows[0];
  if (!host || Number(host.sms_credits || 0) < 1) {
    const error = new Error('Text updates are not available for this host right now');
    error.statusCode = 409;
    throw error;
  }
  const consent = prepareFollowSmsConsent({ phone, hostName: host.host_name });
  const { rows } = await db.query(
    `UPDATE host_follows
        SET sms_phone=$3,sms_opted_in_at=$4,sms_opted_out_at=NULL,
            sms_consent_source=$5,sms_consent_version=$6,sms_consent_text=$7,
            updated_at=NOW()
      WHERE follower_organizer_id=$1 AND host_organizer_id=$2
        AND unsubscribed_at IS NULL AND email_opted_in_at IS NOT NULL
      RETURNING id`,
    [followerOrganizerId, hostOrganizerId, consent.phone, consent.consentedAt,
     consent.source, consent.version, consent.text]
  );
  if (!rows.length) {
    const error = new Error('Follow this host before adding text updates');
    error.statusCode = 409;
    throw error;
  }
  return rows[0];
}

async function unfollowHost(db, followerOrganizerId, hostOrganizerId) {
  const { rowCount } = await db.query(
    `UPDATE host_follows
        SET unsubscribed_at=COALESCE(unsubscribed_at,NOW()),
            sms_opted_out_at=CASE WHEN sms_opted_in_at IS NOT NULL THEN COALESCE(sms_opted_out_at,NOW()) ELSE sms_opted_out_at END,
            updated_at=NOW()
      WHERE follower_organizer_id=$1 AND host_organizer_id=$2`,
    [followerOrganizerId, hostOrganizerId]
  );
  // Unfollow is the host-level opt-out. Record it in the shared suppression
  // list as well so an older RSVP marketing opt-in cannot keep sending after
  // the person has explicitly unfollowed here.
  await db.query(
    `INSERT INTO follower_optouts (organizer_id,email)
     SELECT $2,email FROM organizers WHERE id=$1 AND email IS NOT NULL
     ON CONFLICT DO NOTHING`,
    [followerOrganizerId, hostOrganizerId]
  );
  return rowCount > 0;
}

async function isFollowingHost(db, followerOrganizerId, hostOrganizerId) {
  if (!followerOrganizerId || Number(followerOrganizerId) === Number(hostOrganizerId)) return false;
  const { rows } = await db.query(
    `SELECT 1 FROM host_follows
      WHERE follower_organizer_id=$1 AND host_organizer_id=$2
        AND unsubscribed_at IS NULL`,
    [followerOrganizerId, hostOrganizerId]
  );
  return rows.length > 0;
}

async function followStatus(db, followerOrganizerId, hostOrganizerId) {
  const { rows } = await db.query(
    `SELECT hf.id,hf.unsubscribed_at,hf.email_opted_in_at,hf.email_consent_version,
            hf.sms_phone,hf.sms_opted_in_at,hf.sms_opted_out_at,hf.sms_consent_version,
            COALESCE(host.sms_credits,0)::int AS sms_credits,
            EXISTS (
              SELECT 1 FROM follower_optouts fo
               WHERE fo.organizer_id=hf.host_organizer_id
                 AND LOWER(fo.email)=LOWER(follower.email)
            ) AS email_opted_out
       FROM organizers host
       LEFT JOIN host_follows hf
         ON hf.host_organizer_id=host.id AND hf.follower_organizer_id=$1
       LEFT JOIN organizers follower ON follower.id=$1
      WHERE host.id=$2`,
    [followerOrganizerId, hostOrganizerId]
  );
  const row = rows[0] || {};
  const following = Boolean(row.id && !row.unsubscribed_at);
  return {
    following,
    emailOn: Boolean(following && row.email_opted_in_at
      && row.email_consent_version === FOLLOW_EMAIL_CONSENT_VERSION && !row.email_opted_out),
    textOn: Boolean(following && row.sms_phone && row.sms_opted_in_at
      && row.sms_consent_version === FOLLOW_SMS_CONSENT_VERSION && !row.sms_opted_out_at),
    smsAvailable: Number(row.sms_credits || 0) > 0,
    phoneLast4: row.sms_phone ? String(row.sms_phone).slice(-4) : null
  };
}

module.exports = {
  findPublicHost, followHost, unfollowHost, isFollowingHost, followStatus, enableFollowSms
};
