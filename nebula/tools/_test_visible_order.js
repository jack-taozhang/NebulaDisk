/* ============================================================================
 * _test_visible_order.js —— ★ 「下一个」的顺序必须与用户所见列表一致 ★
 *
 * 这是上一个 bug 的第二层，也是同一个根因家族：
 *   资源管理器界面上显示的是 **visibleEntries(S)**（文件夹优先 + 排序键 + 过滤），
 *   但 activate() 之前把 **S.entries**（接口原始顺序）交给了预览窗口。
 *   结果：位置计数出现「界面上第 10 个文件却写着 20 / 25」这种对不上的数字，
 *         而且「下一个」会跳到用户预料之外的文件。
 *
 * 本测试从产品源码抽取：
 *   · visibleEntries —— 排序/过滤的实现
 *   · 并断言 activate / refreshContext 的传参用的是 visibleEntries，
 *     而不是裸的 S.entries（源码形态闸）。
 * ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const EXPL = path.resolve(__dirname, '../web/js/explorer.js');
const src = fs.readFileSync(EXPL, 'utf8');

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
  if (i < 0) throw new Error(`源码里找不到 ${name}()`);
  let d = 0, started = false;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') { d++; started = true; }
    else if (src[j] === '}') { d--; if (started && d === 0) return src.slice(i, j + 1); }
  }
  throw new Error(`${name}() 花括号不配对`);
}

/* ---------- §0 源码形态：两个传参点都必须是 visibleEntries ---------- */
console.log('\n§0 源码形态：交给预览窗口的必须是 visibleEntries(S)');
{
  ok('activate() 里 Viewer.open 传 visibleEntries(S)',
     /Viewer\.open\(\s*S\.mount,\s*joinPath\(S\.path,\s*e\.name\),\s*e,\s*visibleEntries\(S\),\s*S\.path\s*\)/.test(bare),
     '仍是 S.entries → 顺序会与界面不一致');
  ok('openOnlyOffice 传 visibleEntries(S)',
     /Viewer\.openOnlyOffice\(\s*S\.mount,\s*joinPath\(S\.path,\s*single\.name\),\s*single,\s*visibleEntries\(S\),\s*S\.path\s*\)/.test(bare),
     '仍是 S.entries');
  ok('refreshContext 也传 visibleEntries(S)',
     /Viewer\.refreshContext\(\s*S\.mount,\s*S\.path,\s*visibleEntries\(S\)\s*\)/.test(bare),
     '仍是 S.entries → 会把已排好的顺序又打乱回原始顺序');
  ok('★ 没有任何一处再把裸 S.entries 交给 Viewer',
     !/Viewer\.(open|openOnlyOffice|refreshContext)\([^)]*\bS\.entries\b/.test(bare));
}

/* ---------- 用真实 visibleEntries 验证行为 ---------- */
const vSrc = extractFn('visibleEntries');
const sandbox = { console };
vm.createContext(sandbox);
vm.runInContext(`${vSrc}\n; this.visibleEntries = visibleEntries;`, sandbox);
const { visibleEntries } = sandbox;

const f = (name, o) => Object.assign({ name, ext: name.split('.').pop(), isDir: false, size: 100, mtime: 0 }, o);
const d = (name) => ({ name, isDir: true, size: 0, mtime: 0 });

/* ---------- §1 文件夹优先 ---------- */
console.log('\n§1 文件夹永远排在文件前面（Windows 行为）');
{
  const S = {
    entries: [f('a.png'), d('子文件夹B'), f('b.png'), d('子文件夹A')],
    sortKey: 'name', sortAsc: true, filter: '',
  };
  const list = visibleEntries(S);
  ok('前两个是文件夹', list[0].isDir && list[1].isDir,
     list.map((x) => `${x.isDir ? '[D]' : ''}${x.name}`).join(','));
  ok('总数不变（4）', list.length === 4);
}

/* ---------- §2 名称排序（zh-CN + 数字感知） ---------- */
console.log('\n§2 名称排序：中文按拼音、数字按数值');
{
  const S = {
    entries: [f('file10.png'), f('file2.png'), f('file1.png')],
    sortKey: 'name', sortAsc: true, filter: '',
  };
  const names = visibleEntries(S).map((x) => x.name);
  ok('数字感知排序：file1 < file2 < file10',
     names.join(',') === 'file1.png,file2.png,file10.png', names.join(','));
}

/* ---------- §3 降序 ---------- */
console.log('\n§3 降序：sortAsc=false 时结果反转（文件夹仍在前）');
{
  const S = {
    entries: [d('文件夹'), f('a.png'), f('b.png')],
    sortKey: 'name', sortAsc: false, filter: '',
  };
  const names = visibleEntries(S).map((x) => x.name);
  ok('文件夹仍第一，文件降序', names[0] === '文件夹' && names[1] === 'b.png' && names[2] === 'a.png',
     names.join(','));
}

/* ---------- §4 按类型排序 ---------- */
console.log('\n§4 按扩展名排序（sortKey = type）');
{
  const S = {
    entries: [f('x.png'), f('a.pdf'), f('m.txt')],
    sortKey: 'type', sortAsc: true, filter: '',
  };
  const exts = visibleEntries(S).map((x) => x.ext);
  ok('扩展名升序 pdf < png < txt', exts.join(',') === 'pdf,png,txt', exts.join(','));
}

/* ---------- §5 过滤后再排序 ---------- */
console.log('\n§5 过滤（S.filter）先于排序生效');
{
  const S = {
    entries: [f('报告A.pdf'), f('照片B.png'), f('报告C.pdf')],
    sortKey: 'name', sortAsc: true, filter: '报告',
  };
  const list = visibleEntries(S);
  ok('只剩 2 项', list.length === 2, list.map((x) => x.name).join(','));
  ok('都含关键字', list.every((x) => x.name.includes('报告')));
}

/* ---------- §6 不改动原数组（纯函数契约） ---------- */
console.log('\n§6 ★ 不得就地修改 S.entries（否则界面顺序会被污染）');
{
  const orig = [f('z.png'), d('夹'), f('a.png')];
  const S = { entries: orig, sortKey: 'name', sortAsc: true, filter: '' };
  const before = orig.map((x) => x.name).join(',');
  visibleEntries(S);
  const after = orig.map((x) => x.name).join(',');
  ok('原数组顺序未变', before === after, `${before} → ${after}`);
}

console.log(`\n════════════════════════════════`);
console.log(`  通过 ${pass} / ${pass + fail}`);
if (fail) { console.log(`  ❌ 失败 ${fail} 项`); process.exit(1); }
console.log('  ✅ 全部通过');
