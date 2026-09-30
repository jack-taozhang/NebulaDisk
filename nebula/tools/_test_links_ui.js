/* ============================================================================
 * _test_links_ui.js —— 「链接管理」面板的**源码形态护栏**
 *
 * 对应用户需求（原文）：
 *   「分享链接管理 需要一个更强大，更丰富，更直观的一些的功能，帮我实现他。」
 *   「在开始菜单增加一个按钮，专用于分享管理。」
 *
 * ★ 为什么这个文件值得存在 ★
 *   这类"面板 + 入口"的改动最容易在**接线处**出问题，而且出错了页面照常渲染：
 *     · 面板写好了，但右键菜单/开始菜单还指向旧函数 ⇒ 点了没反应
 *     · 开始菜单磁贴画出来了，但 onclick 分支没人处理 data-app ⇒ 点了没反应
 *     · qr.js 忘了引入 / 引入顺序不对 ⇒ 点「二维码」抛 QR is not defined
 *     · 前端自己拼 /f/ 或 /s/ 地址（违反 C-4「URL 一律服务端构造」）
 *     · ★ 用在线二维码接口 ★ —— 这条最严重：链接是免登录的能力型 URL，
 *       发给第三方 = 把用户的文件对外公开。必须有一条闸门挡住。
 *
 * 本测试只做**静态形态**检查（正则/源码包含）；真正的交互由
 * e2e / 人工在浏览器里确认。静态闸门挡不住"看着对但点不动"，
 * 但能挡住"根本没接线"和"安全红线"这两类。
 * ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
/** 去掉注释：否则注释里举的反例会把闸门骗绿 */
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const app = read('web/js/app.js');
const explorer = read('web/js/explorer.js');
const links = read('web/js/links.js');
const api = read('web/js/api.js');
const html = read('web/index.html');
const css = read('web/css/app.css');

