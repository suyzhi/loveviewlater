// 捕获右键点击的帖子/链接 URL，通过消息发送给 background
// 用于 X/Twitter、Reddit 等 SPA 网站

function getHoveredText(target) {
  // 从鼠标所在元素取文本，向上走到有意义的文本块
  let el = target;
  for (let i = 0; el && el !== document.body && el !== document.documentElement && i < 5; i++) {
    const t = (el.textContent || '').trim();
    if (t.length >= 10) return t;
    el = el.parentElement;
  }
  return (target.textContent || '').trim();
}

document.addEventListener(
  'contextmenu',
  (e) => {
    const hoverText = getHoveredText(e.target);
    let result = null;

    // 策略 1：向上遍历找 <a> 标签
    let el = e.target;
    while (el && el !== document.body && el !== document.documentElement) {
      if (el.tagName === 'A' && el.href && !el.href.startsWith('javascript:')) {
        result = { url: el.href, title: hoverText || el.textContent?.trim() };
        break;
      }
      el = el.parentElement;
    }

    // 策略 2：找文章/帖子容器提取链接
    if (!result) {
      el = e.target;
      while (el && el !== document.body && el !== document.documentElement) {
        if (el.matches('article, [role="article"], [data-testid="tweet"]')) {
          result = extractPostLink(el);
          if (result) result.title = hoverText || result.title;
          break;
        }
        el = el.parentElement;
      }
    }

    // 策略 3：就近找 a 标签
    if (!result) {
      const nearby = e.target.closest('a[href]');
      if (nearby && nearby.href && !nearby.href.startsWith('javascript:')) {
        result = { url: nearby.href, title: hoverText || nearby.textContent?.trim() };
      }
    }

    // 策略 4：在 document 中找最近的帖子容器
    if (!result) {
      const articles = document.querySelectorAll('article, [role="article"]');
      let best = null;
      let bestDist = Infinity;
      for (const art of articles) {
        const r = art.getBoundingClientRect();
        const d = Math.abs(e.clientX - (r.left + r.width / 2)) + Math.abs(e.clientY - (r.top + r.height / 2));
        if (d < bestDist) { bestDist = d; best = art; }
      }
      if (best) {
        result = extractPostLink(best);
        if (result) result.title = hoverText || result.title;
      }
    }

    if (result) {
      chrome.runtime.sendMessage({ type: 'contextUrl', url: result.url, title: result.title || result.url });
    }
  },
  { capture: true }
);

function extractPostLink(container) {
  // 1. 包含 <time> 的链接（X 帖子永久链接）
  const byTime = container.querySelector('a time, a[datetime]');
  if (byTime) {
    const a = byTime.closest('a');
    if (a?.href) return { url: a.href, title: '' };
  }

  const all = [...container.querySelectorAll('a[href]')].filter((a) => !a.href.startsWith('javascript:'));

  // 2. 包含帖子 URL 模式的链接
  for (const a of all) {
    if (a.href.includes('/status/') || a.href.includes('/post/') || a.href.includes('/comments/')) {
      return { url: a.href, title: '' };
    }
  }

  // 3. 文本最长的链接
  let best = null;
  let bestLen = 0;
  for (const a of all) {
    const t = (a.textContent || '').trim();
    if (t.length > bestLen && !a.href.match(/\/[^\/]+?\/(photo|video|media)\/?/)) {
      best = a;
      bestLen = t.length;
    }
  }
  if (best) return { url: best.href, title: '' };

  // 4. 任意链接兜底
  if (all[0]) return { url: all[0].href, title: '' };

  return null;
}
