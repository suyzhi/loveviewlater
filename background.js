let panelOpen = false;

// tabId -> itemId 映射，用于追踪从稍后再看打开的页面
const trackedTabs = new Map();

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'panelOpened') panelOpen = true;
  if (msg.type === 'panelClosed') panelOpen = false;

  // 从侧边栏：打开一个新标签页并追踪
  if (msg.type === 'openItem') {
    chrome.tabs.create({ url: msg.url, active: true }, (tab) => {
      trackedTabs.set(tab.id, msg.itemId);
    });
  }

  // 从内容脚本：更新滚动百分比
  if (msg.type === 'scrollUpdate' && sender.tab) {
    const itemId = trackedTabs.get(sender.tab.id);
    if (itemId && msg.percent !== undefined) {
      chrome.storage.local.get({ readLaterList: [] }, (result) => {
        const list = result.readLaterList;
        const item = list.find((i) => i.id === itemId);
        if (item) {
          item.scrollPercent = Math.max(item.scrollPercent || 0, msg.percent);
          item.scrollUpdatedAt = Date.now();
          chrome.storage.local.set({ readLaterList: list });
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
  trackedTabs.delete(tabId);
});

function injectScrollTracker(tabId) {
  chrome.scripting
    .executeScript({
      target: { tabId },
      files: ['content-scroll-tracker.js'],
    })
    .catch(() => {
      // 受限页面（chrome:// 等）或标签页已关闭
      trackedTabs.delete(tabId);
    });
}

// ---- 以下原有代码不变 ----

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'addPageToReadLater',
    title: '添加到稍后再看',
    contexts: ['page'],
  });
  chrome.contextMenus.create({
    id: 'addLinkToReadLater',
    title: '链接添加到稍后再看',
    contexts: ['link'],
  });
});

chrome.action.onClicked.addListener((tab) => {
  if (panelOpen) {
    chrome.runtime.sendMessage({ type: 'closePanel' }).catch(() => {});
    panelOpen = false;
  } else {
    chrome.sidePanel.open({ windowId: tab.windowId });
  }
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  let url, title;

  if (info.menuItemId === 'addLinkToReadLater' && info.linkUrl) {
    url = info.linkUrl;
    title = info.selectionText || url;
  } else if (info.menuItemId === 'addPageToReadLater' && tab) {
    url = tab.url;
    title = tab.title || url;
  }

  if (!url) return;

  const item = {
    id: Date.now().toString(),
    title: title,
    url: url,
    favicon: `https://www.google.com/s2/favicons?domain=${new URL(url).hostname}&sz=32`,
    addedAt: Date.now(),
  };

  chrome.storage.local.get({ readLaterList: [] }, (result) => {
    const list = result.readLaterList;
    if (list.some((i) => i.url === item.url)) return;
    list.unshift(item);
    chrome.storage.local.set({ readLaterList: list });
  });
});
