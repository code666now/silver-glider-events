-- One host-approved thank-you may use a confirmed primary RSVP's email without
-- granting marketing consent or treating that email as verified. Older approved
-- deliveries retain their original host/event scope and eligibility rules.
ALTER TABLE message_log
  DROP CONSTRAINT message_log_post_event_consent_scope_check;

ALTER TABLE message_log
  ADD CONSTRAINT message_log_post_event_consent_scope_check
    CHECK (post_event_consent_scope IN ('host','event','event_rsvp'));

COMMENT ON COLUMN message_log.post_event_consent_scope IS
  'Frozen thank-you render/audience scope: event_rsvp is a one-event RSVP note, not marketing consent or mailbox proof; NULL retains legacy host scope.';
