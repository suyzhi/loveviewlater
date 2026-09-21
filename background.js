import {
  RANDOM_PICK_COOLDOWN_MS,
  STORAGE_KEY,
  addOrBumpItem,
  createListStore,
  createSerialExecutor,
  getDomain,
  isSupportedUrl,
  normalizeStoredList,
  normalizeUrl,
  prepareImport,
  urlsReferToSameDocument,
} from './core.mjs';
import {
  CONTEXT_TTL_MS,
  PANEL_CLOSE_GRACE_MS,
  PROGRESS_FLUSH_DELAY_MS,
  TRACKED_TABS_FLUSH_DELAY_MS,
} from './constants.mjs';

const WRITE_STAMP_KEY = 'readLaterListStamp';
const MAX_PENDING_CONTEXTS = 50;

const trackedTabs = new Map();
const pendingContextByTab = new Map();
const panelStates = new Map();
const runSerially = createSerialExecutor();

// 内存里持有权威列表，写盘按窗口合并：滚动进度每 400ms 上报一次，
// 没必要每次都把整张表反序列化再写回去（1000 条约 380KB）。
const listStore = createListStore({
  read: readListFromStorage,
  write: writeListToStorage,
  flushDelayMs: PROGRESS_FLUSH_DELAY_MS,
});

let listWriteStamp = null;

async function readListFromStorage() {
  const result = await chrome.storage.local.get({ [STORAGE_KEY]: [] });
  return normalizeStoredList(result[STORAGE_KEY]);
}

async function writeListToStorage(list) {
  listWriteStamp = crypto.randomUUID();
  await chrome.storage.local.set({ [STORAGE_KEY]: list, [WRITE_STAMP_KEY]: listWriteStamp });
}

// 只有别的上下文（开发者工具、另一份安装）改了存储才需要丢掉缓存重读；
// 自己的写入带 stamp，可以直接认出来。
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local' || !changes[STORAGE_KEY]) return;
  const stamp = changes[WRITE_STAMP_KEY]?.newValue;
  if (stamp !== undefined && stamp === listWriteStamp) return;
  listStore.invalidate();
});

function normalizeTrackedState(state) {
  if (typeof state === 'string') return { itemId: state };
  return state && typeof state === 'object' ? state : {};
}

async function initTrackedTabs() {
  try {
    const result = await chrome.storage.session.get({ trackedTabs: {} });
    for (const [tabId, state] of Object.entries(result.trackedTabs)) {
      trackedTabs.set(Number(tabId), normalizeTrackedState(state));
    }
  } catch {
    // 会话存储不可用时仅影响跨 Service Worker 的追踪恢复。
  }
}

const trackedTabsReady = initTrackedTabs();

let trackedPersistTimer = null;

function scheduleTrackedTabsPersist() {
  if (trackedPersistTimer !== null) return;
  trackedPersistTimer = setTimeout(() => {
    trackedPersistTimer = null;
    chrome.storage.session.set({ trackedTabs: Object.fromEntries(trackedTabs) }).catch(() => {});
  }, TRACKED_TABS_FLUSH_DELAY_MS);
}

async function saveTrackedTab(tabId, state) {
  if (tabId === undefined) return;
  await trackedTabsReady;
  trackedTabs.set(tabId, normalizeTrackedState(state));
  scheduleTrackedTabsPersist();
}

async function removeTrackedTab(tabId) {
  await trackedTabsReady;
  if (!trackedTabs.delete(tabId)) return;
  scheduleTrackedTabsPersist();
}

function prunePendingContexts() {
  const now = Date.now();
  for (const [tabId, context] of pendingContextByTab.entries()) {
    if (now - context.createdAt > CONTEXT_TTL_MS) pendingContextByTab.delete(tabId);
  }
  // 兜底：极端情况下（大量标签页从未右键）也不让 Map 无限增长。
  while (pendingContextByTab.size > MAX_PENDING_CONTEXTS) {
    const oldest = pendingContextByTab.keys().next().value;
    pendingContextByTab.delete(oldest);
  }
}

function buildSource(tab, fallbackUrl) {
  const candidate = tab?.url || fallbackUrl || '';
  const sourceUrl = isSupportedUrl(candidate) ? new URL(candidate).toString() : '';
  return {
    sourceUrl,
    sourceTitle: tab?.title || sourceUrl,
    sourceDomain: getDomain(sourceUrl),
  };
}

function makeFallbackFavicon(tab, targetUrl) {
  if (!tab?.favIconUrl || !isSupportedUrl(tab.url) || !isSupportedUrl(targetUrl)) return undefined;
  try {
    return new URL(tab.url).origin === new URL(targetUrl).origin ? tab.favIconUrl : undefined;
  } catch {
    return undefined;
  }
}

