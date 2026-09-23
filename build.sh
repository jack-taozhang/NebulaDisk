#!/usr/bin/env bash
# =============================================================================
# kkFileView 镜像构建脚本（在 WSL / Linux 下执行）
#
#   ./build.sh                     # 构建 kkfileview:5.0.2
#   ./build.sh --up                # 构建后用 docker compose 启动
#   ./build.sh --arch arm64        # 构建 arm64 镜像
#   ./build.sh --no-cache          # 不用缓存全量重建
#   ./build.sh --only-base         # 只构建运行时基础层（快速自检，不跑 Maven）
#   ./build.sh --apt-mirror ""     # 不用 apt 加速源
#   ./build.sh --sync v5.0.2       # 先按 tag 同步源码再构建
#
# 注意 1：构建统一带 --network=host。本机容器 DNS 不可用
#         （WSL2 的 10.255.255.254 在 docker bridge 网段不可达），
#         不加这个参数会在下载 apt / maven 依赖时失败。
# 注意 2：换版本号要同时改三处 —— Dockerfile 里 ENTRYPOINT 的硬编码路径、
#         .env 的 KK_VERSION/KK_IMAGE、docker-compose.yml。
#         Dockerfile 有版本一致性自检，漏改会直接构建失败，不会产出坏镜像。
# =============================================================================
set -euo pipefail

cd "$(dirname "$0")"

VERSION="5.0.2"
ARCH=""
APT_MIRROR="mirrors.aliyun.com"
NO_CACHE=0
DO_UP=0
ONLY_BASE=0
SYNC_TAG=""
PLATFORM_FLAG=""
TARGET_FLAG=""
HOST_NETWORK=1

UBUNTU_IMAGE_DEFAULT="ubuntu:24.04"
MAVEN_IMAGE_DEFAULT="maven:3.9-eclipse-temurin-21"

usage() {
    cat <<'EOF'
kkFileView 镜像构建脚本

  ./build.sh                    构建 kkfileview:5.0.2
  ./build.sh --up               构建后用 docker compose 启动
  ./build.sh --arch arm64       构建 arm64 镜像
  ./build.sh --no-cache         不用缓存全量重建
  ./build.sh --only-base        只构建运行时基础层（快速自检，不跑 Maven）
  ./build.sh --apt-mirror ""    不用 apt 加速源（默认 mirrors.aliyun.com）
  ./build.sh --no-host-network  不用 host 网络构建（本机容器 DNS 正常时才可）
  ./build.sh --sync v5.0.2      先按 tag 同步源码再构建
  -h, --help                    显示本帮助
EOF
    exit 0
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --arch)             ARCH="$2"; shift 2 ;;
        --sync)             SYNC_TAG="$2"; shift 2 ;;
        --apt-mirror)       APT_MIRROR="$2"; shift 2 ;;
        --no-cache)         NO_CACHE=1; shift ;;
        --up)               DO_UP=1; shift ;;
        --only-base)        ONLY_BASE=1; shift ;;
        --no-host-network)  HOST_NETWORK=0; shift ;;
        -h|--help)          usage ;;
        *) echo "未知参数：$1"; usage ;;
    esac
done

if [[ -n "$ARCH" ]]; then
    PLATFORM_FLAG="--platform=linux/${ARCH}"
fi

# ---------------------------------------------------------------------------
# 0. 环境检查
# ---------------------------------------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
    cat >&2 <<'EOF'
✗ 找不到 docker 命令。

  如果你在 Windows 上，先进入 WSL 再执行：
      wsl -d <你的发行版>
      cd /mnt/d/Docker/kkFileView && ./build.sh
EOF
    exit 1
fi

if ! docker info >/dev/null 2>&1; then
    echo "✗ docker 守护进程不可用，请先确认 Docker 已启动。" >&2
    exit 1
fi

echo "==> Docker 服务端版本：$(docker version --format '{{.Server.Version}}' 2>/dev/null || echo unknown)"
echo "==> 目标平台：${ARCH:-当前主机架构}"
echo "==> 构建版本：${VERSION}"

