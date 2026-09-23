#!/usr/bin/env bash
# =============================================================================
# up.sh —— 源码构建路径：建基础镜像 → 建应用镜像 → 起栈 → 验证
#
#   用法：
#     bash deploy/up.sh [部署目录] [--no-build] [--no-verify]
#
#     部署目录      放 .env 与数据的地方（默认当前目录）。
#                   不传就复用当前目录 —— 所以最省事的用法是：
#                       cd /vol1/1000/NebulaDisk && bash <源码>/deploy/up.sh
#     --no-build    跳过构建，直接用已有镜像 up -d
#     --no-verify   跳过 OnlyOffice 链路预检
#
#   ★ 关于「源码目录」与「部署目录」为什么要分开 ★
#     -f 指定编排文件，--project-directory 决定 ① 从哪读 .env ② 相对路径的基准。
#     于是源码可以整体替换/更新（换 tar、git pull），
#     而 .env 与数据（data/、onlyoffice/）留在部署目录里不动。
#
#   构建需要什么：
#     · 基础镜像 kkfileview:5.0.2 —— 本脚本会在缺失时调用仓库根的 ./build.sh
#       自动构建它（那一步会拉 maven 镜像 + 跑 Maven，首次约 10~20 分钟）
#     · 能上外网（装 apt 包 / pip 依赖 / Maven 依赖）
# =============================================================================
set -uo pipefail

CDIR="$(cd -- "$(dirname -- "$0")" && pwd)"
ROOT="$(cd -- "$CDIR/.." && pwd)"
# shellcheck source=_common.sh
. "$CDIR/_common.sh"

DEPLOY_DIR=""; DO_BUILD=1; DO_VERIFY=1
for a in "$@"; do
  case "$a" in
    --no-build)  DO_BUILD=0 ;;
    --no-verify) DO_VERIFY=0 ;;
    -h|--help)   sed -n '3,30p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*)          bad "未知参数：$a"; exit 2 ;;
    *)           DEPLOY_DIR="$a" ;;
  esac
done
[ -n "$DEPLOY_DIR" ] || DEPLOY_DIR="$PWD"
DEPLOY_DIR="$(cd -- "$DEPLOY_DIR" 2>/dev/null && pwd)" || { bad "部署目录不存在：$DEPLOY_DIR"; exit 1; }

COMPOSE_FILE="$CDIR/docker-compose.yml"
# ★ 共享盘的挂载不写死在主编排里 ★ 由 gen_mounts() 从 .env 的 NB_MOUNTS 派生，
#   以 -f 追加在本文件之后。真相只有 .env 一处，加盘 = 加一行。
MOUNTS_FILE="$DEPLOY_DIR/docker-compose.mounts.yml"
say "NebulaDisk 源码构建部署"
info "源码目录： $ROOT"
info "部署目录： $DEPLOY_DIR"
info "编排文件： $COMPOSE_FILE（+ 生成的 docker-compose.mounts.yml）"

# ---------------------------------------------------------------------------
say "1/7 检查环境"
detect_docker || exit 1
# ★ docker daemon 视角的路径 ★
#   Windows + wsl.exe 调 docker 时，MSYS(/d/…) 与 Windows(D:/…) 两种形式 daemon
#   都不认，必须换算成 /mnt/d/…；Linux/NAS 上原样。（见 _common.sh 的 to_docker_path）
SRC_DK="$(to_docker_path "$ROOT")"
DEPLOY_DK="$(to_docker_path "$DEPLOY_DIR")"
COMPOSE_DK="$(to_docker_path "$COMPOSE_FILE")"
MOUNTS_DK="$(to_docker_path "$MOUNTS_FILE")"
# build.context 由它决定（Compose 解析相对路径的基准是 --project-directory，
# 不是编排文件所在目录，所以必须传绝对路径）
export NB_SRC_DIR="$SRC_DK"
info "daemon 视角： 源码=$SRC_DK  部署=$DEPLOY_DK"
# compose 调用统一带部署目录（.env 与相对挂载的基准）
# ★ -f 的**顺序**有意义：后一个覆盖前一个，所以挂载叠加文件必须在主编排之后 ★
compose() { $COMPOSE -f "$COMPOSE_DK" -f "$MOUNTS_DK" --project-directory "$DEPLOY_DK" "$@"; }
[ -f "$ROOT/nebula/Dockerfile" ] || { bad "找不到 $ROOT/nebula/Dockerfile —— 源码目录不对？"; exit 1; }
[ -f "$ROOT/src/pom.xml" ]      || warn "找不到 src/pom.xml —— 若基础镜像已在本地，不影响；否则无法构建它"

