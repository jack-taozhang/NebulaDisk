/* ============================================================================
 * _test_window_controls.js —— ★ 预览窗口不许出现「两套 最小化/最大化/关闭」★
 *
 * 对应 bug（用户报障原话）：
 *   「网盘内部 视频文件 打开，有两层 最小化，最大化，关闭按钮。
 *    可以参照图片预览窗口。」
 *
 * 根因（读 shell.js 就能确认，不是猜）：
 *   shell.js 里有**两处**会渲染那三键：
 *     ① `Toolbar.build()`  —— 第 246 行起，`opts.controls === false` 时才不渲染；
 *     ② 标题栏 `data-role="titlebar"` —— 第 316 行起，`opts.chromeless` 时才不渲染。
 *   两个开关**互相独立**。默认（什么都不传）= 两个都渲染 = **两套按钮**。
 *   图片预览（openImage）早就传了 `chromeless: true`，所以只有一套 ——
 *   正是用户拿来对照的那个"参照物"；视频/音频（openMedia）漏了，于是两套。
 *
 * 本测试锁死的不变量（一句话）：
 *   **viewer.js 里每一个 WM.open(...) 都必须显式写 chromeless，
 *     且值只能是 true。**
 *   为什么是"全部"而不是"只测音视频"：
 *     这是一个**版式契约**——预览器的三键统一由工具栏承载，标题栏一律不渲染。
 *     只盯音视频的话，下一个新增的预览器（比如将来加个 3D 预览）会再踩一次。
 *
 * 设计原则与其它测试一致：
 *   · 只从产品源码里抽（绝不复制一份逻辑进来，否则测的是副本）
 *   · §0 先做"解析器自检"：匹配数必须是 6（当前已知的预览器个数）。
 *     0 命中就说明正则/解析坏了 —— 那时**必须报错**，不能假装通过
 *     （0 通过 0 失败正是"文件没跑起来"的典型信号）。
 * ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const VIEWER = path.join(ROOT, 'web/js/viewer.js');
const SHELL = path.join(ROOT, 'web/js/shell.js');

let pass = 0, fail = 0;
// ★ 参数序：ok(条件, 说明, 附注) ★
//   与 verify-share-route.mjs 一致（断言在前，人读的说明在后）。
//   ⚠️ 仓库里两种序都存在（_test_controls.js 是 ok(说明, 条件)）——
//      曾经因此把这个文件的 `ok` 写反，全部断言"通过"但打印的是 true/false，
//      等于**闸门失效**。改这个函数签名时务必连同所有调用点一起看。
const ok = (cond, name, extra) => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${extra ? '  → ' + extra : ''}`); }
};

const src = fs.readFileSync(VIEWER, 'utf8');
const shell = fs.readFileSync(SHELL, 'utf8');

/* ---------------------------------------------------------------------------
 * 工具：从 `WM.open(` 起截出配平的大括号块
 *
 * 为什么不正则在括号上硬啃：对象字面量里会有嵌套对象（icon/render/opts…），
 * 正则数不清层级。这里做朴素的花括号配平 —— 前提是**不跳过字符串里的花括号**。
 * 对本文件安全：块内没有带 `{` 的字符串字面量（注释里的 `{` 也只在注释中，
 * 注释里的花括号会破坏配平，所以下面先剥注释）。
 * ------------------------------------------------------------------------- */
function stripComments(s) {
  // 先剥块注释，再剥行注释（模板字符串里出现 `//` 的情况本文件没有）
  return s.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
          .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));
}

function braceBlock(text, fromIdx) {
  const start = text.indexOf('{', fromIdx);
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return { start, end: i, body: text.slice(start + 1, i), at: start };
    }
  }
  return null;
}

/** 找出所有 `WM.open(` 调用点的入参数组块 */
function findAllOpenBlocks(text) {
  const out = [];
  const re = /WM\.open\s*\(/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const blk = braceBlock(text, m.index + m[0].length);
    if (blk) out.push({ callAt: m.index, ...blk });
  }
  return out;
}

const clean = stripComments(src);
const blocks = findAllOpenBlocks(clean);

console.log('\n§0 解析器自检（0 命中 = 解析坏了，必须报错）');
ok(blocks.length === 6,
   `viewer.js 里解出 6 个 WM.open({...})（当前预览器个数：图/音视频/文本/kk/CAD/OnlyOffice）`,
   `实际 ${blocks.length}`);

const lineOf = (idx) => clean.slice(0, idx).split('\n').length;

console.log('\n§1 ★ 每个预览窗口都必须 chromeless（= 只有一套三键）★');
let noChrome = [];
blocks.forEach((b) => {
  const has = /(^|[\s,{])chromeless\s*:\s*true\s*[,}\n]/.test(b.body);
  if (!has) noChrome.push(`第 ${lineOf(b.callAt)} 行的 WM.open`);
});
ok(noChrome.length === 0,
   '6 个 WM.open 全都显式写了 `chromeless: true`（标题栏不渲染 ⇒ 不会和工具栏三键重复）',
   noChrome.join(' / '));
ok(blocks.length === 0 || !/chromeless\s*:\s*false/.test(clean),
   '没有任何 WM.open 把 chromeless 关掉（false 等于把两套按钮请回来）');

console.log('\n§2 ★ 用户报障的那一处（音视频）单独再钉一颗钉子 ★');
//   不满足于"6 个都合规"：把命中的那个块单独拎出来，
//   否则将来有人把 openMedia 改成 openAV、块数变了，这条也会悄悄失效。
const mediaBlock = blocks.find((b) => /kind === 'video'/.test(b.body) && /'play'/.test(b.body));
ok(!!mediaBlock, '定位到音视频预览（openMedia）的 WM.open 块',
   mediaBlock ? `第 ${lineOf(mediaBlock.callAt)} 行` : '没找到 —— 代码结构变了，请更新本测试');
if (mediaBlock) {
  ok(/chromeless\s*:\s*true/.test(mediaBlock.body),
     '音视频预览是 chromeless（用户看到的两层三键已消除）');
  ok(/minWidth\s*:/.test(mediaBlock.body) && /minHeight\s*:/.test(mediaBlock.body),
     '音视频预览带 minWidth/minHeight（无标题栏后仍能拖到合理大小）');
}

console.log('\n§3 两个渲染点确实由各自的开关控制（防"改一处漏一处"）');
//   ① 工具栏三键：controls === false 才不渲染
const toolbar = braceBlock(shell, shell.indexOf('function build(opts)'));
ok(!!toolbar, '定位到 Toolbar.build()');
if (toolbar) {
  ok(/controls\s*===\s*false/.test(toolbar.body) && /data-act="min"/.test(toolbar.body),
     'Toolbar.build：`controls !== false` 时渲染三键（data-act=min/max/close）');
}
//   ② 标题栏三键：chromeless 才不渲染
ok(/opts\.chromeless\s*\?\s*''/.test(shell),
   '标题栏：`opts.chromeless ? \'\' : <titlebar>` —— 传了 chromeless 就不渲染标题栏三键');
//   两个开关是独立的 —— 这正是当初漏一处的结构性原因，写进断言里当文档
const nTitlebar = (shell.match(/data-role="titlebar"/g) || []).length;
ok(nTitlebar >= 2,
   `shell.js 里有 ${nTitlebar} 处标题栏渲染点（build 与 open 各一）⇒ 只改一处仍会漏，故 §1 要求"全部"`);

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail ? 1 : 0);
