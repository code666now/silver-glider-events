const { eventEndAtSql } = require('./post-event');

// Shared minimum for confirmed primary guests. Being selectable is not
// marketing consent; the invitation flow still applies target-specific checks.
function confirmedPrimaryGuestInviteSql(alias, hostParam) {
  if (!/^[a-z_]+$/i.test(alias) || !/^\$[1-9]\d*$/.test(hostParam)) throw new Error('Invalid invitation query arguments');
  return `${alias}.status='confirmed'
    AND NULLIF(BTRIM(${alias}.email),'') IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM follower_optouts fo
       WHERE fo.organizer_id=${hostParam} AND LOWER(BTRIM(fo.email))=LOWER(BTRIM(${alias}.email))
    )`;
}

function upcomingFamiliarInviteTargetSql(alias) {
  if (!/^[a-z_]+$/i.test(alias)) throw new Error('Invalid invitation query alias');
  return `${alias}.status='published' AND ${alias}.archived_at IS NULL
    AND ${alias}.secret_show_enabled=FALSE
    AND ${alias}.event_date >= (CURRENT_TIMESTAMP AT TIME ZONE ${alias}.timezone)::date`;
}

function familiarInviteSourcePastSql(alias) {
  const end = eventEndAtSql(alias);
  // Keep the existing local-date behavior and also allow an already ended
  // morning event whose recap can arrive on that same calendar date.
  return `(${alias}.event_date < (CURRENT_TIMESTAMP AT TIME ZONE ${alias}.timezone)::date OR NOW() >= ${end})`;
}

module.exports = { confirmedPrimaryGuestInviteSql, familiarInviteSourcePastSql, upcomingFamiliarInviteTargetSql };
