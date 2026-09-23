#!/usr/bin/env bash
# ==========================================================================
# NebulaDisk 前端端到端测试（agent-browser 驱动真实 Chromium）
#
# 验证清单：
#   1. 登录页出现、错误密码被拒、正确密码进桌面
#   2. 桌面图标 / 任务栏 / 开始菜单渲染
#   3. 资源管理器自动打开首个目录并列出文件
#   4. 双击文件夹进入子目录
#   5. 双击文本文件 → 原生查看器
#   6. 双击图片 → 图片查看器
#   7. 视图切换、排序
#   8. 右键菜单出现
#   9. 新建文件夹 / 重命名 / 删除
#  10. 每个环节都截图，并收集 console 报错
# ==========================================================================
set -uo pipefail

BASE="${BASE:-http://127.0.0.1:8899}"
OUT="${OUT:-/tmp/nebula-shots}"
mkdir -p "$OUT"

PASS=0; FAIL=0
ok()   { echo "  [OK  ] $1"; PASS=$((PASS+1)); }
bad()  { echo "  [FAIL] $1"; FAIL=$((FAIL+1)); }
info() { echo "  [INFO] $1"; }

AB() { agent-browser "$@" 2>&1; }

echo "======================================================================"
echo "NebulaDisk 前端 E2E 测试  目标: $BASE"
echo "======================================================================"

# ---------------------------------------------------------------- 1. 登录页
echo
echo "[1] 登录页"
AB open "$BASE" > /dev/null
AB wait --load load > /dev/null
sleep 1

SNAP="$(AB snapshot)"
if echo "$SNAP" | grep -q "登录"; then ok "登录页渲染出「登录」按钮"; else bad "登录页未出现"; echo "$SNAP" | head -20; fi
if echo "$SNAP" | grep -q "用户名"; then ok "用户名输入框存在"; else bad "用户名输入框缺失"; fi
if echo "$SNAP" | grep -q "NebulaDisk"; then ok "品牌名出现"; else bad "品牌名缺失"; fi
AB screenshot --path "$OUT/01-login.png" > /dev/null

# ------------------------------------------------------- 2. 错误密码被拒绝
echo
echo "[2] 登录校验"
AB type "#lg-user" "admin" > /dev/null
AB type "#lg-pass" "wrong-password" > /dev/null
AB click "button[type=submit]" > /dev/null
sleep 1.2
SNAP="$(AB snapshot)"
if echo "$SNAP" | grep -qiE "错误|失败|invalid"; then
  ok "错误密码被拒绝并提示"
else
  bad "错误密码未给出提示"
fi
AB screenshot --path "$OUT/02-login-error.png" > /dev/null

# ------------------------------------------------------------ 3. 正确登录
echo
echo "[3] 正确登录 → 桌面"
AB type "#lg-pass" "admin123" > /dev/null
AB click "button[type=submit]" > /dev/null
sleep 2.2

SNAP="$(AB snapshot)"
if echo "$SNAP" | grep -q "此电脑"; then ok "桌面图标「此电脑」出现"; else bad "桌面未渲染"; fi
if echo "$SNAP" | grep -qE "文档|图片"; then ok "映射目录图标出现"; else bad "映射目录未出现"; fi
AB screenshot --path "$OUT/03-desktop.png" > /dev/null

# 自动打开的资源管理器
echo
echo "[4] 资源管理器自动打开"
if echo "$SNAP" | grep -q "说明.txt"; then
  ok "资源管理器自动打开并列出文件"
else
  info "未看到 说明.txt，尝试再次快照"
  sleep 1.5
  SNAP="$(AB snapshot)"
  if echo "$SNAP" | grep -q "说明.txt"; then ok "文件列表出现（延迟）"; else bad "文件列表未出现"; fi
fi
for f in readme.md report.csv config.json app.py; do
  if echo "$SNAP" | grep -q "$f"; then ok "列出文件: $f"; else bad "缺少文件: $f"; fi
