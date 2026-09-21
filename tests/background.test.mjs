import test from 'node:test';
import assert from 'node:assert/strict';

// —— 最小 chrome 桩：只覆盖 background.js 用到的 API ——
function createChromeStub({ local = {}, session = {}, activeTab = null } = {}) {
  const listeners = {
    message: [],
    connect: [],
    installed: [],
    startup: [],
    tabUpdated: [],
    tabRemoved: [],
    actionClicked: [],
    menuClicked: [],
    storageChanged: [],
  };
  const writes = [];
  const localStore = { ...local };
  const sessionStore = { ...session };
  const sentMessages = [];
  const injected = [];

  const chrome = {
    runtime: {
      lastError: undefined,
      onMessage: { addListener: (fn) => listeners.message.push(fn) },
      onConnect: { addListener: (fn) => listeners.connect.push(fn) },
      onInstalled: { addListener: (fn) => listeners.installed.push(fn) },
      onStartup: { addListener: (fn) => listeners.startup.push(fn) },
      reload() {},
    },
    storage: {
      local: {
        async get(defaults) {
          const out = {};
          for (const [key, fallback] of Object.entries(defaults)) {
            out[key] = key in localStore ? localStore[key] : fallback;
          }
          return out;
        },
        async set(values) {
          const previous = { ...localStore };
          Object.assign(localStore, values);
          writes.push(structuredClone(values));
          const changes = {};
          for (const [key, value] of Object.entries(values)) {
            changes[key] = { oldValue: previous[key], newValue: value };
          }
          for (const fn of listeners.storageChanged) fn(changes, 'local');
        },
      },
      session: {
        async get(defaults) {
          const out = {};
          for (const [key, fallback] of Object.entries(defaults)) {
            out[key] = key in sessionStore ? sessionStore[key] : fallback;
          }
          return out;
        },
        async set(values) { Object.assign(sessionStore, values); },
      },
      onChanged: { addListener: (fn) => listeners.storageChanged.push(fn) },
    },
    tabs: {
      async query() { return activeTab ? [activeTab] : []; },
      async create() { return { id: 7 }; },
      async sendMessage(tabId, message) { sentMessages.push({ tabId, message }); },
      onUpdated: { addListener: (fn) => listeners.tabUpdated.push(fn) },
      onRemoved: { addListener: (fn) => listeners.tabRemoved.push(fn) },
    },
    scripting: {
      async executeScript(args) { injected.push(args); },
    },
    sidePanel: {
      async open() {},
    },
    action: { onClicked: { addListener: (fn) => listeners.actionClicked.push(fn) } },
    contextMenus: {
      create() {},
      removeAll(callback) { callback?.(); },
      onClicked: { addListener: (fn) => listeners.menuClicked.push(fn) },
    },
  };

  return { chrome, listeners, writes, localStore, sessionStore, sentMessages, injected };
}

let caseId = 0;

// 每个用例都拿一份全新的 background 实例（查询串绕过模块缓存），
// 并且在 import 之前换好全局 chrome 桩。
async function loadBackground(options = {}) {
  const stub = createChromeStub(options);
  globalThis.chrome = stub.chrome;
  caseId += 1;
  await import(`../background.js?case=${caseId}`);
  return stub;
}

// 用 setImmediate 排空微任务链（mock timers 会把 setTimeout 换掉）。
const drain = () => new Promise((resolve) => setImmediate(resolve));

async function sendMessage(stub, message, sender = {}) {
  const listener = stub.listeners.message[0];
  assert.ok(listener, 'background 应该注册了 onMessage 监听');
  const response = await new Promise((resolve) => {
    const keepAlive = listener(message, sender, resolve);
    if (keepAlive !== true) resolve(undefined);
  });
  // 有些分支（进度上报）不通过 sendResponse 回话，等它的异步链跑完再断言。
  await drain();
  await drain();
  return response;
}

// 让 7 号标签页进入「被追踪且已绑定页面」的状态。
async function bindTrackedTab(stub, url) {
  await sendMessage(stub, { type: 'openItem', url, itemId: ITEM.id });
  await stub.listeners.tabUpdated[0](7, { status: 'complete' }, { id: 7, url, windowId: 1 });
}

const ITEM = {
  id: 'item-1',
  title: '示例文章',
  url: 'https://example.com/post',
  normalizedUrl: 'https://example.com/post',
  addedAt: 1_700_000_000_000,
  firstAddedAt: 1_700_000_000_000,
  sourceUrl: 'https://example.com/post',
  sourceTitle: '示例文章',
  sourceDomain: 'example.com',
};

