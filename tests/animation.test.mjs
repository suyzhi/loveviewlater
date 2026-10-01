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
    this.attributes = {};
    this.style = { setProperty() {} };
    this.className = '';
    this.textContent = '';
    this.parent = null;
    this.removed = false;
    this.animations = [];
    this.shadowRoot = null;
  }

  appendChild(child) {
    child.parent = this;
    this.children.push(child);
    return child;
  }

  append(...children) {
    children.forEach((child) => this.appendChild(child));
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  attachShadow() {
    this.shadowRoot = new FakeElement('#shadow-root', this.document);
    return this.shadowRoot;
  }

  remove() {
    this.removed = true;
    if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this);
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

function flightHosts(document) {
  const roots = [document.body, document.documentElement].filter(Boolean);
  return roots.flatMap((root) => root.children.filter((child) => child.tagName === 'read-later-flight'));
}

function find(node, className) {
  if (!node) return null;
  if (node.className === className) return node;
  for (const child of [...(node.shadowRoot ? [node.shadowRoot] : []), ...node.children]) {
    const hit = find(child, className);
    if (hit) return hit;
  }
  return null;
}

async function loadRuntime({ reducedMotion = false } = {}) {
  const source = await fs.readFile(new URL('../content-add-animation.js', import.meta.url), 'utf8');
  const harness = createHarness();
  if (reducedMotion) harness.context.matchMedia = () => ({ matches: true });
  vm.runInContext(source, harness.context);
  const listener = harness.getMessageListener();
  assert.equal(typeof listener, 'function');
  // 每次播放都必须回话 { played: true }：后台靠它判断要不要注入脚本。
  const play = (message) => {
    let response;
    listener(message, {}, (value) => { response = value; });
    assert.equal(response?.played, true);
  };
  return { harness, play };
}

// translate3d(Xpx, Ypx, 0) → [X, Y]（不用的轴写成裸 0）
function translateOf(frame) {
  const match = /translate3d\((-?[\d.]+)(?:px)?, (-?[\d.]+)(?:px)?/.exec(frame.transform);
  return match ? [Number(match[1]), Number(match[2])] : null;
}

test('animation runtime keeps only the newest card and uses duplicate copy', async () => {
  const { harness, play } = await loadRuntime();

  play({ type: 'playAddAnimation', animationId: 'first', label: 'First', domain: 'example.com', x: 10, y: 10 });
  const [firstHost] = flightHosts(harness.document);
  assert.equal(flightHosts(harness.document).length, 1);
  assert.equal(firstHost.dataset.animationId, 'first');
  assert.equal(find(firstHost, 'title').textContent, 'First');
  assert.equal(find(firstHost, 'meta').textContent, 'example.com');

  play({ type: 'playAddAnimation', animationId: 'second', duplicate: true, label: 'Second' });
  const [secondHost] = flightHosts(harness.document);
  assert.equal(firstHost.removed, true);
  assert.equal(flightHosts(harness.document).length, 1);
  assert.equal(secondHost.dataset.animationId, 'second');
  assert.equal(find(secondHost, 'meta').textContent, '已在抽屉里 · 已置顶');

  const cleanupTimer = [...harness.timers.values()].find((timer) => timer.delay === 1600);
  assert.ok(cleanupTimer);
  cleanupTimer.callback();
  assert.equal(flightHosts(harness.document).length, 0);
});

test('card lives in a shadow root so page CSS cannot restyle it', async () => {
  const { harness, play } = await loadRuntime();
  play({ type: 'playAddAnimation', animationId: 'iso', label: 'Iso' });
  const [host] = flightHosts(harness.document);
  assert.ok(host.shadowRoot, '卡片应该挂在 Shadow DOM 里');
  assert.match(host.attributes.style, /all: initial/);
  const style = host.shadowRoot.children.find((child) => child.tagName === 'style');
  assert.match(style.textContent, /\.title\s*\{[\s\S]*text-overflow: ellipsis/);
  assert.match(style.textContent, /\.meta\s*\{/);
});

test('flight stays on compositor-friendly properties', async () => {
  const { harness, play } = await loadRuntime();
  play({ type: 'playAddAnimation', animationId: 'perf', label: 'Perf', panelOpen: true });
  const [host] = flightHosts(harness.document);

  const allowed = {
    x: ['transform'],
    y: ['transform'],
    card: ['transform', 'opacity'],
    lift: ['opacity'],
    slit: ['transform', 'opacity'],
  };
  for (const [className, props] of Object.entries(allowed)) {
    const node = find(host, className);
    assert.ok(node, `.${className} 应该存在`);
    assert.equal(node.animations.length, 1, `.${className} 只跑一条动画`);
    const keys = new Set([...props, 'offset', 'easing']);
    for (const frame of node.animations[0].frames) {
      assert.ok(Object.keys(frame).every((key) => keys.has(key)), `.${className} 帧里有多余属性：${JSON.stringify(frame)}`);
    }
  }
  // 不转圈：旋转角度始终很小。
  for (const frame of find(host, 'card').animations[0].frames) {
    const turn = /rotate\((-?[\d.]+)deg\)/.exec(frame.transform);
    if (turn) assert.ok(Math.abs(Number(turn[1])) <= 3, frame.transform);
  }
});

test('with the side panel open the card exits through the right edge at row height', async () => {
  const { harness, play } = await loadRuntime();
  play({ type: 'playAddAnimation', animationId: 'open', label: 'Open', panelOpen: true, x: 200, y: 400 });
  const [host] = flightHosts(harness.document);
  const xFrames = find(host, 'x').animations[0].frames;
  const yFrames = find(host, 'y').animations[0].frames;
  // translate 给的是未缩放卡片的左缘；按 0.72 缩放后，可见左缘要整个越过视口右侧。
  const width = parseFloat(find(host, 'card').style.width);
  const visibleLeft = translateOf(xFrames.at(-1))[0] + width / 2 - (width * 0.72) / 2;
  assert.ok(visibleLeft > harness.context.innerWidth, `最终应在视口右侧之外：${visibleLeft}`);
  // 弧线：顶点高于起点和落点。
  const ys = yFrames.map((frame) => translateOf(frame)[1]);
  assert.ok(Math.min(...ys) < ys[0] && Math.min(...ys) < ys.at(-1), `应该先抬起再落下：${ys}`);
  assert.ok(find(host, 'slit'), '侧边栏边缘要亮起一道缝');
});

test('with the side panel closed the card leaves through the top-right corner', async () => {
  const { harness, play } = await loadRuntime();
  play({ type: 'playAddAnimation', animationId: 'closed', label: 'Closed', panelOpen: false, x: 200, y: 400 });
  const [host] = flightHosts(harness.document);
  const lastY = translateOf(find(host, 'y').animations[0].frames.at(-1))[1];
  assert.ok(lastY < 0, `最终应在视口顶部之外：${lastY}`);
  assert.equal(find(host, 'slit'), null);
  assert.equal(find(host, 'card').animations[0].frames.at(-1).opacity, 0);
});

test('reduced motion skips the flight and keeps a short fade', async () => {
  const { harness, play } = await loadRuntime({ reducedMotion: true });
  play({ type: 'playAddAnimation', animationId: 'reduced', label: 'Reduced', panelOpen: true });

  const delays = [...harness.timers.values()].map((timer) => timer.delay);
  assert.deepEqual(delays, [1600]);
  const [host] = flightHosts(harness.document);
  assert.equal(find(host, 'x').animations.length, 0);
  assert.equal(find(host, 'slit'), null);
  assert.equal(find(host, 'card').animations[0].options.duration, 460);
});
