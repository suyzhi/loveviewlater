const STORAGE_KEY = 'readLaterList';
const BACKUP_FILENAME = '稍后再看自动备份.json';

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
  backupDirBtn: document.getElementById('backupDirBtn'),
  backupDirLabel: document.getElementById('backupDirLabel'),
};

let backupDirHandle = null;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('ReadLaterBackup', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('handles');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveHandle(handle) {
  const db = await openDB();
  const tx = db.transaction('handles', 'readwrite');
  tx.objectStore('handles').put(handle, 'backupDir');
  await new Promise(r => { tx.oncomplete = r; });
}

async function loadHandle() {
  const db = await openDB();
  const tx = db.transaction('handles', 'readonly');
  const req = tx.objectStore('handles').get('backupDir');
  return new Promise((resolve) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
}

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
  autoBackup();
}

async function renderList(list) {
  const isEmpty = list.length === 0;
  elements.list.innerHTML = '';
  elements.emptyState.classList.toggle('hidden', !isEmpty);
  elements.footer.classList.toggle('hidden', isEmpty);
  if (isEmpty) return;
  list.forEach(item => elements.list.appendChild(renderItem(item)));
  elements.count.textContent = `共 ${list.length} 项`;
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
  renderList(list);
  autoBackup();
}

async function clearAll() {
  if (document.querySelectorAll('.list-item').length === 0) return;
  if (!confirm('确定清空全部稍后再看列表？')) return;
  await setList([]);
  renderList([]);
  autoBackup();
}

async function writeToCustomDir(blob) {
  if (!backupDirHandle) return;
  try {
    const fileHandle = await backupDirHandle.getFileHandle(BACKUP_FILENAME, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(blob);
    await writable.close();
  } catch (e) {
    backupDirHandle = null;
    updateBackupLabel();
  }
}

async function readFromCustomDir() {
  if (!backupDirHandle) return null;
  try {
    const fileHandle = await backupDirHandle.getFileHandle(BACKUP_FILENAME);
    const file = await fileHandle.getFile();
    return await file.text();
  } catch {
    return null;
  }
}

async function autoBackup() {
  const list = await getList();
  const data = JSON.stringify({ version: 1, exportedAt: Date.now(), list }, null, 2);
  const blob = new Blob([data], { type: 'application/json' });
  const url = URL.createObjectURL(blob);

  // always backup to Downloads
  try {
    await chrome.downloads.download({ url, filename: BACKUP_FILENAME, saveAs: false, conflictAction: 'overwrite' });
  } catch {}

  // also backup to custom directory if set
  await writeToCustomDir(blob);
  URL.revokeObjectURL(url);
}

async function autoRestore() {
  // try custom directory first
  if (backupDirHandle) {
    const text = await readFromCustomDir();
    if (text) {
      const data = JSON.parse(text);
      if (Array.isArray(data.list) && data.list.length > 0) {
        const list = await getList();
        if (list.length === 0) {
          await setList(data.list);
          return true;
        }
      }
    }
  }

  // fallback to Downloads backup
  try {
    const items = await chrome.downloads.search({ filename: BACKUP_FILENAME, orderBy: ['-startTime'], limit: 1 });
    if (items.length === 0) return false;
    const resp = await fetch(items[0].url);
    const data = await resp.json();
    if (Array.isArray(data.list) && data.list.length > 0) {
      const list = await getList();
      if (list.length === 0) {
        await setList(data.list);
        return true;
      }
    }
  } catch {}
  return false;
}

async function pickBackupDir() {
  try {
    const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
    backupDirHandle = handle;
    await saveHandle(handle);
    updateBackupLabel();
    // immediately save a backup
    autoBackup();
  } catch (e) {
    if (e.name !== 'AbortError') {
      alert('选择备份目录失败：' + e.message);
    }
  }
}

function updateBackupLabel() {
  if (backupDirHandle && backupDirHandle.name) {
    elements.backupDirLabel.textContent = backupDirHandle.name;
    elements.backupDirLabel.title = backupDirHandle.name;
  } else {
    elements.backupDirLabel.textContent = '未设置（自动备份到下载文件夹）';
    elements.backupDirLabel.title = '';
  }
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
    autoBackup();
    alert(`导入成功！新增 ${newItems.length} 项${newItems.length !== imported.length ? `，跳过 ${imported.length - newItems.length} 项重复` : ''}`);
  } catch {
    alert('导入失败：文件格式不正确');
  }
}

async function init() {
  // restore backup directory handle
  backupDirHandle = await loadHandle();
  updateBackupLabel();

  // try auto-restore if list is empty
  let list = await getList();
  if (list.length === 0) {
    const restored = await autoRestore();
    if (restored) list = await getList();
  }
  renderList(list);

  elements.addBtn.addEventListener('click', addCurrentTab);
  elements.clearBtn.addEventListener('click', clearAll);
  elements.exportBtn.addEventListener('click', exportData);
  elements.importBtn.addEventListener('click', () => elements.importFileInput.click());
  elements.backupDirBtn.addEventListener('click', pickBackupDir);
  elements.importFileInput.addEventListener('change', (e) => {
    if (e.target.files[0]) { importData(e.target.files[0]); e.target.value = ''; }
  });

  chrome.storage.onChanged.addListener((changes) => {
    if (changes[STORAGE_KEY]) renderList(changes[STORAGE_KEY].newValue || []);
  });
}

document.addEventListener('DOMContentLoaded', init);
