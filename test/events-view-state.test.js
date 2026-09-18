const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeView,
  resolveInitialView,
  localDateKey,
  eventDateKey,
  isUpcomingEventDate
} = require('../public/js/events-view-state');

test('My Events gives a valid URL view precedence over the remembered tab', () => {
  assert.equal(resolveInitialView('going', 'hosting'), 'going');
  assert.equal(resolveInitialView('hosting', 'going'), 'hosting');
  assert.equal(resolveInitialView(null, 'hosting'), 'hosting');
  assert.equal(resolveInitialView('invalid', 'going'), 'going');
  assert.equal(resolveInitialView('invalid', 'invalid'), 'going');
  assert.equal(normalizeView('going'), 'going');
  assert.equal(normalizeView('hosting'), 'hosting');
  assert.equal(normalizeView('invalid'), null);
});

test('event date comparison keeps today upcoming without parsing date-only values as UTC', () => {
  assert.equal(eventDateKey('2026-09-18'), '2026-09-18');
  assert.equal(eventDateKey('2026-09-18T00:00:00.000Z'), '2026-09-18');
  assert.equal(eventDateKey('not-a-date'), '');
  assert.equal(isUpcomingEventDate('2026-09-18', '2026-09-18'), true);
  assert.equal(isUpcomingEventDate('2026-09-19', '2026-09-18'), true);
  assert.equal(isUpcomingEventDate('2026-09-17', '2026-09-18'), false);
  assert.equal(isUpcomingEventDate('', '2026-09-18'), false);
});

test('local date keys use local calendar fields and remain zero padded', () => {
  const date = new Date(2026, 8, 7, 23, 30);
  assert.equal(localDateKey(date), '2026-09-07');
});
