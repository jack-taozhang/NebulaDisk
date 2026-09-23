/* =============================================================================
   _test_resize_hit.js —— 窗口缩放 / 置顶 / 冲突 的纯逻辑仿真

   ★ 本文件的第一原则：**直接从 js/shell.js 抽取真实源码**，
     绝不复制一份逻辑进来。★
     （见下方「为什么不能抄」）

   ---------------------------------------------------------------------------
   为什么不能抄（血泪教训，别再犯）
   ---------------------------------------------------------------------------
   本文件旧版把 _bindResize 的实现**抄**了一份到测试里，且抄的是过时参数
   （EDGE=10 / CORNER=16，而产品早已是 14 / 20，也没包含后来加的
   「右上角让位三键」逻辑）。于是产品真有 bug 时测试仍然 12/12 全绿 ——
   这就是「假绿」：比没有测试更危险，因为它会让人相信已经修好了。

   现在改为：读 shell.js 源码 → 花括号配平抽取函数体 → 在 DOM 桩里
   `new Function(...)` 执行。产品改一行，测试立刻跟着变，漂移不可能再发生。
   §0 还额外做了「源码同步性」断言，一旦抽取失败或抽到旧实现就立刻报红。

   ---------------------------------------------------------------------------
   怎么观测几何变化（旧版第二个错误）
   ---------------------------------------------------------------------------
   真实的 _bindResize **不会**写 `state._lastGeom`（那是旧测试自己造的字段）。
   它只做一件事：
       Object.assign(state.el.style, { left, top, width, height });
   所以正确的观测点是**桩元素的 style 对象**，不是虚构的 state 字段。
   本文件用 `geomOf(state)` 从 `state.el.style.width/height/left/top`
   解析出数字来断言 —— 与产品真实写入路径完全一致。

   ---------------------------------------------------------------------------
   覆盖的不变量
   ---------------------------------------------------------------------------
     0. 抽取到的确实是**当前**产品源码（防假绿的总开关）
     1. 八个方向手柄都建了，每个都挂了 mousedown
     2. 手柄 z-index 高于窗口内容（不被预览 iframe 盖住）
     3. 一次 mousedown 即进入拖动态（无需「长按」）
     4. 拖动中 mousemove 真的改尺寸；mouseup 后停止跟手
     5. 最大化 / 非左键 拒绝缩放
     6. 最小尺寸约束生效（宽 460 / 高 320）
     7. 拖动期间禁止选中文本，松手恢复
     8. ★ 右上角 ne 热区**不覆盖**窗口三键（关闭键冲突的守卫）★
     9. ★ 三键 z-index 高于 resize 热区（双保险）★
    10. 文件夹窗口：双击文件夹在**当前窗口**内进入，不另开窗口
    11. 开始菜单：不再有「用户管理」磁贴（data-app="admin"）
    12. iframe 置顶：每次 load 后重绑；几何兜底不被 iframe 提前 return 掉
   ============================================================================= */
'use strict';
const fs = require('fs');
const path = require('path');

const WEB = path.join(__dirname, '..', 'web');
const SHELL = path.join(WEB, 'js', 'shell.js');
const EXPLORER = path.join(WEB, 'js', 'explorer.js');
const APP = path.join(WEB, 'js', 'app.js');
const CSS = path.join(WEB, 'css', 'app.css');

const src = fs.readFileSync(SHELL, 'utf8');
const explorerSrc = fs.readFileSync(EXPLORER, 'utf8');
const appSrc = fs.readFileSync(APP, 'utf8');
const css = fs.readFileSync(CSS, 'utf8');

/* ----------------------------- 最小 DOM 桩 ----------------------------- */
function makeEl(tag) {
  const el = {
    tagName: (tag || 'div').toUpperCase(),
    children: [], parent: null,
    style: {}, dataset: {}, classList: {
      _s: new Set(),
      add(...c) { c.forEach((x) => this._s.add(x)); },
      remove(...c) { c.forEach((x) => this._s.delete(x)); },
      contains(c) { return this._s.has(c); },
    },
    // ★ className 必须与 classList 同步 ★
    //   真实 DOM 里 `el.className = 'a b'` 会让 classList 立刻包含 a、b。
    //   产品代码里 _shieldOn 用 `className = 'wm-drag-shield'` 建元素、
    //   随后用 classList 操作 —— 桩里若不同步，测试就会假红。
    get className() { return [...el.classList._s].join(' '); },
    set className(v) {
      el.classList._s = new Set(String(v).split(/\s+/).filter(Boolean));
    },
    _listeners: {},
    offsetLeft: 100, offsetTop: 80, offsetWidth: 800, offsetHeight: 600,
    innerHTML: '',
    appendChild(c) { c.parent = el; el.children.push(c); return c; },
    removeChild(c) {
      const i = el.children.indexOf(c);
      if (i >= 0) el.children.splice(i, 1);
      return c;
    },
    remove() { if (el.parent) el.parent.removeChild(el); },
    querySelector(sel) { return find(el, sel); },
    querySelectorAll(sel) { return findAll(el, sel); },
    contains(n) {
      if (!n) return false;
      if (n === el) return true;
      return el.children.some((c) => c.contains && c.contains(n));
    },
    addEventListener(t, fn) {
      (el._listeners[t] = el._listeners[t] || []).push(fn);
    },
    removeEventListener(t, fn) {
      const a = el._listeners[t] || [];
      const i = a.indexOf(fn);
      if (i >= 0) a.splice(i, 1);
    },
    dispatch(t, ev) {
      // 真实 DOM 事件一定带 target（= 派发到的那个元素）。桩里补上，
      // 否则产品代码里的 `e.target.closest(...)` 会抛 undefined。
      const e2 = Object.assign({ target: el, currentTarget: el }, ev);
      (el._listeners[t] || []).slice().forEach((f) => f(e2));
    },
    /** 指针捕获桩：真实浏览器里 setPointerCapture 保证「之后所有指针事件
     *  都派发给本元素，与指针位置无关」。测试里只需保证三个方法存在、
     *  且语义自洽（set 之后 has 为 true，release 之后为 false）。 */
    _captured: null,
    setPointerCapture(id) { el._captured = id; },
    hasPointerCapture(id) { return el._captured === id; },
    releasePointerCapture() { el._captured = null; },
    getBoundingClientRect() {
      return { left: el.offsetLeft, top: el.offsetTop,
               width: el.offsetWidth, height: el.offsetHeight,
               right: el.offsetLeft + el.offsetWidth,
               bottom: el.offsetTop + el.offsetHeight };
    },
    closest() { return null; },
    setAttribute() {}, removeAttribute() {},
    get firstChild() { return el.children[0] || null; },
  };
  return el;
}

function matchSel(el, sel) {
  if (!el || !sel) return false;
  return sel.split(',').some((raw) => {
    const s = raw.trim();
    if (s.startsWith('.')) return el.classList.contains(s.slice(1));
    if (s.startsWith('[')) {
      const m = s.match(/^\[([\w-]+)(?:="([^"]*)")?\]$/);
      if (!m) return false;
      const key = m[1] === 'data-role' ? 'role'
                : m[1] === 'data-resize' ? 'resize' : m[1];
      if (m[2] === undefined) return el.dataset[key] !== undefined;
      return el.dataset[key] === m[2];
    }
    return el.tagName === s.toUpperCase();
  });
}
function findAll(root, sel, out = []) {
  for (const c of root.children) {
    if (matchSel(c, sel)) out.push(c);
    findAll(c, sel, out);
  }
  return out;
}
function find(root, sel) { return findAll(root, sel)[0] || null; }

/* --------------------------- 全局环境桩 --------------------------- */
const docEl = makeEl('html');
// #window-layer 在真实页面里是 position:absolute;inset:0 于 #desktop(fixed)，
// 所以它的 rect 原点是 (0,0)。_posOf 会减去 layer 的 rect，这里必须归零，
// 否则桩里所有坐标会被凭空平移 (offsetLeft,offsetTop)。
docEl.offsetLeft = 0; docEl.offsetTop = 0;
docEl.offsetWidth = 1440; docEl.offsetHeight = 900;
docEl.scrollLeft = 0; docEl.scrollTop = 0;
global.document = {
  body: makeEl('body'),
  documentElement: docEl,
  _listeners: {},
  createElement: makeEl,
  getElementById: () => null,
  querySelector: (s) => find(docEl, s),
  addEventListener(t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); },
  removeEventListener(t, fn) {
    const a = this._listeners[t] || [];
    const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1);
  },
  dispatch(t, ev) { (this._listeners[t] || []).slice().forEach((f) => f(ev)); },
};
global.window = { innerWidth: 1440, innerHeight: 900, addEventListener() {} };
// getComputedStyle 桩：产品代码用它读 `--taskbar-h` 与 `--toolbar-h`。
// 返回 CSS 变量表；读不到的名字给空串（产品里有兜底默认值）。
global.getComputedStyle = () => ({
  getPropertyValue(name) {
    const vars = { '--taskbar-h': '48px', '--toolbar-h': '29px' };
    return vars[name] || '';
  },
});

