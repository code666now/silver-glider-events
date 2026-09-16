-- Familiar Faces invitation links are durable, event-scoped bearer links.
-- Keep revocation as the safety control, but remove time-based expiration so
-- the same personal URL works on any device whenever the recipient opens it.
ALTER TABLE guest_invitation_tokens
  ALTER COLUMN expires_at DROP NOT NULL;

UPDATE guest_invitation_tokens
   SET expires_at = NULL
 WHERE expires_at IS NOT NULL;
