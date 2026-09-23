#!/usr/bin/env bash
# =============================================================================
# diagnose-oo.sh —— OnlyOffice 打不开文档 的现场诊断
#
#   在**部署机器**上执行（需要 docker 权限）：
#       bash diagnose-oo.sh
#
#   它只读不写，最后给出结论与修复命令。
#
# ★ 为什么需要这个脚本 ★
#   OnlyOffice 报「打开文件时发生错误」时，浏览器那边**看不出任何有用信息**。
#   真正的线索只在两个地方：
#     ① OnlyOffice 容器能不能解析并连上 NEBULA_BASE_URL 指向的地址；
#     ② OnlyOffice 的 converter 日志里的原始报错行。
#   这个脚本把这两件事一次性摊开。
#
# ★ 根因的判断依据 ★
#   编辑器**外壳**（工具栏/页码/缩放）能渲染出来 ⇒ 配置下发与 JWT 都是通的；
#   只有**正文**打不开 ⇒ 失败发生在「OnlyOffice 服务端去 GET 文档」这一步。
#   所以排查范围天然就缩小到「网络能否互通 + 地址填得对不对」，与 JWT、
#   与前端都无关。
# =============================================================================
set -u

say()  { printf '\n\033[1m== %s ==\033[0m\n' "$1"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
info() { printf '    %s\n' "$1"; }

# ---- docker 通道 ----
# 依次尝试：本机 docker → 本机 sudo docker → 经 wsl.exe 调 docker
# （最后一种是为 Windows + WSL 后端的场景准备的，与 nebula/build.sh 同款处理）
DK=""
for c in "docker" "sudo docker" "wsl.exe -e docker" "wsl.exe docker"; do
    $c version >/dev/null 2>&1 && { DK="$c"; break; }
done
if [ -z "$DK" ]; then
    bad "找不到 docker。本脚本要在部署机器上、有 docker 权限的环境里跑。"
    exit 1
fi

NB="${NB_CONTAINER:-nebula}"
OO_USER="${OO_CONTAINER:-}"       # 留空则自动探测

envof() { # $1=容器名 $2=变量名
    $DK inspect "$1" --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null \
      | grep -E "^$2=" | tail -1 | cut -d= -f2-
}
netsof() {
    $DK inspect "$1" --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' 2>/dev/null | tr ' ' '\n' | grep -v '^$'
}

# ---------------------------------------------------------------------------
say "0. 找到容器"
if ! $DK inspect "$NB" >/dev/null 2>&1; then
    bad "找不到云盘容器 '$NB'（可用 NB_CONTAINER 指定别的名字）"
    exit 1
fi
ok "云盘容器：$NB"

OO=""
if [ -n "$OO_USER" ]; then
    $DK inspect "$OO_USER" >/dev/null 2>&1 && OO="$OO_USER"
else
    # ① 先用 NEBULA_OO_URL 里的主机名当容器名试
    host_try="$(envof "$NB" NEBULA_OO_URL | sed -E 's#^https?://##; s#[:/].*$##')"
    [ -n "$host_try" ] && $DK inspect "$host_try" >/dev/null 2>&1 && OO="$host_try"
    # ② 再扫镜像名里带 onlyoffice 的容器
    if [ -z "$OO" ]; then
        OO="$($DK ps --format '{{.Names}} {{.Image}}' 2>/dev/null \
             | grep -i 'onlyoffice' | head -1 | awk '{print $1}')"
    fi
fi
if [ -z "$OO" ]; then
    warn "没找到 OnlyOffice 容器（可设 OO_CONTAINER=名字 指定）"
    info "如果 OnlyOffice 跑在别的机器/以 NAS 套件形式安装，"
    info "那么 NEBULA_BASE_URL 必须填那台机器能访问到的地址，见下面第 3 节。"
else
    ok "OnlyOffice 容器：$OO"
fi

# ---------------------------------------------------------------------------
say "1. 云盘的取流基地址（决定 OnlyOffice 去哪拿文件）"
NB_BASE="$(envof "$NB" NEBULA_BASE_URL)"
NB_OOURI="$(envof "$NB" NEBULA_OO_URL)"
NB_SECRET="$(envof "$NB" NEBULA_OO_SECRET)"
if [ -z "$NB_BASE" ]; then
    bad "NEBULA_BASE_URL 未设置"
    info "应用会回退到 http://127.0.0.1:8088 —— 那是【OnlyOffice 自己的】localhost，"
    info "必然取不到文件。这是最常见的根因。"
    info "修复：.env 里设 NEBULA_BASE_URL=http://nebula:8088"
else
    ok "NEBULA_BASE_URL = $NB_BASE"
    case "$NB_BASE" in
        *127.0.0.1*|*localhost*)
            bad "填成了 localhost —— OnlyOffice 容器里的 localhost 是它自己！"
            info "修复：改为 http://$NB:8088（用容器名 + 容器端口）" ;;
        *:8089*|*:${NB_HOST_PORT:-8089}*)
            warn "端口像是宿主机映射端口。容器间互通应该用**容器端口 8088**。"
            info "若 OnlyOffice 与云盘不在同一台机器，才需要用宿主地址，"
            info "而且还要在 OnlyOffice 侧放行私有 IP（见第 4 节）。" ;;
    esac
