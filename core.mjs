export const STORAGE_KEY = 'readLaterList';
export const EXPORT_VERSION = 2;
export const IMPORT_MAX_BYTES = 5 * 1024 * 1024;
export const RANDOM_PICK_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

// 存储形态版本：写盘时给每条记录打上 v，读回时命中就能跳过全部 URL 解析。
// 字段语义变化时 +1，旧记录会自然走一次完整的规范化迁移。
export const SCHEMA_VERSION = 3;
export const MAX_TEXT_LENGTH = 2000;
// data: URL 形式的图标会占 storage.local 配额（默认约 10 MB），太长的一律丢弃。
export const MAX_FAVICON_DATA_URL_LENGTH = 4096;

// 进度会随滚动刷新的排序：只有这些视图需要在进度变化时重排列表。
export const PROGRESS_SENSITIVE_SORTS = ['progressAsc', 'progressDesc'];
export const PROGRESS_SENSITIVE_FILTERS = ['inProgress', 'complete'];

const TRACKING_PARAMS = new Set(['fbclid', 'gclid', 'mc_cid', 'mc_eid']);
const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const HTTP_URL_PATTERN = /^https?:\/\//i;
const GOOGLE_FAVICON_PATTERN = /^https?:\/\/(www\.)?google\.com\/s2\/favicons/i;

