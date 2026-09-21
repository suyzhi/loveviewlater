(function () {
  if (globalThis.__readLaterAnimationRuntimeLoaded) return;
  globalThis.__readLaterAnimationRuntimeLoaded = true;

  const PAPER_WIDTH = 148;
  const PAPER_HEIGHT = 42;
  const SPARK_COUNT = 8;

  let activeAnimation = null;

  function ensureAnimationStyles() {
    if (document.getElementById('read-later-catch-style')) return;
    const style = document.createElement('style');
    style.id = 'read-later-catch-style';
    style.textContent = `
      .read-later-catch-layer {
        position: fixed;
        inset: 0;
        z-index: 2147483647;
        pointer-events: none;
        overflow: hidden;
        contain: layout style paint;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      /* 外层只做位移/旋转，内层只做圆角与透明度：把逐帧重绘从路径动画里剥离出来。 */
      .read-later-paper-plane {
        position: fixed;
        left: 0;
        top: 0;
        pointer-events: none;
        will-change: transform;
      }
      .read-later-toolbar-glow {
        position: fixed;
        left: var(--target-x);
        top: 0;
        width: 34px;
        height: 4px;
        border-radius: 999px;
        background: linear-gradient(90deg, transparent, rgba(66,133,244,0.9), transparent);
        box-shadow: 0 0 12px rgba(66,133,244,0.75);
        opacity: 0;
        transform: translate(-50%, -50%) scaleX(0.45);
        animation: readLaterToolbarGlow 1.05s ease forwards;
      }
      .read-later-paper {
        position: relative;
        width: min(${PAPER_WIDTH}px, calc(100vw - 24px));
        min-height: ${PAPER_HEIGHT}px;
        padding: 9px 11px;
        border-radius: 10px;
        color: #24324a;
        background:
          linear-gradient(135deg, rgba(255,255,255,0.98), rgba(244,248,255,0.97) 48%, rgba(226,236,255,0.98)),
          repeating-linear-gradient(0deg, transparent 0 11px, rgba(66,133,244,0.08) 12px 13px);
        box-shadow: 0 10px 22px rgba(24,52,89,0.16), inset 0 0 0 1px rgba(66,133,244,0.14);
        transform-origin: center;
      }
      .read-later-spark {
        position: fixed;
        left: var(--spark-x);
        top: var(--spark-y);
        width: 6px;
        height: 6px;
        border-radius: 999px;
        background: hsl(var(--spark-hue), 92%, 62%);
        box-shadow: 0 0 7px hsl(var(--spark-hue), 92%, 62%);
        opacity: 0;
        will-change: transform, opacity;
      }
      @keyframes readLaterToolbarGlow {
        0%, 58% { opacity: 0; transform: translate(-50%, -50%) scaleX(0.3); }
        72% { opacity: 1; transform: translate(-50%, -50%) scaleX(1); }
        100% { opacity: 0; transform: translate(-50%, -50%) scaleX(0.55); }
      }
      @media (prefers-reduced-motion: reduce) {
        .read-later-toolbar-glow {
          animation: none !important;
        }
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function cleanupAnimation() {
    if (!activeAnimation) return;
    const current = activeAnimation;
    activeAnimation = null;
    for (const timer of current.timers) clearTimeout(timer);
    current.timers.clear();
    for (const animation of current.animations) {
      try {
        animation.cancel();
      } catch {
        // 动画可能已经结束。
      }
    }
    current.animations.clear();
    current.layer.remove();
  }

  function schedule(callback, delay) {
    const timer = setTimeout(() => {
      activeAnimation?.timers.delete(timer);
      callback();
    }, delay);
    activeAnimation?.timers.add(timer);
    return timer;
  }

  function createPaper(meta) {
    const paper = document.createElement('div');
    paper.className = 'read-later-paper';
    const title = document.createElement('span');
    title.className = 'read-later-paper-title';
    title.textContent = meta.label || '稍后再看';
    const mark = document.createElement('span');
    mark.className = 'read-later-paper-mark';
    mark.textContent = meta.duplicate ? '已在列表中 · 已置顶' : '收进稍后再看';
    paper.append(title, mark);
    return paper;
  }

  function playReadLaterAnimation(meta) {
    cleanupAnimation();
    if (document.hidden) return;
    ensureAnimationStyles();

    const width = Math.max(1, window.innerWidth);
    const height = Math.max(1, window.innerHeight);
    const startX = Math.min(width - 24, Math.max(24, Number(meta.x) || width / 2));
    const startY = Math.min(height - 24, Math.max(24, Number(meta.y) || height / 2));
    const targetX = width < 64 ? width / 2 : width - 28;
    const targetY = -12;

    const layer = document.createElement('div');
    layer.className = 'read-later-catch-layer';
    layer.dataset.animationId = meta.animationId || '';

    const toolbarGlow = document.createElement('div');
    toolbarGlow.className = 'read-later-toolbar-glow';
    toolbarGlow.style.setProperty('--target-x', `${targetX}px`);

    const plane = document.createElement('div');
    plane.className = 'read-later-paper-plane';
    const paper = createPaper(meta);
    plane.appendChild(paper);

    layer.append(toolbarGlow, plane);
    // 优先挂到 body：有些站点会给 html 设置 filter/transform，那会把 fixed 定位变成相对定位。
    (document.body || document.documentElement).appendChild(layer);

    activeAnimation = { layer, timers: new Set(), animations: new Set() };
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // 测量一次纸张尺寸，避免依赖写死的宽高常量。
    let paperWidth = PAPER_WIDTH;
    let paperHeight = PAPER_HEIGHT;
    try {
      const measured = paper.getBoundingClientRect();
      if (measured.width > 0) paperWidth = measured.width;
      if (measured.height > 0) paperHeight = measured.height;
    } catch {
      // 保留默认尺寸。
    }
    const offsetX = paperWidth / 2;
    const offsetY = paperHeight / 2;

    const animation = reducedMotion
      ? animateReducedMotion(plane, offsetX, offsetY, targetX, meta.duplicate)
      : animatePaperAlongCurve(plane, paper, offsetX, offsetY, startX, startY, targetX, targetY);
    activeAnimation.animations.add(animation);

    if (!reducedMotion) {
      // 火花在纸张接近收敛时出现，用负延迟一次性派发，避免 8 个独立计时器。
      schedule(() => addSparks(layer, targetX, targetY), 760);
    }

    // 动画真正结束就立刻清理；兜底计时器防止 finished 永远不落定（例如后台标签页）。
    let cleaned = false;
    const finish = () => {
      if (cleaned) return;
      cleaned = true;
      if (activeAnimation && activeAnimation.layer === layer) cleanupAnimation();
    };
    animation.finished.then(finish, () => {});
    schedule(finish, 1600);
  }

  function animateReducedMotion(plane, offsetX, offsetY, targetX, duplicate) {
    const baseX = targetX - offsetX;
    const baseY = 12 - offsetY;
    return plane.animate([
      { transform: `translate3d(${baseX}px, ${baseY}px, 0) scale(0.96)`, opacity: 0 },
      { transform: `translate3d(${baseX}px, ${baseY}px, 0) scale(1)`, opacity: 1, offset: 0.28 },
      { transform: `translate3d(${baseX}px, ${baseY}px, 0) scale(1)`, opacity: 1, offset: 0.72 },
      { transform: `translate3d(${baseX}px, ${baseY - 4}px, 0) scale(${duplicate ? 0.98 : 1})`, opacity: 0 },
    ], { duration: 460, easing: 'ease-out', fill: 'forwards' });
  }

  function addSparks(layer, targetX, targetY) {
    if (!activeAnimation || activeAnimation.layer !== layer) return;
    const runtime = activeAnimation;
    for (let i = 0; i < SPARK_COUNT; i++) {
      const spark = document.createElement('span');
      spark.className = 'read-later-spark';
      const angle = (Math.PI * 2 * i) / SPARK_COUNT;
      const distance = 16 + (i % 3) * 7;
      const dx = Math.cos(angle) * distance;
      const dy = Math.sin(angle) * distance;
      spark.style.setProperty('--spark-x', `${targetX}px`);
      spark.style.setProperty('--spark-y', `${targetY}px`);
      spark.style.setProperty('--spark-hue', `${205 + i * 14}`);
      spark.style.transform = `translate3d(${-3 + dx * 0.35}px, ${-3 + dy * 0.35}px, 0) scale(0.45)`;
      spark.style.opacity = '0';
      layer.appendChild(spark);
      const animation = spark.animate([
        { transform: `translate3d(${-3 + dx * 0.35}px, ${-3 + dy * 0.35}px, 0) scale(0.45)`, opacity: 0 },
        { transform: `translate3d(${-3 + dx * 0.4}px, ${-3 + dy * 0.4}px, 0) scale(0.7)`, opacity: 1, offset: 0.25 },
        { transform: `translate3d(${-3 + dx}px, ${-3 + dy}px, 0) scale(0.8)`, opacity: 0 },
      ], { duration: 480, delay: i * 18, easing: 'cubic-bezier(.2,.7,.3,1)', fill: 'forwards' });
      runtime.animations.add(animation);
      animation.finished.then(
        () => runtime.animations.delete(animation),
        () => runtime.animations.delete(animation)
      );
    }
  }

  function animatePaperAlongCurve(plane, paper, offsetX, offsetY, startX, startY, targetX, targetY) {
    const distanceX = targetX - startX;
    const distanceY = targetY - startY;
    const lift = Math.min(150, Math.max(70, Math.abs(distanceX) * 0.18 + Math.abs(distanceY) * 0.08));
    const controlX = startX + distanceX * 0.46;
    const controlY = Math.min(startY, targetY) - lift;
    const baseX = -offsetX;
    const baseY = -offsetY;

    const frames = [];
    const radiusFrames = [];
    let needsSquash = false;

    for (let i = 0; i <= 34; i++) {
      const t = i / 34;
      const eased = t < 0.5 ? 4 * t ** 3 : 1 - ((-2 * t + 2) ** 3) / 2;
      const x = quadratic(startX, controlX, targetX, eased);
      const y = quadratic(startY, controlY, targetY, eased);
      const sx = interpolateScaleX(eased);
      const sy = interpolateScaleY(eased);
      if (Math.abs(sx - 1) > 0.002 || Math.abs(sy - 1) > 0.002) needsSquash = true;
      frames.push({
        transform: `translate3d(${baseX + x}px, ${baseY + y}px, 0) rotate(${-3 + 660 * eased}deg) scale(${sx}, ${sy})`,
        opacity: clamp01(eased < 0.05 ? eased / 0.05 : eased > 0.9 ? (1 - eased) / 0.1 : 1),
        offset: t,
      });
      radiusFrames.push({
        borderRadius: `${interpolateRadius(eased)}px`,
        offset: t,
      });
    }

    if (needsSquash) {
      // 外层只跑路径，内层贴着轨迹做轻微的挤压/拉伸，两者合起来就是原来的形变。
      const squash = paper.animate(
        frames.map((frame, index) => {
          const sx = interpolateScaleX(index / 34);
          const sy = interpolateScaleY(index / 34);
          return {
            transform: `scale(${sx / Math.max(sx, 1)}, ${sy / Math.max(sy, 1)})`,
            offset: frame.offset,
          };
        }),
        { duration: 1080, easing: 'linear', fill: 'forwards' }
      );
      activeAnimation?.animations.add(squash);
      squash.finished.then(() => activeAnimation?.animations.delete(squash), () => {});
    }

    const path = plane.animate(
      frames.map(({ transform, opacity, offset }) => ({ transform, opacity, offset })),
      { duration: 1080, easing: 'linear', fill: 'forwards' }
    );
    const shape = paper.animate(radiusFrames, { duration: 1080, easing: 'linear', fill: 'forwards' });
    activeAnimation?.animations.add(shape);
    shape.finished.then(() => activeAnimation?.animations.delete(shape), () => {});
    return path;
  }

  function quadratic(start, control, end, t) {
    return ((1 - t) ** 2 * start) + (2 * (1 - t) * t * control) + (t ** 2 * end);
  }

  function interpolateScaleX(t) {
    if (t < 0.1) return 0.92 + t * 0.8;
    if (t < 0.44) return 1 - (t - 0.1) * 1.4;
    if (t < 0.72) return 0.52 - (t - 0.44) * 0.95;
    return Math.max(0.04, 0.25 - (t - 0.72) * 0.68);
  }

  function interpolateScaleY(t) {
    if (t < 0.12) return 1.06 - t * 0.4;
    if (t < 0.5) return 1 + (t - 0.12) * 0.5;
    if (t < 0.78) return 1.19 - (t - 0.5) * 1.5;
    return Math.max(0.35, 0.77 - (t - 0.78) * 1.4);
  }

  function interpolateRadius(t) {
    if (t < 0.32) return 10 + t * 36;
    if (t < 0.58) return 22 + t * 80;
    return 999;
  }

  function clamp01(value) {
    return Math.max(0, Math.min(1, value));
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'playAddAnimation') playReadLaterAnimation(message);
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) cleanupAnimation();
  });
  window.addEventListener('pagehide', cleanupAnimation);
})();
