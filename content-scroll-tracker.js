// 滚动深度追踪脚本
// 由 background.js 注入到用户打开的稍后再看页面中
(function () {
  if (window.__readLaterTrackerLoaded) return;
  window.__readLaterTrackerLoaded = true;

  let maxScrollPercent = 0;
  let restored = false;
  let lastReportAt = 0;
  let pendingTimer = null;
  let resizeTimer = null;
  let lastFlushKey = '';
  // 恢复位置时自己调的 scrollTo 也会触发 scroll 事件，这段时间里的滚动不算用户读的。
  let programmaticUntil = 0;
  // 当前位置是恢复脚本拉过去的、用户还没自己滚过：半加载的页面会把 scrollTo 夹到底部，
  // 这时按位置量出来的 100% 是假的，也不能拿夹过的 scrollY 覆盖原来的记录。
  let positionFromRestore = false;
  // 不足一屏的页面没法用滚动衡量，只能看停留：可见时间累计够了、离开时才记为读完。
  let visibleMs = 0;
  let visibleSince = document.hidden ? null : performance.now();

  // 进度推送不能太密：后台每次都要写存储并通知侧边栏，过密会让列表不断重排。
  const REPORT_INTERVAL_MS = 400; // 与 constants.mjs 的 PROGRESS_REPORT_INTERVAL_MS 保持一致
  const RESIZE_REPORT_DELAY_MS = 500;
  const RESTORE_START_DELAY_MS = 300;
  const RESTORE_RETRY_MS = 500;
  const RESTORE_MAX_ATTEMPTS = 5;
  const RESTORE_TOLERANCE_PX = 4;
  const PROGRAMMATIC_SCROLL_MS = 120;
  const SHORT_PAGE_READ_MS = 3000;

  // 页面现在滚不动时返回 null：可能真的不足一屏，也可能懒加载还没把内容撑开，这里分不清。
  // 原来直接当 100%，后台又按最大值合并，慢页面就永远停在「读完了」。
  function getScrollPercent() {
    const scrollHeight = Math.max(
      document.documentElement.scrollHeight,
      document.body.scrollHeight
    );
    const clientHeight = window.innerHeight;
    const maxScroll = scrollHeight - clientHeight;
    if (maxScroll <= 0) return null;
    return Math.min(100, Math.round((window.scrollY / maxScroll) * 100));
  }

  function visibleTime() {
    return visibleMs + (visibleSince === null ? 0 : performance.now() - visibleSince);
  }

  function sendScrollUpdate({ flush = false } = {}) {
    if (pendingTimer !== null) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }
    const scrollY = window.scrollY;
    // 离开页面时 visibilitychange / pagehide / beforeunload 会接连触发，同样的内容只落一次盘。
    const flushKey = `${maxScrollPercent}:${scrollY}`;
    if (flush && flushKey === lastFlushKey) return;
    lastFlushKey = flush ? flushKey : '';
    lastReportAt = Date.now();
    try {
      chrome.runtime.sendMessage({
        type: 'scrollUpdate',
        percent: maxScrollPercent,
        scrollY,
        pageUrl: window.location.href,
        // 离开页面时让后台立刻落盘，其余情况交给合并窗口。
        flush,
      });
    } catch (e) {
      // 扩展上下文可能已销毁
    }
  }

  // force 只是把当前位置推一次（scrollY 照样上报），不会凭空加进度：滚不动的页面不算读完。
  function reportScroll({ force = false, flush = false } = {}) {
    if (positionFromRestore) return;
    const percent = getScrollPercent();
    const advanced = percent !== null && percent > maxScrollPercent;
    if (!advanced && !force) return;
    if (advanced) maxScrollPercent = percent;
    if (force) {
      sendScrollUpdate({ flush });
      return;
    }
    const elapsed = Date.now() - lastReportAt;
    if (elapsed >= REPORT_INTERVAL_MS) {
      sendScrollUpdate();
      return;
    }
    if (pendingTimer !== null) return;
    pendingTimer = setTimeout(() => {
      pendingTimer = null;
      reportScroll();
    }, REPORT_INTERVAL_MS - elapsed);
  }

  // 离开页面时：短页面只有「这时仍然滚不动、确实加载完了、也真的看过一会儿」才记为读完。
  function reportLeave() {
    if (getScrollPercent() === null
      && document.readyState === 'complete'
      && visibleTime() >= SHORT_PAGE_READ_MS) {
      maxScrollPercent = 100;
      sendScrollUpdate({ flush: true });
      return;
    }
    reportScroll({ force: true, flush: true });
  }

  function restoreScrollPosition() {
    if (restored) return;
    restored = true;

    const restore = window.__readLaterRestore || {};
    const targetY = Number(restore.scrollY || 0);
    const targetPercent = Number(restore.percent || 0);
    if (targetY <= 0 && targetPercent <= 0) return;
    // 100% 却从没滚过（scrollY 为 0）：短页面或旧版本误记的进度，按百分比恢复只会跳到页底。
    if (targetY <= 0 && targetPercent >= 100) return;

    let attempts = 0;
    let cancelled = false;

    const cancel = () => {
      if (cancelled) return;
      cancelled = true;
      window.removeEventListener('wheel', cancel, true);
      window.removeEventListener('touchstart', cancel, true);
      window.removeEventListener('pointerdown', cancel, true);
      window.removeEventListener('keydown', cancel, true);
      window.removeEventListener('scroll', cancelOnUserScroll, true);
    };
    // 用户自己动了就别再抢：原来这里会每 500ms 强拉一次、连拉 5 次。
    const cancelOnUserScroll = () => {
      if (performance.now() < programmaticUntil) return;
      cancel();
    };

    window.addEventListener('wheel', cancel, { capture: true, passive: true });
    window.addEventListener('touchstart', cancel, { capture: true, passive: true });
    window.addEventListener('pointerdown', cancel, true);
    window.addEventListener('keydown', cancel, true);
    window.addEventListener('scroll', cancelOnUserScroll, { capture: true, passive: true });

    const targetFor = () => {
      if (targetY > 0) return targetY;
      const scrollHeight = Math.max(
        document.documentElement.scrollHeight,
        document.body.scrollHeight
      );
      const maxScroll = Math.max(0, scrollHeight - window.innerHeight);
      return Math.round(maxScroll * Math.min(100, targetPercent) / 100);
    };

    const tryRestore = () => {
      if (cancelled) return;
      attempts += 1;
      const top = targetFor();
      // 只纠正偏差：已经到位就不动，避免把用户或站点的滚动拉回来。
      if (Math.abs(window.scrollY - top) > RESTORE_TOLERANCE_PX) {
        programmaticUntil = performance.now() + PROGRAMMATIC_SCROLL_MS;
        positionFromRestore = true;
        window.scrollTo({ top, behavior: 'auto' });
      }
      if (attempts < RESTORE_MAX_ATTEMPTS) setTimeout(tryRestore, RESTORE_RETRY_MS);
      else cancel();
    };

    setTimeout(tryRestore, RESTORE_START_DELAY_MS);
  }

  // requestAnimationFrame 节流的滚动事件
  let ticking = false;
  window.addEventListener(
    'scroll',
    () => {
      // 恢复脚本自己 scrollTo 引起的滚动不算数；用户滚过之后才重新按位置计算进度。
      if (performance.now() < programmaticUntil) return;
      positionFromRestore = false;
      if (!ticking) {
        window.requestAnimationFrame(() => {
          reportScroll();
          ticking = false;
        });
        ticking = true;
      }
    },
    { passive: true }
  );

  // 窗口大小变化（动态内容加载）：拖动窗口时 resize 会连发，这里限流。
  window.addEventListener('resize', () => {
    if (resizeTimer !== null) return;
    resizeTimer = setTimeout(() => {
      resizeTimer = null;
      reportScroll({ force: true });
    }, RESIZE_REPORT_DELAY_MS);
  }, { passive: true });

  // 页面可见性变化（切标签/关闭）：顺带累计可见时间
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (visibleSince !== null) visibleMs += performance.now() - visibleSince;
      visibleSince = null;
      reportLeave();
    } else if (visibleSince === null) {
      visibleSince = performance.now();
    }
  });

  // 页面关闭前保存（beforeunload 并不总会触发，pagehide 更可靠，两个都挂上）
  window.addEventListener('beforeunload', reportLeave);
  window.addEventListener('pagehide', reportLeave);

  // 初始报告
  restoreScrollPosition();
  setTimeout(() => reportScroll({ force: true }), 500);
})();