fi
[ -n "$NB_OOURI" ] && info "NEBULA_OO_URL    = $NB_OOURI"
if [ -n "$NB_SECRET" ]; then
    ok "NEBULA_OO_SECRET 已设置（长度 ${#NB_SECRET}）"
else
    bad "NEBULA_OO_SECRET 为空 —— 与 OnlyOffice 的 JWT_SECRET 不一致时编辑器会直接打不开"
fi

# ---------------------------------------------------------------------------
say "2. 两个容器是否在同一个 docker 网络上"
NBNETS="$(netsof "$NB")"
info "云盘 所在网络：$(printf '%s' "$NBNETS" | tr '\n' ' ')"
if [ -n "$OO" ]; then
    OONETS="$(netsof "$OO")"
    info "OnlyOffice 所在网络：$(printf '%s' "$OONETS" | tr '\n' ' ')"
    SHARED=""
    for n in $NBNETS; do
        printf '%s\n' "$OONETS" | grep -qx "$n" && SHARED="$SHARED $n"
    done
    if [ -n "$SHARED" ]; then
        ok "有共同网络：$SHARED"
        info "所以在 OnlyOffice 里 '$NB' 这个主机名是可以解析的。"
    else
        bad "没有共同网络 —— OnlyOffice 解析不了主机名 '$NB'，这正是报错的直接原因"
        info "修复（任选其一）："
        info "  A) 把 .env 的 NB_OO_NETWORK 改成 OnlyOffice 所在的那个网络名，再 up -d"
        info "  B) 临时接一下： docker network connect <OnlyOffice的网络> $NB"
        info "     ⚠️ 下次 compose up 重建容器会掉，A 才是长久办法"
    fi
else
    info "（没找到 OnlyOffice 容器，跳过网络比对）"
fi

# ---------------------------------------------------------------------------
say "3. ★ 决定性检查：模拟 OnlyOffice 去取文件 ★"
if [ -n "$OO" ]; then
    H="$(printf '%s' "${NB_BASE:-http://127.0.0.1:8088}" | sed -E 's#^https?://##; s#[:/].*$##')"
    info "在 OnlyOffice 容器内解析 '$H'："
    R="$($DK exec "$OO" getent hosts "$H" 2>/dev/null | head -1 || true)"
    if [ -n "$R" ]; then ok "$R"; else
        bad "解析失败 —— 环境不对（网络不同 / 名字写错 / 容器已停）"
    fi
    info "在 OnlyOffice 容器内请求 ${NB_BASE:-http://127.0.0.1:8088}/healthz："
    # 只取最后那个三位数：`docker exec` 的 stdout 混进别的行时，
    # 直接整串比较会把「能通」误报成「不通」。
    CODE="$($DK exec "$OO" curl -s -o /dev/null -w '%{http_code}' --max-time 8 \
            "${NB_BASE:-http://127.0.0.1:8088}/healthz" 2>/dev/null | tr -d '\r' \
          | grep -oE '[0-9]{3}' | tail -1 || true)"
    CODE="${CODE:-000}"
    case "$CODE" in
        200) ok "200 —— 链路是通的，取流不该失败。请把第 5 节的日志一起看" ;;
        000) bad "连不上（超时/解析失败/被防火墙拦）" ;;
        403|422) warn "返回 $CODE —— 网络通了，但**取流被签名校验拒绝**。
     常见原因：只有一台云盘实例吗？NEBULA_JWT_SECRET 是否被改过？" ;;
        *) bad "返回 $CODE（期望 200）" ;;
    esac
