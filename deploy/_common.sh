#!/usr/bin/env bash
# =============================================================================
# _common.sh —— 部署脚本共享库（被 up.sh / install.sh source）
#
#   ★ 为什么要有它 ★
#     「源码构建」和「离线镜像包」两条部署路径的**前置检查与验证完全一样**
#     （探 docker 通道 → 备 .env → 建宿主机目录 → 起栈 → 等健康 → OnlyOffice 链路预检）。
#     以前这些逻辑抄在 install.sh 里，再加一条路径就要抄第二份 —— 必然漂移。
#     所以抽到这里，up.sh / install.sh 各自只保留「我是怎么拿到镜像的」这一件不同的事。
#
#   用法：  . "$(dirname -- "$0")/_common.sh"
#
#   约定：本文件只**定义函数与变量**，不执行任何动作、不解析参数。
# =============================================================================

# ---------------------------------------------------------------------------
# 输出
# ---------------------------------------------------------------------------
say()  { printf '\n\033[1m== %s ==\033[0m\n' "$1"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; FAIL=1; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
info() { printf '    %s\n' "$1"; }
FAIL=0

# ---------------------------------------------------------------------------
# docker 通道探测
#
# 三种可能：本机 docker / sudo docker / 经 wsl.exe 调 docker（Windows + WSL 后端）。
# 结果写进两个全局变量：DK（调用前缀）、COMPOSE（compose 调用前缀）
# ---------------------------------------------------------------------------
detect_docker() {
  DK=""
  for c in "docker" "sudo docker" "wsl.exe -e docker" "wsl.exe docker"; do
    # shellcheck disable=SC2086
    if $c version >/dev/null 2>&1; then DK="$c"; break; fi
  done
  if [ -z "$DK" ]; then
    bad "找不到可用的 docker。Windows 上请用 Docker Desktop + WSL2。"
    return 1
  fi
  ok "docker 可用（$DK）"

  # compose：新版是 `docker compose` 子命令，老版是独立的 docker-compose
  if $DK compose version >/dev/null 2>&1; then
    COMPOSE="$DK compose"
  elif command -v docker-compose >/dev/null 2>&1; then
    COMPOSE="docker-compose"
  else
    bad "没有 compose 插件。请升级 docker，或单独装 docker-compose。"
    return 1
  fi
  ok "compose 可用（$COMPOSE）"
  return 0
}

# ---------------------------------------------------------------------------
# 路径换算：本脚本视角 → docker daemon 视角
#
#   ★ 为什么需要 ★
#     Windows(Git Bash) + `wsl.exe -e docker` 时，脚本里的路径是 MSYS 形式
#     （/d/Docker/...）或 Windows 形式（D:/Docker/...），而 daemon 在 WSL 里，
#     只认 /mnt/d/Docker/...。不换算就会得到「找不到路径」。
#     Linux/NAS 上 daemon 与脚本同视角，原样返回。
#     （这段逻辑与 nebula/build.sh 里的 to_docker_path 同源，别再各写一份。）
# ---------------------------------------------------------------------------
to_docker_path() { # $1=路径
  local p="$1"
  case "$DK" in
    *wsl*)
      case "$p" in
        /mnt/*)          printf '%s\n' "$p" ;;                       # 已经是 daemon 视角
        /[a-zA-Z]/*)     printf '/mnt/%s\n' \
                           "$(printf '%s' "${p#/}" | sed -E 's#^([a-zA-Z])/#\l\1/#')" ;;
        [A-Za-z]:[/\\]*) printf '/mnt/%s\n' \
                           "$(printf '%s' "$p" | sed -E 's#^([A-Za-z]):[/\\]#\l\1/#')" ;;
        *)               printf '%s\n' "$p" ;;
      esac ;;
    *) printf '%s\n' "$p" ;;
  esac
}

# ---------------------------------------------------------------------------
# .env 读写
# ---------------------------------------------------------------------------
# 取某个键的值（取最后一个非注释赋值）
env_get() { # $1=文件 $2=键
  grep -E "^[[:space:]]*$2[[:space:]]*=" "$1" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d ' \r'
}

# .env 不存在时从模板生成
env_bootstrap() { # $1=部署目录 $2=模板路径
  local dir="$1" tpl="$2" f="$1/.env"
  if [ -f "$f" ]; then ok ".env 已存在（$f）"; return 0; fi
  if [ ! -f "$tpl" ]; then bad "既没有 .env 也没有模板 $tpl"; return 1; fi
  cp "$tpl" "$f"
  warn "已从模板生成 $f —— **请先编辑它**，至少确认："
  info "NB_MOUNTS      → 你的真实目录（显示名|宿主机路径|容器内路径|可见用户）"
  info "                 加盘就加一行，数量不限"
  info "NB_ADMIN_PASSWORD → 管理员密码"
  info "NB_OO_SECRET   → OnlyOffice 密钥（留空会启动失败）"
  return 0
}

# ---------------------------------------------------------------------------
# 小工具：python 探测 / MSYS 路径换算
#
# ★ 为什么要 winpath ★
#   本机是 Git Bash（MSYS），但 `python3`/`python` 往往是**原生 Windows 程序**，
#   它读不懂 `/d/foo` 这种 MSYS 路径（会变成 `D:\d\foo`）。所以在 Git Bash 下
#   要转成 `D:/foo`；在 NAS（Linux）上 cygpath 不存在，原样返回正好。
# ---------------------------------------------------------------------------
find_python() {
  local c
  for c in python3 python py; do
    command -v "$c" >/dev/null 2>&1 && { printf '%s' "$c"; return 0; }
  done
  return 1
}

winpath() {
  local p="$1"
  if command -v cygpath >/dev/null 2>&1; then cygpath -m "$p"; return; fi
  printf '%s' "$p"
}

# ---------------------------------------------------------------------------
# 生成「共享盘挂载」叠加编排
#
#   compose 的 volumes 是**静态**的，长不出动态条数，所以「共享盘」由
#   <部署目录>/docker-compose.mounts.yml 这个**生成物**提供，用 -f 追加在
#   主编排之后。真相只有一处：.env 里的 NB_MOUNTS。
#
#   ⇒ 加一个盘 = 在 .env 的 NB_MOUNTS 里加一行，然后重跑本脚本。
#     盘的数量不设上限。
# ---------------------------------------------------------------------------
gen_mounts() { # $1=部署目录 $2=gen-mounts.py 所在目录（源码里的 deploy/）
  local dep="$1" srcdir="$2" py
  py="$(find_python)" || { bad "找不到 python3/python —— 无法生成挂载叠加文件"; return 1; }
  local gen="$srcdir/gen-mounts.py"
  [ -f "$gen" ] || { bad "找不到 $gen"; return 1; }
  # 在部署目录里跑、参数传 "."：这样输出与读到的 .env 都落在部署目录
  if ( cd "$dep" && "$py" "$(winpath "$gen")" . ); then
    ok "挂载叠加文件就绪：$dep/docker-compose.mounts.yml"
  else
    bad "生成挂载叠加文件失败（NB_MOUNTS 格式错？见上面的报错）"
    return 1
  fi
}

# ---------------------------------------------------------------------------
# 生成「单文件自洽」的编排（离线包路径专用）
#
#   图形化容器管理器（群晖 Container Manager / 威联通 Container Station）**只吃
#   一个 compose 文件**，用不了 `-f a.yml -f b.yml` 叠加。所以离线包里那份是把
#   docker-compose.base.yml（纯运行版、不含挂载）与 NB_MOUNTS 派生的挂载
#   **合并**成一个 docker-compose.yml。
#
#   ★ 每次 install.sh 都重新合并 ⇒ 改 NB_MOUNTS 立即生效，且不会留下
#     「上一次的默认挂载」变成孤儿绑定（叠加式会留下，见 gen-mounts.py 的说明）。
# ---------------------------------------------------------------------------
gen_mounts_standalone() { # $1=目录（含 docker-compose.base.yml / gen-mounts.py / .env）
  local dir="$1" py gen="$1/gen-mounts.py"
  py="$(find_python)" || { bad "找不到 python3/python —— 无法生成编排"; return 1; }
  [ -f "$gen" ] || { bad "找不到 $gen（离线包不完整，重新用 deploy/export-bundle.sh 生成）"; return 1; }
  [ -f "$dir/docker-compose.base.yml" ] || { bad "找不到 $dir/docker-compose.base.yml"; return 1; }
  cp -f "$dir/docker-compose.base.yml" "$dir/docker-compose.yml" || return 1
  if ( cd "$dir" && "$py" "$(winpath "$gen")" . --merge-into docker-compose.yml ); then
    ok "已生成单文件编排：$dir/docker-compose.yml"
  else
    bad "把共享盘挂载合并进编排失败（NB_MOUNTS 格式错？见上面的报错）"
    return 1
  fi
}

# ---------------------------------------------------------------------------
# 按 .env 建好缺失的宿主机目录
#
# ★ 不能省 ★ 容器启动时会逐个检查映射路径，不存在就打 ✗ 并**摘掉该映射**，
#   界面上表现为「盘不见了」，用户很难联想到是宿主机目录没建。
#
# 共享盘的路径来自 NB_MOUNTS 的第二段（宿主机路径），相对路径以**部署目录**为基准
# ——与 compose 的 --project-directory 保持一致。
# ---------------------------------------------------------------------------
_mk_dir() { # $1=说明 $2=路径 $3=基准目录
  local what="$1" v="$2" base="$3" d
  [ -n "$v" ] || return 0
  case "$v" in
    /*|[A-Za-z]:[/\\]*) d="$v" ;;
    *) d="$base/${v#./}" ;;
  esac
  if [ -d "$d" ]; then ok "$what → $d"
  elif mkdir -p "$d" 2>/dev/null; then ok "$what → $d（已创建）"
  else bad "$what → $d 无法创建（检查父目录是否存在、是否有写权限）"; fi
}

ensure_host_dirs() { # $1=.env 路径  $2=部署目录（解析相对路径的基准）
  local f="$1" base="${2:-.}" v raw chunk host label old_ifs
  for k in NB_DATA_DIR NB_KK_FILE_DIR NB_KK_LOG_DIR; do
    v="$(env_get "$f" "$k")"
    _mk_dir "$k" "$v" "$base"
  done

  raw="$(env_get "$f" NB_MOUNTS)"
  if [ -n "$raw" ]; then
    old_ifs="$IFS"; IFS=';'
    for chunk in $raw; do
      IFS="$old_ifs"
      chunk="$(printf '%s' "$chunk" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
      if [ -z "$chunk" ]; then IFS=';'; continue; fi
      label="$(printf '%s' "$chunk" | cut -d'|' -f1)"
      host="$(printf '%s' "$chunk" | cut -d'|' -f2)"
      _mk_dir "盘[$label]" "$host" "$base"
      IFS=';'
    done
    IFS="$old_ifs"
  else
    # 兼容还没迁移到 NB_MOUNTS 的老 .env
    for k in NB_SHARE_DIR NB_PHOTOS_DIR NB_PRIVATE_DIR; do
      v="$(env_get "$f" "$k")"
      _mk_dir "$k" "$v" "$base"
    done
  fi
}

# ---------------------------------------------------------------------------
# 外部网络：compose 里 oonet 之类是 external，不存在会让 up 直接失败
# ---------------------------------------------------------------------------
ensure_network() { # $1=网络名
  local n="$1"
  if $DK network inspect "$n" >/dev/null 2>&1; then ok "网络 $n 已存在"; return 0; fi
  if $DK network create "$n" >/dev/null 2>&1; then
    ok "已创建占位网络 $n"
    info "（以后接入 OnlyOffice / cad-viewer 等兄弟容器时加入它即可互通）"
  else
    bad "创建网络 $n 失败"
  fi
}

# ---------------------------------------------------------------------------
# 等容器健康（探云盘自己的 /healthz，它同时反映 kkFileView / OnlyOffice / CAD）
# ---------------------------------------------------------------------------
wait_healthy() { # $1=最长秒数（默认 180）
  local limit="${1:-180}" i=0 n=$(( ${1:-180} / 3 ))
  echo "  等待健康检查（最长 ${limit} 秒）…"
  for i in $(seq 1 "$n"); do
    if $DK exec nebula curl -fsS http://127.0.0.1:8088/healthz >/dev/null 2>&1; then
      ok "容器已就绪"
      return 0
    fi
    sleep 3
  done
  warn "${limit} 秒内未就绪，可执行： $DK logs --tail=50 nebula"
  return 1
}

# ---------------------------------------------------------------------------
# OnlyOffice 链路预检
#
# ★ 为什么必须在安装时就查 ★
#   OnlyOffice 取不到文件时，浏览器那边只有一个「打开文件时发生错误」的对话框，
#   看不出任何有用线索。而根因几乎总是「两个容器不在同一网络」或「基地址填错」。
#   编辑器外壳能渲染 ⇒ 配置与 JWT 是通的；只有正文打不开 ⇒ 失败在
#   「OnlyOffice 服务端去 GET 文档」这一步。所以只查网络与地址。
#
#   更深的排查（converter 日志里的原始报错）交给 diagnose-oo.sh。
# ---------------------------------------------------------------------------
preflight_oo() {
  local OO_CTN NB_BASE H R C OOSEC NBSEC NET_OO
  OO_CTN="$($DK ps --format '{{.Names}} {{.Image}}' 2>/dev/null \
            | grep -i 'onlyoffice' | head -1 | awk '{print $1}')"
  NB_BASE="$(envof nebula NEBULA_BASE_URL)"

  if [ -z "$OO_CTN" ]; then
    warn "本机没找到 OnlyOffice 容器 —— 跳过预检"
    info "Office 文件会走下载，其余格式（PDF/图片/视频/压缩包/代码/CAD）不受影响。"
    return 0
  fi
  ok "找到 OnlyOffice 容器：$OO_CTN"

  # ① 共同网络
  local SHARED="" n
  for n in $(netsof nebula); do
    netsof "$OO_CTN" | grep -qx "$n" && SHARED="$SHARED $n"
  done
  if [ -n "$SHARED" ]; then
    ok "云盘与 OnlyOffice 有共同网络：$SHARED"
  else
    NET_OO="$(netsof "$OO_CTN" | head -1)"
    bad "两者**没有共同网络** —— OnlyOffice 解析不了 'nebula'，文档必然打不开"
    info "OnlyOffice 所在网络：$(netsof "$OO_CTN" | tr '\n' ' ')"
    if [ -n "$NET_OO" ] && $DK network connect "$NET_OO" nebula >/dev/null 2>&1; then
      ok "已临时把云盘接入 $NET_OO（立即生效，无需重启）"
      warn "这只是临时的：下次 compose up 重建容器就会掉。"
      info "请让编排把两个服务放进**同一张**网络（本项目的 deploy/docker-compose.yml 已如此）。"
    fi
  fi

  # ② ★ 决定性检查：从 OnlyOffice 容器去取云盘的文件 ★
  if [ -n "$NB_BASE" ]; then
    H="$(printf '%s' "$NB_BASE" | sed -E 's#^https?://##; s#[:/].*$##')"
    R="$($DK exec "$OO_CTN" getent hosts "$H" 2>/dev/null | head -1 || true)"
    if [ -n "$R" ]; then ok "OnlyOffice 内可解析 $H → $(printf '%s' "$R" | awk '{print $1}')"
    else bad "OnlyOffice 内解析不了 $H（网络没通 / 名字写错）"; fi
    # 状态码只取「最后那个三位数」：docker exec 的 stdout 混进别的行时，
    # 直接整串比较会把「能通」误报成「不通」。
    C="$($DK exec "$OO_CTN" curl -s -o /dev/null -w '%{http_code}' --max-time 8 \
           "${NB_BASE%/}/healthz" 2>/dev/null | tr -d '\r' \
         | grep -oE '[0-9]{3}' | tail -1 || true)"
    C="${C:-000}"
    if [ "$C" = "200" ]; then ok "OnlyOffice → ${NB_BASE%/}/healthz = 200（取流链路通畅）"
    else bad "OnlyOffice → ${NB_BASE%/}/healthz = $C（期望 200）—— Office 文件会打不开"; fi
  else
    bad "NEBULA_BASE_URL 未设置，应用回退到 127.0.0.1:8088 —— OnlyOffice 会取不到文件"
  fi

  # ③ ★ /tmp 必须世界可写 ★
  #   网络通、JWT 也对，仍然可能转换失败 —— 那是**另一类**原因，很容易漏查。
  #   OO 的 converter/docservice 以非 root 的 ds(101:102) 运行，转换时要在
  #   /tmp 下建 ASC_CONVERT* 临时目录；不满足就报
  #       EACCES: permission denied, mkdir '/tmp/ASC_CONVERT…'
  #   症状很迷惑：编辑器**外壳**（工具栏/页码/缩放）能出来，只有**正文**打不开。
  #   ⇒ 光查网络与 JWT 是不够的，必须真的以 ds 身份写一次 /tmp。
  local TMPOUT TMPMODE TMPOWNER
  TMPOUT="$($DK exec "$OO_CTN" ls -ldn /tmp 2>/dev/null | tr -d '\r' | head -1 || true)"
  if [ -n "$TMPOUT" ]; then
    TMPMODE="$(printf '%s' "$TMPOUT" | awk '{print $1}')"
    TMPOWNER="$(printf '%s' "$TMPOUT" | awk '{print $3":"$4}')"
    # 权威判据是这个真写测试，而不是看权限位（有些 NAS 的 ls 输出不易解析）
    if $DK exec --user ds "$OO_CTN" sh -c \
         'mkdir -p /tmp/.nb_probe && rmdir /tmp/.nb_probe' >/dev/null 2>&1; then
      ok "/tmp 对 ds(101) 可写（$TMPMODE $TMPOWNER）"
    else
      bad "/tmp 对 ds(101) **不可写**（$TMPMODE $TMPOWNER）—— 转换必然 EACCES"
      info "症状：编辑器外壳能出来，正文报「打开文件时发生错误」。"
      info "修法：给 onlyoffice 加 tmpfs，并**显式**写 mode=1777 ——"
      info "    tmpfs:"
      info "      - /tmp:rw,exec,size=2G,mode=1777"
      info "★ 注意 `- /tmp` 或 `- /tmp:size=2G` 在很多 NAS 上得到的是 0755，照样不行。"
      info "★ 镜像自带的 /tmp 也**不能**指望：同名 latest 标签在不同机器上 digest 不同，"
      info "  实测有 1777 的，也有 1001:1002 / 755 的。"
    fi
  else
    warn "取不到 $OO_CTN 的 /tmp 信息，跳过这一项"
  fi

  # ④ JWT 密钥一致性
  OOSEC="$(envof "$OO_CTN" JWT_SECRET)"
  NBSEC="$(envof nebula NEBULA_OO_SECRET)"
  if [ -n "$OOSEC" ] && [ -n "$NBSEC" ]; then
    if [ "$OOSEC" = "$NBSEC" ]; then ok "JWT 密钥两边一致"
    else
      bad "JWT 密钥不一致：云盘=$NBSEC / OnlyOffice=$OOSEC"
      info "本项目的编排里两边读的是同一个变量 NB_OO_SECRET，正常不会不一致。"
    fi
  else
    warn "有一边取不到 JWT 密钥，跳过比对（OnlyOffice 可能未启用 JWT）"
  fi

  echo
  info "深入排查（把 converter 日志里的原始报错打出来）："
  info "    bash deploy/diagnose-oo.sh"
}

# ---------------------------------------------------------------------------
# 小工具
# ---------------------------------------------------------------------------
# 读容器里**生效**的环境变量（可能被编排覆盖，不能只看 .env）
envof() { # $1=容器 $2=变量名
  $DK inspect "$1" --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null \
    | grep -E "^$2=" | tail -1 | cut -d= -f2-
}
netsof() { # $1=容器
  $DK inspect "$1" --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' 2>/dev/null \
    | tr ' ' '\n' | grep -v '^$'
}

# 镜像在本地就以 tar 导入（幂等；有 .sha256 就先校验）
load_image_tar() { # $1=tar 路径 $2=镜像名
  local tar="$1" img="$2"
  if $DK image inspect "$img" >/dev/null 2>&1; then ok "$img 已存在，跳过导入"; return 0; fi
  if [ ! -f "$tar" ]; then bad "本地没有 $img，也找不到 $tar"; return 1; fi
  if [ -f "$tar.sha256" ] && command -v sha256sum >/dev/null 2>&1; then
    echo "  校验 $(basename "$tar") 完整性…"
    if sha256sum -c "$tar.sha256" >/dev/null 2>&1; then ok "SHA256 校验通过"
    else bad "$tar 校验不通过（传输损坏？请重新拷贝）"; return 1; fi
  fi
  echo "  正在导入 $(basename "$tar")…"
  if $DK load -i "$tar" >/dev/null 2>&1; then ok "$img 导入完成"
  else bad "$tar 导入失败"; return 1; fi
}

# 收尾：打印访问地址与常用命令
print_done() { # $1=部署目录 $2=compose 文件 $3=额外 compose 参数(可空)
  local dir="$1" cfile="$2" extra="${3:-}" PORT HOST
  PORT="$(env_get "$dir/.env" NB_HOST_PORT)"; PORT="${PORT:-8089}"
  say "完成"
  HOST="$(hostname -I 2>/dev/null | awk '{print $1}')"
  echo "  访问地址： http://${HOST:-<本机IP>}:$PORT"
  echo
  echo "  管理员密码："
  if [ -z "$(env_get "$dir/.env" NB_ADMIN_PASSWORD)" ]; then
    echo "    .env 里留空了 → 是随机生成的，用下面命令取："
    echo "      $DK logs nebula 2>&1 | grep 管理员"
  else
    echo "    就是 .env 里 NB_ADMIN_PASSWORD 的值"
  fi
  echo
  echo "  常用命令（在 $dir 下执行）："
  echo "    日志： $DK logs -f nebula"
  # shellcheck disable=SC2086
  echo "    停止： $COMPOSE -f $cfile $extra stop"
  # shellcheck disable=SC2086
  echo "    启动： $COMPOSE -f $cfile $extra up -d"
}
