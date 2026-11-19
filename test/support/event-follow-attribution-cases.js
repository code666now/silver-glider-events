module.exports = function registerEventFollowAttributionCases({
  test, assert, pool, createEvent, getOrganizerId, getBaseUrl, signSession
}) {
  const { recordLegalAcceptance } = require('../../src/lib/legal-acceptance');
  const { hashCode } = require('../../src/lib/secret-show');
  const { attachVerifiedPhoneIdentity } = require('../../src/lib/canonical-identity');
  const { loadEventFollowerImpact } = require('../../src/lib/event-follow-attribution');

  async function follower(name) {
    const { rows: [{ id }] } = await pool.query(
      'INSERT INTO organizers (email,name) VALUES ($1,$2) RETURNING id', [`${name}@example.test`, name]
    );
    // The organizer's canonical user is attached by an AFTER INSERT trigger,
    // so read the persisted row rather than the insert's original user_id.
    const { rows: [account] } = await pool.query('SELECT id,user_id FROM organizers WHERE id=$1', [id]);
    await recordLegalAcceptance(pool, account);
    return account;
  }

  const session = account => `sge_session=${signSession(account.id)}`;

  async function readSource(event, cookie = '') {
    const page = await fetch(`${getBaseUrl()}/e/${event.slug}`, { headers: cookie ? { cookie } : {} });
    const html = await page.text();
    const eventData = html.match(/<script id="event-data" type="application\/json">([^<]+)<\/script>/)?.[1];
    return eventData ? JSON.parse(eventData).followAttribution : null;
  }

  function sourceRequest(event, marker) {
    return { sourceEventSlug: event.slug, sourceAttribution: marker };
  }

  async function patch(account, body, { extraCookie = '', hostSlug = 'test-host' } = {}) {
    const cookie = [session(account), extraCookie].filter(Boolean).join('; ');
    const response = await fetch(`${getBaseUrl()}/api/hosts/${hostSlug}/follow`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ email: true, text: false, ...body })
    });
    assert.equal(response.status, 200);
    return response.json();
  }

  const impact = (event, organizerId = getOrganizerId()) => loadEventFollowerImpact(pool, { eventId: event.id, organizerId });

  test('event follower attribution keeps first-event credit stable across concurrent saves and re-follows', async () => {
    const first = await createEvent({ slug: 'first-follow-show' });
    const second = await createEvent({ slug: 'second-follow-show' });
    const fromFirst = sourceRequest(first, await readSource(first));
    const fromSecond = sourceRequest(second, await readSource(second));
    assert.match(fromFirst.sourceAttribution, /^[a-f0-9]{64}$/);
    assert.match(fromSecond.sourceAttribution, /^[a-f0-9]{64}$/);
    const person = await follower('first-show-follower');
    const results = await Promise.all([patch(person, fromFirst), patch(person, fromFirst)]);
    assert.ok(results.every(result => result.following && result.emailOn && !result.textOn));

    const pageOnly = await follower('host-page-first');
    const hostPage = await (await fetch(`${getBaseUrl()}/h/test-host`, { headers: { cookie: session(pageOnly) } })).text();
    assert.doesNotMatch(hostPage, /sourceAttribution|followAttribution/);
    await patch(pageOnly, {});
    await patch(pageOnly, fromSecond);

    const legacy = await follower('legacy-source-follower');
    await pool.query(`INSERT INTO host_follows (follower_organizer_id, follower_user_id, host_organizer_id, source_event_id)
      VALUES ($1,$2,$3,$4)`, [legacy.id, legacy.user_id, getOrganizerId(), second.id]);

    const firstImpact = await impact(first);
    assert.equal(firstImpact.newFollowers, 1);
    assert.equal(firstImpact.activeFollowers, 3);
    assert.ok(firstImpact.attributionStartedAt);
    assert.equal((await impact(second)).newFollowers, 0);
    assert.deepEqual(await impact(first, person.id), { newFollowers: 0, activeFollowers: 0, attributionStartedAt: null });

    const unfollowed = await patch(person, { ...fromFirst, email: false, text: false });
    assert.equal(unfollowed.following, false);
    assert.equal((await impact(first)).newFollowers, 0);
    assert.equal((await impact(first)).activeFollowers, 2);
    await patch(person, fromSecond);
    await patch(pageOnly, { email: false, text: false });
    await patch(pageOnly, fromSecond);
    assert.equal((await impact(first)).newFollowers, 1);
    assert.equal((await impact(second)).newFollowers, 0);
    assert.equal((await impact(second)).activeFollowers, 3);
  });

  test('event follower attribution rejects missing, wrong-host, stale, and locked source proof without blocking Follow', async () => {
    const former = await createEvent({ slug: 'hidden-after-render' });
    const newer = await createEvent({ slug: 'source-stays-public' });
    const oldMarker = await readSource(former);
    const publicMarker = await readSource(newer);
    assert.match(oldMarker, /^[a-f0-9]{64}$/);
    assert.match(publicMarker, /^[a-f0-9]{64}$/);
    await pool.query(
      "UPDATE events SET status='hidden', hidden_at=NOW(), hidden_previous_status='published' WHERE id=$1", [former.id]
    );
    assert.equal(await readSource(former), null);
    const draft = await createEvent({ slug: 'follow-draft-source', status: 'draft' });
    assert.equal(await readSource(draft, session({ id: getOrganizerId() })), null);

    for (const [name, request] of [
      ['no-source-proof', sourceRequest(newer, undefined)],
      ['wrong-event-proof', sourceRequest(newer, oldMarker)],
      ['stale-event-proof', sourceRequest(former, oldMarker)]
    ]) {
      assert.equal((await patch(await follower(name), request)).following, true);
    }
    await pool.query(`INSERT INTO organizers (email,name,org_name,public_slug)
      VALUES ('unrelated-host@example.test','Other Host','Other Host','unrelated-host')`);
    const otherHostPerson = await follower('wrong-host-proof');
    assert.equal((await patch(otherHostPerson, sourceRequest(newer, publicMarker), { hostSlug: 'unrelated-host' })).following, true);
    assert.equal((await impact(former)).newFollowers, 0);
    assert.equal((await impact(newer)).newFollowers, 0);
    assert.equal((await impact(newer)).activeFollowers, 3);

    const secret = await createEvent({ slug: 'private-secret-follow-proof', visibility: 'private', secret_show_enabled: true, secret_show_version: 1 });
    await pool.query('INSERT INTO event_secret_codes (event_id,code_hash) VALUES ($1,$2)', [secret.id, await hashCode('SD8FG2')]);
    assert.equal(await readSource(secret), null);
    const unlock = await fetch(`${getBaseUrl()}/api/public/events/${secret.slug}/unlock`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'SD8FG2' })
    });
    assert.equal(unlock.status, 200);
    const unlockCookie = unlock.headers.get('Set-Cookie')?.match(/sge_secret_\d+=[^;,]+/)?.[0];
    assert.ok(unlockCookie);
    const secretMarker = await readSource(secret, unlockCookie);
    assert.match(secretMarker, /^[a-f0-9]{64}$/);
    assert.equal((await patch(await follower('secret-without-unlock'), sourceRequest(secret, secretMarker))).following, true);
    assert.equal((await impact(secret)).newFollowers, 0);
    assert.equal((await patch(await follower('secret-with-unlock'), sourceRequest(secret, secretMarker), { extraCookie: unlockCookie })).following, true);
    assert.equal((await impact(secret)).newFollowers, 1);
  });

  test('event follower attribution counts a text-only follower without enabling email or event reminder consent', async () => {
    const event = await createEvent({ slug: 'text-only-first-follow' });
    const person = await follower('text-only-event-attribution');
    await attachVerifiedPhoneIdentity(pool, {
      userId: person.user_id, phone: '+14155550126', verifiedAt: new Date(), verificationSource: 'follow_attribution_test'
    });
    const fromEvent = sourceRequest(event, await readSource(event));
    const result = await patch(person, { ...fromEvent, email: false, text: true });
    assert.equal(result.following, true);
    assert.equal(result.emailOn, false);
    assert.equal(result.textOn, true);
    assert.equal((await impact(event)).newFollowers, 1);
    assert.equal((await impact(event)).activeFollowers, 1);
    const { rows: [{ count }] } = await pool.query('SELECT COUNT(*)::int AS count FROM rsvps WHERE event_id=$1', [event.id]);
    assert.equal(count, 0, 'following and aggregate statistics must not create an RSVP or opt the follower into event reminders');
  });
};