/* --------------- 从产品源码**原样**抽取函数体 --------------- */

/** 去掉 // 行注释 与 /* … *​/ 块注释，只留可执行代码。
 *
 *  ★ 为什么断言必须先用它 ★
 *    本次修的三个行为，注释里**都写了**「旧实现是错的」的说明文字
 *    （例如「曾一度改成 newWindow:true」「原先这里还会 push app:'admin'」
 *    「旧的 __nebulaFocusBound 一次性标志」）。若直接对全文做
 *    `!/newWindow:/` 这类负向断言，匹配到的是**注释**而不是代码，
 *    结果永远报红 —— 这是「假红」，和假绿一样浪费时间。
 *    所以：负向断言一律在 stripComments 之后做。
 *    （正向断言不受影响，因为注释不会凭空造出函数调用。） */
function stripComments(s) {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:\\])\/\/[^\n]*/g, '$1 ');
}
const srcCode = stripComments(src);
const explorerCode = stripComments(explorerSrc);
const appCode = stripComments(appSrc);

/** 从 `function <name>(state) {` 起，按花括号配平切出完整函数定义 */
function extractFn(name) {
  const start = src.indexOf(`function ${name}(state)`);
  if (start < 0) throw new Error(`未找到 ${name}，shell.js 结构变了？`);
  let i = src.indexOf('{', start), depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(start, j + 1); }
  }
  throw new Error(`${name} 花括号不配平`);
}

/** 同上，但函数签名不是 `(state)`（例如 _shieldOn(cursor)） */
function extractFn2(name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`未找到 ${name}，shell.js 结构变了？`);
  let i = src.indexOf('{', start), depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(start, j + 1); }
  }
  throw new Error(`${name} 花括号不配平`);
}

const resizeSrc = extractFn('_bindResize');
// _bindResize 的依赖：_posOf（真实小数几何）、_shieldOn/_shieldOff（整屏遮罩）
const posOfSrc = extractFn('_posOf');
const shieldOnSrc = extractFn2('_shieldOn');
const shieldOffSrc = extractFn2('_shieldOff');
// _bindDrag 的依赖同上
const dragSrc = extractFn('_bindDrag');

/* ★ 两处 pointerdown 都会调 focus(state.id) 把窗口前置 ★
 *   沙箱必须注入它，否则 ReferenceError 直接崩掉整个套件
 *   （本文件就是因为这个从「141 通过」变成「0 通过 / exit=1」）。
 *   下面顺带把它记下来，用于断言「拖边框也会前置」。 */
const focusCalls = [];
const focusStub = (id) => { focusCalls.push(id); };

// eslint-disable-next-line no-new-func
const bindResize = new Function('document', 'window', 'layer', 'focus', `
  let _shield = null, _shieldCount = 0;
  ${posOfSrc}
  ${shieldOnSrc}
  ${shieldOffSrc}
  ${resizeSrc}
  return _bindResize;
`)(global.document, global.window, () => docEl, focusStub);

// eslint-disable-next-line no-new-func
const bindDrag = new Function('document', 'window', 'layer', 'focus', `
  let _shield = null, _shieldCount = 0;
  ${posOfSrc}
  ${shieldOnSrc}
  ${shieldOffSrc}
  ${dragSrc}
  return _bindDrag;
`)(global.document, global.window, () => docEl, focusStub);

