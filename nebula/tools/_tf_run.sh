#!/usr/bin/env bash
# =============================================================================
# _tf_run.sh —— ★ 点「最顶上那条工具栏」也能前置窗口（真浏览器验证）★
#
# 用户原文：
#   「窗口点击聚焦显示所有窗口 最顶上的工具栏 （最小化，最大化，关闭这一行）
#     目前没有涵盖在呢。 需要增加点击这个区域也能前置显示窗口。
#     两种窗口都要修改。」
#
# 步骤：
#   1) 登录 + 打开桌面
#   2) 开一个**文件夹窗口**（explorer）
#   3) 再开一个**有 iframe 的预览窗口**（测试文档.pdf 走 OnlyOffice）
#      —— 需求明确说「两种窗口都要修改」，所以必须两种都在场
#   4) 跑 _tf_probe.js：对每一种窗口分别
#        工具栏空白 / 三键那一块 / 内容区 / 缩放热区 按下，
#        断言 zIndex 变大且变成最顶层，且不留下整屏拖拽遮罩
#   5) 自判（agent-browser eval 返回的是转义过的 JSON，必须先 deesc）
# =============================================================================
set -uo pipefail
export PATH="/c/Users/HP/.workbuddy/binaries/PortableGit/versions/1.2.0/usr/bin:/c/Users/HP/.workbuddy/binaries/PortableGit/versions/1.2.0/mingw64/bin:/c/Windows/System32:/c/Windows:/usr/bin:$PATH"
S="tf$(date +%s)"; BASE="http://127.0.0.1:8089"; AB="agent-browser --session $S"
HERE="$(cd -- "$(dirname -- "$0")" && pwd)"
OUT="$HERE/_tf.out"; : > "$OUT"
TMPD="$HERE/_tf_tmp"; rm -rf "$TMPD"; mkdir -p "$TMPD"
log() { echo "$*" >> "$OUT"; echo "$*"; }
CJ="$TMPD/ck.txt"

# ★★ 绝不要给 agent-browser 的输出接管道（`| tail`）★★
#   实测接管道会让它卡死不返回（stdout 被提前关闭 → 进程阻塞）。
#   正确做法：重定向到文件，再读文件。
abrun() {
  local tag="$1"; shift
  $AB "$@" > "$TMPD/$tag.txt" 2>&1   # $AB 不能加引号：它含空格，要按词拆分
  return $?
}

# ★★ Windows 原生 curl 不认 MSYS 路径（/d/...）★★
#   会把 -o 目标当成不存在的目录，报 curl: (23) 且**不生成 cookie jar**。
winpath() {
  local p="$1"
  if command -v cygpath >/dev/null 2>&1; then cygpath -m "$p"; return; fi
  printf '%s' "$p" | sed -E 's#^/([a-zA-Z])/#\1:/#'
}

curl -s -X POST "$BASE/api/login" \
  -d "username=admin&password=${NEBULA_TEST_PASSWORD:-dev-pass-not-real}" \
  -c "$(winpath "$CJ")" -o "$(winpath "$TMPD/login.json")"
TOK=$(awk '/nebula_session/{print $7}' "$CJ" 2>/dev/null | tr -d '\r\n')
[ -n "$TOK" ] || { log "❌ 登录失败: $(cat "$TMPD/login.json" 2>/dev/null)"; exit 1; }
log "登录 OK，票据长度 ${#TOK}"
abrun o1 open "$BASE/"
abrun ck cookies set nebula_session "$TOK" --url "$BASE/" --path / --httpOnly
abrun o2 open "$BASE/"
sleep 3

runjs() { $AB eval "$(cat "$HERE/$1")" > "$TMPD/eval.txt" 2>/dev/null; tail -1 "$TMPD/eval.txt"; }
# 去转义（agent-browser eval 会把 " 变成 \"）
deesc() { printf '%s' "$1" | sed 's/\\"/"/g; s/\\\\/\\/g'; }

READY=0
for i in $(seq 1 20); do
  R=$(runjs _grid_ready.js); RD=$(deesc "$R")
  grep -qE '"ready":true' <<<"$RD" && { READY=1; break; }
  sleep 2
done
[ "$READY" = "1" ] || { log "❌ 桌面未就绪: $R"; exit 1; }
log "就绪： $(deesc "$R")"

