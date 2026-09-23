#!/usr/bin/env bash
# =============================================================================
# install.sh —— 离线镜像包路径：导入镜像 → 起栈 → 验证
#
#   ★ 本脚本给「离线包」用 ★
#     离线包 = 本目录下同时有：
#         nebula-<ver>.tar / nebula-cad-viewer-<ver>.tar   （docker save 产物）
#         docker-compose.yml                               （纯运行版，生成物）
#         .env.example / _common.sh / install.sh / diagnose-oo.sh
#     整套由 deploy/export-bundle.sh 生成。
#
#   如果你有**源码**、想从源码构建，请用 deploy/up.sh，不要用本脚本。
#
#   用法：
#     bash install.sh [--no-verify]
#
#   幂等：重复执行不会报错，已完成的步骤自动跳过。
#
#   注：本文件是**规范来源**（在 deploy/ 下）；export-bundle.sh 会连同 _common.sh
#       一起复制进包。所以它只依赖「与自己同目录」的那些文件，不依赖源码树。
# =============================================================================
set -uo pipefail

CDIR="$(cd -- "$(dirname -- "$0")" && pwd)"

if [ ! -f "$CDIR/_common.sh" ]; then
  echo "✗ 同目录缺少 _common.sh —— 离线包不完整（重新用 deploy/export-bundle.sh 生成）" >&2
  echo "  如果你有源码、想从源码构建，请用： bash deploy/up.sh <部署目录>" >&2
  exit 1
fi
# shellcheck source=_common.sh
. "$CDIR/_common.sh"

DO_VERIFY=1
for a in "$@"; do
  case "$a" in
    --no-verify) DO_VERIFY=0 ;;
    -h|--help)   sed -n '3,26p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) bad "未知参数：$a"; exit 2 ;;
  esac
done

# ★ 运行时用的是**单文件** docker-compose.yml ★
#   它由 docker-compose.base.yml（纯运行版）+ NB_MOUNTS 派生的共享盘挂载
#   合并而成 —— 图形化容器管理器只吃一个文件，装不了 -f 叠加。
#   见 _common.sh 的 gen_mounts_standalone()。
COMPOSE_FILE="$CDIR/docker-compose.yml"
BASE_FILE="$CDIR/docker-compose.base.yml"
VER="1.0.0"

# ---------------------------------------------------------------------------
say "1/6 检查环境"
detect_docker || exit 1
if [ ! -f "$BASE_FILE" ]; then
  bad "同目录下没有 docker-compose.yml —— 这不是一个完整的离线包"
  info "如果你有源码，请改用源码路径： bash deploy/up.sh <部署目录>"
  exit 1
fi
ok "找到 docker-compose.base.yml"

# ---------------------------------------------------------------------------
say "2/6 导入镜像"
# 版本号取包内 tar 的文件名（与 compose 里 image: 的 tag 对齐）
NEBULA_TAR="$(ls "$CDIR"/nebula-[0-9]*.tar 2>/dev/null | head -1)"
CAD_TAR="$(ls "$CDIR"/nebula-cad-viewer-*.tar 2>/dev/null | head -1)"
if [ -n "$NEBULA_TAR" ]; then
  VER="$(basename "$NEBULA_TAR" | sed -E 's#^nebula-([0-9][0-9.]*)\.tar$#\1#')"
  [ -n "$VER" ] || VER="1.0.0"
  load_image_tar "$NEBULA_TAR" "nebula:${VER}" || exit 1
else
  warn "没找到 nebula-*.tar —— 假定镜像已在本地"
fi

if [ -n "$CAD_TAR" ]; then
  # CAD 包里有 1.7.0 与 latest 两个 tag，导完确认一下
  $DK load -i "$CAD_TAR" >/dev/null 2>&1 || warn "CAD 镜像导入失败"
  if $DK image inspect nebula/cad-viewer:latest >/dev/null 2>&1 \
     || $DK image inspect "nebula/cad-viewer:1.7.0" >/dev/null 2>&1; then
    ok "nebula/cad-viewer 已就绪"
  else
    warn "导入后仍找不到 nebula/cad-viewer —— dwg/dxf 预览会不可用"
  fi
  info "（CAD 查看器是可选组件，只影响 dwg/dxf 预览）"
else
  warn "没找到 nebula-cad-viewer-*.tar —— 跳过（dwg/dxf 预览将不可用）"
fi

# ---------------------------------------------------------------------------
say "3/6 准备 .env"
env_bootstrap "$CDIR" "$CDIR/.env.example" || exit 1
if [ -z "$(env_get "$CDIR/.env" NB_OO_SECRET)" ]; then
  bad "NB_OO_SECRET 是空的 —— 编排里它是必填（故意 fail fast）"
  info "编辑 $CDIR/.env 填上它（自己定一个强密码；OnlyOffice 两侧读的是同一个变量）"
  exit 1
fi

# ---------------------------------------------------------------------------
say "4/6 准备宿主机目录 + 生成共享盘挂载"
gen_mounts_standalone "$CDIR" || exit 1
ensure_host_dirs "$CDIR/.env" "$CDIR"

# ---------------------------------------------------------------------------
say "5/6 启动"
# 离线包的编排是「纯运行版」（无 build:），三个服务共用 nebula-net，不需要外部网络
if $COMPOSE -f "$COMPOSE_FILE" --project-directory "$CDIR" up -d; then ok "compose up 完成"
else bad "compose up 失败，请查看上面的报错"; exit 1; fi
wait_healthy 180 || true

# ---------------------------------------------------------------------------
say "6/6 验证"
$DK ps --format '  {{.Names}}\t{{.Status}}' 2>/dev/null | grep -E 'nebula|onlyoffice|cad-viewer' || true
echo
echo -n "  云盘 healthz： "
$DK exec nebula curl -s --max-time 8 http://127.0.0.1:8088/healthz 2>/dev/null || echo "(取不到)"
echo
if [ "$DO_VERIFY" = "1" ]; then
  preflight_oo
fi

print_done "$CDIR" "$COMPOSE_FILE"
exit "$FAIL"