# ---------------------------------------------------------------------------
# 1. 可选：同步源码到指定 tag
# ---------------------------------------------------------------------------
if [[ -n "$SYNC_TAG" ]]; then
    echo "==> 同步源码到 tag ${SYNC_TAG}"
    if [[ -d src/.git ]]; then
        git -C src fetch --depth 1 origin "refs/tags/${SYNC_TAG}"
        git -C src checkout -f FETCH_HEAD
    else
        rm -rf src
        git clone --depth 1 --branch "${SYNC_TAG}" \
            https://github.com/kekingcn/kkFileView.git src
    fi
fi

if [[ ! -f src/pom.xml ]]; then
    cat >&2 <<EOF
✗ 找不到 src/pom.xml，源码未就绪。先执行：

    git clone --depth 1 --branch v${VERSION} \\
        https://github.com/kekingcn/kkFileView.git src

  或直接：./build.sh --sync v${VERSION}
EOF
    exit 1
fi

# ---------------------------------------------------------------------------
# 2. 组装构建参数
# ---------------------------------------------------------------------------
if [[ "$ONLY_BASE" -eq 1 ]]; then
    TARGET_FLAG="--target runtime-base"
    IMAGE_TAGS=( -t "kkfileview-base:${VERSION}" )
else
    IMAGE_TAGS=( -t "kkfileview:${VERSION}" -t "kkfileview:latest" )
fi

BUILD_ARGS=(
    --build-arg "KK_VERSION=${VERSION}"
    --build-arg "UBUNTU_IMAGE=${UBUNTU_IMAGE_DEFAULT}"
    --build-arg "APT_MIRROR=${APT_MIRROR}"
    --build-arg "MAVEN_IMAGE=${MAVEN_IMAGE_DEFAULT}"
)
[[ "$NO_CACHE" -eq 1 ]] && BUILD_ARGS+=(--no-cache)

NET_FLAG=""
if [[ "$HOST_NETWORK" -eq 1 ]]; then
    NET_FLAG="--network=host"
fi

echo
echo "==> 开始构建：${IMAGE_TAGS[*]}"
echo "    apt 源：${APT_MIRROR:-（用镜像自带官方源）}"
echo "    网络：  ${NET_FLAG:---network=bridge（默认）}"
[[ "$ONLY_BASE" -eq 0 ]] && echo "    首次构建需下载 apt 包与 Maven 依赖，请耐心等待。"

# shellcheck disable=SC2086
docker build \
    ${PLATFORM_FLAG} \
    ${NET_FLAG} \
    ${TARGET_FLAG} \
    "${BUILD_ARGS[@]}" \
    "${IMAGE_TAGS[@]}" \
    .

echo
echo "✓ 构建完成"
docker images --filter "reference=kkfileview*" \
    --format '  {{.Repository}}:{{.Tag}}  {{.Size}}  ({{.CreatedSince}})'

if [[ "$ONLY_BASE" -eq 1 ]]; then
    echo
    echo "运行时基础层已产出，可这样自检："
    echo "    docker run --rm kkfileview-base:${VERSION} \\"
    echo "        ls -l /usr/lib/libreoffice/program/soffice.bin"
    exit 0
fi

# ---------------------------------------------------------------------------
# 3. 可选：启动
# ---------------------------------------------------------------------------
if [[ "$DO_UP" -eq 1 ]]; then
    echo
    echo "==> docker compose up -d"
    docker compose up -d
    echo
    echo "  预览服务首页：http://localhost:8012/"
    echo
    echo "  带同源反代 + 演示页："
    echo "      docker compose --profile proxy up -d"
    echo "      → http://localhost:8080/"
else
    echo
    echo "下一步："
    echo "    docker compose up -d                     # 仅启动预览服务"
    echo "    docker compose --profile proxy up -d     # 额外启动 nginx 演示同源嵌入"
fi
