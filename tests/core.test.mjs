import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SCHEMA_VERSION,
  addOrBumpItem,
  createSerialExecutor,
  documentKey,
  getRandomPickPool,
  itemsSignature,
  normalizeStoredList,
  normalizeUrl,
  pickWeightedOldItems,
  prepareImport,
  selectVisibleItems,
  urlsReferToSameDocument,
} from '../core.mjs';

function idFactory(...ids) {
  let index = 0;
  return () => ids[index++] || `generated-${index}`;
}

test('normalizeUrl removes tracking parameters and trailing slash', () => {
  assert.equal(
    normalizeUrl('https://example.com/article/?utm_source=test&keep=1#part'),
    'https://example.com/article?keep=1#part',
  );
  assert.equal(documentKey('https://example.com/article/#part'), 'https://example.com/article');
});

test('document binding ignores hashes but rejects a new route', () => {
  assert.equal(
    urlsReferToSameDocument('https://example.com/a#one', 'https://example.com/a#two'),
    true,
  );
  assert.equal(
    urlsReferToSameDocument('https://example.com/a', 'https://example.com/b'),
    false,
  );
  assert.equal(urlsReferToSameDocument('https://example.com/a', 'file:///tmp/a'), false);
});

test('stored version 1 items migrate without losing the first added time', () => {
  const list = normalizeStoredList([{
    id: '123',
    title: 'Legacy',
    url: 'https://example.com/legacy',
    addedAt: 100,
  }], { now: 999, makeId: idFactory('fallback') });

  assert.equal(list.length, 1);
  assert.equal(list[0].id, '123');
  assert.equal(list[0].addedAt, 100);
  assert.equal(list[0].firstAddedAt, 100);
});

test('migration removes legacy Google favicons and unsafe metadata', () => {
  const list = normalizeStoredList([{
    id: 'safe',
    title: 'Safe',
    url: 'https://example.com/article',
    addedAt: 100,
    favicon: 'https://www.google.com/s2/favicons?domain=example.com',
    sourceTitle: { unsafe: true },
  }]);
  assert.equal(list[0].favicon, undefined);
  assert.equal(typeof list[0].sourceTitle, 'string');
});

test('migration repairs duplicate stored URLs', () => {
  const list = normalizeStoredList([
    { id: 'newest', title: 'Newest', url: 'https://example.com/a?utm_source=x', addedAt: 20 },
    { id: 'older', title: 'Older', url: 'https://example.com/a', addedAt: 10 },
  ]);
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 'newest');
});

test('duplicate addition updates queue time and really moves the item first', () => {
  const original = {
    id: 'old',
    title: 'Old',
    url: 'https://example.com/old',
    normalizedUrl: 'https://example.com/old',
    addedAt: 100,
  };
  const other = {
    id: 'newer',
    title: 'Newer',
    url: 'https://example.com/newer',
    normalizedUrl: 'https://example.com/newer',
    addedAt: 200,
  };
  const duplicate = { ...original, id: 'unused' };
  const outcome = addOrBumpItem([other, original], duplicate, 300);

  assert.equal(outcome.duplicate, true);
  assert.equal(outcome.list[0].id, 'old');
  assert.equal(outcome.list[0].firstAddedAt, 100);
  assert.equal(outcome.list[0].addedAt, 300);
});

test('version 1 import separates accepted, duplicate and invalid items', () => {
  const current = normalizeStoredList([{
    id: 'current',
    title: 'Current',
    url: 'https://example.com/current',
    addedAt: 10,
  }], { makeId: idFactory('current-fallback') });

  const result = prepareImport({
    version: 1,
    list: [
      { id: 'accepted', title: 'Accepted', url: 'https://example.com/accepted', addedAt: 20 },
      { id: 'duplicate-url', title: 'Duplicate', url: 'https://example.com/current', addedAt: 30 },
      { id: 'bad-scheme', title: 'Bad', url: 'javascript:alert(1)', addedAt: 40 },
      { id: 'accepted-again', title: 'Duplicate in file', url: 'https://example.com/accepted', addedAt: 50 },
    ],
  }, current, { makeId: idFactory('generated') });

  assert.equal(result.imported, 1);
  assert.equal(result.duplicate, 2);
  assert.equal(result.invalid, 1);
  assert.equal(result.list[0].id, 'accepted');
});

test('import rejects unsupported versions and duplicate ids', () => {
  assert.throws(() => prepareImport({ version: 3, list: [] }, []), /\u7248\u672c/);
  const result = prepareImport({
    version: 2,
    list: [{ id: 'same-id', title: 'Conflict', url: 'https://example.com/new', addedAt: 2 }],
  }, [{ id: 'same-id', title: 'Existing', url: 'https://example.com/old', addedAt: 1 }]);
  assert.equal(result.imported, 0);
  assert.equal(result.invalid, 1);
});

test('serial executor preserves writes even when tasks have different delays', async () => {
  const execute = createSerialExecutor();
  const order = [];
  const first = execute(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    order.push('first');
  });
  const second = execute(async () => {
    order.push('second');
  });
  await Promise.all([first, second]);
  assert.deepEqual(order, ['first', 'second']);
});

test('random pool excludes read, complete and recently picked items', () => {
  const now = 1_800_000_000_000;
  const list = [
    { id: 'eligible', addedAt: now - 10_000 },
    { id: 'read', addedAt: now - 20_000, strikethrough: true },
    { id: 'complete', addedAt: now - 30_000, scrollPercent: 100 },
    { id: 'cooling', addedAt: now - 40_000, lastRandomPickedAt: now - 1_000 },
  ];
  assert.deepEqual(getRandomPickPool(list, { now }).map((item) => item.id), ['eligible']);
});

