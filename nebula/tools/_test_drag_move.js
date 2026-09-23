/* =============================================================================
   _test_drag_move.js —— 「拖动条目到文件夹里移动」的纯逻辑仿真

   ★ 第一原则：从 js/explorer.js **抽取真实源码**执行，绝不抄一份进来。★

   ---------------------------------------------------------------------------
   需求（原文）
   ---------------------------------------------------------------------------
     「文件夹窗口中，鼠标左键点住文件或文件夹图标，可以进行拖动，
       拖到指定文件夹中进行移动。」

     「这样的预览和编辑 不单独打开窗口」

   ---------------------------------------------------------------------------
   覆盖的不变量
   ---------------------------------------------------------------------------
     0. 抽到的是**当前**产品源码
     1. 自定义 MIME 与上传用的 'Files' 严格区分（不得串扰）
     2. isSelfOrDescendant：自己 判 true
     3. isSelfOrDescendant：子孙 判 true
     4. isSelfOrDescendant：父目录 判 false
     5. isSelfOrDescendant：同前缀但不同层（/ab vs /a）判 false  ← 经典边界
     6. isSelfOrDescendant：根目录的关系正确
     7. cssEsc：引号/反斜杠被转义（选择器注入防护）
     8. 拖到文件夹 tile → doMove 的目标目录 = 该文件夹
     9. 拖到空白 → 目标目录 = 当前目录
    10. 只读挂载 → 拒绝，不调 API
    11. 目标 == 来源目录 → 不调 API（无意义移动）
    12. 把文件夹拖进自己 → 跳过，不调 API
    13. 多选：合法的走 API，非法的跳过
   ============================================================================= */
'use strict';
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'web', 'js', 'explorer.js');
const src = fs.readFileSync(SRC, 'utf8');

