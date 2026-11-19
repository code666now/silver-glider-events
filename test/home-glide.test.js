const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const script = fs.readFileSync(path.join(__dirname, '../public/js/home-glide.js'), 'utf8');

function element() {
  const listeners = new Map();
  return {
    addEventListener(name, fn) { listeners.set(name, fn); },
    fire(name, event = {}) { listeners.get(name)?.(event); }
  };
}

function fixture({ reduced = false, withObserver = true } = {}) {
  const faces = Array.from({ length: 5 }, element);
  const lastFace = faces[4];
  const replay = Object.assign(element(), { hidden: true });
  const state = { playing: false, starts: 0, disconnects: 0, observed: false };
  const row = Object.assign(element(), {
    clientWidth: 340,
    offsetWidth: 340,
    dataset: {},
    querySelectorAll() { return faces; },
    style: { setProperty(name, value) { state[name] = value; } },
    classList: {
      add() { state.playing = true; state.starts++; },
      remove() { state.playing = false; }
    }
  });
  const motion = Object.assign(element(), { matches: reduced });
  let dispatchIntersection;
  class Observer {
    constructor(callback, options) {
      dispatchIntersection = callback;
      state.threshold = options.threshold;
    }
    observe(target) { state.observed = target === row; }
    disconnect() { state.disconnects++; }
  }

  vm.runInNewContext(script, {
    document: { querySelector: (selector) => selector === '.home-faces' ? row : replay },
    window: { matchMedia: () => motion, ...(withObserver ? { IntersectionObserver: Observer } : {}) },
    IntersectionObserver: Observer
  });
  return {
    row, replay, lastFace, state,
    enter(ratio) { dispatchIntersection?.([{ isIntersecting: ratio > 0, intersectionRatio: ratio }]); },
    reduce(value) { motion.matches = value; motion.fire('change'); }
  };
}

test('fly-over starts at 80% visibility once and ends after the last glow', () => {
  const { enter, lastFace, state } = fixture();
  assert.equal(state.observed, true);
  assert.equal(state.threshold, 0.8);
  enter(0.79);
  assert.equal(state.starts, 0);
  enter(0.8);
  assert.equal(state.starts, 1);
  assert.equal(state.disconnects, 1);
  enter(1); // An observer callback could have already been queued before disconnect.
  lastFace.fire('animationend', { animationName: 'home-face-hop' });
  assert.equal(state.playing, true);
  lastFace.fire('animationend', { animationName: 'home-face-light' });
  assert.equal(state.playing, false);
  assert.equal(state.starts, 1);
});

test('both replay options work without IntersectionObserver', () => {
  const { replay, row, state } = fixture({ withObserver: false });
  assert.equal(replay.hidden, false);
  row.fire('click');
  row.clientWidth = 390;
  replay.fire('click');
  assert.equal(state.starts, 2);
  assert.equal(state['--glide-w'], '390px');
  assert.equal(state.observed, false);
});

test('Reduce Motion clears a flight and switching it off does not restart it', () => {
  const { enter, reduce, replay, row, state } = fixture();
  enter(1);
  reduce(true);
  assert.equal(state.playing, false);
  assert.equal(replay.hidden, true);
  assert.equal(row.dataset.glideReady, undefined);
  row.fire('click');
  reduce(false);
  enter(1);
  assert.equal(state.starts, 1);
  assert.equal(replay.hidden, false);
  replay.fire('click');
  assert.equal(state.starts, 2);
});

test('initial Reduce Motion keeps the illustration still and replay hidden', () => {
  const { enter, replay, row, state } = fixture({ reduced: true });
  enter(1);
  row.fire('click');
  replay.fire('click');
  assert.equal(state.observed, false);
  assert.equal(replay.hidden, true);
  assert.equal(state.starts, 0);
});
