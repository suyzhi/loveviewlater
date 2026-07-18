export const STORAGE_KEY = 'readLaterList';
export const EXPORT_VERSION = 2;
export const IMPORT_MAX_BYTES = 5 * 1024 * 1024;
export const RANDOM_PICK_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

const TRACKING_PARAMS = new Set(['fbclid', 'gclid', 'mc_cid', 'mc_eid']);
const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

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

function cleanText(value, fallback = '', maxLength = 2000) {
  const safeFallback = typeof fallback === 'string' ? fallback : '';
  if (typeof value !== 'string') return safeFallback;
  return value.trim().slice(0, maxLength) || safeFallback;
}

function sanitizeStoredFavicon(value) {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  if (value.startsWith('data:image/')) return value;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
    if (/^(www\.)?google\.com$/i.test(parsed.hostname) && parsed.pathname.startsWith('/s2/favicons')) {
      return undefined;
    }
  } catch {
    return undefined;
  }
  return value;
}

function makeSafeId(rawId, usedIds, makeId) {
  let id = typeof rawId === 'string' && SAFE_ID_PATTERN.test(rawId) ? rawId : makeId();
  while (usedIds.has(id)) id = makeId();
  usedIds.add(id);
  return id;
}

export function normalizeStoredList(rawList, {
  now = Date.now(),
  makeId = () => crypto.randomUUID(),
} = {}) {
  if (!Array.isArray(rawList)) return [];
  const usedIds = new Set();
  const usedUrls = new Set();
  const normalized = [];

  for (const raw of rawList) {
    if (!raw || typeof raw !== 'object' || !isSupportedUrl(raw.url)) continue;
    const url = new URL(raw.url).toString();
    const addedAt = validTimestamp(raw.addedAt) ? raw.addedAt : now;
    const firstAddedAt = validTimestamp(raw.firstAddedAt) ? raw.firstAddedAt : addedAt;
    const normalizedUrl = normalizeUrl(url);
    if (usedUrls.has(normalizedUrl)) continue;
    usedUrls.add(normalizedUrl);
    const item = {
      ...raw,
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
    normalized.push(item);
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

function validateImportItem(raw) {
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

    const normalized = normalizeStoredList([raw], { makeId })[0];
    if (!normalized) {
      invalid += 1;
      continue;
    }
    // 备份内的外部图标不被信任，导入后使用本地字母占位。
    delete normalized.favicon;
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
