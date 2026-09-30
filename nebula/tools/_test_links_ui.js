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

/* ---------- §6 底部按钮顺序 ---------- */
console.log('\n§6 底部按钮顺序（2026-10-01 用户要求）');

// ⚠️⚠️ 参数序警告（本文件踩过一次，别重犯）⚠️⚠️
//   本文件的 ok 是 `ok(名称, 条件, 附加)` —— **名称在前、条件在后**。
//   本轮第一版照着 `.verify/verify-share-route.mjs` 的 `ok(条件, 名称)` 写，
//   结果 11 条断言全部"通过"，打印出来却是 `✅ true` / `✅ false`
//   —— 名称位被传了布尔、条件位被传了非空字符串（恒真）
//   ⇒ 闸门彻底失效，而且**看不出来**（全绿）。
//   这是记忆里记着的那个坑，一模一样地又发生了一次。
//   ⇒ 写完先看输出：出现 `✅ true` / `✅ false` 就是参数序反了。
{
  // 用户原话（两句要**一起**看，只看一句一定会改错）：
  //   ① 「这两个窗口 关闭按钮 改到右边」
  //   ② 「保存 都放在 最右侧」
  // 合起来是两条不变式：
  //   A. 「关闭」类按钮不能甩在最左，得落在**右侧那一组**里；
  //   B. 主操作（保存 / 创建链接）**压在最后**（= 最右）。
  // 只有"没有主按钮可压"的那个弹窗（分享弹窗在「已有分享」态），
  // 关闭才会落到最后。
  //
  // ⚠️ 判据必须落在**顺序**上（indexOf 谁在前），不能只查"两个按钮都在" ——
  //    后者在改动前后都是绿的，等于没守。
  const exFoot = (explorer.match(/dlg\.foot\.innerHTML = `([\s\S]*?)`;/) || [])[1] || '';
  ok('取到分享对话框的页脚模板', !!exFoot, exFoot.slice(0, 80));
  const iCreate = exFoot.indexOf('data-role="create"');
  const iClose = exFoot.indexOf('data-role="close"');
  const iManage = exFoot.indexOf('data-role="manage"');
  ok('分享对话框页脚里「管理我的链接…」「创建链接」「关闭」都在',
     iCreate >= 0 && iClose >= 0 && iManage >= 0);
  ok('★ 分享对话框：「关闭」压在最右（用户要求）★',
     iClose > iCreate && iClose > iManage,
     `manage@${iManage} create@${iCreate} close@${iClose}`);
  ok('「管理我的链接…」仍然靠最左（margin-right:auto），没被"关闭改到右边"带跑',
     /data-role="manage"[^>]*margin-right:auto/.test(exFoot));

  // ⚠️ links.js 里有**两个** `dlg.foot.innerHTML = ...`（二维码弹窗在前、
  //    编辑分享设置在后）。取“第一个”会拿到二维码那个 ⇒ 恒判红。
  //    必须按内容挑：要的是含 `data-role="save"` 的那一个。
  const lnFoots = [...links.matchAll(/dlg\.foot\.innerHTML = `([\s\S]*?)`;/g)]
    .map((m) => m[1]);
  const lnFoot = lnFoots.find((b) => b.includes('data-role="save"')) || '';
  ok('取到编辑分享设置对话框的页脚模板', !!lnFoot, lnFoot.slice(0, 80));
  const iSave = lnFoot.indexOf('data-role="save"');
  const iCancel = lnFoot.indexOf('data-role="cancel"');
  ok('编辑分享设置页脚里「保存」「取消」都在', iSave >= 0 && iCancel >= 0);
  ok('★ 编辑分享设置：「保存」压在最后（= 最右；用户第二句话）★',
     iSave > iCancel, `cancel@${iCancel} save@${iSave}`);
  ok('「取消」在右侧组里（没有被甩到最左）', iCancel > 0);

  // ---- 全局不变式：除分享弹窗外，每个多按钮页脚的**最后一个按钮**都是主操作 ----
  const allJs = ['web/js/app.js', 'web/js/explorer.js', 'web/js/links.js',
                 'web/js/shell.js', 'web/js/viewer.js']
    .filter((f) => fs.existsSync(path.join(ROOT, f)));
  let footBlocks = 0;
  const notPrimaryLast = [];
  for (const f of allJs) {
    const src = strip(read(f));
    const re = /(?:foot\.innerHTML\s*=\s*`|class="dlg-foot"[^>]*>)([\s\S]{0,900}?)`|class="dlg-foot"[^>]*>([\s\S]{0,600}?)<\/div>/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      const blk = m[1] || m[2] || '';
      const btns = [...blk.matchAll(/<button\b([^>]*)>/g)].map((x) => x[1]);
      if (btns.length < 2) continue;
      footBlocks++;
      const last = btns[btns.length - 1];
      if (!/\bprimary\b/.test(last)) {
        notPrimaryLast.push({ f, blk });
      }
    }
  }
  ok(`扫到 ${footBlocks} 处多按钮页脚（<6 处说明正则没匹上）`, footBlocks >= 6);
  // 分享弹窗是唯一例外（用户明确要求关闭最右）
  // ⚠️ 过滤必须拿**完整的 blk**去匹配——第一版存的是裁剪过的预览串，
  //    `data-role="create"` 被截成了 `reate"` ⇒ 例外永远匹不上，
  //    于是第一条恒红、第二条恒红 —— 两条都在说假话。
  const isShareDlg = (t) => /data-role="create"/.test(t.blk)
    && /data-role="close"/.test(t.blk);
  const real = notPrimaryLast.filter((t) => !isShareDlg(t));
  ok('★ 除分享弹窗外，所有弹窗页脚的最后一个按钮都是主操作（.btn primary）★',
     real.length === 0,
     real.map((t) => `${t.f}: …${t.blk.replace(/\s+/g, ' ').slice(-70)}`).join(' || '));
  ok('分享弹窗确实是那个例外（主按钮之后还有「关闭」）',
     notPrimaryLast.length === 1 && isShareDlg(notPrimaryLast[0]),
     `共 ${notPrimaryLast.length} 条未命中主操作尾部`);
}

console.log('\n════════════════════════════════');
console.log(`  通过 ${pass} / ${pass + fail}`);
if (fail) { console.log(`  ❌ 失败 ${fail} 项`); process.exit(1); }
console.log('  ✅ 全部通过');
