// Registered by the single HTTP/PostgreSQL harness; standalone discovery does
// not connect to a database or initialize credentials.
module.exports = function registerBackgroundAvailabilityCases({
  test, assert, pool, createEvent, getOrganizerId, getBaseUrl, signSession,
  createAdminOperator, signInAdminOperator, createDoneForYouClient,
  openDoneForYouEditor, openFlyerPreviewSession, mailer
}) {
  const EventBackgrounds = require('../../public/js/event-backgrounds');
  const { backgroundSelectionAllowed } = require('../../src/lib/background-availability');
  const ownerCookie = () => `sge_session=${signSession(getOrganizerId())}`;
  async function request(path, { method = 'GET', body, cookie = ownerCookie(), origin = getBaseUrl() } = {}) {
    return fetch(`${getBaseUrl()}${path}`, {
      method, redirect: 'manual',
      headers: { ...(cookie ? { cookie } : {}), origin, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
  }
  async function admin() {
    const operator = await createAdminOperator('background-admin@example.test');
    return { operator, cookie: await signInAdminOperator(operator.email) };
  }
  const toggle = (cookie, key, active) => request(`/api/admin/backgrounds/${key}`, { cookie, method: 'PATCH', body: { active } });
  const createBody = theme => ({ title: 'New background night', event_date: '2099-08-10', start_time: '19:30', venue_name: 'Test Hall', status: 'draft', background_theme: theme });
  const seasonalBackgrounds = ['rain-on-glass', 'gather-and-glow', 'candlelit-christmas', 'snow-day', 'midnight-toast', 'starlit-celebration'];
  const fixtureFlyerUrl = 'https://res.cloudinary.com/integration-cloud/image/upload/sg-events/flyers/background-check.jpg';

  async function assertBackgroundPage(event, key, mode, owner = false) {
    const page = await request(`/e/${event.slug}`, { cookie: owner ? ownerCookie() : '' });
    assert.equal(page.status, 200, `${mode} ${key}: ${owner ? 'owner' : 'public'} page loads`);
    const html = await page.text();
    assert.ok(html.includes(`class="event-bg bg-theme fx-${key}"`), `${mode} ${key}: selected effect is rendered`);
    const video = html.match(new RegExp(`<video\\b[^>]*data-effect-theme="${key}"[^>]*>[\\s\\S]*?<\\/video>`));
    assert.ok(video, `${mode} ${key}: selected effect has its own video element`);
    assert.ok(video[0].includes(`/${key}-v1.jpg"`), `${mode} ${key}: versioned still poster is rendered`);
    assert.ok(video[0].includes(`/${key}-v1.mp4"`), `${mode} ${key}: versioned video source is rendered`);
    assert.match(video[0], /<source media="\(max-width: 900px\)"/);
    assert.equal(/<body class="flyer-public-page">/.test(html), mode === 'flyer');
    const ownerData = html.match(/<script id="owner-event-data" type="application\/json">([\s\S]*?)<\/script>/);
    if (owner) {
      assert.ok(ownerData, `${mode} ${key}: authenticated owner editor is present`);
      const savedDesign = JSON.parse(ownerData[1]);
      assert.equal(savedDesign.backgroundTheme, key);
      assert.equal(savedDesign.presentationMode, mode);
      assert.ok(html.includes(`data-owner-theme="${key}"`));
    } else {
      assert.equal(ownerData, null, 'public visitors must not receive the owner editor');
    }
  }

  test('background manager is dedicated Super Admin only with same-origin and strict boolean writes', async () => {
    const { cookie } = await admin();
    const support = await createAdminOperator('background-support@example.test', 'support');
    const supportCookie = await signInAdminOperator(support.email);
    await pool.query('UPDATE organizers SET is_admin=TRUE WHERE id=$1', [getOrganizerId()]);
    for (const denied of ['', ownerCookie()]) {
      assert.equal((await request('/api/admin/backgrounds', { cookie: denied })).status, 401);
      assert.equal((await toggle(denied, 'halloween', false)).status, 401);
    }
    assert.equal((await request('/api/admin/backgrounds', { cookie: supportCookie })).status, 403);
    assert.equal((await toggle(supportCookie, 'halloween', false)).status, 403);
    assert.equal((await request('/admin/backgrounds', { cookie: supportCookie })).status, 302);
    assert.equal((await request('/api/backgrounds', { cookie: '' })).status, 401);
    assert.equal((await request('/api/admin/backgrounds/halloween', {
      cookie, method: 'PATCH', body: { active: false }, origin: 'https://untrusted.example'
    })).status, 403);
    for (const active of ['false', 0, null]) assert.equal((await toggle(cookie, 'halloween', active)).status, 400);
    assert.equal((await toggle(cookie, 'not-a-theme', false)).status, 404);
    for (const key of ['adaptive', 'midnight', 'plaster']) assert.equal((await toggle(cookie, key, false)).status, 409);
    assert.equal((await request('/api/admin/auth/me', { cookie })).status, 200);
    assert.equal((await (await request('/api/admin/auth/me', { cookie })).json()).capabilities.manageBackgrounds, true);
    assert.equal((await (await request('/api/admin/auth/me', { cookie: supportCookie })).json()).capabilities.manageBackgrounds, false);
    const list = await request('/api/admin/backgrounds', { cookie });
    assert.equal(list.status, 200);
    assert.match(list.headers.get('cache-control'), /private, no-store/);
    assert.deepEqual((await list.json()).activeKeys, EventBackgrounds.keys);
    await pool.query("UPDATE admin_operators SET status='disabled' WHERE email='background-admin@example.test'");
    assert.equal((await toggle(cookie, 'halloween', false)).status, 401);
  });

  test('background changes persist and audit once without changing events, messages, or rendering keys', async () => {
    const original = await createEvent({ background_theme: 'halloween' });
    const { cookie, operator } = await admin();
    const messagesBefore = mailer.devOutbox.length;
    assert.equal((await toggle(cookie, 'halloween', false)).status, 200);
    assert.equal((await toggle(cookie, 'halloween', false)).status, 200);
    const saved = (await pool.query('SELECT * FROM event_background_availability WHERE background_key=$1', ['halloween'])).rows[0];
    assert.equal(saved.active, false);
    assert.equal(Number(saved.updated_by_admin_operator_id), Number(operator.id));
    const list = await (await request('/api/backgrounds')).json();
    assert.equal(list.backgrounds.find(item => item.key === 'halloween').active, false);
    assert.ok(!list.activeKeys.includes('halloween'));
    assert.doesNotMatch(JSON.stringify(list), /organizer_id|event_id|@example\.test|request_ip/);
    const history = (await pool.query("SELECT before_state,after_state,metadata FROM admin_account_audit_log WHERE action_type='background_availability_changed'")).rows;
    assert.deepEqual(history, [{ before_state: { active: true }, after_state: { active: false }, metadata: { background_key: 'halloween' } }]);
    assert.deepEqual((await pool.query('SELECT * FROM events WHERE id=$1', [original.id])).rows[0], original);
    assert.equal(mailer.devOutbox.length, messagesBefore);
    assert.equal((await toggle(cookie, 'halloween', true)).status, 200);
    assert.ok((await (await request('/api/backgrounds')).json()).activeKeys.includes('halloween'));
  });

  test('inactive backgrounds are rejected for new and stale selections while existing and duplicated designs survive', async () => {
    const old = await createEvent({ background_theme: 'halloween', status: 'published' });
    const other = await createEvent({ slug: 'fresh-background-night', status: 'draft' });
    const { cookie } = await admin();
    assert.ok((await (await request('/api/backgrounds')).json()).activeKeys.includes('halloween'));
    await toggle(cookie, 'halloween', false);
    const created = await request('/api/events', { method: 'POST', body: createBody('halloween') });
    assert.equal(created.status, 409);
    assert.equal((await created.json()).error, 'background_unavailable');
    const stale = await request(`/api/events/${other.id}`, { method: 'PUT', body: { background_theme: 'halloween' } });
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).error, 'background_unavailable');
    const publicPage = await request(`/e/${old.slug}`, { cookie: '' });
    assert.equal(publicPage.status, 200);
    assert.match(await publicPage.text(), /fx-halloween/);
    const ownerPage = await request(`/e/${old.slug}`);
    assert.match(await ownerPage.text(), /data-owner-theme="halloween"/);
    const retained = await request(`/api/events/${old.id}`, { method: 'PUT', body: { title: 'Still the same design', background_theme: 'halloween' } });
    assert.equal(retained.status, 200);
    assert.equal((await retained.json()).event.background_theme, 'halloween');
    const duplicate = await request(`/api/events/${old.id}/duplicate`, { method: 'POST' });
    assert.equal(duplicate.status, 201);
    const copied = (await duplicate.json()).event;
    assert.equal(copied.background_theme, 'halloween');
    assert.equal((await request(`/api/events/${copied.id}`, { method: 'PUT', body: { title: 'Copied design', background_theme: 'halloween' } })).status, 200);
    assert.equal((await request(`/api/events/${old.id}`, { method: 'PUT', body: { background_theme: 'midnight' } })).status, 200);
    assert.equal((await request(`/api/events/${old.id}`, { method: 'PUT', body: { background_theme: 'halloween' } })).status, 409);
    await toggle(cookie, 'halloween', true);
    assert.equal((await request(`/api/events/${other.id}`, { method: 'PUT', body: { background_theme: 'halloween' } })).status, 200);
  });

  test('inactive availability does not alter published Flyer designs or block unrelated saves', async () => {
    const event = await createEvent({ presentation_mode: 'flyer', flyer_image_url: 'https://res.cloudinary.com/integration-cloud/image/upload/sg-events/flyers/background-check.jpg', background_theme: 'last-guest' });
    await pool.query("UPDATE event_background_availability SET active=FALSE WHERE background_key='last-guest'");
    const page = await request(`/e/${event.slug}`, { cookie: '' });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /fx-last-guest/);
    const save = await request(`/api/events/${event.id}`, { method: 'PUT', body: { description: 'Only the description changed.' } });
    assert.equal(save.status, 200);
    assert.equal((await save.json()).event.background_theme, 'last-guest');
  });

  test('all six curated video backgrounds save and render for owners and guests in Standard and Flyer', async () => {
    for (const mode of ['standard', 'flyer']) {
      for (const key of seasonalBackgrounds) {
        const event = await createEvent({
          slug: `background-${mode}-${key}`,
          presentation_mode: mode,
          flyer_image_url: mode === 'flyer' ? fixtureFlyerUrl : null
        });
        const save = await request(`/api/events/${event.id}`, { method: 'PUT', body: { background_theme: key } });
        assert.equal(save.status, 200, `${mode} ${key}: authenticated owner save succeeds`);
        assert.equal((await save.json()).event.background_theme, key);
        const persisted = (await pool.query('SELECT background_theme,presentation_mode,flyer_image_url FROM events WHERE id=$1', [event.id])).rows[0];
        assert.deepEqual(persisted, {
          background_theme: key,
          presentation_mode: mode,
          flyer_image_url: mode === 'flyer' ? fixtureFlyerUrl : null
        });
        await assertBackgroundPage(event, key, mode);
        await assertBackgroundPage(event, key, mode, true);
      }
    }
  });

  test('deactivating a new video preserves existing Standard and Flyer designs but rejects new selections', async () => {
    const key = 'candlelit-christmas';
    const { cookie } = await admin();
    const existing = [];
    for (const mode of ['standard', 'flyer']) {
      existing.push(await createEvent({
        slug: `retained-seasonal-${mode}`,
        background_theme: key,
        presentation_mode: mode,
        flyer_image_url: mode === 'flyer' ? fixtureFlyerUrl : null
      }));
    }
    assert.equal((await toggle(cookie, key, false)).status, 200);
    assert.ok(!(await (await request('/api/backgrounds')).json()).activeKeys.includes(key));
    for (const event of existing) {
      await assertBackgroundPage(event, key, event.presentation_mode);
      await assertBackgroundPage(event, key, event.presentation_mode, true);
      const retained = await request(`/api/events/${event.id}`, {
        method: 'PUT', body: { title: 'Seasonal design retained', background_theme: key }
      });
      assert.equal(retained.status, 200);
      assert.equal((await retained.json()).event.background_theme, key);
      const other = await createEvent({
        slug: `different-seasonal-${event.presentation_mode}`,
        presentation_mode: event.presentation_mode,
        flyer_image_url: event.flyer_image_url
      });
      const rejected = await request(`/api/events/${other.id}`, { method: 'PUT', body: { background_theme: key } });
      assert.equal(rejected.status, 409);
      assert.equal((await rejected.json()).error, 'background_unavailable');
      assert.equal((await pool.query('SELECT background_theme FROM events WHERE id=$1', [other.id])).rows[0].background_theme, 'midnight');
    }
    const rejectedCreate = await request('/api/events', { method: 'POST', body: createBody(key) });
    assert.equal(rejectedCreate.status, 409);
    assert.equal((await rejectedCreate.json()).error, 'background_unavailable');
  });

  test('Done For You workspace reuses availability and cannot introduce an inactive selection', async () => {
    const { cookie } = await admin();
    const { client } = await createDoneForYouClient(cookie, { email: 'background-client@example.test', contactName: 'Background Client', hostName: 'Background Hosts' });
    const workspace = await openDoneForYouEditor(cookie, client.id);
    const workspaceCookie = `${cookie}; ${workspace.editorCookie}`;
    await toggle(cookie, 'disco', false);
    assert.equal((await request('/admin-editor/api/backgrounds', { cookie })).status, 401);
    const list = await request('/admin-editor/api/backgrounds', { cookie: workspaceCookie });
    assert.equal(list.status, 200);
    assert.ok(!(await list.json()).activeKeys.includes('disco'));
    const blocked = await request('/admin-editor/api/events', { cookie: workspaceCookie, method: 'POST', body: createBody('disco') });
    assert.equal(blocked.status, 409);
    assert.equal((await blocked.json()).error, 'background_unavailable');
  });

  test('flyer recipient picker retains its own inactive look but rejects other inactive looks', async () => {
    const event = await createEvent({ status: 'draft', presentation_mode: 'flyer', background_theme: 'halloween', flyer_image_url: 'https://images.example.test/flyer-background.jpg' });
    const row = (await pool.query(
      `INSERT INTO admin_flyer_requests
         (submitter_name,host_name,email,phone_e164,flyer_url,flyer_public_id,sms_consent_at,sms_consent_version,status,event_id)
       VALUES ('Preview Person','Preview Host','preview-background@example.test','+14155550198',
               'https://images.example.test/flyer-background.jpg','flyers/background',NOW(),'dfy-transactional-v1','preview_sent',$1) RETURNING id`, [event.id]
    )).rows[0];
    const cookie = await openFlyerPreviewSession(row.id);
    await pool.query("UPDATE event_background_availability SET active=FALSE WHERE background_key IN ('halloween','last-guest')");
    const preview = await request('/api/flyer-preview', { cookie });
    assert.equal(preview.status, 200);
    const looks = (await preview.json()).looks;
    assert.equal(looks.find(item => item.key === 'halloween').active, false);
    assert.ok(!looks.some(item => item.key === 'last-guest'));
    assert.equal((await request('/api/flyer-preview/look', { cookie, method: 'POST', body: { backgroundTheme: 'halloween' } })).status, 200);
    const blocked = await request('/api/flyer-preview/look', { cookie, method: 'POST', body: { backgroundTheme: 'last-guest' } });
    assert.equal(blocked.status, 409);
    assert.equal((await blocked.json()).error, 'background_unavailable');
    assert.equal((await request('/api/flyer-preview/look', { cookie, method: 'POST', body: { backgroundTheme: 'midnight' } })).status, 200);
    assert.equal((await request('/api/flyer-preview/look', { cookie, method: 'POST', body: { backgroundTheme: 'halloween' } })).status, 409);
  });

  test('new background selection serializes with deactivation instead of accepting a stale read', async () => {
    const writer = await pool.connect();
    const reader = await pool.connect();
    try {
      await writer.query('BEGIN');
      await writer.query("UPDATE event_background_availability SET active=FALSE WHERE background_key='halloween'");
      await reader.query('BEGIN');
      const selection = backgroundSelectionAllowed(reader, 'halloween');
      await writer.query('COMMIT');
      assert.equal(await selection, false);
      await reader.query('COMMIT');
    } finally {
      await writer.query('ROLLBACK').catch(() => {});
      await reader.query('ROLLBACK').catch(() => {});
      writer.release(); reader.release();
    }
  });
};
