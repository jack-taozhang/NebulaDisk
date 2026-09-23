# =============================================================================
# kkFileView 5.0.2 —— 自包含多阶段构建（面向 iframe 嵌入场景）
#
#   阶段 1 builder     : maven + JDK21 编译源码 → kkFileView-5.0.2.tar.gz
#   阶段 2 runtime-base: ubuntu:24.04 + JRE21 + LibreOffice + 中文字体
#                        （等价于官方 keking/kkfileview-base，但自行构建）
#   阶段 3 final       : 只叠加应用本体
#
# 为什么自己建基础层？
#   官方基础镜像 keking/kkfileview-base 在常用国内镜像站均取不到
#   （1ms.run / rat.dev 返回 not found，daocloud / xuanyuan / 1panel 返回 403），
#   而 library/ubuntu:24.04 可以正常拉取。自建后镜像完全自包含、可复现。
#
# 构建（项目根目录）：
#   docker build --network=host -t kkfileview:5.0.2 .
#
# ⚠️ --network=host 在本机是必需的：WSL2 生成的 /etc/resolv.conf 指向
#    10.255.255.254，该 DNS 代理在 docker bridge 网段不可达，容器内会报
#    "Temporary failure resolving"。走 host 网络即恢复正常。
#
# 只验证运行时基础层（快，不触发 Maven 构建）：
#   docker build --network=host --target runtime-base -t kkfileview-base:5.0.2 .
# =============================================================================

ARG MAVEN_IMAGE=maven:3.9-eclipse-temurin-21
ARG UBUNTU_IMAGE=ubuntu:24.04
# 应用版本号。
# ⚠️ 升级版本时，除了改这里，还要同步修改下方 ENTRYPOINT 中硬编码的 5.0.2 路径
#    （exec form 不展开变量）。下面的自检会在不一致时直接让构建失败。
ARG KK_VERSION=5.0.2


# -----------------------------------------------------------------------------
# 阶段 1：编译打包
# -----------------------------------------------------------------------------
FROM ${MAVEN_IMAGE} AS builder

# 国内 Maven 加速（只镜像 central；aspose 私服不在 mirrorOf 范围，仍走原地址）
COPY docker/maven/settings.xml /root/.m2/settings.xml

WORKDIR /build

# 先只拷 POM，把依赖解析单独成层 —— 改代码时不必重新下载依赖
COPY src/pom.xml ./pom.xml
COPY src/server/pom.xml ./server/pom.xml
RUN mvn -B -pl server -am -DskipTests -Dmaven.wagon.http.retryHandler.count=3 \
        dependency:go-offline || true

# 再拷源码
COPY src/server/src ./server/src

# pom 里 jai_core / jai_codec 是 <scope>system</scope> + <systemPath>${pom.basedir}/lib/...，
# Maven 不走仓库、只按文件路径找，所以 server/lib 必须一起进上下文，否则 package 阶段直接失败：
#   Could not find artifact javax.media:jai_core:jar:1.1.3 at specified path /build/server/lib/jai_core-1.1.3.jar
COPY src/server/lib ./server/lib

# dist-win32.xml 会引用仓库里的 LibreOfficePortable（821MB，Windows 便携版），
# 构建 Linux 镜像用不到、已从上下文排除，这里建空目录占位，
# 避免 win32 的 assembly fileSet 因目录缺失而报错。
RUN mkdir -p server/LibreOfficePortable

RUN mvn -B -pl server -am -DskipTests package \
    && echo "----- 构建产物 -----" \
    && ls -lh server/target/ | grep -E "tar\.gz|\.jar"


# -----------------------------------------------------------------------------
# 阶段 2：运行时基础层（替代官方 keking/kkfileview-base）
# -----------------------------------------------------------------------------
FROM ${UBUNTU_IMAGE} AS runtime-base

ARG APT_MIRROR=mirrors.aliyun.com

