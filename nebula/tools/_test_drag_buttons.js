/* =============================================================================
   _test_drag_buttons.js —— 「工具栏上按下」的纯逻辑仿真
                              （按钮失效 / 不置顶 两个反面）

   ★ 第一原则：从 js/shell.js **抽取真实源码**执行，绝不抄一份进来。★

   ---------------------------------------------------------------------------
   bug ①（按钮失效）用户原文
   ---------------------------------------------------------------------------
     「文件窗口，除了最大化，最小化，关闭外，最顶上其他的按钮都失效了。」

   根因：
     `_bindDrag` 把整条工具栏（[data-drag-handle]）当拖动区，并且在
     pointerdown 里对**非按钮**目标调用了 `e.preventDefault()`。
     而它对「按钮」的豁免判据写的是 `.tb-btn` ——
     这恰好只匹配 WM 自己的三键（最小化/最大化/关闭），
     业务按钮用的是 `.tbtn`（新建文件夹/上传/重命名/下载/删除/视图/排序/详情），
     **不匹配** → 于是点业务按钮时：
        ① 进入拖动分支；
        ② 执行 preventDefault()（在 pointerdown 上）；
        ③ 浏览器因此不再派生 mousedown → click，
           按钮的 click 监听永不触发 → 表现为「按钮全失效」。
     三键因为命中 `.tb-btn` 提前 return，所以只有它们还能用 ——
     与用户描述完全一致。

   修法判据：从「是不是 .tb-btn」放宽为「是不是按钮/可交互控件」。
     'button, [role="button"], input, textarea, select, a,
      [contenteditable], [data-no-drag]'

   ---------------------------------------------------------------------------
   bug ②（工具栏不置顶）用户原文
   ---------------------------------------------------------------------------
     「窗口点击聚焦显示所有窗口，最顶上的工具栏（最小化，最大化，关闭这一行）
       目前没有涵盖在内。需要增加点击这个区域也能前置显示窗口。两种窗口都要修改。」

   根因（同一机制的反面）：置顶只挂在 `el` 的 mousedown 上，而同样是那句
     `preventDefault()`（在 pointerdown 上）把派生的 mousedown 掐掉了
     ⇒ 点工具栏永远不置顶，只有点内容区才置顶。
     `_bindResize` 里的 pointerdown 也一样。

   修法：两处 pointerdown 都在 preventDefault **之前**、按钮豁免**之前**
     调 `focus(state.id)`（三键/业务按钮点下去也要先浮到最上层；
     最大化状态那句 `return` 在更后面，也得先调）。

   ---------------------------------------------------------------------------
   覆盖的不变量
   ---------------------------------------------------------------------------
     0. 抽到的是**当前**产品源码（含放宽后的判据）
     1. 点业务按钮 .tbtn       → 不启动拖动、且不 preventDefault
     2. 点三键 .tb-btn         → 不启动拖动
     3. 点 [role=button]       → 不启动拖动
     4. 点 input               → 不启动拖动、且不 preventDefault
     5. 点 [data-no-drag]      → 不启动拖动
     6. 点工具栏空白           → ★启动拖动★（这是拖动功能本身的回归保护）
     7. 点 a / select / contenteditable → 不启动拖动
     8. 非左键（button=2）     → 不启动拖动
     9. 最大化状态下点空白     → 不启动拖动
    10. 启动拖动时确实调用了 _shieldOn（遮罩随拖动打开）
    11. ★工具栏/热区任意位置按下都要 focus（前置窗口）★
        源码：_bindDrag 与 _bindResize 都含 focus(state.id)，且位置在
              preventDefault 与按钮豁免之前
        行为：空白/业务按钮/三键/input/[data-no-drag] 按下都 focus(id) 且 id 正确；
              最大化时也 focus；右键不 focus；
              「前置」不得弄坏 §1/§6（按钮仍不拖动、空白仍能拖动）
    12. ★R3 工具栏契约（源码形态）★
        业务按钮 = .tbtn + data-a（工厂 Toolbar.btn）
        窗口三键 = .tb-btn + data-act（Toolbar.build 内联，_bindControls 只认这个）
        地址栏导航 = .nav-btn + data-act（合法，不属 .tb-btn）
        预览翻页键 = .tb-btn nav-btn + data-a（class 像三键、属性像业务按钮！）
        explorer 必须复用 WM.Toolbar.build，不许再手写一份
   ============================================================================= */
