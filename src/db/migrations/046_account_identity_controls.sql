-- Signed-in account controls can attach a newly verified email to the
-- canonical user without turning that email into a second organizer. The
-- browser-bound code still lives in magic_link_tokens; requested_user_id
-- records the already-authenticated account that initiated the proof.
ALTER TABLE magic_link_tokens
  ADD COLUMN IF NOT EXISTS requested_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS magic_link_tokens_requested_user_idx
  ON magic_link_tokens (requested_user_id, created_at DESC)
  WHERE requested_user_id IS NOT NULL;

ALTER TABLE magic_link_tokens DROP CONSTRAINT IF EXISTS magic_link_tokens_intent_check;
ALTER TABLE magic_link_tokens ADD CONSTRAINT magic_link_tokens_intent_check
  CHECK (intent IN (
    'sign_in', 'follow_host', 'add_photo', 'verify_guest', 'bind_phone',
    'attach_email', 'identity_step_up'
  ));

ALTER TABLE magic_link_tokens
  DROP CONSTRAINT IF EXISTS magic_link_tokens_requested_user_check;
ALTER TABLE magic_link_tokens
  ADD CONSTRAINT magic_link_tokens_requested_user_check CHECK (
    (intent IN ('attach_email','identity_step_up')) = (requested_user_id IS NOT NULL)
  );

-- Adding or replacing a phone from Account settings proves the phone directly
-- with Twilio Verify. Unlike initial enrollment, an authenticated organizer is
-- already known, so no second email proof is necessary.
ALTER TABLE phone_auth_challenges
  DROP CONSTRAINT IF EXISTS phone_auth_challenges_purpose_check;
ALTER TABLE phone_auth_challenges
  ADD CONSTRAINT phone_auth_challenges_purpose_check
  CHECK (purpose IN ('enroll', 'sign_in', 'add_phone'));

ALTER TABLE phone_auth_challenges
  DROP CONSTRAINT IF EXISTS phone_auth_challenges_method_check;
ALTER TABLE phone_auth_challenges
  ADD CONSTRAINT phone_auth_challenges_method_check CHECK (
    (purpose = 'enroll' AND provider_sid IS NOT NULL AND code_hash IS NULL AND organizer_id IS NULL)
    OR
    (purpose = 'sign_in' AND provider_sid IS NOT NULL AND code_hash IS NULL AND organizer_id IS NOT NULL)
    OR
    (purpose = 'add_phone' AND provider_sid IS NOT NULL AND code_hash IS NULL AND organizer_id IS NOT NULL)
    OR
    (purpose = 'sign_in' AND provider_sid IS NULL AND code_hash IS NOT NULL
      AND organizer_id IS NOT NULL AND used_at IS NOT NULL)
  );
