-- Authentication uses Twilio Verify for both enrollment and returning sign-in.
-- Invalidate any outstanding application-generated sign-in codes from an
-- earlier local/staging build before tightening the method constraint.
UPDATE phone_auth_challenges
   SET used_at=COALESCE(used_at,NOW())
 WHERE purpose='sign_in' AND provider_sid IS NULL AND used_at IS NULL;

ALTER TABLE phone_auth_challenges
  DROP CONSTRAINT IF EXISTS phone_auth_challenges_method_check;

ALTER TABLE phone_auth_challenges
  ADD CONSTRAINT phone_auth_challenges_method_check CHECK (
    (purpose = 'enroll' AND provider_sid IS NOT NULL AND code_hash IS NULL AND organizer_id IS NULL)
    OR
    (purpose = 'sign_in' AND provider_sid IS NOT NULL AND code_hash IS NULL AND organizer_id IS NOT NULL)
    OR
    (purpose = 'sign_in' AND provider_sid IS NULL AND code_hash IS NOT NULL
      AND organizer_id IS NOT NULL AND used_at IS NOT NULL)
  );
