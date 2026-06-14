(function () {
  const payload = globalThis.__readLaterAnimationPayload || {};

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
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }

      .read-later-toolbar-glow {
        position: fixed;
        left: var(--target-x);
        top: 0;
        width: 34px;
        height: 4px;
        border-radius: 999px;
        background: linear-gradient(90deg, transparent, rgba(66,133,244,0.9), transparent);
        box-shadow: 0 0 18px rgba(66,133,244,0.8);
        opacity: 0;
        transform: translate(-50%, -50%) scaleX(0.45);
        animation: readLaterToolbarGlow 1.15s ease forwards;
      }

      .read-later-paper {
        position: fixed;
        left: 0;
        top: 0;
        width: 148px;
        min-height: 42px;
        padding: 9px 11px;
        border-radius: 10px;
        color: #24324a;
        background:
          linear-gradient(135deg, rgba(255,255,255,0.98), rgba(244,248,255,0.97) 48%, rgba(226,236,255,0.98)),
          repeating-linear-gradient(0deg, transparent 0 11px, rgba(66,133,244,0.08) 12px 13px);
        box-shadow: 0 16px 30px rgba(24, 52, 89, 0.18), inset 0 0 0 1px rgba(66,133,244,0.14);
        transform: translate3d(-999px, -999px, 0) rotate(-2deg) scale(1);
        transform-origin: center;
        will-change: transform, opacity, filter, border-radius;
      }

      .read-later-paper::before,
      .read-later-paper::after {
        content: "";
        position: absolute;
        inset: 0;
        border-radius: inherit;
        opacity: 0;
        pointer-events: none;
      }

      .read-later-paper::before {
        background:
          linear-gradient(58deg, transparent 48%, rgba(91, 135, 213, 0.22) 50%, transparent 53%),
          linear-gradient(132deg, transparent 45%, rgba(255, 255, 255, 0.9) 47%, transparent 51%);
        animation: readLaterFolds 1.05s ease forwards;
      }

      .read-later-paper::after {
        background: radial-gradient(circle at 50% 48%, rgba(66,133,244,0.34), transparent 57%);
        animation: readLaterPaperGlow 1.05s ease forwards;
      }

      .read-later-paper-title {
        position: relative;
        z-index: 1;
        display: block;
        overflow: hidden;
        font-size: 12px;
        font-weight: 650;
        line-height: 1.35;
        white-space: nowrap;
        text-overflow: ellipsis;
      }

      .read-later-paper-mark {
        position: relative;
        z-index: 1;
        display: block;
        margin-top: 3px;
        color: #5b6f94;
        font-size: 10px;
        letter-spacing: 0;
      }

      .read-later-spark {
        position: fixed;
        left: var(--spark-x);
        top: var(--spark-y);
        width: 6px;
        height: 6px;
        border-radius: 999px;
        background: hsl(var(--spark-hue), 92%, 62%);
        box-shadow: 0 0 10px hsl(var(--spark-hue), 92%, 62%);
        opacity: 0;
        animation: readLaterSpark 0.56s ease-out var(--spark-delay) forwards;
      }

      @keyframes readLaterToolbarGlow {
        0%, 58% { opacity: 0; transform: translate(-50%, -50%) scaleX(0.3); }
        72% { opacity: 1; transform: translate(-50%, -50%) scaleX(1); }
        100% { opacity: 0; transform: translate(-50%, -50%) scaleX(0.55); }
      }

      @keyframes readLaterFolds {
        0%, 15% { opacity: 0; }
        34%, 70% { opacity: 1; }
        100% { opacity: 0; }
      }

      @keyframes readLaterPaperGlow {
        0%, 35% { opacity: 0; }
        55% { opacity: 0.8; }
        100% { opacity: 0; }
      }

      @keyframes readLaterSpark {
        0% {
          opacity: 0;
          transform: translate(-50%, -50%) scale(0.2);
        }
        22% {
          opacity: 1;
        }
        100% {
          opacity: 0;
          transform: translate(calc(-50% + var(--spark-dx)), calc(-50% + var(--spark-dy))) scale(0.08);
        }
      }
    `;
    document.documentElement.appendChild(style);
  }

  function playReadLaterAnimation(meta) {
    ensureAnimationStyles();

    const startX = Math.min(window.innerWidth - 24, Math.max(24, Number(meta.x) || window.innerWidth / 2));
    const startY = Math.min(window.innerHeight - 24, Math.max(24, Number(meta.y) || window.innerHeight / 2));
    const targetX = Math.max(32, window.innerWidth - 62);
    const targetY = -18;

    const layer = document.createElement('div');
    layer.className = 'read-later-catch-layer';

    const toolbarGlow = document.createElement('div');
    toolbarGlow.className = 'read-later-toolbar-glow';
    toolbarGlow.style.setProperty('--target-x', `${targetX}px`);

    const paper = document.createElement('div');
    paper.className = 'read-later-paper';

    const title = document.createElement('span');
    title.className = 'read-later-paper-title';
    title.textContent = meta.label || '稍后再看';
    const mark = document.createElement('span');
    mark.className = 'read-later-paper-mark';
    mark.textContent = meta.duplicate ? '已在列表中' : '收进稍后再看';
    paper.appendChild(title);
    paper.appendChild(mark);

    layer.appendChild(toolbarGlow);
    layer.appendChild(paper);
    document.documentElement.appendChild(layer);

    animatePaperAlongCurve(paper, startX, startY, targetX, targetY);

    setTimeout(() => {
      for (let i = 0; i < 8; i++) {
        const spark = document.createElement('span');
        spark.className = 'read-later-spark';
        const angle = (Math.PI * 2 * i) / 8;
        const distance = 16 + (i % 3) * 7;
        spark.style.setProperty('--spark-x', `${targetX}px`);
        spark.style.setProperty('--spark-y', `${targetY}px`);
        spark.style.setProperty('--spark-dx', `${Math.cos(angle) * distance}px`);
        spark.style.setProperty('--spark-dy', `${Math.sin(angle) * distance}px`);
        spark.style.setProperty('--spark-delay', `${i * 0.018}s`);
        spark.style.setProperty('--spark-hue', `${205 + i * 14}`);
        layer.appendChild(spark);
      }
    }, 820);

    setTimeout(() => {
      layer.remove();
    }, 1600);
  }

  function animatePaperAlongCurve(paper, startX, startY, targetX, targetY) {
    const distanceX = targetX - startX;
    const distanceY = targetY - startY;
    const lift = Math.min(150, Math.max(70, Math.abs(distanceX) * 0.18 + Math.abs(distanceY) * 0.08));
    const controlX = startX + distanceX * 0.46;
    const controlY = Math.min(startY, targetY) - lift;
    const frames = [];

    for (let i = 0; i <= 34; i++) {
      const t = i / 34;
      const eased = easeInOutCubic(t);
      const x = quadratic(startX, controlX, targetX, eased);
      const y = quadratic(startY, controlY, targetY, eased);
      const scale = interpolateScale(eased);
      const rotate = -3 + 660 * eased;
      const opacity = eased < 0.05 ? eased / 0.05 : eased > 0.9 ? (1 - eased) / 0.1 : 1;
      const radius = eased < 0.32 ? 10 + eased * 36 : eased < 0.58 ? 22 + eased * 80 : 999;
      const blur = eased > 0.82 ? (eased - 0.82) * 3 : 0;

      frames.push({
        transform: `translate3d(${x - 74}px, ${y - 21}px, 0) rotate(${rotate}deg) scale(${scale})`,
        opacity: Math.max(0, Math.min(1, opacity)),
        borderRadius: `${radius}px`,
        filter: `saturate(${1 + eased * 0.18}) blur(${blur}px)`,
        offset: t,
      });
    }

    paper.animate(frames, {
      duration: 1180,
      easing: 'linear',
      fill: 'forwards',
    });
  }

  function quadratic(start, control, end, t) {
    return ((1 - t) ** 2 * start) + (2 * (1 - t) * t * control) + (t ** 2 * end);
  }

  function easeInOutCubic(t) {
    return t < 0.5 ? 4 * t ** 3 : 1 - ((-2 * t + 2) ** 3) / 2;
  }

  function interpolateScale(t) {
    if (t < 0.1) return 0.92 + t * 0.8;
    if (t < 0.44) return 1 - (t - 0.1) * 1.4;
    if (t < 0.72) return 0.52 - (t - 0.44) * 0.95;
    return Math.max(0.04, 0.25 - (t - 0.72) * 0.68);
  }

  playReadLaterAnimation(payload);
})();
