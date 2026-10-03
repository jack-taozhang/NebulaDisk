# =============================================================================
# NebulaDisk —— 云盘 + 反向代理（前门 nginx）单镜像
#
#   FROM ubuntu:24.04
#   + nginx（前门：静态资源/WS/缓存不再穿过 Python）
#   + Python 运行时 + supervisord
#   + NebulaDisk 应用（FastAPI + 仿 Windows 前端）
#
# ★★ 2026-10-04 架构变更：KK 剥离、反代并入 ★★
#   改前：nebula 镜像 = `FROM kkfileview:5.0.2` + Python + supervisord（KK 与应用同体）
#         反代 = 独立容器 nebula-front（nginx:1.27-alpine）+ 宿主目录绑定挂载
#   改后：nebula 镜像 = ubuntu + **nginx（前门）** + 应用
#         kkFileView  → 独立镜像 `kkfileview:<ver>`，独立容器
#
#   为什么把 KK 剥离出去：
#     · 镜像从 2.78GB 降到约 0.7GB。KK 那层（JRE21 + LibreOffice + 中日韩字体，
#       2.05GB）与云盘本体无关，却让「改一行前端也要重建 2GB 层」。
#     · KK 是第三方件，升级节奏与我们无关，不该绑在一起。
#     · 容器职责单一：KK 崩了/吃内存，不再牵连云盘进程。
#     ⚠️ 代价：KK 与应用不再共享进程与文件系统 ⇒ 应用必须用**网络地址**访问 KK
#        （`NEBULA_PREVIEW=http://kkfileview:8012`，见 deploy/docker-compose.yml）。
#
#   为什么把「反代」并进来：
#     · `nebula/nginx/nebula-front.conf` 里那些头部协议（Host / X-Forwarded-Proto /
#       Cookie 兜底）与**应用的取值方式是一对**，分开存放必然漂移。
#       实测事故：只传了 conf 没传它 include 的 `.inc` ⇒ `nginx -t` 照样通过、
#       行为一点没变（map 定义了但没人引用）。
#     · 并进同一镜像后，两者同版本、同发布节奏、同一次 `docker load`。
#     · 容器内 nginx 监听 80，compose 把宿主机 8089 映到它；应用退到 8088（仅本机）。
#
#   ★ KK 的模板定制去哪了 ★
#     以前用 `nebula/overrides/web/*.ftl` 在构建期覆盖 KK jar 内的模板。
#     现在这些模板改为**外置**：`nebula/kkfileview-templates/web/*.ftl`，
#     由 compose 挂进 KK 容器，并用 KK 自带的
#         SPRING_FREEMARKER_TEMPLATE_LOADER_PATH=file:/opt/kk-templates/web/,classpath:/web/
#     让它们**优先于** jar 内的同名模板。
#     ⇒ KK 镜像保持「官方源码、零定制」，我们的定制仍在网盘这一侧。
#
# 为什么 OnlyOffice 不进来 ★ 仍然成立 ★
#   官方 onlyoffice/documentserver 是 6.83GB，内含 PostgreSQL、RabbitMQ、
#   Nginx、Node.js、.NET。合并进来镜像会膨胀到 8GB+，且两套 Web 服务会抢端口。
#   正确做法：OnlyOffice 保持独立容器，两者通过 docker 网络互通：
#     nebula  --(签名URL拉文档)-->  onlyoffice
#     onlyoffice --(反拉 /api/raw)-->  nebula
#   因此本容器必须和 OnlyOffice 在**同一个 docker 网络**上。
#
# 构建（项目根目录）：
#   docker build --network=host -f nebula/Dockerfile -t nebula:1.2.7 .
#   （或： ./nebula/build.sh --nebula-only ，见该脚本）
#
# ⚠️ 构建上下文必须是仓库根目录（不是 nebula/），因为 COPY 路径以仓库根为基准。
# =============================================================================

# ★ 基础镜像用 ubuntu:24.04（与自建 kkfileview 镜像同一底包）★
#   以前是 `FROM kkfileview:5.0.2`（靠它的 JRE/LibreOffice）；剥离 KK 之后
#   不再需要那 2GB 底包，直接用官方 ubuntu 即可。
ARG BASE_IMAGE=ubuntu:24.04

FROM ${BASE_IMAGE}

