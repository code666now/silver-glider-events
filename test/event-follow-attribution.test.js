const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SESSION_SECRET ||= 'event-follow-attribution-test-only';
const { setUnlockCookie } = require('../src/lib/secret-show');
const {
  signEventFollowSource, eventFollowSourceMatches, loadEventFollowerImpact
} = require('../src/lib/event-follow-attribution');

const event = Object.freeze({
  id: 22, organizer_id: 11, slug: 'dance-night', status: 'published', visibility: 'public',
  secret_show_enabled: false, secret_show_version: 0
});
const noCookies = { headers: {} };

test('event follower attribution proves the rendered event and owner without leaking IDs or bypassing publish state', () => {
  const marker = signEventFollowSource(event);
  assert.match(marker, /^[a-f0-9]{64}$/);
  assert.ok(eventFollowSourceMatches(noCookies, event, marker));
  for (const change of [{ id: 23 }, { organizer_id: 12 }, { slug: 'another-show' }, { visibility: 'private' }]) {
    assert.equal(eventFollowSourceMatches(noCookies, { ...event, ...change }, marker), false);
  }
  for (const status of ['draft', 'hidden', 'cancelled']) {
    assert.equal(signEventFollowSource({ ...event, status }), null);
    assert.equal(eventFollowSourceMatches(noCookies, { ...event, status }, marker), false);
  }
  for (const malformed of [null, undefined, [], '🚫', '0'.repeat(64), marker + '.']) {
    assert.equal(eventFollowSourceMatches(noCookies, event, malformed), false);
  }
});

test('event follower attribution always needs the current Secret Show unlock proof as well as the source marker', () => {
  const secret = { ...event, visibility: 'private', secret_show_enabled: true, secret_show_version: 4 };
  let cookie;
  setUnlockCookie({ append(_name, value) { cookie = value.split(';')[0]; } }, secret);
  const marker = signEventFollowSource(secret);
  assert.equal(eventFollowSourceMatches(noCookies, secret, marker), false);
  assert.ok(eventFollowSourceMatches({ headers: { cookie } }, secret, marker));
  const rotated = { ...secret, secret_show_version: 5 };
  assert.equal(eventFollowSourceMatches({ headers: { cookie } }, rotated, signEventFollowSource(rotated)), false);
  assert.equal(eventFollowSourceMatches({ headers: { cookie: 'sge_secret_22=%Q' } }, secret, marker), false);
});

test('event follower impact returns only aggregate counts and the prospective start date', async () => {
  const appliedAt = new Date('2026-11-20T01:00:00Z');
  const query = async (sql, args) => {
    assert.match(sql, /events e[\s\S]*e\.id=\$1 AND e\.organizer_id=\$2/);
    assert.match(sql, /DISTINCT COALESCE\(hf\.follower_user_id,hf\.follower_organizer_id\)/);
    assert.match(sql, /hf\.unsubscribed_at IS NULL/);
    assert.doesNotMatch(sql, /\bemail|sms|follower_optouts/);
    assert.deepEqual(args, [22, 11, '087_event_follow_attribution.sql']);
    return { rows: [{ new_followers: 2, active_followers: 7, attribution_started_at: appliedAt }] };
  };
  assert.deepEqual(await loadEventFollowerImpact({ query }, { eventId: 22, organizerId: 11 }), {
    newFollowers: 2, activeFollowers: 7, attributionStartedAt: appliedAt.toISOString()
  });
});
