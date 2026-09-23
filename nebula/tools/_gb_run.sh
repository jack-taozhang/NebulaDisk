#!/usr/bin/env bash
# =============================================================================
# _gb_run.sh —— 业务按钮可用性 真实浏览器验证（修复「按钮全失效」）
#
# 背景：用户报「文件窗口，除了最大化，最小化，关闭外，最顶上其他的按钮都
#       失效了」。根因是 _bindDrag 只豁免 .tb-btn，业务按钮 .tbtn 走进拖动
#       分支并被执行了 preventDefault(pointerdown) → click 永不触发。
#
# 本脚本用**完整鼠标序列**（pointerdown→mousedown→pointerup→mouseup→click）
# 驱动真实按钮，看它们的可观测副作用是否发生。
# 只派发 click 是测不出这个 bug 的（必然假绿）。
# =============================================================================
set -uo pipefail
export PATH="/c/Users/HP/.workbuddy/binaries/PortableGit/versions/1.2.0/usr/bin:/c/Users/HP/.workbuddy/binaries/PortableGit/versions/1.2.0/mingw64/bin:/c/Users/HP/.workbuddy/binaries/node/versions/24.21.0:/c/Windows/System32:/c/Windows:/usr/bin:$PATH"
S="gb$(date +%s)"; BASE="http://127.0.0.1:8089"; AB="agent-browser --session $S"
HERE="$(cd -- "$(dirname -- "$0")" && pwd)"
OUT="$HERE/_gb_buttons.out"; : > "$OUT"
log() { echo "$*" >> "$OUT"; echo "$*"; }
CJ="$HERE/_ck.txt"
TMPD="$HERE/_gb_tmp"; mkdir -p "$TMPD"

# ★ Windows 原生 curl 不认 MSYS 路径（/d/...）→ 必须转 Windows 形式，
#   否则报 exit 23 且不生成 cookie jar。
winpath() {
  local p="$1"
  if command -v cygpath >/dev/null 2>&1; then cygpath -m "$p"; return; fi
  printf '%s' "$p" | sed -E 's#^/([a-zA-Z])/#\1:/#'
}

curl -s -X POST "$BASE/api/login" \
  -d "username=admin&password=${NEBULA_TEST_PASSWORD:-dev-pass-not-real}" \
  -c "$(winpath "$CJ")" -o "$TMPD/login.json"
TOK=$(awk '/nebula_session/{print $7}' "$CJ" 2>/dev/null | tr -d '\r\n')
[ -n "$TOK" ] || { log "❌ 登录失败"; exit 1; }
# ★ 不要给 agent-browser 接管道（会卡死）；一律重定向到文件
abrun() { local tag="$1"; shift; $AB "$@" > "$TMPD/$tag.txt" 2>&1; }
abrun o1 open "$BASE/"
abrun ck cookies set nebula_session "$TOK" --url "$BASE/" --path / --httpOnly
abrun o2 open "$BASE/"
sleep 3
runjs() { $AB eval "$(cat "$HERE/$1")" > "$TMPD/eval.txt" 2>/dev/null; tail -1 "$TMPD/eval.txt"; }

READY=0
for i in $(seq 1 20); do
  R=$(runjs _grid_ready.js)
  RD=$(printf '%s' "$R" | sed 's/\\"/"/g; s/\\\\/\\/g')
  if grep -qE '"ready":true' <<<"$RD"; then READY=1; break; fi
  sleep 2
done
[ "$READY" = "1" ] || { log "❌ 页面未就绪: $R"; exit 1; }
log "就绪： $R"

V=$(runjs _gb_open.js); log "开文件夹窗： $V"; sleep 3

V=$(runjs _gb_buttons.js)
VC=$(printf '%s' "$V" | sed 's/\\"/"/g; s/\\\\/\\/g')
log ""
log "═════════ 业务按钮真实性验证（完整鼠标序列）═════════"
log "$VC"
log ""

OK=1
# ★ 键值紧邻匹配：整份 JSON 在一行，宽匹配会跨字段假命中
grep -qE '"viewListWorks":true' <<<"$VC" || OK=0
grep -qE '"viewGridWorks":true' <<<"$VC" || OK=0
grep -qE '"infoWorks":true'     <<<"$VC" || OK=0
grep -qE '"sortWorks":true'     <<<"$VC" || OK=0
grep -qE '"notMoved":true'      <<<"$VC" || OK=0

log "═════════ 自判 ═════════"
if [ "$OK" = "1" ]; then
  log "  ✅ 业务按钮全部生效（视图切换 / 详细信息 / 排序均触发副作用）"
  log "  ✅ 且点击按钮没有把窗口拖走"
else
  log "  ❌ 仍有按钮失效：$V"
fi
log ""
log "结果写入 $OUT"
[ "$OK" = "1" ] || exit 1
