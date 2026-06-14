const STORAGE_KEY = 'readLaterList';
const processedAnimations = new Set();

const elements = {
  list: document.getElementById('list'),
  emptyState: document.getElementById('emptyState'),
  footer: document.getElementById('footer'),
  count: document.getElementById('count'),
  addBtn: document.getElementById('addBtn'),
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

let toastTimer = null;
let pendingDelete = null;
let observedListRects = new Map();
let listResizeObserver = null;
let resizeAnimationFrame = null;
let closingPanel = false;
let panelPort = null;

async function getList() {
  const result = await chrome.storage.local.get({ [STORAGE_KEY]: [] });
  return result[STORAGE_KEY];
}

async function setList(list) {
  await chrome.storage.local.set({ [STORAGE_KEY]: list });
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

function getDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function normalizeUrl(url) {
  try {
    const parsed = new URL(url);
    for (const key of [...parsed.searchParams.keys()]) {
      if (/^utm_/i.test(key) || ['fbclid', 'gclid', 'mc_cid', 'mc_eid'].includes(key.toLowerCase())) {
        parsed.searchParams.delete(key);
      }
    }
    if (parsed.pathname !== '/' && parsed.pathname.endsWith('/')) {
      parsed.pathname = parsed.pathname.slice(0, -1);
    }
    return parsed.toString();
  } catch {
    return url;
  }
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

function closePanelWithAnimation() {
  if (closingPanel) return;
  closingPanel = true;

  const app = document.getElementById('app');
  app.style.width = `${app.getBoundingClientRect().width}px`;
  app.getBoundingClientRect();
  app.classList.add('collapse-out');
  app.style.width = '0px';
  chrome.runtime.sendMessage({ type: 'panelClosing' }).catch(() => {});

  let closed = false;
  const finishClose = () => {
    if (closed) return;
    closed = true;
    chrome.runtime.sendMessage({ type: 'panelClosed' }).catch(() => {});
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

function animateListMovement(fromRects) {
  requestAnimationFrame(() => {
    document.querySelectorAll('.list-item').forEach((el) => {
      const from = fromRects.get(el.dataset.id);
      const to = el.getBoundingClientRect();
      if (!from) {
        el.animate(
          [
            { opacity: 0, transform: 'translateY(6px)' },
            { opacity: 1, transform: 'translateY(0)' },
          ],
          { duration: 180, easing: 'cubic-bezier(.2,.8,.2,1)' }
        );
        return;
      }

      const dx = from.left - to.left;
      const dy = from.top - to.top;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;

      el.animate(
        [
          { transform: `translate(${dx}px, ${dy}px)` },
          { transform: 'translate(0, 0)' },
        ],
        { duration: 260, easing: 'cubic-bezier(.2,.8,.2,1)' }
      );
    });
    observedListRects = getListItemRects();
  });
}

function animateItemsBelowResize(fromRects, changedRects) {
  requestAnimationFrame(() => {
    const changedBottoms = [...changedRects.values()]
      .map((rect) => rect.bottom)
      .sort((a, b) => a - b);

    document.querySelectorAll('.list-item').forEach((el) => {
      const from = fromRects.get(el.dataset.id);
      const to = el.getBoundingClientRect();
      if (!from || changedRects.has(el.dataset.id)) return;

      const affected = changedBottoms.some((bottom) => from.top >= bottom - 0.5);
      if (!affected) return;

      const dy = from.top - to.top;
      if (Math.abs(dy) < 0.5) return;

      el.animate(
        [
          { transform: `translateY(${dy}px)` },
          { transform: 'translateY(0)' },
        ],
        { duration: 260, easing: 'cubic-bezier(.2,.8,.2,1)' }
      );
    });

    observedListRects = getListItemRects();
  });
}

function animateLayoutChange(change) {
  const before = getListItemRects();
  change();
  animateListMovement(before);
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

function renderItem(item) {
  const li = document.createElement('li');
  li.className = 'list-item';
  if (item.strikethrough) li.classList.add('strikethrough');
  li.dataset.id = item.id;

  const favicon = document.createElement('img');
  favicon.className = 'list-item-favicon';
  favicon.src = item.favicon || `https://www.google.com/s2/favicons?domain=${getDomain(item.url)}&sz=32`;
  favicon.onerror = () => { favicon.src = ''; favicon.style.display = 'none'; };

  const content = document.createElement('div');
  content.className = 'list-item-content';

  const titleEl = document.createElement('div');
  titleEl.className = 'list-item-title';
  titleEl.textContent = item.title || item.url;
  if (item.strikethrough) titleEl.dataset.s = '';

  const domainEl = document.createElement('div');
  domainEl.className = 'list-item-domain';
  let domainText = `${getDomain(item.url)} · ${formatTime(item.addedAt)}`;
  if (item.scrollPercent !== undefined && item.scrollPercent > 0) {
    domainText += ` · ${item.scrollPercent}%`;
  }
  domainEl.textContent = domainText;

  content.appendChild(titleEl);
  content.appendChild(domainEl);

  const sourceEl = document.createElement('div');
  sourceEl.className = 'list-item-source';
  sourceEl.textContent = `来源 ${sourceText(item) || '未知'}`;
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

  // 浏览进度条
  if (item.scrollPercent !== undefined && item.scrollPercent > 0) {
    const progressContainer = document.createElement('div');
    progressContainer.className = 'scroll-progress';
    const progressBar = document.createElement('div');
    progressBar.className = 'scroll-progress-bar';
    const pct = Math.min(100, item.scrollPercent);
    progressBar.style.width = pct + '%';
    if (pct >= 100) progressBar.classList.add('complete');
    progressContainer.appendChild(progressBar);
    content.appendChild(progressContainer);
  }

  const actions = document.createElement('div');
  actions.className = 'list-item-actions';

  const readCheckbox = document.createElement('input');
  readCheckbox.className = 'list-item-read';
  readCheckbox.type = 'checkbox';
  readCheckbox.checked = !!item.strikethrough;
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
    armDeleteButton(deleteBtn);
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
    resetPendingDelete(deleteBtn);
  });

  actions.appendChild(readCheckbox);
  actions.appendChild(deleteBtn);
  actions.appendChild(cancelDeleteBtn);

  li.appendChild(favicon);
  li.appendChild(content);
  li.appendChild(actions);

  li.addEventListener('click', () => openItem(item));

  return li;
}

async function toggleStrikethrough(id) {
  const list = await getList();
  const item = list.find(i => i.id === id);
  if (!item) return;

  const li = document.querySelector(`.list-item[data-id="${id}"]`);
  if (!li) return;

  item.strikethrough = !item.strikethrough;
  await setList(list);
  viewState.list = list;

  if (viewState.filter !== 'all') {
    renderList(list);
    return;
  }

  const titleEl = li.querySelector('.list-item-title');

  if (!item.strikethrough) {
    // 取消删除线：直接操作现有 DOM
    li.classList.remove('strikethrough');
    li.classList.add('strikethrough-reverse');
    const spans = titleEl?.querySelectorAll(':scope > span');
    if (spans?.length > 0) {
      spans.forEach((span, i) => {
        span.style.animation = `strikeLineOut 0.35s ease-out ${(i * 0.1).toFixed(2)}s forwards`;
      });
    }
    setTimeout(() => {
      li.classList.remove('strikethrough-reverse');
      if (titleEl) {
        titleEl.innerHTML = '';
        titleEl.textContent = item.title || item.url;
        delete titleEl.dataset.s;
        titleEl.style.cssText = '';
      }
      updateCount();
    }, 450);
  } else {
    // 添加删除线：直接修改现有 DOM
    li.classList.add('strikethrough');
    if (titleEl) {
      titleEl.innerHTML = '';
      titleEl.textContent = item.title || item.url;
      titleEl.dataset.s = '';
    }
    processedAnimations.delete(item.id);
    requestAnimationFrame(splitStrikethroughLines);
    updateCount();
  }
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

function armDeleteButton(button) {
  resetPendingDelete();
  const cancelButton = button.parentElement?.querySelector('.list-item-cancel-delete');

  button.classList.add('confirming');
  button.textContent = '删除';
  button.title = '确认删除';
  button.setAttribute('aria-label', '确认删除');
  if (cancelButton) {
    cancelButton.classList.add('show');
    cancelButton.tabIndex = 0;
  }

  pendingDelete = {
    button,
    cancelButton,
    timer: setTimeout(() => resetPendingDelete(button), 3000),
  };
}

function resetPendingDelete(exceptButton = null) {
  if (!pendingDelete) return;
  const { button, cancelButton, timer } = pendingDelete;
  if (exceptButton && button !== exceptButton) return;
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

async function deleteItem(id) {
  const list = await getList();
  const filtered = list.filter(item => item.id !== id);
  await setList(filtered);
  viewState.list = filtered;
  renderList();
  showToast('已删除');
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

function renderList(list = viewState.list) {
  const before = getListItemRects();
  viewState.list = list;
  const visibleList = getVisibleList();
  const isEmpty = viewState.list.length === 0;
  elements.list.innerHTML = '';
  updateEmptyState(visibleList.length, viewState.list.length);
  if (isEmpty || visibleList.length === 0) {
    elements.count.textContent = viewState.list.length ? `显示 0 / 共 ${viewState.list.length} 项` : '';
    return;
  }
  visibleList.forEach(item => elements.list.appendChild(renderItem(item)));
  elements.count.textContent = visibleList.length === viewState.list.length
    ? `共 ${viewState.list.length} 项`
    : `显示 ${visibleList.length} / 共 ${viewState.list.length} 项`;
  animateListMovement(before);
  observeListLayout();
  requestAnimationFrame(splitStrikethroughLines);
}

function splitStrikethroughLines() {
  document.querySelectorAll('.list-item-title[data-s]').forEach(el => {
    const itemId = el.closest('.list-item')?.dataset.id;
    if (!itemId || processedAnimations.has(itemId)) return;
    processedAnimations.add(itemId);
    const text = el.textContent;
    const lh = parseFloat(getComputedStyle(el).lineHeight);
    if (!lh || !text) return;

    // 逐字包裹测量分行
    el.textContent = '';
    const chars = [];
    for (const ch of text) {
      const s = document.createElement('s');
      s.textContent = ch;
      s.style.cssText = 'display:inline; white-space:pre; font:inherit';
      el.appendChild(s);
      chars.push(s);
    }

    // 按 offsetTop 分组
    const lines = [{ spans: [chars[0]], text: chars[0].textContent }];
    for (let i = 1; i < chars.length; i++) {
      const lastTop = chars[i - 1].offsetTop;
      if (chars[i].offsetTop > lastTop + 1) {
        lines.push({ spans: [chars[i]], text: chars[i].textContent });
      } else {
        lines[lines.length - 1].spans.push(chars[i]);
        lines[lines.length - 1].text += chars[i].textContent;
      }
    }

    // 重建为逐行 span
    el.textContent = '';
    lines.forEach((line, i) => {
      const span = document.createElement('span');
      span.textContent = line.text;
      span.style.display = 'block';
      const delay = (i * 0.1).toFixed(2);
      span.style.cssText += `animation: strikeLineIn 0.35s ease-out ${delay}s forwards;`;
      el.appendChild(span);
    });
  });
}

async function addCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('edge://')) return;
  const normalizedUrl = normalizeUrl(tab.url);
  const item = {
    id: Date.now().toString(),
    title: tab.title || tab.url,
    url: tab.url,
    normalizedUrl,
    favicon: tab.favIconUrl || `https://www.google.com/s2/favicons?domain=${new URL(tab.url).hostname}&sz=32`,
    addedAt: Date.now(),
    sourceUrl: tab.url,
    sourceTitle: tab.title || tab.url,
    sourceDomain: getDomain(tab.url),
  };
  const list = await getList();
  const existingIndex = list.findIndex(i => (i.normalizedUrl || normalizeUrl(i.url)) === normalizedUrl);
  if (existingIndex >= 0) {
    const [existing] = list.splice(existingIndex, 1);
    list.unshift(existing);
    await setList(list);
    renderList(list);
    showToast('已在列表中，已移到顶部');
    return;
  }
  list.unshift(item);
  await setList(list);
  renderList(list);
  showToast('已添加到稍后再看');
}

async function clearAll() {
  if (viewState.list.length === 0) return;
  if (!confirm('确定清空全部稍后再看列表？')) return;
  await setList([]);
  renderList([]);
  showToast('已清空');
}

async function exportData() {
  const list = await getList();
  if (list.length === 0) { alert('列表为空，无需导出'); return; }
  const blob = new Blob([JSON.stringify({ version: 1, exportedAt: Date.now(), list }, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `稍后再看备份_${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

async function importData(file) {
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    const imported = data.list;
    if (!Array.isArray(imported)) throw new Error();
    const current = await getList();
    const existingUrls = new Set(current.map(i => i.normalizedUrl || normalizeUrl(i.url)));
    const newItems = imported
      .filter(i => i.url && !existingUrls.has(i.normalizedUrl || normalizeUrl(i.url)))
      .map(i => ({
        ...i,
        normalizedUrl: i.normalizedUrl || normalizeUrl(i.url),
        sourceUrl: i.sourceUrl || i.url,
        sourceTitle: i.sourceTitle || i.title || i.url,
        sourceDomain: i.sourceDomain || getDomain(i.sourceUrl || i.url),
      }));
    const merged = [...newItems, ...current];
    await setList(merged);
    renderList(merged);
    alert(`导入成功！新增 ${newItems.length} 项${newItems.length !== imported.length ? `，跳过 ${imported.length - newItems.length} 项重复` : ''}`);
  } catch {
    alert('导入失败：文件格式不正确');
  }
}

async function init() {
  panelPort = chrome.runtime.connect({ name: 'sidePanel' });
  const list = await getList();
  renderList(list);

  elements.addBtn.addEventListener('click', addCurrentTab);
  elements.searchInput.addEventListener('input', (e) => {
    viewState.query = e.target.value;
    renderList();
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

  chrome.runtime.sendMessage({ type: 'panelOpened' });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'closePanel') {
      closePanelWithAnimation();
    }
    if (msg.type === 'listUpdated') {
      chrome.storage.local.get({ [STORAGE_KEY]: [] }, (result) => {
        renderList(result[STORAGE_KEY]);
        showToast(msg.title ? `已添加：${msg.title}` : '已添加到稍后再看');
      });
    }
    if (msg.type === 'itemDuplicate') {
      chrome.storage.local.get({ [STORAGE_KEY]: [] }, (result) => {
        renderList(result[STORAGE_KEY]);
        showToast('已在列表中，已移到顶部');
      });
    }
    if (msg.type === 'scrollProgressUpdated') {
      // 实时更新单个项目的进度条，不重绘全部
      const li = document.querySelector(`.list-item[data-id="${msg.itemId}"]`);
      if (!li) return;
      const content = li.querySelector('.list-item-content');
      const itemInState = viewState.list.find(i => i.id === msg.itemId);
      if (itemInState) itemInState.scrollPercent = msg.percent;
      // 更新底部 domain 文字中的百分比
      const domainEl = li.querySelector('.list-item-domain');
      if (domainEl) {
        // 获取当前列表数据重建 domain 文字
        chrome.storage.local.get({ [STORAGE_KEY]: [] }, (result) => {
          const item = result[STORAGE_KEY].find(i => i.id === msg.itemId);
          if (!item) return;
          const newDomainText = `${getDomain(item.url)} · ${formatTime(item.addedAt)} · ${msg.percent}%`;
          domainEl.textContent = newDomainText;
        });
      }
      // 更新或创建进度条
      let progressContainer = li.querySelector('.scroll-progress');
      const pct = Math.min(100, msg.percent);
      if (progressContainer) {
        const bar = progressContainer.querySelector('.scroll-progress-bar');
        if (bar) {
          bar.style.width = pct + '%';
          bar.classList.toggle('complete', pct >= 100);
        }
      } else if (pct > 0 && content) {
        progressContainer = document.createElement('div');
        progressContainer.className = 'scroll-progress';
        const progressBar = document.createElement('div');
        progressBar.className = 'scroll-progress-bar';
        progressBar.style.width = pct + '%';
        if (pct >= 100) progressBar.classList.add('complete');
        progressContainer.appendChild(progressBar);
        content.appendChild(progressContainer);
      }
    }
  });

  window.addEventListener('pagehide', () => {
    chrome.runtime.sendMessage({ type: 'panelClosed' }).catch(() => {});
  });
}

document.addEventListener('DOMContentLoaded', init);
