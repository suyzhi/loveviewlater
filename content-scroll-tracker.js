// 滚动深度追踪脚本
// 由 background.js 注入到用户打开的稍后再看页面中
(function () {
  if (window.__readLaterTrackerLoaded) return;
  window.__readLaterTrackerLoaded = true;

  let maxScrollPercent = 0;
  let restored = false;

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

  function reportScroll(force = false) {
    const percent = getScrollPercent();
    if (percent > maxScrollPercent || force) {
      maxScrollPercent = percent;
      try {
        chrome.runtime.sendMessage({
          type: 'scrollUpdate',
          percent: maxScrollPercent,
          scrollY: window.scrollY,
        });
      } catch (e) {
        // 扩展上下文可能已销毁
      }
    }
  }

  function restoreScrollPosition() {
    if (restored) return;
    restored = true;

    const restore = window.__readLaterRestore || {};
    const targetY = Number(restore.scrollY || 0);
    const targetPercent = Number(restore.percent || 0);
    if (targetY <= 0 && targetPercent <= 0) return;

    const getTargetY = () => {
      if (targetY > 0) return targetY;
      const scrollHeight = Math.max(
        document.documentElement.scrollHeight,
        document.body.scrollHeight
      );
      const maxScroll = Math.max(0, scrollHeight - window.innerHeight);
      return Math.round(maxScroll * Math.min(100, targetPercent) / 100);
    };

    let attempts = 0;
    const tryRestore = () => {
      attempts += 1;
      window.scrollTo({ top: getTargetY(), behavior: 'auto' });
      if (attempts < 5) setTimeout(tryRestore, 500);
    };

    setTimeout(tryRestore, 300);
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

  // 窗口大小变化（动态内容加载）
  window.addEventListener('resize', reportScroll, { passive: true });

  // 页面可见性变化（切标签/关闭）
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) reportScroll(true);
  });

  // 页面关闭前保存
  window.addEventListener('beforeunload', () => reportScroll(true));

  // 初始报告
  restoreScrollPosition();
  setTimeout(reportScroll, 500);
})();
