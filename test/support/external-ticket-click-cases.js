module.exports = function registerExternalTicketClickCases({
  test, assert, pool, createEvent, getOrganizerId, getBaseUrl, signSession, responseCookie
}) {
  const { loadExternalTicketImpact, ticketVisitorSlot } = require('../../src/lib/external-ticket-impact');
  const { hashCode, unlockCookieName } = require('../../src/lib/secret-show');
  const point = 'e4aa1a1f33d06d42ef02f91e63c90935';
  const second = '5eece03f08dcb4e61f75375a398162c3';
  const url = 'https://dice.fm/event/fixture-show?src=ordinary';
  const empty = { totalTicketClicks: null, uniqueTicketClicks: null };

  function external(overrides = {}) {
    return createEvent({ admission_type: 'external_tickets', ticket_price: 15, ticket_url: url, ...overrides });
  }
  const page = (event, headers) => fetch(`${getBaseUrl()}/e/${event.slug}`, { headers }).then(res => res.text());
  const metrics = (event, organizerId = getOrganizerId()) => loadExternalTicketImpact(pool, { eventId: event.id, organizerId });
  const dock = (html) => {
    const start = html.indexOf('id="mobile-rsvp-dock"');
    assert.notEqual(start, -1);
    return html.slice(start);
  };

  async function click(event, browserKey = point, headers = {}) {
    const response = await fetch(`${getBaseUrl()}/api/public/events/${event.slug}/external-ticket-click`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ browserKey })
    });
    assert.equal(response.status, 204);
    assert.equal(response.headers.get('location'), null);
    assert.equal(await response.text(), '');
  }

  test('free and at-the-door RSVP actions display the admission price in the right place', async () => {
    const standard = await createEvent({ slug: 'standard-free-dock' });
    const flyer = await createEvent({ slug: 'flyer-free-dock', presentation_mode: 'flyer',
      flyer_image_url: 'https://images.example.test/flyer.jpg' });
    const door = await external({ slug: 'standard-door-dock', ticket_url: null, ticket_price: null });
    const standardHtml = await page(standard);
    assert.doesNotMatch(standardHtml, /<div class="ticket-note">/);
    assert.match(standardHtml, /<button[^>]*id="rsvp-cta"[^>]*>RSVP <span class="cta-price">· Free<\/span><\/button>/);
    const flyerHtml = await page(flyer);
    assert.match(flyerHtml, /Free with RSVP/);
    for (const html of [standardHtml, flyerHtml]) {
      assert.match(dock(html), /<div class="dock-row">\s*<p class="dock-when">\s*<strong>Free<\/strong>\s*<span>Sat, Aug 10 · 7:30 PM<\/span>\s*<\/p>\s*<button[^>]*id="mobile-rsvp-cta"[^>]*aria-controls="rsvp-form-box"[^>]*>RSVP<\/button>/);
    }
    const doorHtml = await page(door);
    assert.match(doorHtml, /<div class="ticket-note"><span>Paid admission<\/span><em>At the door<\/em><\/div>/);
    assert.match(doorHtml, /<button[^>]*id="rsvp-cta"[^>]*>RSVP<\/button>/);
    assert.match(dock(doorHtml), /<p class="dock-when"><strong>Tickets<\/strong><span>Sat, Aug 10 · 7:30 PM<\/span>/);
  });

  test('external ticket links preserve direct navigation and track a deduplicated aggregate across surfaces', async () => {
    const standard = await external({ slug: 'standard-external-clicks' });
    const flyer = await external({ slug: 'flyer-external-clicks', presentation_mode: 'flyer',
      flyer_image_url: 'https://images.example.test/flyer.jpg', ticket_url: 'https://test-show.eventbrite.com/' });
    const standardHtml = await page(standard);
    assert.match(standardHtml, /href="https:\/\/dice\.fm\/event\/fixture-show\?src=ordinary"[^>]*data-external-ticket-click/);
    assert.match(standardHtml, /<div class="ticket-note"><span>\$15<\/span>/);
    assert.match(standardHtml, /<button[^>]*id="rsvp-cta"[^>]*data-primary-action="rsvp"[^>]*>RSVP<\/button>/);
    assert.match(standardHtml, /Tickets sold on DICE/);
    assert.match(dock(standardHtml), /<p class="dock-when"><strong>\$15<\/strong><span>Sat, Aug 10 · 7:30 PM<\/span>/);
    const flyerHtml = await page(flyer);
    assert.match(flyerHtml, /id="ticket-cta"[^>]*href="https:\/\/test-show\.eventbrite\.com\/"[^>]*data-external-ticket-click/);
    const flyerDock = dock(flyerHtml);
    assert.match(flyerDock, /<div class="dock-row"><p class="dock-when"><strong>\$15<\/strong><span>Sat, Aug 10 · 7:30 PM<\/span><\/p>/);
    assert.match(flyerDock, /id="mobile-rsvp-cta"[^>]*href="https:\/\/test-show\.eventbrite\.com\/"[^>]*aria-describedby="dock-ticket-seller"[^>]*data-external-ticket-click[^>]*>Get Tickets<\/a><\/div><p id="dock-ticket-seller"[^>]*>Tickets sold on Eventbrite<\/p>/);
    assert.match(flyerHtml, /RSVP instead/);
    assert.equal(flyerHtml.match(/Tickets sold on Eventbrite/g)?.length, 2);
    assert.deepEqual(await metrics(standard), { totalTicketClicks: 0, uniqueTicketClicks: 0 });
    assert.deepEqual(await metrics(standard, getOrganizerId() + 10000), empty);
    assert.notEqual(ticketVisitorSlot(standard.id, point), ticketVisitorSlot(standard.id, second));
    await Promise.all([click(standard), click(standard), click(standard, second), click(flyer)]);
    assert.deepEqual(await metrics(standard), { totalTicketClicks: 3, uniqueTicketClicks: 2 });
    assert.deepEqual(await metrics(flyer), { totalTicketClicks: 1, uniqueTicketClicks: 1 });
    const { rows: [stored] } = await pool.query('SELECT * FROM external_ticket_clicks WHERE event_id=$1', [standard.id]);
    assert.deepEqual(Object.keys(stored).sort(), ['event_id', 'total_clicks', 'unique_clicks', 'visitor_slots']);
    await pool.query('UPDATE events SET ticket_url=NULL WHERE id=$1', [standard.id]);
    await click(standard);
    assert.deepEqual(await metrics(standard), { totalTicketClicks: 3, uniqueTicketClicks: 2 });
  });

  test('external ticket click analytics omit missing sellers, drafts, checkout, untracked past events, and unauthorized activity', async () => {
    const door = await external({ slug: 'at-door-test', ticket_url: null });
    const native = await createEvent({ slug: 'native-ticket-test', admission_type: 'silver_glider_tickets' });
    const historical = await external({ slug: 'historic-ticket-test', event_date: '2010-01-01' });
    const draft = await external({ slug: 'draft-ticket-test', status: 'draft' });
    const hidden = await external({ slug: 'hidden-ticket-test', status: 'hidden',
      hidden_at: new Date(), hidden_previous_status: 'published' });
    const cancelled = await external({ slug: 'cancelled-ticket-test', status: 'cancelled' });
    const publicEvent = await external({ slug: 'real-ticket-test' });
    const owner = { cookie: `sge_session=${signSession(getOrganizerId())}` };
    for (const event of [door, native, historical, draft, hidden, cancelled]) {
      await click(event);
      assert.deepEqual(await metrics(event), empty);
    }
    assert.match(await page(door), /At the door/);
    assert.doesNotMatch(await page(door), /data-external-ticket-click|Tickets sold on/);
    assert.doesNotMatch(await page(native), /data-external-ticket-click/);
    assert.doesNotMatch(await page(publicEvent, owner), /data-external-ticket-click/);
    await click(publicEvent, point, owner);
    await click(publicEvent, point, { origin: 'https://different.example', 'sec-fetch-site': 'cross-site' });
    await click(publicEvent, 'example@example.test');
    assert.deepEqual(await metrics(publicEvent), { totalTicketClicks: 0, uniqueTicketClicks: 0 });
  });

  test('Secret Show external-ticket clicks need that event’s valid unlock, including after code rotation', async () => {
    const privateEvent = await external({ slug: 'secret-ticket-test', visibility: 'private', secret_show_enabled: true, secret_show_version: 1 });
    const code = '123456';
    await pool.query('INSERT INTO event_secret_codes (event_id,code_hash) VALUES ($1,$2)', [privateEvent.id, await hashCode(code)]);
    const unlock = await fetch(`${getBaseUrl()}/api/public/events/${privateEvent.slug}/unlock`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code })
    });
    assert.equal(unlock.status, 200);
    const cookie = responseCookie(unlock, unlockCookieName(privateEvent.id));
    assert.ok(cookie);
    assert.doesNotMatch(await page(privateEvent), /data-external-ticket-click/);
    assert.match(await page(privateEvent, { cookie }), /data-external-ticket-click/);
    await click(privateEvent);
    await click(privateEvent, point, { cookie });
    await pool.query('UPDATE events SET secret_show_version=2 WHERE id=$1', [privateEvent.id]);
    await click(privateEvent, point, { cookie });
    assert.deepEqual(await metrics(privateEvent), { totalTicketClicks: 1, uniqueTicketClicks: 1 });
  });
};
