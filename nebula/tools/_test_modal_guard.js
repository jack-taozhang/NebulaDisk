/* ============================================================================
 * _test_modal_guard.js —— ★ 弹窗开着时，桌面级快捷键必须全部停摆 ★
 *
 * 对应 bug（用户报障原话）：
 *   「链接管理窗口打开时，其他窗口还是可以操作。服务器设置，关于窗口一样设置。」
 *
 * 真浏览器探针（.verify/probe-spa-fixes.mjs）给出的**实测**结论 ——
 * 注意这与"读代码猜"的差别：
 *   · 鼠标那半边**没问题**：`.modal-mask` 是 `position:fixed; inset:0;
 *     z-index:9600`，高于任务栏 9000 与窗口（100 起），点不到下面；
 *     点下层窗口也不会把它提到最前（zIndex 不变）。
 *   · 漏的是**键盘**：窗口管理器把快捷键挂在 `document` 上
 *     （app.js 的 bindHotkeys、explorer.js 的窗口级 onKey），
 *     它们不看"有没有弹窗"，于是弹窗开着按 F5/F2/Delete/Ctrl+A
 *     命令照样打在**后面那个资源管理器窗口**上。
 *     探针实测：按 F5 真的执行了下层窗口的 refresh。
 *
 * 本测试锁死的不变量（三条）：
 *   ① `Dialog` 必须对外暴露 `isOpen()`，且用**栈**记录层数；
 *   ② 所有**桌面级** `document` keydown 监听，要么先问 `Dialog.isOpen()`，
 *      要么在监听上方写一行 `modal-guard-ok：<理由>`（显式豁免，可审计）；
 *   ③ 遮罩必须真的挡住下层：`position:fixed; inset:0` 且 z-index 高于窗口；
 *      且比遮罩 z-index 更高的浮层（右键菜单 9800 / 开始菜单 9500 的视觉）
 *      必须在进模态时被收掉。
 *
 * 设计原则与其它测试一致：
 *   · 只从产品源码里抽（绝不复制逻辑进来）
 *   · §0 解析器自检：解出的监听数必须是已知值。0 命中 = 解析坏了 ⇒ 报错，
 *     绝不"0 通过 0 失败"地放行（那正是"文件没跑起来"的信号）。
 * ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const JS = path.join(ROOT, 'web/js');
const CSS = path.join(ROOT, 'web/css/app.css');

let pass = 0, fail = 0;
// ★ ok(条件, 说明, 附注) —— 断言在前（与 verify-share-route.mjs 一致）
const ok = (cond, name, extra) => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${extra ? '  → ' + extra : ''}`); }
};

/* ---------------------------------------------------------------------------
 * 源码解析小工具
 * ------------------------------------------------------------------------- */
function stripComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
          .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));
}

/* ---------------------------------------------------------------------------
 * 极简 CSS 规则解析：`选择器 { 声明 }`（只看最外层，够用）
 *   ★ 为什么不直接对整份 css 做 `/#ctx-menu\b[\s\S]{0,240}?z-index…/` ★
 *     这条测试的第一版就是这么写的，结果 z-index 全读成 0/1 —— 因为
 *     窗口大小是拍脑袋定的（`#ctx-menu` 的规则体有 350+ 字符，240 的窗口
 *     根本够不到 z-index）。**拍脑袋的阈值 = 假的绿**。
 *     改成"先定位到规则的声明块，再在块内找 z-index"，长度不再敏感。
 * ------------------------------------------------------------------------- */
function cssRules(text) {
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const sels = m[1].split(',').map((s) => s.trim()).filter(Boolean);
    out.push({ sels, body: m[2] });
  }
  return out;
}
/** 取"选择器精确等于 sel"的规则的 z-index（后者覆盖前者，与实际层叠一致） */
function zIndexOf(rules, sel) {
  let z = 0;
  for (const r of rules) if (r.sels.includes(sel)) {
    const m = /z-index\s*:\s*(-?\d+)/.exec(r.body);
    if (m) z = Number(m[1]);
  }
  return z;
}

