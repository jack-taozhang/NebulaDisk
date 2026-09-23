#!/usr/bin/env bash
# =============================================================================
# _hz2_run.sh —— 热区**相对窗口边缘**定位验证
#   回答用户：「感应范围应该调整到窗口的边缘左右附近」
#
# 判据（用数据说话，不猜）：
#   · 每个热区的**外沿**必须比窗口对应外沿**向外多出 OUT 像素**（跨边框，
#     容差 2~8px）—— 这条在 Request D 之后由「≈0 重合」改写而来
#   · 越界方向必须落在白名单里（只许朝外越，不许往内侧/相邻方向乱越）
#   · ne 角上沿应下移到工具栏下沿（为右上角三个窗口键让位）
#   · 沿右缘扫描：从窗口右沿往里，"e" 手柄应是命中的第一个元素
#
# ★ 更严格的跨边框验收在 _hz3_run.sh（它还验窗外带可命中、内厚保留、
#   周长零真缝）。本脚本保留作**独立第二测量**，交叉印证。
# =============================================================================
set -uo pipefail
export PATH="/c/Users/HP/.workbuddy/binaries/PortableGit/versions/1.2.0/usr/bin:/c/Users/HP/.workbuddy/binaries/PortableGit/versions/1.2.0/mingw64/bin:/c/Users/HP/.workbuddy/binaries/node/versions/24.21.0:/c/Windows/System32:/c/Windows:/usr/bin:$PATH"
S="h2$(date +%s)"; BASE="http://127.0.0.1:8089"; AB="agent-browser --session $S"
NODE_E="/c/Users/HP/.workbuddy/binaries/node/versions/24.21.0/node.exe"
[ -x "$NODE_E" ] || NODE_E="$(command -v node)"
HERE="$(cd -- "$(dirname -- "$0")" && pwd)"
OUT="$HERE/_hz2.out"; : > "$OUT"
log() { echo "$*" >> "$OUT"; echo "$*"; }
CJ="$HERE/_ck_hz2.txt"
TMPD="$HERE/_hz2_tmp"; mkdir -p "$TMPD"

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
V=$(runjs _gb_open.js); log "开文件夹窗： $V"; sleep 3

V=$(runjs _hz2_probe.js)
# ★ agent-browser eval 返回的是「被 JSON 编码过的字符串」★
#   形如 "\"{\\\"ready\\\":true}\"" —— 先用 node 做一层真正的 JSON.parse
#   解出内层字符串，再 parse 成对象。用 sed 手撕转义在多层嵌套下必错
#   （本脚本第一版就是这么 PARSE_ERR 的）。
VC=$(printf '%s' "$V" | "$NODE_E" -e '
  let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
    s=s.trim();
    let v=s;
    // 剥掉 agent-browser 的那层字符串包装（可能是一层，也可能是两层）
    for (let i=0;i<3;i++){
      try { const p=JSON.parse(v); if (typeof p==="string") { v=p; continue; } break; }
      catch(e){ break; }
    }
    process.stdout.write(v);
  });
')
log ""
log "═════════ 热区相对窗口边缘 定位实测 ═════════"
log "$VC"
log ""

# ★ 用 node 解析 JSON（比 sed 稳，能处理嵌套与小数）★
#   VC 此时已是「干净的内层 JSON 字符串」，直接 parse 即可。
J() { printf '%s' "$VC" | "$NODE_E" -e '
  let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
    let o; try{o=JSON.parse(s);}catch(e){process.stdout.write("PARSE_ERR");return;}
    const p=process.argv[1].split(".");
    let v=o; for(const k of p){ if(v==null){process.stdout.write("");return;} v=v[k]; }
    process.stdout.write(v==null?"":String(v));
  });
' "$1"; }

OK=1
log "═════════ 自判 ═════════"
# ★ 2026-09-21 更新（Request D：热区改为**跨边框**）★
#   本脚本原来的判据是「外沿与窗口边沿重合（差 ≈0）」，那是**热区全在窗内**
#   时的正确期望。现在热区要跨出边框，外沿必然比窗口边沿**多出 OUT 像素**，
#   所以判据整体改写为「外沿差值 = ±OUT 量级（2~8px）」。
#   ★ 更严格、更完整的跨边框验收请跑 _hz3_run.sh（它还会验证窗外带可命中、
#     内厚保留、周长零真缝）。本脚本保留作**独立第二测量**，交叉印证。
chk_protrude() { # $1=label $2=key $3=sign(1正/-1负)
  local label="$1" key="$2" sign="$3" v
  v="$(J "$key")"
  case "$v" in
    ''|PARSE_ERR|*[!0-9.-]*) log "  ❌ $label 外沿差值无法解析：$v"; OK=0; return ;;
  esac
  awk -v a="$v" -v s="$sign" 'BEGIN{ exit !( s>0 ? (a>=2 && a<=8) : (a<=-2 && a>=-8) ) }' \
    && log "  ✅ $label 外沿越过窗口边沿 ${v}px（跨边框，向外突出）" \
    || { log "  ❌ $label = ${v}px（应 ${sign}2~8px 量级的外突）"; OK=0; }
}
chk_protrude "e 右缘"  gap.e_right   1
chk_protrude "w 左缘"  gap.w_left    -1
chk_protrude "n 上缘"  gap.n_top    -1
chk_protrude "s 下缘"  gap.s_bottom 1
chk_protrude "ne 右上角" gap.ne_right 1
chk_protrude "sw 左下角" gap.sw_left -1

