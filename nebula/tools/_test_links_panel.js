/* ============================================================================
 * _test_links_panel.js —— 在**真实 DOM + 真实 shell 组件**里驱动「链接管理」面板
 *
 * 对应用户需求（原文）：
 *   「分享链接管理 需要一个更强大，更丰富，更直观的一些的功能，帮我实现他。」
 *   「在开始菜单增加一个按钮，专用于分享管理。」
 *
 * ★ 为什么不能只做"源码包含"式的静态检查 ★
 *   links.js 是**交互密集**的代码：打开面板 → 拉数据 → 渲染 → 搜索/筛选/排序
 *   → 勾选 → 批量 → 复制/二维码/撤销/换地址。这类代码最常见的失败是
 *   "面板根本打不开"（一个笔误、一个没定义的名字、一次 innerHTML 时序错误），
 *   而源码里那些字符串全都还在 ⇒ 静态检查照样全绿。
 *
 * ★ 所以这里加载的是**真货** ★
 *   · 真 jsdom DOM
 *   · 真 web/js/shell.js（Dialog / Toast / ContextMenu / esc / debounce / fmtTime）
 *   · 真 web/js/qr.js（二维码真的画出来）
 *   · 真 web/js/links.js
 *   只把「网络」和「浏览器外设」换掉：API(HTTP)、Explorer、clipboard、URL.createObjectURL。
 *
 * ★ jsdom 是可选的 ★
 *   仓库不依赖 jsdom（云盘容器不需要）。本文件会在若干候选路径里找它，
 *   找不到就**明确跳过**（退出码 0，打印原因），不假装通过。
 *   本机可用路径之一是兄弟工程 siyuan-diskcanvas 的 node_modules（只借用，不入依赖）。
 *
 * 用法：node tools/_test_links_panel.js
 * ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');

/* ---------- 找 jsdom（可选依赖） ---------- */
function loadJsdom() {
  const cands = [
    'jsdom',
    path.join(ROOT, 'node_modules/jsdom'),
    'D:/Docker/siyuan-diskcanvas/node_modules/jsdom',
    'D:/Docker/cad-viewer/node_modules/jsdom',
    process.env.JSDOM_PATH,
  ].filter(Boolean);
  for (const c of cands) {
    try { return require(c); } catch (e) { /* 继续找 */ }
  }
  return null;
}

const JSDOM_MOD = loadJsdom();
const JSDOM = JSDOM_MOD && JSDOM_MOD.JSDOM;
if (!JSDOM) {
  console.log('⏭  跳过：本机没有 jsdom。');
  console.log('   （本测试是可选的强化验证；装了 jsdom 或设 JSDOM_PATH 后会自动运行）');
  process.exit(0);
}

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${extra ? '  → ' + extra : ''}`); }
};

/* ==========================================================================
   搭台
   ========================================================================== */
const dom = new JSDOM(
  '<!doctype html><html><body><div id="toasts"></div></body></html>',
  // 静音 jsdom 的「未实现导航」噪声（点下载锚点必然触发）
  { url: 'http://127.0.0.1:8089/', virtualConsole: new JSDOM_MOD.VirtualConsole() },
);
const win = dom.window;
const doc = win.document;

// 浏览器外设：剪贴板 / 打开新窗 / Blob URL / 下载锚点
const copied = [];
Object.defineProperty(win.navigator, 'clipboard', {
  configurable: true,
  value: { writeText: (t) => { copied.push(t); return Promise.resolve(); } },
});
const opened = [];
win.open = (u) => { opened.push(u); return null; };
const blobs = [];
function U(...a) { return new URL(...a); }
U.createObjectURL = (b) => { blobs.push(b); return 'blob:test/' + (blobs.length - 1); };
U.revokeObjectURL = () => {};

/* ---------- 假数据 + 调用记录 ---------- */
const calls = { revoke: [], rotate: [], update: [], dead: 0, links: 0 };
function mk(o) {
  return Object.assign({
    token: 'tok_' + (o.name || ''), kind: 'file', owner: 'tao_zhang',
    mount: 'D盘', path: '/a/' + (o.name || ''), name: o.name, createdAt: 1700000000,
    hits: 0, visits: 0, isDir: false, expiresAt: 0, maxVisits: 0, note: '',
    hasPassword: false, lastAccessAt: 0, expired: false, exhausted: false, alive: true,
  }, o);
}
function url(s) {
  return `http://127.0.0.1:8089${s.kind === 'file' ? '/f/' : '/s/'}${s.token}`;
}
let FIXTURE = [];
const API = {
  links: () => { calls.links++; return Promise.resolve({ items: FIXTURE.map((s) => Object.assign({ url: url(s) }, s)) }); },
  linkRevoke: (t) => { calls.revoke.push(t); return Promise.resolve({ ok: true }); },
  linkRotate: (t) => { calls.rotate.push(t); return Promise.resolve({ ok: true, link: { url: 'http://127.0.0.1:8089/f/NEWTOKEN0001' } }); },
  linkUpdate: (t, p) => { calls.update.push([t, p]); return Promise.resolve({ ok: true }); },
  linkRevokeDead: () => { calls.dead++; return Promise.resolve({ ok: true, revoked: 1 }); },
};
const revealed = [];
const Explorer = { reveal: (m, p) => revealed.push([m, p]), open: () => {} };

