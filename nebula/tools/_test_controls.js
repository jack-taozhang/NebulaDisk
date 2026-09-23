/* ============================================================================
 * _test_controls.js —— ★ 窗口控制键监听不许吞掉业务按钮的 click ★
 *
 * 对应 bug（真实浏览器 track 出来的）：
 *   「在预览窗口点『下一个文件』，文件不切换」
 *   根因：_bindControls 用 `querySelectorAll('.tb-btn')` 选中了**所有** .tb-btn，
 *         而翻页键的 class 恰好是 `tb-btn nav-btn`；那条监听第一行无条件
 *         `e.stopPropagation()`，把 click 在到达 .win-toolbar 业务监听前掐断。
 *
 * 本测试的原则（与其它测试一致）：
 *   · 只从**产品源码**里抽取，绝不复制一份逻辑进来（否则测的是副本）
 *   · §0 先断言源码形态（收窄过的选择器 + 仍带 stopPropagation）
 *   · 用真实 DOM 桩跑 _bindControls，验证：
 *       ① 三键（带 data-act）能被选中并触发对应动作
 *       ② 翻页键（tb-btn nav-btn，无 data-act）**不被选中** → 不吞事件
 *       ③ 普通业务按钮（.tbtn）同样不被选中
 * ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SHELL = path.resolve(__dirname, '../web/js/shell.js');
const src = fs.readFileSync(SHELL, 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${extra ? '  → ' + extra : ''}`); }
};

/* ---------- 极简 DOM 桩 ---------- */
class El {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.dataset = {};
    this._listeners = {};
    this.classList = { add() {}, remove() {}, toggle() {} };
  }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  addEventListener(t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); }
  removeEventListener(t, fn) {
    const a = this._listeners[t] || [];
    const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1);
  }
  /** 只支持本测试用到的选择器：.a.b / [attr] / .a[attr] */
  matches(sel) {
    return sel.split(/(?=\.)|(?=\[)/).filter(Boolean).every((part) => {
      if (part.startsWith('.')) {
        const cls = part.slice(1);
        return (this._cls || []).includes(cls);
      }
      if (part.startsWith('[')) {
        const m = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(part);
        if (!m) return false;
        const key = m[1] === 'data-act' ? 'act'
                  : m[1].startsWith('data-') ? m[1].slice(5) : m[1];
        return m[2] === undefined ? this.dataset[key] !== undefined
                                  : this.dataset[key] === m[2];
      }
      return false;
    });
  }
  querySelectorAll(sel) {
    const out = [];
    const walk = (n) => {
      for (const c of n.children) {
        for (const s of sel.split(',').map((x) => x.trim())) if (c.matches(s)) { out.push(c); break; }
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  fire(type, ev) {
    for (const fn of (this._listeners[type] || []).slice()) fn(ev);
  }
}

/** 造一个按钮：cls 是 class 列表，data 是 dataset */
function btn(cls, data) {
  const b = new El('button');
  b._cls = cls;
  b.dataset = Object.assign({}, data);
  return b;
}

/* ---------- 从源码抽取 _bindControls ---------- */
function extractFn(name) {
  const i = src.indexOf(`function ${name}(`);
  if (i < 0) throw new Error(`源码里找不到 ${name}()，shell.js 可能被重构过`);
  let d = 0, started = false;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') { d++; started = true; }
    else if (src[j] === '}') { d--; if (started && d === 0) return src.slice(i, j + 1); }
  }
  throw new Error(`${name}() 花括号不配对`);
}

const fnSrc = extractFn('_bindControls');

/**
 * 去注释后的源码。
 * ★ 教训：负向断言（"不该出现 X"）必须先 stripComments ——
 *   否则注释里为了解释历史而提到的那段旧写法会把断言误判成失败。
 */
function stripComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}
const fnBare = stripComments(fnSrc);

/* ---------- §0 源码形态断言 ---------- */
console.log('\n§0 源码形态（防回归的第一道闸）');
ok('选择器已收窄为 .tb-btn[data-act]',
   /querySelectorAll\(\s*['"]\.tb-btn\[data-act\]['"]\s*\)/.test(fnBare),
   '还是老写法 .tb-btn —— 会再次吞掉翻页键的 click');
ok('不再有裸的 querySelectorAll(\'.tb-btn\')（已去注释）',
   !/querySelectorAll\(\s*['"]\.tb-btn['"]\s*\)/.test(fnBare));
ok('仍然保留 stopPropagation（避免冒泡到全局兜底）',
   /stopPropagation\s*\(/.test(fnBare));

/* ---------- 用 DOM 桩真跑一遍 ---------- */
console.log('\n§1 三键照常工作（带 data-act）');

const calls = [];
const sandbox = {
  console,
  minimize: (id) => calls.push(['min', id]),
  toggleMax: (id) => calls.push(['max', id]),
  close: (id) => calls.push(['close', id]),
  _bindControls: null,
};
vm.createContext(sandbox);
vm.runInContext(`${fnSrc}\n; this._bindControls = _bindControls;`, sandbox);
const bindControls = sandbox._bindControls;

function buildWin() {
  const el = new El('div');
  el._cls = ['window'];
  // 窗口控制键（WM 自己的三键）
  const min = btn(['tb-btn'], { act: 'min' });
  const max = btn(['tb-btn', 'max'], { act: 'max' });
  const cls = btn(['tb-btn', 'close'], { act: 'close' });
  // 翻页键 —— class 是 tb-btn nav-btn，但**没有** data-act
  const prev = btn(['tb-btn', 'nav-btn'], { a: 'prev' });
  const next = btn(['tb-btn', 'nav-btn'], { a: 'next' });
  // 业务按钮，class 是 .tbtn
  const zoom = btn(['tbtn'], { a: 'zoomin' });
  [min, max, cls, prev, next, zoom].forEach((b) => el.appendChild(b));
  return { el, min, max, cls, prev, next, zoom };
}

{
  const w = buildWin();
  bindControls({ id: 'img:共享', el: w.el });

  calls.length = 0;
  w.min.fire('click', { stopPropagation() {} });
  ok('min 触发', JSON.stringify(calls) === JSON.stringify([['min', 'img:共享']]), JSON.stringify(calls));

  calls.length = 0;
  w.max.fire('click', { stopPropagation() {} });
  ok('max 触发', JSON.stringify(calls) === JSON.stringify([['max', 'img:共享']]), JSON.stringify(calls));

  calls.length = 0;
  w.cls.fire('click', { stopPropagation() {} });
  ok('close 触发', JSON.stringify(calls) === JSON.stringify([['close', 'img:共享']]), JSON.stringify(calls));
}

console.log('\n§2 ★翻页键绝不被吞★（本条就是本次 bug 的守门人）');
{
  const w = buildWin();
  bindControls({ id: 'img:共享', el: w.el });

  // 翻页键上不该有任何 click 监听
  ok('next 上没有挂到 click 监听',
     (w.next._listeners.click || []).length === 0,
     `挂了 ${(w.next._listeners.click || []).length} 条`);
  ok('prev 上没有挂到 click 监听',
     (w.prev._listeners.click || []).length === 0);

  // 端到端：模拟真实冒泡。next 的 click 必须能到达祖先（.win-toolbar）
  let reachedToolbar = false;
  const bar = new El('div');
  bar._cls = ['toolbar', 'win-toolbar'];
  bar.addEventListener('click', () => { reachedToolbar = true; });
  bar.appendChild(w.next);

  // 模拟浏览器冒泡：从 next 依次向上派发，任一环节 stopPropagation 即中断
  const bubble = (node, ev) => {
    for (let n = node; n; n = n.parentNode) {
      let stopped = false;
      const e = Object.assign({}, ev, { stopPropagation: () => { stopped = true; } });
      n.fire('click', e);
      if (stopped) return;
      if (ev.__prevented) return;
    }
  };
  bubble(w.next, {});
  ok('★ next 的 click 能冒泡到 .win-toolbar（不再被掐断）', reachedToolbar === true);

  // 反向保护：三键仍然要 stopPropagation（不然会冒到 app.js 全局兜底）
  let leaked = false;
  const bar2 = new El('div');
  bar2._cls = ['toolbar', 'win-toolbar'];
  bar2.addEventListener('click', () => { leaked = true; });
  bar2.appendChild(w.cls);
  bubble(w.cls, {});
  ok('三键仍会 stopPropagation（不外泄到全局兜底）', leaked === false);
}

console.log('\n§3 业务按钮（.tbtn）也不被选中');
{
  const w = buildWin();
  bindControls({ id: 'x', el: w.el });
  ok('zoomin(.tbtn) 上没有 click 监听',
     (w.zoom._listeners.click || []).length === 0);
}

console.log('\n§4 只处理带 data-act 的键，未知 act 不炸');
{
  const w = buildWin();
  const weird = btn(['tb-btn'], { act: 'nope' });
  w.el.appendChild(weird);
  bindControls({ id: 'x', el: w.el });
  calls.length = 0;
  let threw = false;
  try { weird.fire('click', { stopPropagation() {} }); } catch (e) { threw = true; }
  ok('未知 data-act 不抛错、也不产生动作', !threw && calls.length === 0);
}

console.log(`\n════════════════════════════════`);
console.log(`  通过 ${pass} / ${pass + fail}`);
if (fail) { console.log(`  ❌ 失败 ${fail} 项`); process.exit(1); }
console.log('  ✅ 全部通过');
