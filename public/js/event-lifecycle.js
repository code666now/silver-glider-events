(function eventLifecycleModule(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.SgeEventLifecycle = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createEventLifecycle() {
  const VARIANTS = Object.freeze({
    NEW_EVENT: 'new-event',
    REMINDER_FUNDED: 'reminder-funded',
    REMINDER_NEEDS_CREDITS: 'reminder-needs-credits',
    FOLLOWER_OUTREACH: 'follower-outreach',
    TONIGHT: 'tonight',
    ENDED: 'ended'
  });

  function number(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function variantFor({ event = {}, smsPreview = null, followerPreview = null } = {}) {
    if (event.lifecycle_phase === 'ended' || event.is_past) return VARIANTS.ENDED;
    if (event.lifecycle_phase === 'tonight') return VARIANTS.TONIGHT;

    const reminderCount = number(smsPreview?.recipientCount ?? event.sms_eligible_count);
    if (event.sms_reminder_enabled && reminderCount > 0) {
      if (smsPreview?.needsFunds) return VARIANTS.REMINDER_NEEDS_CREDITS;
      return VARIANTS.REMINDER_FUNDED;
    }

    const rsvps = number(event.rsvp_count);
    const followers = number(followerPreview?.count);
    if (rsvps === 0 && followers === 0) return VARIANTS.NEW_EVENT;
    return VARIANTS.FOLLOWER_OUTREACH;
  }

  function reminderDateLabel(eventDate) {
    const raw = String(eventDate || '').slice(0, 10);
    const date = new Date(`${raw}T00:00:00Z`);
    if (Number.isNaN(date.getTime())) return 'the day before';
    date.setUTCDate(date.getUTCDate() - 1);
    return date.toLocaleDateString('en-US', {
      weekday: 'long',
      month: 'short',
      day: 'numeric',
      timeZone: 'UTC'
    });
  }

  function deliveryReceipt(event = {}) {
    const textDelivered = number(event.day_before_sms_delivered_count);
    const textAccepted = number(event.day_before_sms_accepted_count);
    const textFailed = number(event.day_before_sms_failed_count);
    const emailSent = number(event.day_before_email_sent_count);
    const emailFailed = number(event.day_before_email_failed_count);
    const textPending = Math.max(0, textAccepted - textDelivered - textFailed);
    return {
      textDelivered,
      textAccepted,
      textFailed,
      textPending,
      emailSent,
      emailFailed,
      hasRecordedSend: textAccepted > 0 || textDelivered > 0 || textFailed > 0 || emailSent > 0 || emailFailed > 0
    };
  }

  return { VARIANTS, variantFor, reminderDateLabel, deliveryReceipt };
});
