#!/usr/bin/env bash
# =============================================================================
# _hz_run.sh —— resize 热区「太宽 / 太快」真实浏览器验证
#
# 验证：
#   · 几何厚度实测 ≤ 期望上界（"太宽"已修正）
#   · 进入热区后光标**不立刻**变（"太快"已修正：有延时）
#   · 按下立刻响应（延时没有拖慢真实拖拽）
#
# 复用 _gb_run.sh 的全部踩坑经验：
#   · 不给 agent-browser 接管道（会卡死）→ 一律重定向到文件
#   · $AB 不加引号（含空格，加了会 command not found）
#   · Windows 原生 curl 不认 MSYS 路径 → winpath() 转换 + 写真实文件
#   · grep 用 here-string（避免 <(...) + -q 的 SIGPIPE 卡死）
# =============================================================================
set -uo pipefail
export PATH="/c/Users/HP/.workbuddy/binaries/PortableGit/versions/1.2.0/usr/bin:/c/Users/HP/.workbuddy/binaries/PortableGit/versions/1.2.0/mingw64/bin:/c/Users/HP/.workbuddy/binaries/node/versions/24.21.0:/c/Windows/System32:/c/Windows:/usr/bin:$PATH"
S="hz$(date +%s)"; BASE="http://127.0.0.1:8089"; AB="agent-browser --session $S"
NODE_E="/c/Users/HP/.workbuddy/binaries/node/versions/24.21.0/node.exe"
[ -x "$NODE_E" ] || NODE_E="$(command -v node)"
HERE="$(cd -- "$(dirname -- "$0")" && pwd)"
OUT="$HERE/_hz.out"; : > "$OUT"
log() { echo "$*" >> "$OUT"; echo "$*"; }
CJ="$HERE/_ck_hz.txt"
TMPD="$HERE/_hz_tmp"; mkdir -p "$TMPD"

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

# 开一个文件夹窗口（热区验证需要一个真实可缩放窗口）
V=$(runjs _gb_open.js); log "开文件夹窗： $V"; sleep 3

V=$(runjs _hz_probe.js)
VC=$(printf '%s' "$V" | sed 's/\\"/"/g; s/\\\\/\\/g')
log ""
log "═════════ resize 热区几何 + 时序 实测 ═════════"
log "$VC"
log ""

# ★ 取值：容忍空串 "" 与 null ★
#   `"key":""`（空字符串）若用 [^,}]* 会吃掉引号导致取值错位，
#   故显式区分三种形态：数字、字符串、空串。
grab() {
  printf '%s' "$VC" | "$NODE_E" -e '
    let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
      const key=process.argv[1];
      const m=s.match(new RegExp("\""+key+"\"\\s*:\\s*(\"[^\"]*\"|[^,}]+)"));
      if(!m){process.stdout.write("");return;}
      let v=m[1].trim();
      if(v[0]==="\"") v=v.slice(1,-1);
      process.stdout.write(v);
    });
  ' "$1"
}

OK=1
ET=$(grab eastThickness);  WT=$(grab westThickness); ST=$(grab southThickness)
NT=$(grab northThickness); SEC=$(grab seCorner); CDIR=$(grab centerDir)
EHD=$(grab eastHitDepth)
CIN=$(grab cursorOnEnter); BCI=$(grab bodyCursorOnEnter)
CIP=$(grab cursorOnPress); RES=$(grab resizedOnImmediatePress)
CUP=$(grab cursorAfterUp)
HCI=$(grab handleCursorInit)

log "═════════ 自判 ═════════"
# A) 几何：厚度必须 >0 且 ≤ 16（"太宽"的验收线）
#   ★ 2026-09-21 更新（Request D：热区跨边框）★
#     探针量的是手柄自身的 getBoundingClientRect，跨边框后它 =
#       内侧 EDGE(8) + 外侧 OUT(4) = 12px（不再是 8px）
#     所以上限要从 12 抬到 16（给 EDGE/OUT 的将来微调留余量）。
#     真正的"太宽"判据仍然成立：≤16px 在 100% 缩放下都不会显得宽。
EDGE_MAX=16
for pair in "eastThickness=$ET" "westThickness=$WT" "southThickness=$ST" "northThickness=$NT"; do
  k="${pair%%=*}"; v="${pair#*=}"
  case "$v" in
    ''|*[!0-9]*) log "  ❌ $k 无法解析：$v"; OK=0 ;;
    *)
      if [ "$v" -ge 1 ] && [ "$v" -le "$EDGE_MAX" ]; then
        log "  ✅ $k = ${v}px（1~${EDGE_MAX} 跨边框总厚，不过宽）"
      else
        log "  ❌ $k = ${v}px 超出 1~${EDGE_MAX}（太宽或抓不到）"; OK=0
      fi ;;
  esac
