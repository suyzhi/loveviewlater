// 捕获右键点击的帖子/链接 URL，通过消息发送给 background
// 用于 X/Twitter、Reddit 等 SPA 网站

document.addEventListener(
  'contextmenu',
  (e) => {
    const target = e.target;
    let result = null;

    // 策略 1：向上遍历找 <a> 标签
    let el = target;
    while (el && el !== document.body && el !== document.documentElement) {
      if (el.tagName === 'A' && el.href && !el.href.startsWith('javascript:')) {
        result = { url: el.href, title: el.textContent?.trim() };
        break;
      }
      el = el.parentElement;
    }

    // 策略 2：找文章/帖子容器提取链接
    if (!result) {
      el = target;
      while (el && el !== document.body && el !== document.documentElement) {
        if (el.matches('article, [role="article"], [data-testid="tweet"]')) {
          result = extractPostLink(el);
          break;
        }
        el = el.parentElement;
      }
    }

    // 策略 3：就近找 a 标签
    if (!result) {
      const nearby = target.closest('a[href]');
      if (nearby && nearby.href && !nearby.href.startsWith('javascript:')) {
        result = { url: nearby.href, title: nearby.textContent?.trim() };
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
        if (d < bestDist) {
          bestDist = d;
          best = art;
        }
      }
      if (best) result = extractPostLink(best);
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
    if (a?.href) return { url: a.href, title: container.querySelector('[data-testid="tweetText"]')?.textContent?.trim() || a.textContent?.trim() };
  }

  const all = [...container.querySelectorAll('a[href]')].filter(a => !a.href.startsWith('javascript:'));

  // 2. 包含 /status/ /post/ /comments/ 模式
  for (const a of all) {
    if (a.href.includes('/status/') || a.href.includes('/post/') || a.href.includes('/comments/')) {
      return { url: a.href, title: a.textContent?.trim() };
    }
  }

  // 3. 文本最长的链接（通常是标题/正文）
  let best = null;
  let bestLen = 0;
  for (const a of all) {
    const t = (a.textContent || '').trim();
    if (t.length > bestLen && !a.href.match(/\/[^\/]+?\/(photo|video|media)\/?/)) {
      best = a;
      bestLen = t.length;
    }
  }
  if (best) return { url: best.href, title: best.textContent?.trim() };

  // 4. 任意链接兜底
  if (all[0]) return { url: all[0].href, title: all[0].textContent?.trim() };

  return null;
}
