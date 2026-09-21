// 捕获右键点击的帖子 URL，通过消息发送给 background
// 标题用帖子完整原文
//
// 性能约定：这个脚本在所有站点常驻，contextmenu 里的每一步都可能作用在
// 巨大的 DOM 上，所以任何全页扫描/整页取文本的写法都要避免。


(function () {
  const LABEL_SOURCE_LIMIT = 200;
  const TEXT_LIMIT = 1000;
  const ARTICLE_SELECTOR = 'article, [role="article"], [data-testid="tweet"]';

  let lastContextMeta = null;
  let lastPageClickAt = 0;
  // 侧边栏没打开时，页面里的点击不需要上报（每次 sendMessage 都会唤醒 Service Worker）。
  let watchClicks = false;

  function send(message) {
    try {
      const result = chrome.runtime.sendMessage(message);
      if (result && typeof result.catch === 'function') result.catch(() => {});
    } catch {
      // 扩展上下文已失效（重载或更新）。
    }
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'watchPageClicks') watchClicks = !!message.enabled;
  });

  document.addEventListener(
    'contextmenu',
    (e) => {
      let result = null;
      lastContextMeta = {
        x: e.clientX,
        y: e.clientY,
        label: getContextLabel(e.target),
      };

      // 策略 1：向上遍历找 <a> 标签
      let el = e.target;
      while (el && el !== document.body && el !== document.documentElement) {
        if (el.tagName === 'A' && el.href && !el.href.startsWith('javascript:')) {
          result = { url: el.href, title: el.textContent?.trim() };
          break;
        }
        el = el.parentElement;
      }

      // 策略 2：找文章/帖子容器
      if (!result) {
        el = e.target;
        while (el && el !== document.body && el !== document.documentElement) {
          if (el.matches(ARTICLE_SELECTOR)) {
            const link = findPostUrl(el);
            if (link) result = { url: link, title: extractFullText(el) };
            break;
          }
          el = el.parentElement;
        }
      }

      // 策略 3：就近 a 标签
      if (!result) {
        const nearby = e.target.closest('a[href]');
        if (nearby && nearby.href && !nearby.href.startsWith('javascript:')) {
          const art = nearby.closest(ARTICLE_SELECTOR);
          result = {
            url: nearby.href,
            title: art ? extractFullText(art) : nearby.textContent?.trim(),
          };
        }
      }

      // 策略 4：命中测试找最近的帖子容器。
      // 原来这里遍历整页 article 并逐个量 getBoundingClientRect()，长列表站点上
      // 每次右键都要强制布局几百次；elementsFromPoint 是浏览器内部的命中测试，便宜得多。
      if (!result) {
        const stack = typeof document.elementsFromPoint === 'function'
          ? document.elementsFromPoint(e.clientX, e.clientY)
          : [];
        for (const node of stack) {
          const art = node.closest?.(ARTICLE_SELECTOR);
          if (!art) continue;
          const link = findPostUrl(art);
          if (link) result = { url: link, title: extractFullText(art) };
          break;
        }
      }

      if (result) {
        send({
          type: 'contextUrl',
          url: result.url,
          title: result.title || result.url,
          label: result.title || lastContextMeta.label || result.url,
          x: e.clientX,
          y: e.clientY,
        });
      } else {
        send({ type: 'contextMeta', ...lastContextMeta });
      }
    },
    { capture: true }
  );

  document.addEventListener(
    'pointerdown',
    (e) => {
      if (!watchClicks) return;
      if (e.button !== 0) return;
      if (isEditingTarget(e.target)) return;

      const now = Date.now();
      if (now - lastPageClickAt < 250) return;
      lastPageClickAt = now;

      send({ type: 'pageClicked' });
    },
    { capture: true }
  );

  function findPostUrl(container) {
    const byTime = container.querySelector('a time, a[datetime]');
    if (byTime) {
      const a = byTime.closest('a');
      if (a?.href) return a.href;
    }
    const all = [...container.querySelectorAll('a[href]')].filter((a) => !a.href.startsWith('javascript:'));
    for (const a of all) {
      if (a.href.includes('/status/') || a.href.includes('/post/') || a.href.includes('/comments/')) {
        return a.href;
      }
    }
    let best = null;
    let bestLen = 0;
    for (const a of all) {
      const t = (a.textContent || '').trim();
      if (t.length > bestLen && !a.href.match(/\/[^/]+?\/(photo|video|media)\/?/)) {
        best = a;
        bestLen = t.length;
      }
    }
    if (best) return best.href;
    return all[0]?.href || null;
  }

  function extractFullText(container) {
    const tweetText = container.querySelector('[data-testid="tweetText"]');
    if (tweetText) return clampText(tweetText.textContent);
    const postContent = container.querySelector('[data-testid="postText"], .post-content, [itemprop="articleBody"], .entry-content');
    if (postContent) return clampText(postContent.textContent);
    const parts = [];
    let total = 0;
    for (const node of container.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li, [dir="auto"]')) {
      const t = (node.textContent || '').trim();
      if (!t || t.length <= 3) continue;
      parts.push(t);
      total += t.length + 1;
      // 够长就停：原来会把整棵子树的文本拼完再 slice。
      if (total >= TEXT_LIMIT) break;
    }
    return clampText(parts.join('\n'));
  }

  function clampText(text) {
    return (text || '').trim().slice(0, TEXT_LIMIT);
  }

  // 右键点在页面空白处时 target 可能是 <body>：直接读 textContent 会把整页文本
  // 复制一遍再跑正则。这里只在小粒度元素上取文本，否则回退到页面标题。
  function getContextLabel(target) {
    const link = target?.closest?.('a[href]');
    if (link) return normalizeLabel(link.textContent);

    let el = target;
    while (el && el !== document.body && el !== document.documentElement) {
      if (el.childElementCount <= 6) {
        const text = el.textContent;
        if (text && text.length <= LABEL_SOURCE_LIMIT) return normalizeLabel(text);
        if (text && text.length > LABEL_SOURCE_LIMIT) break;
      }
      el = el.parentElement;
    }
    return normalizeLabel(document.title) || '稍后再看';
  }

  function normalizeLabel(text) {
    return String(text || '').replace(/\s+/g, ' ').trim().slice(0, 42);
  }

  function isEditingTarget(target) {
    return !!target?.closest?.('input, textarea, select, [contenteditable="true"], [role="textbox"]');
  }
})();
