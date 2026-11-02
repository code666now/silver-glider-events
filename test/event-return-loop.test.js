process.env.SESSION_SECRET ||= 'return-loop-unit-test-only';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { canInviteFriend, friendShareAvailable, nextPublicEvent, renderEventReturn } = require('../src/lib/event-return');
const upcoming = { status:'published',visibility:'public',secret_show_enabled:false,starts_in_future:true,total_attendance:2,capacity:3 };
const ended = { ...upcoming,id:1,organizer_id:2,post_event_ended:true,organizer_public_slug:'good-company',org_name:'Good & Company' };

test('friend invitation prompt is public-only, upcoming and capacity-aware', () => {
  assert.equal(canInviteFriend(upcoming),true);
  for (const patch of [{visibility:'private'},{secret_show_enabled:true},{status:'draft'},{status:'cancelled'},{starts_in_future:false},{total_attendance:3},{capacity:0}]) {
    assert.equal(canInviteFriend({...upcoming,...patch}),false);
  }
  assert.equal(canInviteFriend({...upcoming,capacity:null}),true);
});

test('friend share availability reads current party counts and fails closed without failing RSVP', async () => {
  assert.equal(await friendShareAvailable({query:async sql => {
    assert.match(sql,/COUNT\(guest_first_name\)/);
    return {rows:[{...upcoming,total_attendance:3}]};
  }},1),false);
  assert.equal(await friendShareAvailable({query:async()=>{throw new Error('offline');}},1),false);
});

test('next event lookup is owner-bound, public, non-secret, active and chronologically bounded', async () => {
  let calls=0;
  const db={query:async(sql,values)=>{
    calls++;
    assert.deepEqual(values,[2,1]);
    for(const pattern of [/e\.organizer_id=\$1/,/e\.id<>\$2/,/e\.status='published'/,/e\.visibility='public'/,/secret_show_enabled=FALSE/,/account_status='active'/,/AT TIME ZONE e\.timezone > NOW\(\)/,/LIMIT 1/]) assert.match(sql,pattern);
    assert.doesNotMatch(sql,/manage_token|email|venue_address/);
    return {rows:[{slug:'next-night'}]};
  }};
  assert.equal((await nextPublicEvent(db,ended)).slug,'next-night');
  assert.equal(await nextPublicEvent(db,{...ended,post_event_ended:false}),null);
  assert.equal(await nextPublicEvent(db,{...ended,status:'cancelled'}),null);
  assert.equal(calls,1);
});

test('ended event offers a safe next event or explicit Follow, without replacing original details', () => {
  const html=renderEventReturn(ended,{slug:'next-night',title:'Next <script>',event_date:'2099-09-01',cover_image_url:'https://example.test/art.jpg'});
  assert.match(html,/Next from Good &amp; Company/);
  assert.match(html,/Next &lt;script&gt;/);
  assert.match(html,/href="\/e\/next-night"/);
  assert.doesNotMatch(html,/event-return-follow/);
  assert.match(renderEventReturn(ended,null),/id="event-return-follow"/);
  assert.equal(renderEventReturn({...ended,post_event_ended:false},null),'');
});

test('both event presentations and owner repeat flow reuse existing scoped actions', () => {
  const read=file=>fs.readFileSync(path.join(__dirname,'..',file),'utf8');
  for(const file of ['src/views/event-public.html','src/views/event-public-flyer.html']) assert.match(read(file),/{{EVENT_RETURN_HTML}}/);
  const client=read('public/js/public-event.js');
  assert.match(client,/response !== 'going' \|\| confirmationEditing \|\| !EVENT.friendShareAllowed/);
  assert.match(client,/closeRsvpConfirmation\(\);\s+share\(\)/);
  assert.match(client,/location\.origin \+ `\/e\/\$\{EVENT.slug\}`/);
  const editor=read('public/js/event-owner-editor.js');
  assert.match(editor,/get\('repeat'\) === '1' && EVENT.status === 'draft'/);
  assert.match(editor,/repeatRequested.*'&repeat=1'/);
});
