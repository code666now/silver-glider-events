// A cell that starts with = + - @ (or a tab/return) is run as a formula by
// Excel and Sheets. Guest names are typed by the public, so prefix those with
// an apostrophe to keep them as plain text. A value that is only a number,
// like a +1 phone, can't do anything and stays as it is.
function csvEscape(val) {
  let s = val == null ? '' : String(val);
  if (/^[=+\-@\t\r]/.test(s) && !/^[+-]?[\d\s().-]+$/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// "2026-10-14 20:05" in the event's own time zone, a form spreadsheets read
// as a date.
function localTime(value, timeZone) {
  if (!value) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date(value));
  const part = type => parts.find(p => p.type === type)?.value || '';
  return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}`;
}

const yesNo = value => (value ? 'Yes' : 'No');
const fullName = (first, last) => `${first || ''} ${last || ''}`.trim();

// One row per person, matching the Familiar Faces grid: going, then invited,
// then can't make it. A +1 sits on the row of the person who brought them.
function familiarFacesToCsv({ going, invited, declined, timeZone }) {
  const header = [
    'Name', 'Email', 'Phone', 'Status', 'Plus one', 'Times with you',
    'Reminders', 'Texts OK', 'Updates from you', `Date (${timeZone})`
  ];
  const rows = [
    ...going.map(r => [
      fullName(r.first_name, r.last_name), r.email, r.phone, 'Going',
      fullName(r.guest_first_name, r.guest_last_name), Number(r.visit_count) || 1,
      yesNo(r.wants_reminders), yesNo(r.texts_ok), yesNo(r.organizer_optin),
      localTime(r.created_at, timeZone)
    ]),
    ...invited.map(i => [
      String(i.recipient_name || '').trim(), String(i.recipient || '').trim(), '', 'Invited',
      '', '', '', '', '', localTime(i.created_at, timeZone)
    ]),
    ...declined.map(r => [
      fullName(r.first_name, r.last_name), r.email, r.phone, 'Can’t make it',
      '', '', '', '', yesNo(r.organizer_optin), localTime(r.created_at, timeZone)
    ])
  ];
  return [header, ...rows].map(row => row.map(csvEscape).join(',')).join('\n') + '\n';
}

module.exports = { familiarFacesToCsv, csvEscape };
