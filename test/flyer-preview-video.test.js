const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { renderEventBackground } = require('../src/lib/event-background-render');

const source = relative => fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');

function publicAppearance(key) {
  const { bgClass, bgEffect, fxMedia, fxVeil } = renderEventBackground(key);
  return { bgClass, bgEffect, fxMedia, fxVeil };
}

function chooseFixture({ phone = true, reduced = false, saveData = false, hidden = false, key = 'disco' } = {}) {
  const js = source('public/js/flyer-preview.js');
  const prior = publicAppearance('plaster');
  const next = publicAppearance(key);
  const logs = [];
  let resolveSave;
  let rejectSave;
  const response = new Promise((resolve, reject) => { resolveSave = resolve; rejectSave = reject; });
  const context = {
    options: [{ key, label: key, active: true, appearance: next }],
    currentKey: 'plaster', savingVibe: false, loading: false,
    payload: { preview: { backgroundTheme: 'plaster', appearance: prior } },
    motion: { matches: reduced }, navigator: { connection: { saveData } }, document: { hidden },
    window: {
      matchMedia: () => ({ matches: phone }),
      SGFlyerPreviewBackground: { apply(appearance, opts) { logs.push(['apply', appearance.bgClass, opts?.eagerVideo === true]); return true; } }
    },
    requestVibe(url) { logs.push(['request', url]); return response; },
    setSaving(value) { context.savingVibe = value; },
    changeSelection(key) { context.currentKey = key; },
    currentLabel() { return key; },
    announce(text, error) { if (error) logs.push(['error', text]); },
    savePositionAndReload(key) { logs.push(['reload', key]); }
  };
  const choose = vm.runInNewContext(`${js.slice(js.indexOf('    function applyLook('), js.indexOf("    retry.addEventListener('click', populate);"))}\nchoose`, context);
  return { run: () => choose(key), logs, context, finish: () => resolveSave({ ok: true, backgroundTheme: key, appearance: next }), rejectSave };
}

test('a phone starts one selected video before the write and keeps it on success', async () => {
  const f = chooseFixture();
  const done = f.run();
  assert.deepEqual(f.logs, [['apply', 'fx-disco', true], ['request', '/api/flyer-preview/look']]);
  assert.equal(f.context.currentKey, 'plaster', 'the UI does not report a selection saved yet');
  f.finish();
  await done;
  assert.equal(f.logs.length, 2, 'saving does not recreate the video or reload the page');
  assert.equal(f.context.payload.preview.backgroundTheme, 'disco');
  assert.equal(f.context.payload.preview.appearance.bgClass, 'fx-disco');
});

test('desktop, stills, reduced motion and data-saving settings do not start early', async () => {
  for (const settings of [{ phone: false }, { reduced: true }, { saveData: true }, { hidden: true }, { key: 'aurora' }]) {
    const f = chooseFixture(settings);
    const done = f.run();
    assert.deepEqual(f.logs, [['request', '/api/flyer-preview/look']]);
    f.finish();
    await done;
    assert.deepEqual(f.logs[1], ['apply', settings.key ? 'bg-aurora' : 'fx-disco', false]);
  }
});

test('a rejected save restores the prior background and announces the error', async () => {
  const f = chooseFixture();
  const done = f.run();
  f.rejectSave(Object.assign(new Error('This preview can no longer be changed.'), { status: 409, code: 'preview_not_editable' }));
  await done;
  assert.deepEqual(f.logs, [
    ['apply', 'fx-disco', true], ['request', '/api/flyer-preview/look'],
    ['apply', 'bg-plaster', false], ['error', 'This preview can no longer be changed.']
  ]);
  assert.equal(f.context.payload.preview.backgroundTheme, 'plaster');
  assert.equal(f.context.savingVibe, false);
});

test('eager video selects one responsive source while retaining inline muted playback', () => {
  const js = source('public/js/public-event.js');
  const attributes = node => ({ attrs: {}, getAttribute(key) { return this.attrs[key] ?? null; },
    setAttribute(key, value) { this.attrs[key] = value; }, hasAttribute(key) { return key in this.attrs; }, ...node });
  const clip = publicAppearance('disco').fxMedia;
  const sourceNodes = Array.from(clip.matchAll(/<source( media="([^"]+)")? src="([^"]+)" type="video\/mp4">/g), m =>
    attributes({ localName: 'source', attrs: { type: 'video/mp4', src: m[3], ...(m[2] ? { media: m[2] } : {}) } }));
  const clipNode = attributes({ className: 'fx-video-media', dataset: { effectTheme: 'disco' },
    attrs: { poster: clip.match(/poster="([^"]+)"/)[1] }, children: sourceNodes });
  function build(phone, eager) {
    const context = {
      URL, readEffectElement: () => clipNode, matchMedia: () => ({ matches: phone }),
      document: { createElement: name => attributes({ localName: name, dataset: {}, children: [], appendChild(child) { this.children.push(child); } }) }
    };
    return vm.runInNewContext(`${js.slice(js.indexOf('  function readEffectUrl('), js.indexOf('  window.SGFlyerPreviewBackground'))}\nbuildEffectVideo`, context)(clip, 'disco', eager);
  }
  const phone = build(true, true);
  assert.equal(phone.autoplay, true);
  assert.equal(phone.preload, 'auto');
  assert.equal(phone.muted, true);
  assert.equal(phone.hasAttribute('playsinline'), true);
  assert.match(phone.src, /w_800/);
  assert.equal(phone.children.length, 0, 'no second video source is loaded on a phone');
  assert.match(build(false, true).src, /w_1280/);
  const desktop = build(false, false);
  assert.equal(desktop.src, undefined);
  assert.equal(desktop.children.length, 2);
  assert.equal(desktop.preload, 'none');
});
