/* ============================================================================
 * _test_kind_filter.js —— ★ 翻页只能在同一类型内进行 ★
 *
 * 对应用户报的问题（原文）：
 *   「照片预览 上面的总数目前是所有文件的总数，但是切换时 到别的类型文件时，
 *     提示无法显示这张照片。而不是调用其他程序打开该文件。」
 *
 * 根因：翻页列表原来只是「所有可预览文件」（只排除文件夹和隐藏文件），
 *      所以看照片时按「下一个」会走进 .csv / .py，交给 <img> 就是
 *      「无法显示这张照片」。
 *
 * 修法：kindOf(entry) 给每个文件算预览类型，翻页列表只保留**同 kind**。
 *
 * 本测试从产品源码抽取 kindOf / siblingsOfKind / previewableList / nativeKind /
 * guessExt，验证：
 *   §0 源码形态：makeCtx / refreshContext / step 三处都接了 kind
 *   §1 分类正确性（图片/视频/音频/文本/CAD/Office/KK/无预览器）
 *   §2 siblingsOfKind 只留同类
 *   §3 ★ 目录里图片夹在其它类型之间时，图片的 m 只数图片 ★（就是用户报的场景）
 *   §4 无内置预览器的文件不参与翻页
 *   §5 文件夹/隐藏文件仍被排除
 *   §6 路由优先级与 open() 一致（cad 优先于 office，原生优先于 kkfileview）
 * ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const VIEWER = path.resolve(__dirname, '../web/js/viewer.js');
const src = fs.readFileSync(VIEWER, 'utf8');

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
  if (i < 0) throw new Error(`源码里找不到 ${name}()，viewer.js 可能被重构过`);
  let d = 0, started = false;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') { d++; started = true; }
    else if (src[j] === '}') { d--; if (started && d === 0) return src.slice(i, j + 1); }
  }
  throw new Error(`${name}() 花括号不配对`);
}

/* ---------- §0 源码形态 ---------- */
console.log('\n§0 源码形态：三处都必须接住 kind（防回归第一道闸）');
{
  ok('kindOf() 存在', /function kindOf\(/.test(src));
  ok('siblingsOfKind() 存在', /function siblingsOfKind\(/.test(src));
  ok('makeCtx 用 kindOf 算 kind 并按 kind 过滤',
     /const kind = kindOf\(me, path\)/.test(bare) && /siblingsOfKind\(all, kind\)/.test(bare),
     'makeCtx 没做同类过滤 → 翻页会跨类型');
  ok('refreshContext 继续按 kind 过滤（不许退回宽列表）',
     /siblingsOfKind\(entries, c\.kind\)/.test(bare),
     'refreshContext 没按 kind 过滤 → 目录一刷新就跨类型');
  ok('★ step() 有跨类型防线（最后一道保险）',
     /kindOf\(e\)\s*!==\s*c\.kind/.test(bare),
     'step 没有跨类型防线');
  ok('ctx 对象带 kind 字段',
     /kind:\s*c\.kind != null \? c\.kind : null/.test(bare) && /currentName: name, kind/.test(bare));
  ok('kindOf 已导出（供测试/调试）', /kindOf,/.test(bare));
}

/* ---------- 抽取实现 ---------- */
const names = ['guessExt', 'nativeKind', 'previewableList', 'kindOf', 'siblingsOfKind'];
const sandbox = { console };
vm.createContext(sandbox);
vm.runInContext(
  names.map(extractFn).join('\n') + '\n;' +
  names.map((n) => `this.${n} = ${n};`).join('\n'),
  sandbox,
);
const { kindOf, siblingsOfKind, previewableList } = sandbox;

/* ---------- 造数据 ---------- */
const f = (name, extra) => Object.assign(
  { name, ext: name.split('.').pop(), isDir: false }, extra || {});
const d = (name) => ({ name, isDir: true });

/* ---------- §1 分类正确性 ---------- */
console.log('\n§1 kindOf 分类');
{
  const cases = [
    ['高一1班.jpeg', 'image'],
    ['照片.PNG', 'image'],
    ['扫描.svg', 'image'],
    ['片子.mp4', 'video'],
    ['歌.mp3', 'audio'],
    ['说明.txt', 'text'],
    ['脚本.py', 'text'],
    ['配置.json', 'text'],
    ['清单.csv', 'text'],
    ['readme.md', 'text'],
  ];
  cases.forEach(([n, want]) => {
    const got = kindOf(f(n));
    ok(`${n} → ${want}`, got === want, `得到 ${got}`);
  });

  // 路由驱动的类型
  ok('CAD（route=cad）→ cad', kindOf(f('立库规划图块.dwg', { route: 'cad' })) === 'cad');
  ok('Office（route=onlyoffice）→ onlyoffice',
     kindOf(f('Office测试.docx', { route: 'onlyoffice' })) === 'onlyoffice');
  ok('PDF（route=onlyoffice）→ onlyoffice',
     kindOf(f('测试文档.pdf', { route: 'onlyoffice' })) === 'onlyoffice');
  ok('KK（route=kkfileview）→ kkfileview',
     kindOf(f('冷门格式.xyz', { route: 'kkfileview' })) === 'kkfileview');
  ok('★ 完全没有 route 且原生不认 → null（只提供下载，不参与翻页）',
     kindOf(f('神秘文件.bin')) === null,
     `得到 ${kindOf(f('神秘文件.bin'))}`);
  ok('文件夹 → null', kindOf(d('子文件夹A')) === null);
}

/* ---------- §6 路由优先级必须与 open() 一致 ---------- */
console.log('\n§6 kindOf 的优先级与 open() 路由一致');
{
  // open() 的顺序：cad → onlyoffice → 原生 → kkfileview
  // 所以即使 route 说是 kkfileview，只要原生认这个扩展名，也应按原生归类
  ok('route=kkfileview 但扩展名是 png → image（原生优先）',
     kindOf(f('伪装.png', { route: 'kkfileview' })) === 'image',
     `得到 ${kindOf(f('伪装.png', { route: 'kkfileview' }))}`);
  ok('route=cad 时即使扩展名像文本也 → cad（cad 最优先）',
     kindOf(f('图纸.txt', { route: 'cad' })) === 'cad');
  ok('route=onlyoffice 优先于原生判定',
     kindOf(f('表.csv', { route: 'onlyoffice' })) === 'onlyoffice',
     `得到 ${kindOf(f('表.csv', { route: 'onlyoffice' }))}`);
}

/* ---------- §2 siblingsOfKind 只留同类 ---------- */
console.log('\n§2 siblingsOfKind 只保留同 kind');
{
  const all = [
    d('子文件夹A'),
    f('高一1班.jpeg'), f('高一2班.jpeg'), f('高一3班.jpeg'),
    f('脚本.py'), f('清单.csv'), f('说明.txt'),
    f('歌.mp3'),
    f('神秘文件.bin'),
  ];
  const imgs = siblingsOfKind(all, 'image');
  ok('image 只留 3 张', imgs.length === 3, JSON.stringify(imgs.map((x) => x.name)));
  ok('全是图片', imgs.every((x) => /\.jpeg$/.test(x.name)));
  ok('文件夹被排除', !imgs.some((x) => x.isDir));

  // 注意：本夹具里原生文本类型只有 脚本.py / 清单.csv / 说明.txt 三个
  const texts = siblingsOfKind(all, 'text');
  ok('text 留 3 个（py/csv/txt）', texts.length === 3,
     JSON.stringify(texts.map((x) => x.name)));

  ok('kind=null → 空数组（没有预览器就不参与翻页）',
     siblingsOfKind(all, null).length === 0);
}

/* ---------- §3 ★ 用户报的场景：图片夹在其它类型之间 ★ ---------- */
console.log('\n§3 ★核心场景★ 目录里图片混在大量其它文件中');
{
  // 模拟真实共享目录：29 项，其中 6 张 jpeg 夹在中间，还有 pdf/docx/dwg/csv…
  const all = [
    d('00-Q3-1250'), d('1.2.14.TFDF-6# F向'), d('子文件夹A'), d('子文件夹B'),
    f('00-Q3-1250.zip', { route: 'kkfileview' }),
    f('毕业生面试指南.doc', { route: 'kkfileview' }),
    f('测试图片.png'),
    f('测试文档.pdf', { route: 'onlyoffice' }),
    f('高二1班.jpeg'), f('高二2班.jpeg'), f('高二3班.jpeg'),
    f('高一1班.jpeg'), f('高一2班.jpeg'), f('高一3班.jpeg'),
    f('工时表.csv'), f('脚本.py'),
    f('立库规划图块.dwg', { route: 'cad' }),
    f('配置.json'), f('清单.csv'), f('示例.txt'), f('说明.txt'),
    f('天一新增价格预估.xlsx', { route: 'onlyoffice' }),
    f('Office测试.docx', { route: 'onlyoffice' }),
    f('readme.md'),
  ];
  const imgs = siblingsOfKind(all, 'image');
  ok('★ 图片窗口的总数 = 7（6 张 jpeg + 1 张 png，不含 pdf/csv/dwg…）',
     imgs.length === 7, `得到 ${imgs.length}: ${imgs.map((x) => x.name).join(',')}`);
  ok('★ 全部是浏览器能渲染的图片扩展名',
     imgs.every((x) => /\.(jpe?g|png|gif|bmp|webp|svg|ico|avif)$/i.test(x.name)),
     imgs.map((x) => x.name).join(','));
  ok('★ 高一1班.jpeg 的下一个必须是图片（不再是 pdf/csv）', (() => {
    const i = imgs.findIndex((x) => x.name === '高一1班.jpeg');
    const next = imgs[i + 1];
    return !!next && kindOf(next) === 'image';
  })());

  // 反向：office 窗口只翻 office
  const oo = siblingsOfKind(all, 'onlyoffice');
  ok('office 窗口只翻 office（3 个：pdf/docx/xlsx）', oo.length === 3,
     oo.map((x) => x.name).join(','));
  ok('office 里不含 jpeg', !oo.some((x) => /\.jpeg$/i.test(x.name)));

  // cad 窗口只有 1 个 → navBtns 会因 total<=1 而不显示按钮（正确行为）
  ok('cad 只有 1 个（导航条会自动隐藏）', siblingsOfKind(all, 'cad').length === 1);
}

/* ---------- §4 无预览器不参与 ---------- */
console.log('\n§4 无内置预览器的文件不进任何同类列表');
{
  const all = [f('a.png'), f('b.bin'), f('c.未知')];
  ['image', 'video', 'text', 'onlyoffice', 'kkfileview', 'cad'].forEach((k) => {
    const list = siblingsOfKind(all, k);
    ok(`kind=${k} 不含 .bin/.未知`, !list.some((x) => /bin|未知/.test(x.name)),
       list.map((x) => x.name).join(','));
  });
}

/* ---------- §5 过滤规则 ---------- */
console.log('\n§5 文件夹与隐藏文件仍被排除');
{
  const all = [d('夹'), f('a.png'), f('.hidden.png'), f('b.png')];
  const list = siblingsOfKind(all, 'image');
  ok('只剩 2 张可见图片', list.length === 2, list.map((x) => x.name).join(','));
  ok('点开头隐藏图片被排除', !list.some((x) => x.name[0] === '.'));
}

console.log(`\n════════════════════════════════`);
console.log(`  通过 ${pass} / ${pass + fail}`);
if (fail) { console.log(`  ❌ 失败 ${fail} 项`); process.exit(1); }
console.log('  ✅ 全部通过');
