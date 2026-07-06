function csvEscape(val) {
  const s = val == null ? '' : String(val);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function rsvpsToCsv(rows) {
  const header = ['first_name', 'last_name', 'email', 'phone', 'reminders', 'organizer_optin', 'status', 'rsvpd_at'];
  const lines = rows.map(r => [
    r.first_name, r.last_name, r.email, r.phone || '',
    r.wants_reminders ? 'yes' : 'no',
    r.organizer_optin ? 'yes' : 'no',
    r.status,
    new Date(r.created_at).toISOString()
  ].map(csvEscape).join(','));
  return [header.join(','), ...lines].join('\n') + '\n';
}

module.exports = { rsvpsToCsv };
