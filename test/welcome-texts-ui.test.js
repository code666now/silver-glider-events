const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const client = read('public/js/welcome-texts.js');

function fixture(context = 'messaging') {
  const nodes = new Map();
  const node = key => {
    if (!nodes.has(key)) nodes.set(key, { textContent:'',checked:false,disabled:false,handlers:{},
      addEventListener(name, fn) { this.handlers[name] = fn; },
      setAttribute() {}, removeAttribute() {}, focus() {}, classList:{ toggle() {} } });
    return nodes.get(key);
  };
  const container = { id:'test-welcome',hidden:true,html:'',
    set innerHTML(value) { this.html=value; nodes.clear(); },get innerHTML() { return this.html; },
    replaceChildren() { this.html=''; },
    querySelector(selector) { return this.html.includes(selector.slice(1,-1)) ? node(selector) : null; }
  };
  const scope = {window:{location:{origin:'https://site.test'}},URL,fetch:async()=>{},navigator:{},document:{}};
  vm.runInNewContext(client,scope);
  return {container,scope,controller:scope.window.SgeWelcomeTexts.create(container,{context,eventId:'first'})};
}
const eligible = {enabled:true,state:'eligible',credits:50,firstPublishedEventId:'first',firstEventRecentlyPublished:true,previewFingerprint:'fresh',pendingReminders:[],shareEventUrl:'/e/first',hostPageUrl:'/h/host'};

test('welcome card requires server eligibility and first-event evidence rather than a URL flag', async()=>{
  const {controller,container}=fixture('publication');
  assert.equal(await controller.load({...eligible,firstEventRecentlyPublished:false}),false);
  assert.equal(await controller.load({...eligible,firstPublishedEventId:'other'}),false);
  assert.equal(await controller.load({...eligible,state:'needs_event'}),false);
  assert.equal(await controller.load({...eligible,enabled:false}),false);
  assert.equal(await controller.load(eligible),true);
  assert.match(container.innerHTML,/Your first event is live!/);
  assert.match(container.innerHTML,/data-welcome-share/);
});

test('existing hosts have a gift without fake first-event celebration and no repeated claimed offer',async()=>{
  const {controller,container}=fixture();
  assert.equal(await controller.load({...eligible,firstEventRecentlyPublished:false}),true);
  assert.doesNotMatch(container.innerHTML,/Your first event is live/);
  assert.equal(await controller.load({...eligible,state:'claimed'}),false);
  assert.equal(container.hidden,true);
});

test('welcome card keeps included email, US limits, permission boundaries and optional sharing visible',async()=>{
  const {controller,container}=fixture();
  await controller.load(eligible);
  assert.match(container.innerHTML,/Email reminders and event updates are included at no extra cost/);
  assert.match(container.innerHTML,/US recipients/);
  assert.match(container.innerHTML,/Claiming does not turn reminders on or subscribe anyone/);
  assert.match(container.innerHTML,/data-welcome-share/);
  assert.match(container.innerHTML,/data-welcome-host/);
  assert.match(container.innerHTML,/No purchase required/);
});

test('enabled reminders require explicit acknowledgment and untrusted labels are escaped',async()=>{
  const {controller,container}=fixture();
  await controller.load({...eligible,pendingReminderCredits:12,pendingReminders:[{title:'<img src=x onerror=alert(1)>',creditCost:12}]});
  assert.match(container.innerHTML,/data-welcome-claim disabled/);
  assert.match(container.innerHTML,/data-welcome-confirm type="checkbox"/);
  assert.match(container.innerHTML,/Estimated total: 12 credits/);
  assert.doesNotMatch(container.innerHTML,/<img/);
  assert.match(container.innerHTML,/&lt;img/);
});

test('missing verification cannot claim; sharing stays optional and unsafe URLs are omitted',async()=>{
  const {controller,container}=fixture();
  await controller.load({...eligible,state:'needs_verification',missingVerification:['phone'],shareEventUrl:'https://malicious.test/e/first',hostPageUrl:'javascript:alert(1)'});
  assert.doesNotMatch(container.innerHTML,/data-welcome-claim/);
  assert.match(container.innerHTML,/Verify your mobile number/);
  assert.match(container.innerHTML,/settings\/account\?welcome=texts/);
  assert.doesNotMatch(container.innerHTML,/malicious|javascript:/);
});

test('payment success comes from owner-scoped confirmed status, never the return URL alone',()=>{
  const settings=read('public/js/settings.js');
  assert.match(settings,/result\.credited === true/);
  assert.match(settings,/result\.status === 'completed' && result\.credited === true/);
  assert.match(settings,/checkoutConfirmationBusy = !paymentSettled/);
  assert.match(settings,/checkout-sessions\/\$\{encodeURIComponent\(sessionId\)\}/);
  assert.match(settings,/attempt < 8/);
  assert.match(settings,/Payment confirmation is taking a little longer/);
  assert.match(settings,/sge-text-pack:\$\{currentOrganizer\.id\}/);
  assert.doesNotMatch(settings,/MOST POPULAR/);
  assert.match(settings,/Number\.isFinite\(Number\(state\.balance\)\)/);
});

test('refunded checkout returns are settled adjustments, not pending or newly added texts', async () => {
  const settings = read('public/js/settings.js');
  const handler = settings.slice(settings.indexOf('async function showCheckoutReturn()'), settings.indexOf('function showSettings()'));
  for (const status of ['partially_refunded', 'refunded', 'reversed']) {
    const messages = [];
    let reads = 0, reloads = 0;
    const scope = { URLSearchParams, URL,
      window: { location: { search: '?checkout=success&session_id=cs_test_refunded' },
        setTimeout() { throw new Error('A settled adjustment must not poll.'); } },
      settingsElement: () => ({ focus() {} }),
      showCreditResult: message => messages.push(message),
      setCheckoutBusy() {},
      checkoutConfirmationBusy: false,
      api: async () => { reads += 1; return { status, credited: true, credits: 300 }; },
      loadSmsCredits: async () => { reloads += 1; }
    };
    vm.runInNewContext(handler, scope);
    await scope.showCheckoutReturn();
    assert.equal(reads, 1);
    assert.equal(reloads, 1);
    assert.equal(scope.checkoutConfirmationBusy, false);
    assert.match(messages.at(-1), /reflect the adjustment/);
    assert.doesNotMatch(messages.at(-1), /texts added|taking a little longer/);
    if (status === 'partially_refunded') assert.match(messages.at(-1), /partially refunded/);
  }
});

test('welcome styling supports keyboard, small screens and reduced motion',()=>{
  const css=read('public/css/welcome-texts.css');
  assert.match(css,/:focus-visible/);
  assert.match(css,/@media \(max-width:600px\)/);
  assert.match(css,/prefers-reduced-motion:reduce/);
  assert.match(css,/min-height:56px/);
});

test('audience messaging uses destination-usable funds and additional paid credits',()=>{
  const manage=read('public/js/manage.js');
  assert.match(manage,/preview\.usableBalance \?\? preview\.balance/);
  assert.match(manage,/preview\.creditsNeeded \?\?/);
  assert.match(manage,/preview\.textUsableBalance \?\? textBalance/);
  assert.match(manage,/preview\.textCreditsNeeded \?\?/);
  assert.match(manage,/Complimentary texts cover US numbers only/);
});
