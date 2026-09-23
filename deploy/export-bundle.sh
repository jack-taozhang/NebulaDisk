#!/usr/bin/env bash
# =============================================================================
# export-bundle.sh —— 生成离线镜像包（dist/nebula-<ver>/）
#
#   用法：
#     bash deploy/export-bundle.sh              # 只重新生成包内的脚本与配置
#     bash deploy/export-bundle.sh --save       # 顺便 docker save 出镜像 tar
#
#   ★ 为什么要「生成」而不是手工维护一份 ★
#     离线包里的 docker-compose.yml / install.sh / _common.sh / 文档
#     全都是**同一个东西的第二份拷贝**。手工维护必然漂移 ——
#     本项目已经吃过一次：dist 里那 3 份 compose 各自演进几轮后，
#     只有一份是对的，排查时先在错的那份上浪费了一轮。
#     现在改成：deploy/ 是唯一真相，dist/ 是产物（可随时整体重生成）。
#
#   产出内容：
#     docker-compose.yml        ← deploy/docker-compose.run.yml（纯运行版，无 build:）
#     .env.example              ← deploy/.env.example
#     _common.sh install.sh     ← deploy/ 同名文件
#     diagnose-oo.sh            ← deploy/diagnose-oo.sh
#     安装说明.md                ← deploy/README.md
#     nebula-<ver>.tar(+.sha256)     ← 仅 --save 时
#     nebula-cad-viewer-<ver>.tar(+.sha256) ← 仅 --save 时
# =============================================================================
set -uo pipefail

CDIR="$(cd -- "$(dirname -- "$0")" && pwd)"
ROOT="$(cd -- "$CDIR/.." && pwd)"
# shellcheck source=_common.sh
. "$CDIR/_common.sh"

DO_SAVE=0
for a in "$@"; do
  case "$a" in
    --save) DO_SAVE=1 ;;
    -h|--help) sed -n '3,26p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) bad "未知参数：$a"; exit 2 ;;
  esac
done

VER="$(env_get "$CDIR/.env.example" NB_VERSION)"; VER="${VER:-1.0.0}"
CAD_VER="$(env_get "$CDIR/.env.example" NB_CAD_VERSION)"; CAD_VER="${CAD_VER:-1.7.0}"
OUT="$ROOT/dist/nebula-$VER"

# ---------------------------------------------------------------------------
say "1/4 重新生成纯运行版编排"
PY="python3"
command -v python3 >/dev/null 2>&1 || PY="python"
if ! ( cd "$CDIR" && $PY gen-run-compose.py ); then
  bad "生成 docker-compose.run.yml 失败"; exit 1
fi

# ---------------------------------------------------------------------------
say "2/4 准备输出目录 $OUT"
mkdir -p "$OUT"
ok "目录就绪"

# ---------------------------------------------------------------------------
say "3/4 复制/生成包内文件"
# 注意：**不要**把 up.sh / docker-compose.yml(可build) / gen-run-compose.py 放进包 ——
#       离线包只负责「导入镜像并运行」，那些是源码路径的东西。
cp -f "$CDIR/docker-compose.run.yml" "$OUT/docker-compose.base.yml" && ok "docker-compose.base.yml（纯运行版，不含共享盘挂载）"
cp -f "$CDIR/.env.example"           "$OUT/.env.example"         && ok ".env.example"
cp -f "$CDIR/_common.sh"             "$OUT/_common.sh"           && ok "_common.sh"
cp -f "$CDIR/install.sh"             "$OUT/install.sh"           && ok "install.sh"
cp -f "$CDIR/diagnose-oo.sh"         "$OUT/diagnose-oo.sh"       && ok "diagnose-oo.sh"
cp -f "$CDIR/gen-mounts.py"          "$OUT/gen-mounts.py"        && ok "gen-mounts.py（共享盘挂载生成器）"
if [ -f "$CDIR/README.md" ]; then
  cp -f "$CDIR/README.md" "$OUT/安装说明.md" && ok "安装说明.md（← deploy/README.md）"
else
  warn "deploy/README.md 不存在，跳过安装说明.md"
fi

# ---------------------------------------------------------------------------
# ★ 另外生成一份**单文件** docker-compose.yml ★
#   图形化容器管理器（群晖 Container Manager / 威联通 Container Station）
#   **只吃一个 compose 文件**，用不了 -f 叠加。所以这里把 base 与「默认共享盘
#   挂载」合并成单文件，让图形界面用户开箱可用。
#   （install.sh 每次会重新合并，所以命令行用户改 NB_MOUNTS 立即生效。）
#   输入用 .env.example（不能为了导出就先造一个 .env）
#   ★ 路径一律过 winpath ★ Git Bash 下 $PY 往往是**原生 Windows python**，
#     喂它 `/d/foo` 会被解析成 `D:\d\foo` → "can't open file"。同一类坑在本项目
#     出现过多次（curl 的 cookie jar、run_unit_tests 的 node）。
if "$PY" "$(winpath "$CDIR/gen-mounts.py")" "$(winpath "$OUT")" \
        --env "$(winpath "$OUT/.env.example")" \
        --merge-into "$(winpath "$OUT/docker-compose.base.yml")" \
        --out "$(winpath "$OUT/docker-compose.yml")"; then
  ok "docker-compose.yml（单文件自洽，含默认共享盘挂载）"