/* ------------------------------ 断言 ------------------------------ */
let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${extra ? '  → ' + extra : ''}`); }
}

let mkSeq = 0;
function mkWin(over = {}) {
  const el = makeEl('div');
  el.classList.add('window');
  const body = makeEl('div');
  body.dataset.role = 'body';
  el.appendChild(body);
  // ★ id 现在是必需字段：_bindDrag/_bindResize 都会调 focus(state.id) 前置窗口 ★
  return { id: 'win-' + (++mkSeq), el, bodyEl: body, opts: {}, minimized: false, maximized: false, ...over };
}

function md(x, y, button = 0) {
  return { clientX: x, clientY: y, button, preventDefault() {}, stopPropagation() {} };
}

/** 指针事件桩。pointerId 恒为 1 —— 测试里同时只会有一个手势。 */
function pd(x, y, button = 0) {
  return {
    clientX: x, clientY: y, button, pointerId: 1,
    cancelable: true,
    preventDefault() {}, stopPropagation() {},
  };
}

/** ★ 唯一正确的观测点：产品写进 style 的四个值 ★
 *  真实 _bindResize 只做 Object.assign(state.el.style, {left,top,width,height})，
 *  不写任何 state._lastGeom（那是旧测试的虚构字段）。
 *  取不到时返回 null，用来表达「根本没进入拖动态」。 */
function geomOf(state) {
  const s = state.el.style;
  const num = (v) => {
    const m = String(v == null ? '' : v).match(/^(-?\d+(?:\.\d+)?)px$/);
    return m ? Number(m[1]) : null;
  };
  const w = num(s.width), h = num(s.height);
  if (w === null && h === null) return null;
  return { w, h, x: num(s.left), y: num(s.top) };
}

/** ★ 拖动的观测点：拖动**只写 left/top**，从不写 width/height ★
 *  所以不能复用 geomOf（它看到 width/height 都是 null 就返回 null，
 *  会误判成「没进入拖动态」）。这个函数只看 left/top。 */
function posOf(state) {
  const s = state.el.style;
  const num = (v) => {
    const m = String(v == null ? '' : v).match(/^(-?\d+(?:\.\d+)?)px$/);
    return m ? Number(m[1]) : null;
  };
  const x = num(s.left), y = num(s.top);
  if (x === null && y === null) return null;
  return { x, y };
}

console.log('\n=== 窗口缩放热区仿真（读产品源码） ===\n');

/* 0. 确认抽取到的是**当前**产品逻辑，而不是过时的副本 */
console.log('[0] 源码同步性');
ok(/const EDGE\s*=\s*(\d+)/.test(resizeSrc), '抽到的是当前实现（含 EDGE 常量）');
const edgeVal = Number((resizeSrc.match(/const EDGE\s*=\s*(\d+)/) || [])[1]);
const cornerVal = Number((resizeSrc.match(/const CORNER\s*=\s*(\d+)/) || [])[1]);
// ★ 本轮：用户反馈「感应范围太宽也太快」→ 热区必须**收窄** ★
//   同时保留"别太薄"的下限（历史上 5px 太薄，用户按不准）。
//   区间断言而非等值断言：将来微调不误报，但跨出区间立刻报红。
ok(edgeVal >= 6 && edgeVal <= 10,
   `EDGE 收窄到合理区间 6~10px（用户报"太宽"，实测 ${edgeVal}px）`, `实际 ${edgeVal}`);
ok(cornerVal >= 10 && cornerVal <= 14,
   `CORNER 收窄到合理区间 10~14px（实测 ${cornerVal}px）`, `实际 ${cornerVal}`);
ok(cornerVal > edgeVal,
   `CORNER(${cornerVal}) 必须大于 EDGE(${edgeVal})（角部覆盖斜向，需更大）`);
// ★ 本轮（Request D）：抽 OUT —— 热区向窗口**外侧**延伸的像素数 ★
//   用户原文：「以边框外边缘 向左和向右，向上向下偏移一定范围内都可激活。
//              目前都是在窗口里面，这个要调整一下。」
//   注意 OUT 现在可能还不存在（若源码被回退）→ 抽不到就取 0，让后续断言报红。
const outMatch = resizeSrc.match(/const OUT\s*=\s*(\d+)/);
const outVal = outMatch ? Number(outMatch[1]) : 0;
ok(outMatch !== null,
   '[跨边框] 源码含 const OUT 常量（热区向外延伸量）',
   outMatch ? '' : '未找到 const OUT —— 跨边框实现可能被回退');
ok(outVal >= 2 && outVal <= 8,
   `[跨边框] OUT 在合理区间 2~8px（实测 ${outVal}px）`, `实际 ${outVal}`);
ok(new RegExp(`const CORNER\\s*=\\s*${cornerVal}`).test(resizeSrc),
   '抽到的是当前 CORNER 的实现');
ok(/Object\.assign\(state\.el\.style/.test(resizeSrc),
   '确认几何写的是 el.style（测试观测点正确）');
// ★ 本轮新增：手势必须走 pointer + 遮罩 + 真实几何起点 ★
ok(/addEventListener\('pointerdown'/.test(resizeSrc),
   '[缩放] 用 pointerdown 而非 mousedown（配合指针捕获）');
ok(/_shieldOn\(/.test(resizeSrc) && /_shieldOff\(/.test(resizeSrc),
   '[缩放] 拖动期间启用/撤除整屏遮罩（防指针落到 iframe 丢事件）');
ok(/_posOf\(state\)/.test(resizeSrc),
   '[缩放] 起点用 _posOf（真实小数几何），不再用取整的 offsetLeft');
ok(!/state\.el\.offsetLeft/.test(resizeSrc),
   '[缩放] 源码里已无 offsetLeft 起点（旧写法已彻底移除）');

ok(/addEventListener\('pointerdown'/.test(dragSrc),
   '[拖动] 用 pointerdown 而非 mousedown');
ok(/setPointerCapture/.test(dragSrc),
   '[拖动] 调用了 setPointerCapture（规范级的事件保证）');
ok(/_shieldOn\(/.test(dragSrc) && /_shieldOff\(/.test(dragSrc),
   '[拖动] 启用/撤除整屏遮罩');
ok(/_posOf\(state\)/.test(dragSrc) && !/state\.el\.offsetLeft/.test(dragSrc),
   '[拖动] 起点改用 _posOf，offsetLeft 已移除');
ok(!/document\.addEventListener\('mousemove'/.test(dragSrc),
   '[拖动] 不再在 document 上挂 mousemove（那正是丢事件的旧实现）');

/* 1. 八向手柄齐全 */
const st = mkWin();
bindResize(st);
const handles = st.el.children.filter((c) => c.dataset.resize);
ok(handles.length === 8, '八个方向的手柄都创建了', `实际 ${handles.length}`);
ok(['n','s','e','w','ne','nw','se','sw'].every((d) => handles.some((h) => h.dataset.resize === d)),
   '方向集合完整');

/* 2. 每个手柄都挂了 pointerdown */
ok(handles.every((h) => (h._listeners.pointerdown || []).length === 1),
   '每个手柄都绑定了 pointerdown');

/* 3. 手柄在最上层（z-index 高于内容），确保不被 iframe 盖住 */
ok(handles.every((h) => h.style.zIndex === 900),
   '手柄 z-index 高于窗口内容（不被预览 iframe 覆盖）');

/* 4. 关键：**一次 pointerdown 即进入拖动态**，无需「按住」 */
const east = handles.find((h) => h.dataset.resize === 'e');
document.body.style.userSelect = '';
// ★ 本测试把 _bindResize 与 _bindDrag 分别放进独立的 new Function 作用域
//   （各自有一份模块级 _shield），而真实页面只有**一个** WM 模块、**一个**
//   _shield。所以这里要取「当前正显示的那一个」，不能盲取第一个 ——
//   否则会拿到另一个作用域里处于隐藏态的遮罩，造成假红。
const SHIELD = () =>
  document.body.children.filter((c) => c.classList.contains('wm-drag-shield'))
    .find((c) => c.classList.contains('on')) || null;
focusCalls.length = 0;   // 只统计这一次按下
east.dispatch('pointerdown', pd(900, 400));
ok(document.body.style.userSelect === 'none',
   '一次 pointerdown 即进入拖动态（无需长按）');
ok(!!SHIELD(), '进入拖动态时整屏遮罩已启用（指针不会落到 iframe 上）');
ok(east.hasPointerCapture(1),
   '手柄已捕获指针（规范级保证事件不丢）');

/* 4.b ★ 拖边框也要把窗口前置（本轮新增）★
 *   _bindResize 在 pointerdown 里会 preventDefault + stopPropagation，
 *   浏览器因此不再派生 mousedown，而「置顶」原本只挂在 mousedown 上
 *   ⇒ 拖后台窗口的边框不会把它提上来。修法是在这里直接 focus(state.id)。
 *   热区是 .window 的直接子元素、不在工具栏里，所以工具栏那处修复覆盖不到。 */
ok(focusCalls.length === 1 && focusCalls[0] === st.id,
   '拖边框的 pointerdown 调用了 focus(窗口id) → 窗口被前置',
   JSON.stringify(focusCalls));

/* 5. 拖动中真的改变尺寸 —— 观测 el.style（产品真实写入点） */
east.dispatch('pointermove', { clientX: 1000, clientY: 400 });
let g = geomOf(st);
ok(g && g.w === 900,
   'pointermove 拖动后宽度变大（800 → 900）', JSON.stringify(g));

/* 6. pointerup 结束拖动，后续 pointermove 不再改尺寸 */
east.dispatch('pointerup', {});
const frozen = JSON.stringify(geomOf(st));
east.dispatch('pointermove', { clientX: 1300, clientY: 400 });
ok(JSON.stringify(geomOf(st)) === frozen, 'pointerup 后停止缩放（不再跟手）');
ok(document.body.style.userSelect === '', '松手后 userSelect 已恢复');
ok(!SHIELD(), '松手后整屏遮罩已撤除');
ok(!east.hasPointerCapture(1), '松手后指针捕获已释放');

/* 7. 最大化时拒绝缩放 */
const stMax = mkWin({ maximized: true });
bindResize(stMax);
document.body.style.userSelect = '';
stMax.el.children.find((c) => c.dataset.resize === 'se').dispatch('pointerdown', pd(900, 400));
stMax.el.children.find((c) => c.dataset.resize === 'se').dispatch('pointermove', { clientX: 1000, clientY: 500 });
ok(geomOf(stMax) === null, '最大化状态下拒绝缩放');
ok(document.body.style.userSelect === '', '最大化时也不留下 userSelect 残留');
stMax.el.children.find((c) => c.dataset.resize === 'se').dispatch('pointerup', {});

/* 8. 非左键拒绝缩放 */
const stR = mkWin();
bindResize(stR);
const nwH = stR.el.children.find((c) => c.dataset.resize === 'nw');
nwH.dispatch('pointerdown', pd(200, 200, 2));
nwH.dispatch('pointermove', { clientX: 100, clientY: 100 });
ok(geomOf(stR) === null, '右键按下不触发缩放');
nwH.dispatch('pointerup', {});

/* 9. 最小尺寸约束生效 */
const stMin = mkWin();
bindResize(stMin);
const eM = stMin.el.children.find((c) => c.dataset.resize === 'e');
eM.dispatch('pointerdown', pd(900, 400));
eM.dispatch('pointermove', { clientX: -5000, clientY: 400 });
const gm = geomOf(stMin);
ok(gm && gm.w === 460, '宽度被最小宽度 460 约束住', `实际 ${gm && gm.w}`);
eM.dispatch('pointerup', {});

/* 9b. 最小高度约束 */
const stMinH = mkWin();
bindResize(stMinH);
const sH = stMinH.el.children.find((c) => c.dataset.resize === 's');
sH.dispatch('pointerdown', pd(500, 700));
sH.dispatch('pointermove', { clientX: 500, clientY: -5000 });
const gh = geomOf(stMinH);
ok(gh && gh.h === 320, '高度被最小高度 320 约束住', `实际 ${gh && gh.h}`);
sH.dispatch('pointerup', {});

/* 10. ★ 关闭键 vs 缩放热区 的冲突守卫 + 热区铺满周长（无死区）★ */
console.log('\n[10] 右上角「关闭」与「缩放」冲突 / 热区周长铺满');
const stC = mkWin();
bindResize(stC);
const hOf = (d) => stC.el.children.find((c) => c.dataset.resize === d);
const ne = hOf('ne'), eH = hOf('e'), nH = hOf('n');

// ne 角热区必须从工具栏下沿开始（top = --toolbar-h），不能贴 top:0
ok(String(ne.style.top).includes('--toolbar-h'),
   'ne 角热区下移到工具栏下沿（不再覆盖右上角三键）', `top=${ne.style.top}`);

// e 边热区也必须从 ne 角下方接着开始
ok(/--toolbar-h/.test(String(eH.style.top)),
   'e 边热区同步下移到 ne 角下方', `top=${eH.style.top}`);

// ★ 本轮核心改动：n 边右端**紧贴 ne 角**（right = CORNER），不再为三键挖空 ★
//   挖空会在顶边制造一条抓不到的死区（用户报的「调整大小有 BUG」）
//   注意：CORNER 现在是变量，断言用抽出来的 cornerVal，不写死数字 —— 否则
//   热区尺寸一调（如本次 20→12）测试就会假红。
const CPX = cornerVal + 'px';
// ★ 跨边框后的尺寸：角宽 = CORNER + OUT（外 OUT 那截在窗口外）★
const CSPX = (cornerVal + outVal) + 'px';
// ★ 2026-09-21 更新（Request D：跨边框）★
//   n 边右端从"紧贴 ne 角(CLEAR)"进一步改为"直达窗口右沿外(OUT_N)"。
//   理由：ne 角纵向被下移到 toolbar-h，与 n 条**纵向不重叠**，n 伸过去
//   不会压住 ne 角；代价只是盖住三键顶部 9px，而三键 z-index:950 仍赢。
//   收益：顶边右上角那 12px 宽的抓不到区被消除。
ok(String(nH.style.right) === (-outVal + 'px'),
   `n 边右端直达窗口右沿外（right=-OUT），顶边右上角不再留抓不到区`,
   `right=${nH.style.right}`);
ok(!/calc\(.*三键|113px/.test(String(nH.style.right)),
   'n 边不再为三键挖空（死区根因已移除）', `right=${nH.style.right}`);
// 但左端仍须给 nw 角让位（nw 从 top:0 起，与 n 条纵向**会**重叠）
ok(String(nH.style.left) === CPX,
   `n 边左端仍让出 CORNER(${CPX})，不抢 nw 角的斜向缩放`, `left=${nH.style.left}`);

// ★ 铺满周长：边让位用 CORNER，角一律 span(CORNER)（跨边框：外 OUT + 内 CORNER）★
//   2026-09-21 更新：热区改为**跨边框**后，角尺寸从 CORNER 变成 CORNER + OUT，
//   但"让位量"仍是 CORNER（角向内只占 CORNER，OUT 那截在窗口外）。
//   所以这里的断言分两个变量：CPX 用于让位，CSPX 用于尺寸。
ok(String(hOf('n').style.left) === CPX && String(hOf('s').style.right) === CPX,
   `n/s 边左右两端均让出 CORNER(${CPX})（让位量不含 OUT）`, `n.left=${hOf('n').style.left}`);
ok(String(hOf('w').style.top) === CPX && String(hOf('w').style.bottom) === CPX,
   `w 边上下两端均让出 CORNER(${CPX})`);
ok(String(hOf('e').style.bottom) === CPX,
   `e 边下端与 se 角相接（bottom=${CPX}）`);
// e 边上端从 ne 角下沿接起，公式里嵌的是 CLEAR(=CORNER)，不是 CORNER+OUT
ok(String(hOf('e').style.top).includes(CPX) && !String(hOf('e').style.top).includes(cornerVal + outVal + 'px'),
   `e 边上端让位用 CORNER(${CPX})，未误加 OUT（否则留 ${outVal}px 缝）`,
   `top=${hOf('e').style.top}`);
['nw', 'ne', 'sw', 'se'].forEach((d) => {
  const h = hOf(d);
  ok(String(h.style.width) === CSPX && String(h.style.height) === CSPX,
     `${d} 角热区为 span(CORNER)=CORNER+OUT(${CSPX})（外 OUT 内 CORNER）`,
     `w=${h.style.width} h=${h.style.height}`);
});

// CSS 里三键层级必须高于热区 900
const ctrlZ = (css.match(/\.win-controls[^{]*\{[^}]*z-index:\s*(\d+)/s) || [])[1];
ok(ctrlZ !== undefined && Number(ctrlZ) > 900,
   'CSS 中 .win-controls 的 z-index 高于热区 900', `z-index=${ctrlZ}`);

const tbCtrlZ = (css.match(/\.tb-controls[^{]*\{[^}]*z-index:\s*(\d+)/s) || [])[1];
ok(tbCtrlZ !== undefined && Number(tbCtrlZ) > 900,
   'CSS 中 .tb-controls 也抬高了层级（普通标题栏窗口同样受保护）', `z-index=${tbCtrlZ}`);

/* 10b. ★ 整屏遮罩的 CSS 必须真的存在且能收到事件 ★ */
console.log('\n[10b] 拖动/缩放整屏遮罩');
ok(/\.wm-drag-shield\s*\{[^}]*position:\s*fixed/s.test(css),
   'CSS 定义了 .wm-drag-shield 且 position:fixed（铺满视口）');
ok(/\.wm-drag-shield\s*\{[^}]*inset:\s*0/s.test(css),
   '遮罩 inset:0（覆盖整屏，含所有 iframe）');
const shieldZ = (css.match(/\.wm-drag-shield\s*\{[^}]*z-index:\s*(\d+)/s) || [])[1];
ok(shieldZ !== undefined && Number(shieldZ) > 900,
   '遮罩 z-index 高于窗口热区（900）', `z-index=${shieldZ}`);
ok(/\.wm-drag-shield\.on\s*\{[^}]*display:\s*block/s.test(css),
   '遮罩默认隐藏，仅 .on 时显示（不影响正常点击）');

/* 11. 文件夹窗口：双击文件夹 = 原地进入，不另开窗口 */
console.log('\n[11] 文件夹双击行为');
ok(/function openChild\(body, S, name\)\s*\{[\s\S]{0,200}?navigate\(body, S, childPath, \{ push: true \}\)/.
     test(explorerCode),
   'openChild 走 navigate({push:true})（原地进入）');
ok(!/newWindow\s*:/.test(explorerCode),
   'explorer.js 代码中已无 newWindow:（不再另开窗口）');
ok(!/\bnewWindow\b/.test(explorerCode),
   'explorer.js 代码中已无 newWindow 标识符（废弃分支清理干净）');
ok(/const winId = `explorer:\$\{mountLabel\}`;/.test(explorerCode),
   '窗口 id 恒为 explorer:<mount>（一个映射一个窗口）');

/* 12. 开始菜单：不再有「用户管理」磁贴 */
console.log('\n[12] 开始菜单磁贴');
const gridFn = appSrc.slice(appSrc.indexOf('function renderStartGrid'));
const gridBody = stripComments(gridFn.slice(0, gridFn.indexOf('\n}\n') + 2));
ok(!/app\s*:\s*'admin'/.test(gridBody),
   'renderStartGrid 不再 push app:"admin"（用户管理磁贴已移除）');
ok(/me\.mounts/.test(gridBody), '仍按映射目录生成文件夹磁贴');
ok(!/showUserAdmin/.test(gridBody),
   'renderStartGrid 不再引用 showUserAdmin');
ok(/data-app/.test(gridBody), 'data-app 点击分支保留（便于将来加回其它应用）');

/* 13. 置顶绑定：必须重新绑定「每次 load 之后的 iframe window」 */
console.log('\n[13] iframe 内部点击置顶');
ok(/__nebulaFocusWin/.test(srcCode),
   '用「已绑定的 window 对象」判重，而非一次性的布尔标志');
ok(/addEventListener\('load'[\s\S]{0,80}bindFrame/.test(srcCode),
   'iframe 的 load 事件后重新绑定（src 后设场景的修复）');
ok(!/__nebulaFocusBound/.test(srcCode),
   '旧的 __nebulaFocusBound 一次性标志已移除');
// ★ 旧断言已更新（2026-09-21）★
//   原先这里断言的是「几何兜底不被 target 在本窗口内提前 return 掉」，
//   那是**已经被删除**的第三条路径（几何命中判定）。本会话改用更可靠的
//   「透明点击盾」（路径 4）后，那条几何兜底代码整块移除了 ——
//   所以旧断言必然报红。这不是回归，是断言过时。
//   现在改为断言路径 3 的 focusin 兜底仍然存在（它还在用 state.el.contains）。
ok(/state\.el\.contains\(t\)/.test(srcCode),
   '路径 3（focusin 兜底）仍在：只对本窗口内的 iframe 触发置顶');
ok(/tagName === 'IFRAME'/.test(srcCode),
   '且严格判 IFRAME，不误伤其它元素');
// ★ 新增：路径 4（透明点击盾）必须存在 —— 这才是现在的主保障 ★
ok(/iframe-shield/.test(srcCode),
   '路径 4：透明点击盾已实现（跨域 iframe 也 100% 可触发置顶）');
ok(!/function hitResizeEdge|_hitEdge/.test(srcCode),
   '已删除的几何兜底不再残留（避免两套置顶逻辑互相干扰）');

/* 14. ★ 拖动必须严格跟随鼠标（本轮新修的核心 bug）★
 *
 *   用户原文：「窗口拖动的位置 有时不能跟随鼠标位置。」
 *
 *   不变量（任一被破坏 = 用户眼中的「不跟手」）：
 *     14a 按下后立刻进入拖动态，且启用遮罩 + 捕获指针
 *     14b 位移严格 = 指针位移（抓取偏移恒定）
 *     14c 指针移出窗口范围（模拟落到 iframe 上）后**仍然收到**事件并继续跟随
 *     14d 松手后彻底停止（不能「松手了还粘着鼠标」）
 *     14e 起点用真实小数坐标，offsetLeft 取整不再造成漂移
 *     14f 边界钳位仅保证窗口留一截在屏幕内，不造成"跟到一半停住"
 */
console.log('\n[14] 拖动跟随鼠标（本轮核心）');

function mkDragWin(over = {}) {
  const el = makeEl('div');
  el.classList.add('window');
  el.offsetLeft = 200; el.offsetTop = 120;
  el.offsetWidth = 800; el.offsetHeight = 600;
  // ★ 关键：几何起点由 _posOf 读 getBoundingClientRect()，
  //   所以桩元素的 rect 也要跟着 offset* 走（makeEl 已实现该映射）。
  const bar = makeEl('div');
  bar.dataset.role = 'titlebar';
  el.appendChild(bar);
  return { el, barEl: bar, opts: {}, minimized: false, maximized: false, ...over };
}

// 14a 按下 → 拖动态 + 遮罩 + 捕获
const d1 = mkDragWin();
bindDrag(d1);
d1.barEl.dispatch('pointerdown', pd(300, 150));
const sh1 = SHIELD();
ok(!!sh1, '14a 按下后启用整屏遮罩');
ok(d1.barEl.hasPointerCapture(1), '14a 按下后捕获指针');

// 14b 位移严格等于指针位移
d1.barEl.dispatch('pointermove', { clientX: 350, clientY: 200, pointerId: 1 });
let dg = posOf(d1);
ok(dg && dg.x === 250 && dg.y === 170,
   '14b 位移严格 = 指针位移（+50,+50）', JSON.stringify(dg));
// 再移一次，验证抓取偏移始终恒定（不是累积误差）
d1.barEl.dispatch('pointermove', { clientX: 400, clientY: 250, pointerId: 1 });
dg = posOf(d1);
ok(dg && dg.x === 300 && dg.y === 220,
   '14b 连续移动累计位移精确（+100,+100，无漂移）', JSON.stringify(dg));

// 14c ★ 模拟「指针落到 iframe 上」：真实环境里父文档会收不到 mousemove，
//     但 pointer capture + 遮罩保证事件仍派发给 bar。这里断言：
//     指针**远离窗口矩形**时事件依然被处理（窗口跟着走）。
d1.barEl.dispatch('pointermove', { clientX: 1200, clientY: 800, pointerId: 1 });
dg = posOf(d1);
ok(!!dg && dg.x !== 300,
   '14c 指针远超窗口范围（模拟落到 iframe）仍继续跟随', JSON.stringify(dg));

// 14d 松手后彻底停止
d1.barEl.dispatch('pointerup', { pointerId: 1 });
const dFrozen = JSON.stringify(posOf(d1));
d1.barEl.dispatch('pointermove', { clientX: 100, clientY: 100, pointerId: 1 });
ok(JSON.stringify(posOf(d1)) === dFrozen, '14d 松手后不再跟随（不会粘着鼠标）');
ok(!SHIELD(), '14d 松手后遮罩已撤除');
ok(!d1.barEl.hasPointerCapture(1), '14d 松手后指针捕获已释放');

// 14e 小数起点不漂移
const d2 = mkDragWin();
d2.el.offsetLeft = 200.4; d2.el.offsetTop = 120.6;
bindDrag(d2);
d2.barEl.dispatch('pointerdown', pd(500, 300));
d2.barEl.dispatch('pointermove', { clientX: 510, clientY: 310, pointerId: 1 });
const dg2 = posOf(d2);
// 期望 200.4+10 = 210.4 → 取整为 210；旧实现用 offsetLeft(200) 会得 210 也一样，
// 但关键在于**起点没有取整**：210.4→210 与 200+10=210 数值巧合相同，
// 因此这里直接断言源码层已换用 _posOf（见 §0），运行时只验证不产生偏移。
ok(dg2 && Math.abs(dg2.x - 210) <= 1,
   '14e 小数起点不产生累积漂移', JSON.stringify(dg2));

// 14f 边界钳位：拖到极远处，窗口仍留一截在屏幕内
//     底部可用边界 = innerHeight(900) − taskbar(48) = 852
const vhUsable = window.innerHeight - 48;
const d3 = mkDragWin();
bindDrag(d3);
d3.barEl.dispatch('pointerdown', pd(300, 150));
d3.barEl.dispatch('pointermove', { clientX: 99999, clientY: 99999, pointerId: 1 });
const dg3 = posOf(d3);
ok(dg3 && dg3.x <= window.innerWidth - 120 + 1,
   '14f 向右钳位：窗口至少留 120px 在屏幕内', JSON.stringify(dg3));
ok(dg3 && dg3.y <= vhUsable - 120 + 1,
   '14f 向下钳位：不钻到任务栏下面（可用高 ' + vhUsable + '）', JSON.stringify(dg3));

const d4 = mkDragWin();
bindDrag(d4);
d4.barEl.dispatch('pointerdown', pd(300, 150));
d4.barEl.dispatch('pointermove', { clientX: -99999, clientY: -99999, pointerId: 1 });
const dg4 = posOf(d4);
ok(dg4 && dg4.y >= 0, '14f 向上钳位：顶边不越出屏幕', JSON.stringify(dg4));
ok(dg4 && dg4.x >= 120 - 800, '14f 向左钳位：至少留一截在屏幕内', JSON.stringify(dg4));
d4.barEl.dispatch('pointerup', { pointerId: 1 });

// 14g 最大化时不可拖
const d5 = mkDragWin({ maximized: true });
bindDrag(d5);
d5.barEl.dispatch('pointerdown', pd(300, 150));
d5.barEl.dispatch('pointermove', { clientX: 400, clientY: 250, pointerId: 1 });
ok(posOf(d5) === null, '14g 最大化状态下拒绝拖动');
d5.barEl.dispatch('pointerup', { pointerId: 1 });

// 14h 搜索框等交互控件上不拖窗口
const d6 = mkDragWin();
const input = makeEl('input');
input.closest = (s) => (s.includes('input') ? input : null);
d6.barEl.appendChild(input);
bindDrag(d6);
d6.barEl.dispatch('pointerdown', { ...pd(300, 150), target: input });
ok(posOf(d6) === null, '14h 工具栏里的输入框上按下不会拖走窗口');
d6.barEl.dispatch('pointerup', { pointerId: 1 });

// 14i close() 中途收尾：_dragUp 已挂到 state 上（供 close 兜底）
ok(typeof d2._dragUp === 'function',
   '14i 拖动收尾函数挂在 state._dragUp（窗口中途关闭时能撤除遮罩）');

/* 15. ★ 默认窗口尺寸必须扣掉任务栏 ★
 *
 *   旧写法 `Math.min(opts.height||620, vh - 24)` 只留 24px 边距，
 *   任务栏（默认 48px）从 y = vh-48 起，于是高 600+ 的窗口
 *   下边缘**连同 s/se/sw 热区一起被任务栏盖住** —— 用户在那里按下去
 *   命中的是任务栏按钮而不是 resize 手柄，这也是「调整大小有 BUG」的一部分。
 */
console.log('\n[15] 默认尺寸扣掉任务栏');
ok(/const taskbarH = cssNum\('--taskbar-h', 48\)/.test(src),
   'open() 从 CSS 变量实读 --taskbar-h（带 48 兜底）');
ok(/vh - taskbarH - 24/.test(src),
   '可用高度 = 视口高 − 任务栏 − 边距（不再只减 24）');
ok(!/Math\.min\(opts\.height \|\| 620, vh - 24\)/.test(src),
   '旧的 `vh - 24` 写法已移除');
ok(/vh - taskbarH - H\) \/ 2/.test(src),
   '垂直居中同样基于扣掉任务栏后的可用高');
ok(/clY = Math\.max\(8, Math\.min\(vh - taskbarH - 120, Y\)\)/.test(src),
   '兜底钳位保证窗口不整块越出可用桌面');

/* 16. ★ resize 热区「延时显示」——悬停意图判定 ★
 *
 *   用户原文：「调整窗口大小的这个 感应范围感觉太快了，
 *             同时是不是可以增加一下 延时显示。」
 *
 *   不变量（任一被破坏 = 用户眼中的「光标乱闪」）：
 *     16a 热区**不再**写死 cursor: X-resize（一碰就变 = 太快）
 *     16b 热区初始 cursor 是 default
 *     16c 指针进入后**不会立刻**变光标（有定时器在等）
 *     16d 停留满延时 → 光标才变成 X-resize
 *     16e 中途离开 → 定时器被清掉，光标保持 default（不残留）
 *     16f 按下立刻武装（延时只作用于光标提示，绝不拖慢真正的拖拽）
 *     16g 延时值有明确常量，且足够"稳"（≥200ms，太短等于没延时）
 *     16h 窗口关闭时定时器被清掉（不留下指向已摘除节点的回调）
 *     16i CSS 层也兜底 cursor:default（JS 未跑时不退化成旧行为）
 *     16j 拖动结束光标复位（不会一直留着双箭头）
 *
 *   ★ 假定时器：产品用 setTimeout，测试必须能在**不真等 260ms** 的情况下
 *     推进时间。用一个可控的 fake setTimeout 替换全局，把回调存进队列，
 *     由 flushTimer 手动触发 —— 这样测试是确定性的、毫秒级完成的。
 */
console.log('\n[16] resize 热区延时显示（悬停意图）');

// ---- 可注入的假定时器 ----
const timers = [];
let timerSeq = 0;
global.setTimeout = (fn, ms) => {
  const id = ++timerSeq;
  timers.push({ id, fn, ms });
  return id;
};
global.clearTimeout = (id) => {
  const i = timers.findIndex((t) => t.id === id);
  if (i >= 0) timers.splice(i, 1);
};
const pendingCount = () => timers.length;
/** 触发所有待处理定时器（模拟「时间到了」），并清空队列 */
function flushTimers() {
  const snapshot = timers.splice(0, timers.length);
  snapshot.forEach((t) => t.fn());
  return snapshot;
}

// ---- 16a/16b: 源码层：不再写死 cursor，延时是常量 ----
ok(!/cursor:\s*`?\$\{dir\}-resize`?/.test(resizeSrc),
   '16a 热区不再写死 cursor:${dir}-resize（"一碰就变"的根因已移除）');
ok(/cursor:\s*'default'/.test(resizeSrc),
   '16b 热区初始 cursor 为 default');
ok(/RESIZE_HOVER_DELAY\s*=\s*(\d+)/.test(resizeSrc),
   '16g 延时值抽成了具名常量 RESIZE_HOVER_DELAY');
const delayVal = Number((resizeSrc.match(/RESIZE_HOVER_DELAY\s*=\s*(\d+)/) || [])[1]);
// ★ 用户两轮反馈叠加：「太快」→ 必须有足够长的延时；
//   但也不能长到"光标怎么还不出来"（>600ms 就开始恼人）。
ok(delayVal >= 300,
   `16g 延时足够"稳"，能滤掉鼠标路过（≥300ms，实测 ${delayVal}ms）`, `实际 ${delayVal}`);
ok(delayVal <= 600,
   `16g 又不至于长到恼人（≤600ms，实测 ${delayVal}ms）`, `实际 ${delayVal}`);
ok(/addEventListener\('pointerenter'/.test(resizeSrc),
   '16c 用 pointerenter 起延时计时');
ok(/addEventListener\('pointerleave'/.test(resizeSrc),
   '16e 用 pointerleave 撤销延时');

// ---- 运行时：真的按上面的语义跑一遍 ----
const stH16 = mkWin();
bindResize(stH16);
const pick = (d) => stH16.el.children.find((c) => c.dataset.resize === d);
const w16 = pick('w');
const e16 = pick('e');

// 16b 运行时：初始 default
ok(w16.style.cursor === 'default',
   '16b 运行时初始 cursor=default（不预先显示双箭头）', `cursor=${w16.style.cursor}`);

// 16c 进入 → 光标**不**立刻变
timers.length = 0;
w16.dispatch('pointerenter', { clientX: 100, clientY: 300, pointerId: 1 });
ok(pendingCount() === 1,
   '16c 指针进入后起了 1 个定时器（延时开始倒数）', `pending=${pendingCount()}`);
ok(w16.style.cursor === 'default',
   '16c 刚进入时 cursor 仍是 default（这就是"延时"）', `cursor=${w16.style.cursor}`);

// 16d 时间到 → 变光标
flushTimers();
ok(w16.style.cursor === 'w-resize',
   '16d 停留满延时后 cursor 变为 w-resize', `cursor=${w16.style.cursor}`);
ok(w16.dataset.armed === '1',
   '16d 同时标记 data-armed="1"（可观测的武装状态）', `armed=${w16.dataset.armed}`);
ok(document.body.style.cursor === 'w-resize',
   '16d body 光标同步（鼠标掠过窗口外缘也不闪回默认）');

// 16e 离开 → 清定时器 + 光标复位
const stH16b = mkWin();
bindResize(stH16b);
const w16b = stH16b.el.children.find((c) => c.dataset.resize === 'w');
timers.length = 0;
w16b.dispatch('pointerenter', { clientX: 100, clientY: 300, pointerId: 1 });
w16b.dispatch('pointerleave', { pointerId: 1 });
ok(pendingCount() === 0,
   '16e 离开时定时器被清除（回调不会再跑）', `pending=${pendingCount()}`);
ok(w16b.style.cursor === 'default',
   '16e 离开后 cursor 保持 default（不残留双箭头）', `cursor=${w16b.style.cursor}`);

// 16e2 ★ 擦过场景（用户真正的抱怨）：进入 → 立刻离开 →
//        之后再推进时间也不该出现光标（旧实现这里会闪）
timers.length = 0;
w16b.dispatch('pointerenter', { clientX: 100, clientY: 300, pointerId: 1 });
w16b.dispatch('pointerleave', { pointerId: 1 });
flushTimers();   // 即便有漏网的回调被触发
ok(w16b.style.cursor === 'default',
   '16e2 鼠标"擦过"边缘（进→出）后推进时间也不出现光标（不再闪）',
   `cursor=${w16b.style.cursor}`);

// 16e3 在不同方向热区之间移动：旧方向的定时器必须被撤销
const stH16c = mkWin();
bindResize(stH16c);
const w16c = stH16c.el.children.find((c) => c.dataset.resize === 'w');
const n16c = stH16c.el.children.find((c) => c.dataset.resize === 'n');
timers.length = 0;
w16c.dispatch('pointerenter', { clientX: 100, clientY: 300, pointerId: 1 });
n16c.dispatch('pointerenter', { clientX: 300, clientY: 5, pointerId: 1 });
ok(pendingCount() === 1,
   '16e3 换到另一个方向热区时旧定时器被撤销（只留 1 个）', `pending=${pendingCount()}`);
flushTimers();
ok(n16c.style.cursor === 'n-resize',
   '16e3 新的方向武装正确（n-resize）', `cursor=${n16c.style.cursor}`);

// 16f ★ 按下立刻武装：不等待 ----
const stH16d = mkWin();
bindResize(stH16d);
const e16d = stH16d.el.children.find((c) => c.dataset.resize === 'e');
timers.length = 0;
e16d.dispatch('pointerdown', pd(900, 400));
ok(e16d.style.cursor === 'e-resize',
   '16f 按下瞬间立刻武装光标（不等待延时，操作不被拖慢）',
   `cursor=${e16d.style.cursor}`);
ok(e16d.hasPointerCapture(1),
   '16f 且同一次 pointerdown 就捕获指针（拖拽能力零延迟）');
e16d.dispatch('pointermove', { clientX: 1000, clientY: 400 });
const g16 = geomOf(stH16d);
ok(g16 && g16.w === 900,
   '16f 按下即可拖动（延时完全没有影响真正的缩放）', JSON.stringify(g16));

// 16j 松手 → 光标复位
e16d.dispatch('pointerup', {});
ok(e16d.style.cursor === 'default',
   '16j 松手后光标复位为 default', `cursor=${e16d.style.cursor}`);
ok(document.body.style.cursor === '',
   '16j 松手后 body 光标清空（不残留双箭头）',
   `body=${JSON.stringify(document.body.style.cursor)}`);

// 16h 关闭时清定时器（源码层：close 里有兜底调用）
ok(/_resizeHoverClear/.test(srcCode),
   '16h 悬停清理函数挂在 state 上（供 close 兜底）');
ok(/w\._resizeHoverClear\s*&&\s*w\._resizeHoverClear\(\)/.test(srcCode),
   '16h close() 里真的调用了它（不留下指向已摘除节点的回调）');

// 16i CSS 兜底
ok(/\[data-resize\]\s*\{[^}]*cursor:\s*default/s.test(css),
   '16i CSS 里 [data-resize] 兜底 cursor:default（JS 未跑时不退化）');

/* 17. ★ 热区**几何**收窄 —— 「感应范围太宽」的另一半 ★
 *
 *   用户原文（第二轮澄清）：「感应范围太宽也太快。」
 *
 *   §16 解决的是"太快"（时序：延时显示光标）。
 *   本节解决"太宽"（几何：热区多大）。两者是独立问题，缺一不可：
 *     · 只做延时不做收窄 → 鼠标稳停在宽热区上仍会亮光标，只是晚了点；
 *     · 只做收窄不做延时 → 鼠标擦过窄热区照样一闪而过。
 *
 *   不变量：
 *     17a 边热区厚度在上限内（超出 10px 即在 100% 缩放下明显"太宽"）
 *     17b 角热区边长在上限内（超出 14px 同理）
 *     17c 热区只占**最外圈**：内缩距离 = 热区厚度（不向内延伸）
 *     17d 收窄后周长仍**零缝隙**（n/s 让位 = CORNER，四角 = CORNER²）
 *     17e 收窄后角仍覆盖斜向（CORNER > EDGE）
 *     17f 收窄不影响可用性：热区 ≥6px（低于最初的 5px 会重现"按不准"）
 */
console.log('\n[17] 热区几何收窄（"感应范围太宽"）');

// 17a/17b —— 数值上界（§0 已断下界与区间，这里做语义化的显式复核）
ok(edgeVal <= 10,
   `17a 边热区 ≤10px（用户报"太宽"，实测 ${edgeVal}px）`, `实际 ${edgeVal}`);
ok(cornerVal <= 14,
   `17b 角热区 ≤14px（实测 ${cornerVal}px）`, `实际 ${cornerVal}`);

// 17f —— 可用的下界
ok(edgeVal >= 6,
   `17f 热区仍 ≥6px（不重蹈 5px "按不准"覆辙，实测 ${edgeVal}px）`, `实际 ${edgeVal}`);

// 17e —— 角必须大于边
ok(cornerVal > edgeVal,
   `17e 角(${cornerVal}) > 边(${edgeVal})：斜向缩放有更大的捕获区`);

// 17c —— 热区跨边框：外沿伸到窗口外 OUT，内侧仍是 EDGE/CORNER
//   ★ 2026-09-21 更新（Request D）★
//     本节原意是"热区只在最外圈、不向内延伸"。跨边框后这个不变量要**升级**：
//     不只是"不向内延伸"，而是"既在窗内薄薄一圈，又向窗外突出 OUT"。
//     所以断言改为：尺寸 = EDGE + OUT / CORNER + OUT，且外沿偏移 = -OUT。
const st17 = mkWin();
bindResize(st17);
const hh = (d) => st17.el.children.find((c) => c.dataset.resize === d);
const EPX = edgeVal + 'px';
const ESPX = (edgeVal + outVal) + 'px';   // 边跨边框尺寸
const OUTP = (-outVal) + 'px';            // 外沿偏移
ok(String(hh('n').style.height) === ESPX && String(hh('s').style.height) === ESPX,
   `17c n/s 边跨边框尺寸 = EDGE+OUT(${ESPX})（外 OUT + 内 EDGE）`, `n.h=${hh('n').style.height}`);
ok(String(hh('e').style.width) === ESPX && String(hh('w').style.width) === ESPX,
   `17c e/w 边跨边框尺寸 = EDGE+OUT(${ESPX})`, `e.w=${hh('e').style.width}`);
// 外沿必须向外（top/left 为 -OUT，bottom/right 为 -OUT）
ok(String(hh('n').style.top) === OUTP && String(hh('s').style.bottom) === OUTP,
   `17c n/s 外沿向窗外偏移 ${OUTP}`, `n.top=${hh('n').style.top}`);
ok(String(hh('e').style.right) === OUTP && String(hh('w').style.left) === OUTP,
   `17c e/w 外沿向窗外偏移 ${OUTP}`, `e.right=${hh('e').style.right}`);
// 四角外沿同样向外（各自那个角的两个方向）
ok(String(hh('nw').style.left) === OUTP && String(hh('nw').style.top) === OUTP,
   `17c nw 角外沿向窗外偏移 ${OUTP}`);
ok(String(hh('se').style.right) === OUTP && String(hh('se').style.bottom) === OUTP,
   `17c se 角外沿向窗外偏移 ${OUTP}`);

// 17d —— 收窄后周长仍零缝隙：核对每条边的"让位量"仍是 CORNER（不是 EDGE）
//       若让位写了 EDGE，角与边之间会露出 (CORNER-EDGE) 的空档 → 抓不到
const CPX17 = cornerVal + 'px';
const seams = [];
if (String(hh('n').style.left) !== CPX17) seams.push('n.left');
// ★ n.right 例外：跨边框后它改为"直达窗口右沿外"（-OUT），不再让位 ★
//   因为 ne 角纵向下移到 toolbar-h，与 n 条不重叠；让位反而留缝。
if (String(hh('n').style.right) !== (-outVal + 'px')) seams.push('n.right');
if (String(hh('s').style.left) !== CPX17) seams.push('s.left');
if (String(hh('s').style.right) !== CPX17) seams.push('s.right');
if (String(hh('e').style.top).indexOf(CPX17) < 0 && !/--toolbar-h/.test(String(hh('e').style.top))) seams.push('e.top');
if (String(hh('e').style.bottom) !== CPX17) seams.push('e.bottom');
if (String(hh('w').style.top) !== CPX17) seams.push('w.top');
if (String(hh('w').style.bottom) !== CPX17) seams.push('w.bottom');
ok(seams.length === 0,
   '17d 收窄后每条边仍按 CORNER 让位（n 右端改为直达右沿）→ 周长零缝隙',
   seams.length ? `可疑字段：${seams.join(', ')}` : '');

// 17d2 —— 显式证明"让位用的是 CORNER 而不是 EDGE"（这正是缝的成因）
ok(CPX17 !== EPX,
   `17d2 CORNER(${CPX17}) ≠ EDGE(${EPX})，两者必须分开使用（否则必然留缝）`);

/* 18. ★ 热区**跨边框**（Request D）★
 *
 *   用户原文：
 *     「调整窗口 鼠标感应 区域 以边框外边缘 向左和向右，向上向下偏移
 *       一定范围内都可激活。目前都是在窗口里面，这个要调整一下。」
 *
 *   不变量：
 *     18a 源码层：OUT 常量存在、且定位助手用的是 span() 与 -OUT
 *     18b 源码层：让位量是 CORNER，**不是** CORNER + OUT（否则留 OUT 缝）
 *     18c 运行层：8 个手柄的外沿都越过窗口边沿 OUT 像素（已在 17c 核对方向）
 *     18d CSS 层：.window 必须 overflow:visible，否则向外那 OUT 被裁掉看不见
 *     18e CSS 层：裁切职责下移到 .toolbar / .win-body（圆角要保住）
 *     18f 零缝隙：跨边框后周长（含窗外带）仍处处可抓（让位量不变）
 */
console.log('\n[18] 热区跨边框（"感应区伸出窗口外"）');

// 18a —— 源码层：OUT 与两个助手
ok(/const OUT\s*=\s*\d+/.test(resizeSrc),
   '18a 源码定义了 OUT 常量（向外延伸量）');
ok(/const OUT_N\s*=\s*-OUT\s*\+\s*'px'/.test(resizeSrc),
   '18a 源码定义了 OUT_N = -OUT + "px"（外沿偏移）');
ok(/const span\s*=\s*\(len\)\s*=>\s*\(len\s*\+\s*OUT\)\s*\+\s*'px'/.test(resizeSrc),
   '18a 源码定义了 span(len) = len + OUT（跨边框尺寸）');

// 18b —— 让位量必须只是 CORNER（这是本会话最容易写错、也最致命的一处）
//   写成 CORNER + OUT → 角与边之间空出 OUT 的缝 → 那段边框抓不到
ok(/const CLEAR\s*=\s*CORNER\s*\+\s*'px'/.test(resizeSrc),
   '18b 让位量 CLEAR = CORNER（不含 OUT，否则角边之间留 OUT 缝）',
   '未找到 `const CLEAR = CORNER + \'px\'`');
