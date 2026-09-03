const test = require('node:test');
const assert = require('node:assert/strict');
const { flyerPrimaryAction } = require('../src/lib/flyer-action');

test('free Flyer events use RSVP as the single primary action', () => {
  assert.deepEqual(flyerPrimaryAction({ admission_type: 'free_rsvp' }), {
    type: 'rsvp',
    label: 'RSVP',
    url: null,
    supportingText: 'Free with RSVP',
    secondaryRsvp: false
  });
});

test('paid Flyer events with a valid destination prioritize tickets and demote RSVP', () => {
  assert.deepEqual(flyerPrimaryAction({ admission_type: 'paid', ticket_price: '36', ticket_url: 'https://tickets.example/show' }), {
    type: 'ticket',
    label: 'Get Tickets · $36',
    url: 'https://tickets.example/show',
    supportingText: '',
    secondaryRsvp: true
  });
});

test('canonical external ticket events preserve the legacy paid-event action', () => {
  const action = flyerPrimaryAction({
    admission_type: 'external_tickets',
    ticket_price: '24',
    ticket_url: 'https://tickets.example/canonical'
  });
  assert.equal(action.type, 'ticket');
  assert.equal(action.label, 'Get Tickets · $24');
  assert.equal(action.secondaryRsvp, true);
});

test('Silver Glider ticket events use the stable Events-owned handoff without RSVP', () => {
  assert.deepEqual(flyerPrimaryAction({
    admission_type: 'silver_glider_tickets',
    slug: 'commerce-night'
  }), {
    type: 'commerce_ticket',
    label: 'Get Tickets',
    url: '/e/commerce-night/tickets',
    supportingText: 'Tickets by Silver Glider',
    secondaryRsvp: false
  });
});

test('pay-at-the-door and invalid ticket destinations keep RSVP primary', () => {
  assert.equal(flyerPrimaryAction({ admission_type: 'paid', ticket_price: 15 }).supportingText, '$15 at the door');
  assert.equal(flyerPrimaryAction({ admission_type: 'paid', ticket_price: 15, ticket_url: 'javascript:alert(1)' }).type, 'rsvp');
});
