(function () {
  if (globalThis.__readLaterAnimationRuntimeLoaded) return;
  globalThis.__readLaterAnimationRuntimeLoaded = true;

  // 时间轴（毫秒）：拿起 0–120 → 弧线滑行 120–570 → 穿过边界 570–760。
  // ARRIVE_MS 要与 constants.mjs 的 ADD_FLIGHT_ARRIVAL_MS 一致：面板按它推迟新行入场。
  const FLIGHT_MS = 760;
  const ARRIVE_MS = 570;
  const LIFT_AT = 120 / FLIGHT_MS;
  const APEX_AT = 320 / FLIGHT_MS;
  const ARRIVE_AT = ARRIVE_MS / FLIGHT_MS;
  const REDUCED_MS = 460;
  const CLEANUP_FALLBACK_MS = 1600;
  const CARD_MAX_WIDTH = 300;
  const CARD_HEIGHT = 62;
  // 侧边栏里新行大致的纵向位置：卡片在这个高度穿过边界，看起来就像直接落进列表。
  const PANEL_ROW_Y = 268;

  const SERIF = '"Songti SC", "Source Han Serif SC", "Noto Serif SC", "Noto Serif CJK SC", '
    + '-apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';

  // 卡片挂在 Shadow DOM 里：网页的 CSS 进不来，每个站点上长得都一样。
  const STYLES = `
    .layer {
      position: fixed;
      inset: 0;
      overflow: hidden;
      pointer-events: none;
      contain: strict;
    }
    .x, .y {
      position: absolute;
      left: 0;
      top: 0;
      will-change: transform;
    }
    .card {
      position: relative;
      box-sizing: border-box;
      display: flex;
      align-items: center;
      gap: 12px;
      height: ${CARD_HEIGHT}px;
      padding: 0 16px;
      border: 1px solid #E2DED5;
      border-radius: 12px;
      background: #F6F4EF;
      color: #1D1B18;
      box-shadow: 0 2px 6px rgba(29, 27, 24, 0.10);
      font: 400 14px/1.4 -apple-system, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
      letter-spacing: 0;
      text-align: left;
      transform-origin: 50% 50%;
      will-change: transform, opacity;
    }
    /* 「拿起」时的大阴影单独一层，只动 opacity，不逐帧重绘 box-shadow。 */
    .lift {
      position: absolute;
      inset: 0;
      border-radius: inherit;
      box-shadow: 0 22px 40px -14px rgba(29, 27, 24, 0.38);
      opacity: 0;
      will-change: opacity;
    }
    .favicon {
      flex: none;
      width: 22px;
      height: 22px;
      display: flex;
      align-items: center;
      justify-content: center;
      overflow: hidden;
      border-radius: 6px;
      background: #ECE9E2;
      color: #6B665D;
      font-size: 11px;
      font-weight: 700;
    }
    .favicon img {
      width: 16px;
      height: 16px;
    }
    .text {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .title {
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
      font-family: ${SERIF};
      font-size: 14px;
      font-weight: 500;
    }
    .meta {
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
      color: #6B665D;
      font-size: 11px;
    }
    .slit {
      position: absolute;
      right: 0;
      width: 3px;
      height: 60px;
      border-radius: 2px;
      background: #2E5E4E;
      box-shadow: 0 0 14px 2px rgba(46, 94, 78, 0.55);
      opacity: 0;
      will-change: transform, opacity;
    }
    @media (prefers-color-scheme: dark) {
      .card {
        border-color: #36332E;
        background: #272522;
        color: #ECE8E1;
        box-shadow: 0 2px 6px rgba(0, 0, 0, 0.3);
      }
      .lift { box-shadow: 0 22px 40px -14px rgba(0, 0, 0, 0.6); }
      .favicon { background: #36332E; color: #A39D93; }
      .meta { color: #A39D93; }
      .slit { background: #8DBFA8; box-shadow: 0 0 14px 2px rgba(141, 191, 168, 0.5); }
    }
  `;

  let activeAnimation = null;

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
    current.host.remove();
  }

  function schedule(callback, delay) {
    const timer = setTimeout(() => {
      activeAnimation?.timers.delete(timer);
      callback();
    }, delay);
    activeAnimation?.timers.add(timer);
    return timer;
  }

  function el(tagName, className, text) {
    const node = document.createElement(tagName);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function createFavicon(meta) {
    const box = el('span', 'favicon');
    const letter = (String(meta.domain || '')[0] || '•').toUpperCase();
    if (typeof meta.favicon === 'string' && /^(https?:|data:image\/)/.test(meta.favicon)) {
      const img = el('img');
      img.alt = '';
      img.onerror = () => { box.textContent = letter; };
      img.src = meta.favicon;
      box.appendChild(img);
    } else {
      box.textContent = letter;
    }
    return box;
  }

  function createCard(meta, width) {
    const card = el('div', 'card');
    card.style.width = `${width}px`;
    const lift = el('div', 'lift');
    const text = el('div', 'text');
    text.append(
      el('span', 'title', meta.label || '稍后再看'),
      el('span', 'meta', meta.duplicate ? '已在抽屉里 · 已置顶' : (meta.domain || '收进稍后再看')),
    );
    card.append(lift, createFavicon(meta), text);
    return { card, lift };
  }

  function clamp(value, min, max) {
    if (min > max) return (min + max) / 2;
    return Math.min(max, Math.max(min, value));
  }

  // 起点是右键位置（没有就取视口中央）；终点按侧边栏是否打开分两种。
  function flightPlan(meta, width) {
    const viewW = Math.max(1, window.innerWidth);
    const viewH = Math.max(1, window.innerHeight);
    const halfW = width / 2;
    const halfH = CARD_HEIGHT / 2;
    const startX = clamp(Number(meta.x) || viewW / 2, halfW + 8, viewW - halfW - 8);
    const startY = clamp(Number(meta.y) || viewH / 2, halfH + 8, viewH - halfH - 8);

    if (meta.panelOpen) {
      // 飞到视口右缘（侧边栏就在那里），在新行的高度穿过边界被裁掉。
      const endScale = 0.72;
      const arriveX = viewW - (width * endScale) / 2 - 2;
      const arriveY = clamp(PANEL_ROW_Y, halfH, viewH - halfH);
      const lift = clamp(Math.abs(arriveX - startX) * 0.15, 36, 100);
      return {
        startX,
        startY,
        arriveX,
        arriveY,
        apexY: Math.max(halfH, Math.min(startY, arriveY) - lift),
        exitX: arriveX + width * endScale + 24,
        exitY: arriveY,
        endScale,
        exitOpacity: 1,
        slitY: arriveY,
      };
    }

    // 侧边栏关着：朝工具栏图标的方向飞出视口顶部，图标本身由后台闪「+1」角标。
    const endScale = 0.5;
    const arriveX = viewW - 48;
    const arriveY = halfH * endScale + 10;
    return {
      startX,
      startY,
      arriveX,
      arriveY,
      apexY: Math.max(arriveY + 8, Math.min(startY, arriveY) - 60),
      exitX: arriveX + 24,
      exitY: -CARD_HEIGHT,
      endScale,
      exitOpacity: 0,
      slitY: null,
    };
  }

  function track(animation) {
    const runtime = activeAnimation;
    runtime?.animations.add(animation);
    animation.finished.then(() => runtime?.animations.delete(animation), () => {});
    return animation;
  }

  // 位移拆成 X / Y 两层，各用各的缓动，合起来就是一条自然的弧线；每层只动 transform。
  function animateFlight(parts, plan, width) {
    const { x, y, card, lift, slit } = parts;
    const halfW = width / 2;
    const halfH = CARD_HEIGHT / 2;
    const timing = { duration: FLIGHT_MS, easing: 'linear', fill: 'forwards' };
    const tx = (value) => `translate3d(${value - halfW}px, 0, 0)`;
    const ty = (value) => `translate3d(0, ${value - halfH}px, 0)`;

    const path = track(x.animate([
      { offset: 0, transform: tx(plan.startX) },
      { offset: LIFT_AT, transform: tx(plan.startX), easing: 'cubic-bezier(.45, 0, .3, 1)' },
      { offset: ARRIVE_AT, transform: tx(plan.arriveX), easing: 'cubic-bezier(.55, 0, 1, 1)' },
      { offset: 1, transform: tx(plan.exitX) },
    ], timing));

    track(y.animate([
      { offset: 0, transform: ty(plan.startY), easing: 'cubic-bezier(.2, .7, .4, 1)' },
      { offset: LIFT_AT, transform: ty(plan.startY - 8), easing: 'cubic-bezier(.25, .6, .45, 1)' },
      { offset: APEX_AT, transform: ty(plan.apexY), easing: 'cubic-bezier(.5, 0, .5, 1)' },
      { offset: ARRIVE_AT, transform: ty(plan.arriveY), easing: 'cubic-bezier(.55, 0, 1, 1)' },
      { offset: 1, transform: ty(plan.exitY) },
    ], timing));

    const midScale = (1 + plan.endScale) / 2 + 0.05;
    track(card.animate([
      { offset: 0, opacity: 0, transform: 'scale(.94)', easing: 'cubic-bezier(.2, .8, .2, 1)' },
      { offset: 0.06, opacity: 1, transform: 'scale(.99) rotate(-.4deg)' },
      { offset: LIFT_AT, opacity: 1, transform: 'scale(1.04) rotate(-1.5deg)', easing: 'cubic-bezier(.4, 0, .4, 1)' },
      { offset: 0.55, opacity: 1, transform: `scale(${midScale}) rotate(2deg)` },
      { offset: ARRIVE_AT, opacity: 1, transform: `scale(${plan.endScale}) rotate(0deg)` },
      { offset: 1, opacity: plan.exitOpacity, transform: `scale(${plan.endScale}) rotate(0deg)` },
    ], timing));

    track(lift.animate([
      { offset: 0, opacity: 0 },
      { offset: LIFT_AT, opacity: 1 },
      { offset: ARRIVE_AT, opacity: 0.3 },
      { offset: 1, opacity: 0.3 },
    ], timing));

    if (slit) {
      track(slit.animate([
        { offset: 0, opacity: 0, transform: 'scaleY(.3)' },
        { offset: 0.68, opacity: 0, transform: 'scaleY(.3)' },
        { offset: 0.8, opacity: 1, transform: 'scaleY(1)' },
        { offset: 1, opacity: 0, transform: 'scaleY(1.15)' },
      ], timing));
    }

    return path;
  }

  // 减少动态效果：不飞行，只在落点附近淡入淡出一下。
  function animateReduced(parts, plan, width) {
    const { x, y, card } = parts;
    const timing = { duration: REDUCED_MS, easing: 'ease-out', fill: 'forwards' };
    const restX = Math.min(plan.arriveX, window.innerWidth - width / 2 - 12);
    const restY = Math.max(plan.arriveY, CARD_HEIGHT / 2 + 12);
    x.style.transform = `translate3d(${restX - width / 2}px, 0, 0)`;
    y.style.transform = `translate3d(0, ${restY - CARD_HEIGHT / 2}px, 0)`;
    return track(card.animate([
      { opacity: 0 },
      { opacity: 1, offset: 0.28 },
      { opacity: 1, offset: 0.72 },
      { opacity: 0 },
    ], timing));
  }

  function playReadLaterAnimation(meta) {
    cleanupAnimation();
    if (document.hidden) return;

    const width = Math.max(160, Math.min(CARD_MAX_WIDTH, window.innerWidth - 32));
    const plan = flightPlan(meta, width);
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const host = document.createElement('read-later-flight');
    host.dataset.animationId = meta.animationId || '';
    host.setAttribute('style', 'all: initial; position: fixed; inset: 0; z-index: 2147483647; pointer-events: none; display: block;');
    const root = host.attachShadow({ mode: 'open' });
    const style = el('style');
    style.textContent = STYLES;
    const layer = el('div', 'layer');
    const x = el('div', 'x');
    const y = el('div', 'y');
    const { card, lift } = createCard(meta, width);
    y.appendChild(card);
    x.appendChild(y);
    layer.appendChild(x);

    let slit = null;
    if (plan.slitY !== null && !reducedMotion) {
      slit = el('div', 'slit');
      slit.style.top = `${plan.slitY - 30}px`;
      layer.appendChild(slit);
    }
    root.append(style, layer);
    // 优先挂到 body：有些站点会给 html 设置 filter/transform，那会把 fixed 定位变成相对定位。
    (document.body || document.documentElement).appendChild(host);

    activeAnimation = { host, timers: new Set(), animations: new Set() };
    const parts = { x, y, card, lift, slit };
    const animation = reducedMotion ? animateReduced(parts, plan, width) : animateFlight(parts, plan, width);

    // 动画真正结束就立刻清理；兜底计时器防止 finished 永远不落定（例如后台标签页）。
    let cleaned = false;
    const finish = () => {
      if (cleaned) return;
      cleaned = true;
      if (activeAnimation && activeAnimation.host === host) cleanupAnimation();
    };
    animation.finished.then(finish, () => {});
    schedule(finish, CLEANUP_FALLBACK_MS);
  }

  // 必须明确回话：页面上常驻的 content-context.js 也在监听消息，
  // 只看 sendMessage 成功与否，会误以为动画脚本已经在了。
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type !== 'playAddAnimation') return;
    playReadLaterAnimation(message);
    sendResponse({ played: true });
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) cleanupAnimation();
  });
  window.addEventListener('pagehide', cleanupAnimation);
})();
