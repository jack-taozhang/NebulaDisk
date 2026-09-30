/* ============================================================================
 * _test_js_scope.js —— ★ 静态闸门：web/js/*.js 里不许「引用了从未声明的标识符」★
 *
 * ---------------------------------------------------------------------------
 * 为什么要有这一套（2026-10-01 真实事故）
 *
 *   本轮改「一个目标只留一条分享」时，在 `explorer.js` 的 `actShare()` 里加了
 *   防连点：
 *        if (shareBusy) return;      ← 读
 *        shareBusy = true;           ← 写
 *        ...
 *        shareBusy = false;
 *   **却漏了那一行 `let shareBusy = false;`**。
 *
 *   后果：`actShare` 的第一句就
 *        ReferenceError: shareBusy is not defined
 *   （读一个未声明的标识符**直接抛**，不像赋值会自动建全局）
 *   ⇒ 右键「分享」**点了完全没反应**，页面上没有任何提示
 *   （异常被 onClick 的调用链吞掉了）。
 *
 *   ★ 这个错是**用户先发现的**，不是我们测出来的。★
 *   当时的浏览器验证脚本里明明有一条「过程中无 console 异常」，
 *   但它**还没跑过** —— 靠"跑到那条代码路径才会暴露"的闸门，
 *   只要那条路径没被触发就等于没有。
 *
 * ---------------------------------------------------------------------------
 * 本测试锁死的不变量
 *
 *   web/js/ 下每个 .js 文件里，**每一个被引用（read）的标识符**，
 *   必须满足三者之一：
 *     ① 在**同一个文件**里被声明过（任意作用域、任意形态：
 *        let/const/var/function/class/形参/catch 参数/解构绑定/import）
 *     ② 是**跨文件全局**（由 web/js/ 全部文件的**顶层**声明自动汇总出来，
 *        不写死名单 —— 写死的名单一定会漂移）
 *     ③ 是浏览器/语言内置全局（固定白名单，见下面的 BUILTINS）
 *
 *   ★ 精度取舍（刻意为之）★
 *     本测试**不**做完整的作用域链分析，只判断"这个名字在整个文件里到底
 *     声明过没有"。理由：本仓要抓的是"**根本没声明**"这一类（上面那个事故
 *     正是这一类），而完整作用域分析会引入大量边界情况与误报。
 *     误报会让闸门被无视 —— 那比没有闸门更糟。
 *     代价：\"声明在兄弟块里\"这种块级作用域错误抓不到（已知的取舍）。
 *
 *   ★ 解析器自检（§0）★
 *     acorn 解析不出来 / 解析出的标识符数量异常小 ⇒ **报错**，
 *     绝不「0 通过 0 失败」地放行（那正是"文件没跑起来"的信号）。
 *     负向自检也是常驻的：脚本会临时注入一个从未声明的变量，
 *     确认闸门**真的会变红**（见 §3）。
 *
 * 用法：  node tools/_test_js_scope.js
 * 退出码：0 = 全绿
 * ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const JSDIR = path.join(ROOT, 'web/js');

let pass = 0, fail = 0;
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? '  → ' + extra : ''}`); }
};
const info = (t) => console.log(`  · ${t}`);

// ---------------------------------------------------------------------------
// acorn：本机没有独立的 node_modules，从若干候选位置找。
// ★ 找不到就**大声失败**，绝不静默跳过（静默跳过 = 闸门失效还看不出来）★
// ---------------------------------------------------------------------------
function loadAcorn() {
  const cands = [
    'acorn',
    path.join(__dirname, '../node_modules/acorn'),
    'C:/Users/Tao_Zhang/.workbuddy/binaries/node/versions/22.22.2-3/node_modules/@tencent/slidep/node_modules/acorn',
    '/c/Users/Tao_Zhang/.workbuddy/binaries/node/versions/22.22.2-3/node_modules/@tencent/slidep/node_modules/acorn',
  ];
  for (const c of cands) {
    try { return require(c); } catch { /* 试下一个 */ }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 内置全局白名单：语言 + 浏览器（只列本仓真的用得上的）
