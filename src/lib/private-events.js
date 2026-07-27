const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isTrue(value) {
  return value === true || value === 'true';
}

function splitName(value) {
  const full = String(value || '').trim().replace(/\s+/g, ' ').slice(0, 160);
  const parts = full.split(' ').filter(Boolean);
  return {
    firstName: String(parts.shift() || '').slice(0, 80),
    lastName: parts.join(' ').slice(0, 80)
  };
}

function normalizePrivateSettings(visibility, body = {}) {
  if (visibility !== 'private') {
    return { show_guest_list: false, allow_guests: false, comments_enabled: false };
  }
  return {
    show_guest_list: isTrue(body.show_guest_list),
    allow_guests: isTrue(body.allow_guests),
    comments_enabled: isTrue(body.comments_enabled)
  };
}

function parseNamedGuest(event, body = {}) {
  const bringingGuest = isTrue(body.bringing_guest);
  if (!event.allow_guests || !bringingGuest) {
    return {
      guestFirstName: null,
      guestLastName: null,
      guestEmail: null,
      partySize: 1,
      error: null
    };
  }

  const { firstName, lastName } = splitName(body.guest_name);
  if (!firstName) {
    return { partySize: 2, error: 'Enter your guest’s name' };
  }
  const guestEmail = String(body.guest_email || '').trim().toLowerCase().slice(0, 254) || null;
  if (guestEmail && !EMAIL_RE.test(guestEmail)) {
    return { partySize: 2, error: 'Enter a valid guest email' };
  }
  return {
    guestFirstName: firstName,
    guestLastName: lastName,
    guestEmail,
    partySize: 2,
    error: null
  };
}

function attendanceCounts(rows = []) {
  const confirmed = rows.filter(row => row.status == null || row.status === 'confirmed');
  const guestCount = confirmed.filter(row => Boolean(row.guest_first_name)).length;
  return {
    submissionCount: confirmed.length,
    guestCount,
    totalAttendance: confirmed.length + guestCount
  };
}

function publicGuestNames(rows = []) {
  const names = [];
  for (const row of rows) {
    const attendee = String(row.first_name || '').trim().slice(0, 80);
    const guest = String(row.guest_first_name || '').trim().slice(0, 80);
    if (attendee) names.push({ firstName: attendee, isGuest: false });
    if (guest) names.push({ firstName: guest, isGuest: true });
  }
  return names;
}

function canAppearInPublicListings(event) {
  return event?.visibility === 'public' && event?.status === 'published';
}

function robotsDirective(visibility) {
  return visibility === 'private' ? 'noindex, nofollow, noarchive' : 'index, follow';
}

function cleanComment(value) {
  const message = String(value || '').trim();
  if (!message) return { error: 'Write a comment first' };
  if (message.length > 300) return { error: 'Comments can be up to 300 characters' };
  return { message };
}

function attendeeCookieName(eventId) {
  return `sge_attendee_${Number(eventId)}`;
}

function readCookie(req, name) {
  const header = req.headers.cookie || '';
  const part = header.split(';').map(item => item.trim()).find(item => item.startsWith(`${name}=`));
  return part ? decodeURIComponent(part.slice(name.length + 1)) : '';
}

module.exports = {
  attendanceCounts,
  attendeeCookieName,
  canAppearInPublicListings,
  cleanComment,
  normalizePrivateSettings,
  parseNamedGuest,
  publicGuestNames,
  readCookie,
  robotsDirective,
  splitName
};
