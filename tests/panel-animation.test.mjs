import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const panelScript = readFileSync(new URL('../sidepanel/panel.js', import.meta.url), 'utf8');
const panelStyles = readFileSync(new URL('../sidepanel/panel.css', import.meta.url), 'utf8');

test('read titles remain plain text instead of fixed per-line DOM', () => {
  assert.doesNotMatch(panelScript, /splitStrikethroughLines|createElement\(['"]s['"]\)/);
  assert.match(panelStyles, /box-decoration-break:\s*clone/);
  // 标题的父容器若是 flex/grid，标题会被块级化，删除线只画在第一行。
  const content = panelStyles.match(/\.list-item-content\s*\{[^}]*\}/);
  assert.ok(content, '.list-item-content 规则应该存在');
  assert.doesNotMatch(content[0], /display:\s*(inline-)?(flex|grid)/);
  assert.match(panelStyles, /\.list-item-title\s*\{[^}]*display:\s*inline;/);
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
  const flip = panelScript.match(/function shiftAnimation\(el, dy[^)]*\)[\s\S]*?\n\}/);
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
  // 帧里不动阴影、圆角、滤镜：大阴影是单独一层，只改它的 opacity。
  const frames = [...source.matchAll(/\.animate\(\[([\s\S]*?)\], /g)].map((match) => match[1]);
  assert.ok(frames.length >= 4, '应该抓到各层的关键帧');
  for (const body of frames) {
    assert.doesNotMatch(body, /boxShadow|borderRadius|filter|blur\(/);
  }
  assert.match(source, /\.lift\s*\{[\s\S]*?box-shadow/);
  // 不再有彩色火花和工具栏光条。
  assert.doesNotMatch(source, /spark|toolbar-glow/i);
});

test('panel delays the new row until the page-side card arrives', () => {
  assert.match(panelScript, /function arrivalAnimation\(el, delay\)/);
  assert.match(panelScript, /function takeArrival\(nodes\)/);
  assert.match(panelScript, /shiftAnimation\(el, dy, shiftDelay\)/);
  const constants = readFileSync(new URL('../constants.mjs', import.meta.url), 'utf8');
  const content = readFileSync(new URL('../content-add-animation.js', import.meta.url), 'utf8');
  const shared = Number(/ADD_FLIGHT_ARRIVAL_MS = (\d+)/.exec(constants)[1]);
  const local = Number(/const ARRIVE_MS = (\d+)/.exec(content)[1]);
  assert.equal(local, shared, '内容脚本与面板对「卡片几时到达」的约定要一致');
});

test('multi-line strikethrough draws line by line, then settles back to clone', () => {
  const strike = panelScript.match(/function playStrikeAnimation\(li, struck\)[\s\S]*?\n\}/)[0];
  // slice 把折行的几段当成一长条：宽度增长时自然是逐行划过去。
  assert.match(strike, /setProperty\('box-decoration-break', 'slice'\)/);
  assert.match(strike, /getClientRects\(\)\.length/);
  const clear = panelScript.match(/function clearStrikeInline\(titleEl\)[\s\S]*?\n\}/)[0];
  assert.match(clear, /removeProperty\('box-decoration-break'\)/);
});

test('closing keeps the text-reflow collapse and hands the frame back to the browser', () => {
  // 「文字流」：宽度过渡收到 0，文字逐帧重新折行——这是刻意保留的效果，别换成整体平移。
  assert.match(panelStyles, /#app\s*\{[^}]*transition:[^}]*width 0\.42s/);
  assert.match(panelScript, /app\.style\.width = '0px'/);
  assert.match(panelScript, /e\.propertyName === 'width'/);
  assert.match(panelScript, /chrome\.sidePanel\.close\(\{ windowId: panelWindowId \}\)/);
});

test('current-page card repaints even when callers already swapped viewState.list', () => {
  const render = panelScript.match(/function renderList\(list = viewState\.list\) \{[\s\S]*?\n\}/)[0];
  assert.match(render, /list !== savedUrls\.list/);
  assert.doesNotMatch(render, /list !== viewState\.list/);
});
