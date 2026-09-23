#!/usr/bin/env bash
# =============================================================================
# run_share_tests.sh —— 跑分享功能的集成测试
#
#   ★ 为什么单独一个脚本、不并进 run_unit_tests.sh ★
#     那套跑的是**纯 JS**逻辑，解释器是 node；
#     分享测试是 **Python + FastAPI TestClient**（要真的走 HTTP 路由、
#     真的建库、真的验路径穿越），解释器与依赖都不同，混在一起只会更脆。
#
#   用法：  bash nebula/tools/run_share_tests.sh
#   退出码：0 = 全绿
# =============================================================================
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"

# 优先用隔离 venv（装好了 fastapi/bcrypt/httpx/python-multipart）
PY="${PY:-/c/Users/HP/.workbuddy/binaries/python/envs/default/Scripts/python.exe}"
if [ ! -x "$PY" ]; then PY="$(command -v python 2>/dev/null || command -v python3)"; fi
[ -n "$PY" ] || { echo "❌ 找不到可用的 python"; exit 1; }

echo "解释器： $PY"
(cd "$ROOT" && "$PY" tools/_test_shares.py)
rc=$?

if [ "$rc" = "0" ]; then
  echo "✅ 分享集成测试全部通过"
else
  echo "❌ 分享集成测试存在失败（退出码 $rc）"
fi
exit $rc
