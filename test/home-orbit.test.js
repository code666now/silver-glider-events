const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');
const { measureOrbit, photoDimensions, orbitFrame, boostOffset, mountHomeOrbit } = require('../public/js/home-orbit');

const turn = 2 * Math.PI;
const near = (actual, expected, epsilon = .00001) => assert.ok(Math.abs(actual - expected) < epsilon, `${actual} ≠ ${expected}`);

test('all seven seed images, including the Make-Out Room poster, are WebPs within the homepage budget', async () => {
  const seed = fs.readFileSync(path.join(__dirname, '../src/db/migrations/097_seed_homepage_photography.sql'), 'utf8');
  const photos = [...seed.matchAll(/'(\/images\/homepage-photography\/[\w-]+\.webp)', (\d+), (\d+), (\d+)\)/g)];
  assert.equal(photos.length, 7);
  assert.match(photos[4][1], /disco-ball\.webp$/);
  assert.match(photos.at(-1)[1], /hqdr-make-out-room\.webp$/);
  let totalBytes = 0;
  for (const [index, [, url, width, height, order]] of photos.entries()) {
    const file = path.join(__dirname, '../public', url);
    totalBytes += fs.statSync(file).size;
    const image = await sharp(file).metadata();
    assert.deepEqual([image.format, image.width, image.height, Number(order)], ['webp', Number(width), Number(height), index]);
  }
  assert.ok(totalBytes < 450 * 1024, `Initial gallery images total ${totalBytes} bytes`);
});

test('the responsive photo wheel keeps native photo proportions and one common circular phase', () => {
  const landscape = measureOrbit(1440, 820, 490, 155);
  const phone = measureOrbit(390, 570, 288, 139);
  assert.equal(landscape.mobile, false);
  assert.equal(phone.mobile, true);
  assert.ok(landscape.size > phone.size);
  const portrait = photoDimensions(phone.size, .62);
  near(portrait.width / portrait.height, .62);
  const wide = photoDimensions(phone.size, 1.58);
  near(wide.width / wide.height, 1.58);
  assert.deepEqual(photoDimensions(100, NaN), { width: 100, height: 100 });

  const start = orbitFrame(.42, 0, 7, phone, portrait);
  const next = orbitFrame(.42 + turn / 7, 0, 7, phone, portrait);
  assert.deepEqual(next, orbitFrame(.42, 1, 7, phone, portrait));
  near((start.x / phone.rx) ** 2 + (start.y / (phone.ry * .64)) ** 2, 1);
  assert.ok(Math.abs(start.focusX) <= Math.abs(start.x));
  assert.ok(Math.abs(start.focusY) <= Math.abs(start.y));
  const foreground = orbitFrame(Math.PI / 2, 0, 7, phone, portrait);
  const background = orbitFrame(-Math.PI / 2, 0, 7, phone, portrait);
  assert.ok(foreground.depth > background.depth && foreground.scale > background.scale && foreground.brightness > background.brightness);
});

test('a click adds exactly one eased rotation and blends back to the same wheel speed', () => {
  near(boostOffset(-50), 0);
  near(boostOffset(1450), Math.PI);
  near(boostOffset(2900), turn);
  near(boostOffset(4000), turn);
  assert.ok(boostOffset(1) - boostOffset(0) < .000001);
  assert.ok(boostOffset(2900) - boostOffset(2899) < .000001);
  assert.ok(boostOffset(1451) - boostOffset(1450) > .004);
});

class Element extends EventTarget {
  constructor() {
    super();
    this.attributes = new Map();
    this.props = new Map();
    this.classes = new Set();
    this.items = new Map();
    this.dataset = {};
    this.style = { setProperty: (key, value) => this.props.set(key, value) };
    this.classList = { add: name => this.classes.add(name) };
  }
  setAttribute(key, value) { this.attributes.set(key, value); }
  getAttribute(key) { return this.attributes.get(key); }
  querySelector(key) { return this.items.get(key) || null; }
  querySelectorAll(key) { return this.items.get(key) || []; }
}

const emit = (target, name) => target.dispatchEvent(new Event(name, { cancelable: true }));

const storage = () => {
  const values = new Map();
  return { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) };
};

function mount({ number = 7, reduced = false, settings = false, store = storage(), sessionStore, search = '' } = {}) {
  const doc = new Element();
  const win = new Element();
  const stage = new Element();
  const gallery = new Element();
  const hero = new Element();
  const motion = new Element();
  const credits = new Element();
  const panel = new Element();
  const input = new Element();
  const note = new Element();
  const homeLink = new Element();
  stage.parentElement = new Element();
  stage.clientWidth = 390;
  stage.clientHeight = 570;
  hero.offsetWidth = 285;
  hero.offsetHeight = 139;
  panel.hidden = true;
  note.textContent = 'You can still step through photos with animation off.';
  homeLink.href = '/';
  motion.matches = reduced;
  win.matchMedia = () => motion;
  win.localStorage = store;
  win.sessionStorage = sessionStore;
  win.location = { search };
  const cards = Array.from({ length: number }, () => {
    const card = new Element();
    const img = new Element();
    img.complete = true;
    img.naturalWidth = 120;
    card.disabled = true;
    card.setAttribute('aria-label', 'Spin photo wheel — Example photo');
    card.items.set('img', img);
    card.dataset.orbitRatio = '.8';
    return card;
  });
  gallery.items.set('.home-orbit-photo', cards);
  if (settings) {
    doc.items.set('[data-home-motion-controls]', panel);
    doc.items.set('[data-home-orbit-motion]', input);
    doc.items.set('[data-home-motion-note]', note);
    doc.items.set('.home-how-back', homeLink);
  } else {
    for (const [key, node] of Object.entries({ stage, gallery, hero })) doc.items.set(`[data-home-orbit-${key}]`, node);
    doc.items.set('.home-orbit-credits', credits);
  }
  let latest = 0;
  let now = 0;
  const queue = new Map();
  win.requestAnimationFrame = fn => { queue.set(++latest, fn); return latest; };
  win.cancelAnimationFrame = id => queue.delete(id);
  const tick = (count = 1) => {
    for (let i = 0; i < count; i++) {
      now += 20;
      const callbacks = [...queue.values()];
      queue.clear();
      assert.ok(callbacks.length <= 1, 'avoid separate RAF loops for different photos');
      callbacks.forEach(fn => fn(now));
    }
  };
  mountHomeOrbit(doc, win);
  return { doc, win, stage, gallery, motion, credits, cards, queue, tick, panel, input, note, homeLink };
}