ok(!/const CLEAR\s*=\s*\(\s*CORNER\s*\+\s*OUT\s*\)/.test(resizeSrc),
   '18b 未残留 `CLEAR = (CORNER + OUT)` 的错误写法（历史踩过的坑）');

// 18c —— 八个手柄都用 OUT_N 定位（一条都不能漏）
const outNCnt = (resizeSrc.match(/OUT_N/g) || []).length;
ok(outNCnt >= 8,
   `18c 八个手柄的定位都用到 OUT_N（实测出现 ${outNCnt} 次，≥8）`, `实际 ${outNCnt}`);

// 18d/18e —— CSS：外侧那 OUT 必须可见（.window 不能裁掉它）
const cssWin = (css.match(/\.window\s*\{[^}]*\}/s) || [''])[0];
ok(/overflow:\s*visible/.test(cssWin),
   '18d .window 为 overflow:visible（否则向外那 OUT 被裁掉，等于没做）',
   `.window 规则：${cssWin.replace(/\s+/g, ' ').slice(0, 120)}`);
const cssToolbar = (css.match(/\.toolbar\s*\{[^}]*\}/s) || [''])[0];
ok(/overflow:\s*hidden/.test(cssToolbar),
   '18e 裁切职责下移到 .toolbar（overflow:hidden，保住上圆角）');