else
  bad "合并共享盘挂载失败"; exit 1
fi
# ---------------------------------------------------------------------------
say "4/4 校验产物"
# ★ 离线包里的 compose 绝不能含 build: ★
#   群晖 Container Manager / 威联通 Container Station 这类图形化容器管理器
#   不支持 build:，会转而按 image: 去联网拉取 → 表现为「镜像明明导入了却卡在 Pulling」。
if grep -qE '^[[:space:]]*build:' "$OUT/docker-compose.yml"; then
  bad "产物 compose 里含 build: —— 生成逻辑有问题（gen-run-compose.py 应已剥掉）"
  exit 1
fi
ok "产物 compose 无 build: 段"
# ★ 只数**真正的配置行** ★ 生成物头部注释里也提到了 pull_policy 这个词，
#   用裸 grep 会把注释一起数进去（实测数出 5 处而不是 3 处，假红一次）。
NPULL="$(grep -cE '^    pull_policy: never' "$OUT/docker-compose.yml")"
[ "$NPULL" -eq 3 ] && ok "pull_policy: never × 3" || { bad "pull_policy 数量异常：$NPULL"; exit 1; }
NSVC="$(grep -cE '^  [a-z-]+:$' "$OUT/docker-compose.yml")"
info "产物里「缩进 2 的顶层条目」数：$NSVC（含 networks/volumes 的子项，仅供参考）"

# ★ 单文件里必须真的带上共享盘挂载 ★
#   只数**配置行**：注释里也会出现 NEBULA_MOUNTS 这个词（同一份生成物头部就写了），
#   裸 grep 会假红 —— 同 pull_policy 那次。
NMOUNT="$(grep -cE '^ +NEBULA_MOUNTS:' "$OUT/docker-compose.yml")"
[ "$NMOUNT" -eq 1 ] && ok "单文件里有 NEBULA_MOUNTS 声明" \
  || { bad "单文件里 NEBULA_MOUNTS 声明的行数异常：$NMOUNT"; exit 1; }
NBIND="$(grep -cE '^      - \".*:/mnt/' "$OUT/docker-compose.yml")"
[ "$NBIND" -ge 1 ] && ok "单文件里有 $NBIND 条共享盘绑定" \
  || { bad "单文件里没有任何共享盘绑定 —— 图形界面用户会看不到盘"; exit 1; }
[ -f "$OUT/docker-compose.base.yml" ] && ok "docker-compose.base.yml 就位" \
  || { bad "缺 docker-compose.base.yml —— install.sh 会跑不起来"; exit 1; }
[ -f "$OUT/gen-mounts.py" ] && ok "gen-mounts.py 就位" \
  || { bad "缺 gen-mounts.py —— install.sh 无法生成挂载"; exit 1; }

# ---------------------------------------------------------------------------
if [ "$DO_SAVE" = "1" ]; then
  say "额外：导出镜像 tar"
  detect_docker || exit 1
  save_one() { # $1=镜像 $2=输出名
    local img="$1" out="$2"
    if ! $DK image inspect "$img" >/dev/null 2>&1; then
      warn "本地没有 $img —— 跳过（先 ./nebula/build.sh 或 docker load）"
      return 1
    fi
    echo "  导出 $img → $(basename "$out")…"
    if $DK save -o "$out" "$img"; then
      ( cd "$OUT" && sha256sum "$(basename "$out")" > "$(basename "$out").sha256" )
      ok "$(basename "$out")  $(du -h "$out" | cut -f1)"
    else bad "$img 导出失败"; fi
  }
  # ★ 用 wsl.exe 调 docker 时，-o 必须是 daemon 看得懂的路径（/mnt/...）★
  OUT_FOR_DOCKER="$OUT"
  case "$DK" in *wsl*) OUT_FOR_DOCKER="$(printf '%s' "$OUT" | sed -E 's#^([A-Za-z]):#/mnt/\l\1#')" ;; esac
  save_one "nebula:$VER" "$OUT_FOR_DOCKER/nebula-$VER.tar"
  save_one "nebula/cad-viewer:$CAD_VER" "$OUT_FOR_DOCKER/nebula-cad-viewer-$CAD_VER.tar"
fi

# ---------------------------------------------------------------------------
say "完成"
ls -la "$OUT" | awk 'NR>3{printf "  %10s  %s\n", $5, $9}'
echo
info "拷到目标机器后： bash install.sh"
info "想连镜像一起导出： bash deploy/export-bundle.sh --save"
exit "$FAIL"
