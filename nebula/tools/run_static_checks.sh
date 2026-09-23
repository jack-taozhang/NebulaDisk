#!/usr/bin/env bash
# =============================================================================
# run_static_checks.sh —— 后端静态检查（不需要 docker、不需要运行中的服务）
#
# 为什么要有它（两个都是真实事故）：
#
#   ① 名字解析
#     2026-09-21 把 app/main.py 拆成 app/routers/ 包后，`make_raw_url` 留在了
#     rawlink.py 而 onlyoffice / preview / cad 三个 router 没 import 它。
#     后果是 **OnlyOffice + kkFileView + CAD 三条预览链路全部 500**
#     （前端只看到「无法打开编辑器 Internal Server Error」），
#     而当时的下述检查**全绿**：
#        · run_unit_tests.sh（8 套 JS 单测）—— 只覆盖前端
#        · selfcheck.py「全部自检通过」—— 只校验**路由是否存在**
#        · python -c "import app.main" —— 导入不执行函数体
#     ⇒ 这类「只在调用路径上炸」的错误必须靠静态名字解析兜住。
#
#   ② 换行符 CRLF
#     在 Windows 上用 `Path.write_text()` 打补丁会把整个文件变成 CRLF
#     （write_text 按 os.linesep 转换）。`.py` 无所谓，**`.sh` 在 Linux 上
#     直接语法错误**（`set: pipefail: invalid option name`）。
#     ★ 关键是 **Git Bash 容忍 CRLF、Linux 不容忍** ★
#     ⇒ 本地怎么测都是绿的，一推到 NAS 才炸。必须显式检查。
#
# 三步：
#   1) nebula/app/ 名字解析（期望 0 处）
#   2) 换行符（nebula/ + deploy/ + 根级脚本，期望 0 个 CRLF；src/ 是上游，不扫）
#   3) ★ 两套护栏的自检 ★ —— 拿夹具跑一遍，必须**恰好**报出预期数量。
#      护栏自己没被验证过 = 没有护栏。
# =============================================================================
set -uo pipefail

HERE="$(cd -- "$(dirname -- "$0")" && pwd)"
ROOT="$HERE/../.."
APP="$HERE/../app"
FIX="$HERE/_undef_fixtures"
EOLFIX="$HERE/_eol_fixtures"
CHECK="$HERE/check_undefined.py"
EOL="$HERE/check_eol.py"

# ★★ MSYS 路径必须转给原生 Windows 程序 ★★
#   `/d/Docker/...` 会被 Windows Python 解析成 `D:\d\Docker\...`（盘符 + 字面 d）
#   → "can't open file" → 检查器返回非 0 → 被误判成「检查失败」。
winpath() {
  local p="$1"
  if command -v cygpath >/dev/null 2>&1; then cygpath -m "$p"; return; fi
  printf '%s' "$p" | sed -E 's#^/([a-zA-Z])/#\1:/#'
}

# 找一个能用的 python
PY=""
for c in \
  "C:/Users/HP/.workbuddy/binaries/python/envs/default/Scripts/python.exe" \
  "python3" "python" ; do
  if command -v "$c" >/dev/null 2>&1; then PY="$c"; break; fi
  [ -x "$c" ] && { PY="$c"; break; }
done
[ -n "$PY" ] || { echo "❌ 找不到 python"; exit 1; }

FAIL=0

# ---------------------------------------------------------------------------
echo
echo "════════ 1/3 后端名字解析（nebula/app/）════════"
if "$PY" "$(winpath "$CHECK")" "$(winpath "$APP")"; then
  echo "  ✅ 通过"
else
  echo "  ❌ 有未定义名 —— 这些会在**调用时**才 NameError（往往表现为 500）"
  FAIL=1
fi

