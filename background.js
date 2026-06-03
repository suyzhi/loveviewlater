let panelOpen = false;

// tabId -> itemId 映射，用于追踪从稍后再看打开的页面
const trackedTabs = new Map();
// 内容脚本发来的右键上下文 URL
let pendingContextUrl = null;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'panelOpened') panelOpen = true;
  if (msg.type === 'panelClosed') panelOpen = false;

  // 从内容脚本：右键点击的 URL
  if (msg.type === 'contextUrl') {
    pendingContextUrl = { url: msg.url, title: msg.title };
  }

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
    id: 'addToReadLater',
    title: '添加到稍后再看',
    contexts: ['page', 'link', 'image', 'video', 'audio', 'selection'],
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

  // 优先使用内容脚本发来的帖子 URL（处理 SPA 网站）
  if (pendingContextUrl) {
    url = pendingContextUrl.url;
    title = info.selectionText || pendingContextUrl.title || url;
    pendingContextUrl = null;
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
    chrome.storage.local.set({ readLaterList: list }, () => {
      // 通知侧边栏刷新
      chrome.runtime.sendMessage({ type: 'listUpdated' }).catch(() => {});
    });
  });
});
