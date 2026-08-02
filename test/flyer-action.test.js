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

test('pay-at-the-door and invalid ticket destinations keep RSVP primary', () => {
  assert.equal(flyerPrimaryAction({ admission_type: 'paid', ticket_price: 15 }).supportingText, '$15 at the door');
  assert.equal(flyerPrimaryAction({ admission_type: 'paid', ticket_price: 15, ticket_url: 'javascript:alert(1)' }).type, 'rsvp');
});
