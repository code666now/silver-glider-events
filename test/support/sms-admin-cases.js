module.exports = function register(ctx) {
  const { test, assert, pool, createEvent, createAdminOperator, signInAdminOperator, signSession } = ctx;

  test('announcement short links expose only public published landing pages and grant no session', async () => {
    const event = await createEvent();
    const get = id => fetch(`${ctx.baseUrl}/s/e/${id}`, { redirect: 'manual' });
    const published = await get(event.id);
    assert.equal(published.status, 302);
    assert.equal(published.headers.get('location'), `/e/${event.slug}`);
    assert.equal(published.headers.get('set-cookie'), null);
    assert.equal(published.headers.get('cache-control'), 'no-store');
    await pool.query("UPDATE events SET visibility='private' WHERE id=$1", [event.id]);
    assert.equal((await get(event.id)).status, 404);
    await pool.query("UPDATE events SET visibility='public',status='draft' WHERE id=$1", [event.id]);
    assert.equal((await get(event.id)).status, 404);
    await pool.query("UPDATE events SET status='published',visibility='private',secret_show_enabled=TRUE WHERE id=$1", [event.id]);
    const secret = await get(event.id);
    assert.equal(secret.status, 404, 'secret shows cannot use the public announcement shortcut');
    assert.equal(secret.headers.get('set-cookie'), null);
    for (const id of ['0', '-1', '01', '2147483648', 'abc']) assert.equal((await get(id)).status, 404);
  });

  test('welcome spending is super-admin-only, durable and honest about unpriced texts', async () => {
    const path = `${ctx.baseUrl}/api/admin/sms-welcome-costs`;
    assert.equal((await fetch(path)).status, 401);
    assert.equal((await fetch(path, { headers: { cookie: `sge_session=${signSession(ctx.organizerId)}` } })).status, 401);
    await createAdminOperator('text-cost-support@example.test', 'support');
    const support = await signInAdminOperator('text-cost-support@example.test');
    assert.equal((await fetch(path, { headers: { cookie: support } })).status, 403);
    await createAdminOperator('text-cost-admin@example.test', 'super_admin');
    const admin = await signInAdminOperator('text-cost-admin@example.test');
    const emptyResponse = await fetch(path, { headers: { cookie: admin } });
    assert.equal(emptyResponse.status, 200);
    assert.equal(emptyResponse.headers.get('cache-control'), 'no-store');
    const empty = await emptyResponse.json();
    assert.equal(empty.campaign.claims, 0);
    assert.equal(empty.costs.acceptedTexts, 0);
    await pool.query(`INSERT INTO sms_provider_cost_facts
      (provider_message_sid,welcome_credits,provider_price,price_unit,provider_segments)
      VALUES ($1,1,-0.0123,'USD',1),($2,1,NULL,NULL,NULL),($3,1,-0.02,'EUR',1)`,
    [`SM${'a'.repeat(32)}`, `SM${'b'.repeat(32)}`, `SM${'c'.repeat(32)}`]);
    const result = await (await fetch(path, { headers: { cookie: admin } })).json();
    assert.equal(result.costs.acceptedTexts, 3);
    assert.equal(result.costs.recordedTexts, 1);
    assert.equal(result.costs.pendingTexts, 1);
    assert.equal(result.costs.nonUsdTexts, 1);
    assert.equal(result.costs.recordedUsdCost, 0.0123);
    assert.equal(JSON.stringify(result).includes('SM' + 'a'.repeat(32)), false);
    assert.equal(JSON.stringify(result).includes('identity_hmac_key'), false);
  });
};
