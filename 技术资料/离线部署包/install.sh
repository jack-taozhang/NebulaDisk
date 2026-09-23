#!/usr/bin/env bash
# =============================================================================
# NebulaDisk 一键安装（在**目标 NAS** 上执行，不需要源码）
#
#   bash install.sh
#
# 它会依次：
#   1. 检查 docker / docker compose 可用
#   2. 镜像不在本地时，从 nebula-1.0.0.tar 导入
#   3. 外部网络不存在时建一个占位（不建的话 compose up 会直接失败）
#   4. .env 不存在时从 .env.example 复制一份
#   5. 按 .env 建好缺失的宿主机目录（否则容器启动会报「映射路径不存在」）
#   6. docker compose up -d 并做一次健康检查
#
# 幂等：重复执行不会报错，已完成的步骤自动跳过。
# =============================================================================
set -uo pipefail

HERE="$(cd -- "$(dirname -- "$0")" && pwd)"
cd "$HERE" || exit 1

IMAGE_TAR="nebula-1.0.0.tar"
IMAGE="nebula:1.0.0"
FAIL=0

say() { printf '\n\033[1m== %s ==\033[0m\n' "$1"; }
ok()  { printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad() { printf '  \033[31m✗\033[0m %s\n' "$1"; FAIL=1; }
warn(){ printf '  \033[33m!\033[0m %s\n' "$1"; }

# ---- 1) docker 通道 ----
say "1/6 检查 docker"
DK=""
for c in "docker" "sudo docker"; do
    if $c version >/dev/null 2>&1; then DK="$c"; break; fi
done
if [ -z "$DK" ]; then
    bad "找不到可用的 docker。请先装 Docker（NAS 的应用中心通常有）后重试。"
    exit 1
fi
ok "docker 可用（$DK）"

# compose 子命令：新版是 `docker compose`，老版是独立的 docker-compose
if $DK compose version >/dev/null 2>&1; then
    COMPOSE="$DK compose"
elif command -v docker-compose >/dev/null 2>&1; then
    COMPOSE="docker-compose"
else
    bad "没有 compose 插件。请升级 docker，或单独装 docker-compose。"
    exit 1
fi
ok "compose 可用（$COMPOSE）"

# ---- 2) 导入镜像 ----
say "2/6 导入镜像"
if $DK image inspect "$IMAGE" >/dev/null 2>&1; then
    ok "$IMAGE 已存在，跳过导入"
else
    if [ ! -f "$IMAGE_TAR" ]; then
        bad "本地没有 $IMAGE，也找不到 $IMAGE_TAR"
        echo "     请确认 tar 与本脚本在同一目录。" >&2
        exit 1
    fi
    # 有校验文件就先校验：1.7GB 的包在传输中损坏会很隐蔽
    if [ -f "$IMAGE_TAR.sha256" ] && command -v sha256sum >/dev/null 2>&1; then
        echo "  校验 $IMAGE_TAR 完整性…"
        if sha256sum -c "$IMAGE_TAR.sha256" >/dev/null 2>&1; then
            ok "SHA256 校验通过"
        else
            bad "$IMAGE_TAR 校验不通过（传输损坏？请重新拷贝）"
            exit 1
        fi
    fi
    echo "  正在导入 $IMAGE_TAR（约 1.7GB，视磁盘速度需要 1~5 分钟）…"
    if $DK load -i "$IMAGE_TAR"; then
        ok "$IMAGE 导入完成"
    else
        bad "$IMAGE_TAR 导入失败"
        exit 1
    fi
fi

# ---- 3) 外部网络 ----
say "3/6 准备外部网络"
NET="nebula-oo"
if [ -f .env ]; then
    # 从 .env 里读 NB_OO_NETWORK（取最后一个非注释赋值）
    v="$(grep -E '^[[:space:]]*NB_OO_NETWORK[[:space:]]*=' .env | tail -1 | cut -d= -f2- | tr -d ' \r')"
    [ -n "$v" ] && NET="$v"
fi
if $DK network inspect "$NET" >/dev/null 2>&1; then
    ok "网络 $NET 已存在"
else
    if $DK network create "$NET" >/dev/null 2>&1; then
        ok "已创建占位网络 $NET"
        echo "     （以后有 OnlyOffice / cad-viewer 容器时，让它加入这个网络即可互通）"
    else
        bad "创建网络 $NET 失败"
    fi
fi

# ---- 4) .env ----
say "4/6 准备 .env"
if [ -f .env ]; then
    ok ".env 已存在，保持不动"
else
    if [ -f .env.example ]; then
        cp .env.example .env
        warn "已从 .env.example 生成 .env —— **请务必编辑它**，至少改："
        echo "       NB_SHARE_DIR / NB_PHOTOS_DIR / NB_PRIVATE_DIR  → 你的真实目录"
        echo "       NEBULA_MOUNTS                                  → 与上面一一对应"
        echo "       NB_ADMIN_PASSWORD                              → 管理员密码"
    else
        bad "既没有 .env 也没有 .env.example"
    fi
fi

# ---- 5) 宿主机目录 ----
#
# 为什么必须做：容器启动时会逐个检查映射路径，不存在就打 ✗ 并把该映射摘掉，
# 界面上就是「盘不见了」。自动建一遍能让首次部署直接可用。
say "5/6 准备宿主机目录"
envval() { grep -E "^[[:space:]]*$1[[:space:]]*=" .env 2>/dev/null | tail -1 | cut -d= -f2- | tr -d ' \r'; }
ensure_dir() { # $1=env 键名
    local key="$1" v d
    v="$(envval "$key")"
    [ -n "$v" ] || return 0
    case "$v" in /*) d="$v" ;; *) d="$v" ;; esac
    if [ -d "$d" ]; then
        ok "$key → $d"
    elif mkdir -p "$d" 2>/dev/null; then
        ok "$key → $d（已创建）"
    else
        bad "$key → $d 无法创建（检查父目录是否存在、是否有写权限）"
    fi
}
for k in NB_DATA_DIR NB_KK_FILE_DIR NB_KK_LOG_DIR NB_SHARE_DIR NB_PHOTOS_DIR NB_PRIVATE_DIR; do
    ensure_dir "$k"
done

# ---- 6) 启动 ----
say "6/6 启动"
$COMPOSE up -d || bad "compose up 失败，请查看上面的报错"

PORT="8089"
if [ -f .env ]; then
    p="$(grep -E '^[[:space:]]*NB_HOST_PORT[[:space:]]*=' .env | tail -1 | cut -d= -f2- | tr -d ' \r')"
    [ -n "$p" ] && PORT="$p"
fi

echo "  等待健康检查（最长 120 秒）…"
for i in $(seq 1 40); do
    if $DK exec nebula curl -fsS http://127.0.0.1:8088/healthz >/dev/null 2>&1; then
        ok "容器已就绪"
        break
    fi
    [ "$i" -eq 40 ] && warn "120 秒内未就绪，可稍后执行： $DK logs --tail=50 nebula"
    sleep 3
done

say "完成"
IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
echo "  访问地址： http://${IP:-<NAS的IP>}:$PORT"
echo
echo "  管理员密码："
if grep -qE '^[[:space:]]*NB_ADMIN_PASSWORD[[:space:]]*=[[:space:]]*$' .env 2>/dev/null; then
    echo "    你留空了，密码是随机生成的，用下面命令取："
    echo "      $DK logs nebula 2>&1 | grep 管理员"
else
    echo "    就是 .env 里 NB_ADMIN_PASSWORD 的值"
fi
echo
echo "  常用命令："
echo "    查看日志： $DK logs -f nebula"
echo "    停止：     $COMPOSE stop"
echo "    启动：     $COMPOSE start"

exit "$FAIL"
