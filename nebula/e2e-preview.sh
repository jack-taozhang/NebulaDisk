#!/usr/bin/env bash
# ==========================================================================
# NebulaDisk 真实预览链路验证 —— 薄封装
#
# 【重要】真正的断言在 tools/e2e_preview.py 里，这里只负责找到 python 并调用它。
#
# 为什么不用纯 bash + curl：
#   本机 curl 8.21.0 (Windows) 在 Git Bash 下**不把 HttpOnly cookie 写进 jar**
#   （服务端 set-cookie 完全正常，jar 里就是 0 行），后续请求全部 401，
#   极易误判成"云盘鉴权坏了"。同一份逻辑换 httpx 跑完全正常，故统一走 Python。
# ==========================================================================
set -uo pipefail

# 脚本所在目录。用 $(cd ... && pwd) 在 Git Bash 下会把盘符拼错
# （得到 D:\d\Docker\... 这种），所以这里直接用 ${BASH_SOURCE[0]} 的目录名，
# 再交给 python 侧解析 —— Python 的 os.path 处理 Windows 路径更可靠。
SELF="${BASH_SOURCE[0]:-$0}"
HERE="$(cd -- "$(dirname -- "$SELF")" 2>/dev/null && pwd -W 2>/dev/null || pwd)"
# 兜底：若仍拿不到合法路径，退回已知仓库位置
case "$HERE" in
  *nebula) ;;
  *) HERE="D:/Docker/kkFileView/nebula" ;;
esac

PY=""
for c in "/c/Users/HP/.workbuddy/binaries/python/envs/default/Scripts/python.exe" \
         "/c/Users/HP/.workbuddy/binaries/python/versions/3.13.12/python.exe" \
         "$HERE/.venv/Scripts/python.exe" \
         "$HERE/.venv/bin/python" \
         "python" "python3"; do
  if command -v "$c" >/dev/null 2>&1 || [ -x "$c" ]; then PY="$c"; break; fi
done

if [ -z "$PY" ]; then
  echo "找不到可用的 python，请设置 PATH 或安装依赖后重试" >&2
  exit 1
fi

exec "$PY" -X utf8 "$HERE/tools/e2e_preview.py" "$@"