ARG APT_MIRROR=mirrors.aliyun.com
# 国内 PyPI 镜像。
# 为什么要显式指定：直连 pypi.org 在本机链路不稳 —— 实测同一个 requirements.txt
# 里 fastapi 能下到、uvicorn 却报 "Could not find a version ... (from versions: none)"
# （索引请求直接失败，不是版本不匹配）。与上面 apt 同样处理。
# 实测 mirrors.aliyun.com/pypi/simple/uvicorn/ 返回 200 且含 uvicorn-0.39.0。
ARG PIP_MIRROR=https://mirrors.aliyun.com/pypi/simple/

# ★ `ARG NEBULA_VERSION` + `LABEL …version=` **刻意不放在这里** ★
#   Docker 的缓存规则是「ARG 的值变了 ⇒ 它**第一次被使用**的那条指令 cache miss，
#   之后所有后继指令一律 cache miss」——LABEL 就是第一次使用 ⇒
#   **每次只改版本号都会把下游全部 RUN（apt/pip）整段重跑**。
#   ⇒ 已挪到文件**末尾**（EXPOSE 之后，见文末「版本标签」）。

# -----------------------------------------------------------------------------
# 1. Python 运行时 + supervisord + nginx（前门）
#
# 说明：apt 在这一步偶发「Unable to locate package」——本质是镜像源抖动/缓存
# 半截写入，不是包名写错。因此 update 与 install 都带重试，并强制刷新列表，
# 避免整条链因一次网络抖动白跑（基础镜像层已缓存时，重跑只花十几秒）。
# -----------------------------------------------------------------------------
RUN set -eux; \
    # --- 替换 apt 源（Ubuntu 24.04 用 sources.list.d/ubuntu.sources）---
    if [ -n "${APT_MIRROR}" ]; then \
        if [ -f /etc/apt/sources.list.d/ubuntu.sources ]; then \
            sed -i "s@//.*archive.ubuntu.com@//${APT_MIRROR}@g" /etc/apt/sources.list.d/ubuntu.sources; \
            sed -i "s@//security.ubuntu.com@//${APT_MIRROR}@g"  /etc/apt/sources.list.d/ubuntu.sources; \
        elif [ -f /etc/apt/sources.list ]; then \
            sed -i "s@//.*archive.ubuntu.com@//${APT_MIRROR}@g" /etc/apt/sources.list; \
            sed -i "s@//security.ubuntu.com@//${APT_MIRROR}@g"  /etc/apt/sources.list; \
        fi; \
    fi; \
    export DEBIAN_FRONTEND=noninteractive; \
    APT_OPTS="-o Acquire::Retries=5 -o Acquire::http::Timeout=60 -o Acquire::https::Timeout=60"; \
    ok=0; \
    for i in 1 2 3 4 5 6; do \
        echo "=== 第 $i 次：apt-get update ==="; \
        if ! apt-get $APT_OPTS update; then \
            echo "!!! update 失败，清理索引后重试"; \
            rm -rf /var/lib/apt/lists/*; sleep 5; continue; \
        fi; \
        echo "=== 第 $i 次：apt-get install ==="; \
        if apt-get $APT_OPTS install -y --no-install-recommends --fix-missing \
                python3 python3-pip python3-dev \
                supervisor \
                gcc libc6-dev \
                file curl ca-certificates \
                nginx; then \
            ok=1; break; \
        fi; \
        echo "!!! install 失败，清理索引与缓存后重试"; \
        rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*.deb; \
        sleep 5; \
    done; \
    if [ "$ok" != "1" ]; then echo "apt 连续 6 次失败，放弃"; exit 1; fi; \
    python3 --version; \
    supervisord --version; \
    nginx -v; \
    apt-get clean; \
    rm -rf /var/lib/apt/lists/*

# -----------------------------------------------------------------------------
# 2. Python 依赖
#
# 先拷 requirements.txt 单独成层 —— 改代码时不必重装依赖。
# -----------------------------------------------------------------------------
COPY nebula/requirements.txt /tmp/requirements.txt

RUN set -eux; \
    # Ubuntu 24.04 是 Python 3.12（需 --break-system-packages 才能装到系统环境）
    PIP_BREAK=""; \
    if python3 -c "import sys; exit(0 if sys.version_info >= (3, 12) else 1)" 2>/dev/null; then \
        PIP_BREAK="--break-system-packages"; \
    fi; \
    # 走国内镜像 + 重试：直连 PyPI 会间歇性拿不到索引（实测 uvicorn 报
    # "from versions: none"）。多列两个 trusted-host 是为了 PIP_MIRROR
    # 被换成清华源时也不用再改这行。
    ok=0; \
    for i in 1 2 3; do \
        if pip3 install --no-cache-dir $PIP_BREAK \
                -i "${PIP_MIRROR}" \
                --trusted-host mirrors.aliyun.com \
                --trusted-host pypi.tuna.tsinghua.edu.cn \
                -r /tmp/requirements.txt; then ok=1; break; fi; \
        echo "!!! pip 第 $i 次失败，5 秒后重试"; sleep 5; \
    done; \
    [ "$ok" = "1" ] || { echo "pip 连续 3 次失败，放弃"; exit 1; }; \
    rm -f /tmp/requirements.txt; \
    python3 -c "import fastapi, uvicorn, httpx, bcrypt, multipart; print('依赖 OK')"

# -----------------------------------------------------------------------------
# 3. 应用代码
# -----------------------------------------------------------------------------
WORKDIR /opt/nebula

COPY nebula/app          ./app
COPY nebula/web          ./web
COPY nebula/deploy       ./deploy

# -----------------------------------------------------------------------------
# 3.5 前门 nginx 配置（★ 2026-10-04 新增：反代并进镜像 ★）
#
#   这几个文件**必须一起改、一起发**：
#     nginx.conf          → /etc/nginx/nginx.conf（http 层：proxy_cache_path / log_format）
#     nebula-front.conf   → /etc/nginx/conf.d/default.conf（server 块 + map + upstream）
#     _oo-proxy.inc       → OnlyOffice 的公共转发头（被那 5 个 location include）
#     _oo-cache.inc       → OnlyOffice 的服务端缓存策略
#   ⚠️ 血泪：曾出现「map 定义在新的 conf 里、而引用它的指令在 .inc 里，
#      只传了 conf」⇒ `nginx -t` 通过、行为完全没变（map 没人引用 nginx 不报错）。
#      并进镜像后这一整组永远同版本，此类漂移从根上消失。
# -----------------------------------------------------------------------------
COPY nebula/nginx/nginx.conf        /etc/nginx/nginx.conf
COPY nebula/nginx/nebula-front.conf /etc/nginx/conf.d/default.conf
COPY nebula/nginx/_oo-proxy.inc     /etc/nginx/conf.d/_oo-proxy.inc
COPY nebula/nginx/_oo-cache.inc     /etc/nginx/conf.d/_oo-cache.inc

# ★ 让 nginx 的日志进 docker logs ★
#   apt 装的 nginx 默认把 access/error 写成**真文件**，那样 `docker logs nebula`
#   看不到访问日志（运维习惯就是 docker logs，尤其排查「有没有命中缓存/204/404」）。
#   这里按官方镜像的做法改成软链到 /dev/stdout、/dev/stderr。
# ★ 顺带清掉 apt 默认站点 ★ 它会占用 default_server 与我们的 conf.d/default.conf 撞车。
RUN set -eux; \
    rm -f /etc/nginx/sites-enabled/default; \
    ln -sf /dev/stdout /var/log/nginx/access.log; \
    ln -sf /dev/stderr /var/log/nginx/error.log; \
    mkdir -p /var/cache/nginx/oo; \
    chown -R www-data:www-data /var/cache/nginx 2>/dev/null || true

# -----------------------------------------------------------------------------
# 3.6 ★ 构建期闸门：nginx 配置必须自洽 ★
#   把 `nginx -t` 放进构建里 —— 配置写错就**构建失败**，而不是发出去之后
#   容器起不来（那种情况下 `docker compose up` 只会看到容器反复重启）。
#
#   ⚠️ 但 nginx 在**解析配置时就会解析 upstream 里的主机名**，而构建期**没有
#      docker 网络** ⇒ `onlyoffice` / `kkfileview` / `cad-viewer` 全部解析不到，
#      `nginx -t` 会直接报：
#          [emerg] host not found in upstream "onlyoffice:80"
#      （已用最小 conf 实测确认：上游名不可解析时 `nginx -t` 必失败。）
#   ⇒ 测试**前**往 /etc/hosts 塞临时条目、测完撤掉（只为过闸门，不留在镜像里；
#      运行期 docker 会注入它自己的 /etc/hosts，覆盖同一文件）。
# -----------------------------------------------------------------------------
RUN set -eux; \
    cp /etc/hosts /tmp/hosts.bak; \
    printf '127.0.0.1 onlyoffice\n127.0.0.1 kkfileview\n127.0.0.1 cad-viewer\n' >> /etc/hosts; \
    nginx -t; \
    cp /tmp/hosts.bak /etc/hosts; \
    rm -f /tmp/hosts.bak; \
    echo "nginx 配置自检通过（upstream 主机名仅测试期临时可解析）"

# 启动脚本与事件监听器放到 PATH 上，supervisord 直接按名字调用
RUN set -eux; \
    install -m 0755 deploy/nebula-entrypoint.sh  /usr/local/bin/nebula-entrypoint.sh; \
    install -m 0755 deploy/supervisor-exitmon.py /usr/local/bin/supervisor-exitmon.py; \
    mkdir -p /var/lib/nebula /var/log/nebula; \
    chmod -R a+rX /opt/nebula; \
    python3 -m compileall -q app && echo "Python 代码编译通过"

# supervisord 配置（同时放两份：一份给 supervisord 自己，一份便于查看）
COPY nebula/deploy/supervisord.conf /etc/supervisor/conf.d/nebula.conf

# -----------------------------------------------------------------------------
# 4. 运行环境变量
#
# 这些是**默认值**，实际部署请在 compose 的 environment 里覆盖。
# 特别是映射与密钥，不要用这里的默认值上生产。
# -----------------------------------------------------------------------------
ENV NEBULA_DATA_DIR=/var/lib/nebula \
    NEBULA_PORT=8088 \
    NEBULA_TITLE=NebulaDisk \
    NEBULA_LOG_LEVEL=info \
    NEBULA_ADMIN_USER=admin \
    NEBULA_SESSION_HOURS=12 \
    NEBULA_MAX_UPLOAD_MB=2048
# ★ `NEBULA_PREVIEW` 的默认值已改 ★
#   改前：http://127.0.0.1:8012 —— 那时 KK 与应用同容器，走 loopback。
#   改后：KK 是独立容器 ⇒ 必须用**服务名**。默认值在 compose 里给
#        （NEBULA_PREVIEW=http://kkfileview:8012），因为服务名属于编排层信息，
#        写死在镜像里会在换部署环境时出错。这里**故意不设**，让它必须由编排给。

# ★ kkFileView 的 KK_* 环境变量已从这里**移走** ★
#   那些是给 KK 进程的（Spring relaxed binding），KK 现在跑在独立容器里，
#   所以它们在 compose 的 kkfileview 服务上（见 deploy/docker-compose.yml）。
#   本镜像里留 KK_* 只会误导人以为「本容器里还有 KK」。

EXPOSE 80 8088

# -----------------------------------------------------------------------------
# 6. 版本标签
#
# ★ 为什么放在最末尾 ★
#   ARG 一旦改了值，它**第一次被使用**的那条指令（这里的 LABEL）就 cache miss，
#   而 LABEL 之后的**所有**指令也全部 miss。放在文件头部 ⇒ 改版本号 = 全量重建
#   （apt + pip 全套，几分钟）。放在末尾 ⇒ 只多一个空的元数据层，构建 1 秒内完成。
#   ⚠️ 以后加新指令请加在 **它上面**，别往它后面追加 RUN/COPY。
# -----------------------------------------------------------------------------
ARG NEBULA_VERSION=1.2.7

LABEL org.opencontainers.image.title="NebulaDisk" \
      org.opencontainers.image.description="仿 Windows 云盘 + 前门 nginx（单镜像双进程；预览交给独立容器）" \
      org.opencontainers.image.version="${NEBULA_VERSION}"

# -----------------------------------------------------------------------------
# 5. 启动
#
# ★ 用 supervisord 拉两个进程：nginx（前门，80）+ nebula（应用，8088）★
#   nodaemon=true，所以 supervisord 自己是 PID 1，SIGTERM 会转发给两个子进程，
#   `docker stop` 能优雅退出。
#
# ⚠️ 保留 `ENTRYPOINT []`：底包虽然换成了 ubuntu（没有父 ENTRYPOINT 了），
#   但这条是**给未来换底包用的保险**。历史事故：父镜像的
#   `ENTRYPOINT ["sh","-c","...java..."]` 会让我们的 CMD 变成它的参数 ——
#   容器看起来"正常"（子进程能访问），而云盘进程根本没起来，日志里**零报错**。
# -----------------------------------------------------------------------------
ENTRYPOINT []

CMD ["/usr/bin/supervisord", "-c", "/etc/supervisor/conf.d/nebula.conf"]