// ---------------------------------------------------------------------------
const BUILTINS = new Set([
  // 语言
  'globalThis', 'Object', 'Array', 'String', 'Number', 'Boolean', 'Symbol', 'BigInt',
  'Math', 'JSON', 'Date', 'RegExp', 'Error', 'TypeError', 'RangeError', 'SyntaxError',
  'EvalError', 'URIError', 'AggregateError', 'Map', 'Set', 'WeakMap', 'WeakSet',
  'Promise', 'Proxy', 'Reflect', 'Function', 'Infinity', 'NaN', 'undefined',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURI', 'encodeURIComponent',
  'decodeURI', 'decodeURIComponent', 'escape', 'unescape', 'eval',
  'ArrayBuffer', 'Uint8Array', 'Uint16Array', 'Int8Array', 'Int32Array', 'Uint32Array',
  'Float32Array', 'Float64Array', 'DataView', 'SharedArrayBuffer', 'Atomics',
  'structuredClone', 'queueMicrotask', 'setTimeout', 'clearTimeout',
  'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame',
  'requestIdleCallback', 'cancelIdleCallback', 'fetch', 'Headers', 'Request',
  'Response', 'AbortController', 'AbortSignal', 'FormData', 'URLSearchParams',
  'Blob', 'File', 'FileReader', 'FileList', 'URL', 'TextEncoder', 'TextDecoder',
  'atob', 'btoa', 'crypto', 'performance', 'console', 'arguments',
  // 浏览器
  'window', 'self', 'document', 'navigator', 'location', 'history', 'screen',
  'localStorage', 'sessionStorage', 'indexedDB', 'caches', 'CustomEvent', 'Event',
  'EventTarget', 'KeyboardEvent', 'MouseEvent', 'PointerEvent', 'DragEvent',
  'ClipboardEvent', 'InputEvent', 'FocusEvent', 'WheelEvent', 'TouchEvent',
  'HTMLInputElement', 'HTMLElement', 'Element', 'Node', 'NodeList', 'DOMParser',
  'XMLHttpRequest', 'WebSocket', 'Worker', 'Image', 'Audio', 'Video', 'Path2D',
  'CanvasRenderingContext2D', 'IntersectionObserver', 'MutationObserver',
  'ResizeObserver', 'getComputedStyle', 'matchMedia', 'scrollTo', 'scrollBy',
  'alert', 'confirm', 'prompt', 'open', 'close', 'focus', 'blur', 'print',
  'postMessage', 'addEventListener', 'removeEventListener', 'dispatchEvent',
  'innerWidth', 'innerHeight', 'devicePixelRatio', 'top', 'parent', 'frames',
  'CSS', 'DOMRect', 'Range', 'Selection', 'MessageChannel', 'Notification',
  'eyeDropper', 'showOpenFilePicker', 'showSaveFilePicker', 'trustedTypes',
  // CommonJS（qr.js 末尾有 `if (typeof module !== 'undefined') module.exports = QR`
  // 这种 UMD 兜底，为的是同一份文件也能在 Node 里 require 进来跑单测）
  'module', 'exports', 'require', 'process', '__dirname', '__filename',
]);

// ---------------------------------------------------------------------------
// 文件内的 `/* global X, Y */` 注解 —— 外部脚本注入的全局，由**源码自己声明**
//
// ★ 为什么要尊重这个注解（而不是往白名单里堆名字）★
//   `DocsAPI` 是 OnlyOffice 的 api.js 注入的、页面里根本不存在于我们的源码；
//   而 share.js / viewer.js 已经在调用点上方写了 `/* global DocsAPI */`。
//   白名单是"全局的"，注解是"本文件的" —— 后者更准确，也不会随着
//   换预览引擎（kk / cad / OO）而需要改闸门本身。
// ---------------------------------------------------------------------------
function collectGlobalAnnotations(code) {
  const names = new Set();
  const re = /\/\*\s*globals?\s+([^*]+?)\s*\*\//g;
  let m;
  while ((m = re.exec(code)) !== null) {
    for (const raw of m[1].split(/[,\s]+/)) {
      const n = raw.split(':')[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(n)) names.add(n);
    }
  }
  return names;
}

// ---------------------------------------------------------------------------
// 从 ESTree AST 里把「声明过的名字」全部收集出来（任意作用域）
// ---------------------------------------------------------------------------
function collectDeclaredNames(ast) {
  const names = new Set();

  /** 解构模式（{a, b: c, ...rest} / [a, , b] / a = 默认值）里的绑定名 */
  const patternNames = (node) => {
    if (!node) return;
    switch (node.type) {
      case 'Identifier': names.add(node.name); break;
      case 'ObjectPattern':
        for (const p of node.properties) {
          if (p.type === 'RestElement') patternNames(p.argument);
          else patternNames(p.value);
        }
        break;
      case 'ArrayPattern':
        for (const el of node.elements) patternNames(el);
        break;
      case 'RestElement': patternNames(node.argument); break;
      case 'AssignmentPattern': patternNames(node.left); break;
      default: break;
    }
  };

  const visit = (node) => {
    if (!node || typeof node.type !== 'string') return;
    switch (node.type) {
      case 'FunctionDeclaration':
      case 'FunctionExpression':
      case 'ArrowFunctionExpression':
        if (node.id) names.add(node.id.name);
        for (const p of node.params) patternNames(p);
        break;
      case 'ClassDeclaration':
      case 'ClassExpression':
        if (node.id) names.add(node.id.name);
        break;
      case 'VariableDeclarator':
        patternNames(node.id);
        break;
      case 'CatchClause':
        if (node.param) patternNames(node.param);
        break;
      case 'ImportDefaultSpecifier':
      case 'ImportNamespaceSpecifier':
      case 'ImportSpecifier':
        if (node.local) names.add(node.local.name);
        break;
      default: break;
    }
    for (const k of Object.keys(node)) {
      if (k === 'type' || k === 'loc' || k === 'start' || k === 'end') continue;
      const v = node[k];
      if (Array.isArray(v)) { for (const c of v) if (c && typeof c.type === 'string') visit(c); }
      else if (v && typeof v.type === 'string') visit(v);
    }
  };
  visit(ast);
  return names;
}