test('old-content weighted draw samples without replacement', () => {
  const now = 1_800_000_000_000;
  const day = 86400000;
  const list = [
    { id: 'new', addedAt: now - day, firstAddedAt: now - day },
    { id: 'old', addedAt: now - 300 * day, firstAddedAt: now - 300 * day },
    { id: 'middle', addedAt: now - 30 * day, firstAddedAt: now - 30 * day },
  ];
  const picked = pickWeightedOldItems(list, { now, count: 3, random: () => 0.5 });
  assert.equal(picked[0].id, 'old');
  assert.equal(new Set(picked.map((item) => item.id)).size, 3);
});

// —— 快速路径与视图选择 ——

test('带版本号的记录走快速路径，不再重写字段', () => {
  const once = normalizeStoredList([{
    id: 'fast',
    title: '标题',
    url: 'https://example.com/a?utm_source=x',
    addedAt: 100,
    sourceUrl: 'https://example.com/a?utm_source=x',
    scrollPercent: 30,
  }]);
  assert.equal(once[0].v, SCHEMA_VERSION);
  assert.equal(once[0].normalizedUrl, 'https://example.com/a');

  // 留下明显的加工痕迹：迁移路径会 trim，快速路径必须原样保留。
  const again = normalizeStoredList([{ ...once[0], title: '  留白  ' }]);
  assert.equal(again[0].title, '  留白  ');
  assert.equal(again[0].normalizedUrl, 'https://example.com/a');
  assert.equal(again[0].v, SCHEMA_VERSION);
});

test('版本号对不上时回到完整迁移，并修掉越界数据', () => {
  const migrated = normalizeStoredList([{
    id: 'stale',
    v: 1,
    title: '  留白  ',
    url: 'https://example.com/b?utm_source=x',
    addedAt: 100,
    favicon: 'https://www.google.com/s2/favicons?domain=example.com',
    scrollPercent: 250,
  }]);
  assert.equal(migrated[0].title, '留白');
  assert.equal(migrated[0].v, SCHEMA_VERSION);
  assert.equal(migrated[0].favicon, undefined);
  assert.equal(migrated[0].scrollPercent, 100);
});

test('快速路径同样做去重与 id 兜底', () => {
  const base = {
    v: SCHEMA_VERSION,
    title: 'x',
    url: 'https://example.com/a',
    normalizedUrl: 'https://example.com/a',
    addedAt: 1,
    firstAddedAt: 1,
    sourceUrl: 'https://example.com/a',
    sourceTitle: 'x',
    sourceDomain: 'example.com',
  };
  const list = normalizeStoredList([
    { ...base, id: 'first' },
    { ...base, id: 'second' },
    { ...base, id: 'third', normalizedUrl: 'https://example.com/c' },
  ]);
  assert.deepEqual(list.map((item) => item.id), ['first', 'third']);
});

test('超长的 data URL 图标会被丢弃', () => {
  const kept = normalizeStoredList([{
    id: 'fav-ok',
    title: 'x',
    url: 'https://example.com/a',
    addedAt: 1,
    favicon: `data:image/png;base64,${'A'.repeat(200)}`,
  }]);
  assert.ok(kept[0].favicon);

  const dropped = normalizeStoredList([{
    id: 'fav-big',
    title: 'x',
    url: 'https://example.com/b',
    addedAt: 1,
    favicon: `data:image/png;base64,${'A'.repeat(9000)}`,
  }]);
  assert.equal(dropped[0].favicon, undefined);
});

test('selectVisibleItems 一次给出筛选、排序、分页与总数', () => {
  const list = [
    { id: 'a', title: 'Vue 教程', url: 'https://a.com/1', addedAt: 30, scrollPercent: 0 },
    { id: 'b', title: 'React 教程', url: 'https://b.com/1', addedAt: 20, scrollPercent: 100 },
    { id: 'c', title: 'Vue 源码', url: 'https://c.com/1', addedAt: 10, scrollPercent: 55, strikethrough: true },
    { id: 'd', title: 'Vue 动画', url: 'https://d.com/1', addedAt: 5, scrollPercent: 10 },
  ];

  const all = selectVisibleItems(list, { sort: 'addedDesc' });
  assert.equal(all.total, 4);
  assert.deepEqual(all.items.map((item) => item.id), ['a', 'b', 'c', 'd']);

  assert.deepEqual(selectVisibleItems(list, { query: 'vue' }).items.map((item) => item.id), ['a', 'c', 'd']);
  assert.deepEqual(selectVisibleItems(list, { filter: 'inProgress' }).items.map((item) => item.id), ['c', 'd']);
  assert.deepEqual(selectVisibleItems(list, { filter: 'read' }).items.map((item) => item.id), ['c']);
  assert.deepEqual(selectVisibleItems(list, { sort: 'addedAsc' }).items.map((item) => item.id), ['d', 'c', 'b', 'a']);
  assert.deepEqual(selectVisibleItems(list, { sort: 'progressDesc' }).items.map((item) => item.id), ['b', 'c', 'd', 'a']);

  const page = selectVisibleItems(list, { sort: 'addedDesc', limit: 2 });
  assert.equal(page.total, 4, '分页不影响总数');
  assert.deepEqual(page.items.map((item) => item.id), ['a', 'b']);
});

test('itemsSignature 只在进度敏感的排序里带上进度', () => {
  const items = [{ id: 'a', scrollPercent: 1 }, { id: 'b', scrollPercent: 2 }];
  assert.equal(itemsSignature(items), 'a,b');
  assert.equal(itemsSignature(items, { progressSensitive: true }), 'a:1,b:2');
  assert.notEqual(
    itemsSignature([{ id: 'a', scrollPercent: 50 }], { progressSensitive: true }),
    itemsSignature([{ id: 'a', scrollPercent: 51 }], { progressSensitive: true }),
  );
});
