const STORAGE_KEY = 'readLaterList';
const processedAnimations = new Set();

const elements = {
  list: document.getElementById('list'),
  emptyState: document.getElementById('emptyState'),
  footer: document.getElementById('footer'),
  count: document.getElementById('count'),
  addBtn: document.getElementById('addBtn'),
  clearBtn: document.getElementById('clearBtn'),
  exportBtn: document.getElementById('exportBtn'),
  importBtn: document.getElementById('importBtn'),
  importFileInput: document.getElementById('importFileInput'),
  reloadBtn: document.getElementById('reloadBtn'),
};

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

  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'list-item-delete';
  deleteBtn.textContent = '✕';
  deleteBtn.title = '点击标记已读，右键永久删除';
  deleteBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleStrikethrough(item.id);
  });
  deleteBtn.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (confirm(`确定永久删除「${item.title}」？`)) {
      deleteItem(item.id);
    }
  });

  li.appendChild(favicon);
  li.appendChild(content);
  li.appendChild(deleteBtn);

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
  const n = document.querySelectorAll('.list-item').length;
  document.getElementById('count').textContent = `共 ${n} 项`;
}

function openItem(item) {
  chrome.runtime.sendMessage({ type: 'openItem', url: item.url, itemId: item.id });
}

async function deleteItem(id) {
  const list = await getList();
  const filtered = list.filter(item => item.id !== id);
  await setList(filtered);
  // 直接移除 DOM 节点，避免全量重绘触发动画重播
  const li = document.querySelector(`.list-item[data-id="${id}"]`);
  li?.remove();
  // 如果列表空了，更新空状态
  if (filtered.length === 0) {
    elements.list.innerHTML = '';
    elements.emptyState.classList.remove('hidden');
    elements.footer.classList.add('hidden');
  }
  updateCount();
}

async function renderList(list) {
  const isEmpty = list.length === 0;
  elements.list.innerHTML = '';
  elements.emptyState.classList.toggle('hidden', !isEmpty);
  elements.footer.classList.toggle('hidden', isEmpty);
  if (isEmpty) return;
  list.forEach(item => elements.list.appendChild(renderItem(item)));
  elements.count.textContent = `共 ${list.length} 项`;
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
  const item = {
    id: Date.now().toString(),
    title: tab.title || tab.url,
    url: tab.url,
    favicon: tab.favIconUrl || `https://www.google.com/s2/favicons?domain=${new URL(tab.url).hostname}&sz=32`,
    addedAt: Date.now(),
  };
  const list = await getList();
  if (list.some(i => i.url === item.url)) return;
  list.unshift(item);
  await setList(list);
  // 只追加新元素，不重绘全部
  elements.emptyState.classList.add('hidden');
  elements.footer.classList.remove('hidden');
  elements.list.prepend(renderItem(item));
  updateCount();
}

async function clearAll() {
  if (document.querySelectorAll('.list-item').length === 0) return;
  if (!confirm('确定清空全部稍后再看列表？')) return;
  await setList([]);
  renderList([]);
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
    const existingUrls = new Set(current.map(i => i.url));
    const newItems = imported.filter(i => i.url && !existingUrls.has(i.url));
    const merged = [...newItems, ...current];
    await setList(merged);
    renderList(merged);
    alert(`导入成功！新增 ${newItems.length} 项${newItems.length !== imported.length ? `，跳过 ${imported.length - newItems.length} 项重复` : ''}`);
  } catch {
    alert('导入失败：文件格式不正确');
  }
}

async function init() {
  const list = await getList();
  renderList(list);

  elements.addBtn.addEventListener('click', addCurrentTab);
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
      window.close();
    }
    if (msg.type === 'listUpdated') {
      // 增量更新，不触发全量重绘
      chrome.storage.local.get({ [STORAGE_KEY]: [] }, (result) => {
        const newList = result[STORAGE_KEY];
        const existingIds = new Set([...document.querySelectorAll('.list-item')].map(li => li.dataset.id));
        const toAdd = newList.filter(item => !existingIds.has(item.id));
        if (toAdd.length > 0) {
          elements.emptyState.classList.add('hidden');
          elements.footer.classList.remove('hidden');
          for (const item of toAdd) {
            elements.list.prepend(renderItem(item));
          }
          updateCount();
        }
      });
    }
  });

  window.addEventListener('pagehide', () => {
    chrome.runtime.sendMessage({ type: 'panelClosed' });
    document.getElementById('app').classList.add('slide-out');
  });
}

document.addEventListener('DOMContentLoaded', init);