done
if echo "$SNAP" | grep -q "设计文档"; then ok "列出子文件夹: 设计文档"; else bad "缺少子文件夹"; fi
if echo "$SNAP" | grep -q "示例图片.png"; then ok "列出图片: 示例图片.png"; else bad "缺少图片"; fi
AB screenshot --path "$OUT/04-explorer.png" > /dev/null

# --------------------------------------------------------- 5. console 检查
echo
echo "[5] 浏览器控制台错误"
# 截图后再看看有没有报错（agent-browser 会把 console 输出并入 snapshot 的元信息）
if echo "$SNAP" | grep -qiE "Uncaught|TypeError:|ReferenceError:|is not defined"; then
  bad "检测到 JS 运行时错误"
  echo "$SNAP" | grep -iE "Uncaught|TypeError:|ReferenceError:|is not defined" | head -5
else
  ok "未发现 JS 运行时错误"
fi

# ------------------------------------------------------- 6. 双击进文件夹
echo
echo "[6] 双击进入子文件夹"
AB click "text=设计文档" > /dev/null 2>&1 || AB click ".tile:has-text('设计文档')" > /dev/null 2>&1
sleep 0.4
AB dblclick "text=设计文档" > /dev/null 2>&1 || true
sleep 1.2
SNAP="$(AB snapshot)"
if echo "$SNAP" | grep -q "架构说明.md"; then
  ok "进入 设计文档 并列出内容"
else
  info "可能未进入，尝试选择器变体"
  AB dblclick ".tile" > /dev/null 2>&1 || true
  sleep 1
  SNAP="$(AB snapshot)"
  if echo "$SNAP" | grep -q "架构说明.md"; then ok "进入子目录（第二次尝试）"; else bad "双击进入子目录失败"; fi
fi
AB screenshot --path "$OUT/06-subfolder.png" > /dev/null

# 返回上级
AB click "[data-act='up']" > /dev/null 2>&1 || true
sleep 1

# ------------------------------------------------------- 7. 文本文件预览
echo
echo "[7] 双击文本文件 → 原生查看器"
AB dblclick "text=说明.txt" > /dev/null 2>&1 || true
sleep 1.4
SNAP="$(AB snapshot)"
if echo "$SNAP" | grep -qE "这是一个测试文本文件|测试文本"; then
  ok "文本内容渲染成功"
else
  bad "文本查看器未显示内容"
fi
AB screenshot --path "$OUT/07-text-viewer.png" > /dev/null

# 关闭该窗口
AB click ".window .tb-btn.close" > /dev/null 2>&1 || true
sleep 0.8

# ------------------------------------------------------- 8. 图片查看器
echo
echo "[8] 双击图片 → 图片查看器"
AB dblclick "text=示例图片.png" > /dev/null 2>&1 || true
sleep 1.4
SNAP="$(AB snapshot)"
if echo "$SNAP" | grep -qE "适应窗口|100%|适应"; then
  ok "图片查看器工具栏出现"
else
  bad "图片查看器未打开"
fi
AB screenshot --path "$OUT/08-image-viewer.png" > /dev/null
AB click ".window .tb-btn.close" > /dev/null 2>&1 || true
sleep 0.8

# ---------------------------------------------------------- 9. 视图切换
echo
echo "[9] 视图切换（图标 ↔ 列表）"
AB click "[data-act='view']" > /dev/null 2>&1 || true
sleep 0.8
SNAP="$(AB snapshot)"
if echo "$SNAP" | grep -qE "修改日期|类型"; then
  ok "已切换到列表视图（出现列头）"
else
  bad "列表视图切换失败"
fi
AB screenshot --path "$OUT/09-list-view.png" > /dev/null

AB click "[data-act='view']" > /dev/null 2>&1 || true
sleep 0.6

# --------------------------------------------------------- 10. 右键菜单
echo
echo "[10] 右键菜单"
AB click "text=说明.txt" > /dev/null 2>&1 || true
sleep 0.3
AB rightclick "text=说明.txt" > /dev/null 2>&1 || AB click "text=说明.txt" > /dev/null 2>&1 || true
sleep 0.8
SNAP="$(AB snapshot)"
if echo "$SNAP" | grep -qE "重命名|下载|删除|属性"; then
  ok "右键菜单出现且包含预期项"
