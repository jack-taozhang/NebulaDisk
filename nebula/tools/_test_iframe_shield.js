/* ============================================================================
 * _test_iframe_shield.js —— ★ 点 iframe 窗口任意位置都能置顶 ★
 *
 * 对应 bug（用户原文，第三次强调）：
 *   「编辑和预览文件的窗口 目前还没有实现 点击窗口任何地方就聚焦成
 *     最前端显示。」
 *   「目前点击中间部分才能前置，其他位置没有反应」
 *
 * 根因（真机推理 + 旧实现阅读）：
 *   预览/编辑窗口的内容是 <iframe>（OnlyOffice / CAD / kkFileView）。
 *   点在 iframe **内部**时，事件由 iframe 自己的浏览上下文消费，
 *   父文档一个都收不到；跨域时连 contentWindow 也摸不到。
 *   旧实现的三条路径全部依赖「焦点发生转移」：
 *     第 1 次点 → focus 转移 → 置顶（用户看到的"点中间才行"）
 *     第 2 次起 → activeElement 没变 → 不派发 focus/focusin → 没反应
 *   旧的第 4 条「几何兜底」在父文档听 mousedown，同样收不到 iframe 内部点击，
 *   而且每个窗口各自挂一个 document 监听，重叠时会互相抢着置顶。
 *
 * 修法（与是否同源、是否跨域全无关）：
 *   在 iframe 上面盖一层透明 div（.iframe-shield），它属于父文档，
 *   它的 mousedown 必定冒泡到窗口 el 上的捕获监听 → focus(id) → 置顶。
 *   置顶后 shell.js 立即把盾 pointer-events:none，让内容可交互；
 *   别的窗口一上来，focus() 重算 → 盾重新生效。
 *
 * 本测试从产品源码抽取 _bindIframeFocus / focus 相关的盾逻辑，验证：
 *   §0 源码形态：盾存在、用 pointerEvents 开关、走 focus()、挂在全局 Set 上
 *   §1 造盾：每个 iframe 上都盖了一层，且归属本窗口（data-win-id）
 *   §2 ★ 本窗口不是最顶层时 → 盾生效（pointer-events:auto）★
 *   §3 ★ 本窗口是最顶层时 → 盾关闭（pointer-events:none）★
 *   §4 ★ 点盾 → focus(id) 被调用（这就是"任意位置置顶"的机制）★
 *   §5 别的窗口 focus → 本窗口的盾重新生效（syncShield 被联动）
 *   §6 关窗时盾被摘掉、sync 回调被注销（不许泄漏）
 *   §7 盾不吃掉 iframe 的尺寸/布局：inset:0 覆盖整个 iframe
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

function stripComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}
const bare = stripComments(src);

function extractFn(name) {
  let i = src.indexOf(`async function ${name}(`);
  if (i >= 0) { i += 'async '.length; }
  else { i = src.indexOf(`function ${name}(`); }
  if (i < 0) throw new Error(`源码里找不到 ${name}()，shell.js 可能被重构过`);
  let d = 0, started = false;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') { d++; started = true; }
    else if (src[j] === '}') { d--; if (started && d === 0) return src.slice(i, j + 1); }
  }
  throw new Error(`${name}() 花括号不配对`);
}

/* ---------- §0 源码形态（防回归第一道闸，不跑桩） ---------- */
console.log('\n§0 源码形态：点击盾必须存在且走 focus()');
{
  ok('_bindIframeFocus 里造了 .iframe-shield',
     /className\s*=\s*'iframe-shield'/.test(bare),
     '没有点击盾 → 跨域/已聚焦时点任意位置都不会置顶');
  ok('盾用 pointerEvents 开关（不是删节点，避免布局抖动）',
     /pointerEvents\s*=\s*on\s*\?\s*'auto'\s*:\s*'none'/.test(bare),
     '盾的开关方式变了，需重新确认行为');
  ok('盾的 mousedown 里调 focus(id)',
     /s\.addEventListener\('mousedown'[\s\S]{0,400}?focus\(id\)/.test(bare),
     '盾没有触发置顶');
  ok('盾的 mousedown 里 preventDefault（不抢焦点/不触发拖拽）',
     /s\.addEventListener\('mousedown'[\s\S]{0,300}?e\.preventDefault\(\)/.test(bare));
  ok('★ 置顶后立即撤盾（syncShield），内容才能交互',
     /focus\(id\);[\s\S]{0,200}?syncShield\(\);/.test(bare),
     '置顶后没撤盾 → 内容点不动了');
  ok('★ 盾的 sync 回调挂在全局 Set 上（不是每窗口一个 document 监听）',
     /_shieldSyncHooks\s*=\s*new Set\(\)/.test(bare),
     '又退回「每窗口一个 document mousedown」→ 重叠时会互相抢置顶');
  ok('★ focus() 里联动重算所有盾',
     /function focus\(id\)[\s\S]{0,600}?_syncAllShields\(\)/.test(bare),
     '别的窗口置顶后，本窗口的盾不会重新生效');
  ok('minimize/close 也会重算盾',
     /function minimize\(id\)[\s\S]{0,400}?_syncAllShields\(\)/.test(bare) &&
     /const remove = \(\) => \{[\s\S]{0,300}?_syncAllShields\(\)/.test(bare),
     '最小化/关窗后最顶层换人，盾状态没更新');
  ok('★ 旧的「几何兜底」document mousedown 监听已移除',
     !/if \(state\.el\.contains\(t\) && !\(t && t\.tagName === 'IFRAME'\)\) return;/.test(bare),
     '旧几何兜底还在 → 重叠窗口会互相抢着置顶');
  ok('_unbindIframeFocus 里摘盾 + 注销 sync 回调',
     /_shieldSyncHooks\.delete\(state\._iframeShieldOnFocus\)/.test(bare) &&
     /removeChild\(s\)/.test(bare),
     '关窗后盾和回调泄漏');
}

/* ============================================================================
 * 行为测试：把 _bindIframeFocus 从源码抽出来，在 DOM 桩里真跑一遍
 * ========================================================================== */

/* ---------- DOM 桩 ---------- */
/** style 桩：既要能 `style.pointerEvents = x`，也要能 `style.cssText = '...'` */
class Style {
  constructor() { this._css = ''; }
  /** 写入 cssText 时，把里面的声明解析成可读属性（供断言） */
  set cssText(v) {
    this._css = v;
    String(v).split(';').forEach((d) => {
      const i = d.indexOf(':');
      if (i < 0) return;
      const k = d.slice(0, i).trim();
      const val = d.slice(i + 1).trim();
      // position / z-index / background / inset / cursor 等直接存原名
      this[k] = val;
      // 同时给一个驼峰别名，方便两种写法都能读
      const camel = k.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      if (camel !== k) this[camel] = val;
    });
  }
  get cssText() { return this._css; }
}
class El {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.dataset = {};
    this.style = new Style();
    this._listeners = {};
    this._cls = [];
    this.className = '';
    const self = this;
    this.classList = {
      add: (c) => { if (!self._cls.includes(c)) self._cls.push(c); },
      remove: (c) => { self._cls = self._cls.filter((x) => x !== c); },
      contains: (c) => self._cls.includes(c),
      toggle: (c, on) => { if (on) self.classList.add(c); else self.classList.remove(c); },
    };
  }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  setAttribute(k, v) { if (k === 'data-win-id') this.dataset.winId = v; }
  addEventListener(t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); }
  removeEventListener(t, fn) {
    const a = this._listeners[t] || []; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1);
  }
  fire(type, ev) { (this._listeners[type] || []).slice().forEach((fn) => fn(ev || {})); }
  querySelectorAll(sel) {
    const out = [];
    const walk = (n) => n.children.forEach((c) => {
      if (matchesSel(c, sel)) out.push(c);
      walk(c);
    });
    walk(this);
    return out;
  }
  contains(n) {
    if (n === this) return true;
    return this.children.some((c) => c.contains && c.contains(n));
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 };
  }
}
function matchesSel(el, sel) {
  if (sel === 'iframe') return el.tagName === 'IFRAME';
  if (sel.startsWith('.')) {
    const c = sel.slice(1);
    return el._cls.includes(c) || (el.className || '').split(/\s+/).includes(c);
  }
  return false;
}