/**
 * 收集「被引用」的标识符（排除属性名、对象字面量的键、标签、以及声明位置）。
 * 返回 [{ name, line, col }]
 *
 * ⚠️ 实现要点（第一版就在这里栽了）：
 *   分两遍走 —— 第一遍只负责把「**不是引用**的 Identifier」记进 `skip`，
 *   第二遍才真正收集。**不能**靠"第一遍不遍历它"来达到目的：
 *   第二遍是无脑全树遍历的，没进 `skip` 的 Identifier 一律会被收进来
 *   ⇒ 第一版把 `res.json` 的 `json`、`el.classList` 的 `classList`
 *     全报成"未声明"（几百条误报，闸门直接废掉）。
 *   ⇒ 凡是"长得像标识符但不是变量引用"的位置，**必须显式 skip**：
 *     非计算成员 `.prop`、非简写属性的键、标签名、`new.target` 的 meta。
 */
function collectReferences(ast) {
  const refs = [];
  const skip = new Set();

  const visit = (node) => {
    if (!node || typeof node.type !== 'string') return;
    switch (node.type) {
      case 'MemberExpression':
        // obj.prop —— prop 只是属性名，**必须记进 skip**
        if (!node.computed) skip.add(node.property);
        else visit(node.property);
        visit(node.object);
        return;
      case 'Property':
        // `{ key: value }` 的 key 不是引用；但**简写** `{ key }` 的 key 就是引用
        if (node.computed) visit(node.key);
        else if (!node.shorthand) skip.add(node.key);
        visit(node.value);
        return;
      case 'MethodDefinition':
      case 'PropertyDefinition':
        if (node.computed) visit(node.key);
        else if (node.key) skip.add(node.key);
        visit(node.value);
        return;
      case 'LabeledStatement':
        skip.add(node.label);
        visit(node.body);
        return;
      case 'BreakStatement':
      case 'ContinueStatement':
        if (node.label) skip.add(node.label);
        return;
      case 'MetaProperty':
        // new.target / import.meta
        skip.add(node.meta);
        skip.add(node.property);
        return;
      case 'ImportDefaultSpecifier':
      case 'ImportNamespaceSpecifier':
      case 'ImportSpecifier':
      case 'ExportSpecifier':
        // import/export 的名字不是"变量引用"（本仓也没有 ESM，保守跳过）
        return;
      default: break;
    }
    for (const k of Object.keys(node)) {
      if (k === 'type' || k === 'loc' || k === 'start' || k === 'end') continue;
      const v = node[k];
      if (Array.isArray(v)) { for (const c of v) if (c && typeof c.type === 'string') visit(c); }
      else if (v && typeof v.type === 'string') visit(v);
    }
  };
  visit(ast);

  const collect = (node) => {
    if (!node || typeof node.type !== 'string') return;
    if (node.type === 'Identifier' && !skip.has(node)) {
      refs.push({ name: node.name, line: node.loc.start.line, col: node.loc.start.column + 1 });
    }
    for (const k of Object.keys(node)) {
      if (k === 'type' || k === 'loc' || k === 'start' || k === 'end') continue;
      const v = node[k];
      if (Array.isArray(v)) { for (const c of v) if (c && typeof c.type === 'string') collect(c); }
      else if (v && typeof v.type === 'string') collect(v);
    }
  };
  collect(ast);
  return refs;
}

