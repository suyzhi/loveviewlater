import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const panelScript = readFileSync(new URL('../sidepanel/panel.js', import.meta.url), 'utf8');
const panelStyles = readFileSync(new URL('../sidepanel/panel.css', import.meta.url), 'utf8');

test('read titles remain plain text instead of fixed per-line DOM', () => {
  assert.doesNotMatch(panelScript, /splitStrikethroughLines|createElement\(['"]s['"]\)/);
  assert.match(panelStyles, /box-decoration-break:\s*clone/);
});

test('panel entrance animation is explicitly replayed when the panel becomes visible', () => {
  assert.match(panelScript, /function restartPanelEnterAnimation/);
  assert.match(panelScript, /visibilitychange/);
  assert.match(panelStyles, /#app\.panel-enter[\s\S]*animation:\s*slideIn/);
});

test('list rows are reused by id instead of being rebuilt on every render', () => {
  // 不变量：重绘时沿用已有节点，才能保住正在跑的动画与焦点。
  assert.match(panelScript, /function patchRow\(li, item\)/);
  assert.match(panelScript, /existing\.delete\(item\.id\)/);
  assert.doesNotMatch(panelScript, /elements\.list\.innerHTML = ''[\s\S]{0,800}visibleList\.forEach/);
});

test('row animations are coalesced into one frame and cannot stack on the same row', () => {
  // 不变量：所有 DOM 变更走同一个 rAF 队列；同一行的新动画先取消旧动画。
  assert.match(panelScript, /function queueFrame\(callback\)/);
  assert.match(panelScript, /function flushFrameQueue\(\)/);
  assert.match(panelScript, /queue\(creator\) \{[\s\S]{0,80}this\.cancel\(\)/);
  assert.doesNotMatch(panelScript, /animateListMovement/);
});

test('row flipping only changes transform and skips work already in flight', () => {
  const flip = panelScript.match(/function shiftAnimation\(el, dy\)[\s\S]*?\n\}/);
  assert.ok(flip, 'shiftAnimation 应该存在');
  assert.match(flip[0], /translateY\(/);
  assert.doesNotMatch(flip[0], /translate\(/);
  assert.doesNotMatch(flip[0], /opacity/);
});

test('strikethrough motion is driven by WAAPI, not a competing CSS keyframe animation', () => {
  const strike = panelScript.match(/function playStrikeAnimation\(li, struck\)[\s\S]*?\n\}/);
  assert.ok(strike, 'playStrikeAnimation 应该存在');
  assert.match(strike[0], /titleEl\.animate\(/);
  assert.match(strike[0], /backgroundSize: `\$\{percent\}% 1\.4em`/);
  // 反向动画自带背景图，否则取消已读时会直接消失而不是滑走。
  assert.match(strike[0], /backgroundImage: STRIKE_LINE_IMAGE/);
  assert.doesNotMatch(panelStyles, /@keyframes\s+strikeLine/);
  // 静态外观仍由 class 提供，减少动态效果时直接呈现完整删除线。
  assert.match(panelStyles, /\.list-item\.strikethrough \.list-item-title[\s\S]{0,400}background-size:\s*100%\s*1\.4em/);
  assert.match(panelStyles, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.list-item\.strikethrough \.list-item-title/);
});

test('delete confirmation stays above neighbouring rows', () => {
  const rule = panelStyles.match(/\.list-item:has\(\.list-item-delete\.confirming\)\s*\{[^}]*\}/);
  assert.ok(rule, '确认态应有独立的层叠规则');
  assert.match(rule[0], /z-index:\s*2/);
  assert.doesNotMatch(panelStyles, /\.list-item\s*\{[^}]*will-change:\s*transform/);
});

test('scroll progress no longer re-sorts the list on every update', () => {
  assert.match(panelScript, /function patchProgressRow\(itemId\)/);
  assert.match(panelScript, /visibleSignature\(\) !== renderedSignature/);
});

test('page-side add animation keeps per-frame paint work off the flight path', () => {
  const source = readFileSync(new URL('../content-add-animation.js', import.meta.url), 'utf8');
  const path = source.match(/function animatePaperAlongCurve\([\s\S]*?\n {2}\}\n/);
  assert.ok(path, 'animatePaperAlongCurve 应该存在');
  // 路径帧里只允许 transform / opacity；圆角动画拆到 paper 上单独跑。
  const planes = [...path[0].matchAll(/plane\.animate\(([\s\S]*?)\n {4}\); ?/g)].map((match) => match[1]);
  assert.ok(planes.length > 0, '路径动画应该挂在外层元素上');
  for (const frames of planes) {
    assert.doesNotMatch(frames, /borderRadius/);
    assert.doesNotMatch(frames, /filter|blur\(/);
  }
  assert.match(path[0], /paper\.animate\(radiusFrames/);
  // 火花用负延迟一次性派发，不再各自挂独立计时器，也不再逐帧改 box-shadow。
  assert.doesNotMatch(source, /--spark-delay/);
  assert.match(source, /duration: 480, delay: i \* 18/);
});
