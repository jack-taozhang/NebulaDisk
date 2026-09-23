#!/usr/bin/env bash
# 对**运行中的镜像**做分享功能端到端验证（纯 curl，不依赖测试框架）
#
# ★★ cookie jar 必须用 Windows 路径 ★★
#   本机是 Git Bash + **Windows 原生 curl**。给它 MSYS 路径（`/tmp/xxx`）会：
#       curl: (23) client returned ERROR on write
#     并且**不生成 cookie jar** → 后续所有请求都没票据 → /api/list 返回空
#     → 脚本报「✗ 没找到可分享的文件」。看起来像"库里没文件"，
#     其实是脚本自己把票据丢了。**这种静默失败比报错更坏**，所以下面两道措施：
#       ① 统一走 winpath() 转 `D:/...`
#       ② 登录结果显式校验，不 ok 直接退出，绝不带着空票据往下跑
set -uo pipefail
HERE="$(cd -- "$(dirname -- "$0")" && pwd)"
BASE=http://127.0.0.1:8089
TMPD="$HERE/_share_e2e_tmp"
rm -rf "$TMPD"; mkdir -p "$TMPD"
JAR="$TMPD/jar.txt"

winpath() {
  local p="$1"
  if command -v cygpath >/dev/null 2>&1; then cygpath -m "$p"; return; fi
  printf '%s' "$p" | sed -E 's#^/([a-zA-Z])/#\1:/#'
}

LOGIN="$(curl -s -X POST "$BASE/api/login" \
  -d "username=admin&password=${NEBULA_TEST_PASSWORD:-dev-pass-not-real}" -c "$(winpath "$JAR")")"
if ! printf '%s' "$LOGIN" | grep -q '"ok":true'; then
  echo "✗ 登录失败，无法继续：$LOGIN"
  echo "  （票据文件：$JAR）"
  exit 1
fi
echo "登录 OK"

# 找一个真实存在的文件（排除目录）
ENT=$(curl -s -b "$(winpath "$JAR")" "$BASE/api/list?mount=%E5%85%B1%E4%BA%AB&path=/")
FILE=$(printf '%s' "$ENT" | tr '{' '\n' | grep '"isDir":false' | head -1 |
       sed -n 's/.*"name":"\([^"]*\)".*/\1/p')
echo "选中的文件：$FILE"
[ -n "$FILE" ] || { echo "✗ 没找到可分享的文件"; exit 1; }

echo
echo "=== 创建分享（ttl 1 天、无密码）==="
R=$(curl -s -b "$(winpath "$JAR")" -X POST "$BASE/api/shares" \
     --data-urlencode "mount=共享" \
     --data-urlencode "path=/$FILE" \
     -d "ttl_days=1&max_visits=0&password=&note=curl-e2e")
echo "$R"
TOK=$(printf '%s' "$R" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
[ -n "$TOK" ] || { echo "✗ 没拿到 token"; exit 1; }
echo "token 长度：${#TOK}"

code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

echo
echo "=== 访客侧（完全不带 Cookie）==="
echo "  短链 /s/<token>          → $(code "$BASE/s/$TOK")        （期望 200）"
echo "  /api/s/<token>           → $(code "$BASE/api/s/$TOK")        （期望 200，返回落地页 HTML）"
echo "  /api/s/<token>/list      → $(code "$BASE/api/s/$TOK/list?path=/")        （期望 200）"
printf '  列表内容：'
curl -s "$BASE/api/s/$TOK/list?path=/" | head -c 260
echo
echo
echo "=== 安全边界 ==="
echo "  伪造 token               → $(code "$BASE/s/abcdefghijklmnopqrstuvwxyz012345")        （期望 404）"
echo "  穿越 path=../            → $(code "$BASE/api/s/$TOK/list?path=../")        （期望 4xx）"
echo "  穿越 path=../../        → $(code "$BASE/api/s/$TOK/list?path=../../")        （期望 4xx）"

echo
echo "=== 撤销 ==="
curl -s -b "$(winpath "$JAR")" -X POST "$BASE/api/shares/revoke" -d "token=$TOK"; echo
echo "  撤销后短链               → $(code "$BASE/s/$TOK")        （期望 404）"

rm -rf "$TMPD"
