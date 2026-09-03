function formatTicketPrice(price) {
  if (price == null || price === '') return 'Paid admission';
  const value = Number(price);
  if (!Number.isFinite(value) || value <= 0) return 'Paid admission';
  return `$${value.toFixed(2).replace(/\.00$/, '')}`;
}

function validTicketUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : null;
  } catch (_) {
    return null;
  }
}

function flyerPrimaryAction(event = {}) {
  if (isSilverGliderTickets(event)) {
    return {
      type: 'commerce_ticket',
      label: 'Get Tickets',
      url: event.slug ? `/e/${encodeURIComponent(event.slug)}/tickets` : null,
      supportingText: 'Tickets by Silver Glider',
      secondaryRsvp: false
    };
  }

  const isPaid = isExternalTickets(event);
  const ticketUrl = isPaid ? validTicketUrl(event.ticket_url) : null;
  const price = formatTicketPrice(event.ticket_price);
  const hasPrice = price !== 'Paid admission';

  if (ticketUrl) {
    return {
      type: 'ticket',
      label: `Get Tickets${hasPrice ? ` · ${price}` : ''}`,
      url: ticketUrl,
      supportingText: '',
      secondaryRsvp: true
    };
  }

  if (isPaid) {
    return {
      type: 'rsvp',
      label: 'RSVP',
      url: null,
      supportingText: hasPrice ? `${price} at the door` : 'Pay at the door',
      secondaryRsvp: false
    };
  }

  return {
    type: 'rsvp',
    label: 'RSVP',
    url: null,
    supportingText: 'Free with RSVP',
    secondaryRsvp: false
  };
}

module.exports = { flyerPrimaryAction, formatTicketPrice, validTicketUrl };
const { isExternalTickets, isSilverGliderTickets } = require('./admission');
