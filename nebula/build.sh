#!/usr/bin/env bash
# =============================================================================
# NebulaDisk 镜像构建 / 部署脚本
#
#   ./nebula/build.sh                    # 构建 nebula:1.0.0
#   ./nebula/build.sh --up               # 构建后启动
#   ./nebula/build.sh --no-cache         # 全量重建
#   ./nebula/build.sh --check            # 只做构建前检查，不真构建
#   ./nebula/build.sh --logs             # 跟踪运行日志
#   ./nebula/build.sh --down             # 停止并移除容器
#   ./nebula/build.sh --smoke            # 对运行中的容器跑冒烟测试
#
# 前置条件：
#   1. 基础镜像 kkfileview:5.0.2 必须已在本地存在
#      （构建它：./build.sh）
#   2. OnlyOffice 容器已在运行，且知道它所在网络名与 JWT 密钥
#
# ⚠️ 构建统一带 --network=host：WSL2 生成的 /etc/resolv.conf 指向
#    10.255.255.254，该 DNS 在 docker bridge 网段不可达，不带这个参数
#    装 apt 包必失败。
# =============================================================================
set -euo pipefail

# ---- 定位到脚本所在目录 ----
# 这里同时要应付两种 shell，坑点在于 pwd -W 是 Git Bash 独有的参数：
#   Git Bash: $(pwd -W) = D:/Docker/kkFileView/nebula     （Windows 形式）
#   WSL bash: pwd -W  → "pwd: -W: invalid option" 并**报错退出**
# 因此不能简单写 "$(cd .. && pwd -W || pwd)"：在 WSL 下 pwd -W 失败后
# 会退回 `pwd`，看似能用，但一旦某一步真的失败就会静默掉进下面的
# Windows 硬编码兜底，把一个 D:/... 塞进 Linux 路径体系里 —— 那就是
# 构建上下文找不到的根源。所以改成「先探测 pwd -W 是否可用，再决定用谁」。
SELF="${BASH_SOURCE[0]:-$0}"
HERE="$(cd -- "$(dirname -- "$SELF")" 2>/dev/null && pwd)"
# pwd -W 可用（Git Bash）时优先用它，得到 Windows 形式路径便于打印与兜底
if HERE_W="$(cd -- "$(dirname -- "$SELF")" 2>/dev/null && pwd -W 2>/dev/null)"; then
    [[ -n "$HERE_W" ]] && HERE="$HERE_W"
fi
case "$HERE" in
  *nebula) : ;;
  *) HERE="D:/Docker/kkFileView/nebula" ;;
esac
ROOT="$(cd -- "$HERE/.." 2>/dev/null && pwd)"
if ROOT_W="$(cd -- "$HERE/.." 2>/dev/null && pwd -W 2>/dev/null)"; then
    [[ -n "$ROOT_W" ]] && ROOT="$ROOT_W"
fi
[[ -n "$ROOT" ]] || ROOT="D:/Docker/kkFileView"

IMAGE="nebula:1.0.0"
BASE_IMAGE="kkfileview:5.0.2"
DO_UP=0
NO_CACHE=0
DO_CHECK=0
DO_LOGS=0
DO_DOWN=0
DO_SMOKE=0

usage() {
    cat <<'EOF'
NebulaDisk 构建脚本

  ./nebula/build.sh              构建 nebula:1.0.0
  ./nebula/build.sh --up         构建后启动
  ./nebula/build.sh --no-cache   全量重建
  ./nebula/build.sh --check      只做构建前检查
  ./nebula/build.sh --smoke      对运行中的容器跑冒烟测试
  ./nebula/build.sh --logs       跟踪日志
  ./nebula/build.sh --down       停止并移除
  -h, --help                     显示帮助
EOF
    exit 0
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --up)        DO_UP=1; shift ;;
        --no-cache)  NO_CACHE=1; shift ;;
        --check)     DO_CHECK=1; shift ;;
        --logs)      DO_LOGS=1; shift ;;
        --down)      DO_DOWN=1; shift ;;
        --smoke)     DO_SMOKE=1; shift ;;
        -h|--help)   usage ;;
        *) echo "未知参数：$1" >&2; usage ;;
    esac
done

# ---- docker 通道探测：本机 docker 在 WSL 里，Git Bash 直连不通 ----
DK=""
DK_IN_WSL=0
for c in "docker" "wsl.exe -e docker" "wsl.exe docker"; do
    if $c version >/dev/null 2>&1; then
        DK="$c"
        case "$c" in wsl*) DK_IN_WSL=1 ;; esac
        break
    fi
