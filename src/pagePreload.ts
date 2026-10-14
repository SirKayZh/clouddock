/**
 * 注入到每个账号标签页（含 iframe）的脚本：
 *  1. 捕获登录表单提交 -> 上报主进程（是否保存由用户在界面确认）
 *  2. 发现登录框 -> 向主进程请求【该账号 + 当前网站 origin】已保存的登录信息并自动填充
 *
 * 运行在隔离世界（contextIsolation + sandbox），页面脚本无法访问这里的 ipcRenderer。
 * 注意：sandbox 预加载脚本只能 require('electron')，所以保持单文件、不引用本地模块。
 */
import { ipcRenderer } from 'electron';

const TEXT_SEL =
  'input:not([type]), input[type="text"], input[type="email"], input[type="tel"], input[type="number"], input[type="search"]';
const SUBMIT_TEXT = /登录|登入|log\s?in|sign\s?in|submit|确定|下一步|继续|next/i;

function isVisible(el: HTMLElement): boolean {
  const r = el.getBoundingClientRect();
  if (r.width < 4 || r.height < 4) return false;
  const s = getComputedStyle(el);
  return s.visibility !== 'hidden' && s.display !== 'none';
}

function visiblePasswords(): HTMLInputElement[] {
  return Array.from(document.querySelectorAll<HTMLInputElement>('input[type="password"]')).filter(
    (p) => !p.disabled && isVisible(p),
  );
}

/** 找到和密码框同属一个登录表单的容器 */
function findContainer(pwd: HTMLInputElement): ParentNode {
  if (pwd.form) return pwd.form;
  let node: HTMLElement | null = pwd.parentElement;
  for (let i = 0; i < 6 && node; i += 1, node = node.parentElement) {
    if (node.querySelector(TEXT_SEL)) return node;
  }
  return document;
}

/** 密码框之前的可见文本输入框（用户名/邮箱/主账号 ID 等），最多取靠近密码框的 3 个 */
function userInputsFor(pwd: HTMLInputElement): HTMLInputElement[] {
  const all = Array.from(findContainer(pwd).querySelectorAll<HTMLInputElement>(TEXT_SEL));
  return all
    .filter(
      (el) =>
        !el.disabled &&
        !el.readOnly &&
        isVisible(el) &&
        (el.compareDocumentPosition(pwd) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
    )
    .slice(-3);
}

function setValue(el: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
  // 触发框架（React/Vue）的受控输入更新
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

/* ---------- 捕获 ---------- */

let lastSig = '';

function tryCapture(): void {
  try {
    const pwds = visiblePasswords().filter((p) => p.value);
    // 多个密码框 = 注册 / 修改密码，不处理
    if (pwds.length !== 1) return;
    const pwd = pwds[0];
    const values = userInputsFor(pwd).map((el) => el.value.trim());
    while (values.length > 0 && values[0] === '') values.shift();
    if (values.length === 0 || values[values.length - 1] === '') return;
    const sig = `${values.join('\u0000')}\u0001${pwd.value}`;
    if (sig === lastSig) return;
    lastSig = sig;
    ipcRenderer.send('cred:captured', { fields: values, password: pwd.value });
  } catch {
    /* 页面结构异常时静默 */
  }
}

document.addEventListener('submit', tryCapture, true);
document.addEventListener(
  'click',
  (e) => {
    const target = e.target as Element | null;
    const btn = target?.closest?.('button, input[type="submit"], [role="button"], a');
    if (!btn) return;
    const text = (btn as HTMLElement).innerText || (btn as HTMLInputElement).value || '';
    const isSubmit = (btn as HTMLButtonElement).type === 'submit' || SUBMIT_TEXT.test(text);
    if (isSubmit) tryCapture();
  },
  true,
);
document.addEventListener(
  'keydown',
  (e) => {
    if (e.key === 'Enter' && (e.target as HTMLElement | null)?.tagName === 'INPUT') tryCapture();
  },
  true,
);

/* ---------- 自动填充 ---------- */

const handled = new WeakSet<HTMLInputElement>();
let running = false;

async function autofill(): Promise<void> {
  if (running) return;
  const pwds = visiblePasswords().filter((p) => !handled.has(p) && !p.value);
  if (pwds.length === 0) return;
  // 多个密码框（注册/改密页）不自动填
  if (pwds.length > 1) return;
  running = true;
  try {
    const cred = (await ipcRenderer.invoke('cred:get')) as { fields: string[]; password: string } | null;
    for (const pwd of pwds) {
      handled.add(pwd);
      if (!cred || !Array.isArray(cred.fields)) continue;
      const inputs = userInputsFor(pwd);
      // 右对齐：离密码框最近的输入框 = 最后一个字段（用户名），往前依次是主账号 ID 等
      cred.fields.forEach((val, i) => {
        const idx = inputs.length - cred.fields.length + i;
        const el = idx >= 0 ? inputs[idx] : undefined;
        if (el && val && !el.value) setValue(el, val);
      });
      if (!pwd.value) setValue(pwd, cred.password);
    }
  } catch {
    /* 主进程拒绝或页面销毁：忽略 */
  } finally {
    running = false;
  }
}

let timer: ReturnType<typeof setTimeout> | null = null;
function schedule(): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void autofill();
  }, 300);
}

function start(): void {
  schedule();
  // 登录页多为 SPA / 动态 iframe，监听 DOM 变化
  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
else start();