else
    warn "没有 OnlyOffice 容器可用来做这项检查"
    info "请在那台机器上手工执行： curl -sS -o /dev/null -w '%{http_code}\\n' ${NB_BASE:-<你的NB_BASE_URL>}/healthz"
fi

# 反向：云盘能否连上 OnlyOffice（这不是报错原因，但顺手一起看）
if [ -n "$NB_OOURI" ]; then
    info "反向检查：云盘容器内请求 ${NB_OOURI%/}/healthcheck"
    C2="$($DK exec "$NB" curl -s -o /dev/null -w '%{http_code}' --max-time 8 \
           "${NB_OOURI%/}/healthcheck" 2>/dev/null | tr -d '\r' \
         | grep -oE '[0-9]{3}' | tail -1 || true)"
    C2="${C2:-000}"
    [ "$C2" = "200" ] && ok "200" || warn "返回 $C2（仅影响健康面板显示，不是本次报错的根因）"
fi

# ---------------------------------------------------------------------------
say "4. ★ converter 的 /tmp 是否可写（本地 IO 类故障）★"
#
# 这类故障的日志长得完全不一样，与网络无关：
#   EACCES: permission denied, mkdir '/tmp/ASC_CONVERT2026xxxx-xxxx'
#     at getTempDir (server/FileConverter/sources/converter.js)
#
# 原理：converter / docservice 由 supervisord 拉起，**user=ds**（uid 101 这类
#       非 root 用户）。它要在 /tmp 下建临时目录，所以 /tmp 必须**世界可写**
#       （other 位要有 w+x，即 1777）。
if [ -n "$OO" ]; then
    TMPM="$( $DK exec "$OO" ls -ldn /tmp 2>/dev/null | awk '{print $1, $3":"$4}' )"
    echo "  容器内 /tmp = $TMPM"
    case "$TMPM" in
        drwxrwxrwt*) ok "/tmp 是世界可写（1777），ds 能写" ;;
        "") warn "取不到 /tmp 权限（容器在跑吗？）" ;;
        *)  bad "/tmp **不是** drwxrwxrwt —— ds 用户会写不进去，文档必然打不开" ;;
    esac
    echo "  tmpfs 配置 = $($DK inspect "$OO" --format '{{json .HostConfig.Tmpfs}}' 2>/dev/null)"

    # 直接以 ds 身份做一次与 getTempDir 完全同款的操作
    DSCHK="$( $DK exec "$OO" su -s /bin/sh ds -c \
              'mkdir -p /tmp/__dsprobe 2>/dev/null && echo OK && rmdir /tmp/__dsprobe' 2>&1 | tail -1 )"
    if [ "$DSCHK" = "OK" ]; then
        ok "以 ds 用户实测建目录成功"
    else
        bad "以 ds 用户建目录失败：$DSCHK"
        echo
        echo "  ★ 两类成因，用下面这条命令区分 ★"
        echo "     从**镜像本身**起一个全新容器看 /tmp："
        echo "       $DK run --rm --entrypoint sh <OO镜像> -c 'ls -ldn /tmp'"
        echo "     · 若输出不是 drwxrwxrwt ⇒ **镜像自身**的 /tmp 权限是错的"
        echo "       （官方只读预览镜像正常是 drwxrwxrwt root:root；"
        echo "        被 NAS 侧重打过的镜像可能是 0755）"
        echo "     · 若输出是 drwxrwxrwt，但运行中的容器不是 ⇒ 是挂载/启动参数改掉的"
        echo
        echo "  ★ 修复：给 /tmp 挂 tmpfs 并**显式写 mode=1777** ★"
        echo "       services:"
        echo "         <oo服务名>:"
        echo "           tmpfs:"
        echo "             - /tmp:rw,exec,size=2G,mode=1777"
        echo "     ⚠️ 有些 NAS 的 Docker 给 tmpfs 的**默认 mode 是 0755**（不是标准的"
        echo "        1777），所以**不能**简写成 'tmpfs: - /tmp' 或只写 size ——"
        echo "        实测那两种写法得到的仍是 drwxr-xr-x，ds 依然写不进去。"
        echo "     ⚠️ 同时不要设 read_only: true、不要设 user:（converter 要能写文件系统）。"
    fi
