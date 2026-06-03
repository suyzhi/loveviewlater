// 捕获右键点击的帖子/链接 URL
// 处理 SPA 网站（X/Twitter、Reddit 等）中不以 <a> 标签呈现的链接
document.addEventListener('contextmenu', (e) => {
  let el = e.target;
  let foundUrl = null;
  let foundText = null;

  // 最多向上遍历 10 层，找最近的链接
  for (let i = 0; el && el !== document.body && i < 10; i++) {
    // 如果是 <a> 标签
    if (el.tagName === 'A' && el.href) {
      foundUrl = el.href;
      foundText = el.textContent?.trim() || foundUrl;
      break;
    }
    // 查找容器内第一个链接
    if (el.matches('article, [role="article"], .post, .tweet, [data-post-url]')) {
      const a = el.querySelector('a[href]');
      if (a && a.href) {
        foundUrl = a.href;
        foundText = a.textContent?.trim() || foundUrl;
        break;
      }
    }
    el = el.parentElement;
  }

  if (foundUrl) {
    chrome.storage.session.set({ _contextLinkUrl: foundUrl, _contextLinkTitle: foundText });
  }
});