function main() {
  console.log('\n════════ 静态作用域闸门：不许引用未声明的标识符 ════════\n');

  // ---- §0 解析器自检 ------------------------------------------------------
  console.log('[0] 解析器就绪自检');
  const acorn = loadAcorn();
  ok(!!acorn, 'acorn 可用（找不到会大声失败，不静默跳过）',
     '四处候选路径都 require 不到');
  if (!acorn) { console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`); process.exit(1); }
  ok(typeof acorn.parse === 'function', 'acorn.parse 是个函数', typeof acorn.parse);

  const files = fs.readdirSync(JSDIR).filter((f) => f.endsWith('.js')).sort();
  ok(files.length >= 8, `找到 ${files.length} 个 web/js/*.js（少于 8 个说明目录看错了）`,
     files.join(','));

  // ---- 解析全部文件 -------------------------------------------------------
  const parsed = [];
  for (const f of files) {
    const full = path.join(JSDIR, f);
    const code = fs.readFileSync(full, 'utf8');
    try {
      const ast = acorn.parse(code, { ecmaVersion: 2022, sourceType: 'script', locations: true });
      parsed.push({
        name: f, code, ast,
        declared: collectDeclaredNames(ast),
        refs: collectReferences(ast),
        globals: collectGlobalAnnotations(code),
      });
    } catch (e) {
      ok(false, `${f} 解析失败`, String(e.message));
    }
  }

  // §0b：注解解析自检 —— 本仓确实用到了 `/* global DocsAPI */`，
  //      解析不到说明这段正则坏了（0 命中 = 解析坏了，不能静默放过）
  const annTotal = parsed.reduce((n, p) => n + p.globals.size, 0);
  ok(annTotal >= 1, `/* global X */ 注解解析到 ${annTotal} 个（本仓至少 DocsAPI 一处）`);

  // ---- §1 解析自检：引用数不能小得离谱（小 = 遍历写坏了）-------------------
  const totalRefs = parsed.reduce((n, p) => n + p.refs.length, 0);
  ok(totalRefs > 500, `解析出的标识符引用总数 = ${totalRefs}（>500，说明遍历真的在跑）`);

  // ---- 派生「跨文件全局」：各文件**顶层**（column 0）的声明 ----------------
  const crossFile = new Set();
  for (const p of parsed) {
    for (const line of p.code.split(/\r?\n/)) {
      const m = /^(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/.exec(line);
      if (m) crossFile.add(m[1]);
      const m2 = /^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/.exec(line);
      if (m2) crossFile.add(m2[1]);
    }
  }
  info(`跨文件全局（自动汇总，不写死名单）：${[...crossFile].sort().join(' ')}`);
  ok(crossFile.size >= 8, `跨文件全局汇总出 ${crossFile.size} 个`);

  // ---- §2 正题：逐个文件查未声明引用 --------------------------------------
  console.log('\n[1] 每个文件里被引用但从未声明的标识符');
  const problems = [];
  for (const p of parsed) {
    const bad = new Map();      // name -> 第一次出现的位置
    for (const r of p.refs) {
      if (p.declared.has(r.name)) continue;
      if (crossFile.has(r.name)) continue;
      if (p.globals.has(r.name)) continue;      // 本文件自己声明的外部全局
      if (BUILTINS.has(r.name)) continue;
      if (!bad.has(r.name)) bad.set(r.name, r);
    }
    if (bad.size) {
      for (const [n, r] of bad) problems.push({ file: p.name, name: n, line: r.line, col: r.col });
    }
  }
  ok(problems.length === 0,
     '★ 没有任何「引用了未声明的标识符」（这正是 shareBusy 那类事故）★',
     problems.slice(0, 8).map((x) => `${x.file}:${x.line}:${x.col} ${x.name}`).join(' | '));
  if (problems.length) {
    for (const x of problems) info(`未声明：${x.file}:${x.line}:${x.col}  ${x.name}`);
  }

  // ---- §3 常驻负向自检：闸门必须真的会变红 --------------------------------
  //      临时把一处 `let X = ...` 改成 `X = ...`（名字也换掉），
  //      确认上面那套判据**真的能抓到**；抓不到就说明闸门是假的。
  console.log('\n[2] 负向自检（闸门必须真的会红）');
  const victim = parsed.find((p) => p.name === 'explorer.js') || parsed[0];
  const mutated = victim.code.replace(
    /let shareBusy = false;/,
    'shareBusy2 = false;   /* 负向自检：故意去掉声明 */');
  const changed = mutated !== victim.code;
  ok(changed, `负向自检的夹具能匹配到 ${victim.name} 里的那一行`);
  if (changed) {
    const ast2 = acorn.parse(mutated, { ecmaVersion: 2022, sourceType: 'script', locations: true });
    const d2 = collectDeclaredNames(ast2);
    const r2 = collectReferences(ast2);
    const bad2 = new Set();
    for (const r of r2) {
      if (d2.has(r.name) || crossFile.has(r.name)
          || collectGlobalAnnotations(mutated).has(r.name) || BUILTINS.has(r.name)) continue;
      bad2.add(r.name);
    }
    ok(bad2.has('shareBusy2'),
       '★ 负向自检：拿掉 `let shareBusy = false;` 后，闸门**确实报出 shareBusy2** ★',
       [...bad2].join(','));
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail ? 1 : 0);
}

main();