'use strict';
const fs = require('fs');
const path = require('path');

const SHELL = path.join(__dirname, '..', 'web', 'js', 'shell.js');
const src = fs.readFileSync(SHELL, 'utf8');

/* --------------- 从产品源码原样抽取函数体 --------------- */
function extractFn(name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`未找到 ${name}，shell.js 结构变了？`);
  let i = src.indexOf('{', start), depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(start, j + 1); }
  }
  throw new Error(`${name} 花括号不配平`);
}

const bindDragSrc = extractFn('_bindDrag');
const bindResizeSrc = extractFn('_bindResize');

/* ---------------- ★ 去注释 ★ ----------------
 * 「位置先后」类断言必须在**去注释后**的源码上做：
 *   本项目注释写得非常细，注释里出现 `preventDefault()` / `closest(` 这类
 *   片段是常态；一旦注释里恰好也提到了 `focus(state.id)`，
 *   `indexOf` 就会指向注释，先后比较虽然仍「通过」但已经完全失去意义（假绿）。
 *   负向断言同理 —— 注释里为解释历史常常会写出旧写法。
 */
function stripComments(s) {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, ' ')      // 块注释
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1'); // 行注释（避开 http://）
}
const bareDrag = stripComments(bindDragSrc);
const bareResize = stripComments(bindResizeSrc);

