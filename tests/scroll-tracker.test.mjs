import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source = await fs.readFile(new URL('../content-scroll-tracker.js', import.meta.url), 'utf8');

// 在 node:vm 里跑追踪脚本：时钟、定时器、滚动高度、scrollY、可见性、readyState 都由用例控制。
function loadTracker({ scrollHeight = 600, innerHeight = 600, readyState = 'complete', restore } = {}) {
  let now = 0;
  let timerId = 0;
  const timers = new Map();
  const sent = [];
  const scrollCalls = [];
  const windowListeners = new Map();
  const documentListeners = new Map();

  const listen = (bucket) => (type, listener) => {
    if (!bucket.has(type)) bucket.set(type, new Set());
    bucket.get(type).add(listener);
  };
  const unlisten = (bucket) => (type, listener) => bucket.get(type)?.delete(listener);
  const dispatch = (bucket, type) => {
    for (const listener of [...(bucket.get(type) || [])]) listener({ type });
  };
  const setTimer = (callback, delay = 0) => {
    timerId += 1;
    timers.set(timerId, { at: now + delay, callback });
    return timerId;
  };

  const page = { scrollHeight };
  const document = {
    hidden: false,
    readyState,
    documentElement: { get scrollHeight() { return page.scrollHeight; } },
    body: { get scrollHeight() { return page.scrollHeight; } },
    addEventListener: listen(documentListeners),
    removeEventListener: unlisten(documentListeners),
  };

  const context = {
    chrome: { runtime: { sendMessage(message) { sent.push(message); } } },
    document,
    location: { href: 'https://example.com/post' },
    innerHeight,
    scrollY: 0,
    __readLaterRestore: restore,
    Date: { now: () => now },
    performance: { now: () => now },
    setTimeout: setTimer,
    clearTimeout: (id) => timers.delete(id),
    requestAnimationFrame: (callback) => setTimer(callback, 16),
    addEventListener: listen(windowListeners),
    removeEventListener: unlisten(windowListeners),
    // 和浏览器一样：目标超出可滚范围就夹到底，scroll 事件在下一帧才派发。
    scrollTo({ top }) {
      scrollCalls.push(top);
      const next = Math.max(0, Math.min(top, page.scrollHeight - innerHeight));
      if (next === context.scrollY) return;
      context.scrollY = next;
      setTimer(() => dispatch(windowListeners, 'scroll'), 16);
    },
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(source, context);

  const nextDue = (until) => {
    let due = null;
    for (const [id, timer] of timers) {
      if (timer.at <= until && (!due || timer.at < due.timer.at)) due = { id, timer };
    }
    return due;
  };

  return {
    page,
    sent,
    scrollCalls,
    get scrollY() { return context.scrollY; },
    percents: () => sent.map((message) => message.percent),
    // 推进假时钟，按到期顺序跑定时器（定时器里还可以再排定时器）。
    advance(ms) {
      const until = now + ms;
      let due;
      while ((due = nextDue(until))) {
        timers.delete(due.id);
        now = due.timer.at;
        due.timer.callback();
      }
      now = until;
    },
    // 用户自己滚：位置立刻变，scroll 事件同步派发（上报在 rAF 里）。
    userScroll(y) {
      context.scrollY = y;
      dispatch(windowListeners, 'scroll');
    },
    resize: () => dispatch(windowListeners, 'resize'),
    hide() {
      document.hidden = true;
      dispatch(documentListeners, 'visibilitychange');
    },
    show() {
      document.hidden = false;
      dispatch(documentListeners, 'visibilitychange');
    },
    // 关标签页时浏览器依次发 beforeunload → visibilitychange → pagehide。
    close() {
      dispatch(windowListeners, 'beforeunload');
      this.hide();
      dispatch(windowListeners, 'pagehide');
    },
  };
}

test('a page that cannot scroll yet is not reported as read', () => {
  const tracker = loadTracker({ scrollHeight: 400 });
  tracker.advance(600);
  assert.equal(tracker.sent.length, 1, '500ms 的初始上报照常发出（带上 scrollY）');
  assert.equal(tracker.sent[0].scrollY, 0);

  tracker.resize();
  tracker.advance(600);
  assert.ok(tracker.sent.length >= 2, 'resize 之后照常上报');
  assert.deepEqual(new Set(tracker.percents()), new Set([0]), `滚不动不等于读完：${tracker.percents()}`);
});

test('progress is measured once a lazy page grows', () => {
  const tracker = loadTracker({ scrollHeight: 400 });
  tracker.advance(600);

  tracker.page.scrollHeight = 2600; // 内容撑开，可滚 2000px
  tracker.advance(1000);
  tracker.userScroll(1000);
  tracker.advance(100);

  assert.equal(tracker.sent.at(-1).percent, 50);
  assert.equal(tracker.sent.at(-1).scrollY, 1000);
  assert.ok(tracker.percents().every((percent) => percent < 100), `${tracker.percents()}`);
});

test('a short page counts as read only after staying visible for a while', () => {
  const tracker = loadTracker({ scrollHeight: 400 });
  tracker.advance(2000);
  tracker.hide();
  assert.ok(tracker.percents().every((percent) => percent < 100), '只看了 2 秒不算读完');

  // 后台挂着的时间不算，回来再看 1.5 秒，累计超过 3 秒。
  tracker.advance(60_000);
  tracker.show();
  tracker.advance(1500);
  tracker.hide();
  const last = tracker.sent.at(-1);
  assert.equal(last.percent, 100);
  assert.equal(last.flush, true, '离开时要立刻落盘');

  const count = tracker.sent.length;
  tracker.close();
  assert.equal(tracker.sent.length, count, '内容没变就不再重复落盘');
});

test('a short page closed quickly or still loading is not marked read', () => {
  const quick = loadTracker({ scrollHeight: 400 });
  quick.advance(1000);
  quick.close();
  assert.ok(quick.percents().every((percent) => percent < 100), `${quick.percents()}`);
  assert.equal(quick.sent.filter((message) => message.flush).length, 1, '离开的三个事件只落一次盘');

  const loading = loadTracker({ scrollHeight: 400, readyState: 'interactive' });
  loading.advance(5000);
  loading.close();
  assert.ok(loading.percents().every((percent) => percent < 100), `${loading.percents()}`);
});

test('a restore clamped by a half-loaded page does not report 100', () => {
  // 上次读到 3000px，这次页面只加载出 1000px：scrollTo 会被夹到底（400px = 100%）。
  const tracker = loadTracker({ scrollHeight: 1000, restore: { scrollY: 3000, percent: 60 } });
  tracker.advance(3000);
  assert.ok(tracker.scrollCalls.length > 0, '应该尝试过恢复位置');
  assert.equal(tracker.scrollY, 400);
  assert.deepEqual(tracker.sent, [], '恢复脚本拉到的位置既不算进度，也不拿夹过的 scrollY 覆盖记录');

  tracker.hide();
  assert.deepEqual(tracker.sent, []);

  // 用户自己滚过之后照常按位置计算。
  tracker.show();
  tracker.page.scrollHeight = 3600;
  tracker.userScroll(1500);
  tracker.advance(100);
  assert.equal(tracker.sent.at(-1).percent, 50);
});

test('a record pinned at 100% without a scroll position does not jump to the bottom', () => {
  const tracker = loadTracker({ scrollHeight: 3000, restore: { scrollY: 0, percent: 100 } });
  tracker.advance(3000);
  assert.deepEqual(tracker.scrollCalls, []);
  assert.equal(tracker.scrollY, 0);
  assert.deepEqual(tracker.percents(), [0]);
});
