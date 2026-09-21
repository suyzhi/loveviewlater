import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

class FakeElement {
  constructor(tagName, document) {
    this.tagName = tagName;
    this.document = document;
    this.children = [];
    this.dataset = {};
    this.style = { setProperty() {} };
    this.className = '';
    this.textContent = '';
    this.parent = null;
    this.removed = false;
    this.animations = [];
  }

  appendChild(child) {
    child.parent = this;
    this.children.push(child);
    if (child.id) this.document.elementsById.set(child.id, child);
    return child;
  }

  append(...children) {
    children.forEach((child) => this.appendChild(child));
  }

  remove() {
    this.removed = true;
    if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this);
  }

  getBoundingClientRect() {
    return { width: 148, height: 42, left: 0, top: 0, right: 148, bottom: 42 };
  }

  animate(frames = [], options = {}) {
    const animation = {
      frames,
      options,
      cancelled: false,
      finished: Promise.resolve(),
      cancel() { this.cancelled = true; },
    };
    this.animations.push(animation);
    return animation;
  }
}

function createHarness() {
  const timers = new Map();
  let timerId = 0;
  let messageListener;
  const document = {
    hidden: false,
    elementsById: new Map(),
    listeners: new Map(),
    createElement(tagName) { return new FakeElement(tagName, document); },
    getElementById(id) { return this.elementsById.get(id) || null; },
    addEventListener(type, listener) { this.listeners.set(type, listener); },
  };
  document.documentElement = new FakeElement('html', document);
  document.head = new FakeElement('head', document);
  document.documentElement.appendChild(document.head);
  document.body = new FakeElement('body', document);
  document.documentElement.appendChild(document.body);

  const context = {
    chrome: { runtime: { onMessage: { addListener(listener) { messageListener = listener; } } } },
    document,
    innerWidth: 800,
    innerHeight: 600,
    matchMedia: () => ({ matches: false }),
    addEventListener() {},
    setTimeout(callback, delay) {
      const id = ++timerId;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
  };
  context.window = context;

  return {
    context: vm.createContext(context),
    document,
    timers,
    getMessageListener: () => messageListener,
  };
}

function animationLayers(document) {
  const roots = [document.body, document.documentElement].filter(Boolean);
  return roots.flatMap((root) => root.children.filter((child) => child.className === 'read-later-catch-layer'));
}

// 纸张被包在 .read-later-paper-plane 里：外层只跑位移，内层只跑圆角/形变。
function paperOf(layer) {
  const plane = layer.children.find((child) => child.className === 'read-later-paper-plane');
  return plane?.children.find((child) => child.className === 'read-later-paper');
}

test('animation runtime keeps only the newest layer and uses duplicate copy', async () => {
  const source = await fs.readFile(new URL('../content-add-animation.js', import.meta.url), 'utf8');
  const harness = createHarness();
  vm.runInContext(source, harness.context);
  const listener = harness.getMessageListener();
  assert.equal(typeof listener, 'function');

  listener({ type: 'playAddAnimation', animationId: 'first', label: 'First', x: 10, y: 10 });
  const firstLayer = animationLayers(harness.document)[0];
  assert.equal(animationLayers(harness.document).length, 1);
  assert.equal(firstLayer.dataset.animationId, 'first');
  assert.equal(paperOf(firstLayer).children[1].textContent, '收进稍后再看');

  listener({ type: 'playAddAnimation', animationId: 'second', duplicate: true, label: 'Second' });
  const secondLayer = animationLayers(harness.document)[0];
  assert.equal(firstLayer.removed, true);
  assert.equal(animationLayers(harness.document).length, 1);
  assert.equal(secondLayer.dataset.animationId, 'second');
  assert.equal(paperOf(secondLayer).children[1].textContent, '已在列表中 · 已置顶');

  const cleanupTimer = [...harness.timers.values()].find((timer) => timer.delay === 1600);
  assert.ok(cleanupTimer);
  cleanupTimer.callback();
  assert.equal(animationLayers(harness.document).length, 0);
});

test('paper motion stays on compositor-friendly properties', async () => {
  const source = await fs.readFile(new URL('../content-add-animation.js', import.meta.url), 'utf8');
  const harness = createHarness();
  vm.runInContext(source, harness.context);
  harness.getMessageListener()({ type: 'playAddAnimation', animationId: 'perf', label: 'Perf' });

  const plane = animationLayers(harness.document)[0].children[1];
  const paper = paperOf(animationLayers(harness.document)[0]);
  assert.equal(plane.animations.length, 1); // 路径只跑 transform / opacity
  assert.equal(paper.animations.length, 2); // 挤压/拉伸 + 圆角，都在内层
  // 路径动画的每一帧只允许 transform / opacity，避免逐帧重绘。
  const allowed = new Set(['transform', 'opacity', 'offset']);
  for (const frame of plane.animations[0].frames) {
    assert.ok(Object.keys(frame).every((key) => allowed.has(key)), `unexpected key in ${JSON.stringify(frame)}`);
  }
  assert.ok(plane.animations[0].frames.every((frame) => !('filter' in frame) && !('borderRadius' in frame)));
  // 圆角单独放在内层元素上。
  const radiusAnimation = paper.animations.find((animation) => 'borderRadius' in animation.frames[0]);
  assert.ok(radiusAnimation, 'radius animation should live on the inner paper');
  assert.deepEqual(Object.keys(radiusAnimation.frames[0]).filter((key) => key !== 'offset'), ['borderRadius']);
});

test('reduced motion skips sparks and keeps the flat reveal', async () => {
  const source = await fs.readFile(new URL('../content-add-animation.js', import.meta.url), 'utf8');
  const harness = createHarness();
  harness.context.matchMedia = () => ({ matches: true });
  vm.runInContext(source, harness.context);
  harness.getMessageListener()({ type: 'playAddAnimation', animationId: 'reduced', label: 'Reduced' });

  const delays = [...harness.timers.values()].map((timer) => timer.delay);
  assert.deepEqual(delays, [1600]);

  const plane = animationLayers(harness.document)[0].children[1];
  assert.equal(plane.animations[0].options.duration, 460);
});