function buildItem({ url, title, tab, source }) {
  const now = Date.now();
  const item = {
    id: crypto.randomUUID(),
    title: title || url,
    url: new URL(url).toString(),
    normalizedUrl: normalizeUrl(url),
    addedAt: now,
    firstAddedAt: now,
    ...source,
  };
  const favicon = makeFallbackFavicon(tab, url);
  if (favicon) item.favicon = favicon;
  return item;
}

// persist: 'now' 立刻落盘（结构变化丢不起），'deferred' 合并到下一个窗口（进度）。
function mutateList(mutator, { persist = 'now' } = {}) {
  return runSerially(async () => {
    const list = await listStore.get();
    const outcome = (await mutator(list)) || {};
    const nextList = outcome.list || list;
    await listStore.commit(nextList, { deferred: persist === 'deferred' });
    return { ...outcome, list: nextList };
  });
}

function broadcastPanel(message) {
  for (const state of panelStates.values()) {
    try {
      state.port.postMessage(message);
    } catch {
      // 面板可能正在关闭。
    }
  }
}

function broadcastList(outcome, { feedback, originWindowId = null } = {}) {
  broadcastPanel({ type: 'listUpdated', list: outcome.list, feedback, originWindowId });
}

// 页面内的点击监听只在侧边栏打开时才需要：否则每次点击都会把 Service Worker 叫醒。
function setWindowClickWatch(windowId, enabled) {
  if (!Number.isInteger(windowId)) return;
  chrome.tabs.query({ windowId }).then((tabs) => {
    for (const tab of tabs) {
      if (tab.id === undefined) continue;
      chrome.tabs.sendMessage(tab.id, { type: 'watchPageClicks', enabled }).catch(() => {});
    }
  }).catch(() => {});
}

// 动画脚本按需注入：不再给所有站点常驻一份解析成本，也顺带解决「脚本还没加载」的时序问题。
async function playAddAnimation(tabId, payload) {
  if (tabId === undefined) return;
  const message = { type: 'playAddAnimation', animationId: crypto.randomUUID(), ...payload };
  try {
    await chrome.tabs.sendMessage(tabId, message);
    return;
  } catch {
    // 落下去注入再补发一次。
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content-add-animation.js'] });
    await chrome.tabs.sendMessage(tabId, message);
  } catch {
    // 内部页或未获授权页面不支持网页内动画，保存仍然成功。
  }
}

async function openTrackedItem({ id, url, scrollY = 0, scrollPercent = 0 }) {
  if (!isSupportedUrl(url)) throw new Error('页面地址无效');
  const tab = await chrome.tabs.create({ url, active: true });
  if (!tab?.id) throw new Error('无法打开页面');
  await saveTrackedTab(tab.id, {
    itemId: id,
    expectedUrl: url,
    boundUrl: null,
    restoreScrollY: scrollY,
    restorePercent: scrollPercent,
  });
  return tab;
}

function closePanel(windowId) {
  const state = panelStates.get(windowId);
  if (!state || state.closing) return;
  state.closing = true;
  try {
    state.port.postMessage({ type: 'closePanel' });
    setTimeout(() => {
      if (panelStates.get(windowId) !== state) return;
      state.closing = false;
      state.reopen = false;
    }, PANEL_CLOSE_GRACE_MS);
  } catch {
    panelStates.delete(windowId);
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'sidePanel') return;
  let registeredWindowId = null;

  port.onMessage.addListener((message) => {
    if (message.type !== 'registerPanel' || !Number.isInteger(message.windowId)) return;
    registeredWindowId = message.windowId;
    panelStates.set(registeredWindowId, { port, closing: false, reopen: false });
    setWindowClickWatch(registeredWindowId, true);
  });

  port.onDisconnect.addListener(() => {
    if (registeredWindowId === null) return;
    const state = panelStates.get(registeredWindowId);
    if (state?.port !== port) return;
    panelStates.delete(registeredWindowId);
    setWindowClickWatch(registeredWindowId, false);
    // 面板关掉了，别再等着合并窗口：把进度落盘。
    listStore.flush().catch(() => {});
    if (state.reopen) chrome.sidePanel.open({ windowId: registeredWindowId }).catch(() => {});
  });
});

function respondWith(promise, sendResponse) {
  promise
    .then((data) => sendResponse({ ok: true, data }))
    .catch((error) => sendResponse({ ok: false, error: error?.message || '操作失败' }));
  return true;
}

