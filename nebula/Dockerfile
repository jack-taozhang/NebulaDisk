# =============================================================================
# NebulaDisk —— 云盘 + kkFileView 单镜像
#
#   FROM kkfileview:5.0.2        ← 复用已构建好的 kkFileView 镜像
#   + Python 运行时 + supervisord
#   + NebulaDisk 应用（FastAPI + 仿 Windows 前端）
#
# 为什么 FROM kkfileview:5.0.2 而不是 FROM ubuntu：
#   kkFileView 那层已经装好了 JRE21 + LibreOffice + 中日韩字体（约 1.5GB）。
#   重装一遍既慢又容易漏字体（漏了中文文档预览就是方框）。
#
# ★ OnlyOffice 为什么不进来 ★
#   官方 onlyoffice/documentserver 是 6.83GB，内含 PostgreSQL、RabbitMQ、
#   Nginx、Node.js、.NET。合并进来镜像会膨胀到 8GB+，且两套 Web 服务会抢端口。
#   正确做法：OnlyOffice 保持独立容器，两者通过 docker 网络互通：
#     nebula  --(签名URL拉文档)-->  onlyoffice
#     onlyoffice --(反拉 /api/raw)-->  nebula
#   因此本容器必须和 OnlyOffice 在**同一个 docker 网络**上。
#
# 构建（项目根目录）：
#   docker build --network=host -f nebula/Dockerfile -t nebula:1.0.0 .
#
# ⚠️ 构建上下文必须是仓库根目录（不是 nebula/），因为基础镜像 kkfileview:5.0.2
#    需要在本地存在；若用 nebula/ 作上下文，COPY 路径也得跟着改。
# =============================================================================

ARG KK_BASE_IMAGE=kkfileview:5.0.2

FROM ${KK_BASE_IMAGE}

ARG APT_MIRROR=mirrors.aliyun.com
ARG NEBULA_VERSION=1.0.0

LABEL org.opencontainers.image.title="NebulaDisk" \
      org.opencontainers.image.description="仿 Windows 云盘 + kkFileView 预览（单镜像双进程）" \
      org.opencontainers.image.version="${NEBULA_VERSION}"

# -----------------------------------------------------------------------------
# 1. Python 运行时 + supervisord
#
# ubuntu:24.04 自带 python3.12。不装 python3-venv，直接系统级 pip 安装到
# /usr/local —— 镜像内专用，不存在污染宿主的问题。
# --break-system-packages 是 Ubuntu 24.04 的 PEP668 保护，容器里必须加。
# -----------------------------------------------------------------------------
# 说明：apt 在这一步偶发「Unable to locate package」——本质是镜像源抖动/缓存
# 半截写入，不是包名写错。因此 update 与 install 都带重试，并强制 -o 刷新列表，
# 避免整条链因一次网络抖动白跑（基础镜像层已缓存时，重跑只花十几秒）。
# 说明：这一步曾多次以 exit 100 失败，报「Unable to locate package」。
#   实测（见 nebula/tools/diag_apt.sh）真相是：
#     · 镜像源本身没问题，apt-get update 能正常拉完 32.7MB 索引；
#     · 单次 update 要 50 秒左右，网络慢且偶发抖动；
#     · 原写法把 update 与 install 串在一条 RUN 里，update 偶发半截失败后
#       install 直接在空索引上跑 → 报「找不到包」，看起来像包名写错。
#   对策：update 与 install 都进重试循环，并给 apt 显式超时与重试参数。
# ─────────────────────────────────────────────────────────────────────────────
RUN set -eux; \
    if [ -n "${APT_MIRROR}" ]; then \
        sed -i "s@//.*archive.ubuntu.com@//${APT_MIRROR}@g" /etc/apt/sources.list.d/ubuntu.sources; \
        sed -i "s@//security.ubuntu.com@//${APT_MIRROR}@g"  /etc/apt/sources.list.d/ubuntu.sources; \
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
                file; then \
            ok=1; break; \
        fi; \
        echo "!!! install 失败，清理索引与缓存后重试"; \
        rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*.deb; \
        sleep 5; \
    done; \
    if [ "$ok" != "1" ]; then echo "apt 连续 6 次失败，放弃"; exit 1; fi; \
    python3 --version; \
    supervisord --version; \
    apt-get clean; \
    rm -rf /var/lib/apt/lists/*

# -----------------------------------------------------------------------------
# 2. Python 依赖
#
# 先拷 requirements.txt 单独成层 —— 改代码时不必重装依赖。
# -----------------------------------------------------------------------------
COPY nebula/requirements.txt /tmp/requirements.txt

RUN set -eux; \
    pip3 install --no-cache-dir --break-system-packages -r /tmp/requirements.txt; \
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
# 3.5 覆盖 kkFileView 的页面模板（compress.ftl 等）
#
# 这些模板被编译进 jar 的 BOOT-INF/classes/web/*.ftl。改模板**不需要**动 Java
# 代码，所以不必为此重跑一遍 Maven package（基础镜像那条路要几分钟 + 联网）；
# 直接在构建期替换 jar 内对应的资源条目即可，几秒钟完成。
#
# 覆盖清单维护在 nebula/overrides/ 下，目录结构与 jar 内一一对应：
#     overrides/web/compress.ftl -> BOOT-INF/classes/web/compress.ftl
#     overrides/web/svg.ftl      -> BOOT-INF/classes/web/svg.ftl
# 脚本找不到目标条目会直接失败，避免「构建成功但页面还是旧的」这种静默失败。
# -----------------------------------------------------------------------------
COPY nebula/overrides /tmp/overrides
RUN set -eux; \
    JAR="$(ls /opt/kkFileView-*/bin/kkFileView-*.jar | head -1)"; \
    echo "目标 jar: $JAR"; \
    python3 /opt/nebula/deploy/overlay_templates.py "$JAR" /tmp/overrides; \
    rm -rf /tmp/overrides

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
# 这些是**默认值**，实际部署请在 compose/compose 的 environment 里覆盖。
# 特别是映射与密钥，不要用这里的默认值上生产。
# -----------------------------------------------------------------------------
ENV NEBULA_DATA_DIR=/var/lib/nebula \
    NEBULA_PORT=8088 \
    NEBULA_TITLE=NebulaDisk \
    NEBULA_LOG_LEVEL=info \
    NEBULA_ADMIN_USER=admin \
    NEBULA_PREVIEW=http://127.0.0.1:8012 \
    NEBULA_PREVIEW_PUBLIC=/preview \
    NEBULA_SESSION_HOURS=12 \
    NEBULA_MAX_UPLOAD_MB=2048

