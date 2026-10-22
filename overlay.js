/* 工作区下拉浮层：全窗口透明，点击空白处/Esc 关闭；面板锚定在侧栏触发器下方 */
const panel = document.getElementById('panel');
const backdrop = document.getElementById('backdrop');
let data = null;
let editing = false;

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function place() {
  const { anchor, collapsed } = data;
  // 展开态：与触发器同宽；窄栏：88px 放不下，向右伸出成独立浮层（不再受窄栏限制）
  const width = collapsed ? 184 : Math.max(anchor.w, 200);
  const left = collapsed ? Math.max(6, anchor.x - 2) : anchor.x;
  panel.style.width = width + 'px';
  panel.style.left = left + 'px';
  panel.style.top = anchor.y + anchor.h + 6 + 'px';
  panel.style.visibility = 'visible';
}

function render() {
  if (!data) return;
  panel.innerHTML = '';
  const t = document.createElement('div');
  t.className = 'title';
  t.textContent = '切换工作区';
  panel.appendChild(t);
  data.berths.forEach((b) => {
    const item = document.createElement('button');
    item.className = 'item' + (b.id === data.activeBerthId ? ' active' : '');
    item.dataset.id = b.id;
    item.innerHTML = `<span class="name">${esc(b.name)}</span><span class="check">✓</span>`;
    item.addEventListener('click', () => {
      if (editing) return;
      if (b.id === data.activeBerthId) window.overlayApi.close();
      else window.overlayApi.switchBerth(b.id);
    });
    item.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (!editing) window.overlayApi.menu(b.id);
    });
    panel.appendChild(item);
  });
  const sep = document.createElement('div');
  sep.className = 'sep';
  panel.appendChild(sep);
  const add = document.createElement('button');
  add.className = 'item new';
  add.innerHTML = '<span class="plus">＋</span><span class="name">新建工作区</span>';
  add.addEventListener('click', () => startInput(add, '', (v) => window.overlayApi.addBerth(v)));
  panel.appendChild(add);
  place();
}

/** 原位编辑：把按钮/名字替换成输入框，Enter/失焦保存，Esc 取消 */
function startInput(host, initial, onSave, placeholder) {
  if (editing) return;
  editing = true;
  const input = document.createElement('input');
  input.className = 'edit';
  input.maxLength = 12;
  input.value = initial;
  input.placeholder = placeholder || '工作区名称，Enter 确认';
  input.setAttribute('spellcheck', 'false');
  const target = host.classList.contains('item') && !host.classList.contains('new') ? host.querySelector('.name') : host;
  if (host.classList.contains('new')) host.replaceWith(input);
  else target.replaceWith(input);
  let closed = false;
  let composing = false;
  const done = async (save) => {
    if (closed) return;
    closed = true;
    editing = false;
    const v = input.value.trim();
    if (save && v && v !== initial) await onSave(v);
    else window.overlayApi.close();
  };
  input.addEventListener('compositionstart', () => { composing = true; });
  input.addEventListener('compositionend', () => { composing = false; });
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (composing || e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter') done(true);
    if (e.key === 'Escape') done(false);
  });
  input.addEventListener('blur', () => { if (!composing) done(true); });
  input.focus();
  input.select();
}

backdrop.addEventListener('mousedown', () => { if (!editing) window.overlayApi.close(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !editing) window.overlayApi.close(); });

window.overlayApi.onInit((init) => {
  data = init;
  editing = false;
  render();
});
window.overlayApi.onRename((id) => {
  if (!data || editing) return;
  const b = data.berths.find((x) => x.id === id);
  const item = panel.querySelector(`.item[data-id="${id}"]`);
  if (!b || !item) return;
  startInput(item, b.name, (v) => window.overlayApi.renameBerth(b.id, v));
});
window.overlayApi.ready();
