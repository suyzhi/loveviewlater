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

  // 进度推送不能太密：后台每次都要写存储并通知侧边栏，过密会让列表不断重排。
  const REPORT_INTERVAL_MS = 400; // 与 constants.mjs 的 PROGRESS_REPORT_INTERVAL_MS 保持一致
  const RESIZE_REPORT_DELAY_MS = 500;
  const RESTORE_START_DELAY_MS = 300;
  const RESTORE_RETRY_MS = 500;
  const RESTORE_MAX_ATTEMPTS = 5;
  const RESTORE_TOLERANCE_PX = 4;

  function getScrollPercent() {
    const scrollHeight = Math.max(
      document.documentElement.scrollHeight,
      document.body.scrollHeight
    );
    const clientHeight = window.innerHeight;
    const maxScroll = scrollHeight - clientHeight;
    if (maxScroll <= 0) return 100; // 内容不足一屏 = 100%
    return Math.min(100, Math.round((window.scrollY / maxScroll) * 100));
  }

  function sendScrollUpdate({ flush = false } = {}) {
    if (pendingTimer !== null) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }
    lastReportAt = Date.now();
    try {
      chrome.runtime.sendMessage({
        type: 'scrollUpdate',
        percent: maxScrollPercent,
        scrollY: window.scrollY,
        pageUrl: window.location.href,
        // 离开页面时让后台立刻落盘，其余情况交给合并窗口。
        flush,
      });
    } catch (e) {
      // 扩展上下文可能已销毁
    }
  }

  function reportScroll({ force = false, flush = false } = {}) {
    const percent = getScrollPercent();
    if (percent <= maxScrollPercent && !force) return;
    maxScrollPercent = Math.max(maxScrollPercent, percent);
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

  function restoreScrollPosition() {
    if (restored) return;
    restored = true;

    const restore = window.__readLaterRestore || {};
    const targetY = Number(restore.scrollY || 0);
    const targetPercent = Number(restore.percent || 0);
    if (targetY <= 0 && targetPercent <= 0) return;

    let attempts = 0;
    let cancelled = false;
    let programmaticUntil = 0;

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
        programmaticUntil = performance.now() + 120;
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

  // 页面可见性变化（切标签/关闭）
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) reportScroll({ force: true, flush: true });
  });

  // 页面关闭前保存
  window.addEventListener('beforeunload', () => reportScroll({ force: true, flush: true }));

  // 初始报告
  restoreScrollPosition();
  setTimeout(() => reportScroll({ force: true }), 500);
})();
