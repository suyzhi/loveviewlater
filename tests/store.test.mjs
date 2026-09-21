import test from 'node:test';
import assert from 'node:assert/strict';

import { createListStore } from '../core.mjs';

function createFakeTimers() {
  let nextId = 1;
  const timers = new Map();
  return {
    setTimer(callback, delay) {
      const id = nextId++;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimer(id) { timers.delete(id); },
    fire() {
      for (const [id, timer] of [...timers]) {
        timers.delete(id);
        timer.callback();
      }
    },
    get pending() { return timers.size; },
    get delays() { return [...timers.values()].map((timer) => timer.delay); },
  };
}

function createHarness({ initial = [], failWrite = false } = {}) {
  const timers = createFakeTimers();
  const state = { stored: null, reads: 0, writes: [] };
  let shouldFail = failWrite;
  const store = createListStore({
    read: async () => {
      state.reads += 1;
      return initial;
    },
    write: async (list) => {
      if (shouldFail) throw new Error('quota exceeded');
      state.writes.push(structuredClone(list));
      state.stored = list;
    },
    flushDelayMs: 1000,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  return {
    store,
    timers,
    state,
    failNextWrites(value) { shouldFail = value; },
  };
}

test('get 只读一次存储，后续命中内存', async () => {
  const { store, state } = createHarness({ initial: [{ id: 'a' }] });
  assert.deepEqual(await store.get(), [{ id: 'a' }]);
  assert.deepEqual(await store.get(), [{ id: 'a' }]);
  assert.equal(state.reads, 1);
});

test('并发首次读取只读一次存储', async () => {
  const { store, state } = createHarness({ initial: [{ id: 'a' }] });
  const [first, second] = await Promise.all([store.get(), store.get()]);
  assert.equal(state.reads, 1);
  assert.equal(first, second, '两次拿到的应该是同一个数组');
});

test('deferred 提交把窗口内的多次修改合并成一次写盘', async () => {
  const { store, timers, state } = createHarness();
  const list = [{ id: 'a', scrollPercent: 1 }];
  await store.commit(list, { deferred: true });
  list[0].scrollPercent = 5;
  await store.commit(list, { deferred: true });
  list[0].scrollPercent = 9;
  await store.commit(list, { deferred: true });

  assert.equal(state.writes.length, 0, '窗口没到不应该写盘');
  assert.equal(timers.pending, 1, '只会挂一个定时器');
  assert.deepEqual(timers.delays, [1000]);

  timers.fire();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.writes.length, 1);
  assert.equal(state.writes[0][0].scrollPercent, 9, '落盘的是最新状态');
});

test('非延迟提交立刻写盘，并且会取消待写的窗口', async () => {
  const { store, timers, state } = createHarness();
  await store.commit([{ id: 'a' }], { deferred: true });
  assert.equal(timers.pending, 1);
  await store.commit([{ id: 'b' }]);
  assert.equal(timers.pending, 0, '立刻落盘要顺手取消合并窗口');
  assert.equal(state.writes.length, 1);
  assert.deepEqual(state.writes[0], [{ id: 'b' }]);
});

test('没有脏数据时 flush 不写盘', async () => {
  const { store } = createHarness();
  await store.get();
  assert.equal(await store.flush(), false);
});

test('写失败时保留脏标记，下一次 flush 重试', async () => {
  const { store, state, failNextWrites } = createHarness({ failWrite: true });
  await assert.rejects(() => store.commit([{ id: 'a' }]), /quota/);
  assert.equal(store.dirty, true, '失败后必须还能重试');
  assert.equal(state.writes.length, 0);

  failNextWrites(false);
  assert.equal(await store.flush(), true);
  assert.equal(state.writes.length, 1);
  assert.equal(store.dirty, false);
});

test('invalidate 之后重新从存储载入', async () => {
  const { store, state } = createHarness({ initial: [{ id: 'a' }] });
  await store.get();
  store.invalidate();
  assert.equal(store.cached, null);
  await store.get();
  assert.equal(state.reads, 2);
});
