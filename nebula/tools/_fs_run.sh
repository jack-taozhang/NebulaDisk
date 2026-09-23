#!/usr/bin/env bash
# =============================================================================
# _fs_run.sh —— ★ 点 iframe 预览窗口任意位置都能置顶（真浏览器验证）★
#
# 用户原文：「编辑和预览文件的窗口 目前还没有实现 点击窗口任何地方就聚焦成
#            最前端显示。」
#
# 步骤：
#   1) 登录 + 打开桌面
#   2) 开文件夹窗口
#   3) 打开一个**有 iframe 的**预览窗口（OnlyOffice 的 pdf/docx）
#      —— 这是用户报的场景（OnlyOffice / CAD / kkFileView）
#   4) 跑 _fs_probe.js 做网格打点
#   5) 自判（注意 agent-browser eval 返回的是转义过的 JSON）
# =============================================================================
set -uo pipefail
export PATH="/c/Users/HP/.workbuddy/binaries/PortableGit/versions/1.2.0/usr/bin:/c/Users/HP/.workbuddy/binaries/PortableGit/versions/1.2.0/mingw64/bin:/c/Windows/System32:/c/Windows:/usr/bin:$PATH"
S="fs$(date +%s)"; BASE="http://127.0.0.1:8089"; AB="agent-browser --session $S"
HERE="$(cd -- "$(dirname -- "$0")" && pwd)"
OUT="$HERE/_fs.out"; : > "$OUT"
TMPD="$HERE/_fs_tmp"; mkdir -p "$TMPD"
log() { echo "$*" >> "$OUT"; echo "$*"; }
CJ="$HERE/_ck_fs.txt"

# ★★ 绝不要给 agent-browser 的输出接管道（`| tail`）★★
#   实测接管道会让它卡死不返回（stdout 被提前关闭 → 进程阻塞）。
#   正确做法：重定向到文件，再读文件。
abrun() {
  local tag="$1"; shift
  $AB "$@" > "$TMPD/$tag.txt" 2>&1   # ★ $AB 不能加引号：它含空格，要按词拆分
  return $?
}
abread() { cat "$TMPD/$1.txt" 2>/dev/null | tail -3; }

# ★★ Windows 原生 curl 不认 MSYS 路径（/d/...），会把 -o 目标当成不存在的目录，
#   报 `curl: (23) client returned ERROR on write` 并且**不生成 cookie jar**。
#   必须把路径转成 Windows 形式（D:/...）再交给 curl。
winpath() {
  local p="$1"
  if command -v cygpath >/dev/null 2>&1; then cygpath -m "$p"; return; fi
  # 兜底：/d/foo → D:/foo
  printf '%s' "$p" | sed -E 's#^/([a-zA-Z])/#\1:/#'
}
CJW="$(winpath "$CJ")"
LOGINW="$(winpath "$TMPD/login.json")"

curl -s -X POST "$BASE/api/login" \
  -d "username=admin&password=${NEBULA_TEST_PASSWORD:-dev-pass-not-real}" \
  -c "$CJW" -o "$LOGINW"
TOK=$(awk '/nebula_session/{print $7}' "$CJ" 2>/dev/null | tr -d '\r\n')
[ -n "$TOK" ] || { log "❌ 登录失败（没拿到会话票据）: $(cat "$TMPD/login.json" 2>/dev/null)"; exit 1; }
log "登录 OK，票据长度 ${#TOK}"
abrun o1 open "$BASE/"
abrun ck cookies set nebula_session "$TOK" --url "$BASE/" --path / --httpOnly
abrun o2 open "$BASE/"
sleep 3
runjs() { $AB eval "$(cat "$HERE/$1")" > "$TMPD/eval.txt" 2>/dev/null; tail -1 "$TMPD/eval.txt"; }

# 去转义（agent-browser eval 会把 " 变成 \"）
# ★ 用 here-string 不要用进程替换 <()：grep -q 提前退出会让 fifo 触发 SIGPIPE。
deesc() { printf '%s' "$1" | sed 's/\\"/"/g; s/\\\\/\\/g'; }

READY=0
for i in $(seq 1 20); do
  R=$(runjs _grid_ready.js)
  RD=$(deesc "$R")
  grep -qE '"ready":true' <<<"$RD" && { READY=1; break; }
  sleep 2
done
[ "$READY" = "1" ] || { log "❌ 桌面未就绪: $R"; exit 1; }
log "就绪： $(deesc "$R")"

V=$(runjs _gn_open.js); log "开文件夹窗： $(deesc "$V")"; sleep 3

# 打开一个 OnlyOffice 预览窗口（pdf 走 onlyoffice 路由 → 内嵌 iframe）
P=""
for i in $(seq 1 12); do
  P=$(runjs _fs_open.js)
  PD=$(deesc "$P")
  grep -qE '"ok":1' <<<"$PD" && break
  sleep 2
done
log "开 iframe 预览窗： $(deesc "$P")"; sleep 5

log ""
log "═════════ 网格打点：点任意位置是否置顶 ═════════"
V=$(runjs _fs_probe.js)
VC=$(deesc "$V")
log "$VC"
log ""

OK=1
grep -qE '"probeBroken":true' <<<"$VC" && { log "⚠️ 探针自检失败"; OK=0; }
grep -qE '"hasIframeWin":true'         <<<"$VC" || OK=0
grep -qE '"shieldExists":true'         <<<"$VC" || OK=0
grep -qE '"shieldAutoWhenNotTop":true' <<<"$VC" || OK=0
# ★ 主判据：每个格子按下去都抬起来了 + 都变成了最顶 ★
grep -qE '"everyCellRaised":true'      <<<"$VC" || OK=0
grep -qE '"everyCellBecameTop":true'   <<<"$VC" || OK=0
grep -qE '"shieldOffWhenTop":true'     <<<"$VC" || OK=0

log "═════════ 自判 ═════════"
if [ "$OK" = "1" ]; then
  log "  ✅ iframe 预览窗口的每个 iframe 上都盖了透明点击盾"
  log "  ✅ 非最顶层时盾生效（pointer-events:auto）"
  log "  ✅ ★矩形内每一格按下都能把窗口置顶★（=点任意位置都前置）"
  log "  ✅ 置顶后盾自动关闭，内容立即可交互"
else
  log "  ❌ 未通过"
fi
log ""
log "结果写入 $OUT"
[ "$OK" = "1" ] || exit 1