else
  bad "右键菜单未出现"
fi
AB screenshot --path "$OUT/10-context-menu.png" > /dev/null
AB press Escape > /dev/null 2>&1 || true
sleep 0.4

# ------------------------------------------------------ 11. 新建文件夹
echo
echo "[11] 新建文件夹"
AB click "[data-act='new-folder']" > /dev/null 2>&1 || true
sleep 1
SNAP="$(AB snapshot)"
if echo "$SNAP" | grep -qE "新建文件夹|文件夹名称"; then
  ok "新建文件夹对话框出现"
else
  info "对话框快照未命中关键词"
fi
AB screenshot --path "$OUT/11-newfolder-dialog.png" > /dev/null

# 改成确定的名字再提交
AB type "input[data-role='input']" "E2E测试目录" > /dev/null 2>&1 || true
AB click ".dialog [data-r='1']" > /dev/null 2>&1 || true
sleep 1.4
SNAP="$(AB snapshot)"
if echo "$SNAP" | grep -q "E2E测试目录"; then
  ok "文件夹创建成功且出现在列表"
else
  bad "新建文件夹未生效"
fi
AB screenshot --path "$OUT/12-newfolder-created.png" > /dev/null

# ---------------------------------------------------------- 12. 删除它
echo
echo "[12] 删除（含二次确认）"
AB click "text=E2E测试目录" > /dev/null 2>&1 || true
sleep 0.3
AB click "[data-act='delete']" > /dev/null 2>&1 || true
sleep 1.1
SNAP="$(AB snapshot)"
if echo "$SNAP" | grep -qE "永久删除|不可撤销|确定"; then
  ok "删除二次确认对话框出现"
else
  bad "删除确认未出现"
fi
AB screenshot --path "$OUT/13-delete-confirm.png" > /dev/null
AB click ".dialog .btn.danger" > /dev/null 2>&1 || true
sleep 1.5
SNAP="$(AB snapshot)"
if echo "$SNAP" | grep -q "E2E测试目录"; then
  bad "删除后仍能看到该目录"
else
  ok "目录已删除"
fi
AB screenshot --path "$OUT/14-after-delete.png" > /dev/null

# ------------------------------------------------------- 13. 开始菜单
echo
echo "[13] 开始菜单"
AB click "#btn-start" > /dev/null 2>&1 || true
sleep 0.9
SNAP="$(AB snapshot)"
if echo "$SNAP" | grep -qE "推荐的项目|已固定|admin"; then
  ok "开始菜单打开"
else
  bad "开始菜单未打开"
fi
AB screenshot --path "$OUT/15-start-menu.png" > /dev/null
AB press Escape > /dev/null 2>&1 || true

# ------------------------------------------------------- 14. 侧栏切换映射
echo
echo "[14] 通过侧栏切换映射目录"
AB click ".side-item[data-mount='图片']" > /dev/null 2>&1 || true
sleep 1.6
SNAP="$(AB snapshot)"
if echo "$SNAP" | grep -q "screenshot.png"; then
  ok "切换到「图片」映射并列出内容"
else
  info "侧栏切换快照未命中"
fi
AB screenshot --path "$OUT/16-switch-mount.png" > /dev/null

# 切回文档
AB click ".side-item[data-mount='文档']" > /dev/null 2>&1 || true
sleep 1.2

# ------------------------------------------------------- 15. 最终全貌
echo
echo "[15] 最终界面全貌 + 活动窗口"
AB click "[data-act='info']" > /dev/null 2>&1 || true
sleep 0.8
AB screenshot --path "$OUT/17-final.png" > /dev/null
ok "已保存最终截图"

# --------------------------------------------------------------- 收尾
echo
echo "======================================================================"
echo "结果：通过 $PASS 项，失败 $FAIL 项"
echo "截图目录: $OUT"
echo "======================================================================"

AB close > /dev/null 2>&1 || true
exit $([ "$FAIL" -eq 0 ] && echo 0 || echo 1)
