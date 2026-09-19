const crypto = require('crypto');
const { tokenHash } = require('./guest-session');
const { readCookie } = require('./private-events');
const { normalizeE164 } = require('./sms');
const { attachVerifiedPhoneIdentity } = require('./canonical-identity');

const REQUEST_COOKIE = 'sge_phone_auth';
const CODE_LENGTH = 6;
const MAX_AGE_SECONDS = 20 * 60;

class PhoneAuthError extends Error {
  constructor(message, { code = 'phone_auth_error', status = 400 } = {}) {
    super(message);
    this.name = 'PhoneAuthError';
    this.code = code;
    this.status = status;
  }
}

function maskPhone(value) {
  const phone = String(value || '');
  return phone.length >= 4 ? `•••• ${phone.slice(-4)}` : '';
}

function setPhoneAuthCookie(res, requestToken, maxAgeSeconds = MAX_AGE_SECONDS) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.append('Set-Cookie', `${REQUEST_COOKIE}=${encodeURIComponent(requestToken)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`);
}

function clearPhoneAuthCookie(res) {
  res.append('Set-Cookie', `${REQUEST_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function readPhoneAuthRequest(req) {
  return readCookie(req, REQUEST_COOKIE);
}

async function createPhoneChallenge(db, {
  phone,
  purpose,
  organizerId = null,
  providerSid = null,
  returnPath = null,
  ttlMinutes = 20
}) {
  if (!['enroll', 'sign_in'].includes(purpose)) {
    throw new PhoneAuthError('Unsupported phone authentication purpose');
  }
  const phoneE164 = normalizeE164(phone);
  const requestToken = crypto.randomBytes(32).toString('base64url');
  const requestHash = tokenHash(requestToken);
  const { rows } = await db.query(
    `INSERT INTO phone_auth_challenges
       (phone_e164,organizer_id,purpose,request_hash,provider_sid,return_path,expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,NOW() + make_interval(mins => $7))
     RETURNING id,phone_e164,organizer_id,purpose,provider_sid,return_path,expires_at`,
    [phoneE164, organizerId, purpose, requestHash, providerSid, returnPath || null, ttlMinutes]
  );
  return { ...rows[0], requestToken };
}

async function readPhoneChallenge(db, req, { forUpdate = false, includeExpired = false } = {}) {
  const requestToken = readPhoneAuthRequest(req);
  if (!requestToken || requestToken.length > 180) return null;
  const { rows } = await db.query(
    `SELECT id,phone_e164,organizer_id,purpose,provider_sid,return_path,
            verified_at,used_at,expires_at
       FROM phone_auth_challenges
      WHERE request_hash=$1 AND used_at IS NULL
        ${includeExpired ? '' : 'AND expires_at > NOW()'}
      ORDER BY id DESC LIMIT 1
      ${forUpdate ? 'FOR UPDATE' : ''}`,
    [tokenHash(requestToken)]
  );
  return rows[0] || null;
}

async function markPhoneChallengeVerified(client, challengeId) {
  const { rows } = await client.query(
    `UPDATE phone_auth_challenges
        SET verified_at=COALESCE(verified_at,NOW()),
            expires_at=GREATEST(expires_at,NOW() + INTERVAL '20 minutes')
      WHERE id=$1 AND purpose='enroll' AND used_at IS NULL AND expires_at > NOW()
      RETURNING id,phone_e164,organizer_id,purpose,return_path,verified_at,expires_at`,
    [challengeId]
  );
  return rows[0] || null;
}

async function cancelPhoneChallenge(db, req) {
  const requestToken = readPhoneAuthRequest(req);
  if (!requestToken || requestToken.length > 180) return 0;
  const { rowCount } = await db.query(
    `UPDATE phone_auth_challenges SET used_at=COALESCE(used_at,NOW())
      WHERE request_hash=$1 AND used_at IS NULL`,
    [tokenHash(requestToken)]
  );
  return rowCount;
}

async function bindVerifiedPhone(client, { challengeId, organizerId }) {
  const { rows: challengeRows } = await client.query(
    `SELECT id,phone_e164,verified_at,used_at,expires_at
       FROM phone_auth_challenges
      WHERE id=$1 AND purpose='enroll'
      FOR UPDATE`,
    [challengeId]
  );
  const challenge = challengeRows[0];
  if (!challenge || !challenge.verified_at || challenge.used_at || new Date(challenge.expires_at) <= new Date()) {
    throw new PhoneAuthError('Phone verification expired. Start again.', {
      code: 'phone_verification_expired', status: 400
    });
  }

  const { rows: phoneRows } = await client.query(
    `SELECT id,organizer_id FROM account_phone_credentials
      WHERE phone_e164=$1 AND revoked_at IS NULL FOR UPDATE`,
    [challenge.phone_e164]
  );
  if (phoneRows.length && Number(phoneRows[0].organizer_id) !== Number(organizerId)) {
    throw new PhoneAuthError('That phone number belongs to another Silver Glider account.', {
      code: 'phone_identity_conflict', status: 409
    });
  }

  const { rows: organizerRows } = await client.query(
    `SELECT id,phone_e164 FROM account_phone_credentials
      WHERE organizer_id=$1 AND revoked_at IS NULL FOR UPDATE`,
    [organizerId]
  );
  if (organizerRows.length && organizerRows[0].phone_e164 !== challenge.phone_e164) {
    throw new PhoneAuthError('This account already has a different verified phone number.', {
      code: 'account_phone_conflict', status: 409
    });
  }

  if (!phoneRows.length && !organizerRows.length) {
    try {
      await client.query(
        `INSERT INTO account_phone_credentials (organizer_id,phone_e164,verified_at,last_used_at)
         VALUES ($1,$2,NOW(),NOW())`,
        [organizerId, challenge.phone_e164]
      );
    } catch (error) {
      if (error?.code === '23505') {
        throw new PhoneAuthError('That phone number or account is already connected.', {
          code: 'phone_identity_conflict', status: 409
        });
      }
      throw error;
    }
  } else {
    await client.query(
      `UPDATE account_phone_credentials SET last_used_at=NOW(),updated_at=NOW()
        WHERE organizer_id=$1 AND phone_e164=$2 AND revoked_at IS NULL`,
      [organizerId, challenge.phone_e164]
    );
  }
  await attachVerifiedPhoneIdentity(client, {
    userId: organizerId,
    phone: challenge.phone_e164,
    verifiedAt: challenge.verified_at,
    verificationSource: 'twilio_verify'
  });
  await client.query('UPDATE phone_auth_challenges SET used_at=NOW() WHERE id=$1', [challenge.id]);
  return challenge.phone_e164;
}

async function invalidateOrganizerPhoneChallenges(db, organizerId) {
  const { rowCount } = await db.query(
    `UPDATE phone_auth_challenges SET used_at=COALESCE(used_at,NOW())
      WHERE used_at IS NULL AND (
        organizer_id=$1 OR phone_e164 IN (
          SELECT phone_e164 FROM account_phone_credentials WHERE organizer_id=$1 AND revoked_at IS NULL
        )
      )`,
    [organizerId]
  );
  return rowCount;
}

module.exports = {
  CODE_LENGTH,
  MAX_AGE_SECONDS,
  REQUEST_COOKIE,
  PhoneAuthError,
  bindVerifiedPhone,
  cancelPhoneChallenge,
  clearPhoneAuthCookie,
  createPhoneChallenge,
  invalidateOrganizerPhoneChallenges,
  markPhoneChallengeVerified,
  maskPhone,
  readPhoneAuthRequest,
  readPhoneChallenge,
  setPhoneAuthCookie
};