test('list:get 是纯读：不写存储，并且第二次调用不再读存储', async () => {
  const stub = await loadBackground({
    local: { readLaterList: [{ ...ITEM, favicon: 'https://www.google.com/s2/favicons?domain=example.com' }] },
  });

  const first = await sendMessage(stub, { type: 'list:get' });
  assert.equal(first.ok, true);
  assert.equal(stub.writes.length, 0, '读列表不应该触发整表回写');
  assert.equal(first.data.list.length, 1);
  assert.equal(first.data.list[0].favicon, undefined, '遗留的 Google 图标应被清掉');
  assert.equal(first.data.list[0].v, 3, '规范化后应带上形态版本号');

  let reads = 0;
  const originalGet = stub.chrome.storage.local.get;
  stub.chrome.storage.local.get = async (defaults) => {
    reads += 1;
    return originalGet(defaults);
  };
  const second = await sendMessage(stub, { type: 'list:get' });
  assert.equal(reads, 0, '第二次读取应该直接命中内存缓存');
  assert.deepEqual(second.data.list.map((item) => item.id), ['item-1']);
});

test('结构变更立刻落盘，滚动进度先攒着，强制上报才落盘', async () => {
  const stub = await loadBackground({ local: { readLaterList: [{ ...ITEM, v: 3 }] } });

  await sendMessage(stub, { type: 'list:toggleRead', itemId: 'item-1' });
  assert.equal(stub.writes.length, 1, '标记已读必须立刻落盘');

  await bindTrackedTab(stub, ITEM.url);
  const writesAfterBind = stub.writes.length;
  await sendMessage(stub, { type: 'scrollUpdate', percent: 42, scrollY: 1200, pageUrl: ITEM.url }, { tab: { id: 7, windowId: 1 } });
  assert.equal(stub.writes.length, writesAfterBind, '普通进度上报不立刻写盘');

  await sendMessage(stub, { type: 'scrollUpdate', percent: 60, scrollY: 2400, pageUrl: ITEM.url, flush: true }, { tab: { id: 7, windowId: 1 } });
  assert.equal(stub.writes.length, writesAfterBind + 1, '离开页面时的强制上报要立刻落盘');
  const written = stub.writes.at(-1).readLaterList[0];
  assert.equal(written.scrollPercent, 60);
  assert.equal(written.scrollY, 2400);
  assert.ok(written.scrollUpdatedAt > 0);
});

test('滚动进度的合并窗口到点后自动落盘，标签页状态也是攒着写', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const stub = await loadBackground({ local: { readLaterList: [{ ...ITEM, v: 3 }] } });
  await bindTrackedTab(stub, ITEM.url);

  // 追踪状态写 session 也走一个短合并窗口，避免标签页抖动时反复写。
  assert.equal(stub.sessionStore.trackedTabs, undefined);
  t.mock.timers.tick(200);
  await drain();
  assert.equal(stub.sessionStore.trackedTabs[7].itemId, ITEM.id);

  const writesBefore = stub.writes.length;
  await sendMessage(stub, { type: 'scrollUpdate', percent: 30, scrollY: 500, pageUrl: ITEM.url }, { tab: { id: 7 } });
  await drain();
  assert.equal(stub.writes.length, writesBefore, '刚上报时还没到窗口');

  t.mock.timers.tick(1000);
  await drain();
  assert.equal(stub.writes.length, writesBefore + 1, '1 秒后合并窗口关闭，进度落盘');
  assert.equal(stub.writes.at(-1).readLaterList[0].scrollPercent, 30);
  t.mock.timers.reset();
});

test('未知操作返回错误而不是静默失败', async () => {
  const stub = await loadBackground();
  const missing = await sendMessage(stub, { type: 'list:nope' });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /未知操作/);

  const added = await sendMessage(stub, { type: 'list:addCurrent', windowId: 1 });
  assert.equal(added.ok, false);
  assert.match(added.error, /不支持添加/);
});

test('右键添加只写一次存储，并带上写入 stamp', async () => {
  const stub = await loadBackground();
  const listener = stub.listeners.menuClicked[0];
  assert.ok(listener, 'background 应该注册了右键菜单监听');
  await listener(
    { linkUrl: 'https://example.com/a', selectionText: '标题' },
    { id: 3, url: 'https://example.com/', title: '来源页', windowId: 1 },
  );
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(stub.writes.length, 1);
  assert.equal(stub.writes[0].readLaterList.length, 1);
  assert.equal(stub.writes[0].readLaterList[0].title, '标题');
  assert.ok(stub.writes[0].readLaterListStamp, '写入要带 stamp 才能区分外部改动');
});

test('存储被外部改写时丢弃缓存', async () => {
  const stub = await loadBackground({ local: { readLaterList: [{ ...ITEM, v: 3 }] } });
  await sendMessage(stub, { type: 'list:get' });

  // 模拟别的上下文直接写存储：没有 stamp 的变更必须让缓存失效。
  stub.localStore.readLaterList = [{ ...ITEM, id: 'external', v: 3 }];
  for (const fn of stub.listeners.storageChanged) {
    fn({ readLaterList: { oldValue: [ITEM], newValue: stub.localStore.readLaterList } }, 'local');
  }

  const after = await sendMessage(stub, { type: 'list:get' });
  assert.deepEqual(after.data.list.map((item) => item.id), ['external']);
});