fi

# ---------------------------------------------------------------------------
say "5. JWT 密钥是否一致"
if [ -n "$OO" ]; then
    OOSEC="$($DK inspect "$OO" --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null \
            | grep -E '^JWT_SECRET=' | tail -1 | cut -d= -f2-)"
    if [ -n "$OOSEC" ] && [ -n "$NB_SECRET" ]; then
        if [ "$OOSEC" = "$NB_SECRET" ]; then
            ok "两边一致"
        else
            bad "不一致！云盘=$NB_SECRET / OnlyOffice=$OOSEC"
            info "把 .env 的 NB_OO_SECRET 改成 OnlyOffice 那个值，再 up -d"
        fi
    else
        warn "取不到其中一边的密钥（OO 可能未启用 JWT）"
    fi
    info "OnlyOffice 若被允许访问私有 IP 的开关关着，用 **IP 字面量**"
    info "（如 http://192.168.1.10:8089）取文件会被拒，日志会写"
    info "\"It is private IP address\"。用**主机名**不受影响。"
    info "要放行：进容器改 /etc/onlyoffice/documentserver/default.json 的"
    info "  services.CoAuthoring.request-filtering-agent 里两个值改 true，再重启容器。"
fi

# ---------------------------------------------------------------------------
say "6. ★ OnlyOffice converter 日志里的原始报错 ★"
if [ -n "$OO" ]; then
    for f in /var/log/onlyoffice/documentserver/converter/out.log; do
        echo "  --- $f 最后 20 行 ---"
        $DK exec "$OO" sh -c "tail -20 $f 2>/dev/null" 2>/dev/null | sed 's/^/    /' || echo "    （读不到）"
    done
    echo
    echo "  --- 关键词命中 ---"
    for kw in 'private IP' 'not allowed' 'ECONNREFUSED' 'ENOTFOUND' 'timed out' 'Download' 'download failed'; do
        hit="$($DK exec "$OO" sh -c "grep -i '$kw' /var/log/onlyoffice/documentserver/converter/out.log 2>/dev/null | tail -2" 2>/dev/null)"
        [ -n "$hit" ] && { printf '    [%s]\n' "$kw"; printf '%s\n' "$hit" | sed 's/^/      /'; }
    done
    info "（上面没有输出 = 该关键词没命中）"
    echo
    echo "  提示：日志行里的主机名/IP 就是 OnlyOffice 真正去拉的地址，"
    echo "        直接拿它和 .env 里的 NEBULA_BASE_URL 对比，答案往往就在那里。"
fi

# ---------------------------------------------------------------------------
say "结论怎么读"
cat <<'EOF'
  【类 A：取不到文件（网络/地址）】看第 3 节
  · 第 3 节解析/请求失败   → 网络没通：改 NB_OO_NETWORK，或 docker network connect
  · 第 3 节返回 403/422    → 网络通了但签名被拒：查 NEBULA_JWT_SECRET / 是否有多实例
  · 第 6 节出现 private IP → OnlyOffice 拒绝私有地址：改用主机名，或放行私有 IP
  · 第 1 节端口写成 8089   → 容器间互通要用容器端口 8088

  【类 B：文件取到了但转换失败（本地 IO/权限）】看第 4、6 节
  · 第 4 节 /tmp 不是 drwxrwxrwt，或 ds 建目录失败
      → /tmp 不可写。**修复：给 /tmp 挂 tmpfs 且显式写 mode=1777**
        （部分 NAS 的 Docker 给 tmpfs 的默认 mode 是 0755，只写 size 不管用）
  · 第 6 节出现 EACCES / EPERM
      → 同上，或数据目录属主不对（ds=101 写不进去）

  · 一切正常但正文仍打不开 → 把第 6 节最后 20 行原样发出来
EOF
