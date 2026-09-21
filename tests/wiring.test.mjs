import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('..', import.meta.url);
const read = (file) => readFile(new URL(file, root), 'utf8');

// 扩展没有构建步骤，改坏引用只有运行时才会发现，这几条测试把接线关系钉住。

test('manifest 引用的文件都存在', async () => {
  const manifest = JSON.parse(await read('manifest.json'));
  assert.equal(manifest.manifest_version, 3);
  const files = [
    manifest.background.service_worker,
    manifest.side_panel.default_path,
    ...Object.values(manifest.icons),
    ...Object.values(manifest.action.default_icon),
    ...manifest.content_scripts.flatMap((entry) => entry.js),
  ];
  for (const file of files) {
    await assert.doesNotReject(() => read(file), `manifest 引用了不存在的文件：${file}`);
  }
});

test('面板脚本用到的元素 id 都在 panel.html 里', async () => {
  const [script, html] = await Promise.all([
    read('sidepanel/panel.js'),
    read('sidepanel/panel.html'),
  ]);
  const ids = [...script.matchAll(/getElementById\('([^']+)'\)/g)].map((match) => match[1]);
  assert.ok(ids.length > 10, '应该抓到了面板元素');
  for (const id of ids) {
    assert.match(html, new RegExp(`id="${id}"`), `panel.html 里缺少 #${id}`);
  }
});

test('跨模块 import 的名字都真的被导出', async () => {
  const exportedOf = async (file) => {
    const source = await read(file);
    const names = new Set();
    for (const match of source.matchAll(/export (?:async )?(?:function|const|let|class)\s+([A-Za-z0-9_$]+)/g)) {
      names.add(match[1]);
    }
    return names;
  };
  const exports = new Map([
    ['./core.mjs', await exportedOf('core.mjs')],
    ['./constants.mjs', await exportedOf('constants.mjs')],
  ]);

  for (const file of ['background.js', 'sidepanel/panel.js']) {
    const source = await read(file);
    const isPanel = file.startsWith('sidepanel/');
    for (const match of source.matchAll(/import \{([^}]+)\} from '(\.\.?\/[^']+)'/g)) {
      const specifier = isPanel ? match[2].replace('../', './') : match[2];
      const available = exports.get(specifier);
      assert.ok(available, `${file} 引入了未登记的模块 ${match[2]}`);
      for (const rawName of match[1].split(',')) {
        const name = rawName.trim();
        if (!name) continue;
        assert.ok(available.has(name), `${file} 引用了 ${specifier} 未导出的 ${name}`);
      }
    }
  }
});

test('面板和内容脚本发出的消息类型，后台都有分支处理', async () => {
  const background = await read('background.js');
  // 分支可能写成 type === 'x'，也可能是端口那侧的 type !== 'x' 早退。
  // 一行里可能比较多个类型（`type === 'a' || type === 'b'`），把该行出现的字面量都收进来。
  const handled = new Set(
    [...background.matchAll(/type [!=]==? ([^\n]+)/g)]
      .flatMap((match) => [...match[1].matchAll(/'([a-zA-Z:]+)'/g)].map((inner) => inner[1])),
  );
  const actions = new Set([...background.matchAll(/'((?:list|panel):[a-zA-Z]+)':/g)].map((match) => match[1]));
  assert.ok(actions.has('list:get'), '面板动作表应该存在');

  for (const file of ['content-context.js', 'content-scroll-tracker.js', 'sidepanel/panel.js']) {
    const source = await read(file);
    const sent = new Set([...source.matchAll(/type: '([a-zA-Z:]+)'/g)].map((match) => match[1]));
    for (const type of sent) {
      assert.ok(
        handled.has(type) || actions.has(type),
        `${file} 发出了 ${type}，但 background.js 没有处理`,
      );
    }
  }
});

test('后台发给页面的消息，内容脚本都监听了', async () => {
  const background = await read('background.js');
  const pairs = [
    ['watchPageClicks', 'content-context.js'],
    ['playAddAnimation', 'content-add-animation.js'],
  ];
  for (const [type, file] of pairs) {
    assert.match(background, new RegExp(`type: '${type}'`), `background 应该发送 ${type}`);
    const source = await read(file);
    assert.match(source, new RegExp(`type === '${type}'`), `${file} 应该处理 ${type}`);
  }
});

test('按需注入的脚本列表都指向真实文件', async () => {
  const background = await read('background.js');
  const injected = [...background.matchAll(/files: \[([^\]]+)\]/g)]
    .flatMap((match) => [...match[1].matchAll(/'([^']+)'/g)].map((inner) => inner[1]));
  assert.ok(injected.length >= 2, '应该抓到按需注入的脚本');
  for (const file of injected) {
    await assert.doesNotReject(() => read(file), `注入的脚本不存在：${file}`);
  }
});
