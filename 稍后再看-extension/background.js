chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "addPageToReadLater",
    title: "添加到稍后再看",
    contexts: ["page"]
  });
  chrome.contextMenus.create({
    id: "addLinkToReadLater",
    title: "链接添加到稍后再看",
    contexts: ["link"]
  });
});

chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ windowId: tab.windowId });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  let url, title;

  if (info.menuItemId === "addLinkToReadLater" && info.linkUrl) {
    url = info.linkUrl;
    title = info.selectionText || url;
  } else if (info.menuItemId === "addPageToReadLater" && tab) {
    url = tab.url;
    title = tab.title || url;
  }

  if (!url) return;

  const item = {
    id: Date.now().toString(),
    title: title,
    url: url,
    favicon: `https://www.google.com/s2/favicons?domain=${new URL(url).hostname}&sz=32`,
    addedAt: Date.now()
  };

  chrome.storage.local.get({ readLaterList: [] }, (result) => {
    const list = result.readLaterList;
    list.unshift(item);
    chrome.storage.local.set({ readLaterList: list });
  });
});