done
if [[ -z "$DK" ]]; then
    echo "✗ 找不到可用的 docker（本机需通过 wsl.exe 访问）" >&2
    exit 1
fi
echo "docker 通道：$DK"

# ---- 判断「docker 能否看见当前路径」----
# 关键点：DK_IN_WSL 只说明「我们要通过 wsl.exe 去调 docker」，
# 并不说明「docker 看不见我们现在的路径」。
# 脚本有两种进入方式，二者需要的路径形式**正好相反**：
#
#   A) 在 Git Bash 里跑：   ./nebula/build.sh
#      ROOT=D:/Docker/kkFileView  → docker 在 WSL 里，必须换算成 /mnt/d/...
#      （DK_IN_WSL=1，要换算）
#
#   B) 在 WSL 里跑：        bash /mnt/d/Docker/kkFileView/nebula/build.sh
#      ROOT 经 pwd 得到的就是 /mnt/d/Docker/kkFileView，本来就被 docker 看见；
#      此时若还去「换算」，/mnt/d/... 不匹配 ^[A-Za-z]:/ 会原样返回，
#      看似没事 —— 但真正的地雷是 ROOT 若退化成 Windows 形式
#      （D:/Docker/kkFileView）而 DK_IN_WSL 仍为 1，就会把 Windows 路径
#      丢给 Linux daemon，docker 报 "path ... not found"，且这一步在
#      precheck 之后，表现为「检查全过、构建立刻失败」。
#
# 所以判定依据不该是「docker 在哪」，而是「当前路径长什么样」：
# 只要 ROOT 是 Windows 盘符形式，就必须换算；否则保持原样。
ROOT_IS_WIN=0
case "$ROOT" in [A-Za-z]:/*|[A-Za-z]:\\*) ROOT_IS_WIN=1 ;; esac
if [[ $ROOT_IS_WIN -eq 1 ]]; then
    # Windows 形式路径 → 只有经由 wsl.exe 调用才可能被看见
    if [[ $DK_IN_WSL -eq 0 ]]; then
        echo "✗ 路径是 Windows 形式（$ROOT）但 docker 是 Linux 原生通道，" >&2
        echo "  Linux daemon 看不见这个路径。请在 Git Bash 下执行本脚本：" >&2
        echo "      ./nebula/build.sh ${*:-}" >&2
        exit 1
    fi
    NEED_PATH_CONV=1
else
    NEED_PATH_CONV=0
fi

# ---- 路径换算 ----
# docker 跑在 WSL 里，它看不见 Windows 的 D:\... 路径。
# 「构建上下文」是传给 daemon 的路径，必须换成 /mnt/d/... 形式。
# （-f Dockerfile 的路径由 docker CLI 自己读，可以用 Windows 路径。）
to_docker_path() {
    local p="$1"
    if [[ $NEED_PATH_CONV -eq 1 ]]; then
        # D:/Docker/kkFileView  ->  /mnt/d/Docker/kkFileView
        if [[ "$p" =~ ^([A-Za-z]):[/\\](.*)$ ]]; then
            local drive="${BASH_REMATCH[1],,}"
            printf '/mnt/%s/%s\n' "$drive" "${BASH_REMATCH[2]}"
        else
            printf '%s\n' "$p"
        fi
    else
        printf '%s\n' "$p"
    fi
}

CTX_DOCKER="$(to_docker_path "$ROOT")"
# -f 的路径也必须一起换算：Git Bash 会把 D:/... 当成含冒号的参数去「转换」，
# 结果传成 "D::" 之类的怪东西，docker 报 "lstat D:: no such file or directory"。
DOCKERFILE_DOCKER="$(to_docker_path "$HERE")/Dockerfile"
echo "构建上下文：$CTX_DOCKER"
echo "Dockerfile：$DOCKERFILE_DOCKER"

# ---- compose 调用封装 ----
# compose 文件路径要能被 docker CLI 读到，而 --project-directory 用于解析
# 相对卷路径（.env 里的 ./data、./sample/*）。
# WSL docker 下这两个都得是 /mnt/d/... 形式。
COMPOSE_FILE_DOCKER="$(to_docker_path "$HERE")/docker-compose.yml"
PROJ_DIR_DOCKER="$(to_docker_path "$HERE")"
compose() {
    $DK compose -f "$COMPOSE_FILE_DOCKER" --project-directory "$PROJ_DIR_DOCKER" "$@"
}

# ---------------------------------------------------------------------------
# 构建前检查
# ---------------------------------------------------------------------------
precheck() {
    echo
    echo "===== 构建前检查 ====="
    local fail=0

    if $DK image inspect "$BASE_IMAGE" >/dev/null 2>&1; then
        echo "✓ 基础镜像存在：$BASE_IMAGE"
    else
        echo "✗ 基础镜像不存在：$BASE_IMAGE" >&2
        echo "  请先在仓库根目录执行 ./build.sh 构建它。" >&2
        fail=1
    fi

    for f in app/main.py app/config.py app/auth.py app/files.py app/integrations.py \
             app/users.py web/index.html requirements.txt \
             deploy/supervisord.conf deploy/nebula-entrypoint.sh Dockerfile; do
        if [[ -f "$HERE/$f" ]]; then
            echo "✓ $f"
        else
            echo "✗ 缺少文件：nebula/$f" >&2
            fail=1
        fi
    done

    # compose 语法（缺 .env 变量时 compose 会报缺值，属提示不阻塞）
    if compose config >/dev/null 2>&1; then
        echo "✓ docker-compose.yml 语法正确"
    else
        echo "! docker-compose.yml 校验未通过（可能缺 .env 变量，仅提示）"
    fi

    echo
    if [[ $fail -eq 1 ]]; then
        echo "✗ 检查未通过，已中止。" >&2
        exit 1
    fi
    echo "✓ 检查通过"
}

precheck

if [[ $DO_CHECK -eq 1 ]]; then
    exit 0
fi

# ---------------------------------------------------------------------------
# 停止
# ---------------------------------------------------------------------------
if [[ $DO_DOWN -eq 1 ]]; then
    echo
    echo "===== 停止 nebula ====="
    compose down || true
    exit 0
fi

# ---------------------------------------------------------------------------
# 日志
# ---------------------------------------------------------------------------
if [[ $DO_LOGS -eq 1 ]]; then
    compose logs -f --tail=100
    exit 0
fi

# ---------------------------------------------------------------------------
# 冒烟测试（对运行中的容器）
# ---------------------------------------------------------------------------
if [[ $DO_SMOKE -eq 1 ]]; then
    PORT="${NB_HOST_PORT:-8088}"
    echo
    echo "===== 冒烟测试  http://127.0.0.1:$PORT ====="
    ok=0; bad=0
    chk() {
        if [[ "$2" == "$3" ]]; then echo "  [OK  ] $1 → $2"; ok=$((ok+1));
        else echo "  [FAIL] $1 → $2（期望 $3）"; bad=$((bad+1)); fi
    }
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "http://127.0.0.1:$PORT/" || echo 000)
    chk "云盘首页" "$code" "200"
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "http://127.0.0.1:$PORT/healthz" || echo 000)
    chk "健康接口" "$code" "200"
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "http://127.0.0.1:$PORT/api/me" || echo 000)
    chk "未登录 /api/me" "$code" "401"
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "http://127.0.0.1:8012/" || echo 000)
    chk "kkFileView 直连" "$code" "200"
    echo
    echo "通过 $ok 项，失败 $bad 项"
    exit $([[ $bad -eq 0 ]] && echo 0 || echo 1)
fi

# ---------------------------------------------------------------------------
# 构建
# ---------------------------------------------------------------------------
echo
echo "===== 构建 $IMAGE ====="
CACHE_FLAG=""
[[ $NO_CACHE -eq 1 ]] && CACHE_FLAG="--no-cache"

# 上下文 = 仓库根目录（Dockerfile 里 COPY nebula/... 依赖这个布局）
# 注意上下文与 -f 都必须用 daemon 能理解的路径（WSL 里是 /mnt/d/...）。
# MSYS_NO_PATHCONV=1 关掉 Git Bash 的自动路径重写，否则带冒号的参数会被改坏。
MSYS_NO_PATHCONV=1 $DK build \
    --network=host \
    $CACHE_FLAG \
    -f "$DOCKERFILE_DOCKER" \
    -t "$IMAGE" \
    --build-arg "KK_BASE_IMAGE=$BASE_IMAGE" \
    "$CTX_DOCKER"

echo
echo "✓ 构建完成：$IMAGE"
$DK images "$IMAGE" --format '  {{.Repository}}:{{.Tag}}  {{.Size}}'

if [[ $DO_UP -eq 1 ]]; then
    echo
    echo "===== 启动 ====="
    [[ -f "$HERE/.env" ]] || { echo "! 未找到 nebula/.env，从 .env.example 复制一份"; cp "$HERE/.env.example" "$HERE/.env"; }
    compose up -d
    echo
    echo "启动完成。查看状态："
    echo "  ./nebula/build.sh --logs"
    echo "  浏览器打开 http://<NAS_IP>:${NB_HOST_PORT:-8088}"
fi
