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
# ★ 不写死用户名 ★（曾经写死 `C:/Users/HP/...`，换机后静默退回系统 python）
PY="${PY:-${USERPROFILE:-$HOME}/.workbuddy/binaries/python/envs/default/Scripts/python.exe}"
if [ ! -x "$PY" ]; then PY="${USERPROFILE:-$HOME}/.workbuddy/binaries/python/envs/default/bin/python"; fi
if [ ! -x "$PY" ]; then PY="$(command -v python 2>/dev/null || command -v python3)"; fi
[ -n "$PY" ] || { echo "❌ 找不到可用的 python"; exit 1; }

echo "解释器： $PY"
echo
echo "════════ 1/2 分享功能（含兼容壳回归）════════"
(cd "$ROOT" && "$PY" tools/_test_shares.py)
rc1=$?

echo
echo "════════ 2/2 统一链接模型（直链 /f/ + 分享 /s/ + 迁移）════════"
(cd "$ROOT" && "$PY" tools/_test_links.py)
rc2=$?

rc=0
[ "$rc1" = "0" ] || rc=1
[ "$rc2" = "0" ] || rc=1

if [ "$rc" = "0" ]; then
  echo "✅ 分享 / 统一链接 集成测试全部通过"
else
  echo "❌ 存在失败（分享退出码 $rc1，链接退出码 $rc2）"
fi
exit $rc
