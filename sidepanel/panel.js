import {
  EXPORT_VERSION,
  IMPORT_MAX_BYTES,
  getDomain,
  getRandomPickPool,
  pickWeightedOldItems,
} from '../core.mjs';

const elements = {
  list: document.getElementById('list'),
  emptyState: document.getElementById('emptyState'),
  footer: document.getElementById('footer'),
  count: document.getElementById('count'),
  addBtn: document.getElementById('addBtn'),
  randomBtn: document.getElementById('randomBtn'),
  randomPicker: document.getElementById('randomPicker'),
  randomCards: document.getElementById('randomCards'),
  randomError: document.getElementById('randomError'),
  randomEmpty: document.getElementById('randomEmpty'),
  randomPoolCount: document.getElementById('randomPoolCount'),
  randomCloseBtn: document.getElementById('randomCloseBtn'),
  randomRerollBtn: document.getElementById('randomRerollBtn'),
  searchInput: document.getElementById('searchInput'),
  filterSelect: document.getElementById('filterSelect'),
  sortSelect: document.getElementById('sortSelect'),
  clearBtn: document.getElementById('clearBtn'),
  exportBtn: document.getElementById('exportBtn'),
  importBtn: document.getElementById('importBtn'),
  importFileInput: document.getElementById('importFileInput'),
  reloadBtn: document.getElementById('reloadBtn'),
  toast: document.getElementById('toast'),
};

const viewState = {
  list: [],
  query: '',
  filter: 'all',
  sort: 'addedDesc',
};

const SEARCH_RENDER_DELAY = 180;

let toastTimer = null;
let pendingDelete = null;
let observedListRects = new Map();
let listResizeObserver = null;
let resizeAnimationFrame = null;
let closingPanel = false;
let panelPort = null;
let panelWindowId = null;
let randomPickerTimer = null;
let searchRenderTimer = null;
let queuedFrame = 0;
let frameQueue = [];
let renderedSignature = null;
const randomSessionSeen = new Set();

// 每一行的动画可能同时在跑，按 id 收敛，避免同一元素叠加多个动画。
const rowAnimations = new Map();
const rowStates = new WeakMap();

async function getList() {
  const result = await sendAction('list:get');
  return result.list;
}

async function sendAction(type, payload = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...payload });
  if (!response?.ok) throw new Error(response?.error || '操作失败');
  return response.data;
}

function prefersReducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function formatTime(ts) {
  const now = Date.now();
  const diff = now - ts;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes}分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}天前`;
  return new Date(ts).toLocaleDateString('zh-CN');
}

function sourceText(item) {
  return item.sourceDomain || getDomain(item.sourceUrl || item.url);
}

function getProgress(item) {
  return Math.min(100, Math.max(0, item.scrollPercent || 0));
}

function showToast(message) {
  if (!elements.toast) return;
  elements.toast.textContent = message;
  elements.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    elements.toast.classList.remove('show');
  }, 2200);
}

function restartPanelEnterAnimation() {
  const app = document.getElementById('app');
  if (!app) return;
  closingPanel = false;
  app.style.width = '';
  app.classList.remove('collapse-out', 'panel-enter');
  app.getBoundingClientRect();
  app.classList.add('panel-enter');
}

function closePanelWithAnimation() {
  if (closingPanel) return;
  closingPanel = true;

  const app = document.getElementById('app');
  app.style.width = `${app.getBoundingClientRect().width}px`;
  app.getBoundingClientRect();
  app.classList.add('collapse-out');
  app.style.width = '0px';

  let closed = false;
  const finishClose = () => {
    if (closed) return;
    closed = true;
    window.close();
  };
  const handleTransitionEnd = (e) => {
    if (e.target !== app) return;
    if (e.propertyName !== 'width') return;
    app.removeEventListener('transitionend', handleTransitionEnd);
    finishClose();
  };
  app.addEventListener('transitionend', handleTransitionEnd);
  setTimeout(finishClose, 460);
}

function formatBacklogAge(item) {
  const start = item.firstAddedAt || item.addedAt || Date.now();
  const days = Math.max(0, Math.floor((Date.now() - start) / 86400000));
  if (days < 1) return '今天加入';
  if (days === 1) return '积压 1 天';
  return `积压 ${days} 天`;
}

function renderRandomCard(item, index) {
  const button = document.createElement('button');
  button.className = 'random-card';
  button.type = 'button';
  button.style.setProperty('--deal-delay', `${index * 90}ms`);
  button.setAttribute('aria-label', `打开候选 ${index + 1}：${item.title || item.url}`);

  const number = document.createElement('span');
  number.className = 'random-card-number';
  number.textContent = String(index + 1).padStart(2, '0');
  const title = document.createElement('strong');
  title.className = 'random-card-title';
  title.textContent = item.title || item.url;
  const meta = document.createElement('span');
  meta.className = 'random-card-meta';
  const progress = getProgress(item);
  meta.textContent = [
    formatBacklogAge(item),
    getDomain(item.url),
    progress > 0 ? `已读 ${progress}%` : '还没开始',
  ].join(' · ');
  const action = document.createElement('span');
  action.className = 'random-card-action';
  action.textContent = '就看这篇 →';
  button.append(number, title, meta, action);
  button.addEventListener('click', () => openRandomItem(item.id));
  return button;
}

function drawRandomChoices() {
  const fullPool = getRandomPickPool(viewState.list);
  let remainingPool = getRandomPickPool(viewState.list, { excludeIds: randomSessionSeen });
  if (remainingPool.length === 0 && fullPool.length > 0) {
    randomSessionSeen.clear();
    remainingPool = fullPool;
  }
  const choices = pickWeightedOldItems(remainingPool, { count: 3 });
  choices.forEach((item) => randomSessionSeen.add(item.id));

  elements.randomCards.innerHTML = '';
  elements.randomError.textContent = '';
  elements.randomError.classList.add('hidden');
  choices.forEach((item, index) => elements.randomCards.appendChild(renderRandomCard(item, index)));
  elements.randomEmpty.classList.toggle('hidden', choices.length > 0);
  elements.randomCards.classList.toggle('hidden', choices.length === 0);
  elements.randomRerollBtn.disabled = fullPool.length === 0;
  elements.randomPoolCount.textContent = fullPool.length > 0
    ? `可抽 ${fullPool.length} 篇`
    : '随机池已清空';
}

function openRandomPicker() {
  clearTimeout(randomPickerTimer);
  drawRandomChoices();
  elements.randomPicker.classList.remove('hidden');
  requestAnimationFrame(() => {
    elements.randomPicker.classList.add('show');
    const firstCard = elements.randomCards.querySelector('.random-card');
    (firstCard || elements.randomCloseBtn).focus();
  });
}

function closeRandomPicker() {
  clearTimeout(randomPickerTimer);
  elements.randomPicker.classList.remove('show');
  randomPickerTimer = setTimeout(() => {
    elements.randomPicker.classList.add('hidden');
    elements.randomBtn.focus();
  }, 180);
}

async function openRandomItem(itemId) {
  const item = viewState.list.find((candidate) => candidate.id === itemId);
  if (!item) return;
  elements.randomPicker.setAttribute('aria-busy', 'true');
  elements.randomCards.querySelectorAll('.random-card').forEach((card) => {
    card.disabled = true;
  });
  try {
    const openResponse = await chrome.runtime.sendMessage({
      type: 'openItem',
      url: item.url,
      itemId: item.id,
      scrollY: item.scrollY || 0,
      scrollPercent: item.scrollPercent || 0,
    });
    if (openResponse?.ok === false) throw new Error(openResponse.error || '无法打开页面');

    try {
      const result = await sendAction('list:markRandomPicked', { itemId, windowId: panelWindowId });
      viewState.list = result.list;
    } catch (error) {
      if (!/未知操作/.test(error.message)) throw error;
      // 兼容尚未重载的新旧后台：页面已经打开，冷却记录会在重载后恢复。
    }
    closeRandomPicker();
    showToast('🎲 已从历史积压中抽出一篇');
  } catch (error) {
    elements.randomError.textContent = error.message || '无法打开所选页面';
    elements.randomError.classList.remove('hidden');
    elements.randomCards.querySelectorAll('.random-card').forEach((card) => {
      card.disabled = false;
    });
  } finally {
    elements.randomPicker.removeAttribute('aria-busy');
  }
}

function matchesFilter(item) {
  const progress = getProgress(item);
  if (viewState.filter === 'unread') return !item.strikethrough;
  if (viewState.filter === 'read') return !!item.strikethrough;
  if (viewState.filter === 'inProgress') return progress > 0 && progress < 100;
  if (viewState.filter === 'complete') return progress >= 100;
  return true;
}

function matchesSearch(item) {
  const query = viewState.query.trim().toLowerCase();
  if (!query) return true;
  const haystack = [
    item.title,
    item.url,
    getDomain(item.url),
    item.sourceTitle,
    item.sourceUrl,
    sourceText(item),
  ].filter(Boolean).join(' ').toLowerCase();
  return haystack.includes(query);
}

function sortItems(items) {
  const sorted = [...items];
  sorted.sort((a, b) => {
    if (viewState.sort === 'addedAsc') return (a.addedAt || 0) - (b.addedAt || 0);
    if (viewState.sort === 'progressDesc') return getProgress(b) - getProgress(a);
    if (viewState.sort === 'progressAsc') return getProgress(a) - getProgress(b);
    if (viewState.sort === 'sourceAsc') {
      return sourceText(a).localeCompare(sourceText(b), 'zh-CN') || (b.addedAt || 0) - (a.addedAt || 0);
    }
    return (b.addedAt || 0) - (a.addedAt || 0);
  });
  return sorted;
}

function getVisibleList() {
  return sortItems(viewState.list.filter(item => matchesFilter(item) && matchesSearch(item)));
}

function getListItemRects() {
  const rects = new Map();
  document.querySelectorAll('.list-item').forEach((el) => {
    rects.set(el.dataset.id, el.getBoundingClientRect());
  });
  return rects;
}

function visibleSignature() {
  const progressSensitive = ['progressAsc', 'progressDesc'].includes(viewState.sort);
  return getVisibleList()
    .map((item) => (progressSensitive ? `${item.id}:${getProgress(item)}` : item.id))
    .join(',');
}

function rowAnimation(id) {
  let api = rowAnimations.get(id);
  if (!api) {
    const animations = new Set();
    api = {
      animations,
      queue(creator) {
        this.cancel();
        const animation = creator();
        if (!animation) return;
        animations.add(animation);
        animation.finished.then(
          () => animations.delete(animation),
          () => animations.delete(animation)
        );
      },
      cancel() {
        for (const animation of animations) {
          try {
            animation.cancel();
          } catch {
            // 动画可能已经结束。
          }
        }
        animations.clear();
      },
    };
    rowAnimations.set(id, api);
  }
  return api;
}

function clearRowAnimations(id) {
  rowAnimations.get(id)?.cancel();
  rowAnimations.delete(id);
}

async function deleteItem(id) {
  const result = await sendAction('list:delete', { itemId: id, windowId: panelWindowId });
  viewState.list = result.list;
  renderList(result.list);
  showToast('已删除');
}

function enterAnimation(el) {
  if (prefersReducedMotion()) return null;
  return el.animate(
    [
      { opacity: 0, transform: 'translateY(8px)' },
      { opacity: 1, transform: 'translateY(0)' },
    ],
    { duration: 200, easing: 'cubic-bezier(.2,.8,.2,1)' }
  );
}

function shiftAnimation(el, dy) {
  if (prefersReducedMotion()) return null;
  if (Math.abs(dy) < 0.5) return null;
  return el.animate(
    [
      { transform: `translateY(${dy}px)` },
      { transform: 'translateY(0)' },
    ],
    { duration: 260, easing: 'cubic-bezier(.2,.8,.2,1)' }
  );
}

// 把 DOM 变更和数据更新收进同一帧：先量旧位置，再改 DOM，再排 FLIP。
function queueFrame(callback) {
  frameQueue.push(callback);
  if (queuedFrame) return;
  queuedFrame = requestAnimationFrame(() => {
    queuedFrame = 0;
    const queue = frameQueue;
    frameQueue = [];
    for (const task of queue) {
      try {
        task();
      } catch (error) {
        console.error(error);
      }
    }
  });
}

function flushFrameQueue() {
  if (!queuedFrame) return;
  cancelAnimationFrame(queuedFrame);
  queuedFrame = 0;
  const queue = frameQueue;
  frameQueue = [];
  for (const task of queue) {
    try {
      task();
    } catch (error) {
      console.error(error);
    }
  }
}

function observeListLayout() {
  if (!('ResizeObserver' in window)) {
    observedListRects = getListItemRects();
    return;
  }

  if (!listResizeObserver) {
    listResizeObserver = new ResizeObserver((entries) => {
      if (resizeAnimationFrame) return;
      const before = observedListRects;
      const changedRects = new Map();
      entries.forEach((entry) => {
        const id = entry.target.dataset.id;
        const previous = before.get(id);
        const current = entry.target.getBoundingClientRect();
        if (id && previous && Math.abs(previous.height - current.height) > 0.5) {
          changedRects.set(id, previous);
        }
      });
      if (changedRects.size === 0) {
        observedListRects = getListItemRects();
        return;
      }
      resizeAnimationFrame = requestAnimationFrame(() => {
        resizeAnimationFrame = null;
        animateItemsBelowResize(before, changedRects);
      });
    });
  }

  listResizeObserver.disconnect();
  document.querySelectorAll('.list-item').forEach((el) => listResizeObserver.observe(el));
  observedListRects = getListItemRects();
}

function animateItemsBelowResize(fromRects, changedRects) {
  const changedBottoms = [...changedRects.values()]
    .map((rect) => rect.bottom)
    .sort((a, b) => a - b);

  document.querySelectorAll('.list-item').forEach((el) => {
    const from = fromRects.get(el.dataset.id);
    if (!from || changedRects.has(el.dataset.id)) return;

    const affected = changedBottoms.some((bottom) => from.top >= bottom - 0.5);
    if (!affected) return;

    const dy = from.top - el.getBoundingClientRect().top;
    if (Math.abs(dy) < 0.5) return;

    rowAnimation(el.dataset.id).queue(() => shiftAnimation(el, dy));
  });

  observedListRects = getListItemRects();
}

function createRow(item) {
  const li = document.createElement('li');
  li.className = 'list-item';
  li.dataset.id = item.id;

  const favicon = item.favicon ? document.createElement('img') : document.createElement('span');
  favicon.className = item.favicon ? 'list-item-favicon' : 'list-item-favicon list-item-favicon-fallback';
  if (item.favicon) {
    favicon.src = item.favicon;
    favicon.alt = '';
    favicon.onerror = () => {
      const fallback = document.createElement('span');
      fallback.className = 'list-item-favicon list-item-favicon-fallback';
      fallback.textContent = (getDomain(item.url)[0] || '?').toUpperCase();
      favicon.replaceWith(fallback);
    };
  } else {
    favicon.textContent = (getDomain(item.url)[0] || '?').toUpperCase();
  }

  const content = document.createElement('div');
  content.className = 'list-item-content';

  const titleEl = document.createElement('div');
  titleEl.className = 'list-item-title';
  titleEl.textContent = item.title || item.url;

  const domainEl = document.createElement('div');
  domainEl.className = 'list-item-domain';

  content.appendChild(titleEl);
  content.appendChild(domainEl);

  const sourceEl = document.createElement('div');
  sourceEl.className = 'list-item-source';
  sourceEl.title = item.sourceUrl ? `打开来源：${item.sourceUrl}` : '打开来源';
  sourceEl.tabIndex = 0;
  sourceEl.addEventListener('click', (e) => {
    e.stopPropagation();
    openSource(item);
  });
  sourceEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      e.stopPropagation();
      openSource(item);
    }
  });
  content.appendChild(sourceEl);

  const actions = document.createElement('div');
  actions.className = 'list-item-actions';

  const readCheckbox = document.createElement('input');
  readCheckbox.className = 'list-item-read';
  readCheckbox.type = 'checkbox';
  readCheckbox.title = '标记已读';
  readCheckbox.setAttribute('aria-label', '标记已读');
  readCheckbox.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleStrikethrough(item.id);
  });

  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'list-item-delete';
  deleteBtn.textContent = '🗑';
  deleteBtn.title = '永久删除';
  deleteBtn.setAttribute('aria-label', '永久删除');
  deleteBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (deleteBtn.classList.contains('confirming')) {
      deleteItem(item.id);
      return;
    }
    armDeleteButton(item.id);
  });
  deleteBtn.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
  });

  const cancelDeleteBtn = document.createElement('button');
  cancelDeleteBtn.className = 'list-item-cancel-delete';
  cancelDeleteBtn.textContent = '取消';
  cancelDeleteBtn.title = '取消删除';
  cancelDeleteBtn.tabIndex = -1;
  cancelDeleteBtn.setAttribute('aria-label', '取消删除');
  cancelDeleteBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    resetPendingDelete(item.id);
  });

  actions.appendChild(readCheckbox);
  actions.appendChild(deleteBtn);
  actions.appendChild(cancelDeleteBtn);

  li.appendChild(favicon);
  li.appendChild(content);
  li.appendChild(actions);

  li.addEventListener('click', () => openItem(item));

  li._readLater = { content, titleEl, domainEl, sourceEl, readCheckbox, deleteBtn, cancelDeleteBtn };
  return li;
}

// 删除线动画只操作标题行，避免整行重排；正反两个方向都从当前状态出发。
const strikeAnimations = new WeakMap();

// 与 CSS 中的删除线保持一致：取消已读时 class 会立刻移除，
// 所以反向动画必须自己带上背景图，否则那一下是直接消失而不是滑走。
const STRIKE_LINE_IMAGE = 'linear-gradient(to bottom, '
  + 'transparent calc(0.6em - 0.5px), var(--text) calc(0.6em - 0.5px), '
  + 'var(--text) calc(0.6em + 0.5px), transparent calc(0.6em + 0.5px))';

function clearStrikeInline(titleEl) {
  strikeAnimations.get(titleEl)?.cancel();
  strikeAnimations.delete(titleEl);
  titleEl.style.backgroundImage = '';
  titleEl.style.backgroundSize = '';
  titleEl.style.backgroundRepeat = '';
  titleEl.style.backgroundPosition = '';
}

function playStrikeAnimation(li, struck) {
  const titleEl = li._readLater?.titleEl;
  if (!titleEl || prefersReducedMotion()) return;
  strikeAnimations.get(titleEl)?.cancel();
  const from = struck ? 0 : 100;
  const to = struck ? 100 : 0;
  const frame = (percent) => ({
    backgroundImage: STRIKE_LINE_IMAGE,
    backgroundRepeat: 'no-repeat',
    backgroundPosition: 'left top',
    backgroundSize: `${percent}% 1.4em`,
  });
  const animation = titleEl.animate([frame(from), frame(to)],
    { duration: 280, easing: 'ease-out', fill: 'forwards' });
  strikeAnimations.set(titleEl, animation);
  animation.finished.then(() => {
    if (strikeAnimations.get(titleEl) === animation) clearStrikeInline(titleEl);
  }, () => {});
}

function normalizeStrike(el) {
  const titleEl = el._readLater?.titleEl;
  if (titleEl) clearStrikeInline(titleEl);
}

function setRowStruck(el, struck, { animate = false } = {}) {
  const state = rowStates.get(el);
  if (state) state.struck = struck;
  if (el.dataset.struck !== (struck ? '1' : '0')) {
    el.dataset.struck = struck ? '1' : '0';
    if (animate) playStrikeAnimation(el, struck);
    else normalizeStrike(el);
  }
  el.classList.toggle('strikethrough', struck);
}

function paintProgress(row, li, item) {
  const percent = getProgress(item);
  const state = rowStates.get(li);
  if (state) state.percent = item.scrollPercent;
  if (row.domainEl) {
    row.domainEl.textContent = `${getDomain(item.url)} · ${formatTime(item.addedAt)}${percent > 0 ? ` · ${percent}%` : ''}`;
  }
  let progressContainer = row.content.querySelector('.scroll-progress');
  if (percent <= 0) {
    if (progressContainer) progressContainer.remove();
    return;
  }
  if (!progressContainer) {
    progressContainer = document.createElement('div');
    progressContainer.className = 'scroll-progress';
    const progressBar = document.createElement('div');
    progressBar.className = 'scroll-progress-bar';
    progressContainer.appendChild(progressBar);
    row.content.appendChild(progressContainer);
  }
  const bar = progressContainer.querySelector('.scroll-progress-bar');
  if (!bar) return;
  const width = `${Math.min(100, percent)}%`;
  if (bar.style.width !== width) bar.style.width = width;
  bar.classList.toggle('complete', percent >= 100);
}

// 整行内容刷新：只在值真的变了的时候写 DOM，避免无谓的重排与动画抖动。
function paintRow(li, item) {
  const row = li._readLater;
  if (!row) return;
  const state = rowStates.get(li) || {};
  const title = item.title || item.url;
  if (row.titleEl.textContent !== title) row.titleEl.textContent = title;
  row.sourceEl.textContent = `来源 ${sourceText(item) || '未知'}`;
  row.sourceEl.title = item.sourceUrl ? `打开来源：${item.sourceUrl}` : '打开来源';
  row.readCheckbox.checked = !!item.strikethrough;
  if (state.percent !== item.scrollPercent) {
    paintProgress(row, li, item);
  }
  setRowStruck(li, !!item.strikethrough);
}

function renderRow(item) {
  const li = createRow(item);
  rowStates.set(li, { struck: !!item.strikethrough, percent: undefined });
  paintRow(li, item);
  return li;
}

function patchRow(li, item) {
  const state = rowStates.get(li);
  if (state) state.percent = undefined;
  paintRow(li, item);
  return li;
}

function updateCount() {
  const visibleCount = getVisibleList().length;
  elements.count.textContent = visibleCount === viewState.list.length
    ? `共 ${viewState.list.length} 项`
    : `显示 ${visibleCount} / 共 ${viewState.list.length} 项`;
}

function openItem(item) {
  chrome.runtime.sendMessage({
    type: 'openItem',
    url: item.url,
    itemId: item.id,
    scrollY: item.scrollY || 0,
    scrollPercent: item.scrollPercent || 0,
  });
}

function armDeleteButton(itemId) {
  resetPendingDelete();
  const li = elements.list.querySelector(`.list-item[data-id="${CSS.escape(itemId)}"]`);
  const button = li?._readLater?.deleteBtn;
  const cancelButton = li?._readLater?.cancelDeleteBtn;
  if (!button) return;

  button.classList.add('confirming');
  button.textContent = '删除';
  button.title = '确认删除';
  button.setAttribute('aria-label', '确认删除');
  if (cancelButton) {
    cancelButton.classList.add('show');
    cancelButton.tabIndex = 0;
  }

  pendingDelete = {
    itemId,
    button,
    cancelButton,
    timer: setTimeout(() => resetPendingDelete(itemId), 3000),
  };
}

function resetPendingDelete(exceptItemId = null) {
  if (!pendingDelete) return;
  const { itemId, button, cancelButton, timer } = pendingDelete;
  if (exceptItemId && itemId !== exceptItemId) return;
  clearTimeout(timer);
  button.classList.remove('confirming');
  button.textContent = '🗑';
  button.title = '永久删除';
  button.setAttribute('aria-label', '永久删除');
  if (cancelButton) {
    cancelButton.classList.remove('show');
    cancelButton.tabIndex = -1;
  }
  pendingDelete = null;
}

function openSource(item) {
  const url = item.sourceUrl || item.url;
  if (!url) return;
  chrome.tabs.create({ url, active: true });
}

function updateEmptyState(visibleCount, totalCount) {
  const isEmpty = totalCount === 0;
  elements.emptyState.classList.toggle('hidden', !isEmpty && visibleCount > 0);
  elements.footer.classList.toggle('hidden', isEmpty);
  if (isEmpty) {
    elements.emptyState.querySelector('.empty-text').textContent = '暂无内容';
    elements.emptyState.querySelector('.empty-hint').textContent = '点击上方按钮或右键菜单添加网页';
    return;
  }
  if (visibleCount === 0) {
    elements.emptyState.querySelector('.empty-text').textContent = '没有匹配项';
    elements.emptyState.querySelector('.empty-hint').textContent = '换个关键词或筛选条件试试';
    elements.emptyState.classList.remove('hidden');
  }
}

function renderEmptyList() {
  for (const el of elements.list.children) clearRowAnimations(el.dataset.id);
  elements.list.innerHTML = '';
  renderedSignature = '';
  updateEmptyState(0, viewState.list.length);
  elements.count.textContent = viewState.list.length ? `显示 0 / 共 ${viewState.list.length} 项` : '';
}

// keyed 复用：条目 DOM 只创建一次，筛选/排序/进度更新不再推倒重来。
function renderList(list = viewState.list) {
  viewState.list = list;
  const visibleList = getVisibleList();
  if (visibleList.length === 0) {
    renderEmptyList();
    return;
  }

  const signature = visibleSignature();
  if (signature === renderedSignature && elements.list.children.length === visibleList.length) {
    updateCount();
    return;
  }

  // 必须在任何 DOM 变更之前量旧位置，包括进度条插入这种会让行变高的更新。
  const before = getListItemRects();

  const existing = new Map();
  for (const el of elements.list.children) existing.set(el.dataset.id, el);

  const orderedNodes = visibleList.map((item) => {
    const previous = existing.get(item.id);
    if (previous) {
      existing.delete(item.id);
      return patchRow(previous, item);
    }
    return renderRow(item);
  });

  queueFrame(() => {
    elements.list.append(...orderedNodes);
    for (const el of existing.values()) {
      clearRowAnimations(el.dataset.id);
      el.remove();
    }
    for (const el of orderedNodes) {
      const from = before.get(el.dataset.id);
      if (!from) {
        if (!prefersReducedMotion()) rowAnimation(el.dataset.id).queue(() => enterAnimation(el));
        continue;
      }
      const dy = from.top - el.getBoundingClientRect().top;
      if (Math.abs(dy) < 0.5) continue;
      rowAnimation(el.dataset.id).queue(() => shiftAnimation(el, dy));
    }
    renderedSignature = signature;
    updateEmptyState(orderedNodes.length, viewState.list.length);
    updateCount();
    observeListLayout();
  });
}

function scheduleSearchRender() {
  clearTimeout(searchRenderTimer);
  searchRenderTimer = setTimeout(() => {
    searchRenderTimer = null;
    flushFrameQueue();
    renderList();
  }, SEARCH_RENDER_DELAY);
}

async function toggleStrikethrough(id) {
  const result = await sendAction('list:toggleRead', { itemId: id, windowId: panelWindowId });
  const item = result.item;
  if (!item) return;

  viewState.list = result.list;
  const li = elements.list.querySelector(`.list-item[data-id="${CSS.escape(id)}"]`);
  if (!li) {
    renderList(result.list);
    return;
  }

  setRowStruck(li, !!item.strikethrough, { animate: true });
  if (viewState.filter !== 'all' || ['progressAsc', 'progressDesc'].includes(viewState.sort)) {
    renderList(result.list);
    return;
  }
  updateCount();
}

async function addCurrentTab() {
  try {
    const result = await sendAction('list:addCurrent', { windowId: panelWindowId });
    renderList(result.list);
    showToast(result.duplicate ? '已在列表中，已移到顶部' : '已添加到稍后再看');
  } catch (error) {
    showToast(error.message);
  }
}

async function clearAll() {
  if (viewState.list.length === 0) return;
  if (!confirm('确定清空全部稍后再看列表？')) return;
  const result = await sendAction('list:clear', { windowId: panelWindowId });
  renderList(result.list);
  showToast('已清空');
}

async function exportData() {
  const list = await getList();
  if (list.length === 0) { alert('列表为空，无需导出'); return; }
  const blob = new Blob([JSON.stringify({ version: EXPORT_VERSION, exportedAt: Date.now(), list }, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `稍后再看备份_${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

async function importData(file) {
  try {
    if (file.size > IMPORT_MAX_BYTES) throw new Error('备份文件不能超过 5 MB');
    const text = await file.text();
    const data = JSON.parse(text);
    const result = await sendAction('list:import', { payload: data, windowId: panelWindowId });
    renderList(result.list);
    alert(`导入完成：新增 ${result.imported} 项，重复 ${result.duplicate} 项，无效 ${result.invalid} 项`);
  } catch (error) {
    alert(`导入失败：${error.message || '文件格式不正确'}`);
  }
}

function patchProgressRow(itemId) {
  const item = viewState.list.find((candidate) => candidate.id === itemId);
  if (!item) return;
  const li = elements.list.querySelector(`.list-item[data-id="${CSS.escape(itemId)}"]`);
  if (!li?._readLater) return;
  const from = li.getBoundingClientRect();
  paintRow(li, item);
  // 进度条首次出现会让本行变高，下方条目补一次平滑让位。这里在同一帧内量完前后位置。
  const to = li.getBoundingClientRect();
  if (Math.abs(from.top - to.top) >= 0.5 || Math.abs(from.height - to.height) >= 0.5) {
    observeListLayout();
  }
}

function handlePanelMessage(msg) {
  if (msg.type === 'closePanel') {
    closePanelWithAnimation();
  }
  if (msg.type === 'listUpdated') {
    const cameFromAnotherWindow = msg.originWindowId === null || msg.originWindowId !== panelWindowId;
    if (cameFromAnotherWindow) {
      flushFrameQueue();
      renderList(msg.list || []);
      if (!elements.randomPicker.classList.contains('hidden')) drawRandomChoices();
    }
    if (msg.feedback) showToast(msg.feedback);
  }
  if (msg.type !== 'scrollProgressUpdated') return;

  const itemInState = viewState.list.find(i => i.id === msg.itemId);
  if (itemInState) {
    itemInState.scrollPercent = msg.percent;
    itemInState.scrollY = msg.scrollY;
  }
  if (!itemInState) return;

  const progressSensitiveView = ['inProgress', 'complete'].includes(viewState.filter)
    || ['progressAsc', 'progressDesc'].includes(viewState.sort);
  if (progressSensitiveView) {
    // 只有可见结果真的变了才重排，滚动过程中的重复进度不再触发整表动画。
    if (visibleSignature() !== renderedSignature) renderList();
    return;
  }

  patchProgressRow(msg.itemId);
}

async function init() {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  panelWindowId = activeTab?.windowId ?? null;
  panelPort = chrome.runtime.connect({ name: 'sidePanel' });
  if (Number.isInteger(panelWindowId)) {
    panelPort.postMessage({ type: 'registerPanel', windowId: panelWindowId });
  }
  panelPort.onMessage.addListener(handlePanelMessage);
  try {
    const list = await getList();
    renderList(list);
  } catch (error) {
    renderList([]);
    showToast(error.message || '列表加载失败');
  }

  elements.addBtn.addEventListener('click', addCurrentTab);
  elements.randomBtn.addEventListener('click', openRandomPicker);
  elements.randomCloseBtn.addEventListener('click', closeRandomPicker);
  elements.randomRerollBtn.addEventListener('click', () => {
    clearTimeout(randomPickerTimer);
    // 重新触发一次抽卡入场：先落回初始态，下一帧再贴上 .show。
    elements.randomPicker.getBoundingClientRect();
    elements.randomPicker.classList.remove('show');
    drawRandomChoices();
    requestAnimationFrame(() => elements.randomPicker.classList.add('show'));
  });
  elements.searchInput.addEventListener('input', (e) => {
    viewState.query = e.target.value;
    scheduleSearchRender();
  });
  elements.filterSelect.addEventListener('change', (e) => {
    viewState.filter = e.target.value;
    renderList();
  });
  elements.sortSelect.addEventListener('change', (e) => {
    viewState.sort = e.target.value;
    renderList();
  });
  document.addEventListener('click', () => resetPendingDelete());
  elements.clearBtn.addEventListener('click', clearAll);
  elements.exportBtn.addEventListener('click', exportData);
  elements.importBtn.addEventListener('click', () => elements.importFileInput.click());
  elements.reloadBtn.addEventListener('click', () => {
    if (confirm('重新加载扩展以应用更改？侧边栏会关闭，重新点击图标即可打开。')) {
      chrome.runtime.reload();
    }
  });
  elements.importFileInput.addEventListener('change', (e) => {
    if (e.target.files[0]) { importData(e.target.files[0]); e.target.value = ''; }
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !elements.randomPicker.classList.contains('hidden')) {
      closeRandomPicker();
    }
  });
}

document.addEventListener('DOMContentLoaded', () => {
  restartPanelEnterAnimation();
  init();
});

window.addEventListener('pageshow', (event) => {
  if (event.persisted) restartPanelEnterAnimation();
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') restartPanelEnterAnimation();
});
