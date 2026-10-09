-- Publishing remains a deliberate Super Admin action after the flyer recipient
-- approves the exact preview by phone. The invitation reference lets the
-- eventual email claim update the pilot's real claim metric without treating
-- preview approval as an account claim.
ALTER TABLE admin_flyer_requests
  ADD COLUMN IF NOT EXISTS claim_invitation_id BIGINT REFERENCES admin_account_invitations(id),
  ADD COLUMN IF NOT EXISTS claim_invitation_sent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS claim_invitation_status TEXT,
  ADD COLUMN IF NOT EXISTS claim_invitation_attempted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS claim_invitation_error TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname='admin_flyer_requests_claim_invitation_status_check'
  ) THEN
    ALTER TABLE admin_flyer_requests
      ADD CONSTRAINT admin_flyer_requests_claim_invitation_status_check
      CHECK (claim_invitation_status IS NULL OR claim_invitation_status IN (
        'sending','sent','not_needed','failed'
      ));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS admin_flyer_requests_claim_invitation_idx
  ON admin_flyer_requests (claim_invitation_id)
  WHERE claim_invitation_id IS NOT NULL;

COMMENT ON COLUMN admin_flyer_requests.claim_invitation_id IS
  'Target-bound Home Base invitation sent after this approved event was published.';
COMMENT ON COLUMN admin_flyer_requests.claimed_at IS
  'Set when the linked promoter already controls the account or claims the target-bound Home Base invitation.';
