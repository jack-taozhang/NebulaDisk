#!/usr/bin/env bash
# =============================================================================
# run_unit_tests.sh —— 跑齐全部纯逻辑单元测试（不需要浏览器 / 不需要 Docker）
#
#   ★ 为什么要有这个脚本 ★
#     各套件的汇总行格式不统一（`结果：N 通过 / M 失败`、`通过 N / N`），
#     靠人肉 tail 容易看漏一套。这里统一解析并通过 Node 汇总，
#     任何一套非零失败即整体失败。
#
#   ★ 解析为什么交给 Node ★
#     直接在 bash 里对含中文的输出做 `grep -E '通过[[:space:]]*[0-9]+'`
#     在不同 locale / MSYS 版本下会静默匹配失败（本脚本第一版就踩了：
#     8 套全被误判为 0 通过）。改为把原始输出交给 Node 用正则解析，
#     正则与文件编码一致，稳定且不受 shell 排序规则影响。
#
#   用法：  bash nebula/tools/run_unit_tests.sh
#   退出码：0 = 全绿；1 = 有失败或脚本崩溃
# =============================================================================
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
NODE="${NODE:-/c/Users/HP/.workbuddy/binaries/node/versions/24.21.0/node.exe}"
if [ ! -x "$NODE" ]; then NODE="$(command -v node)"; fi

# ★ Windows 原生 node.exe 不认识 MSYS 路径（/d/Docker/...）★
#   必须把传给它的所有路径转成 D:/Docker/... 形式，否则 readFileSync 直接
#   ENOENT，每一套都会被判成 MISSING（本脚本第二版踩过的坑）。
winpath() {
  if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else
    printf '%s' "$1" | sed -E 's#^/([a-zA-Z])/#\1:/#'
  fi
}

SUITES=(
  _test_controls.js
  _test_refresh_ctx.js
  _test_visible_order.js
  _test_drag_buttons.js
  _test_drag_move.js
  _test_kind_filter.js
  _test_iframe_shield.js
  _test_resize_hit.js
)

# ★ 不能用 mktemp -d ★
#   Git Bash 的 mktemp 返回 MSYS 路径（如 /tmp/tmp.xxx → E:\TEMP\tmp.xxx），
#   而这里调用的是 **Windows 原生** node.exe —— 它不认识 /tmp 这种路径，
#   会静默读不到文件、把每套都判成失败。
#   改为在脚本同级建一个真实的项目内临时目录（路径已是 Windows 可识别的）。
TMPD="$HERE/.unit_tmp"
rm -rf "$TMPD"; mkdir -p "$TMPD"

for f in "${SUITES[@]}"; do
  if [ -f "$HERE/$f" ]; then
    # ★ 用 Windows 路径调 node.exe（MSYS 路径它读不到）★
    "$NODE" "$(winpath "$HERE/$f")" > "$TMPD/$f.txt" 2>&1
    echo "$?" > "$TMPD/$f.rc"
  else
    echo "MISSING" > "$TMPD/$f.rc"
  fi
done

# 汇总：把目录交给 Node 解析（避免 bash 里的中文正则/locale 坑）
# ★ node -e 的 argv 约定：argv[1] 起才是我们传的参数（argv[0] 是 node 自己）★
"$NODE" -e '
const fs = require("fs"), path = require("path");
const dir = process.argv[1];
const suites = process.argv.slice(2);
let tp = 0, tf = 0, bad = 0;
console.log("");
console.log("==================== 单元测试总览 ====================");
for (const f of suites) {
  const rcFile = path.join(dir, f + ".rc");
  const rcRaw = fs.existsSync(rcFile) ? fs.readFileSync(rcFile, "utf8").trim() : "MISSING";
  if (rcRaw === "MISSING") {
    console.log("  " + f.padEnd(28) + "  MISSING");
    bad++; continue;
  }
  const rc = Number(rcRaw);
  const txt = fs.readFileSync(path.join(dir, f + ".txt"), "utf8");
  // ★ 两种语序都要覆盖（这是本脚本最容易踩的坑）★
  //   A) `结果：13 通过 / 0 失败`    —— 数字在「通过」**前面**
  //   B) `通过 12 / 12` + 全部通过  —— 数字在「通过」**后面**
  //   第一版只写了 B 的语序，于是 A 类的三套（drag_buttons/drag_move/
  //   resize_hit）恒被判成 0 通过、假红。两种都必须匹配。
  let np = null, nf = null;
  let m = txt.match(/(\d+)\s*通过\s*\/\s*(\d+)\s*失败/);   // A
  if (m) { np = +m[1]; nf = +m[2]; }
  if (np === null) {
    m = txt.match(/通过\s*(\d+)\s*\/\s*(\d+)/);             // B
    if (m) { np = +m[1]; const tot = +m[2]; nf = tot - np; if (nf < 0) nf = 0; }
  }
  if (np === null) { np = 0; nf = 1; }               // 解析不出来 = 当失败处理
  // ★ 零失败的"合格证"有两种写法，两种都认 ★
  //   `✅ 全部通过` / `0 失败`（数字在前）/ `失败 0`（数字在后）
  if (nf === 0 && !/全部通过/.test(txt) && !/(\d+)\s*失败/.test(txt) && !/失败\s*\d/.test(txt)) nf = 1;
  if (rc !== 0 || nf !== 0) {
    console.log("  " + f.padEnd(28) + "  \u274c  通过 " + np + " / 失败 " + nf + "  (exit=" + rc + ")");
    bad++;
  } else {
    console.log("  " + f.padEnd(28) + "  \u2705  通过 " + np);
  }
  tp += np; tf += nf;
}
console.log("-----------------------------------------------------");
console.log("  合计：通过 " + tp + " / 失败 " + tf);
if (bad === 0 && tf === 0) {
  console.log("  \u2705 全部通过");
  console.log("=====================================================");
  process.exit(0);
}
console.log("  \u274c 有套件失败（" + bad + " 套）");
console.log("=====================================================");
process.exit(1);
' "$(winpath "$TMPD")" "${SUITES[@]}"
rc=$?
rm -rf "$TMPD"
exit $rc
