const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('admin workspace uses consistent responsive loading and recovery states', () => {
  const css = read('public/css/main.css');
  const line = read('src/views/admin-line.html');
  const hosts = read('src/views/admin-hosts.html');
  const feedback = read('src/views/admin-feedback.html');
  const invitations = read('src/views/admin-invitations.html');
  const ticketing = read('src/views/admin-ticketing.html');

  assert.match(css, /Data-loading states for the private admin workspace/);
  assert.match(css, /\.admin-skeleton-card/);
  assert.match(css, /\.admin-load-error/);
  assert.match(css, /@media \(max-width: 520px\)[\s\S]*\.admin-skeleton-card/);

  assert.equal((line.match(/admin-skeleton-card admin-skeleton-row/g) || []).length >= 4, true);
  assert.match(line, /id="list" aria-busy="true"/);
  assert.match(line, /data-status="pending"[^>]*disabled/);
  assert.match(line, /id="retry-line"/);

  assert.equal((hosts.match(/admin-skeleton-card admin-skeleton-row/g) || []).length >= 6, true);
  assert.match(hosts, /id="host-search"[^>]*disabled/);
  assert.match(hosts, /id="host-list" aria-busy="true"/);
  assert.match(hosts, /id="retry-hosts"/);

  assert.equal((feedback.match(/admin-skeleton-card admin-skeleton-row/g) || []).length >= 6, true);
  assert.match(feedback, /id="type-filter"[^>]*disabled/);
  assert.match(feedback, /id="status-filter"[^>]*disabled/);
  assert.match(feedback, /id="feedback-list" aria-busy="true"/);
  assert.match(feedback, /id="retry-feedback"/);

  assert.equal((invitations.match(/admin-skeleton-card admin-skeleton-row/g) || []).length >= 4, true);
  assert.match(invitations, /id="invite-count" aria-label="Loading invitation count"/);
  assert.match(invitations, /id="invite-list" aria-busy="true"/);
  assert.match(invitations, /id="retry-invitations"/);

  assert.equal((ticketing.match(/admin-skeleton-card admin-skeleton-row/g) || []).length >= 4, true);
  assert.match(ticketing, /id="interest-list" aria-busy="true"/);
  assert.match(ticketing, /id="send-launch"[^>]*disabled/);
  assert.match(ticketing, /id="retry-interest"/);
});
