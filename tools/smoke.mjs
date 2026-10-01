#!/usr/bin/env node
// 端到端冒烟测试：起一个本地页面，用无头 Chromium 真的加载扩展，
// 走一遍「添加当前页 / 标记已读 / 分页 / 筛选搜索 / 两步确认」，并捕获页面异常。
//
// 注意：Chrome 137+ 不再支持 --load-extension（只剩 Chrome for Testing / Chromium 支持），
// 所以默认按 Edge → Chromium → Chrome for Testing → Chrome 的顺序找可用浏览器，
// 也可以用 SMOKE_BROWSER 指定。浏览器不支持装载时按「跳过」处理。

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EXT_DIR = fileURLToPath(new URL('..', import.meta.url));
const HTTP_PORT = Number(process.env.SMOKE_HTTP || 8791);
const CDP_PORT = Number(process.env.SMOKE_CDP || 9333);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const CANDIDATES = [
  process.env.SMOKE_BROWSER,
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
].filter(Boolean);

async function pickBrowser() {
  for (const candidate of CANDIDATES) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // 继续找下一个。
    }
  }
  return null;
}

let failures = 0;
function check(ok, label, extra = '') {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${extra ? ' -> ' + extra : ''}`);
  if (!ok) failures += 1;
}

const browserPath = await pickBrowser();
if (!browserPath) {
  console.log('跳过：没有找到 Chromium 系浏览器（可用 SMOKE_BROWSER 指定路径）');
  process.exit(0);
}
const isPlainChrome = /Google Chrome\.app/.test(browserPath) && !/for Testing/.test(browserPath);
console.log('浏览器:', browserPath);

const pageHtml = `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<title>测试文章：长文阅读</title></head><body><article><h1>长文标题</h1>
<p>一二三四五六七八九十</p></article></body></html>`;
const server = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(pageHtml);
});
await new Promise((resolve) => server.listen(HTTP_PORT, '127.0.0.1', resolve));

const profileDir = await mkdtemp(path.join(tmpdir(), 'read-later-smoke-'));
const browser = spawn(browserPath, [
  `--user-data-dir=${profileDir}`,
  `--load-extension=${EXT_DIR}`,
  `--disable-extensions-except=${EXT_DIR}`,
  `--remote-debugging-port=${CDP_PORT}`,
  '--headless=new',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-gpu',
  'about:blank',
], { stdio: 'ignore' });

async function shutdown(code) {
  browser.kill('SIGKILL');
  server.close();
  try {
    await rm(profileDir, { recursive: true, force: true });
  } catch {
    // 临时目录清不干净不影响结论。
  }
  process.exit(code);
}

const listTargets = async () => {
  try {
    return await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
  } catch {
    return null;
  }
};

let swTarget = null;
for (let attempt = 0; attempt < 40 && !swTarget; attempt++) {
  swTarget = (await listTargets())?.find(
    (target) => target.type === 'service_worker' && target.url.endsWith('/background.js'),
  );
  if (!swTarget) await wait(500);
}
if (!swTarget) {
  if (isPlainChrome) {
    console.log('跳过：该浏览器不再支持 --load-extension，请用 Edge / Chromium / Chrome for Testing');
    await shutdown(0);
  }
  console.log('FAIL 扩展没有加载起来');
  await shutdown(1);
}
const extensionId = new URL(swTarget.url).host;
console.log('OK   Service Worker 已启动, 扩展 id =', extensionId);

const exceptions = [];
async function connect(wsUrl, label) {
  const socket = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  let nextId = 0;
  const pending = new Map();
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
      return;
    }
    if (message.method === 'Runtime.exceptionThrown') {
      exceptions.push(`[${label}] ${message.params.exceptionDetails?.exception?.description || message.params.exceptionDetails?.text}`);
    }
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
      exceptions.push(`[${label}] console.error ${JSON.stringify(message.params.args?.map((arg) => arg.value ?? arg.description))}`);
    }
  };
  const send = (method, params = {}) => new Promise((resolve) => {
    const id = ++nextId;
    pending.set(id, resolve);
    socket.send(JSON.stringify({ id, method, params }));
  });
  await send('Runtime.enable');
  return {
    close: () => socket.close(),
    async evalInPage(expression) {
      const response = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      const details = response.result?.exceptionDetails;
      if (details) throw new Error(details.exception?.description || details.text || '运行时求值失败');
      return response.result?.result?.value;
    },
  };
}

// 断言前轮询：无头环境里 rAF/渲染的时序不稳定，固定 sleep 容易假失败。
async function waitFor(read, predicate, { timeoutMs = 8000, intervalMs = 200 } = {}) {
  let last;
  for (let elapsed = 0; elapsed < timeoutMs; elapsed += intervalMs) {
    last = await read();
    if (predicate(last)) return last;
    await wait(intervalMs);
  }
  return last;
}

const worker = await connect(swTarget.webSocketDebuggerUrl, 'sw');

// 1. 内容脚本注入 + 消息通道
const pageTab = await worker.evalInPage(`chrome.tabs.create({ url: 'http://127.0.0.1:${HTTP_PORT}/', active: true }).then((tab) => tab.id)`);
await wait(1500);
const contentReady = await worker.evalInPage(`chrome.tabs.sendMessage(${pageTab}, { type: 'watchPageClicks', enabled: true }).then(() => 'ok').catch((error) => error.message)`);
check(contentReady === 'ok', '内容脚本按需通信', String(contentReady));

// 2. 面板页（后台标签页打开，逻辑与侧边栏一致）
const panelUrl = `chrome-extension://${extensionId}/sidepanel/panel.html`;
const panelTab = await worker.evalInPage(`chrome.tabs.create({ url: '${panelUrl}', active: false }).then((tab) => tab.id)`);
await wait(1200);
let panelTarget = null;
for (let attempt = 0; attempt < 20 && !panelTarget; attempt++) {
  panelTarget = (await listTargets())?.find((target) => target.type === 'page' && target.url === panelUrl);
  if (!panelTarget) await wait(300);
}
const panel = await connect(panelTarget.webSocketDebuggerUrl, 'panel');
await wait(600);
check(true, '面板页面已加载');

// 3. 添加当前页：面板 -> 后台 -> 存储 -> 广播
await panel.evalInPage("document.querySelector('#addBtn').click()");
const addToast = await waitFor(
  () => panel.evalInPage("document.querySelector('#toast').textContent"),
  (text) => /已添加/.test(text),
);
check(/已添加/.test(addToast), '添加当前页有反馈', JSON.stringify(addToast));
const stored = await worker.evalInPage("chrome.storage.local.get('readLaterList').then((result) => JSON.stringify(result.readLaterList.map((item) => ({ title: item.title, url: item.url, source: item.sourceDomain }))))");
check(stored.includes('测试文章：长文阅读') && stored.includes('127.0.0.1'), '记录已写入存储', stored);

// 4. 面板可见（后台标签页里 rAF 会停摆，侧边栏本身是可见的）后再断言渲染
await worker.evalInPage(`chrome.tabs.update(${panelTab}, { active: true }).then(() => 'activated')`);
const rowCount = await waitFor(
  () => panel.evalInPage("document.querySelectorAll('.list-item').length"),
  (count) => count === 1,
);
check(rowCount === 1, '面板在变成可见后补上渲染', String(rowCount));
const rendered = JSON.parse(await panel.evalInPage(`JSON.stringify({
  rows: document.querySelectorAll('.list-item').length,
  title: document.querySelector('.list-item-title')?.textContent,
  href: document.querySelector('.list-item-title')?.href,
  tag: document.querySelector('.list-item-title')?.tagName,
  domain: document.querySelector('.list-item-domain')?.textContent,
  count: document.querySelector('#count').textContent,
})`));
check(rendered.rows === 1, '面板渲染出 1 行', JSON.stringify(rendered));
check(rendered.tag === 'A' && rendered.href === `http://127.0.0.1:${HTTP_PORT}/`, '标题是可聚焦的真链接');
check(/127\.0\.0\.1/.test(rendered.domain || ''), '域名/时间行不是空的', JSON.stringify(rendered.domain));

// 5. 标记已读：面板 -> 后台 -> 存储 + 行样式
await panel.evalInPage("document.querySelector('.list-item-read').click()");
await waitFor(
  () => panel.evalInPage("document.querySelector('.list-item')?.classList.contains('strikethrough')"),
  (struck) => struck === true,
);
const struck = JSON.parse(await panel.evalInPage(`JSON.stringify({
  cls: document.querySelector('.list-item').classList.contains('strikethrough'),
  checked: document.querySelector('.list-item-read').checked,
})`));
const storedStruck = await worker.evalInPage("chrome.storage.local.get('readLaterList').then((result) => JSON.stringify(result.readLaterList.map((item) => !!item.strikethrough)))");
check(struck.cls && struck.checked && storedStruck === '[true]', '标记已读同步到存储与 DOM', JSON.stringify(struck) + ' / ' + storedStruck);

// 6. 分页：外部写入 -> 缓存失效 -> 面板重载
const seed = JSON.stringify(Array.from({ length: 250 }, (_, index) => ({
  v: 3,
  id: `seed-${index}`,
  title: `种子文章 ${index}`,
  url: `https://example.com/post/${index}`,
  normalizedUrl: `https://example.com/post/${index}`,
  addedAt: 1_700_000_000_000 + index,
  firstAddedAt: 1_700_000_000_000 + index,
  sourceUrl: `https://example.com/post/${index}`,
  sourceTitle: `种子文章 ${index}`,
  sourceDomain: 'example.com',
  scrollPercent: index % 3 === 0 ? 40 : 0,
})));
await worker.evalInPage(`chrome.storage.local.set({ readLaterList: ${seed} }).then(() => 'seeded')`);
await panel.evalInPage('location.reload()');
await waitFor(
  () => panel.evalInPage("document.querySelectorAll('.list-item').length"),
  (count) => count === 200,
);
const before = JSON.parse(await panel.evalInPage(`JSON.stringify({
  rows: document.querySelectorAll('.list-item').length,
  more: !!document.querySelector('.list-more'),
  count: document.querySelector('#count').textContent,
})`));
await panel.evalInPage("document.querySelector('.list-more-btn').click()");
const afterRows = await waitFor(
  () => panel.evalInPage("document.querySelectorAll('.list-item').length"),
  (count) => count === 250,
);
const paged = {
  before,
  after: {
    rows: afterRows,
    more: await panel.evalInPage("!!document.querySelector('.list-more')"),
  },
};
check(paged.before.rows === 200 && paged.before.more, '首屏只渲染 200 行并给出「显示更多」', JSON.stringify(paged.before));
check(paged.before.count === '共 250 篇', '总数按整表统计', paged.before.count);
check(paged.after.rows === 250 && !paged.after.more, '点「显示更多」后补齐 250 行', JSON.stringify(paged.after));

// 7. 筛选 + 搜索
await panel.evalInPage(`(() => {
  document.querySelector('.filter-tab[data-filter="inProgress"]').click();
})()`);
const inProgressRows = await waitFor(
  () => panel.evalInPage("document.querySelectorAll('.list-item').length"),
  (count) => count === 84,
);
await panel.evalInPage(`(() => {
  const search = document.querySelector('#searchInput');
  search.value = '种子文章 249';
  search.dispatchEvent(new Event('input'));
})()`);
const searchedRows = await waitFor(
  () => panel.evalInPage("document.querySelectorAll('.list-item').length"),
  (count) => count === 1,
);
const filtered = {
  inProgress: inProgressRows,
  searched: searchedRows,
  count: await panel.evalInPage("document.querySelector('#count').textContent"),
};
check(filtered.inProgress === 84 && filtered.searched === 1, '筛选与搜索生效', JSON.stringify(filtered));

// 8. 进度条
const progressBars = await panel.evalInPage("document.querySelectorAll('.scroll-progress').length");
check(progressBars > 0, '进度条渲染', String(progressBars));

// 9. 清空是两步确认，点别处可取消
const twoStep = JSON.parse(await panel.evalInPage(`(async () => {
  const button = document.querySelector('#clearBtn');
  button.click();
  await new Promise((resolve) => setTimeout(resolve, 200));
  const armed = { text: button.textContent.trim(), confirming: button.classList.contains('confirming') };
  document.querySelector('#list').click();
  await new Promise((resolve) => setTimeout(resolve, 200));
  return JSON.stringify({ armed, reset: button.textContent.trim() });
})()`));
check(twoStep.armed.confirming && twoStep.armed.text === '确认清空？', '第一次点击进入确认态', JSON.stringify(twoStep.armed));
check(twoStep.reset === '清空全部', '点别处会取消确认', twoStep.reset);

check(exceptions.length === 0, '没有未捕获异常 / console.error', exceptions.join(' | '));

panel.close();
worker.close();
console.log(failures === 0 ? '\n冒烟测试全部通过' : `\n冒烟测试失败 ${failures} 项`);
await shutdown(failures === 0 ? 0 : 1);
