#!/usr/bin/env bash
# ==========================================================================
# NebulaDisk API 契约测试 —— 薄封装
#
# 【重要】真正的断言在 tools/e2e_api.py 里，这里只负责找到 python 并调用它。
#
# 本脚本已废弃原先的纯 bash + curl 实现，原因：
#   本机 curl 8.21.0 (Windows) 在 Git Bash 下有两个坑 ——
#     1) 不把 HttpOnly cookie 写进 jar（症状：全站 401，像鉴权坏了）
#     2) /tmp 映射到 Windows 路径，curl -o 写不出来（症状：000 / 空文件）
#   同一份逻辑换 httpx 跑完全正常，所以测试端统一走 Python。
# ==========================================================================
set -uo pipefail

SELF="${BASH_SOURCE[0]:-$0}"
HERE="$(cd -- "$(dirname -- "$SELF")" 2>/dev/null && pwd -W 2>/dev/null || pwd)"
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

exec "$PY" -X utf8 "$HERE/tools/e2e_api.py" "$@"
