// 捕获右键点击的帖子 URL，通过消息发送给 background
// 标题用帖子完整原文

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
        if (link) { result = { url: link, title: extractFullText(best) }; }
      }
    }

    if (result) {
      // 视觉反馈：把找到的容器边框闪一下绿色
      if (result.url && !result.url.includes('x.com') && !result.url.includes('twitter.com/home')) {
        const art = document.querySelector('article, [role="article"]');
        if (art) {
          art.style.outline = '3px solid #00ff00';
          art.style.outlineOffset = '-3px';
          setTimeout(() => { art.style.outline = ''; }, 1000);
        }
      }

      // 同时发送消息和存 storage 双重保险
      chrome.runtime.sendMessage({ type: 'contextUrl', url: result.url, title: result.title || result.url });
      chrome.storage.local.set({ _pendingContext: { url: result.url, title: result.title || result.url } });
    } else {
      // 没找到：闪红色
      document.body.style.outline = '3px solid #ff0000';
      setTimeout(() => { document.body.style.outline = ''; }, 500);
    }
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
    if (t.length > bestLen && !a.href.match(/\/[^\/]+?\/(photo|video|media)\/?/)) {
      best = a;
      bestLen = t.length;
    }
  }
  if (best) return best.href;
  return all[0]?.href || null;
}

function extractFullText(container) {
  const tweetText = container.querySelector('[data-testid="tweetText"]');
  if (tweetText) return tweetText.textContent?.trim() || '';
  const postContent = container.querySelector('[data-testid="postText"], .post-content, [itemprop="articleBody"], .entry-content');
  if (postContent) return postContent.textContent?.trim() || '';
  const parts = [];
  for (const p of container.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li, [dir="auto"]')) {
    const t = (p.textContent || '').trim();
    if (t && t.length > 3) parts.push(t);
  }
  return parts.join('\n').slice(0, 1000);
}