function findItem(list, itemId) {
  const item = list.find((candidate) => candidate.id === itemId);
  if (!item) throw new Error('条目不存在');
  return item;
}

function assertPickable(item) {
  if (item.strikethrough || Number(item.scrollPercent) >= 100) {
    throw new Error('该条目已不在随机池中');
  }
}

const panelActions = {
  // 纯读：不写存储、不广播。
  'list:get': async () => ({ list: await listStore.get() }),

  'list:addCurrent': async (message) => {
    const query = { active: true };
    if (Number.isInteger(message.windowId)) query.windowId = message.windowId;
    else query.currentWindow = true;
    const [tab] = await chrome.tabs.query(query);
    if (!tab || !isSupportedUrl(tab.url)) throw new Error('当前页面不支持添加');
    const source = buildSource(tab, tab.url);
    const item = buildItem({ url: tab.url, title: tab.title, tab, source });
    const outcome = await mutateList((list) => addOrBumpItem(list, item));
    broadcastList(outcome, { originWindowId: message.windowId });
    playAddAnimation(tab.id, {
      duplicate: outcome.duplicate,
      label: outcome.item.title || outcome.item.url,
    });
    return { duplicate: outcome.duplicate, item: outcome.item, list: outcome.list };
  },

  'list:toggleRead': async (message) => {
    const outcome = await mutateList((list) => {
      const item = findItem(list, message.itemId);
      item.strikethrough = !item.strikethrough;
      return { list, item };
    });
    broadcastList(outcome, { originWindowId: message.windowId });
    return { item: outcome.item, list: outcome.list };
  },

  'list:delete': async (message) => {
    const outcome = await mutateList((list) => ({
      list: list.filter((item) => item.id !== message.itemId),
    }));
    broadcastList(outcome, { originWindowId: message.windowId });
    return { list: outcome.list };
  },

  'list:clear': async (message) => {
    const outcome = await mutateList(() => ({ list: [] }));
    broadcastList(outcome, { originWindowId: message.windowId });
    return { list: outcome.list };
  },

  'list:import': async (message) => {
    const outcome = await mutateList((list) => prepareImport(message.payload, list));
    broadcastList(outcome, { originWindowId: message.windowId });
    return {
      imported: outcome.imported,
      duplicate: outcome.duplicate,
      invalid: outcome.invalid,
      list: outcome.list,
    };
  },

  // 面板打开页面后回来登记冷却时间（打开失败时不会到这里）。
  'list:markRandomPicked': async (message) => {
    const outcome = await mutateList((list) => {
      const item = findItem(list, message.itemId);
      assertPickable(item);
      const now = Date.now();
      if (Number.isFinite(item.lastRandomPickedAt)
        && now - item.lastRandomPickedAt < RANDOM_PICK_COOLDOWN_MS) {
        return { list, item };
      }
      item.lastRandomPickedAt = now;
      return { list, item };
    });
    broadcastList(outcome, { originWindowId: message.windowId });
    return { item: outcome.item, list: outcome.list };
  },
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const type = message?.type;

  if (type?.startsWith('list:')) {
    const action = panelActions[type];
    if (!action) return respondWith(Promise.reject(new Error('未知操作')), sendResponse);
    return respondWith(action(message, sender), sendResponse);
  }

  if (type === 'pageClicked') {
    const windowId = sender.tab?.windowId;
    if (windowId !== undefined) closePanel(windowId);
    return undefined;
  }

  if (type === 'contextMeta' || type === 'contextUrl') {
    const tabId = sender.tab?.id;
    if (tabId !== undefined) {
      prunePendingContexts();
      const existing = type === 'contextUrl' ? (pendingContextByTab.get(tabId) || {}) : {};
      pendingContextByTab.set(tabId, {
        ...existing,
        url: type === 'contextUrl' ? message.url : undefined,
        title: type === 'contextUrl' ? message.title : undefined,
        label: message.label,
        x: message.x,
        y: message.y,
        createdAt: Date.now(),
      });
    }
    return undefined;
  }

  if (type === 'openItem') {
    return respondWith(openTrackedItem({
      id: message.itemId,
      url: message.url,
      scrollY: message.scrollY,
      scrollPercent: message.scrollPercent,
    }), sendResponse);
  }

  if (type === 'scrollUpdate' && sender.tab?.id !== undefined) {
    trackedTabsReady.then(async () => {
      const state = normalizeTrackedState(trackedTabs.get(sender.tab.id));
      if (!state.itemId || !state.boundUrl || !urlsReferToSameDocument(state.boundUrl, message.pageUrl)) return;
      const outcome = await mutateList((list) => {
        const item = list.find((candidate) => candidate.id === state.itemId);
        if (!item) return { list, item: null };
        item.scrollPercent = Math.min(100, Math.max(item.scrollPercent || 0, Number(message.percent) || 0));
        item.scrollY = Math.max(0, Math.round(Number(message.scrollY) || 0));
        item.scrollUpdatedAt = Date.now();
        return { list, item };
      }, { persist: message.flush ? 'now' : 'deferred' });
      if (!outcome.item) return;
      broadcastPanel({
        type: 'scrollProgressUpdated',
        itemId: outcome.item.id,
        percent: outcome.item.scrollPercent,
        scrollY: outcome.item.scrollY,
      });
    }).catch(() => {});
    return undefined;
  }

  return undefined;
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  // 新开的标签页错过广播时补一次点击监听开关。
  if (changeInfo.status === 'complete' && panelStates.has(tab.windowId)) {
    chrome.tabs.sendMessage(tabId, { type: 'watchPageClicks', enabled: true }).catch(() => {});
  }

  await trackedTabsReady;
  const state = normalizeTrackedState(trackedTabs.get(tabId));
  if (!state.itemId) return;

  if (state.boundUrl && changeInfo.url && !urlsReferToSameDocument(state.boundUrl, changeInfo.url)) {
    removeTrackedTab(tabId);
    return;
  }

  if (changeInfo.status !== 'complete' || !isSupportedUrl(tab.url)) return;
  if (!state.boundUrl) {
    state.boundUrl = tab.url;
    saveTrackedTab(tabId, state);
  } else if (!urlsReferToSameDocument(state.boundUrl, tab.url)) {
    removeTrackedTab(tabId);
    return;
  }
  injectScrollTracker(tabId, state);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  pendingContextByTab.delete(tabId);
  removeTrackedTab(tabId);
});