const appBare = strip(app);
const exBare = strip(explorer);
const linkBare = strip(links);

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${extra ? '  → ' + extra : ''}`); }
};

/* ---------- §1 面板本身 ---------- */
console.log('\n§1 面板本体（web/js/links.js）');
{
  ok('导出全局 LinkManager 且提供 open()',
    /const LinkManager = \(\(\) => \{/.test(linkBare) && /return \{ open/.test(linkBare));

  // ★ URL 一律服务端构造（C-4）。前端只能拿 s.url，不许自己拼 token 路径。
  ok('只用服务端给的 url（不自己拼 /f/ 或 /s/）',
    !/['"`]\/[fs]\/['"`]\s*\+/.test(linkBare) && !/\$\{[^}]*\}\/[fs]\//.test(linkBare),
    '前端自拼地址 = 线上后端一改就全错');

  // 管理面必须走统一的 /api/links 一组
  ['/api/links', '/api/links/revoke', '/api/links/rotate',
    '/api/links/revoke-dead'].forEach((p) => {
    ok(`用了统一接口 ${p}`, api.includes(p) || linkBare.includes(p));
  });
  ok('改参数走 /api/links/update', api.includes('/api/links/update'));

  // 搜索 / 筛选 / 排序 / 批量 / 导出 / 二维码 —— 用户要的"更丰富"
  ok('有搜索框', /data-role="q"/.test(linkBare));
  ok('有类型筛选', /data-role="kind"/.test(linkBare));
  ok('有状态筛选', /data-role="status"/.test(linkBare));
  ok('有排序 + 升降序', /data-role="sort"/.test(linkBare) && /data-role="dir"/.test(linkBare));
  ok('有统计条', /lm-stats/.test(linkBare));
  // ---- 批量处理（用户：「可用批量处理」）----
  ok('★ 有主控「全选」（工具条上，恒可见）★', /data-role="all"/.test(linkBare));
  ok('全选口径是"当前筛选结果"且有半选态',
    /indeterminate/.test(linkBare) && /visibleItems\(\)\.forEach/.test(linkBare));
  ok('批量：复制地址', /data-b="copy"/.test(linkBare));
  ok('批量：导出所选', /data-b="csv"/.test(linkBare));
  ok('批量：续期 / 解除次数限制', /data-b="renew"/.test(linkBare) && /novisit/.test(linkBare));
  ok('批量：反选', /data-b="invert"/.test(linkBare));
  ok('批量：撤销', /data-b="kill"/.test(linkBare));
  ok('批量：取消选择', /data-b="none"/.test(linkBare));
  ok('选中态三处一起同步（主控 / 批量条 / 行）', /function syncSelection\(\)/.test(linkBare));
  // ---- 其它 ----
  ok('有导出 CSV', /text\/csv/.test(linkBare));
  ok('有二维码', /QR\.svg\(/.test(linkBare));
  ok('有换地址（rotate）', /API\.linkRotate\(/.test(linkBare));
  ok('有编辑参数', /showEdit/.test(linkBare) && /API\.linkUpdate\(/.test(linkBare));
  ok('有「在网盘中定位」', /Explorer\.reveal\(/.test(linkBare));
  ok('子弹窗也能 Esc 关闭（否则 Esc 卡在子框上）', /function escClose\(/.test(linkBare));

  // ★ 只重渲染列表容器（否则搜索框每次按键都被重建 ⇒ 焦点丢失）★
  ok('搜索输入只触发列表重渲染（不整块 innerHTML）',
    /qInput\.oninput = debounce\(/.test(linkBare)
    && !/function renderAll\(\)[\s\S]{0,120}dlg\.el\.innerHTML/.test(linkBare));
}

/* ---------- §2 安全红线：不许把链接交给第三方 ---------- */
console.log('\n§2 ★ 二维码必须本地画（不许用在线接口）★');
{
  // ★ 必须去注释再查 ★
  //   "不许用在线二维码接口"这条闸门最容易被自己的**注释**骗红/骗绿 ——
  //   qr.js 的文件头就写了"把 token 发给 api.qrserver.com 之类等于公开文件"
  //   这句反例。不去注释就会把说明当成引用（第一版就踩了）。
  const ALL = strip(read('web/js/qr.js')) + linkBare + html;
  const 外部 = [
    'api.qrserver.com', 'chart.googleapis.com', 'quickchart.io',
    'qrserver.com', 'goqr.me', 'zxing', 'qrenco.de',
  ].filter((d) => ALL.includes(d));
  ok('没有引用任何在线二维码服务', 外部.length === 0, 外部.join(', '));
  ok('二维码由本地 qr.js 生成（QR.svg）', /QR\.svg\(/.test(linkBare));
  ok('qr.js 自带（不依赖构建时下载）', fs.existsSync(path.join(ROOT, 'web/js/qr.js')));
  ok('二维码正确性有交叉验证脚本',
    fs.existsSync(path.join(ROOT, 'tools/qr_crosscheck.py'))
    && fs.existsSync(path.join(ROOT, 'tools/qr_dump.mjs')));
}

/* ---------- §3 引入顺序 ---------- */
console.log('\n§3 脚本引入（顺序错了就会 QR is not defined）');
{
  const iQr = html.indexOf('/static/js/qr.js');
  const iLinks = html.indexOf('/static/js/links.js');
  const iExp = html.indexOf('/static/js/explorer.js');
  ok('index.html 引入了 qr.js', iQr > -1);
  ok('index.html 引入了 links.js', iLinks > -1);
  ok('qr.js 排在 links.js 之前', iQr > -1 && iLinks > -1 && iQr < iLinks);
  ok('links.js 排在 explorer.js 之前（explorer 点击时才用，顺序仅为清晰）',
    iLinks > -1 && iExp > -1 && iLinks < iExp);
}

/* ---------- §4 入口接线 ---------- */
console.log('\n§4 入口接线（写好了但没接上 = 点了没反应）');
{
  ok('右键菜单「管理我的链接…」指向 LinkManager.open()',
    /管理我的链接…[\s\S]{0,80}LinkManager\.open\(\)/.test(exBare));
  ok('分享对话框里的「管理我的链接…」也指向 LinkManager.open()',
    /管理我的链接…[\s\S]{0,400}?LinkManager\.open\(\)/.test(exBare));
  ok('explorer.js 里已无遗留的 openLinkManager 定义/调用',
    !/openLinkManager/.test(exBare));
  // ★ 分享对话框里「直链」必须排在「分享链接」**上面**（用户要求换位）★
  ok('★ 分享对话框：直链在分享链接上面（已换位）★',
    exBare.indexOf('data-role="directwrap"') < exBare.indexOf('data-role="sharewrap"')
    && exBare.indexOf('data-role="directwrap"') > -1);

  ok('★ 开始菜单页脚有专门的「链接管理」图标按钮（#btn-links）★',
    /id="btn-links"/.test(html) && /title="链接管理/.test(html));
  ok('★ 它紧挨在「用户管理」左边 ★',
    html.indexOf('id="btn-links"') < html.indexOf('id="btn-users"')
    && html.indexOf('id="btn-links"') > 0,
    '用户要求：「链接管理图标按钮 放到用户管理 按钮边上。」');
  ok('按钮是 and 同款 icon-only 样式（.start-power）',
    /class="start-power" id="btn-links"/.test(html));
  ok('app.js 绑定了它的 click → LinkManager.open()',
    /btn-links[\s\S]{0,320}LinkManager\.open\(\)/.test(appBare));
  ok('链接管理对所有用户可见（不像用户管理那样按 isAdmin 隐藏）',
    !/btn-links[\s\S]{0,200}isAdmin/.test(appBare));
  ok('★ 磁贴区不再留重复入口 ★',
    /const START_APPS = \[\];/.test(appBare) && !/app:links/.test(appBare),
    '同一功能在开始菜单里出现两处 = 多余');
  ok('磁贴不再被误加内置应用样式（sa-builtin 已清）',
    !css.includes('sa-builtin'));
}

/* ---------- §5 样式 ---------- */
console.log('\n§5 样式');
{
  ok('面板加宽（.dialog.links）', /\.dialog\.links\s*\{/.test(css));
  ['lm-stats', 'lm-bar', 'lm-list', 'lm-item', 'lm-acts', 'lm-qr', 'lm-perm', 'lm-all']
    .forEach((c) => ok(`有 .${c} 样式`, css.includes('.' + c)));
}

console.log('\n════════════════════════════════');
console.log(`  通过 ${pass} / ${pass + fail}`);
if (fail) { console.log(`  ❌ 失败 ${fail} 项`); process.exit(1); }
console.log('  ✅ 全部通过');