# kkFileView 侧：这些是**产品固定行为**，不是部署参数，所以定在这里，
# 不要在每个 compose 里再抄一遍（抄了就会两处漂移）。
ENV KK_TRUST_HOST="*" \
    KK_BASE_URL=default \
    KK_CACHE_TYPE=jdk \
    KK_OFFICE_PREVIEW_TYPE=pdf \
    KK_OFFICE_QUALITY=80 \
    KK_DELETE_PASSWORD=false \
    OFFICE_PLUGIN_SERVER_PORTS=2001
# KK_TRUST_HOST 的用途说明：
#   kkFileView 要回拉本容器（签名的 raw 直链）。trust.host 是 4.4+ 的 SSRF 白名单，
#   不放开的话预览必 403。
# 这些变量名是 Spring 的 relaxed binding：KK_OFFICE_PREVIEW_TYPE → kk.office.preview.type。
# 需要临时覆盖时，在 compose 的 environment 里写同名变量即可（env 优先于镜像 ENV）。

EXPOSE 8012 8088

# -----------------------------------------------------------------------------
# 5. 启动
#
# ⚠️ 必须 ENTRYPOINT [] 清空基础镜像继承的 ENTRYPOINT ★
#   基础镜像 kkfileview:5.0.2 里有
#       ENTRYPOINT ["sh","-c","...java..."]
#   Docker 的规则是：子镜像若只设 CMD，CMD 会变成**父 ENTRYPOINT 的参数**。
#   结果是 java 照常启动、我们的 supervisord 被当成多余参数丢掉 ——
#   容器看起来"正常"（kkFileView 能访问），但云盘进程根本没起来，
#   而且日志里**没有任何报错**，极难发现（第一次就踩了这个坑）。
#   清空 ENTRYPOINT 后再设 CMD，才能真正改用 supervisord 当 PID 1。
# -----------------------------------------------------------------------------
ENTRYPOINT []

# 用 supervisord 拉两个进程。nodaemon=true，所以它自己是 PID 1。
# supervisord 会把 SIGTERM 转发给两个子进程，docker stop 能优雅退出。
CMD ["/usr/bin/supervisord", "-c", "/etc/supervisor/conf.d/nebula.conf"]