# ① 文件夹窗口（explorer）
V=$(runjs _gn_open.js); log "开文件夹窗： $(deesc "$V")"; sleep 3
# ② iframe 预览窗口（OnlyOffice）
P=""
for i in $(seq 1 12); do
  P=$(runjs _fs_open.js); PD=$(deesc "$P")
  grep -qE '"ok":1' <<<"$PD" && break
  grep -qE '"notready":true' <<<"$PD" && { log "⚠️ 预览窗还没就绪，重试…"; sleep 2; continue; }
  sleep 2
done
log "开 iframe 预览窗： $(deesc "$P")"

# ★★ 必须**轮询**等 iframe 真正出现，不能 fixed sleep ★★
#   OnlyOffice 窗口是两段式：先出「正在连接 OnlyOffice…」的 boot 占位（无 iframe），
#   转换完才把 <iframe> 插进 [data-role="host"]。冷启动/大文档可达十几秒。
#   原先是 `sleep 6` —— 机器一忙就等不够，_tf_probe 报 hasIframeWin:false，
#   runner 误判成「预览窗口点工具栏没置顶」。**那是脚本的锅**。
IFR=0
for i in $(seq 1 30); do
  W=$(runjs _tf_wait_iframe.js); WD=$(deesc "$W")
  grep -qE '"ready":true' <<<"$WD" && { IFR=1; break; }
  sleep 3
done
if [ "$IFR" = "1" ]; then
  log "iframe 就绪： $(deesc "$W")"
else
  log "⚠️ 等了 90s 仍没有 iframe，诊断：$(deesc "$W")"
fi

log ""
log "═════════ 工具栏置顶 实测（两种窗口 × 四个区域）═════════"
V=$(runjs _tf_probe.js)
VC=$(deesc "$V")
log "$VC"
log ""

OK=1
# ★ 先把「环境没准备好」与「产品有 bug」分清 ★
if [ "$IFR" != "1" ]; then
  log "⚠️ 探针环境未就绪：iframe 预览窗始终没长出 iframe（见上面诊断）。"
  log "   这**不能**说明产品有问题（点工具栏是否置顶根本没被测到）。"
  log "   先查：OnlyOffice 容器是否健康 / 该文档能否转换 / 网关是否卡住。"
  OK=0
fi
grep -qE '"probeBroken":true'             <<<"$VC" && { log "⚠️ 探针自检失败（没同时测到两种窗口）"; OK=0; }
grep -qE '"hasTwoKinds":true'             <<<"$VC" || { log "  ✗ 没同时拿到 explorer 与 iframe 两种窗口"; OK=0; }
grep -qE '"toolbarBlankRaisesExplorer":true' <<<"$VC" || { log "  ✗ 文件夹窗口：点工具栏空白没置顶"; OK=0; }
grep -qE '"toolbarBlankRaisesIframe":true'   <<<"$VC" || { log "  ✗ 预览窗口：点工具栏空白没置顶"; OK=0; }
grep -qE '"controlsBlockRaises":true'     <<<"$VC" || { log "  ✗ 三键那一块按下没置顶"; OK=0; }
grep -qE '"realButtonRaises":true'        <<<"$VC" || { log "  ✗ 真正的三键按钮上按下没置顶"; OK=0; }
grep -qE '"contentBodyStillRaises":true'  <<<"$VC" || { log "  ✗ 内容区按下没置顶（回归！原本就能）"; OK=0; }
grep -qE '"resizeHandleRaises":true'      <<<"$VC" || { log "  ✗ 缩放热区按下没置顶"; OK=0; }
grep -qE '"noShieldLeft":true'            <<<"$VC" || { log "  ✗ 留下了整屏拖拽遮罩（会吃掉后续点击）"; OK=0; }

log "═════════ 自判 ═════════"
if [ "$OK" = "1" ]; then
  log "  ✅ 两种窗口（文件夹 / iframe 预览）点**工具栏空白处**都能前置"
  log "  ✅ 点「最小化 最大化 关闭」那一整块、以及三键按钮本身，都能前置"
  log "  ✅ 点内容区仍能前置（原有能力没被修坏）"
  log "  ✅ 拖缩放热区也能前置（热区不在工具栏内，走的是另一处修复）"
  log "  ✅ 每次按下都配了抬起，屏上没有残留拖拽遮罩"
else
  log "  ❌ 未通过（详见上方 ✗）"
fi
log ""
log "结果写入 $OUT"
[ "$OK" = "1" ] || exit 1
