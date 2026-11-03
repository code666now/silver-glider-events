'use strict';

// Registered inside public-flows.test.js to retain its serial sge_test reset
// hooks, dev outbox and background-work drain. Never run a second SQL fixture.
module.exports = function registerThankYouCreditsCases(h) {
  const { test, assert, pool, mailer } = h;
  const credits = [{ name: 'DJ Night', role: 'DJ', instagramHandle: 'night.dj' }];
  const draft = extra => ({ subject: 'Thanks for our night', message: 'Thanks for being part of it.', includeFollow: true, ...extra });
  const read = async (event, cookie) => (await (await h.postEventRequest(event.id, cookie)).json()).thankYou;
  const save = (event, cookie, body) => h.postEventRequest(event.id, cookie, '/thank-you', 'PUT', body);
  const count = async table => Number((await pool.query(`SELECT COUNT(*)::int AS count FROM ${table}`)).rows[0].count);

  async function fixture(overrides = {}) {
    const current = await h.postEventFixture(overrides);
    mailer.devOutbox.length = 0;
    return current;
  }

  test('simple thank-you credits suggest only this owned event vibe and retain an explicitly cleared draft', async () => {
    const { event, cookie } = await fixture({ event_vibe_label: 'Our DJ', event_vibe_label_2: 'Our Photographer', event_vibe_label_3: null });
    await h.createEvent({ slug: 'unrelated-credits-night', event_date: '2020-10-01', event_vibe_label: 'Never copy this person' });
    assert.deepEqual((await read(event, cookie)).credits, [
      { name: 'Our DJ', role: '', instagramHandle: null },
      { name: 'Our Photographer', role: '', instagramHandle: null }
    ]);
    assert.equal((await save(event, cookie, draft({ credits: [] }))).status, 200);
    assert.deepEqual((await read(event, cookie)).credits, []);
    await pool.query("UPDATE events SET event_vibe_label='Changed suggested artist' WHERE id=$1", [event.id]);
    assert.deepEqual((await read(event, cookie)).credits, [], 'a deliberate removal never repopulates on reload or event edit');
    assert.equal((await save(event, cookie, draft({ message: 'Only the message changed.' }))).status, 200);
    assert.deepEqual((await read(event, cookie)).credits, [], 'a legacy partial client cannot restore removed credits');
    const batch = (await pool.query('SELECT credits FROM post_event_thank_you_batches WHERE event_id=$1', [event.id])).rows[0];
    assert.deepEqual(batch.credits, []);
    assert.equal(mailer.devOutbox.length, 0);
  });

  test('a NULL legacy unsent credits draft uses current event suggestions until a specific list is saved', async () => {
    const { event, cookie } = await fixture({ event_vibe_label: 'Original Vibe' });
    assert.equal((await save(event, cookie, draft({ credits: [] }))).status, 200);
    await pool.query('UPDATE post_event_thank_you_batches SET credits=NULL WHERE event_id=$1', [event.id]);
    assert.deepEqual((await read(event, cookie)).credits, [{ name: 'Original Vibe', role: '', instagramHandle: null }]);
    const saved = await save(event, cookie, draft({ credits: [{ name: '  My   Person ', instagramHandle: '@Night.DJ' }] }));
    assert.equal(saved.status, 200, await saved.clone().text());
    assert.deepEqual((await saved.json()).thankYou.credits, [{ name: 'My Person', role: '', instagramHandle: 'night.dj' }]);
    await pool.query("UPDATE events SET event_vibe_label='Not the saved person' WHERE id=$1", [event.id]);
    assert.deepEqual((await read(event, cookie)).credits, [{ name: 'My Person', role: '', instagramHandle: 'night.dj' }]);
  });

  test('saving simple credits is owner-only and changes no event, account, RSVP, contributor invitation, follow or email', async () => {
    const { event, cookie } = await fixture({ event_vibe_label: 'Keep this event artist' });
    const outsider = await h.signInAccount('outside-credits-host@example.test');
    mailer.devOutbox.length = 0;
    const beforeEvent = (await pool.query('SELECT * FROM events WHERE id=$1', [event.id])).rows[0];
    const beforeAccounts = (await pool.query('SELECT id,name,org_name,public_slug,logo_url,instagram_handle FROM organizers ORDER BY id')).rows;
    const tables = ['rsvps', 'event_contributors', 'contributor_profiles', 'contributor_follow_intents', 'host_follows', 'message_log'];
    const beforeCounts = await Promise.all(tables.map(count));
    assert.equal((await save(event, '', draft({ credits }))).status, 401);
    assert.equal((await h.postEventRequest(event.id, outsider.sessionCookie)).status, 404);
    assert.equal((await save(event, outsider.sessionCookie, draft({ credits, organizerId: h.organizerId }))).status, 404);
    const response = await save(event, cookie, draft({ credits: [{ ...credits[0], email: 'do-not-contact@example.test', userId: 999, profileUrl: '/people/forged' }] }));
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual((await read(event, cookie)).credits, credits, 'only the credit presentation fields are persisted');
    assert.deepEqual((await pool.query('SELECT * FROM events WHERE id=$1', [event.id])).rows[0], beforeEvent);
    assert.deepEqual((await pool.query('SELECT id,name,org_name,public_slug,logo_url,instagram_handle FROM organizers ORDER BY id')).rows, beforeAccounts);
    assert.deepEqual(await Promise.all(tables.map(count)), beforeCounts);
    assert.equal(mailer.devOutbox.length, 0, 'saving credit text never sends an invitation, claim, or guest email');
  });

  test('simple credits reject over-limit lists, invalid names and unsafe Instagram sources without changing the previous draft', async () => {
    const { event, cookie } = await fixture();
    assert.equal((await save(event, cookie, draft({ credits }))).status, 200);
    const invalid = [
      null, {}, [{ name: '' }], [{ name: 'x'.repeat(101) }], [{ name: 'Valid', role: 'x'.repeat(81) }],
      Array.from({ length: 4 }, (_, index) => ({ name: `Person ${index}` })),
      ...['javascript:alert(1)', 'https://instagram.com.evil.test/name', 'https://instagram.com@evil.test/name',
        'https://evil.test/instagram.com/name', 'https://user:pass@instagram.com/name', 'https://instagram.com/name/extra',
        'https://instagram.com/%2Fother', 'bad handle'].map(instagramHandle => ({ name: 'Valid name', instagramHandle })).map(person => [person])
    ];
    for (const value of invalid) {
      const response = await save(event, cookie, draft({ credits: value }));
      assert.equal(response.status, 400, `${JSON.stringify(value)}: ${await response.clone().text()}`);
      assert.deepEqual((await read(event, cookie)).credits, credits);
    }
    assert.equal(mailer.devOutbox.length, 0);
  });

  test('v4 preview renders plain credits or canonical Instagram links without creating an onboarding flow', async () => {
    const { event, cookie } = await fixture();
    await h.createRsvp(event.id, { email: 'simple-preview-guest@example.test' });
    const preview = await h.previewPostEventDraft(event.id, cookie, draft({ credits: [
      { name: 'A & B', role: '<b>DJ</b>', instagramHandle: 'https://www.instagram.com/Night.DJ/?igsh=tracking#discard' },
      { name: 'Name Only' }
    ] }));
    assert.match(preview.html, /Big thanks to/);
    assert.match(preview.html, /A &amp; B/);
    assert.match(preview.html, /&lt;b&gt;DJ&lt;\/b&gt;/);
    assert.match(preview.html, /Name Only/);
    assert.match(preview.html, /https:\/\/(?:www\.)?instagram\.com\/night\.dj\/?/);
    assert.match(preview.html, /Follow my page/);
    assert.doesNotMatch(preview.html, /igsh=|tracking|#discard|\/people\/|contributors\/|claim|Meet Name Only|<b>DJ<\/b>|9876 Private Address|simple-preview-guest@example\.test/);
    assert.equal(await count('event_contributors'), 0);
    assert.equal(await count('contributor_profiles'), 0);
    assert.equal(await count('contributor_follow_intents'), 0);
    assert.equal(await count('host_follows'), 0);
    assert.equal(mailer.devOutbox.length, 0);
  });

  test('changed simple credits invalidate a preview, while an approved completed note cannot be edited or sent twice', async () => {
    const { event, cookie } = await fixture();
    await h.createRsvp(event.id, { email: 'simple-approved-guest@example.test' });
    const initial = await h.previewPostEventDraft(event.id, cookie, draft({ credits }));
    const nextCredits = [{ name: 'Updated Person', role: '', instagramHandle: null }];
    assert.equal((await save(event, cookie, draft({ credits: nextCredits }))).status, 200);
    assert.equal((await h.postEventRequest(event.id, cookie, '/thank-you/send', 'POST', { previewToken: initial.previewToken })).status, 409);
    assert.equal(mailer.devOutbox.length, 0);
    const final = await h.previewPostEventDraft(event.id, cookie, draft({ credits: nextCredits }));
    assert.equal((await h.postEventRequest(event.id, cookie, '/thank-you/send', 'POST', { previewToken: final.previewToken })).status, 202);
    await h.settlePostEventThankYouWork();
    const delivered = h.lastDevEmail('simple-approved-guest@example.test');
    assert.match(delivered.html, /Updated Person/);
    assert.doesNotMatch(delivered.html, /\/people\/|contributors\/claim/);
    const state = await read(event, cookie);
    assert.equal(state.status, 'sent');
    assert.deepEqual(state.credits, nextCredits);
    assert.equal((await save(event, cookie, draft({ credits: [] }))).status, 409);
    assert.equal((await h.postEventRequest(event.id, cookie, '/thank-you/send', 'POST', { previewToken: final.previewToken })).status, 409);
    await h.settlePostEventThankYouWork();
    assert.equal(mailer.devOutbox.filter(message => message.to === 'simple-approved-guest@example.test').length, 1);
  });

  test('a v4 retry uses frozen credit text and artwork after source-event edits, with its original provider key', async () => {
    const { event } = await fixture({ event_vibe_label: 'Original artist' });
    const rsvp = await h.createRsvp(event.id, { email: 'simple-retry-guest@example.test' });
    const person = { rsvp, userId: null, consentScope: 'event_rsvp' };
    const { batch, logs } = await h.seedApprovedPostEventBatch(event, [person]);
    const { loadPostEventContext, emailRenderSnapshot, renderSnapshotDigest } = require('../../src/lib/post-event');
    const context = await loadPostEventContext(pool, { eventId: event.id, organizerId: h.organizerId });
    const snapshot = emailRenderSnapshot(context.event, context.host, { thankYouVersion: 4, credits });
    const snapshotHash = renderSnapshotDigest(snapshot);
    await pool.query('UPDATE post_event_thank_you_batches SET credits=$2::jsonb,render_snapshot=$3::jsonb,render_snapshot_hash=$4 WHERE id=$1',
      [batch.id, JSON.stringify(credits), JSON.stringify(snapshot), snapshotHash]);
    await pool.query("UPDATE message_log SET status='failed',attempt_count=1,last_attempt_at=NOW()-INTERVAL '3 minutes',error='transport_unavailable' WHERE id=$1", [logs[0].id]);
    await pool.query("UPDATE events SET title='Changed live event',event_vibe_label='Changed live artist',cover_image_url='https://example.test/changed-live.jpg' WHERE id=$1", [event.id]);
    const worker = require('../../src/jobs/post-event-thank-yous');
    await worker.processPostEventThankYouBatch(batch.id);
    await worker.processPostEventThankYouBatch(batch.id);
    const delivered = h.lastDevEmail(rsvp.email);
    assert.match(delivered.html, /DJ Night/);
    assert.match(delivered.html, /Our Night/);
    assert.doesNotMatch(delivered.html, /Changed live event|Changed live artist|changed-live\.jpg|\/people\/|contributors\/claim/);
    assert.equal(delivered.idempotencyKey, `post-event-thank-you:${batch.id}:${logs[0].id}`);
    assert.equal(mailer.devOutbox.filter(message => message.to === rsvp.email).length, 1);
    const frozen = (await pool.query('SELECT render_snapshot,render_snapshot_hash FROM post_event_thank_you_batches WHERE id=$1', [batch.id])).rows[0];
    assert.equal(frozen.render_snapshot_hash, snapshotHash);
    assert.deepEqual(frozen.render_snapshot, JSON.parse(JSON.stringify(snapshot)));
  });
};