/* ---------- 全局环境桩 ---------- */
const sb = { console, Set, Math, parseInt };
sb.document = {
  createElement: (t) => new El(t),
  addEventListener() {}, removeEventListener() {},
  querySelectorAll: () => [],
  body: new El('body'),
};
sb.getComputedStyle = () => ({ position: 'relative' });
sb.MutationObserver = class {
  constructor() {}
  observe() {}
  disconnect() { sb.__moDisconnected = true; }
};
sb.window = sb;
sb.windows = new Map();
sb.__focusCalls = [];
sb.__zTop = 100;
/** 忠实模拟产品 focus()：先抬高 zIndex，再（由产品代码自己）重算盾 */
sb.focus = (id) => {
  sb.__focusCalls.push(id);
  const w = sb.windows.get(id);
  if (w) w.el.style.zIndex = ++sb.__zTop;   // 等价于 _raise(w)
};

vm.createContext(sb);
// ★ 模块级单例（_shieldSyncHooks 等）定义在 _bindIframeFocus 之外，
//   必须一并注入，否则抽取出来的函数会 ReferenceError。
vm.runInContext(
  'let _shieldSyncHooks = null;\n' +
  'let _shieldGlobalBound = false;\n' +
  'let _onAnyFocusSync = null;\n',
  sb,
);
vm.runInContext(extractFn('_bindIframeFocus'), sb);
vm.runInContext(extractFn('_unbindIframeFocus'), sb);
vm.runInContext(extractFn('_syncAllShields'), sb);
vm.runInContext(
  'this._bindIframeFocus = _bindIframeFocus;' +
  'this._unbindIframeFocus = _unbindIframeFocus;' +
  'this._syncAllShields = _syncAllShields;' +
  'this.__hooks = () => _shieldSyncHooks;',
  sb,
);

