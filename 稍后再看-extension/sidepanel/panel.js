const STORAGE_KEY = 'readLaterList';

const elements = {
  list: document.getElementById('list'),
  emptyState: document.getElementById('emptyState'),
  footer: document.getElementById('footer'),
  count: document.getElementById('count'),
  addBtn: document.getElementById('addBtn'),
  clearBtn: document.getElementById('clearBtn'),
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

  const domainEl = document.createElement('div');
  domainEl.className = 'list-item-domain';
  domainEl.textContent = `${getDomain(item.url)} · ${formatTime(item.addedAt)}`;

  content.appendChild(titleEl);
  content.appendChild(domainEl);

  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'list-item-delete';
  deleteBtn.textContent = '✕';
  deleteBtn.title = '删除';
  deleteBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    deleteItem(item.id);
  });

  li.appendChild(favicon);
  li.appendChild(content);
  li.appendChild(deleteBtn);

  li.addEventListener('click', () => openItem(item));

  return li;
}

function openItem(item) {
  chrome.tabs.create({ url: item.url, active: false });
}

async function deleteItem(id) {
  const list = await getList();
  const filtered = list.filter(item => item.id !== id);
  await setList(filtered);
  renderList(filtered);
}

async function renderList(list) {
  const isEmpty = list.length === 0;

  elements.list.innerHTML = '';
  elements.emptyState.classList.toggle('hidden', !isEmpty);
  elements.footer.classList.toggle('hidden', isEmpty);

  if (isEmpty) return;

  list.forEach(item => {
    elements.list.appendChild(renderItem(item));
  });

  elements.count.textContent = `共 ${list.length} 项`;
}

async function addCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('edge://')) {
    return;
  }

  const item = {
    id: Date.now().toString(),
    title: tab.title || tab.url,
    url: tab.url,
    favicon: tab.favIconUrl || `https://www.google.com/s2/favicons?domain=${new URL(tab.url).hostname}&sz=32`,
    addedAt: Date.now(),
  };

  const list = await getList();
  const exists = list.some(i => i.url === item.url);
  if (exists) return;

  list.unshift(item);
  await setList(list);
  renderList(list);
}

async function clearAll() {
  if (document.querySelectorAll('.list-item').length === 0) return;
  if (!confirm('确定清空全部稍后再看列表？')) return;
  await setList([]);
  renderList([]);
}

async function init() {
  const list = await getList();
  renderList(list);

  elements.addBtn.addEventListener('click', addCurrentTab);
  elements.clearBtn.addEventListener('click', clearAll);

  chrome.storage.onChanged.addListener((changes) => {
    if (changes[STORAGE_KEY]) {
      renderList(changes[STORAGE_KEY].newValue || []);
    }
  });
}

document.addEventListener('DOMContentLoaded', init);