function extractFn(name) {
  // ★ 注意：产品里 doMove 是 `async function doMove(...)`。
  //   若只 indexOf('function doMove(')，切出来的片段会**丢掉 async 前缀**，
  //   注入后函数体里的 await 就成了语法错误（第一版就踩了这个）。
  //   所以要往前多看几字符，把 `async `（若存在）一并纳入。
  let start = src.indexOf(`async function ${name}(`);
  if (start >= 0) {
    // 对齐到 async 起点即可
  } else {
    start = src.indexOf(`function ${name}(`);
  }
  if (start < 0) throw new Error(`未找到 ${name}，explorer.js 结构变了？`);
  let i = src.indexOf('{', start), depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(start, j + 1); }
  }
  throw new Error(`${name} 花括号不配平`);
}
function stripComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:\\])\/\/[^\n]*/g, '$1 ');
}

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? '  → ' + detail : ''}`); }
}

console.log('\n════════ _test_drag_move ════════\n');

/* ---------------- §0 源码同步性 ---------------- */
{
  const need = [
    ['自定义 MIME 常量', /application\/x-nebula-names/],
    ['与上传的 Files 区分（只处理自定义类型）', /payloadOf|dragPayload/],
    ['拖动源写入 dataTransfer', /setData\(\s*DND_MIME/],
    ['放置目标判定存在', /function targetOf|const targetOf/],
    ['自我/子孙 保护', /function isSelfOrDescendant/],
    ['只读挂载拒绝', /S\.mountReadonly/],
  ];
  let f = 0;
  need.forEach(([d, re]) => { if (!re.test(src)) { console.log(`  ✗ §0 缺少：${d}`); f++; } });
  console.log(f === 0 ? '§0 源码同步性：OK' : `§0 源码同步性：FAIL(${f})`);
  if (f) process.exitCode = 1;
}

/* ---------------- 抽取被测函数 ---------------- */
const normPathSrc = extractFn('normPath');
const joinPathSrc = extractFn('joinPath');
const cssEscSrc   = extractFn('cssEsc');
const selfSrc     = extractFn('isSelfOrDescendant');
const doMoveSrc   = extractFn('doMove');

// joinPath 依赖 normPath；一起注入
function makeHelpers() {
  const f = new Function(
    normPathSrc + '\n' + joinPathSrc + '\n' + cssEscSrc + '\n' + selfSrc + '\n' +
    'return { normPath, joinPath, cssEsc, isSelfOrDescendant };'
  );
  return f();
}
const H = makeHelpers();

/* ---------------- §2-§6 isSelfOrDescendant ---------------- */
{
  const { isSelfOrDescendant } = H;
  check('§2 自己 → true', isSelfOrDescendant('/a/b', '/a/b') === true);
  check('§3 子孙 → true', isSelfOrDescendant('/a/b/c', '/a/b') === true);
  check('§4 父目录 → false', isSelfOrDescendant('/a', '/a/b') === false);
  check('§5 同前缀不同层 /ab vs /a → false（经典边界）',
    isSelfOrDescendant('/ab', '/a') === false,
    `得到 ${isSelfOrDescendant('/ab', '/a')}`);
  check('§6 根目录：/x 是 / 的子孙 → true',
    isSelfOrDescendant('/x', '/') === true);
  check('§6 根目录：/ 是 / 的自己 → true',
    isSelfOrDescendant('/', '/') === true);
}

/* ---------------- §7 cssEsc ---------------- */
{
  const { cssEsc } = H;
  const out = cssEsc('a"b\\c');
  check('§7 引号被转义', out.indexOf('\\"') >= 0, out);
  check('§7 反斜杠被转义', out.indexOf('\\\\') >= 0, out);
  check('§7 普通名不变', cssEsc('高一1班.jpeg') === '高一1班.jpeg');
}

/* ---------------- 构造 doMove 运行环境 ---------------- */
function runDoMove(opts) {
  const calls = [];
  const toasts = [];
  const loads = [];
  const apiMove = async (mount, p, target, isMove) => {
    calls.push({ mount, p, target, isMove });
    if (opts.failOn && opts.failOn.indexOf(p) >= 0) throw new Error('server said no');
  };
  // ★ doMove 是 async，包装它的函数体也必须是 async ★
  //   否则 `await` 出现在非 async 函数里 → SyntaxError（第一版就踩了这个）。
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const fn = new AsyncFunction(
    'body', 'S', 'pl', 'target',
    'API', 'Toast', 'load', 'WM', 'console',
    // doMove 内部还会用到 isSelfOrDescendant，一并注入（它是同文件里的兄弟函数）
    normPathSrc + '\n' + joinPathSrc + '\n' + selfSrc + '\n' +
    doMoveSrc + '\n; return await doMove(body, S, pl, target);'
  );
  return fn(
    {},                                        // body（load 被桩掉，不需要真 DOM）
    opts.S,
    opts.pl,
    opts.target,
    { move: apiMove },
    { ok: (...a) => toasts.push(['ok', ...a]),
      error: (...a) => toasts.push(['error', ...a]),
      info: (...a) => toasts.push(['info', ...a]) },
    async (b, s) => { loads.push(s.mount + s.path); },
    { get: () => null },
    console
  ).then(() => ({ calls, toasts, loads }));
}

(async () => {
  /* --------- §8 拖到文件夹 → 目标 = 该文件夹 --------- */
  {
    const S = { mount: 'share', path: '/', winId: 'w1', mountReadonly: false };
    const pl = { mount: 'share', dir: '/', names: ['示例.txt'], winId: 'w1' };
    const r = await runDoMove({ S, pl, target: { kind: 'item', entry: { name: '子文件夹A', isDir: true } } });
    // ★ 期望值来源：joinPath('/','子文件夹A') === '子文件夹A'（根目录下**不带**前导斜杠）
    //   这是 explorer 既有的、与后端约定好的语义，不是本功能定义的。
    //   第一版写成 '/子文件夹A' 是**测试错了**，不是产品错了。
    check('§8 拖到文件夹「子文件夹A」→ API.move 的 target = 子文件夹A（joinPath 在根目录的真实语义）',
      r.calls.length === 1 && r.calls[0].target === '子文件夹A',
      JSON.stringify(r.calls));
    check('§8 且是移动（isMove=true）',
      r.calls.length === 1 && r.calls[0].isMove === true);
    check('§8 源路径也走同一语义', r.calls.length === 1 && r.calls[0].p === '示例.txt',
      JSON.stringify(r.calls));
    check('§8 提示为「已移动」', r.toasts.some((t) => t[0] === 'ok'),
      JSON.stringify(r.toasts));
  }

  /* --------- §9 拖到空白 → 目标 = 当前目录 --------- */
  {
    const S = { mount: 'share', path: '/子文件夹A', winId: 'w1', mountReadonly: false };
    const pl = { mount: 'share', dir: '/', names: ['示例.txt'], winId: 'w2' };
    const r = await runDoMove({ S, pl, target: { kind: 'cwd' } });
    check('§9 跨窗口拖到空白 → target = /子文件夹A（目标窗口的当前目录）',
      r.calls.length === 1 && r.calls[0].target === '/子文件夹A',
      JSON.stringify(r.calls));
  }

  /* --------- §10 只读挂载 → 拒绝 --------- */
  {
    const S = { mount: 'share', path: '/', winId: 'w1', mountReadonly: true };
    const pl = { mount: 'share', dir: '/', names: ['示例.txt'], winId: 'w1' };
    const r = await runDoMove({ S, pl, target: { kind: 'item', entry: { name: '子文件夹A', isDir: true } } });
    check('§10 只读挂载 → 不调用 API，且提示错误',
      r.calls.length === 0 && r.toasts.some((t) => t[0] === 'error'),
      JSON.stringify({ calls: r.calls, toasts: r.toasts }));
  }

  /* --------- §11 目标 == 来源目录 → 不调 API --------- */
  {
    const S = { mount: 'share', path: '/', winId: 'w1', mountReadonly: false };
    const pl = { mount: 'share', dir: '/', names: ['示例.txt'], winId: 'w1' };
    const r = await runDoMove({ S, pl, target: { kind: 'cwd' } });
    check('§11 目标就是来源目录 → 静默不调 API（Windows 同样不响应）',
      r.calls.length === 0, JSON.stringify(r.calls));
  }

  /* --------- §12 把文件夹拖进它自己 → 跳过 --------- */
  {
    const S = { mount: 'share', path: '/', winId: 'w1', mountReadonly: false };
    const pl = { mount: 'share', dir: '/', names: ['子文件夹A'], winId: 'w1' };
    const r = await runDoMove({ S, pl, target: { kind: 'item', entry: { name: '子文件夹A', isDir: true } } });
    check('§12 文件夹拖到自己 → 不调 API，并给出「不能移动到自身内部」',
      r.calls.length === 0 && r.toasts.some((t) => t[0] === 'error'
        && String(t[2]).indexOf('自身内部') >= 0),
      JSON.stringify({ calls: r.calls, toasts: r.toasts }));
  }

  /* --------- §12b 把文件夹拖进自己的子孙目录 → 跳过 --------- */
  {
    const S = { mount: 'share', path: '/子文件夹A', winId: 'w1', mountReadonly: false };
    const pl = { mount: 'share', dir: '/', names: ['子文件夹A'], winId: 'w1' };
    const r = await runDoMove({ S, pl, target: { kind: 'item', entry: { name: '更深一层', isDir: true } } });
    check('§12b 拖进自己的子孙目录 → 不调 API（防目录环）',
      r.calls.length === 0, JSON.stringify(r.calls));
  }

  /* --------- §13 多选：合法走 API，非法跳过 --------- */
  {
    const S = { mount: 'share', path: '/', winId: 'w1', mountReadonly: false };
    const pl = { mount: 'share', dir: '/', names: ['示例.txt', '子文件夹A', 'readme.md'], winId: 'w1' };
    const r = await runDoMove({ S, pl, target: { kind: 'item', entry: { name: '子文件夹A', isDir: true } } });
    // 子文件夹A 被跳过（拖到自己），另两个应移动；target/p 都用 joinPath 的真实语义
    check('§13 多选中非法项被跳过、合法项仍移动',
      r.calls.length === 2
      && r.calls.every((c) => c.target === '子文件夹A')
      && r.calls.every((c) => c.p !== '子文件夹A'),
      JSON.stringify(r.calls));
    check('§13 有跳过时给出 info 级提示（不是静默）',
      r.toasts.some((t) => t[0] === 'info'), JSON.stringify(r.toasts));
  }

  /* --------- §14 服务端失败时汇总为 error --------- */
  {
    const S = { mount: 'share', path: '/', winId: 'w1', mountReadonly: false };
    const pl = { mount: 'share', dir: '/', names: ['a.txt', 'b.txt'], winId: 'w1' };
    const r = await runDoMove({
      S, pl, target: { kind: 'item', entry: { name: '子文件夹A', isDir: true } },
      // ★ failOn 必须用 joinPath 产生的真实路径（根目录下不带前导斜杠）★
      failOn: ['a.txt'],
    });
    check('§14 部分失败 → 报 error 且指出失败项',
      r.toasts.some((t) => t[0] === 'error'), JSON.stringify(r.toasts));
  }

  console.log(`\n──────── 结果：${pass} 通过 / ${fail} 失败 ────────\n`);
  if (fail) process.exitCode = 1;
})();