# ---------------------------------------------------------------------------
say "2/7 准备 .env"
env_bootstrap "$DEPLOY_DIR" "$CDIR/.env.example" || exit 1
OO_SECRET="$(env_get "$DEPLOY_DIR/.env" NB_OO_SECRET)"
if [ -z "$OO_SECRET" ]; then
  bad "NB_OO_SECRET 还是空的 —— 编排里它是必填（故意 fail fast，避免启动后表现为「文档打不开」）"
  info "编辑 $DEPLOY_DIR/.env 填上它（自己定一个强密码即可，两边读的是同一个变量）"
  exit 1
fi
ok "NB_OO_SECRET 已设置（长度 ${#OO_SECRET}）"

# ---------------------------------------------------------------------------
say "3/7 准备宿主机目录 + 生成共享盘挂载"
gen_mounts "$DEPLOY_DIR" "$CDIR" || exit 1
ensure_host_dirs "$DEPLOY_DIR/.env" "$DEPLOY_DIR"

# ---------------------------------------------------------------------------
say "4/7 准备基础镜像"
BASE_IMG="$(env_get "$DEPLOY_DIR/.env" NB_BASE_IMAGE)"; BASE_IMG="${BASE_IMG:-kkfileview:5.0.2}"
if $DK image inspect "$BASE_IMG" >/dev/null 2>&1; then
  ok "$BASE_IMG 已存在"
elif [ "$DO_BUILD" = "1" ]; then
  warn "$BASE_IMG 不在本地 —— 调用仓库根的 ./build.sh 构建它"
  info "首次构建要拉 maven 镜像 + 跑 Maven，约 10~20 分钟，请耐心等待"
  echo
  if ! ( cd "$ROOT" && bash ./build.sh ); then
    bad "基础镜像构建失败。请先单独把它跑通： cd $ROOT && ./build.sh"
    exit 1
  fi
  ok "基础镜像就绪：$BASE_IMG"
else
  bad "$BASE_IMG 不在本地，而 --no-build 要求用它。先去掉 --no-build，或手动构建它。"
  exit 1
fi

# ---------------------------------------------------------------------------
say "5/7 构建应用镜像"
if [ "$DO_BUILD" = "1" ]; then
  if compose build; then ok "应用镜像构建完成"
  else
    bad "compose build 失败"
    info "常见原因：apt / pip 拉不到包（网络），或基础镜像里缺构建所需组件。"
    info "可单独重试： cd $DEPLOY_DIR && $COMPOSE -f $COMPOSE_FILE -f $MOUNTS_FILE --project-directory $DEPLOY_DIR build"
    exit 1
  fi
else
  warn "已跳过构建（--no-build）"
fi

# ---------------------------------------------------------------------------
say "6/7 启动"
if compose up -d; then ok "compose up 完成"
else bad "compose up 失败，请查看上面的报错"; exit 1; fi
wait_healthy 180 || true

# ---------------------------------------------------------------------------
say "7/7 验证"
$DK ps --format '  {{.Names}}\t{{.Status}}' 2>/dev/null | grep -E 'nebula|onlyoffice|cad-viewer' || true
echo
echo -n "  云盘 healthz： "
$DK exec nebula curl -s --max-time 8 http://127.0.0.1:8088/healthz 2>/dev/null || echo "(取不到)"
echo
if [ "$DO_VERIFY" = "1" ]; then
  preflight_oo
fi

print_done "$DEPLOY_DIR" "$COMPOSE_FILE" "-f $MOUNTS_FILE"
info ""
info "下次更新代码后，只要："
info "    bash $CDIR/up.sh $DEPLOY_DIR        # 重建并重启"
exit "$FAIL"
