/* ============================================================================
 * _test_refresh_ctx.js —— ★ 目录变化后，预览窗口的兄弟列表与 index 必须重对齐 ★
 *
 * 对应需求：
 *   「在预览窗口，增加可以切换上一个 和下一个文件。」
 *   翻页依赖的 files/index 必须与目录**当前**内容一致，否则：
 *     · 删掉下一个文件 → 「下一个」指向不存在的文件
 *     · 新上传一个文件 → 「下一个」漏掉它
 *     · 重命名当前文件 → index 变 -1，翻页按钮直接消失
 *
 * 本测试从**产品源码**抽取 previewableList / refreshContext，在桩里跑：
 *   §1 删除后续文件 → 列表变短、index 保持指向同一个名字
 *   §2 在**前面**插入文件 → index 必须右移（这是最容易写错的一条）
 *   §3 重命名当前文件 → 找不到 → index = -1（翻页暂禁，但不崩）
 *   §4 index 越界后的兜底：用旧列表 index 找回名字
 *   §5 mount / dir 不匹配的窗口必须原样不动
 *   §6 文件夹与被过滤项不计入
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

function extractFn(name) {
  // 允许 async 前缀
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

const previewableSrc = extractFn('previewableList');
const refreshSrc = extractFn('refreshContext');

/* ---------- 桩：ctxOf 用一个可注入的 Map ---------- */
const sandbox = { console, ctxOf: new Map() };
vm.createContext(sandbox);
vm.runInContext(
  `${previewableSrc}\n${refreshSrc}\n;` +
  `this.previewableList = previewableList; this.refreshContext = refreshContext;`,
  sandbox,
);
const { previewableList, refreshContext } = sandbox;

/* ---------- 造数据 ---------- */
const f = (name, ext) => ({ name, ext: ext || name.split('.').pop(), isDir: false });
const d = (name) => ({ name, isDir: true });

function put(winId, ctx) { sandbox.ctxOf.set(winId, ctx); }
function get(winId) { return sandbox.ctxOf.get(winId); }
function reset() { sandbox.ctxOf = new Map(); sandbox.__reset && sandbox.__reset(); }

/** 让 ctxOf 重新成为同一张表（refreshContext 闭包捕获的是模块级 ctxOf） */
function reseed(map) {
  vm.runInContext('this.ctxOf = ctxOf', sandbox, { ctxOf: map });
}

/* ---------- §1 删除后续文件 ---------- */
console.log('\n§1 删掉「下一个」文件 → 列表变短，index 仍指向当前文件');
{
  const map = new Map();
  vm.runInContext('ctxOf', sandbox);
  sandbox.ctxOf = new Map();
  // 由于 refreshContext 闭包引用的是最初的 ctxOf 绑定，这里用同一张表增删
  const T = sandbox.ctxOf;
  T.clear();
  T.set('img:共享', {
    mount: '共享', dir: '/', currentName: 'b.png', index: 1,
    files: [f('a.png'), f('b.png'), f('c.png')],
  });
  refreshContext('共享', '/', [f('a.png'), f('b.png')]);
  const c = T.get('img:共享');
  ok('列表已更新为 2 项', c.files.length === 2, JSON.stringify(c.files.map((x) => x.name)));
  ok('index 仍指向 b.png（=1）', c.index === 1 && c.files[c.index].name === 'b.png',
     `index=${c.index}`);
  ok('currentName 保持 b.png', c.currentName === 'b.png');
}

/* ---------- §2 在前面插入文件（关键：index 必须右移） ---------- */
console.log('\n§2 在列表**前面**插入文件 → index 必须右移（最容易写错的一条）');
{
  const T = sandbox.ctxOf;
  T.clear();
  T.set('img:共享', {
    mount: '共享', dir: '/', currentName: 'b.png', index: 1,
    files: [f('a.png'), f('b.png')],
  });
  refreshContext('共享', '/', [f('aaa.png'), f('a.png'), f('b.png')]);
  const c = T.get('img:共享');
  ok('index 右移到 2（因为前面多了 aaa.png）', c.index === 2,
     `index=${c.index} → ${c.files.map((x) => x.name).join(',')}`);
  ok('index 指向的仍是 b.png', c.files[c.index] && c.files[c.index].name === 'b.png',
     c.files[c.index] && c.files[c.index].name);
}

/* ---------- §3 重命名当前文件 ---------- */
console.log('\n§3 当前文件被重命名 → 找不到，index = -1（翻页暂禁但不崩）');
{
  const T = sandbox.ctxOf;
  T.clear();
  T.set('img:共享', {
    mount: '共享', dir: '/', currentName: 'b.png', index: 1,
    files: [f('a.png'), f('b.png')],
  });
  let threw = false;
  try { refreshContext('共享', '/', [f('a.png'), f('b-new.png')]); } catch (e) { threw = true; }
  const c = T.get('img:共享');
  ok('不抛异常', !threw);
  ok('index = -1', c.index === -1, `index=${c.index}`);
  ok('列表已换成新的', c.files.map((x) => x.name).join(',') === 'a.png,b-new.png');
}

/* ---------- §4 currentName 缺失时用旧 index 兜底 ---------- */
console.log('\n§4 没登记 currentName → 用旧列表里 index 指向的名字兜底');
{
  const T = sandbox.ctxOf;
  T.clear();
  T.set('img:共享', {
    mount: '共享', dir: '/', index: 1,   // 故意不给 currentName
    files: [f('a.png'), f('b.png'), f('c.png')],
  });
  refreshContext('共享', '/', [f('z1.png'), f('a.png'), f('b.png'), f('c.png')]);
  const c = T.get('img:共享');
  ok('★ index 仍落在 b.png 上（没有变成 -1）', c.files[c.index] && c.files[c.index].name === 'b.png',
     `index=${c.index} → ${c.files.map((x) => x.name).join(',')}`);
}

/* ---------- §5 mount / dir 不匹配 → 原样不动 ---------- */
console.log('\n§5 别的挂载 / 别的目录的窗口不受影响');
{
  const T = sandbox.ctxOf;
  T.clear();
  const other = {
    mount: 'D盘', dir: '/x', currentName: 'q.png', index: 0,
    files: [f('q.png'), f('r.png')],
  };
  T.set('img:D盘', other);
  const snapshot = JSON.stringify(other);
  refreshContext('共享', '/', [f('a.png')]);
  ok('不匹配的窗口保持原样', JSON.stringify(T.get('img:D盘')) === snapshot,
     JSON.stringify(T.get('img:D盘')));
}

/* ---------- §6 过滤规则 ---------- */
console.log('\n§6 previewableList 过滤：文件夹与隐藏项不计入');
{
  const list = previewableList([
    d('子文件夹A'), f('a.png'), { name: '.hidden', ext: 'png', isDir: false },
    f('b.pdf'), null, { name: '', isDir: false },
  ]);
  ok('只剩 2 个可预览文件', list.length === 2, JSON.stringify(list.map((x) => x.name)));
  ok('文件夹被排除', !list.some((x) => x.isDir));
  ok('点开头隐藏项被排除', !list.some((x) => x.name[0] === '.'));
}

console.log(`\n════════════════════════════════`);
console.log(`  通过 ${pass} / ${pass + fail}`);
if (fail) { console.log(`  ❌ 失败 ${fail} 项`); process.exit(1); }
console.log('  ✅ 全部通过');