function braceBlock(text, fromIdx) {
  const start = text.indexOf('{', fromIdx);
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') { depth--; if (depth === 0) return { start, end: i, body: text.slice(start + 1, i) }; }
  }
  return null;
}

/** 从 `(` 起按顶层逗号切参数（跳过字符串与嵌套括号）
 *  ★ 从开括号的**下一个字符**开始扫，depth===0 表示"在参数列表顶层" ★
 *    第一版从括号自身开始扫、depth 从 0 起 ⇒ 一进循环 depth 就变成 1，
 *    于是"顶层逗号"永远不成立、参数全挤成一个 —— `args[1]` 拿到的是
 *    一大段垃圾串（表现为 handlerExpr 打印出 "S" 这种鬼东西），
 *    后面所有 handler 都解析不出来 ⇒ 满屏假红。 */
function callArgs(text, openParen) {
  const args = [];
  let depth = 0, start = openParen + 1, inS = null;
  for (let i = openParen + 1; i < text.length; i++) {
    const c = text[i], p = text[i - 1];
    if (inS) { if (c === inS && p !== '\\') inS = null; continue; }
    if (c === '"' || c === "'" || c === '`') { inS = c; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) { args.push(text.slice(start, i)); return { args, end: i }; }
      depth--;
    } else if (c === ',' && depth === 0) { args.push(text.slice(start, i)); start = i + 1; }
  }
  return { args, end: -1 };
}

const lineOf = (text, idx) => text.slice(0, idx).split('\n').length;

/**
 * 找出一份源码里所有 `document.addEventListener('keydown', …)`，
 * 并把 handler 的**函数体**取出来（用于看它有没有问 Dialog.isOpen()）。
 *
 * ★ 必须同时拿 raw 与 stripped 两份 ★
 *   解析用 stripped（把注释换成等长空格，**索引与 raw 一一对应**，
 *   所以注释里的 `{` `}` 不会破坏配平）；
 *   但 `modal-guard-ok` 标记本身就是一条**注释** —— 只看 stripped 会
 *   永远找不到它（本测试第一版就这么错了：7 处监听全被判成未豁免）。
 */
