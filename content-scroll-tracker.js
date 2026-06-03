// 滚动深度追踪脚本
// 由 background.js 注入到用户打开的稍后再看页面中
(function () {
  let maxScrollPercent = 0;

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

  function reportScroll() {
    const percent = getScrollPercent();
    if (percent > maxScrollPercent) {
      maxScrollPercent = percent;
      try {
        chrome.runtime.sendMessage({ type: 'scrollUpdate', percent: maxScrollPercent });
      } catch (e) {
        // 扩展上下文可能已销毁
      }
    }
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
    if (document.hidden) reportScroll();
  });

  // 页面关闭前保存
  window.addEventListener('beforeunload', reportScroll);

  // 初始报告
  setTimeout(reportScroll, 500);
})();