test('the same loop respects visibility, keyboard focus and open credits; photo activation still boosts it', async () => {
  const { doc, gallery, credits, cards, queue, tick } = mount();
  assert.equal(queue.size, 1);
  assert.ok(cards.every(card => !card.disabled && card.props.has('--ho-x')));
  const initial = cards[2].props.get('--ho-x');
  tick(6);
  assert.notEqual(cards[2].props.get('--ho-x'), initial);

  gallery.items.set(':focus-visible', cards[0]);
  emit(gallery, 'focusin');
  assert.equal(queue.size, 0);
  gallery.items.delete(':focus-visible');
  emit(gallery, 'focusout');
  await Promise.resolve();
  assert.equal(queue.size, 1);

  for (const [element, property, event] of [[doc, 'hidden', 'visibilitychange'], [credits, 'open', 'toggle']]) {
    element[property] = true;
    emit(element, event);
    assert.equal(queue.size, 0);
    element[property] = false;
    emit(element, event);
    assert.equal(queue.size, 1);
  }
  const before = cards[2].props.get('--ho-x');
  emit(cards[1], 'click');
  tick(40);
  assert.notEqual(cards[2].props.get('--ho-x'), before);
  assert.equal(queue.size, 1);
});

test('the standalone motion setting persists on return and cancels animation in an open homepage tab', () => {
  const store = storage();
  const { panel, input } = mount({ settings: true, store });
  assert.equal(panel.hidden, false);
  assert.equal(input.checked, true);
  const open = mount({ store });
  emit(open.cards[0], 'click');
  assert.equal(open.queue.size, 1);
  input.checked = false;
  emit(input, 'change');
  open.win.dispatchEvent(Object.assign(new Event('storage'), { key: 'sge-home-photo-motion' }));
  assert.equal(open.queue.size, 0);
  const loaded = mount({ store });
  assert.equal(loaded.queue.size, 0);
  assert.match(loaded.cards[0].getAttribute('aria-label'), /^Step photo wheel/);
  const still = loaded.cards[2].props.get('--ho-x');
  emit(loaded.cards[1], 'click');
  assert.notEqual(loaded.cards[2].props.get('--ho-x'), still);
  assert.equal(loaded.queue.size, 0, 'a deliberate step does not animate when disabled');
  input.checked = true;
  emit(input, 'change');
  loaded.win.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
  assert.equal(loaded.queue.size, 1, 'browser Back reads the latest setting');
  assert.match(loaded.cards[0].getAttribute('aria-label'), /^Spin photo wheel/);
});

test('a direct return link still turns off motion when storage is blocked or a stale local value wins', () => {
  const unavailable = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
  const { input, homeLink, note } = mount({ settings: true, store: unavailable });
  input.checked = false;
  emit(input, 'change');
  assert.equal(homeLink.href, '/?photo-motion=off');
  assert.match(note.textContent, /Back to homepage/);
  assert.equal(mount({ store: unavailable, search: '?photo-motion=off' }).queue.size, 0);
  const readOnly = { ...unavailable, getItem: () => 'on' };
  const mixed = mount({ settings: true, store: readOnly, sessionStore: storage() });
  mixed.input.checked = false;
  emit(mixed.input, 'change');
  assert.equal(mixed.homeLink.href, '/?photo-motion=off');
});

test('device Reduce Motion wins and empty or single-photo galleries remain static', () => {
  const { stage, cards, motion, queue } = mount({ reduced: true });
  assert.equal(stage.parentElement.classes.has('is-orbit-enhanced'), true);
  assert.equal(queue.size, 0);
  const before = cards[0].props.get('--ho-x');
  emit(cards[0], 'click');
  assert.notEqual(cards[0].props.get('--ho-x'), before);
  assert.equal(queue.size, 0);
  motion.matches = false;
  emit(motion, 'change');
  assert.equal(queue.size, 0, 'changing the system setting should not unexpectedly start movement');

  const settings = mount({ settings: true, reduced: true });
  assert.equal(settings.input.disabled, true);
  assert.equal(settings.input.checked, false);
  assert.match(settings.note.textContent, /Reduce Motion/);
  settings.motion.matches = false;
  emit(settings.motion, 'change');
  assert.equal(settings.input.disabled, false);
  assert.equal(settings.input.checked, true);

  for (const number of [0, 1]) {
    const idle = mount({ number });
    assert.equal(idle.stage.parentElement.classes.has('is-orbit-enhanced'), false);
    assert.equal(idle.queue.size, 0);
  }
});