/* -------- §0 源码同步性：判据必须已放宽（否则抽取到的是旧实现） -------- */
{
  let fails = 0;
  const need = [
    ['放宽后的按钮判据（含 button 选择器）', /closest\(\s*'button,/],
    ['保留了输入类控件', /input,\s*textarea,\s*select/],
    ['保留了 data-no-drag 逃生口', /\[data-no-drag\]/],
  ];
  need.forEach(([desc, re]) => {
    if (!re.test(bareDrag)) { console.log(`  ✗ §0 缺少：${desc}`); fails++; }
  });
  // 负向：不应再出现「只判 .tb-btn」这种旧写法（★ 去注释后再判，否则会被
  //   解释历史的那段注释误伤 —— 注释里为了说明来龙去脉必须提到旧写法）
  if (/closest\(\s*'\.tb-btn'\s*\)/.test(bareDrag)) {
    console.log('  ✗ §0 仍存在只判 .tb-btn 的旧写法（业务按钮会失效）');
    fails++;
  }
  console.log(fails === 0
    ? '§0 源码同步性：OK（判据已放宽为 button/[role=button]/input/...）'
    : `§0 源码同步性：FAIL(${fails})`);
  if (fails) process.exitCode = 1;
}

/* ----------------------------- 最小 DOM 桩 ----------------------------- */
function makeEl(tag, cls) {
  const el = {
    tagName: (tag || 'div').toUpperCase(),
    children: [], parent: null, parentNode: null,
    style: {}, dataset: {}, _cls: (cls || ''),
    get className() { return el._cls; },
    set className(v) { el._cls = v || ''; },
    classList: {
      _s: new Set((cls || '').split(/\s+/).filter(Boolean)),
      add(...c) { c.forEach((x) => this._s.add(x)); },
      remove(...c) { c.forEach((x) => this._s.delete(x)); },
      contains(c) { return this._s.has(c); },
    },
    _listeners: {},
    appendChild(c) { c.parent = el; c.parentNode = el; el.children.push(c); return c; },
    addEventListener(k, fn) { (el._listeners[k] ||= []).push(fn); },
    removeEventListener(k, fn) {
      el._listeners[k] = (el._listeners[k] || []).filter((f) => f !== fn);
    },
    /** 按选择器判断本元素（或祖先链）是否匹配 —— 实现产品用到的几种 */
    closest(sel) {
      const parts = String(sel).split(',').map((s) => s.trim()).filter(Boolean);
      let n = el;
      while (n) {
        for (const p of parts) {
          if (matches(n, p)) return n;
        }
        n = n.parentNode;
      }
      return null;
    },
    /** 极简 querySelector：只找 `[data-role="x"]` 与 `[data-drag-handle]` */
    querySelector(sel) {
      const found = [];
      const walk = (n) => {
        for (const c of n.children) {
          if (matches(c, sel)) found.push(c);
          walk(c);
        }
      };
      walk(el);
      return found[0] || null;
    },
    setPointerCapture() {},
    hasPointerCapture() { return false; },
    releasePointerCapture() {},
  };
  return el;
}

/** 极简选择器匹配：只支持产品里出现的这几种 */
function matches(n, sel) {
  if (!n || !n.tagName) return false;
  const tag = n.tagName.toLowerCase();
  const cls = n._cls || '';
  const has = (c) => cls.split(/\s+/).includes(c);
  if (sel === 'button') return tag === 'button';
  if (sel === '[role="button"]') return n.dataset && n.dataset.role === 'button';
  if (sel === 'input') return tag === 'input';
  if (sel === 'textarea') return tag === 'textarea';
  if (sel === 'select') return tag === 'select';
  if (sel === 'a') return tag === 'a';
  if (sel === '[contenteditable]') return n.dataset && n.dataset.contenteditable != null;
  if (sel === '[data-no-drag]') return n.dataset && n.dataset.noDrag != null;
  if (sel === '[data-role="titlebar"]') return n.dataset && n.dataset.role === 'titlebar';
  if (sel === '[data-drag-handle]') return n.dataset && n.dataset.dragHandle != null;
  if (sel.startsWith('.')) return has(sel.slice(1));
  return false;
}

/** 造一个"窗口 + 工具栏"的最小结构 */
function makeWorld(opts = {}) {
  const el = makeEl('div');
  const bar = makeEl('div', 'toolbar win-toolbar');
  bar.dataset = { dragHandle: '' };
  el.appendChild(bar);
  return { el, bar, maximized: !!opts.maximized };
}

/** 在桩里执行产品的 _bindDrag，返回可观测的记录 */
function runBind(state) {
  const log = { shieldOn: 0, shieldOff: 0, focused: [], dragged: false };
  const posOfCalls = [];
  const fn = new Function(
    'state', 'document', 'window', 'getComputedStyle', 'parseFloat',
    'isFinite', 'Number', 'Math', 'console',
    '_posOf', '_shieldOn', '_shieldOff', 'focus',
    // ★ 关键：抽出来的是**函数声明**，必须显式调用它 ★
    //   第一版只把声明放进 new Function 的函数体里，没有调用 ——
    //   于是 _bindDrag 一行都没执行，bar 上永远没有监听，
    //   §6「点空白应启动拖动」假红（而且所有 §1-§5 的"通过"也是假的：
    //   它们断言"不启动拖动"，而实际上根本没执行，空过。）
    bindDragSrc + '\n; _bindDrag(state); return null;'
  );
  let bindErr = null;
  try {
    fn(
      state,
      {
        body: { style: {} },
        documentElement: {},
        querySelector: () => null,
        addEventListener: () => {},
        removeEventListener: () => {},
      },
      { innerWidth: 1264, innerHeight: 625, addEventListener: () => {} },
      () => ({ getPropertyValue: () => '48px' }),
      parseFloat, isFinite, Number, Math, console,
      (s) => { posOfCalls.push(1); return { x: 100, y: 100, w: 900, h: 500 }; },
      () => { log.shieldOn++; },
      () => { log.shieldOff++; },
      // ★ 窗口前置（本文件 §11 起要断言它被调用）★
      (id) => { log.focused.push(id); }
    );
  } catch (e) { bindErr = e; }
  // 触发生成的 pointerdown 监听
  //
  // ★ 坑：监听是挂在 **bar**（工具栏/[data-drag-handle]）上的，不是挂在 el 上。
  //   第一版从 state.el._listeners 取 → 永远空数组 → §6「点空白应启动拖动」
  //   假红。必须先拿到 _bindDrag 自己选中的那个 bar，再读它的监听。
  const bar = state.el.querySelector('[data-role="titlebar"]')
           || state.el.querySelector('[data-drag-handle]');
  const hs = bar ? (bar._listeners.pointerdown || []) : [];
  return { hs, log, posOfCalls, bar, bindErr };
}

/* ------------------------------ 断言工具 ------------------------------ */
let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? '  → ' + detail : ''}`); }
}
function evFor(target, opts = {}) {
  return {
    button: opts.button == null ? 0 : opts.button,
    pointerId: 1, clientX: 0, clientY: 0,
    target,
    cancelable: true,
    _prevented: false,
    preventDefault() { this._prevented = true; },
  };
}
/** 在一个 target 上派发 pointerdown，返回 {dragging, prevented, focused} */
function pressOn(state, target, opts) {
  // ★ state.id 必须存在：产品里 _bindDrag 会调 focus(state.id) ★
  //   这里给个默认值，免得每个调用点都写一遍；§11 会断言值传对了。
  const st = Object.assign({ id: 'win-test' }, state);
  const { hs, log, posOfCalls, bar, bindErr } = runBind(st);
  // 自检：抽出来的函数必须真的执行到并挂上监听，否则本文件所有断言都是空过
  if (bindErr) throw new Error(`_bindDrag 执行抛错：${bindErr.message}`);
  if (!bar || !hs.length) {
    throw new Error('_bindDrag 未在工具栏上挂 pointerdown —— 抽取/调用链有问题，测试结果不可信');
  }
  const ev = evFor(target, opts);
  hs.forEach((h) => h(ev));
  return {
    prevented: ev._prevented,
    shieldOn: log.shieldOn,
    posOfCalls: posOfCalls.length,
    focused: log.focused,
  };
}

// 让 target 挂在工具栏下（模拟真实 DOM 层级）
function attach(bar, node) { bar.appendChild(node); return node; }

console.log('\n════════ _test_drag_buttons ════════\n');

/* --------- §1 业务按钮 .tbtn[data-a]：不得启动拖动，且不得 preventDefault --------- */
{
  const w = makeWorld();
  // ★ 属性形态与产品一致：业务按钮 = class="tbtn" + data-a（WM.Toolbar.btn 产出）
  const btn = attach(w.bar, Object.assign(makeEl('button', 'tbtn'), { dataset: { a: 'new-folder' } }));
  const r = pressOn({ el: w.el }, btn);
  check('§1 点 .tbtn → 不启动拖动（无 _posOf / 无遮罩）',
    r.shieldOn === 0 && r.posOfCalls === 0, JSON.stringify(r));
  // ★ 关键：一旦 preventDefault 被调用，浏览器就不会派生 click → 按钮失效
  check('§1 点 .tbtn → 不调用 preventDefault（否则 click 不会触发）',
    r.prevented === false, `prevented=${r.prevented}`);
}

/* --------- §2 三键 .tb-btn[data-act] --------- */
{
  const w = makeWorld();
  const btn = attach(w.bar, Object.assign(makeEl('button', 'tb-btn'), { dataset: { act: 'max' } }));
  const r = pressOn({ el: w.el }, btn);
  check('§2 点 .tb-btn（三键）→ 不启动拖动且不 preventDefault',
    r.shieldOn === 0 && r.prevented === false, JSON.stringify(r));
}

/* --------- §3 [role=button] --------- */
{
  const w = makeWorld();
  const n = attach(w.bar, makeEl('div'));
  n.dataset = { role: 'button' };
  const r = pressOn({ el: w.el }, n);
  check('§3 点 [role=button] → 不启动拖动',
    r.shieldOn === 0 && r.prevented === false, JSON.stringify(r));
}

/* --------- §4 input（搜索框） --------- */
{
  const w = makeWorld();
  const inp = attach(w.bar, makeEl('input'));
  const r = pressOn({ el: w.el }, inp);
  check('§4 点 input → 不启动拖动且不 preventDefault（否则选不中文字）',
    r.shieldOn === 0 && r.prevented === false, JSON.stringify(r));
}

/* --------- §5 [data-no-drag] --------- */
{
  const w = makeWorld();
  const n = attach(w.bar, makeEl('div', 'something'));
  n.dataset = { noDrag: '' };
  const r = pressOn({ el: w.el }, n);
  check('§5 点 [data-no-drag] → 不启动拖动',
    r.shieldOn === 0 && r.prevented === false, JSON.stringify(r));
}

/* --------- §6 ★ 工具栏空白：必须仍然能拖 ★ --------- */
{
  const w = makeWorld();
  const blank = attach(w.bar, makeEl('span', 'tb-spacer'));
  const r = pressOn({ el: w.el }, blank);
  check('§6 点工具栏空白 → ★启动拖动★（拖动功能不能被修坏）',
    r.shieldOn === 1 && r.prevented === true && r.posOfCalls === 1, JSON.stringify(r));
}

/* --------- §7 a / select / contenteditable --------- */
{
  ['a', 'select'].forEach((t) => {
    const w = makeWorld();
    const n = attach(w.bar, makeEl(t));
    const r = pressOn({ el: w.el }, n);
    check(`§7 点 <${t}> → 不启动拖动`,
      r.shieldOn === 0 && r.prevented === false, JSON.stringify(r));
  });
  const w = makeWorld();
  const ce = attach(w.bar, makeEl('div'));
  ce.dataset = { contenteditable: 'true' };
  const r = pressOn({ el: w.el }, ce);
  check('§7 点 [contenteditable] → 不启动拖动',
    r.shieldOn === 0 && r.prevented === false, JSON.stringify(r));
}

/* --------- §8 非左键 --------- */
{
  const w = makeWorld();
  const blank = attach(w.bar, makeEl('span'));
  const r = pressOn({ el: w.el }, blank, { button: 2 });
  check('§8 右键按下 → 不启动拖动', r.shieldOn === 0, JSON.stringify(r));
}

/* --------- §9 最大化状态 --------- */
{
  const w = makeWorld({ maximized: true });
  const blank = attach(w.bar, makeEl('span'));
  const r = pressOn({ el: w.el, maximized: true }, blank);
  check('§9 最大化状态点空白 → 不启动拖动', r.shieldOn === 0, JSON.stringify(r));
}

/* --------- §10 嵌套：按钮里的 icon（svg）也要能豁免 --------- */
{
  const w = makeWorld();
  const btn = attach(w.bar, makeEl('button', 'tbtn'));
  const svg = btn.appendChild(makeEl('svg'));
  const r = pressOn({ el: w.el }, svg);
  check('§10 点业务按钮内部的 <svg> 图标 → 靠 closest 上溯到 button，仍豁免',
    r.shieldOn === 0 && r.prevented === false, JSON.stringify(r));
}

/* --------- §11 ★ 工具栏/热区任意位置按下都要能前置窗口（本轮新增）★ ---------
 *
 * 需求（原文）：
 *   「窗口点击聚焦显示所有窗口，最顶上的工具栏（最小化，最大化，关闭这一行）
 *     目前没有涵盖在内。需要增加点击这个区域也能前置显示窗口。两种窗口都要修改。」
 *
 * 根因（同一个机制，和上面那个 bug 是反面）：
 *   窗口置顶原本只挂在 `el` 的 **mousedown** 捕获监听上；
 *   而 _bindDrag / _bindResize 都会在 pointerdown 里 `preventDefault()`，
 *   按 Pointer Events 规范这会**抑制浏览器派生的 mousedown**。
 *   ⇒ 点工具栏（和拖边框）时根本没有 mousedown → focus() 不执行 → 不置顶。
 *   ⇒ 只有点窗口内容区（不 preventDefault 的路径）才会置顶。
 *
 * 修法：把 focus(state.id) 提前到这两个 pointerdown 里，且放在
 *   preventDefault 与「按钮豁免」**之前**（三键/业务按钮点下去也要先浮到最上层，
 *   最大化状态下也要能前置 —— 那句 `if (state.maximized) return` 在更后面）。
 *
 * 为什么一处修复覆盖「两种窗口」：
 *   资源管理器窗口（explorer.js 手写工具栏）与预览窗口（WM.Toolbar.build）
 *   用的是**同一个** `.toolbar.win-toolbar[data-drag-handle]`，都走 _bindDrag。
 */
{
  /* --- 11.1 源码形态（在**去注释**的源码上比对位置）--- */
  check('§11 源码：_bindDrag 内含 focus(state.id)',
    /focus\(\s*state\.id\s*\)/.test(bareDrag));
  {
    const iFocus = bareDrag.indexOf('focus(state.id)');
    const iPrev = bareDrag.indexOf('e.cancelable) e.preventDefault()');
    check('§11 源码：_bindDrag 的 focus 在 preventDefault **之前**',
      iFocus >= 0 && iPrev >= 0 && iFocus < iPrev,
      `focus@${iFocus} preventDefault@${iPrev}`);
    const iBtn = bareDrag.indexOf('closest(');
    check('§11 源码：_bindDrag 的 focus 在按钮豁免**之前**（三键也能前置）',
      iFocus >= 0 && iBtn >= 0 && iFocus < iBtn,
      `focus@${iFocus} closest@${iBtn}`);
  }
  {
    const iFocus = bareResize.indexOf('focus(state.id)');
    const iPrev = bareResize.indexOf('e.cancelable) e.preventDefault()');
    check('§11 源码：_bindResize 也调用了 focus(state.id)（热区不在工具栏内，覆盖不到）',
      iFocus >= 0, `iFocus=${iFocus}`);
    check('§11 源码：_bindResize 的 focus 在 preventDefault 之前',
      iFocus >= 0 && iPrev >= 0 && iFocus < iPrev,
      `focus@${iFocus} preventDefault@${iPrev}`);
  }
  // 负向：不能再出现「只在 mousedown 里置顶」这种唯一路径的写法
  //   （attach() 里那条 mousedown 监听要保留 —— 内容区仍靠它；
  //     这里只锁住「pointerdown 路径里也有」这个新增事实）

  /* --- 11.2 行为：不同目标按下都要 focus，且 id 传对 --- */
  const cases = [
    ['工具栏空白（tb-spacer）', () => makeEl('span', 'tb-spacer')],
    ['业务按钮 .tbtn', () => makeEl('button', 'tbtn')],
    ['三键 .tb-btn', () => makeEl('button', 'tb-btn')],
    ['搜索框 input', () => makeEl('input')],
    ['[data-no-drag]', () => { const n = makeEl('div'); n.dataset = { noDrag: '' }; return n; }],
  ];
  cases.forEach(([desc, build]) => {
    const w = makeWorld();
    const target = attach(w.bar, build());
    const r = pressOn({ el: w.el, id: 'explorer:共享' }, target);
    check(`§11 点 ${desc} → 调用了 focus 且 id 正确`,
      r.focused.length === 1 && r.focused[0] === 'explorer:共享',
      JSON.stringify(r.focused));
  });

  /* --- 11.3 最大化状态：不拖动，但仍要前置 --- */
  {
    const w = makeWorld({ maximized: true });
    const blank = attach(w.bar, makeEl('span'));
    const r = pressOn({ el: w.el, maximized: true, id: 'img:照片' }, blank);
    check('§11 最大化窗口点工具栏 → 不拖动但**要**前置',
      r.shieldOn === 0 && r.focused.length === 1 && r.focused[0] === 'img:照片',
      JSON.stringify(r));
  }

  /* --- 11.4 非左键：不该前置（右键菜单不应改变层叠）--- */
  {
    const w = makeWorld();
    const blank = attach(w.bar, makeEl('span'));
    const r = pressOn({ el: w.el }, blank, { button: 2 });
    check('§11 右键按下 → 不前置（button!==0 提前 return）',
      r.focused.length === 0 && r.shieldOn === 0, JSON.stringify(r));
  }

  /* --- 11.5 回归：前置不能把拖动/豁免弄坏 --- */
  {
    const w = makeWorld();
    const blank = attach(w.bar, makeEl('span', 'tb-spacer'));
    const r = pressOn({ el: w.el }, blank);
    check('§11 工具栏空白 → 既前置又仍然能拖',
      r.focused.length === 1 && r.shieldOn === 1 && r.prevented === true && r.posOfCalls === 1,
      JSON.stringify(r));
    const w2 = makeWorld();
    const btn = attach(w2.bar, makeEl('button', 'tbtn'));
    const r2 = pressOn({ el: w2.el }, btn);
    check('§11 业务按钮 → 前置 + 仍不拖动 + 仍不 preventDefault（click 必须能触发）',
      r2.focused.length === 1 && r2.shieldOn === 0 && r2.prevented === false,
      JSON.stringify(r2));
  }
}

/* =============================================================================
   §12 ★ R3 契约：工具栏只有一份真相（源码形态断言）★

   用户需求原文：「部署文件改为可以build方式。并重构」

   重构前：explorer.js 手写了一大段工具栏 HTML（`<button class="tbtn" data-act="…">`），
           viewer.js 走 `WM.Toolbar.build`（产出 `data-a`）——
           **两种窗口各写一份工具栏**，属性还不同名 → 双份真相、必然漂移。

   重构后只有一套契约（写在 shell.js 的 Toolbar 注释里）：
     · 业务按钮（工厂 `Toolbar.btn` 产出）：`class="tbtn"` + **`data-a`**
     · 窗口控制键（`Toolbar.build` 内联）：`class="tb-btn"` + **`data-act`**
     · 地址栏导航键（explorer 自带）：`class="nav-btn"` + `data-act`（**不是** .tb-btn）
     · 预览翻页键（viewer 自带）：`class="tb-btn nav-btn"` + **`data-a`**
       ← 这条最容易写错：它 class 像三键、属性像业务按钮。
         正是「点『下一个文件』没反应」的根源（被 `.tb-btn` 宽选择器吞掉 click）。

   本节只做**源码形态**断言（不依赖 DOM 桩），防止有人再手写一份工具栏 /
   再把属性名写回去。行为断言在 §1/§2/§11 与本文件之外的 _test_controls.js。
   ============================================================================= */
{
  const fs12 = require('fs');
  const p12 = require('path');
  const W = p12.join(__dirname, '..', 'web', 'js');
  const rd = (f) => fs12.readFileSync(p12.join(W, f), 'utf8');
  /* ★ 还要剥掉 HTML 注释 ★
     本项目习惯在 innerHTML 模板里写大段 `<!-- ... -->` 作为**文档性注释**
     （explorer.js 的工具栏说明就在里面，正文里明写了 `class="tbtn" + data-a`）。
     只剥 JS 注释会让下面那条负向断言命中这段文档 → 假红。 */
  const noHtmlComment = (s) => s.replace(/<!--[\s\S]*?-->/g, ' ');
  const exSrc = noHtmlComment(stripComments(rd('explorer.js')));
  const vwSrc = noHtmlComment(stripComments(rd('viewer.js')));
  const shSrc = noHtmlComment(stripComments(rd('shell.js')));

  console.log('\n§12 R3 工具栏契约（源码形态）');

  /* --- 12.1 explorer 必须复用工厂，不再手写业务按钮 --- */
  check('§12 explorer 工具栏由 WM.Toolbar.build 产出',
    /WM\.Toolbar\.build\(\s*\{/.test(exSrc));
  check('§12 explorer 不再手写 class="tbtn"（旧的双份真相）',
    !/class="tbtn/.test(exSrc),
    '手写业务按钮会与 WM.Toolbar.btn 的模板漂移');
  // 负向：业务动作不允许再挂在 data-act 上（枚举式，避免误伤地址栏 nav-btn）
  const bizActs = ['new-folder', 'upload', 'rename', 'download', 'delete',
    'view-grid', 'view-list', 'sort', 'info'];
  const stale = bizActs.filter((a) => new RegExp(`data-act="${a}"`).test(exSrc));
  check('§12 explorer 业务按钮不再是 data-act（应为 data-a）',
    stale.length === 0, `仍是 data-act 的：${stale.join(', ') || '无'}`);

  // 地址栏 nav-btn 保留 data-act —— 它不属 .tb-btn，不能被误改
  const navActs = ['back', 'forward', 'up', 'refresh'];
  check('§12 explorer 地址栏 nav-btn 保留 data-act（合法，不属 .tb-btn）',
    navActs.every((a) => new RegExp(`data-act="${a}"`).test(exSrc)));

  /* --- 12.2 explorer 的点击处理必须紧跟新属性 --- */
  check('§12 explorer 用 closest(\'[data-a]\') 认业务按钮',
    /closest\(\s*'\[data-a\]'\s*\)/.test(exSrc));
  check('§12 explorer 业务按钮处理器紧随 [data-a] 读 dataset.a',
    /closest\(\s*'\[data-a\]'\s*\)[\s\S]{0,240}?dataset\.a\b/.test(exSrc),
    'dataset.act 是地址栏 .nav-btn[data-act] 与对话框按钮的合法读法，不能一刀切禁掉');
  check('§12 explorer 视图/禁用态查询用 [data-a="…"]',
    /\[data-a="\$\{/.test(exSrc) || /\[data-a="/.test(exSrc));

  /* --- 12.3 工厂模板：业务 data-a、三键 data-act --- */
  check('§12 Toolbar.btn 模板产出 data-a',
    /class="tbtn \$\{extra\}"\s+data-a=/.test(shSrc) || /data-a="\$\{act\}"/.test(shSrc));
  check('§12 Toolbar.build 的三键产出 data-act',
    ['min', 'max', 'close'].every((k) => new RegExp(`data-act="${k}"`).test(shSrc)));

  /* --- 12.4 三键选择器必须带 [data-act]，且不许裸 .tb-btn --- */
  check('§12 _bindControls 选择器为 .tb-btn[data-act]',
    /querySelectorAll\(\s*['"]\.tb-btn\[data-act\]['"]\s*\)/.test(shSrc));
  check('§12 _bindControls 不再有裸的 querySelectorAll(\'.tb-btn\')',
    !/querySelectorAll\(\s*['"]\.tb-btn['"]\s*\)/.test(shSrc));

  /* --- 12.5 预览翻页键：class 像三键、属性像业务按钮，必须 data-a --- */
  check('§12 viewer 翻页键带 data-a（prev/next）',
    /nav-btn"\s+data-a="prev"/.test(vwSrc) && /nav-btn"\s+data-a="next"/.test(vwSrc));
  check('§12 viewer 翻页键不带 data-act（否则被 _bindControls 吞掉 click）',
    !/nav-btn"?\s+data-act=/.test(vwSrc));
  check('§12 viewer 点击处理用 closest(\'[data-a]\')',
    /closest\(\s*'\[data-a\]'\s*\)/.test(vwSrc));
}

console.log(`\n──────── 结果：${pass} 通过 / ${fail} 失败 ────────\n`);
if (fail) process.exitCode = 1;