/* ---------- 造一个 iframe 窗口 ----------
 * ★ z 号必须走计数器（等价于产品里的 _raise/open）★
 *   绝不能手写比计数器更大的值，否则「谁是最顶层」的判定会和
 *   真实的 _raise 不自洽（这个坑在 §4 上踩过）。
 */
function mkWin(id) {
  const el = new El('div');
  el.dataset.winId = id;
  el.style.zIndex = ++sb.__zTop;          // 等价于产品 _raise()
  const wrap = new El('div');
  wrap.className = 'kk-frame-wrap';
  el.appendChild(wrap);
  const fr = new El('iframe');
  wrap.appendChild(fr);
  const state = { id, el, _iframes: [] };
  sb.windows.set(id, { id, el, minimized: false });
  return { state, el, wrap, fr };
}
const raiseWin = (w) => { w.el.style.zIndex = ++sb.__zTop; };
const shieldOf = (w) => w.wrap.querySelectorAll('.iframe-shield')[0];

console.log('\n§1 造盾：每个 iframe 上都盖了一层，且归属本窗口');
{
  sb.windows.clear();
  sb.__zTop = 100;
  const a = mkWin('img:共享');
  sb._bindIframeFocus(a.state);
  const shields = a.wrap.querySelectorAll('.iframe-shield');
  ok('iframe 上生成了一个盾', shields.length === 1, `得到 ${shields.length}`);
  ok('盾归属本窗口（data-win-id = 窗口 id）',
     shieldOf(a).dataset.winId === 'img:共享', `得到 ${shieldOf(a).dataset.winId}`);
  ok('盾挂在 iframe 的定位父节点里', shieldOf(a).parentNode === a.wrap);
  ok('盾有 pointer-events 内联样式（可被开关）',
     /pointer-events/.test(shieldOf(a).style._css), shieldOf(a).style._css);
  ok('盾覆盖整个 iframe（inset:0）',
     /inset\s*:\s*0/.test(shieldOf(a).style._css), shieldOf(a).style._css);
  sb._bindIframeFocus(a.state);
  ok('重复 bind 不会叠加第二个盾',
     a.wrap.querySelectorAll('.iframe-shield').length === 1);
}

