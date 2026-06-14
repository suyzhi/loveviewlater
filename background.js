let panelOpen = false;

const STORAGE_KEY = 'readLaterList';
const CONTEXT_TTL_MS = 5000;

// tabId -> 追踪状态映射，用于追踪从稍后再看打开的页面
// 使用 chrome.storage.session 持久化，避免 MV3 SW 重启后丢失
const trackedTabs = new Map();

async function initTrackedTabs() {
  try {
    const result = await chrome.storage.session.get({ trackedTabs: {} });
    const stored = result.trackedTabs;
    for (const [tabId, state] of Object.entries(stored)) {
      trackedTabs.set(Number(tabId), normalizeTrackedState(state));
    }
  } catch {
    // session storage 不可用（如 Firefox）
  }
}
initTrackedTabs();

function normalizeTrackedState(state) {
  if (typeof state === 'string') return { itemId: state };
  return state || {};
}

async function saveTrackedTab(tabId, state) {
  trackedTabs.set(tabId, normalizeTrackedState(state));
  try {
    const result = await chrome.storage.session.get({ trackedTabs: {} });
    const stored = result.trackedTabs;
    stored[tabId] = normalizeTrackedState(state);
    await chrome.storage.session.set({ trackedTabs: stored });
  } catch {
    // 非关键错误，忽略
  }
}

async function removeTrackedTab(tabId) {
  trackedTabs.delete(tabId);
  try {
    const result = await chrome.storage.session.get({ trackedTabs: {} });
    const stored = result.trackedTabs;
    delete stored[tabId];
    await chrome.storage.session.set({ trackedTabs: stored });
  } catch {
    // 非关键错误，忽略
  }
}

// tabId -> 右键上下文 URL，避免多个标签页快速右键时串台
const pendingContextByTab = new Map();

function prunePendingContexts() {
  const now = Date.now();
  for (const [tabId, context] of pendingContextByTab.entries()) {
    if (now - context.createdAt > CONTEXT_TTL_MS) pendingContextByTab.delete(tabId);
  }
}

function getDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function buildSource(tab, fallbackUrl) {
  const sourceUrl = tab?.url || fallbackUrl || '';
  return {
    sourceUrl,
    sourceTitle: tab?.title || sourceUrl,
    sourceDomain: getDomain(sourceUrl),
  };
}

function normalizeUrl(url) {
  try {
    const parsed = new URL(url);
    for (const key of [...parsed.searchParams.keys()]) {
      if (/^utm_/i.test(key) || ['fbclid', 'gclid', 'mc_cid', 'mc_eid'].includes(key.toLowerCase())) {
        parsed.searchParams.delete(key);
      }
    }
    if (parsed.pathname !== '/' && parsed.pathname.endsWith('/')) {
      parsed.pathname = parsed.pathname.slice(0, -1);
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

function notifyPanel(message) {
  chrome.runtime.sendMessage(message).catch(() => {});
}

function notifyTab(tabId, message) {
  if (tabId === undefined) return;
  chrome.tabs.sendMessage(tabId, message).catch(() => {});
}

function playAddAnimation(tabId, payload) {
  if (tabId === undefined) return;
  chrome.scripting
    .executeScript({
      target: { tabId },
      func: (animationPayload) => {
        globalThis.__readLaterAnimationPayload = animationPayload;
      },
      args: [payload],
    })
    .then(() => chrome.scripting.executeScript({
      target: { tabId },
      files: ['content-add-animation.js'],
    }))
    .catch(() => {
      notifyTab(tabId, { type: 'playAddAnimation', ...payload });
    });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'panelOpened') panelOpen = true;
  if (msg.type === 'panelClosed') panelOpen = false;

  // 从内容脚本：右键点击的 URL
  if (msg.type === 'contextMeta') {
    const tabId = sender.tab?.id;
    if (tabId !== undefined) {
      const existing = pendingContextByTab.get(tabId) || {};
      pendingContextByTab.set(tabId, {
        ...existing,
        x: msg.x,
        y: msg.y,
        label: msg.label,
        createdAt: Date.now(),
      });
    }
  }

  if (msg.type === 'contextUrl') {
    const tabId = sender.tab?.id;
    if (tabId !== undefined) {
      const existing = pendingContextByTab.get(tabId) || {};
      pendingContextByTab.set(tabId, {
        ...existing,
        url: msg.url,
        title: msg.title,
        x: msg.x ?? existing.x,
        y: msg.y ?? existing.y,
        label: msg.label || msg.title || existing.label,
        createdAt: Date.now(),
      });
    }
  }

  // 从侧边栏：打开一个新标签页并追踪
  if (msg.type === 'openItem') {
    chrome.tabs.create({ url: msg.url, active: true }, (tab) => {
      saveTrackedTab(tab.id, {
        itemId: msg.itemId,
        restoreScrollY: msg.scrollY,
        restorePercent: msg.scrollPercent,
      });
    });
  }

  // 从内容脚本：更新滚动百分比
  if (msg.type === 'scrollUpdate' && sender.tab) {
    const state = normalizeTrackedState(trackedTabs.get(sender.tab.id));
    const itemId = state.itemId;
    if (itemId && msg.percent !== undefined) {
      chrome.storage.local.get({ [STORAGE_KEY]: [] }, (result) => {
        const list = result[STORAGE_KEY];
        const item = list.find((i) => i.id === itemId);
        if (item) {
          item.scrollPercent = Math.max(item.scrollPercent || 0, msg.percent);
          item.scrollY = Math.max(0, Math.round(msg.scrollY || 0));
          item.scrollUpdatedAt = Date.now();
          chrome.storage.local.set({ [STORAGE_KEY]: list });
          notifyPanel({ type: 'scrollProgressUpdated', itemId, percent: item.scrollPercent });
        }
      });
    }
  }
});

// 标签页加载完成后注入滚动追踪脚本
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && trackedTabs.has(tabId)) {
    injectScrollTracker(tabId);
  }
});

