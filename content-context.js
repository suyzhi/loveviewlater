// 捕获右键点击的帖子 URL，通过消息发送给 background
// 标题用帖子的完整原文

document.addEventListener(
  'contextmenu',
  (e) => {
    let result = null;

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
        if (el.matches('article, [role="article"], [data-testid="tweet"]')) {
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
        // 看看它是否在文章容器里
        const art = nearby.closest('article, [role="article"]');
        result = {
          url: nearby.href,
          title: art ? extractFullText(art) : nearby.textContent?.trim(),
        };
      }
    }

    // 策略 4：按距离找最近的帖子容器
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
        const link = findPostUrl(best);
        if (link) result = { url: link, title: extractFullText(best) };
      }
    }

    if (result) {
      chrome.runtime.sendMessage({ type: 'contextUrl', url: result.url, title: result.title || result.url });
    }
  },
  { capture: true }
);

function findPostUrl(container) {
  // 1. 包含 <time> 的链接（X 帖子永久链接）
  const byTime = container.querySelector('a time, a[datetime]');
  if (byTime) {
    const a = byTime.closest('a');
    if (a?.href) return a.href;
  }

  const all = [...container.querySelectorAll('a[href]')].filter((a) => !a.href.startsWith('javascript:'));

  // 2. 含帖子 URL 模式
  for (const a of all) {
    if (a.href.includes('/status/') || a.href.includes('/post/') || a.href.includes('/comments/')) {
      return a.href;
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
  if (best) return best.href;

  // 4. 任意链接
  return all[0]?.href || null;
}

function extractFullText(container) {
  // X/Twitter
  const tweetText = container.querySelector('[data-testid="tweetText"]');
  if (tweetText) return tweetText.textContent?.trim() || '';

  // Reddit / 通用
  const postContent = container.querySelector('[data-testid="postText"], .post-content, [itemprop="articleBody"], .entry-content');
  if (postContent) return postContent.textContent?.trim() || '';

  // 兜底：收集所有非空段落
  const parts = [];
  for (const p of container.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li, [dir="auto"]')) {
    const t = (p.textContent || '').trim();
    if (t && t.length > 3) parts.push(t);
  }
  return parts.join('\n').slice(0, 1000);
}