console.log('\n§2/§3 ★ 盾的开关只看「本窗口是不是最顶层」★');
{
  sb.windows.clear();
  sb.__focusCalls = [];
  const a = mkWin('oo:共享');   // 在下
  const b = mkWin('cad:共享');  // 在上
  sb._bindIframeFocus(a.state);
  sb._bindIframeFocus(b.state);
  ok('★ 非最顶层窗口 → 盾生效（pointer-events:auto）',
     shieldOf(a).style.pointerEvents === 'auto', `得到 ${shieldOf(a).style.pointerEvents}`);
  ok('★ 最顶层窗口 → 盾关闭（pointer-events:none）',
     shieldOf(b).style.pointerEvents === 'none', `得到 ${shieldOf(b).style.pointerEvents}`);

  raiseWin(a);  // 模拟 a 被置顶（走计数器，与产品 _raise 一致）
  a.state._iframeShieldOnFocus();
  b.state._iframeShieldOnFocus();
  ok('★ a 置顶后 → a 撤盾、b 重新挂盾（联动正确）',
     shieldOf(a).style.pointerEvents === 'none' &&
     shieldOf(b).style.pointerEvents === 'auto',
     `a=${shieldOf(a).style.pointerEvents} b=${shieldOf(b).style.pointerEvents}`);
}

console.log('\n§4 ★ 点盾 → focus(id) 被调用（"任意位置置顶"的机制）★');
{
  // ★ 每个小节都清空窗口表 + 复位 z 计数器 ★
  //   否则上一节手动设的 zIndex 会污染本节的最顶层判定
  //   （真实产品里 z 号只由 _raise 递增，不会有人手写）
  sb.windows.clear();
  sb.__zTop = 100;
  sb.__focusCalls = [];
  const a = mkWin('img2:共享');
  const b = mkWin('oo2:共享');
  sb._bindIframeFocus(a.state);
  sb._bindIframeFocus(b.state);
  shieldOf(a).fire('mousedown', { stopPropagation() {}, preventDefault() {} });
  ok('★ 点 a 的盾 → focus("img2:共享") 被调用',
     sb.__focusCalls.includes('img2:共享'), JSON.stringify(sb.__focusCalls));
  ok('点盾后 a 的盾被撤掉（内容立即可交互）',
     shieldOf(a).style.pointerEvents === 'none',
     `得到 ${shieldOf(a).style.pointerEvents}；zTop=${sb.__zTop}`);
}

console.log('\n§5 别的窗口 focus → 本窗口的盾重新生效');
{
  sb.windows.clear();
  sb.__zTop = 100;
  const a = mkWin('img3:共享');
  const b = mkWin('oo3:共享');
  sb._bindIframeFocus(a.state);
  sb._bindIframeFocus(b.state);
  ok('每个 iframe 窗口都注册了 syncShield 回调',
     typeof a.state._iframeShieldOnFocus === 'function' &&
     typeof b.state._iframeShieldOnFocus === 'function');
  raiseWin(a);
  b.state._iframeShieldOnFocus();
  ok('★ b 感知到自己不是最顶层 → 盾重新生效',
     shieldOf(b).style.pointerEvents === 'auto', `得到 ${shieldOf(b).style.pointerEvents}`);
}

console.log('\n§6 关窗时盾被摘掉（不许泄漏）');
{
  const a = mkWin('img4:共享');
  sb._bindIframeFocus(a.state);
  ok('关窗前盾在', a.wrap.querySelectorAll('.iframe-shield').length === 1);
  sb.__moDisconnected = false;
  sb._unbindIframeFocus(a.state);
  ok('★ 关窗后盾被移除', a.wrap.querySelectorAll('.iframe-shield').length === 0);
  ok('★ 关窗后 sync 回调被注销', a.state._iframeShieldOnFocus === null);
  ok('关窗后 MutationObserver 被断开', sb.__moDisconnected === true);
}

console.log('\n§7 盾不改变 iframe 布局（纯覆盖，零尺寸副作用）');
{
  const a = mkWin('img5:共享');
  sb._bindIframeFocus(a.state);
  const css = shieldOf(a).style._css;
  ok('盾是 absolute 定位（不挤走 iframe）', /position\s*:\s*absolute/.test(css), css);
  ok('盾有 z-index（盖在 iframe 之上）', /z-index\s*:\s*\d+/.test(css), css);
  ok('盾背景透明（用户看不出多了一层）', /background\s*:\s*transparent/.test(css), css);
}

console.log('\n════════════════════════════════');
console.log(`  通过 ${pass} / ${pass + fail}`);
if (fail) console.log(`  ❌ 失败 ${fail} 项`);
else console.log('  ✅ 全部通过');
process.exitCode = fail ? 1 : 0;