function injectScrollTracker(tabId, state) {
  chrome.scripting.executeScript({
    target: { tabId },
    func: (restore) => {
      window.__readLaterRestore = restore;
    },
    args: [{ scrollY: state.restoreScrollY || 0, percent: state.restorePercent || 0 }],
  }).then(() => chrome.scripting.executeScript({
    target: { tabId },
    files: ['content-scroll-tracker.js'],
  })).catch(() => removeTrackedTab(tabId));
}

function ensureContextMenu() {
  chrome.contextMenus.create({
    id: 'addToReadLater',
    title: '添加到稍后再看',
    contexts: ['all'],
  }, () => chrome.runtime.lastError);
}

function resetContextMenu() {
  chrome.contextMenus.removeAll(ensureContextMenu);
}

// 菜单由浏览器持久化：只在安装/更新和浏览器启动时同步一次，
// 避免 Service Worker 每次启动都撞一次 duplicate id。
chrome.runtime.onInstalled.addListener(resetContextMenu);
chrome.runtime.onStartup.addListener(ensureContextMenu);

chrome.action.onClicked.addListener((tab) => {
  const state = panelStates.get(tab.windowId);
  if (!state) {
    chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
    return;
  }
  if (state.closing) {
    state.reopen = true;
    return;
  }
  closePanel(tab.windowId);
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  prunePendingContexts();
  const pending = tab?.id !== undefined ? pendingContextByTab.get(tab.id) : null;
  let url;
  let title;

  if (pending?.url) {
    url = pending.url;
    title = info.selectionText || pending.title || url;
  } else if (info.linkUrl) {
    url = info.linkUrl;
    title = info.selectionText || info.linkUrl;
  } else if (info.srcUrl) {
    url = info.srcUrl;
    try {
      title = decodeURIComponent(new URL(url).pathname.split('/').pop() || url);
    } catch {
      title = url;
    }
  } else if (info.selectionText) {
    url = tab?.url || info.pageUrl;
    title = info.selectionText;
  } else {
    url = tab?.url;
    title = tab?.title || url;
  }

  if (tab?.id !== undefined) pendingContextByTab.delete(tab.id);
  if (!isSupportedUrl(url)) return;

  const source = buildSource(tab, info.pageUrl);
  const item = buildItem({ url, title, tab, source });
  mutateList((list) => addOrBumpItem(list, item)).then((outcome) => {
    broadcastList(outcome, { feedback: outcome.duplicate
      ? '已在列表中，已移到顶部'
      : `已添加：${outcome.item.title || outcome.item.url}` });
    playAddAnimation(tab?.id, {
      duplicate: outcome.duplicate,
      label: outcome.item.title || outcome.item.url,
      x: pending?.x,
      y: pending?.y,
    });
  }).catch(() => {});
});