# 系统依赖。相比上游 Dockerfile 的包列表做了三处修正：
#   1. ttf-wqy-microhei / ttf-wqy-zenhei 在 Ubuntu 24.04 已改名为 fonts-wqy-*，
#      沿用旧名会 "no installation candidate" 直接失败 —— 这里用新名并补 Noto CJK。
#   2. ttf-mscorefonts-installer 需联网从 SourceForge 下载并接受 EULA，
#      网络不通会中断构建；改用 fonts-liberation2 + fonts-crosextra-carlito
#      （与 Arial / Times New Roman / Calibri 度量兼容，版式影响很小）。
#      确实需要微软字体时，在下面 apt 步骤后自行追加安装即可。
#   3. 额外装 curl，便于容器内排查接口问题。
RUN set -eux; \
    if [ -n "${APT_MIRROR}" ]; then \
        sed -i "s@//.*archive.ubuntu.com@//${APT_MIRROR}@g"  /etc/apt/sources.list.d/ubuntu.sources; \
        sed -i "s@//security.ubuntu.com@//${APT_MIRROR}@g"   /etc/apt/sources.list.d/ubuntu.sources; \
        sed -i "s@//ports.ubuntu.com@//${APT_MIRROR}@g"      /etc/apt/sources.list.d/ubuntu.sources; \
    fi; \
    export DEBIAN_FRONTEND=noninteractive; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        openjdk-21-jre \
        libreoffice-nogui \
        tzdata locales xfonts-utils fontconfig \
        fonts-wqy-microhei fonts-wqy-zenhei xfonts-wqy \
        fonts-noto-cjk \
        fonts-liberation2 fonts-crosextra-carlito \
        ca-certificates curl; \
    echo 'Asia/Shanghai' > /etc/timezone; \
    ln -sf /usr/share/zoneinfo/Asia/Shanghai /etc/localtime; \
    localedef -i zh_CN -c -f UTF-8 -A /usr/share/locale/locale.alias zh_CN.UTF-8; \
    locale-gen zh_CN.UTF-8; \
    fc-cache -fv >/dev/null; \
    apt-get autoremove -y; \
    apt-get clean; \
    rm -rf /var/lib/apt/lists/*; \
    test -x /usr/lib/libreoffice/program/soffice.bin; \
    echo "soffice.bin 就位"; \
    java -version

ENV LANG=zh_CN.UTF-8
ENV LC_ALL=zh_CN.UTF-8
ENV TZ=Asia/Shanghai


# -----------------------------------------------------------------------------
# 阶段 3：应用镜像
# -----------------------------------------------------------------------------
FROM runtime-base AS final

ARG KK_VERSION=5.0.2

# 版本一致性自检：ENTRYPOINT / ENV 里的路径写死了版本号，对不上就直接失败
RUN set -eux; \
    if [ "${KK_VERSION}" != "5.0.2" ]; then \
        echo "✗ KK_VERSION=${KK_VERSION} 与 Dockerfile 中硬编码的 5.0.2 不一致。" >&2; \
        echo "  请同步修改 ENTRYPOINT 里的路径后重试。" >&2; \
        exit 1; \
    fi

# tar 内含顶层目录 kkFileView-<version>/，解到 /opt 即得官方标准布局
COPY --from=builder /build/server/target/kkFileView-*.tar.gz /tmp/kkfileview.tar.gz
RUN tar -xzf /tmp/kkfileview.tar.gz -C /opt \
    && rm -f /tmp/kkfileview.tar.gz \
    && mkdir -p "/opt/kkFileView-${KK_VERSION}/file" \
                "/opt/kkFileView-${KK_VERSION}/log" \
                "/opt/kkFileView-${KK_VERSION}/cache" \
    && ls -la "/opt/kkFileView-${KK_VERSION}"

# 健康检查脚本（不依赖 curl，只用 bash 的 /dev/tcp）
COPY docker/healthcheck.sh /usr/local/bin/kkfileview-healthcheck.sh
RUN chmod +x /usr/local/bin/kkfileview-healthcheck.sh

# 关闭 core dump。soffice 无头转换在 /dev/shm 不足时会被 SIGABRT 杀掉（exit 134），
# 而默认 core_pattern=core、ulimit -c=unlimited 会让它往工作目录写下几百 MB 的 core.<pid>，
# 直接撑爆 data 卷。/etc/security/limits.conf 对 docker exec 的 root 不一定生效，
# 所以 ENTRYPOINT 里还会兜一层 ulimit（见文件末尾）。
RUN printf '* soft core 0\n* hard core 0\nroot soft core 0\nroot hard core 0\n' \
        >> /etc/security/limits.conf \
    && echo "core 已禁用"

# getHomePath() 读取该变量，它决定转换产物(file/)、日志、RocksDB 缓存的落盘位置
ENV KKFILEVIEW_BIN_FOLDER=/opt/kkFileView-5.0.2/bin

# JVM 参数：容器内 MaxRAMPercentage 按 cgroup 内存上限计算。
# 注意 soffice 是独立进程、另占内存，堆不要给满。
ENV JAVA_OPTS="-XX:MaxRAMPercentage=50.0 -XX:+ExitOnOutOfMemoryError -Djava.security.egd=file:/dev/./urandom"

WORKDIR /opt/kkFileView-5.0.2

EXPOSE 8012

HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=5 \
    CMD ["/usr/local/bin/kkfileview-healthcheck.sh"]

# 用 sh -c + exec 包一层，只是为了能通过 JAVA_OPTS 调 JVM 参数；
# exec 保证 java 成为 PID 1，docker stop 的 SIGTERM 能触发优雅终止。
# 注意：exec form 不展开变量，故版本号写死。
#
# ulimit -c 0 是 core dump 的兜底：limits.conf 对已运行的 PID 1 不生效，
# 必须在启动 java 前显式设一次，否则 soffice 崩溃时仍会写 core 文件。
ENTRYPOINT ["sh","-c","ulimit -c 0 2>/dev/null || true; exec java $JAVA_OPTS -Dfile.encoding=UTF-8 -Dspring.config.location=/opt/kkFileView-5.0.2/config/application.properties -jar /opt/kkFileView-5.0.2/bin/kkFileView-5.0.2.jar"]