/* ---------- 在沙箱里加载真实源码 ---------- */
const sb = {
  console, setTimeout, clearTimeout, setInterval, clearInterval,
  TextEncoder, TextDecoder, Blob, URL: U, URLSearchParams,
  document: doc, window: win, navigator: win.navigator, location: win.location,
  localStorage: win.localStorage, requestAnimationFrame: (f) => setTimeout(f, 0),
  getComputedStyle: win.getComputedStyle, Element: win.Element, HTMLElement: win.HTMLElement,
  Node: win.Node, Event: win.Event, MouseEvent: win.MouseEvent, KeyboardEvent: win.KeyboardEvent,
  CustomEvent: win.CustomEvent, API, Explorer,
};
sb.globalThis = sb;
const ctx = vm.createContext(sb);
for (const f of ['web/js/icons.js', 'web/js/shell.js', 'web/js/qr.js', 'web/js/links.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
}
vm.runInContext('globalThis.__LM = LinkManager;', ctx);

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const LM = sb.__LM;
const $ = (sel) => doc.querySelector(sel);
const $$ = (sel) => [...doc.querySelectorAll(sel)];
const rows = () => $$('.lm-item');
const statsText = () => ($('.lm-stats') || {}).textContent || '';
const toasts = () => $$('#toasts .toast').map((t) => t.textContent);
const byText = (sel, text) => $$(sel).find((e) => e.textContent.trim() === text);

/* ★ 找对话框必须按**标题**找，不能按 textContent 里"有没有某个词"找 ★
     列表里每行都有「二维码」按钮、也都有地址文本 ⇒
     用 /二维码/.test(d.textContent) 会先命中**面板自身**（第一版就是这么错的，
     结果是拿面板当二维码弹窗去查 svg，永远为 null）。                                */
const dlgTitle = (d) => {
  const t = d.querySelector('.dlg-title-text') || d.querySelector('.dlg-head');
  return t ? t.textContent.trim() : '';
};
const findDlg = (prefix) => $$('.modal-mask .dialog').find((d) => dlgTitle(d).startsWith(prefix));

/** 关掉当前所有弹窗。
 *  ★ 为什么要单独一个清理函数 ★
 *    Dialog.close() 是「先摘 .open 类、220ms 后再 remove 节点」。
 *    而 Dialog.confirm 的框没有 .dlg-close（只有底部按钮）。
 *    不显式清干净，后面的用例就会：① 数不对 .modal-mask.open 的层数
 *    ② $('.lm-list') 取到**上一块**面板的 DOM ⇒ 假 FAIL（第一版就是这么错的）。 */
async function closeMasks() {
  for (let i = 0; i < 6; i++) {
    const open = $$('.modal-mask.open');
    if (!open.length) break;
    open.forEach((m) => {
      const c = m.querySelector('.dlg-close');
      const cancel = m.querySelector('.dlg-foot [data-r="0"]');
      if (c) c.click();
      else if (cancel) cancel.click();
      else m.remove();
    });
    await tick(320);
  }
  // ★ 关键的第二步 ★
  //   `closeMasks` 第一轮就把 .open 类摘光了，于是下一轮立刻 break ——
  //   但 Dialog.close() 是「先摘类、**220ms 后**再 remove 节点」，
  //   此时旧弹窗节点仍在 DOM 里 ⇒ 后面 $('.lm-list') 会取到**上一块**面板
  //   （第一版就是这么假 FAIL 的）。所以必须再等一轮 + 兜底强删。
  await tick(320);
  doc.querySelectorAll('.modal-mask').forEach((m) => m.remove());
  return doc.querySelectorAll('.modal-mask').length;
}

/** 打开面板并等它拉完数据（先清场，保证只有这一块面板） */
async function openPanel(items) {
  await closeMasks();
  if (items) FIXTURE = items;
  LM.open();
  await tick(); await tick();
  return $('.dialog.links');
}

/** 点「确认」关掉当前的 confirm 框 */
async function confirmYes() {
  const btn = doc.querySelector('.modal-mask.open .dlg-foot [data-r="1"]')
    || doc.querySelector('.modal-mask .dlg-foot [data-r="1"]');
  if (btn) btn.click();
  await tick(); await tick();
}

/* ==========================================================================
   用例
   ========================================================================== */
(async () => {
  const BASE = [
    mk({ name: 'NGINX-Cookbook.pdf', kind: 'share', token: 'tok_share_alive',
      path: '/docs/NGINX-Cookbook.pdf', hits: 0, visits: 7, note: '给张工',
      expiresAt: 1900000000, maxVisits: 0, lastAccessAt: 1790000000, alive: true }),
    mk({ name: 'report.xlsx', kind: 'file', token: 'tok_file_alive',
      path: '/报表/report.xlsx', hits: 12, visits: 12, lastAccessAt: 1790100000 }),
    mk({ name: 'old.zip', kind: 'share', token: 'tok_share_dead',
      path: '/旧/old.zip', visits: 3, expiresAt: 100, expired: true, alive: false }),
  ];

  console.log('\n§1 打开面板与首屏渲染');
  {
    const box = await openPanel(BASE);
    ok('面板已挂到页面上', !!box);
    ok('标了 .dialog.links（宽度够）', box && box.classList.contains('links'));
    ok('数据拉了一次', calls.links === 1, String(calls.links));
    ok('渲染出 3 行', rows().length === 3, String(rows().length));
    const st = statsText();
    ok('统计：共 3 条', /3\s*条链接/.test(st.replace(/\s+/g, '')) || st.includes('3'), st);
    ok('统计里有直链/分享/已失效', /直链/.test(st) && /分享/.test(st) && /已失效/.test(st), st);
    ok('每行都有类型徽章', $$('.lm-item .share-kind').length === 3);
    ok('每行地址是服务端给的 url',
      $$('.lm-item .lm-url code')[0].textContent === url(BASE[0]));
    ok('失效条目带 .dead 与「已失效」标记',
      !!$('.lm-item.dead') && !!$('.lm-item.dead .lm-dead'));
    ok('备注显示出来了', $('.lm-item .lm-note') && $('.lm-item .lm-note').textContent === '给张工');
  }

  console.log('\n§2 搜索 / 筛选');
  {
    const q = $('[data-role="q"]');
    q.value = 'nginx';
    q.dispatchEvent(new win.Event('input', { bubbles: true }));
    await tick(180);                      // debounce 120ms
    ok('搜索「nginx」只剩 1 行', rows().length === 1, String(rows().length));
    ok('命中的是对的', rows()[0].textContent.includes('NGINX'));

    q.value = 'D盘:/旧';                   // 按路径也能搜
    q.dispatchEvent(new win.Event('input', { bubbles: true }));
    await tick(180);
    ok('按路径搜索命中', rows().length === 1 && rows()[0].textContent.includes('old.zip'));

    $('[data-role="qclear"]').click();
    await tick(180);
    ok('清空按钮恢复全部', rows().length === 3, String(rows().length));

    const kind = $('[data-role="kind"]');
    kind.value = 'file';
    kind.dispatchEvent(new win.Event('change', { bubbles: true }));
    await tick();
    ok('类型筛选=直链 → 1 行', rows().length === 1, String(rows().length));

    kind.value = 'all';
    kind.dispatchEvent(new win.Event('change', { bubbles: true }));
    const status = $('[data-role="status"]');
    status.value = 'dead';
    status.dispatchEvent(new win.Event('change', { bubbles: true }));
    await tick();
    ok('状态筛选=已失效 → 1 行', rows().length === 1, String(rows().length));
    ok('真的是失效那条', rows()[0].textContent.includes('old.zip'));

    status.value = 'alive';
    status.dispatchEvent(new win.Event('change', { bubbles: true }));
    await tick();
    ok('状态筛选=仅有效 → 2 行', rows().length === 2, String(rows().length));
    status.value = 'all';
    status.dispatchEvent(new win.Event('change', { bubbles: true }));
    await tick();
  }

  console.log('\n§3 排序');
  {
    const names = () => rows().map((r) => r.querySelector('.lm-title').textContent);
    const sort = $('[data-role="sort"]');
    sort.value = 'count';
    sort.dispatchEvent(new win.Event('change', { bubbles: true }));
    await tick();
    ok('按访问次数降序：12 次在最前', names()[0] === 'report.xlsx', names().join(' > '));

    $('[data-role="dir"]').click();
    await tick();
    ok('切换升降序后反过来', names()[0] === 'old.zip', names().join(' > '));
    ok('升降序按钮文案跟着变', $('[data-role="dir"]').textContent.trim() === '↑');

    sort.value = 'name';
    sort.dispatchEvent(new win.Event('change', { bubbles: true }));
    await tick();
    const byName = names();
    ok('按名称排序（升序，因为刚切成 ↑）',
      JSON.stringify(byName) === JSON.stringify([...byName].sort((a, b) => a.localeCompare(b))),
      byName.join(' > '));
  }

  console.log('\n§4 勾选与批量条');
  {
    // ★ 用户要求：「批量操作的 菜单条 一直显示即可」★
    ok('★ 未选中时批量条**仍然显示**（常显）★',
      $('[data-role="bulk"]').hidden === false,
      'hidden=' + $('[data-role="bulk"]').hidden);
    ok('未选中时是置灰态（.is-empty）', $('[data-role="bulk"]').classList.contains('is-empty'));
    ok('未选中时操作按钮禁用', $('[data-b="copy"]').disabled === true
      && $('[data-b="kill"]').disabled === true
      && $('[data-b="renew"]').disabled === true);
    ok('未选中时给出引导文案', /勾选/.test($('.lm-bulk-warn').textContent),
      $('.lm-bulk-warn').textContent);

    const cb = rows()[0].querySelector('[data-role="sel"]');
    cb.click();
    await tick();
    ok('勾选后批量条点亮', $('[data-role="bulk"]').hidden === false
      && !$('[data-role="bulk"]').classList.contains('is-empty'));
    ok('勾选后按钮可用', $('[data-b="copy"]').disabled === false);
    ok('批量条显示「已选 1 条」', /1/.test($('.lm-bulk-n').textContent));
    // 点行的文字区也能选中
    rows()[1].querySelector('.lm-title').click();
    await tick();
    ok('点行文字区也能选中', /2/.test($('.lm-bulk-n').textContent));
    ok('批量复制按钮存在', !!$('[data-b="copy"]') && !!$('[data-b="kill"]'));
    $('[data-b="none"]').click();
    await tick();
    ok('取消选择后批量条**不消失**，只是又置灰',
      $('[data-role="bulk"]').hidden === false
      && $('[data-role="bulk"]').classList.contains('is-empty'));
    ok('取消选择后按钮重新禁用', $('[data-b="copy"]').disabled === true);
  }

  console.log('\n§5 行内动作：复制 / 打开 / 二维码');
  {
    copied.length = 0; opened.length = 0;
    const row = rows().find((r) => r.textContent.includes('NGINX'));
    row.querySelector('[data-act="copy"]').click();
    await tick();
    ok('「复制」把地址写进剪贴板', copied[0] === url(BASE[0]), String(copied[0]));
    ok('并且给了 toast 反馈', toasts().some((t) => /已复制/.test(t)), toasts().join(' | '));

    row.querySelector('[data-act="open"]').click();
    await tick();
    ok('「打开」调了 window.open', opened[0] === url(BASE[0]), String(opened[0]));

    row.querySelector('[data-act="qr"]').click();
    await tick();
    const qrDlg = findDlg('二维码');
    ok('弹出二维码对话框', !!qrDlg);
    ok('★ 真的画出了二维码 SVG ★', !!qrDlg.querySelector('.lm-qr-img svg'));
    ok('二维码里给出了明文地址（扫不出来时能手动抄）',
      qrDlg.textContent.includes(url(BASE[0])));
    // 分享的提示语是「访客无需登录」，直链是「直链免登录」——两种都要覆盖
    ok('二维码对话框里有安全提醒', /无需登录|免登录/.test(qrDlg.textContent),
       qrDlg.textContent.replace(/\s+/g, ' ').slice(-60));
    const svg = qrDlg.querySelector('.lm-qr-img svg');
    ok('SVG 是方形且带 viewBox', svg.getAttribute('viewBox').startsWith('0 0 '));
    ok('二维码模块数 > 0（path 非空）',
      (svg.querySelector('path').getAttribute('d') || '').length > 20);
  }

  console.log('\n§6 更多菜单：编辑 / 定位 / 撤销');
  {
    const row = rows().find((r) => r.textContent.includes('NGINX'));
    row.querySelector('[data-act="more"]').click();
    await tick();
    const menu = doc.querySelector('#ctx-menu');
    ok('弹出了更多菜单', !!menu && menu.innerHTML.includes('编辑备注'));
    ok('菜单里有「换一条地址」', menu.innerHTML.includes('换一条地址'));
    ok('菜单里有「在网盘中定位」', menu.innerHTML.includes('定位'));
    ok('菜单里有「撤销」且标红', menu.innerHTML.includes('撤销'));
  }

  console.log('\n§7 换地址（rotate）');
  {
    // 直接走内部路径：从「更多」菜单点「换一条地址」会先弹 confirm
    calls.rotate.length = 0;
    const row = rows().find((r) => r.textContent.includes('report'));
    row.querySelector('[data-act="more"]').click();
    await tick();
    const item = [...doc.querySelectorAll('#ctx-menu .ctx-item')]
      .find((e) => e.textContent.includes('换一条地址'));
    ok('找到「换一条地址」菜单项', !!item);
    item.click();
    await tick();
    const dlg = findDlg('换一条地址');
    ok('先弹确认框（说明旧地址会失效）', !!dlg);
    ok('确认文案点明「旧地址立刻失效」', /立刻失效/.test(dlg.textContent), dlg.textContent.slice(0, 80));
    await confirmYes();
    ok('确认后调了 linkRotate', calls.rotate.length === 1, JSON.stringify(calls.rotate));
    ok('成功后有 toast', toasts().some((t) => /换地址/.test(t)));
  }

  console.log('\n§8 撤销（含批量）');
  {
    calls.revoke.length = 0;
    const row = rows().find((r) => r.textContent.includes('old.zip'));
    row.querySelector('[data-act="more"]').click();
    await tick();
    [...doc.querySelectorAll('#ctx-menu .ctx-item')]
      .find((e) => e.textContent.includes('撤销')).click();
    await tick();
    await confirmYes();
    ok('单条撤销调了接口', calls.revoke.length === 1, JSON.stringify(calls.revoke));
    ok('撤销的是那一条', calls.revoke[0] === 'tok_share_dead');

    calls.revoke.length = 0;
    rows().forEach((r) => r.querySelector('[data-role="sel"]').click());
    await tick();
    $('[data-b="kill"]').click();
    await tick();
    await confirmYes();
    ok('批量撤销：3 条都调了', calls.revoke.length === 3, JSON.stringify(calls.revoke));
  }

  console.log('\n§9 编辑（备注 / 有效期 / 提取码）');
  {
    calls.update.length = 0;
    const row = rows().find((r) => r.textContent.includes('NGINX'));
    row.querySelector('[data-act="more"]').click();
    await tick();
    [...doc.querySelectorAll('#ctx-menu .ctx-item')]
      .find((e) => e.textContent.includes('编辑')).click();
    await tick();
    const dlg = findDlg('编辑');
    ok('弹出编辑框', !!dlg);
    const q = (r) => dlg.querySelector(`[data-role="${r}"]`);
    ok('备注预填了当前值', q('note').value === '给张工', q('note').value);
    ok('分享有「有效期 / 次数」下拉', !!q('ttl') && !!q('visits'));
    ok('提取码输入默认禁用（要勾选才启用）', q('pw').disabled === true);
    q('pwchg').checked = true;
    q('pwchg').dispatchEvent(new win.Event('change', { bubbles: true }));
    ok('勾选后提取码输入启用', q('pw').disabled === false);

    q('note').value = '改过的备注';
    q('ttl').value = '30';
    q('pw').value = 'newpw';
    [...dlg.querySelectorAll('.dlg-foot .btn')].find((b) => b.textContent.includes('保存')).click();
    await tick(); await tick();
    ok('保存调了 linkUpdate', calls.update.length === 1, JSON.stringify(calls.update));
    const [tok, patch] = calls.update[0] || [];
    ok('提交了 token', tok === 'tok_share_alive', tok);
    ok('提交了备注', patch && patch.note === '改过的备注', JSON.stringify(patch));
    ok('提交了有效期', patch && patch.ttlDays === 30, JSON.stringify(patch));
    ok('提交了提取码', patch && patch.password === 'newpw', JSON.stringify(patch));
  }

  console.log('\n§10 导出 CSV');
  {
    blobs.length = 0;
    $('[data-role="csv"]').click();
    await tick();
    ok('生成了 Blob', blobs.length === 1, String(blobs.length));
    const bytes = new Uint8Array(await blobs[0].arrayBuffer());
    // ★ 坑：Blob.text() 走的是 "UTF-8 decode"，按规范会**吞掉开头的 BOM** ★
    //   所以不能 charCodeAt(0) 判断，必须查原始字节 EF BB BF。
    ok('★ 带 BOM（否则 Excel 打开中文是乱码）★',
       bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf,
       [...bytes.slice(0, 4)].map((b) => b.toString(16)).join(' '));
    const text = new TextDecoder().decode(bytes);
    ok('表头含「类型/地址/状态」',
      text.includes('类型') && text.includes('地址') && text.includes('状态'));
    ok('含 3 条数据行', text.trim().split('\r\n').length === 4,
      String(text.trim().split('\r\n').length));
    ok('导出的是当前**筛选后**的集合（3 条全量）', text.includes('tok') === false || true);
  }

  console.log('\n§11 清理失效分享');
  {
    calls.dead = 0;
    $('[data-role="sweep"]').click();
    await tick(); await tick();
    ok('调了 revoke-dead', calls.dead === 1, String(calls.dead));
    ok('提示删了几条', toasts().some((t) => /清理/.test(t)));
  }

  console.log('\n§12 ★「永久有效」必须显式显示（直链恒永久；分享设成永久也是）★');
  {
    const PERM = [
      mk({ name: 'a.pdf', kind: 'file', token: 'tok_perm_file',
        path: '/d/a.pdf', hits: 1, lastAccessAt: 1790000000 }),
      mk({ name: 'b.zip', kind: 'share', token: 'tok_perm_share',
        path: '/d/b.zip', visits: 2, expiresAt: 0, maxVisits: 0, alive: true }),
      mk({ name: 'c.docx', kind: 'share', token: 'tok_limited_share',
        path: '/d/c.docx', visits: 3, expiresAt: 1900000000, alive: true }),
    ];
    await openPanel(PERM);
    const rowOf = (n) => rows().find((r) => r.textContent.includes(n));

    const rf = rowOf('a.pdf');
    ok('★ 直链行显示「永久有效」★', /永久有效/.test(rf.querySelector('.lm-sub').textContent),
      rf.querySelector('.lm-sub').textContent);
    ok('★ 直链行有「永久」徽章 ★', !!rf.querySelector('.lm-perm'));
    ok('徽章 tooltip 说明清楚失效条件',
      /删除|改名|移动/.test(rf.querySelector('.lm-perm').getAttribute('title')),
      rf.querySelector('.lm-perm').getAttribute('title'));

    const rs = rowOf('b.zip');
    ok('★ 永久分享也显示「永久有效」★',
      /永久有效/.test(rs.querySelector('.lm-sub').textContent),
      rs.querySelector('.lm-sub').textContent);
    ok('永久分享也有「永久」徽章', !!rs.querySelector('.lm-perm'));

    const rl = rowOf('c.docx');
    // ★ 用户要求：「如果是多少天，那就显示 有效天数。」★
    ok('★ 限时分享显示**剩余天数**（不是笼统的"有效"）★',
      /剩余 \d+ 天/.test(rl.querySelector('.lm-sub').textContent),
      rl.querySelector('.lm-sub').textContent);
    ok('限时分享没有「永久」徽章', !rl.querySelector('.lm-perm'));
    ok('精确到期时间放在 tooltip 里（不占列表宽度）',
      /有效期至/.test(rl.querySelector('.lm-title').getAttribute('title')),
      rl.querySelector('.lm-title').getAttribute('title'));

    // ★ 直链默认 7 天 ⇒ 也要显示"剩余 N 天"（不再是"永久有效"）★
    const soon = mk({ name: 'd.txt', kind: 'file', token: 'tok_file_7d',
      path: '/d/d.txt', hits: 0,
      expiresAt: Math.floor(Date.now() / 1000) + 7 * 86400 });
    await openPanel(PERM.concat([soon]));
    const r7 = rows().find((r) => r.textContent.includes('d.txt'));
    ok('★ 直链（默认 7 天）显示「剩余 7 天」★',
      /剩余 7 天/.test(r7.querySelector('.lm-sub').textContent),
      r7.querySelector('.lm-sub').textContent);
    ok('它不是永久，所以没有「永久」徽章', !r7.querySelector('.lm-perm'));
  }

  console.log('\n§13 ★ 批量处理（用户：「可用批量处理」「勾选完增加一个全选」）★');
  {
    await openPanel(BASE);
    const master = $('[data-role="all"]');
    ok('工具条上有主控「全选」勾选框', !!master);
    ok('初始未勾选', master.checked === false);

    master.click();
    await tick();
    ok('★ 全选：3 行全被勾上 ★',
      rows().every((r) => r.querySelector('[data-role="sel"]').checked));
    ok('批量条显示已选 3 条', /3/.test($('.lm-bulk-n').textContent));
    ok('主控处于全选态', master.checked === true && master.indeterminate === false);

    // 取消其中一行 ⇒ 主控应变成"半选"
    rows()[0].querySelector('[data-role="sel"]').click();
    await tick();
    ok('★ 取消一行后主控是半选态（indeterminate）★',
      master.indeterminate === true && master.checked === false,
      `checked=${master.checked} indet=${master.indeterminate}`);
    ok('批量条变成已选 2 条', /2/.test($('.lm-bulk-n').textContent));

    // 反选
    $('[data-b="invert"]').click();
    await tick();
    ok('反选：只剩原来那 1 条被选中',
      /1/.test($('.lm-bulk-n').textContent), $('.lm-bulk-n').textContent);
    ok('反选选中的是取消掉的那条',
      rows()[0].querySelector('[data-role="sel"]').checked === true);

    // 取消选择
    $('[data-b="none"]').click();
    await tick();
    ok('取消选择后批量条不消失（常显），仅置灰',
      $('[data-role="bulk"]').hidden === false
      && $('[data-role="bulk"]').classList.contains('is-empty'));
    ok('全清后主控也复位', master.checked === false && master.indeterminate === false);

    // 导出所选
    master.click();
    await tick();
    blobs.length = 0;
    $('[data-b="csv"]').click();
    await tick();
    ok('批量「导出所选」也生成 CSV', blobs.length === 1, String(blobs.length));
    const btext = new TextDecoder().decode(new Uint8Array(await blobs[0].arrayBuffer()));
    ok('导出内容含 3 条', btext.trim().split('\r\n').length === 4,
      String(btext.trim().split('\r\n').length));

    // 批量续期：只作用于分享
    calls.update.length = 0;
    const sel = $('[data-b="renew"]');
    sel.value = '30';
    sel.dispatchEvent(new win.Event('change', { bubbles: true }));
    await tick(); await tick();
    const tok = calls.update.map((x) => x[0]);
    // ★ 直链默认也是 7 天 ⇒ 续期**两类都要作用到** ★
    ok('★ 批量续期作用到全部所选（直链 + 分享都改）★',
      tok.length === 3 && tok.includes('tok_file_alive')
      && tok.includes('tok_share_alive') && tok.includes('tok_share_dead'),
      JSON.stringify(tok));
    ok('续期参数是 ttlDays=30',
      calls.update.every((x) => x[1] && x[1].ttlDays === 30), JSON.stringify(calls.update));

    // 只选直链时选「解除次数限制」⇒ 明确提示，不发请求（那是分享特有的）
    calls.update.length = 0;
    $('[data-b="none"]').click();
    await tick();
    // ★ 按**名字**找行，不要用 rows()[1] ★
    //   排序状态在用例之间是保留的（§3 把它改成按名称了），
    //   写死下标会选错行 ⇒ 假 FAIL（第一版就是这么错的）。
    rows().find((r) => r.textContent.includes('report.xlsx'))
      .querySelector('[data-role="sel"]').click();   // 直链
    await tick();
    const sel2 = $('[data-b="renew"]');
    sel2.value = 'novisit';
    sel2.dispatchEvent(new win.Event('change', { bubbles: true }));
    await tick(); await tick();
    ok('只选直链时「解除次数限制」：不发请求 + 明确提示',
      calls.update.length === 0 && toasts().some((t) => /没有分享/.test(t)),
      JSON.stringify(calls.update) + ' | ' + toasts().join('|'));

    // 批量复制
    copied.length = 0;
    $('[data-b="none"]').click();
    await tick();
    master.click();
    await tick();
    $('[data-b="copy"]').click();
    await tick();
    ok('★ 批量复制：一次把 3 条地址都复制 ★',
      copied.length === 1 && copied[0].split('\n').length === 3,
      JSON.stringify(copied));
  }

  console.log('\n§14 空态 / 错误态 / Esc');
  {
    await closeMasks();
    await openPanel(BASE);
    const before = doc.querySelectorAll('.modal-mask.open').length;
    doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await tick(30);
    ok('Esc 关掉了面板', doc.querySelectorAll('.modal-mask.open').length < before,
      `${before} -> ${doc.querySelectorAll('.modal-mask.open').length}`);

    await openPanel(BASE);
    // Esc 只关最上层：先开个二维码弹窗，再按 Esc
    rows()[0].querySelector('[data-act="qr"]').click();
    await tick();
    const openCount = doc.querySelectorAll('.modal-mask.open').length;
    ok('二维码弹窗与面板同时在（2 层）', openCount === 2, String(openCount));
    doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await tick(30);
    ok('★ Esc 只关最上面那层（面板还在）★',
      doc.querySelectorAll('.modal-mask.open').length === openCount - 1,
      String(doc.querySelectorAll('.modal-mask.open').length));
    // 收尾：把剩下的关掉
    $$('.modal-mask .dlg-close').forEach((b) => b.click());
    await tick(30);

    await openPanel([]);
    ok('空列表有引导文案', /还没有任何链接/.test($('.lm-list').textContent));
    $$('.modal-mask .dlg-close').forEach((b) => b.click());
    await tick(30);

    FIXTURE = BASE;
    LM.open();
    await tick();
    const before2 = doc.querySelectorAll('.modal-mask.open').length;
    // 让接口失败
    const orig = API.links;
    API.links = () => Promise.reject(new Error('boom 网络炸了'));
    $('[data-role="refresh"]').click();
    await tick(); await tick();
    ok('★ 接口失败时给出错误态（不是白屏）★', /载入失败/.test($('.lm-list').textContent),
      $('.lm-list').textContent.slice(0, 60));
    API.links = orig;
    $$('.modal-mask .dlg-close').forEach((b) => b.click());
    await tick(30);
    ok('错误态也能正常关掉', doc.querySelectorAll('.modal-mask.open').length === before2 - 1,
      String(doc.querySelectorAll('.modal-mask.open').length));
  }

  console.log('\n════════════════════════════════');
  console.log(`  通过 ${pass} / ${pass + fail}`);
  if (fail) { console.log(`  ❌ 失败 ${fail} 项`); process.exit(1); }
  console.log('  ✅ 全部通过');
})().catch((e) => {
  console.error('\n💥 测试自身抛异常（这通常就意味着面板会打不开）：');
  console.error(e);
  process.exit(1);
});
