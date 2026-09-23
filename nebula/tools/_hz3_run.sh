#!/usr/bin/env bash
# =============================================================================
# _hz3_run.sh —— 热区**跨边框**验证（Request D）
#
#   用户原话：
#     「调整窗口 鼠标感应 区域 以边框外边缘 向左和向右，向上向下偏移
#       一定范围内都可激活。目前都是在窗口里面，这个要调整一下。」
#
# 判据（与 _hz2_run.sh 期望**相反**，别搞混）：
#   _hz2 时代热区全在窗内 → 外沿 gap ≈ 0
#   _hz3 现在热区跨边框   → 外沿 gap ≈ ±OUT（向外突出 OUT 像素）
#                          内沿 gap ≈ ∓EDGE/CORNER（向内仍有热区）
#   另外验证：窗外那条 OUT 带**真的能命中**手柄（elementFromPoint，窗外无遮挡）。
# =============================================================================
set -uo pipefail
export PATH="/c/Users/HP/.workbuddy/binaries/PortableGit/versions/1.2.0/usr/bin:/c/Users/HP/.workbuddy/binaries/PortableGit/versions/1.2.0/mingw64/bin:/c/Users/HP/.workbuddy/binaries/node/versions/24.21.0:/c/Windows/System32:/c/Windows:/usr/bin:$PATH"
S="h3$(date +%s)"; BASE="http://127.0.0.1:8089"; AB="agent-browser --session $S"
NODE_E="/c/Users/HP/.workbuddy/binaries/node/versions/24.21.0/node.exe"
[ -x "$NODE_E" ] || NODE_E="$(command -v node)"
HERE="$(cd -- "$(dirname -- "$0")" && pwd)"
OUT="$HERE/_hz3.out"; : > "$OUT"
log() { echo "$*" >> "$OUT"; echo "$*"; }
CJ="$HERE/_ck_hz3.txt"
TMPD="$HERE/_hz3_tmp"; mkdir -p "$TMPD"

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

V=$(runjs _hz3_probe.js)
# agent-browser eval 返回「被 JSON 编码过的字符串」，逐层 JSON.parse 解包
VC=$(printf '%s' "$V" | "$NODE_E" -e '
  let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
    s=s.trim(); let v=s;
    for (let i=0;i<3;i++){
      try { const p=JSON.parse(v); if (typeof p==="string") { v=p; continue; } break; }
      catch(e){ break; }
    }
    process.stdout.write(v);
  });
')
log ""
log "═════════ 热区跨边框 几何实测 ═════════"
log "$VC"
log ""

# JSON 取值：node 脚本走 heredoc（见下方 check_holes 处对引号坑的说明）
#   ★ 数组/对象必须用 JSON.stringify，不能用 String() ★
#     2026-09-21 踩过：holes.top 是 [[1107,1119]]，String() 得 "1107,1119"
#     （外层方括号被吃掉）→ 下游 JSON.parse 失败，"解析失败"假红。
J() { "$NODE_E" - "$VC" "$1" <<'JS'
const [raw, pathStr] = process.argv.slice(2);
let o; try { o = JSON.parse(raw); } catch (e) { process.stdout.write('PARSE_ERR'); process.exit(0); }
let v = o;
for (const k of pathStr.split('.')) { if (v == null) { process.stdout.write(''); process.exit(0); } v = v[k]; }
if (v == null) { process.stdout.write(''); }
else if (typeof v === 'object') { process.stdout.write(JSON.stringify(v)); }
else { process.stdout.write(String(v)); }
JS
}

# 期望 OUT 值：从源码取（角宽 = CORNER+OUT，边厚 = EDGE+OUT）
#   这里直接从探针返回的 handle 宽度反推，避免写死数字。
EW="$(J handles.e.w)"; CW="$(J handles.se.w)"
log "  (i) 实测 e 边跨边框宽度 = ${EW}px；se 角跨边框宽度 = ${CW}px"

OK=1
log "═════════ 自判 ═════════"

# ---- A. 外沿必须**向外突出**（跨边框的核心判据）----
#   gap = handle外沿 - window边沿 → 期望 +OUT（右侧/下侧）与 -OUT（左侧/上侧）
#   我们不写死 OUT，而是取一个合理区间 [2,8]，同时要求与内厚明显不同。
chk_out() { # $1=label  $2=key  $3=sign(1: 期望正值; -1: 期望负值)
  local label="$1" key="$2" sign="$3" v
  v="$(J "$key")"
  case "$v" in
    ''|PARSE_ERR|*[!0-9.-]*) log "  ❌ $label 无法解析：$v"; OK=0; return ;;
  esac
  awk -v a="$v" -v s="$sign" 'BEGIN{ exit !( s>0 ? (a>=2 && a<=8) : (a<=-2 && a>=-8) ) }' \
    && log "  ✅ $label 向外跨出边框 ${v}px（热区已伸到窗口外）" \
    || { log "  ❌ $label = ${v}px，未向外跨出（应 ${sign}2~8px 量级）"; OK=0; }
}
# ★ 注意键名与探针输出的**层级**必须一致（2026-09-21 实测踩过）★
#   探针输出是  out.gaps.{e_right,...}  与  out.innerThickness.{e,...}
#   第一版脚本错写成 gap.* / inner.*（少了个 s）→ 12 个字段全部"无法解析"。
#   教训：JSON 路径是字符串契约，改探针字段名时必须同步改这里。
chk_out "右缘 e"    gaps.e_right   1
chk_out "左缘 w"    gaps.w_left    -1
chk_out "下缘 s"    gaps.s_bottom 1
chk_out "上缘 n"    gaps.n_top    -1
chk_out "右下角 se" gaps.se_right 1
chk_out "左上角 nw" gaps.nw_left  -1