function keydownHandlers(file) {
  const raw = fs.readFileSync(path.join(JS, file), 'utf8');
  const text = stripComments(raw);   // 注释换成等长空格 ⇒ 索引与 raw 一一对应
  const out = [];
  const re = /document\.addEventListener\(\s*['"]keydown['"]/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const openParen = text.indexOf('(', m.index + 'document.addEventListener'.length);
    const { args } = callArgs(text, openParen);
    const handlerExpr = (args[1] || '').trim();
    const capture = /true/.test(args[2] || '');

    let blk = null;
    if (/^[A-Za-z_$][\w$]*$/.test(handlerExpr)) {
      // 具名 handler：找它的声明（function h(…) 或 const h = …）
      const fm = new RegExp(`function\\s+${handlerExpr}\\s*\\(`).exec(text);
      if (fm) blk = braceBlock(text, fm.index + fm[0].length - 1);
      if (!blk) {
        const vm = new RegExp(`(?:const|let|var)\\s+${handlerExpr}\\s*=`).exec(text);
        blk = vm ? braceBlock(text, vm.index + vm[0].length) : null;
      }
    } else {
      const arrow = handlerExpr.indexOf('=>');
      const rel = braceBlock(handlerExpr, arrow >= 0 ? arrow : 0);
      // handlerExpr 是 text 的子串，把相对偏移换成绝对偏移
      if (rel) {
        const base = text.indexOf(handlerExpr, openParen);
        blk = { start: base + rel.start, end: base + rel.end, body: rel.body };
      }
    }
    const body = blk ? blk.body : '';

    // ★ 豁免标记允许写在三处（按从上到下的自然顺序）★
    //   ① handler 函数体里 ② 监听那一行 ③ 监听语句**上方 400 字符内**
    //   （最常见的是 ③：一整段"为什么不守卫"的说明）
    // ★ 必须读 raw，不能读 text ★
    //   标记本身是一条**注释**；text 里注释已被换成空格 ⇒ 永远找不到它。
    //   （本测试第一版就栽在这：7 处监听全被判成"未豁免"。）
    const lineStart = text.lastIndexOf('\n', m.index) + 1;
    const aboveFrom = Math.max(0, lineStart - 400);
    const marked =
      (blk ? /modal-guard-ok/.test(raw.slice(blk.start, blk.end)) : false)
      || /modal-guard-ok/.test(raw.slice(lineStart, text.indexOf('\n', m.index) + 1))
      || /modal-guard-ok/.test(raw.slice(aboveFrom, lineStart));

    out.push({
      file, line: lineOf(text, m.index), capture, marked,
      handlerExpr: handlerExpr.slice(0, 40), body,
    });
  }
  return out;
}

const FILES = ['app.js', 'explorer.js', 'shell.js', 'links.js'];
const all = FILES.flatMap(keydownHandlers);
const shellRaw = fs.readFileSync(path.join(JS, 'shell.js'), 'utf8');
const shell = stripComments(shellRaw);
const app = stripComments(fs.readFileSync(path.join(JS, 'app.js'), 'utf8'));
const explorer = stripComments(fs.readFileSync(path.join(JS, 'explorer.js'), 'utf8'));
const css = fs.readFileSync(CSS, 'utf8');

console.log('\n§0 解析器自检（0 命中 = 解析坏了，必须报错）');
// ★ 已知值在 2026-09-30 从 7 → 6 ★
//   链接管理面板从「模态弹窗」改成了 WM 桌面窗口，面板自己那个
//   capture 阶段的 Esc 收尾监听随之删除（桌面窗口不该被 Esc 关掉，
//   用户管理窗口也如此）。剩下 6 处仍在。
//   这是**产品有意变更**导致的计数变化，不是解析器坏了 ——
//   解析器自检的真正目的是「别在 0 命中时静默放行」，所以这里同时
//   检查「至少覆盖到每个文件」：
ok(all.length === 6,
   `4 个源码文件里解出 6 处 document keydown 监听（已知值）`, `实际 ${all.length}`);
const filesSeen = new Set(all.map((h) => h.file));
ok(filesSeen.size >= 3,
   `监听分布在 ${filesSeen.size} 个文件里（解析器覆盖到多文件，不是只读了一份）`,
   [...filesSeen].join(' '));
console.log('  · ' + all.map((h) => `${h.file}:${h.line}${h.capture ? '(capture)' : ''}`).join('  '));

console.log('\n§1 Dialog 提供了统一判据，且用「栈」而不是「计数器」');
const dialogStart = shell.indexOf('const Dialog = (() => {');
const dialogBlock = dialogStart >= 0 ? braceBlock(shell, dialogStart) : null;
ok(!!dialogBlock, '定位到 Dialog 模块');
const dlg = dialogBlock ? dialogBlock.body : '';
ok(/function\s+isOpen\s*\(/.test(dlg), 'Dialog 暴露 isOpen()');
ok(/return\s*\{[\s\S]*?\bisOpen\b/.test(dlg), 'isOpen 在 Dialog 的返回对象里导出（调用方能拿到）');
ok(/let\s+stack\s*=\s*\[\]/.test(dlg), '用 let stack = [] 记录层数（不是布尔/计数器）');
ok(/stack\.push\(mask\)/.test(dlg), 'markOpen 时入栈');
ok(/stack\.splice\(i,\s*1\)/.test(dlg), 'markClose 时出栈（按元素移除，重复调用安全）');
ok(/isConnected/.test(dlg),
   'isOpen 会剔除已脱离 DOM 的遮罩（自愈：有人绕过 close() 直接摘节点也不会让桌面永久停摆）');
ok(/documentElement\.dataset\.modal/.test(dlg),
   '把「有几层弹窗」写到 <html data-modal>（CSS 与真机探针都能一眼读到）');

console.log('\n§2 ★ 桌面级 keydown 监听必须问 isOpen（或显式豁免）★');
const unguarded = all.filter((h) => {
  if (h.marked) return false;                                // 显式豁免，理由写在源码里
  if (dialogBlock && h.body && dlg.includes(h.body)) return false; // Dialog 自己的监听
  return !/Dialog\.isOpen\(\)/.test(h.body);
});
// ★ 已知值在 2026-09-30 从 3 → 2 ★
//   链接管理面板转成 WM 桌面窗口后，它自己那条「弹窗内 Esc」豁免随之消失；
//   剩下 shell.js 的 ContextMenu 与 links.js 的 escClose（子对话框）。
//   ⚠️ 这是**低位阀**不是精确值：真正的护栏是下面 unguarded === 0，
//      它要求「没写豁免的必须问 Dialog.isOpen()」。阀值只在防呆：
//      免得所有监听都被随手打上豁免标记而绕开真正的检查。
ok(all.filter((h) => h.marked).length >= 2,
   `有 ${all.filter((h) => h.marked).length} 处显式豁免（每条都带 modal-guard-ok 理由，可审计）`,
   all.filter((h) => h.marked).map((h) => `${h.file}:${h.line}`).join(' '));
ok(unguarded.length === 0,
   '其余全部先问 Dialog.isOpen()（弹窗一开，桌面级快捷键一律不响应）',
   unguarded.map((h) => `${h.file}:${h.line} ${h.handlerExpr}`).join(' | '));

console.log('\n§3 守卫必须在「动手之前」——位置错等于没守卫');
const hotStart = app.indexOf('function bindHotkeys()');
const hot = hotStart >= 0 ? braceBlock(app, hotStart) : null;
ok(!!hot, '定位到 app.js bindHotkeys()');
if (hot) {
  const gi = hot.body.indexOf('Dialog.isOpen()');
  const act = hot.body.indexOf('toggleStart()');
  ok(gi >= 0 && (act < 0 || gi < act),
     'bindHotkeys：isOpen() 出现在任何动作（toggleStart 等）**之前**',
     `guard@${gi} firstAction@${act}`);
}
const ekStart = explorer.indexOf('function bindKeys(');
const ek = ekStart >= 0 ? braceBlock(explorer, ekStart) : null;
ok(!!ek, '定位到 explorer.js bindKeys()');
if (ek) {
  const gi = ek.body.indexOf('Dialog.isOpen()');
  const act = ek.body.indexOf('winIdOf(S)');
  ok(gi >= 0 && (act < 0 || gi < act),
     'explorer 窗口级 onKey：isOpen() 出现在取窗口状态**之前**',
     `guard@${gi} winIdOf@${act}`);
}

console.log('\n§4 遮罩本身真的挡得住（鼠标那半边）');
//   ★ 用规则解析而不是"对着整份 css 开个 N 字符的窗口找 z-index" ★
//     第一版就是后者，窗口 240 字符不够 `#ctx-menu` 的规则体（350+ 字符），
//     于是读成 0 ⇒ 断言莫名其妙地红。**拍脑袋的阈值 = 假的绿/假的红。**
//   ★ 必须先剥注释再解析规则 ★
//     否则选择器串会带上前面那段块注释，`'/* 对话框 … */\n.modal-mask'`
//     永远不会等于 `'.modal-mask'` ⇒ 命中恒为 0。
//     （第一版就是这样：`z-index` 全读成 0，断言凭空变红。）
const rules = cssRules(stripComments(css));
const zOf = (sel) => zIndexOf(rules, sel);
const maskBody = (() => {
  let b = '';
  for (const r of rules) if (r.sels.includes('.modal-mask')) b += r.body + ';';
  return b;
})();
ok(!!maskBody, 'app.css 里有 .modal-mask 规则');
ok(/position\s*:\s*fixed/.test(maskBody), '.modal-mask 是 position:fixed');
ok(/inset\s*:\s*0/.test(maskBody), '.modal-mask 铺满视口（inset:0）');
const zMask = zOf('.modal-mask');
ok(zMask > 9000, `遮罩 z-index=${zMask} 高于任务栏(9000)与窗口(100+)`, `z=${zMask}`);
// 比遮罩更高的浮层：必须被 markOpen 收掉，否则会浮在模态之上且可点
const zCtx = zOf('#ctx-menu');
const zCtxOpen = zOf('#ctx-menu.open');
const zStart = zOf('#start-menu');
ok(Math.max(zCtx, zCtxOpen) > zMask,
   `右键菜单 z-index=${Math.max(zCtx, zCtxOpen)} > 遮罩 ${zMask} ⇒ 确实需要主动收掉（这才是当初的穿帮点）`);
ok(/ContextMenu\.close\(\)/.test(dlg), 'markOpen 里收掉右键菜单（它比遮罩高，会浮在模态之上）');
ok(/closeStart\(\)/.test(dlg), 'markOpen 里收掉开始菜单');
ok(zStart > 0, `开始菜单 z-index=${zStart}（记录当前值；同样主动收掉，不依赖它比遮罩低）`);

console.log('\n§5 Esc 的收敛：只关最上面那一层');
ok(/function\s+onModalKey/.test(dlg), '有统一的模态按键处理 onModalKey');
ok(/e\.key\s*===\s*'Escape'/.test(dlg) && /__onEsc/.test(dlg),
   'Esc 只交给**栈顶**那个弹窗自己的 __onEsc（关子层不误伤父层）');
ok(/e\.key\s*!==\s*'Tab'/.test(dlg) && /preventDefault\(\)/.test(dlg),
   'Tab 做焦点陷阱（否则按两下 Tab 焦点就跑到弹窗外面了）');
ok(/mask\.setAttribute\('aria-modal',\s*'true'\)/.test(dlg) || /setAttribute\("aria-modal"/.test(dlg),
   '遮罩标 aria-modal="true"');
ok(/'keydown',\s*onModalKey,\s*true|"keydown",\s*onModalKey,\s*true/.test(dlg),
   'onModalKey 注册在**捕获阶段**（先于业务监听接手，Esc 不会被别人吞掉）');

/* ==========================================================================
   §6 ★ 三个「面板型」界面必须是**桌面窗口**，不许退回模态弹窗 ★

   用户需求（原话，2026-09-30 第 6/7 条）：
     「链接管理窗口打开时，其他窗口要求是可以操作。改为和用户管理窗口一下。」
     「目前服务器窗口，关于窗口 窗口界面打开，点击其他地方，这个窗口会关闭。
       改为和用户管理窗口一下。」

   基准是**用户管理窗口**（`app.js` 的 `showUserAdmin`）——
   它走 `WM.open({ chromeless:true })`：非模态 / 可拖动 / 可最小化 /
   点别处不关。这三个面板历史上都是 `Dialog.custom`（一层 .modal-mask），
   于是「开着它就不能操作别的窗口」+「点遮罩就关」。

   ★ 为什么要把这条写成测试 ★
     退回模态弹窗是**看起来更省事**的改法（不用自己搭工具栏、不用管高度
     撑满），很容易在某次"顺手重写"里被改回去，而且改回去之后
     单元测试、静态检查、其它 8 套 JS 全都不会报错 —— 只有用户会发现。
     所以这条契约必须钉住。
   ========================================================================== */
console.log('\n§6 ★ 面板型界面必须是 WM 桌面窗口（非模态），不许退回 Dialog ★');

const linksRaw = fs.readFileSync(path.join(JS, 'links.js'), 'utf8');
const links = stripComments(linksRaw);
const appRaw = fs.readFileSync(path.join(JS, 'app.js'), 'utf8');

/** 取一个函数体的源码（strip 过注释，便于做形态断言） */
function fnBody(src, decl) {
  const i = src.indexOf(decl);
  if (i < 0) return null;
  const from = src.indexOf('{', i);
  return from < 0 ? null : braceBlock(src, from).body;
}

const panels = [
  {
    name: '链接管理',
    body: fnBody(links, 'function open() {'),
    raw: linksRaw,
    mustNotUse: /Dialog\.custom\(\s*\{\s*title:\s*'链接管理'/,
  },
  {
    name: '服务器设置',
    body: fnBody(app, 'function showServerSettings() {'),
    raw: appRaw,
    mustNotUse: /Dialog\.custom\(\s*\{\s*title:\s*'服务器设置'/,
  },
  {
    name: '关于',
    body: fnBody(app, 'function showAbout() {'),
    raw: appRaw,
    mustNotUse: /Dialog\.custom\(\s*\{\s*title:\s*'关于/,
  },
];

// 基准：用户管理窗口确实是 WM 窗口（这条要先成立，后面三个才"和它一样"）
const base = fnBody(app, 'function showUserAdmin() {');
ok(!!base && /WM\.open\(/.test(base) && /chromeless:\s*true/.test(base),
   '基准：用户管理窗口走 WM.open + chromeless（后面三个要对齐它）');

for (const p of panels) {
  ok(!!p.body, `定位到 ${p.name} 的实现`);
  if (!p.body) continue;

  ok(/WM\.open\(/.test(p.body),
     `${p.name} 用 WM.open 建桌面窗口`);
  ok(/chromeless:\s*true/.test(p.body),
     `${p.name} 传 chromeless:true（否则会渲染出**两层**窗口按钮 —— 见 _test_window_controls.js）`);
  ok(!p.mustNotUse.test(p.body),
     `${p.name} 不再用 Dialog.custom 构造（模态遮罩会挡住其它窗口）`);
  // ★ 只看「面板自己的那段代码」★
  //   面板内部还会弹出**小型表单对话框**（例：服务器设置 → 新建/编辑目录映射），
  //   那些是真正的瞬时对话框，继续用 Dialog + dlg.foot 是**对的**
  //   （用户说的是"面板要像窗口"，不是"所有弹窗都取消"）。
  //   所以把体按第一个嵌套 `Dialog.custom(` 切开，只检查它之前的部分。
  const ownPart = p.body.split('Dialog.custom(')[0];
  ok(!/dlg\.foot/.test(ownPart),
     `${p.name} 自己的代码不再用 dlg.foot（模态弹窗页脚；桌面窗口的动作应上提到工具栏）`);
  ok(/WM\.Toolbar\.build\(/.test(p.body),
     `${p.name} 用 WM.Toolbar.build 建工具栏（顺带拿到窗口三键与 data-drag-handle）`);
  ok(/if\s*\(WM\.get\(WID\)\)\s*\{[^}]*WM\.(restore|focus)/.test(p.body),
     `${p.name} 重复打开时**聚焦已有窗口**而不是叠第二扇（与用户管理窗口一致）`);
}

// 非模态的判据：开关它们不能再动模态栈
ok(!/Dialog\.markOpen/.test(links + app),
   '链接管理 / 服务器设置 / 关于 都不入模态栈 ⇒ 开着它们时其它窗口仍可操作');

// 高度撑满：弹窗时代的写死尺寸必须被窗口上下文覆盖
const cssNoComment = css.replace(/\/\*[\s\S]*?\*\//g, '');
ok(/\.win-col\s*>\s*\.settings-wrap\s*\{[^}]*height:\s*auto/.test(cssNoComment),
   'CSS：.win-col > .settings-wrap 把弹窗时代的 height:560px 改回撑满');
ok(/\.win-col\s*>\s*\.lm\s*\{[^}]*flex:\s*1/.test(cssNoComment),
   'CSS：.win-col > .lm 让链接管理面板占满窗口高度');
ok(/\.win-col\s*>\s*\.lm\s*>\s*\.lm-list\s*\{[^}]*max-height:\s*none/.test(cssNoComment),
   'CSS：窗口里的 .lm-list 解除 max-height（否则列表长到一半就停，下面留一大片空白）');

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail ? 1 : 0);