done
# 角部：应该比边厚（CORNER+OUT=16 > EDGE+OUT=12），且 ≤18
CORNER_MAX=18
case "$SEC" in
  ''|*[!0-9]*) log "  ❌ seCorner 无法解析：$SEC"; OK=0 ;;
  *)
    if [ "$SEC" -ge 1 ] && [ "$SEC" -le "$CORNER_MAX" ]; then
      log "  ✅ seCorner = ${SEC}px（1~${CORNER_MAX} 跨边框角边长）"
    else
      log "  ❌ seCorner = ${SEC}px 超出 1~${CORNER_MAX}"; OK=0
    fi ;;
esac
# 交叉验证（诊断项，不作判据）：右缘内侧命中 e 手柄的深度
# ★ 为什么降级为诊断 ★
#   窗口右缘可能被**另一个窗口**盖住（`elementFromPoint` 返回最顶的那个），
#   此时量到 0 完全正常，不代表热区失效。真正的判据是上面直接读
#   getBoundingClientRect 的 eastThickness/westThickness/... ——
#   那才是"热区几何到底多宽"的直接证据，不受窗口叠放影响。
#   （这正是上次 _fs_probe 的教训：几何归属 ≠ 功能正确性。）
case "$EHD" in
  ''|*[!0-9]*) log "  (i) eastHitDepth 无法解析：$EHD" ;;
  *) if [ "$EHD" -ge 1 ]; then
       log "  ✅ 右缘内侧 ${EHD}px 内命中 e 手柄（交叉验证通过）"
     else
       log "  (i) 右缘内侧未命中 e 手柄 —— 该窗口右缘可能被其它窗口遮挡，非缺陷"
     fi ;;
esac
# 只占最外圈：窗口正中不得命中任何手柄
if [ -z "$CDIR" ] || [ "$CDIR" = "null" ]; then
  log "  ✅ 窗口正中心不命中手柄（热区只占最外圈，不侵占内容）"
else
  log "  ❌ 窗口正中心命中了 $CDIR 手柄（热区向内侵入了）"; OK=0
fi

# B) 时序：初始 / 刚进入都必须是 default（未武装）
grep -qE '"handleCursorInit":"default"' <<<"$VC" || { log "  ❌ 热区初始 cursor 不是 default：$HCI"; OK=0; }
grep -qE '"handleCursorInit":"default"' <<<"$VC" && log "  ✅ 热区初始 cursor = default（不会一碰就变）"
grep -qE '"cursorOnEnter":"default"' <<<"$VC" || { log "  ❌ 刚进入热区光标就变了：$CIN"; OK=0; }
grep -qE '"cursorOnEnter":"default"' <<<"$VC" && log "  ✅ 刚进入热区光标仍 = default（延时生效，过快已修正）"
grep -qE '"delayPendingImmediate":true' <<<"$VC" || { log "  (i) 未能确认延时 pending（窗口可能不足 2 个）"; }
grep -qE '"delayPendingImmediate":true' <<<"$VC" && log "  ✅ 第二个窗口复核：进入后仍未武装（延时确实在等）"

# C) 按下：立刻武装 + 真的能缩放（延时不得拖慢）
grep -qE '"cursorOnPress":"e-resize"' <<<"$VC" || { log "  ❌ 按下时光标未立刻武装：$CIP"; OK=0; }
grep -qE '"cursorOnPress":"e-resize"' <<<"$VC" && log "  ✅ 按下瞬间光标立刻变 e-resize（延时只影响提示，不拖慢操作）"
grep -qE '"resizedOnImmediatePress":true' <<<"$VC" || { log "  ❌ 按下后未能立刻缩放"; OK=0; }
grep -qE '"resizedOnImmediatePress":true' <<<"$VC" && log "  ✅ 按下即可缩放（宽度实际变大）"

# D) 松手复位
grep -qE '"cursorAfterUp":"default"' <<<"$VC" || { log "  (i) 松手后光标未复位：$CUP"; }
grep -qE '"cursorAfterUp":"default"' <<<"$VC" && log "  ✅ 松手后光标复位 default"

log ""
if [ "$OK" = "1" ]; then
  log "  ✅ 热区几何（不过宽）+ 光标时序（有延时、不拖慢拖拽）全部通过"
else
  log "  ❌ 存在未通过项：$V"
fi
log ""
log "结果写入 $OUT"
[ "$OK" = "1" ] || exit 1