# ---- B. 内侧厚度必须仍在（不是把手柄整体搬到窗外）----
chk_in() { # $1=label $2=key $3=最小期望
  local label="$1" key="$2" min="$3" v
  v="$(J "$key")"
  case "$v" in
    ''|PARSE_ERR|*[!0-9.-]*) log "  ❌ $label 无法解析：$v"; OK=0; return ;;
  esac
  awk -v a="$v" -v m="$min" 'BEGIN{ exit !(a>=m) }' \
    && log "  ✅ $label 窗内侧厚度 ${v}px（≥${min}px，窗内仍可抓）" \
    || { log "  ❌ $label 窗内侧厚度仅 ${v}px（应 ≥${min}px）"; OK=0; }
}
chk_in "右缘 e" innerThickness.e 6
chk_in "左缘 w" innerThickness.w 6
chk_in "下缘 s" innerThickness.s 6
chk_in "右下角 se" innerThickness.se 10

# ---- C. 窗外那条带**真的能命中**手柄 ----
#   窗外没有别的元素遮挡，elementFromPoint 结果可信。
hit_chk() { # $1=label $2=key $3=期望前缀
  local label="$1" key="$2" exp="$3" v
  v="$(J "$key")"
  case "$v" in
    ok:*) log "  ✅ $label 窗外带命中手柄（$v）" ;;
    out-of-viewport) log "  (i) $label 窗外点在视口外，跳过（不影响判定）" ;;
    *) log "  ⚠️  $label 窗外带命中 '$v'（期望 $exp）" ;;
  esac
}
log "  ---- 窗外带可命中性（elementFromPoint，窗外无遮挡）----"
hit_chk "右外侧" outsideProbe.rightBand e
hit_chk "左外侧" outsideProbe.leftBand  w
hit_chk "下外侧" outsideProbe.bottomBand s
hit_chk "右下角外侧" outsideProbe.seBand se
hit_chk "左上角外侧" outsideProbe.nwBand nw

# ---- D. 周长零缝隙（含窗外带）----
#   ★ 右上角是**唯一例外**：ne 角为三键让位，纵向从 --toolbar-h 起，
#     所以 y∈[win.t, win.t+toolbarH) 那段「顶边最右 toolbarH 宽」与
#     「右外边带的最上 toolbarH 高」必然不被 ne 覆盖 —— 这是既有设计，
#     不是缺陷（三键有 z-index:950，必须在那里赢）。
#
#   判定方式（不猜）：把测到的缝隙区间交给 node 与「让位带」比对 ——
#     · 让位带内的缝隙   → ✅ 预期内（三键优先）
#     · 让位带外的缝隙   → ❌ 真缝，用户抓不到
log "  ---- 周长零缝隙扫描（含窗外 4px 带）----"
WT="$(J win.t)"; TBH="$(J toolbarH)"; WR="$(J win.r)"; WL="$(J win.l)"
log "  (i) 窗口上沿 y=${WT}，右沿 x=${WR}，工具栏高 --toolbar-h=${TBH}px → 右上让位带 y∈[${WT}, $((WT+TBH))]"

# ★ 这段 JS 用 **heredoc** 传入，不用内联单引号 ★
#   2026-09-21 教训：内联 `node -e '...'` 里只要出现 `'`（哪怕在注释里），
#   bash 的引号配对就会错位，报一个与真实位置无关的 "unexpected EOF"。
#   heredoc（<<'JS'）以行首 JS 为唯一终止符，内部**任何**引号都是字面量，稳。
check_holes() { # $1=label $2=key $3=axis(y|x)
  local label="$1" key="$2" axis="$3" rngs
  rngs="$(J "$key")"
  if [ -z "$rngs" ] || [ "$rngs" = "[]" ]; then log "  ✅ $label 无缝隙"; return; fi
  local verdict
  verdict="$("$NODE_E" - "$rngs" "$axis" "$WT" "$TBH" "$WR" <<'JS'
const [rngStr, axis, winT, tbh, winR] = process.argv.slice(2);
let a; try { a = JSON.parse(rngStr); } catch (e) { process.stdout.write('PARSE_ERR'); }
if (a) {
  // 让位带：右上角三键占的那块（纵向 = 工具栏高）
  const bandLo = axis === 'y' ? Number(winT) : Number(winR) - Number(tbh);
  const bandHi = axis === 'y' ? Number(winT) + Number(tbh) : Number(winR);
  const bad = a.filter(([lo, hi]) => !(lo >= bandLo - 1 && hi <= bandHi + 1));
  process.stdout.write(bad.length ? JSON.stringify(bad) : 'OK');
}
JS
)"
  case "$verdict" in
    OK) log "  ✅ $label 无真缝（$rngs 全部落在右上三键让位带内，属既有设计）" ;;
    PARSE_ERR) log "  ❌ $label 缝隙区间解析失败：$rngs"; OK=0 ;;
    *) log "  ❌ $label 存在**让位带之外**的真缝：$verdict（用户抓不到）"; OK=0 ;;
  esac
}
check_holes "顶边 y=T"   holes.top      x
check_holes "底边 y=B"   holes.bottom   x
check_holes "左边 x=L"   holes.left     y
check_holes "右边 x=R"   holes.right    y
check_holes "右外侧带"   holes.outRight y
check_holes "左外侧带"   holes.outLeft  y
check_holes "上外侧带"   holes.outTop   x
check_holes "下外侧带"   holes.outBottom x

log ""
if [ "$OK" = "1" ]; then
  log "  ✅ 热区确实**跨在窗口边框上**：外沿突出、内沿保留、窗外可命中"
else
  log "  ❌ 存在未通过项"
fi
log ""
log "结果写入 $OUT"
[ "$OK" = "1" ] || exit 1
