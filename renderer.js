'use strict';

const els = {
  list: document.getElementById('accountList'),
  empty: document.getElementById('empty'),
  back: document.getElementById('navBack'),
  fwd: document.getElementById('navFwd'),
  reload: document.getElementById('navReload'),
  home: document.getElementById('navHome'),
  url: document.getElementById('urlInput'),
  badge: document.getElementById('activeBadge'),
  addBtn: document.getElementById('btnAdd'),
  footer: document.getElementById('sbFooter'),
};

let state = {
  accounts: [],
  activeId: null,
  url: '',
  title: '',
  canGoBack: false,
  canGoForward: false,
  isLoading: false,
};
let editing = false; // 添加/重命名进行中时跳过列表重渲染

window.api.onState((s) => {
  state = s;
  render();
});

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function activeAccount() {
  return state.accounts.find((a) => a.id === state.activeId) || null;
}

async function selectAccount(id) {
  localStorage.setItem('clouddock:lastActive', id);
  await window.api.switch(id);
}

function render() {
  renderToolbar();
  if (!editing) renderList();
  els.empty.style.display = state.accounts.length === 0 ? 'flex' : 'none';
}

function renderToolbar() {
  els.back.disabled = !state.canGoBack;
  els.fwd.disabled = !state.canGoForward;
  if (document.activeElement !== els.url) {
    els.url.value = state.url;
  }
  const acc = activeAccount();
  if (acc) {
    const dot = `<span class="dot" style="background:${acc.color}"></span>`;
    const spin = state.isLoading ? '<span class="spin">⟳</span>' : '';
    els.badge.innerHTML = `${dot}<span>${escapeHtml(acc.name)}</span>${spin}`;
  } else {
    els.badge.innerHTML = '<span class="badge-none">未选择账号</span>';
  }
}

function renderList() {
  els.list.innerHTML = '';
  state.accounts.forEach((acc, i) => {
    const item = document.createElement('div');
    item.className = 'acc-item' + (acc.id === state.activeId ? ' active' : '');
    const hint = i < 9 ? `<span class="acc-hint">⌘${i + 1}</span>` : '';
    item.innerHTML = `
      <span class="acc-avatar" style="background:${acc.color}">${escapeHtml(acc.name.slice(0, 1).toUpperCase())}</span>
      <span class="acc-info">
        <span class="acc-name" title="双击重命名">${escapeHtml(acc.name)}</span>
        ${acc.note ? `<span class="acc-note">${escapeHtml(acc.note)}</span>` : ''}
      </span>
      ${hint}
      <span class="acc-del" title="删除账号">✕</span>`;
    item.addEventListener('click', (e) => {
      if (e.target.classList.contains('acc-del')) return;
      selectAccount(acc.id);
    });
    item.querySelector('.acc-del').addEventListener('click', async (e) => {
      e.stopPropagation();
      await window.api.remove(acc.id);
    });
    item.querySelector('.acc-name').addEventListener('dblclick', () => startRename(item, acc));
    els.list.appendChild(item);
  });
}

function startRename(item, acc) {
  editing = true;
  const nameEl = item.querySelector('.acc-name');
  const input = document.createElement('input');
  input.className = 'rename-input';
  input.value = acc.name;
  nameEl.replaceWith(input);
  input.focus();
  input.select();
  let closed = false;
  const done = async (save) => {
    if (closed) return;
    closed = true;
    editing = false;
    const v = input.value.trim();
    input.replaceWith(nameEl);
    if (save && v && v !== acc.name) await window.api.rename(acc.id, v);
    render();
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') done(true);
    if (e.key === 'Escape') done(false);
  });
  input.addEventListener('blur', () => done(true));
}

function showAddForm() {
  editing = true;
  els.addBtn.style.display = 'none';
  const form = document.createElement('div');
  form.className = 'add-form';
  form.innerHTML = `
    <input id="addName" class="add-input" placeholder="账号名称，如：生产环境" maxlength="30">
    <input id="addNote" class="add-input" placeholder="备注（可选），如：UIN 1000xxxx" maxlength="60">
    <div class="add-actions">
      <button class="btn primary" id="addOk">添加并登录</button>
      <button class="btn" id="addCancel">取消</button>
    </div>`;
  els.footer.insertBefore(form, els.footer.firstChild);
  const nameEl = form.querySelector('#addName');
  nameEl.focus();
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    editing = false;
    form.remove();
    els.addBtn.style.display = '';
  };
  const submit = async () => {
    const name = nameEl.value.trim();
    const note = form.querySelector('#addNote').value.trim();
    if (!name) { nameEl.focus(); return; }
    close();
    const acc = await window.api.add(name, note);
    localStorage.setItem('clouddock:lastActive', acc.id);
  };
  form.querySelector('#addOk').addEventListener('click', submit);
  form.querySelector('#addCancel').addEventListener('click', close);
  form.querySelectorAll('input').forEach((inp) => {
    inp.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') submit();
      if (e.key === 'Escape') close();
    });
  });
}

/* ---------- 事件绑定 ---------- */

els.addBtn.addEventListener('click', showAddForm);
document.getElementById('btnAddEmpty').addEventListener('click', showAddForm);
els.back.addEventListener('click', () => window.api.nav('back'));
els.fwd.addEventListener('click', () => window.api.nav('forward'));
els.reload.addEventListener('click', () => window.api.nav('reload'));
els.home.addEventListener('click', () => window.api.nav('home'));

els.url.addEventListener('keydown', (e) => {
  e.stopPropagation();
  if (e.key === 'Enter') {
    window.api.openUrl(els.url.value.trim());
    els.url.blur();
  }
});

window.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && /^Digit[1-9]$/.test(e.code)) {
    const acc = state.accounts[Number(e.code.slice(5)) - 1];
    if (acc) {
      e.preventDefault();
      selectAccount(acc.id);
    }
  }
});

/* ---------- 初始化 ---------- */

(async function init() {
  const list = await window.api.list();
  if (state.accounts.length === 0) state.accounts = list;
  render();
  const last = localStorage.getItem('clouddock:lastActive');
  if (last && list.some((a) => a.id === last)) {
    await window.api.switch(last);
  }
})();