export function isSupportedUrl(url) {
  try {
    const protocol = new URL(url).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

export function normalizeUrl(url, { stripHash = false } = {}) {
  try {
    const parsed = new URL(url);
    for (const key of [...parsed.searchParams.keys()]) {
      if (/^utm_/i.test(key) || TRACKING_PARAMS.has(key.toLowerCase())) {
        parsed.searchParams.delete(key);
      }
    }
    if (parsed.pathname !== '/' && parsed.pathname.endsWith('/')) {
      parsed.pathname = parsed.pathname.slice(0, -1);
    }
    if (stripHash) parsed.hash = '';
    return parsed.toString();
  } catch {
    return String(url || '');
  }
}

export function documentKey(url) {
  return normalizeUrl(url, { stripHash: true });
}

export function urlsReferToSameDocument(left, right) {
  if (!isSupportedUrl(left) || !isSupportedUrl(right)) return false;
  return documentKey(left) === documentKey(right);
}

export function getDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function validTimestamp(value) {
  return Number.isFinite(value) && value > 0;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function cleanText(value, fallback = '', maxLength = MAX_TEXT_LENGTH) {
  const safeFallback = typeof fallback === 'string' ? fallback : '';
  if (typeof value !== 'string') return safeFallback;
  return value.trim().slice(0, maxLength) || safeFallback;
}

function isParsableHttpUrl(value) {
  try {
    const protocol = new URL(value).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

// trustShape 为真表示记录刚由本扩展写出，只需要廉价的形状检查，不必再解析 URL。
function sanitizeStoredFavicon(value, { trustShape = false } = {}) {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  if (value.startsWith('data:image/')) {
    return value.length <= MAX_FAVICON_DATA_URL_LENGTH ? value : undefined;
  }
  if (!HTTP_URL_PATTERN.test(value) || GOOGLE_FAVICON_PATTERN.test(value)) return undefined;
  if (trustShape) return value;
  return isParsableHttpUrl(value) ? value : undefined;
}

function makeSafeId(rawId, usedIds, makeId) {
  let id = typeof rawId === 'string' && SAFE_ID_PATTERN.test(rawId) ? rawId : makeId();
  while (usedIds.has(id)) id = makeId();
  usedIds.add(id);
  return id;
}

// 已经是我们自己写出去的形态：字段类型对得上就直接复用，跳过 6 次 new URL()。
function isNormalizedShape(raw) {
  return !!raw
    && typeof raw === 'object'
    && raw.v === SCHEMA_VERSION
    && typeof raw.id === 'string' && SAFE_ID_PATTERN.test(raw.id)
    && typeof raw.url === 'string' && HTTP_URL_PATTERN.test(raw.url)
    && typeof raw.normalizedUrl === 'string' && HTTP_URL_PATTERN.test(raw.normalizedUrl)
    && typeof raw.title === 'string'
    && validTimestamp(raw.addedAt)
    && validTimestamp(raw.firstAddedAt)
    && typeof raw.sourceUrl === 'string' && HTTP_URL_PATTERN.test(raw.sourceUrl)
    && typeof raw.sourceTitle === 'string'
    && typeof raw.sourceDomain === 'string';
}

function adoptNormalizedItem(raw, { usedIds, usedUrls, makeId }) {
  if (usedUrls.has(raw.normalizedUrl)) return null;
  usedUrls.add(raw.normalizedUrl);

  const item = { ...raw, id: makeSafeId(raw.id, usedIds, makeId) };
  if (item.title.length > MAX_TEXT_LENGTH) item.title = item.title.slice(0, MAX_TEXT_LENGTH);
  if (item.sourceTitle.length > MAX_TEXT_LENGTH) item.sourceTitle = item.sourceTitle.slice(0, MAX_TEXT_LENGTH);

  const favicon = sanitizeStoredFavicon(item.favicon, { trustShape: true });
  if (favicon) item.favicon = favicon;
  else delete item.favicon;

  // 数值兜底只做廉价比较：正常写入路径不会越界，这里防的是外部篡改。
  if (Number.isFinite(item.scrollPercent)) item.scrollPercent = clamp(item.scrollPercent, 0, 100);
  else delete item.scrollPercent;
  if (Number.isFinite(item.scrollY)) item.scrollY = Math.max(0, Math.round(item.scrollY));
  else delete item.scrollY;
  if (!validTimestamp(item.lastRandomPickedAt)) delete item.lastRandomPickedAt;
  if (typeof item.strikethrough !== 'boolean') delete item.strikethrough;
  return item;
}

function migrateRawItem(raw, { now, usedIds, usedUrls, makeId }) {
  if (!raw || typeof raw !== 'object' || !isSupportedUrl(raw.url)) return null;
  const url = new URL(raw.url).toString();
  const addedAt = validTimestamp(raw.addedAt) ? raw.addedAt : now;
  const firstAddedAt = validTimestamp(raw.firstAddedAt) ? raw.firstAddedAt : addedAt;
  const normalizedUrl = normalizeUrl(url);
  if (usedUrls.has(normalizedUrl)) return null;
  usedUrls.add(normalizedUrl);

  const item = {
    ...raw,
    v: SCHEMA_VERSION,
    id: makeSafeId(raw.id, usedIds, makeId),
    title: cleanText(raw.title, url),
    url,
    normalizedUrl,
    addedAt,
    firstAddedAt,
    sourceUrl: isSupportedUrl(raw.sourceUrl) ? new URL(raw.sourceUrl).toString() : url,
    sourceTitle: cleanText(raw.sourceTitle, raw.title || url),
    sourceDomain: getDomain(isSupportedUrl(raw.sourceUrl) ? raw.sourceUrl : url),
  };

  const favicon = sanitizeStoredFavicon(raw.favicon);
  if (favicon) item.favicon = favicon;
  else delete item.favicon;
  if (Number.isFinite(raw.scrollPercent)) item.scrollPercent = clamp(raw.scrollPercent, 0, 100);
  else delete item.scrollPercent;
  if (Number.isFinite(raw.scrollY)) item.scrollY = Math.max(0, Math.round(raw.scrollY));
  else delete item.scrollY;
  if (validTimestamp(raw.lastRandomPickedAt)) item.lastRandomPickedAt = raw.lastRandomPickedAt;
  else delete item.lastRandomPickedAt;
  if (typeof raw.strikethrough !== 'boolean') delete item.strikethrough;
  return item;
}

export function normalizeStoredList(rawList, {
  now = Date.now(),
  makeId = () => crypto.randomUUID(),
} = {}) {
  if (!Array.isArray(rawList)) return [];
  const context = { now, makeId, usedIds: new Set(), usedUrls: new Set() };
  const normalized = [];

  for (const raw of rawList) {
    const item = isNormalizedShape(raw)
      ? adoptNormalizedItem(raw, context)
      : migrateRawItem(raw, context);
    if (item) normalized.push(item);
  }
  return normalized;
}

export function addOrBumpItem(list, item, now = Date.now()) {
  const existingIndex = list.findIndex((candidate) => candidate.normalizedUrl === item.normalizedUrl);
  if (existingIndex >= 0) {
    const [existing] = list.splice(existingIndex, 1);
    existing.firstAddedAt ||= existing.addedAt;
    existing.addedAt = now;
    list.unshift(existing);
    return { list, item: existing, duplicate: true };
  }
  list.unshift(item);
  return { list, item, duplicate: false };
}

export function getRandomPickPool(list, {
  now = Date.now(),
  cooldownMs = RANDOM_PICK_COOLDOWN_MS,
  excludeIds = new Set(),
} = {}) {
  return list.filter((item) => {
    if (!item || excludeIds.has(item.id) || item.strikethrough) return false;
    if (Number(item.scrollPercent) >= 100) return false;
    if (validTimestamp(item.lastRandomPickedAt) && now - item.lastRandomPickedAt < cooldownMs) return false;
    return true;
  });
}

export function pickWeightedOldItems(list, {
  count = 3,
  now = Date.now(),
  cooldownMs = RANDOM_PICK_COOLDOWN_MS,
  excludeIds = new Set(),
  random = Math.random,
} = {}) {
  const pool = getRandomPickPool(list, { now, cooldownMs, excludeIds });
  const picked = [];

  while (pool.length > 0 && picked.length < count) {
    const weights = pool.map((item) => {
      const firstAddedAt = validTimestamp(item.firstAddedAt) ? item.firstAddedAt : item.addedAt;
      const ageDays = Math.max(0, (now - firstAddedAt) / (24 * 60 * 60 * 1000));
      return 1 + Math.min(ageDays, 365) / 30;
    });
    const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
    let cursor = Math.min(0.999999999, Math.max(0, random())) * totalWeight;
    let selectedIndex = pool.length - 1;
    for (let index = 0; index < pool.length; index++) {
      cursor -= weights[index];
      if (cursor < 0) {
        selectedIndex = index;
        break;
      }
    }
    picked.push(pool.splice(selectedIndex, 1)[0]);
  }
  return picked;
}

// —— 列表视图（纯函数，便于单测；面板只负责把结果画出来） ——

export function itemProgress(item) {
  return clamp(Number(item?.scrollPercent) || 0, 0, 100);
}

export function itemSourceText(item) {
  return item?.sourceDomain || getDomain(item?.sourceUrl || item?.url || '');
}

export function itemSearchHaystack(item) {
  return [
    item.title,
    item.url,
    getDomain(item.url),
    item.sourceTitle,
    item.sourceUrl,
    itemSourceText(item),
  ].filter(Boolean).join(' ').toLowerCase();
}

export function matchesItemFilter(item, filter = 'all') {
  if (!item) return false;
  if (filter === 'unread') return !item.strikethrough;
  if (filter === 'read') return !!item.strikethrough;
  const progress = itemProgress(item);
  if (filter === 'inProgress') return progress > 0 && progress < 100;
  if (filter === 'complete') return progress >= 100;
  return true;
}

// 就地排序传入的数组（调用方传进来的通常已经是筛选后的临时数组）。
export function sortItems(items, sort = 'addedDesc') {
  items.sort((a, b) => {
    if (sort === 'addedAsc') return (a.addedAt || 0) - (b.addedAt || 0);
    if (sort === 'progressDesc') return itemProgress(b) - itemProgress(a);
    if (sort === 'progressAsc') return itemProgress(a) - itemProgress(b);
    if (sort === 'sourceAsc') {
      return itemSourceText(a).localeCompare(itemSourceText(b), 'zh-CN') || (b.addedAt || 0) - (a.addedAt || 0);
    }
    return (b.addedAt || 0) - (a.addedAt || 0);
  });
  return items;
}

export function selectVisibleItems(list, {
  query = '',
  filter = 'all',
  sort = 'addedDesc',
  offset = 0,
  limit = Infinity,
} = {}) {
  const needle = String(query || '').trim().toLowerCase();
  const matched = [];
  for (const item of Array.isArray(list) ? list : []) {
    if (!matchesItemFilter(item, filter)) continue;
    if (needle && !itemSearchHaystack(item).includes(needle)) continue;
    matched.push(item);
  }
  sortItems(matched, sort);
  return {
    total: matched.length,
    items: Number.isFinite(limit) ? matched.slice(offset, offset + limit) : matched.slice(offset),
  };
}

// 只有 id 顺序（progress 排序时再加进度）真的变了才需要重排 DOM。
export function itemsSignature(items, { progressSensitive = false } = {}) {
  return items
    .map((item) => (progressSensitive ? `${item.id}:${itemProgress(item)}` : item.id))
    .join(',');
}

// —— 列表存储：内存里持有权威副本，写盘可以延迟合并 ——

export function createListStore({
  read,
  write,
  flushDelayMs = 1000,
  setTimer = (callback, delay) => setTimeout(callback, delay),
  clearTimer = (id) => clearTimeout(id),
} = {}) {
  let cached = null;
  let dirty = false;
  let timer = null;
  let inFlight = null;
  let loading = null;

  function cancelTimer() {
    if (timer === null) return;
    clearTimer(timer);
    timer = null;
  }

  async function flush() {
    cancelTimer();
    if (inFlight) await inFlight.catch(() => {});
    if (!dirty || cached === null) return false;
    dirty = false;
    const snapshot = cached;
    const task = Promise.resolve().then(() => write(snapshot));
    inFlight = task;
    try {
      await task;
    } catch (error) {
      dirty = true; // 写失败保留脏标记，下一次再试。
      throw error;
    } finally {
      if (inFlight === task) inFlight = null;
    }
    return true;
  }

  return {
    get cached() { return cached; },
    get dirty() { return dirty; },
    get pending() { return timer !== null; },
    async get() {
      if (cached !== null) return cached;
      // 并发首次读取共用一个 promise：否则两个 read 各自赋值 cached，
      // 后落地的那个可能把刚改完的列表覆盖回去。
      if (loading === null) {
        loading = Promise.resolve()
          .then(() => read())
          .then((loaded) => {
            cached = Array.isArray(loaded) ? loaded : [];
            return cached;
          })
          .finally(() => { loading = null; });
      }
      return loading;
    },
    async commit(list, { deferred = false } = {}) {
      cached = Array.isArray(list) ? list : [];
      dirty = true;
      if (!deferred) return flush();
      if (timer === null) {
        // 固定窗口的合并写：滚动期间每 flushDelayMs 最多落盘一次，不无限推迟。
        timer = setTimer(() => {
          timer = null;
          flush().catch(() => {});
        }, flushDelayMs);
      }
      return false;
    },
    flush,
    invalidate() {
      cancelTimer();
      cached = null;
      dirty = false;
    },
  };
}

export function validateImportItem(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  if (!isSupportedUrl(raw.url) || !validTimestamp(raw.addedAt)) return false;
  if (raw.id !== undefined && (typeof raw.id !== 'string' || !SAFE_ID_PATTERN.test(raw.id))) return false;
  if (raw.title !== undefined && typeof raw.title !== 'string') return false;
  if (raw.firstAddedAt !== undefined && !validTimestamp(raw.firstAddedAt)) return false;
  if (raw.sourceUrl !== undefined && !isSupportedUrl(raw.sourceUrl)) return false;
  if (raw.scrollPercent !== undefined && !Number.isFinite(raw.scrollPercent)) return false;
  if (raw.scrollY !== undefined && !Number.isFinite(raw.scrollY)) return false;
  if (raw.lastRandomPickedAt !== undefined && !validTimestamp(raw.lastRandomPickedAt)) return false;
  return true;
}

export function prepareImport(payload, currentList, {
  makeId = () => crypto.randomUUID(),
} = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('备份文件格式不正确');
  }
  if (payload.version !== 1 && payload.version !== EXPORT_VERSION) {
    throw new Error('不支持的备份版本');
  }
  if (!Array.isArray(payload.list)) throw new Error('备份文件缺少列表');

  const current = normalizeStoredList(currentList, { makeId });
  const seenUrls = new Set(current.map((item) => item.normalizedUrl));
  const seenIds = new Set(current.map((item) => item.id));
  const accepted = [];
  let duplicate = 0;
  let invalid = 0;

  for (const raw of payload.list) {
    if (!validateImportItem(raw)) {
      invalid += 1;
      continue;
    }

    const normalizedUrl = normalizeUrl(raw.url);
    if (seenUrls.has(normalizedUrl)) {
      duplicate += 1;
      continue;
    }
    if (raw.id && seenIds.has(raw.id)) {
      invalid += 1;
      continue;
    }

    // 外部文件一律走完整规范化（去掉 v 让它绕开快速路径），并丢弃备份里带的图标。
    const { v: _ignoredVersion, favicon: _ignoredFavicon, ...rest } = raw;
    const normalized = normalizeStoredList([rest], { makeId })[0];
    if (!normalized) {
      invalid += 1;
      continue;
    }
    seenUrls.add(normalized.normalizedUrl);
    seenIds.add(normalized.id);
    accepted.push(normalized);
  }

  return {
    list: [...accepted, ...current],
    imported: accepted.length,
    duplicate,
    invalid,
  };
}

export function createSerialExecutor() {
  let tail = Promise.resolve();
  return (task) => {
    const run = tail.then(task, task);
    tail = run.catch(() => {});
    return run;
  };
}