// 标签页关闭时清理映射
chrome.tabs.onRemoved.addListener((tabId) => {
  removeTrackedTab(tabId);
});

function injectScrollTracker(tabId) {
  const state = normalizeTrackedState(trackedTabs.get(tabId));
  chrome.scripting
    .executeScript({
      target: { tabId },
      func: (restore) => {
        window.__readLaterRestore = restore;
      },
      args: [{ scrollY: state.restoreScrollY || 0, percent: state.restorePercent || 0 }],
    })
    .then(() => chrome.scripting.executeScript({
      target: { tabId },
      files: ['content-scroll-tracker.js'],
    }))
    .catch(() => {
      // 受限页面（chrome:// 等）或标签页已关闭
      removeTrackedTab(tabId);
    });
}

// ---- 以下原有代码不变 ----

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'addToReadLater',
    title: '添加到稍后再看',
    contexts: ['page', 'link', 'image', 'video', 'audio', 'selection'],
  });
});

chrome.action.onClicked.addListener((tab) => {
  if (panelOpen) {
    notifyPanel({ type: 'closePanel' });
    panelOpen = false;
  } else {
    chrome.sidePanel.open({ windowId: tab.windowId });
  }
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  let url, title;
  prunePendingContexts();
  const pendingContext = tab?.id !== undefined ? pendingContextByTab.get(tab.id) : null;

  // 优先使用内容脚本发来的帖子 URL（处理 SPA 网站）
  if (pendingContext?.url) {
    url = pendingContext.url;
    title = info.selectionText || pendingContext.title || url;
    pendingContextByTab.delete(tab.id);
  } else if (info.linkUrl) {
    // 右键的是链接
    url = info.linkUrl;
    title = info.selectionText || info.linkUrl;
  } else if (info.srcUrl) {
    // 右键的是图片/视频/音频
    url = info.srcUrl;
    try {
      const name = new URL(url).pathname.split('/').pop() || url;
      title = decodeURIComponent(name);
    } catch {
      title = url;
    }
  } else if (info.selectionText) {
    // 选中的文字
    url = tab?.url || info.pageUrl;
    title = info.selectionText;
  } else if (tab) {
    // 页面空白处
    url = tab.url;
    title = tab.title || url;
  }

  if (!url) return;
  if (tab?.id !== undefined) pendingContextByTab.delete(tab.id);
  const normalizedUrl = normalizeUrl(url);
  const source = buildSource(tab, info.pageUrl);

  const item = {
    id: Date.now().toString(),
    title: title,
    url: url,
    normalizedUrl,
    favicon: `https://www.google.com/s2/favicons?domain=${new URL(url).hostname}&sz=32`,
    addedAt: Date.now(),
    ...source,
  };

  chrome.storage.local.get({ [STORAGE_KEY]: [] }, (result) => {
    const list = result[STORAGE_KEY];
    const existingIndex = list.findIndex((i) => (i.normalizedUrl || normalizeUrl(i.url)) === item.normalizedUrl);
    if (existingIndex >= 0) {
      const [existing] = list.splice(existingIndex, 1);
      list.unshift(existing);
      chrome.storage.local.set({ [STORAGE_KEY]: list }, () => {
        notifyPanel({ type: 'itemDuplicate', itemId: existing.id, title: existing.title || existing.url });
        playAddAnimation(tab?.id, {
          duplicate: true,
          context: pendingContext,
          title: existing.title || existing.url,
          label: existing.title || existing.url,
          x: pendingContext?.x,
          y: pendingContext?.y,
        });
      });
      return;
    }
    list.unshift(item);
    chrome.storage.local.set({ [STORAGE_KEY]: list }, () => {
      // 通知侧边栏刷新
      notifyPanel({ type: 'listUpdated', title: item.title || item.url });
      playAddAnimation(tab?.id, {
        context: pendingContext,
        title: item.title || item.url,
        label: item.title || item.url,
        x: pendingContext?.x,
        y: pendingContext?.y,
      });
    });
  });
});
