const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

process.env.SESSION_SECRET ||= 'admin-editor-stage2-unit-secret';

const root = path.join(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const {
  EDITOR_EVENT_FIELDS,
  EventEditorError,
  toEditorEventDto,
  validateCreateEventInput
} = require('../src/lib/event-editor');

test('admin editor event DTO is an explicit allowlist with no bearer credentials', () => {
  assert.ok(Object.isFrozen(EDITOR_EVENT_FIELDS));
  assert.ok(EDITOR_EVENT_FIELDS.includes('title'));
  assert.ok(EDITOR_EVENT_FIELDS.includes('status'));
  for (const unsafe of [
    'photo_upload_token', 'photo_short_token', 'manage_token',
    'email', 'phone', 'contact_email'
  ]) {
    assert.equal(EDITOR_EVENT_FIELDS.includes(unsafe), false);
  }
  const dto = toEditorEventDto({
    id: 4,
    title: 'Safe event',
    status: 'draft',
    photo_upload_token: 'bearer-one',
    photo_short_token: 'bearer-two',
    future_secret: 'must-not-leak'
  });
  assert.deepEqual(dto, { id: 4, title: 'Safe event', status: 'draft' });
});

test('shared event validation remains reusable by customer and admin handlers', () => {
  const valid = validateCreateEventInput({
    title: 'Shared rules',
    event_date: '2033-01-02',
    start_time: '19:00',
    venue_name: 'Shared Hall',
    visibility: 'private',
    admission_type: 'free_rsvp',
    status: 'draft'
  });
  assert.equal(valid.out.status, 'draft');
  assert.throws(
    () => validateCreateEventInput({ title: '', event_date: '', start_time: '', venue_name: '' }),
    error => error instanceof EventEditorError && error.code === 'event_validation_failed'
  );
});

test('scoped admin routes reuse event rules without creating a customer identity', () => {
  const route = read('src/routes/admin-editor.js');
  const ownerRoute = read('src/routes/events.js');
  const service = read('src/lib/event-editor.js');
  assert.match(route, /requireAdmin, requireDedicatedAdmin, requireAdminEditorWorkspace/);
  assert.match(route, /createEventInTransaction/);
  assert.match(route, /getEventForEditor/);
  assert.match(route, /updateEventInTransaction/);
  assert.match(route, /publishEventInTransaction/);
  assert.match(ownerRoute, /createEventInTransaction/);
  assert.match(ownerRoute, /updateEventInTransaction/);
  assert.match(ownerRoute, /publishEventInTransaction/);
  assert.match(service, /const EDITOR_EVENT_FIELDS = Object\.freeze/);
  assert.doesNotMatch(route, /setSessionCookie|signSession|sge_session|req\.organizer\s*=/);
});

test('quick create forces a draft and binds the exact workspace in one transaction', () => {
  const route = read('src/routes/admin-editor.js');
  const createStart = route.indexOf("router.post('/api/events'");
  const createEnd = route.indexOf("router.get('/api/events/:id'", createStart);
  const create = route.slice(createStart, createEnd);
  assert.match(create, /requireUnboundWorkspace/);
  assert.match(create, /presenter_name/);
  assert.match(create, /status: 'draft'/);
  assert.match(create, /delete body\.presenter_name/);
  assert.match(create, /delete body\.notify_attendees/);
  const begin = create.indexOf("query('BEGIN')");
  const insert = create.indexOf('createEventInTransaction');
  const bind = create.indexOf('bindAdminEditorWorkspaceEventInTransaction');
  const commit = create.indexOf("query('COMMIT')");
  assert.ok(begin >= 0 && insert > begin && bind > insert && commit > bind);
  assert.match(create, /error\.code === '23505'/);
});

test('updates are exact-scope, notification-free, and audit only changed field names', () => {
  const route = read('src/routes/admin-editor.js');
  const updateStart = route.indexOf("router.put('/api/events/:id'");
  const updateEnd = route.indexOf("router.post('/api/events/:id/publish'", updateStart);
  const update = route.slice(updateStart, updateEnd);
  assert.match(update, /requireBoundWorkspace, requireExactEvent/);
  assert.match(update, /notify_attendees: false/);
  assert.match(update, /delete body\.status/);
  assert.match(update, /notification: null/);
  assert.match(update, /changedFields/);
  assert.match(update, /done_for_you_event_draft_updated/);
  assert.doesNotMatch(update, /beforeState:\s*result\.event|afterState:\s*result\.event/);
});

test('publish, workspace completion, audit, commit, and cookie clearing stay ordered', () => {
  const route = read('src/routes/admin-editor.js');
  const publishStart = route.indexOf("router.post('/api/events/:id/publish'");
  const publishEnd = route.indexOf("router.post('/api/workspace/exit'", publishStart);
  const publish = route.slice(publishStart, publishEnd);
  const begin = publish.indexOf("query('BEGIN')");
  const eventPublish = publish.indexOf('publishEventInTransaction');
  const audit = publish.indexOf("actionType: 'done_for_you_event_published'");
  const complete = publish.indexOf('completeAdminEditorWorkspaceInTransaction');
  const commit = publish.indexOf("query('COMMIT')");
  const clearCookie = publish.indexOf('clearAdminEditorCookie');
  assert.ok(begin >= 0 && eventPublish > begin && audit > eventPublish &&
    complete > audit && commit > complete && clearCookie > commit);
  assert.match(publish, /redirect: editorRedirect/);
  assert.match(publish, /ROLLBACK/);
});

test('auxiliary editor APIs are workspace scoped and expose no customer waitlist mutation', () => {
  const route = read('src/routes/admin-editor.js');
  for (const endpoint of [
    '/api/workspace', '/api/auth/me', '/api/places/config',
    '/api/photos/enabled', '/api/photos/search', '/api/photos/track',
    '/api/uploads/cover', '/api/uploads/flyer', '/api/uploads/vibe-photo',
    '/api/commerce/config'
  ]) {
    assert.ok(route.includes(endpoint), `missing scoped endpoint ${endpoint}`);
  }
  assert.doesNotMatch(route, /commerce\/interest/);
  assert.doesNotMatch(route, /preview/);
  assert.match(route, /exactBoundEventStillAvailable/);
});
