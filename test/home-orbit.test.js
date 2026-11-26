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
  querySelector(key) { return this.items.get(key) || null; }
  querySelectorAll(key) { return this.items.get(key) || []; }
  focus() { this.focused = true; }
  showModal() { this.open = true; }
  close() { this.open = false; this.dispatchEvent(new Event('close')); }
}

const emit = (target, name) => target.dispatchEvent(new Event(name, { cancelable: true }));

function mount({ number = 7, reduced = false } = {}) {
  const doc = new Element();
  const win = new Element();
  const stage = new Element();
  const gallery = new Element();
  const hero = new Element();
  const pause = new Element();
  const motion = new Element();
  const trigger = new Element();
  const close = new Element();
  const dialog = new Element();
  const credits = new Element();
  stage.parentElement = new Element();
  stage.clientWidth = 390;
  stage.clientHeight = 570;
  hero.offsetWidth = 285;
  hero.offsetHeight = 139;
  pause.items.set('span', new Element());
  pause.hidden = true;
  motion.matches = reduced;
  win.matchMedia = () => motion;
  const cards = Array.from({ length: number }, () => {
    const card = new Element();
    const img = new Element();
    img.complete = true;
    img.naturalWidth = 120;
    card.disabled = true;
    card.items.set('img', img);
    card.dataset.orbitRatio = '.8';
    return card;
  });
  gallery.items.set('.home-orbit-photo', cards);
  for (const [key, node] of Object.entries({ stage, gallery, hero, pause, how: trigger, close, dialog })) {
    doc.items.set(`[data-home-orbit-${key}]`, node);
  }
  doc.items.set('.home-orbit-credits', credits);
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
  return { doc, stage, gallery, pause, motion, trigger, close, dialog, credits, cards, queue, tick };
}

test('the same loop respects user pause, frame visibility, keyboard and dialog focus', async () => {
  const { doc, gallery, pause, trigger, close, dialog, credits, cards, queue, tick } = mount();
  assert.equal(queue.size, 1);
  assert.equal(pause.hidden, false);
  assert.equal(pause.attributes.get('aria-label'), 'Pause animation');
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
  assert.equal(emit(trigger, 'click'), false, 'enhanced link opens native dialog without changing URL');
  assert.equal(dialog.open, true);
  assert.equal(close.focused, true);
  assert.equal(queue.size, 0);
  emit(close, 'click');
  assert.equal(dialog.open, false);
  assert.equal(trigger.focused, true);
  assert.equal(queue.size, 1);

  emit(pause, 'click');
  assert.equal(pause.attributes.get('aria-label'), 'Play animation');
  assert.equal(queue.size, 0);
  const pausedAt = cards[2].props.get('--ho-x');
  emit(cards[1], 'click');
  emit(cards[3], 'click');
  tick(40);
  assert.notEqual(cards[2].props.get('--ho-x'), pausedAt);
  tick(200);
  assert.equal(queue.size, 0);
  assert.equal(cards[2].props.get('--ho-x'), pausedAt, 'one rotation only when base animation is paused');
});

test('reduced motion is static until a deliberate no-motion step; no gallery still keeps dialog functional', () => {
  const { stage, cards, motion, pause, queue } = mount({ reduced: true });
  assert.equal(stage.parentElement.classes.has('is-orbit-enhanced'), true);
  assert.equal(queue.size, 0);
  assert.equal(pause.hidden, true);
  const before = cards[0].props.get('--ho-x');
  emit(cards[0], 'click');
  assert.notEqual(cards[0].props.get('--ho-x'), before);
  assert.equal(queue.size, 0);
  motion.matches = false;
  emit(motion, 'change');
  assert.equal(pause.hidden, false);
  assert.equal(queue.size, 0, 'changing the system setting should not unexpectedly start movement');
  emit(pause, 'click');
  assert.equal(queue.size, 1);
  emit(cards[4], 'click');
  motion.matches = true;
  emit(motion, 'change');
  assert.equal(queue.size, 0);

  for (const number of [0, 1]) {
    const idle = mount({ number });
    assert.equal(idle.stage.parentElement.classes.has('is-orbit-enhanced'), false);
    assert.equal(idle.pause.hidden, true);
    assert.equal(idle.queue.size, 0);
    emit(idle.trigger, 'click');
    assert.equal(idle.dialog.open, true);
  }
});
