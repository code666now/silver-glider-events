const { isExternalTickets } = require('./admission');

function parseTicketUrl(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    return url;
  } catch (_) {
    return null;
  }
}

function validTicketUrl(value) {
  return parseTicketUrl(value)?.href || null;
}

function ticketSeller(url) {
  // Seller identification is deliberate: never trust query parameters, the
  // start of a hostname, a redirect target, a lookalike, or a custom port.
  if (!url || url.port) return null;
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  if (['dice.fm', 'www.dice.fm', 'link.dice.fm'].includes(hostname)) return 'DICE';
  // Eventbrite also officially issues <organizer-chosen-name>.eventbrite.com.
  if (hostname === 'eventbrite.com' || /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.eventbrite\.com$/.test(hostname)) {
    return 'Eventbrite';
  }
  return null;
}

function externalTicketLink(event) {
  if (!isExternalTickets(event)) return null;
  const url = parseTicketUrl(event.ticket_url);
  if (!url) return null;
  const seller = ticketSeller(url);
  return { url: url.href, sellerLabel: seller ? `Tickets sold on ${seller}` : 'Tickets sold on an external site' };
}

module.exports = { externalTicketLink, validTicketUrl };