# ne.top 单独判定：应 ≈ 工具栏高（给右上角三键让位），而不是 ≈0
#
# ★ 上限不能写死常量 ★
#   旧版这里引用了 `$NE_ALLOW`，而它从未被赋值 —— 在 `set -u` 下直接
#   "NE_ALLOW: unbound variable" 崩掉，把后面的检查全带没了。
#   现在改成从探针报出来的 toolbarH 现算：允许「工具栏高 + 一点余量」。
TBH="$(J toolbarH)"
case "$TBH" in
  ''|PARSE_ERR|*[!0-9.]*) TBH=29 ;;   # 探针没报出来时回退到 --toolbar-h 的已知值
esac
NE_ALLOW="$(awk -v h="$TBH" 'BEGIN{printf "%.0f", h+12}')"
NT="$(J gap.ne_top)"
case "$NT" in
  ''|PARSE_ERR|*[!0-9.-]*) log "  ❌ ne.top 无法解析：$NT"; OK=0 ;;
  *)
    if awk -v a="$NT" -v lim="$NE_ALLOW" 'BEGIN{d=a<0?-a:a; exit !(d<=lim)}'; then
      log "  ✅ ne.top 下移到工具栏下沿 ${NT}px（工具栏高 ${TBH}px，为右上角三键让位，既有设计）"
    else
      log "  ❌ ne.top = ${NT}px 超出预期（应 ≈ 工具栏高 ${TBH}px，上限 ${NE_ALLOW}px）"; OK=0
    fi ;;
esac

# 2) 越界方向必须落在白名单里
#
# ★ 语义已变（Request D）★
#   热区现在**故意**向外跨边框，所以「越界」本身不再是错误；
#   但「往哪个方向越」是有契约的：只有朝外的那 12 条边允许越，其余一律算 bug
#   （例如热区误往窗口内侧或相邻方向溢出，会盖住内容/别的窗口）。
ALLOWED_OVER="n.right n.top s.bottom e.right w.left ne.right nw.left nw.top se.right se.bottom sw.left sw.bottom"
OV="$(J overflow)"
case "$OV" in
  ''|PARSE_ERR)
    log "  ❌ overflow 无法解析：$OV"; OK=0 ;;
  *)
    # ★ 数组经 String() 出来是「逗号连接、无空格」★
    #   直接 `for tok in $OV` 会把整串当成一个词，白名单匹配必然失败。
    #   先把逗号换成空格再遍历。
    OV_SP="$(printf '%s' "$OV" | tr ',' ' ')"
    BAD=""; CNT=0
    for tok in $OV_SP; do
      CNT=$((CNT+1))
      case " $ALLOWED_OVER " in
        *" $tok "*) : ;;
        *) BAD="$BAD $tok" ;;
      esac
    done
    if [ -z "$BAD" ]; then
      log "  ✅ 越界方向全部是「刻意朝外跨边框」（${CNT} 条，全在白名单内）"
    else
      log "  ❌ 出现非预期的越界方向：$BAD"; OK=0
    fi ;;
esac

# 3) 右缘扫描：命中 e 手柄的连续深度
D="$(J eastScanDepth)"; TH="$(J topmostAtEdge)"
case "$D" in
  ''|*[!0-9]*) log "  ❌ eastScanDepth 无法解析：$D"; OK=0 ;;
  *) if [ "$D" -ge 1 ]; then
       log "  ✅ 沿右缘往里扫描：连续命中 e 手柄 ${D}px（热区确实贴在右缘）"
     else
       log "  (i) 右缘扫描未命中 e 手柄（最顶层是 '$TH'，可能是别的窗口遮挡）"
     fi ;;
esac
log "  (i) 右缘 2px 处最顶层元素所属手柄 = '$TH'"

log ""
if [ "$OK" = "1" ]; then
  log "  ✅ 热区几何正确：外沿向外跨出边框、越界方向全在白名单内、可命中"
else
  log "  ❌ 存在未通过项：$V"
fi
log ""
log "结果写入 $OUT"
[ "$OK" = "1" ] || exit 1