# ---------------------------------------------------------------------------
echo
echo "════════ 2/3 换行符（nebula/ deploy/ 根级脚本；src/ 是上游不扫）════════"
# ★ 必须在 $ROOT 下用「相对路径 + .」调用 ★
#   check_eol.py 对「当前目录」这个扫描根只挑根级文件名白名单（build.sh、
#   Dockerfile、.dockerignore…）；传绝对路径会被当成普通目录整棵递归，
#   于是把上游 `src/`（本身就是 CRLF）全报出来 —— 那是假红。
EOLREPOUT="$(cd "$ROOT" && "$PY" "$(winpath "$EOL")" nebula deploy . 2>&1)"
EOLRC=$?
# 输出可能很长，只打前 30 行（判定不看文本，看退出码）
printf '%s\n' "$EOLREPOUT" | head -30 | sed 's/^/  /'
if [ "$EOLRC" = "0" ]; then
  echo "  ✅ 通过"
else
  echo "  ❌ 有 CRLF 文件 —— Linux 上 bash 会直接语法错误"
  echo "     （★ 修的时候别用 write_text：Windows 上它会把 \\n 又写回 \\r\\n ★）"
  FAIL=1
fi

# ---------------------------------------------------------------------------
echo
echo "════════ 3/3 护栏自检 ════════"

echo "  ── 3a 名字解析护栏（_undef_fixtures/）──"
FIXOUT="$("$PY" "$(winpath "$CHECK")" "$(winpath "$FIX")" 2>&1)"
printf '%s\n' "$FIXOUT" | sed 's/^/    /'

# 必须报出两个坏例名，且**恰好 2 处**（多出来的就是假红）
n_bad=$(printf '%s\n' "$FIXOUT" | grep -c '✗' || true)
if grep -q '名字 `make_raw_url` ' <<<"$FIXOUT" \
   && grep -q '名字 `Request` '      <<<"$FIXOUT" \
   && [ "$n_bad" = "2" ]; then
  echo "    ✅ 两个坏例都被抓到，且正例无假红（共 ${n_bad} 处）"
else
  echo "    ❌ 期望恰好 2 处（make_raw_url / Request），实得 ${n_bad} 处"
  echo "       报多了 = 假红（正例被误伤）；报少了 = 护栏失效。两种都要修。"
  FAIL=1
fi
# 正例文件绝不能被点名
if printf '%s\n' "$FIXOUT" | grep -q 'good_scopes.py'; then
  echo "    ❌ 正例 good_scopes.py 被误报（假红）—— 假红的护栏一定会被绕过"
  FAIL=1
else
  echo "    ✅ 正例 good_scopes.py 无误报"
fi
# import * 必须明说跳过
if printf '%s\n' "$FIXOUT" | grep -q '跳过（含 `import \*`'; then
  echo "    ✅ import * 的文件被明确跳过（不假装通过）"
else
  echo "    ❌ import * 的文件没有被明确标注跳过"
  FAIL=1
fi

echo "  ── 3b 换行符护栏（_eol_fixtures/）──"
EOLOUT="$("$PY" "$(winpath "$EOL")" --include-fixtures "$(winpath "$EOLFIX")" 2>&1)"
printf '%s\n' "$EOLOUT" | sed 's/^/    /'

n_eol=$(printf '%s\n' "$EOLOUT" | grep -c 'crlf_bad.sh' || true)
if [ "$n_eol" -ge 1 ]; then
  echo "    ✅ CRLF 坏例被抓到"
else
  echo "    ❌ 没抓到 crlf_bad.sh —— 护栏失效（这正是「推到 NAS 才炸」那次的情形）"
  FAIL=1
fi
if printf '%s\n' "$EOLOUT" | grep -q 'lf_good.sh'; then
  echo "    ❌ LF 正例 lf_good.sh 被误报（假红）"
  FAIL=1
else
  echo "    ✅ LF 正例 lf_good.sh 无误报"
fi
if printf '%s\n' "$EOLOUT" | grep -q 'README.md'; then
  echo "    ❌ 夹具目录里的 LF 的 README.md 被误报（假红）"
  FAIL=1
else
  echo "    ✅ 夹具里的 LF 文件（README.md）无误报"
fi

# ---------------------------------------------------------------------------
echo
if [ "$FAIL" = "0" ]; then
  echo "════════ ✅ 静态检查全部通过 ════════"
else
  echo "════════ ❌ 静态检查未通过 ════════"
fi
echo
exit "$FAIL"