ok(/border-radius:[^;]*var\(--radius-win\)[^;]*var\(--radius-win\)\s*0\s*0/.test(cssToolbar),
   '18e .toolbar 补了上圆角（裁切后原先靠 .window 的圆角不会丢）',
   `toolbar 规则：${cssToolbar.replace(/\s+/g, ' ').slice(0, 120)}`);
const cssBody = (css.match(/\.win-body\s*\{[^}]*\}/s) || [''])[0];
ok(/overflow:\s*hidden/.test(cssBody),
   '18e .win-body 也 overflow:hidden（保住下圆角）');
ok(/border-radius:\s*0\s*0[^;]*var\(--radius-win\)[^;]*var\(--radius-win\)/.test(cssBody),
   '18e .win-body 补了下圆角',
   `.win-body 规则：${cssBody.replace(/\s+/g, ' ').slice(0, 120)}`);

// 18f —— 跨边框后"让位量不变" ⇒ 周长零缝隙（复用 17d 的 seams 结果）
//   这里再显式核一遍四角的让位仍以 CORNER 为基准（角尺寸变大不影响让位）
const seams18 = [];
if (String(hh('n').style.left) !== CPX17) seams18.push('n.left');
if (String(hh('s').style.right) !== CPX17) seams18.push('s.right');
if (String(hh('w').style.top) !== CPX17) seams18.push('w.top');
if (String(hh('e').style.bottom) !== CPX17) seams18.push('e.bottom');
ok(seams18.length === 0,
   '18f 跨边框后让位量仍是 CORNER → 周长零缝隙（含窗外带）',
   seams18.length ? `可疑字段：${seams18.join(', ')}` : '');

// 18g —— 顶边必须**全程可抓**：n 条右端直达到窗口右沿外（不再为 ne 让位）
//   这是跨边框顺带修掉的一个死角：原先 n.right=CLEAR，右上角留 12px 抓不到。
ok(String(hh('n').style.right) === OUTP,
   `18g n 条右端直达窗口右沿外（right=${OUTP}），顶边右上角不再留死角`,
   `right=${hh('n').style.right}`);
// 但左端仍让位（nw 角与 n 条纵向重叠，必须让）
ok(String(hh('n').style.left) === CPX17,
   `18g n 条左端仍让出 CORNER，不抢 nw 角的斜向缩放`, `left=${hh('n').style.left}`);

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail ? 1 : 0);
