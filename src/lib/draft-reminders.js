const DRAFT_REMINDER_SCOPE = 'host_drafts';
const DRAFT_REMINDER_MAX_ATTEMPTS = 3;

function draftRemindersEnabled(env = process.env) {
  return !['false', '0', 'off'].includes(String(env.DRAFT_REMINDERS_ENABLED || '').trim().toLowerCase());
}

function sqlAlias(alias) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) throw new Error('Invalid SQL alias');
  return alias;
}

function eligibleDraftSql(alias = 'draft') {
  const name = sqlAlias(alias);
  return `${name}.status='draft'
    AND ${name}.archived_at IS NULL AND ${name}.first_published_at IS NULL
    AND ${name}.draft_host_activity_at IS NOT NULL
    AND ${name}.draft_host_activity_at > NOW() - INTERVAL '7 days'
    AND (${name}.event_date + ${name}.start_time) AT TIME ZONE ${name}.timezone > NOW()
    AND NOT EXISTS (
      SELECT 1 FROM admin_flyer_requests request
       WHERE request.event_id=${name}.id AND request.status NOT IN ('published','rejected')
    )
    AND NOT EXISTS (
      SELECT 1 FROM admin_event_editor_workspaces workspace
       WHERE workspace.event_id=${name}.id AND workspace.status='active' AND workspace.expires_at > NOW()
    )`;
}

// Used in both candidate and locked send-time queries by all three host-nudge
// jobs. A fresh saved draft replaces setup/next-event mail rather than stacking.
function draftNudgeSuppressionSql(hostAlias = 'host', { firstEvent = false, env = process.env } = {}) {
  const host = sqlAlias(hostAlias);
  const recentDraft = draftRemindersEnabled(env) ? `AND NOT EXISTS (
    SELECT 1 FROM events active_draft
     WHERE active_draft.organizer_id=${host}.id AND ${eligibleDraftSql('active_draft')}
  )` : '';
  return `${firstEvent ? `AND ${host}.first_draft_reminder_attempt_at IS NULL` : ''}
    AND (${host}.last_draft_reminder_attempt_at IS NULL
      OR ${host}.last_draft_reminder_attempt_at <= NOW() - INTERVAL '7 days')
    ${recentDraft}`;
}

// Caller must invoke this in the same transaction as a successful meaningful
// CUSTOMER create/edit/duplicate. Never call for GETs, admin edits, or no-ops.
async function recordDraftHostActivity(db, eventId, organizerId) {
  if (!Number.isSafeInteger(Number(eventId)) || Number(eventId) <= 0
      || !Number.isSafeInteger(Number(organizerId)) || Number(organizerId) <= 0) return false;
  const { rows } = await db.query(
    `UPDATE events SET draft_host_activity_at=clock_timestamp()
      WHERE id=$1 AND organizer_id=$2 AND status='draft'
        AND archived_at IS NULL AND first_published_at IS NULL
      RETURNING id`,
    [eventId, organizerId]
  );
  if (!rows.length) return false;
  await db.query(
    `UPDATE event_draft_reminders SET status='suppressed',error='host_resumed',updated_at=NOW()
      WHERE event_id=$1 AND organizer_id=$2 AND status IN ('pending','failed')`,
    [eventId, organizerId]
  );
  return true;
}

module.exports = {
  DRAFT_REMINDER_SCOPE, DRAFT_REMINDER_MAX_ATTEMPTS, draftRemindersEnabled,
  eligibleDraftSql, draftNudgeSuppressionSql, recordDraftHostActivity
};
