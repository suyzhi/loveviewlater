import {
  RANDOM_PICK_COOLDOWN_MS,
  STORAGE_KEY,
  addOrBumpItem,
  createSerialExecutor,
  getDomain,
  isSupportedUrl,
  normalizeStoredList,
  normalizeUrl,
  prepareImport,
  urlsReferToSameDocument,
} from './core.mjs';

const CONTEXT_TTL_MS = 30_000;
const trackedTabs = new Map();
const pendingContextByTab = new Map();
const panelStates = new Map();
const runSerially = createSerialExecutor();

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

async function persistTrackedTabs() {
  try {
    await chrome.storage.session.set({ trackedTabs: Object.fromEntries(trackedTabs) });
  } catch {
    // 非关键错误。
  }
}

async function saveTrackedTab(tabId, state) {
  if (tabId === undefined) return;
  await trackedTabsReady;
  trackedTabs.set(tabId, normalizeTrackedState(state));
  await persistTrackedTabs();
}

async function removeTrackedTab(tabId) {
  await trackedTabsReady;
  if (!trackedTabs.delete(tabId)) return;
  await persistTrackedTabs();
}

function prunePendingContexts() {
  const now = Date.now();
  for (const [tabId, context] of pendingContextByTab.entries()) {
    if (now - context.createdAt > CONTEXT_TTL_MS) pendingContextByTab.delete(tabId);
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

async function readList() {
  const result = await chrome.storage.local.get({ [STORAGE_KEY]: [] });
  return normalizeStoredList(result[STORAGE_KEY]);
}

function mutateList(mutator) {
  return runSerially(async () => {
    const list = await readList();
    const outcome = await mutator(list);
    const nextList = outcome?.list || list;
    await chrome.storage.local.set({ [STORAGE_KEY]: nextList });
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

function playAddAnimation(tabId, payload) {
  if (tabId === undefined) return;
  chrome.tabs.sendMessage(tabId, {
    type: 'playAddAnimation',
    animationId: crypto.randomUUID(),
    ...payload,
  }).catch(() => {
    // 内部页或未获授权页面不支持网页内动画，保存仍然成功。
  });
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
    }, 700);
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
  });

  port.onDisconnect.addListener(() => {
    if (registeredWindowId === null) return;
    const state = panelStates.get(registeredWindowId);
    if (state?.port !== port) return;
    panelStates.delete(registeredWindowId);
    if (state.reopen) chrome.sidePanel.open({ windowId: registeredWindowId }).catch(() => {});
  });
});

function respondWith(promise, sendResponse) {
  promise
    .then((data) => sendResponse({ ok: true, data }))
    .catch((error) => sendResponse({ ok: false, error: error?.message || '操作失败' }));
  return true;
}

async function handlePanelAction(message) {
  if (message.type === 'list:get') {
    const outcome = await mutateList((list) => ({ list }));
    return { list: outcome.list };
  }

  if (message.type === 'list:addCurrent') {
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
  }

  if (message.type === 'list:toggleRead') {
    const outcome = await mutateList((list) => {
      const item = list.find((candidate) => candidate.id === message.itemId);
      if (!item) throw new Error('条目不存在');
      item.strikethrough = !item.strikethrough;
      return { list, item };
    });
    broadcastList(outcome, { originWindowId: message.windowId });
    return { item: outcome.item, list: outcome.list };
  }

  if (message.type === 'list:delete') {
    const outcome = await mutateList((list) => ({
      list: list.filter((item) => item.id !== message.itemId),
    }));
    broadcastList(outcome, { originWindowId: message.windowId });
    return { list: outcome.list };
  }

  if (message.type === 'list:clear') {
    const outcome = await mutateList(() => ({ list: [] }));
    broadcastList(outcome, { originWindowId: message.windowId });
    return { list: outcome.list };
  }

  if (message.type === 'list:import') {
    const outcome = await mutateList((list) => prepareImport(message.payload, list));
    broadcastList(outcome, { originWindowId: message.windowId });
    return {
      imported: outcome.imported,
      duplicate: outcome.duplicate,
      invalid: outcome.invalid,
      list: outcome.list,
    };
  }

  if (message.type === 'list:openRandom') {
    const outcome = await mutateList(async (list) => {
      const item = list.find((candidate) => candidate.id === message.itemId);
      if (!item) throw new Error('条目不存在');
      if (item.strikethrough || Number(item.scrollPercent) >= 100) {
        throw new Error('该条目已不在随机池中');
      }
      const now = Date.now();
      if (Number.isFinite(item.lastRandomPickedAt)
        && now - item.lastRandomPickedAt < RANDOM_PICK_COOLDOWN_MS) {
        throw new Error('这篇内容刚刚抽过，换一篇吧');
      }
      item.lastRandomPickedAt = now;
      await openTrackedItem(item);
      return { list, item };
    });
    broadcastList(outcome, { originWindowId: message.windowId });
    return { item: outcome.item, list: outcome.list };
  }

  if (message.type === 'list:markRandomPicked') {
    const outcome = await mutateList((list) => {
      const item = list.find((candidate) => candidate.id === message.itemId);
      if (!item) throw new Error('条目不存在');
      if (item.strikethrough || Number(item.scrollPercent) >= 100) {
        throw new Error('该条目已不在随机池中');
      }
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
  }

  throw new Error('未知操作');
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type?.startsWith('list:')) {
    return respondWith(handlePanelAction(message), sendResponse);
  }

  if (message.type === 'pageClicked') {
    const windowId = sender.tab?.windowId;
    if (windowId !== undefined) closePanel(windowId);
  }

  if (message.type === 'contextMeta' || message.type === 'contextUrl') {
    const tabId = sender.tab?.id;
    if (tabId !== undefined) {
      const existing = message.type === 'contextUrl' ? (pendingContextByTab.get(tabId) || {}) : {};
      pendingContextByTab.set(tabId, {
        ...existing,
        url: message.type === 'contextUrl' ? message.url : undefined,
        title: message.type === 'contextUrl' ? message.title : undefined,
        label: message.label,
        x: message.x,
        y: message.y,
        createdAt: Date.now(),
      });
    }
  }

  if (message.type === 'openItem') {
    return respondWith(openTrackedItem({
      id: message.itemId,
      url: message.url,
      scrollY: message.scrollY,
      scrollPercent: message.scrollPercent,
    }), sendResponse);
  }

  if (message.type === 'scrollUpdate' && sender.tab?.id !== undefined) {
    trackedTabsReady.then(() => {
      const state = normalizeTrackedState(trackedTabs.get(sender.tab.id));
      if (!state.itemId || !state.boundUrl || !urlsReferToSameDocument(state.boundUrl, message.pageUrl)) return;
      return mutateList((list) => {
        const item = list.find((candidate) => candidate.id === state.itemId);
        if (!item) return { list, item: null };
        item.scrollPercent = Math.max(item.scrollPercent || 0, Number(message.percent) || 0);
        item.scrollY = Math.max(0, Math.round(Number(message.scrollY) || 0));
        item.scrollUpdatedAt = Date.now();
        return { list, item };
      }).then((outcome) => {
        if (!outcome.item) return;
        broadcastPanel({
          type: 'scrollProgressUpdated',
          itemId: outcome.item.id,
          percent: outcome.item.scrollPercent,
          scrollY: outcome.item.scrollY,
        });
      });
    }).catch(() => {});
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
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

chrome.tabs.onRemoved.addListener((tabId) => removeTrackedTab(tabId));

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

ensureContextMenu();
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
