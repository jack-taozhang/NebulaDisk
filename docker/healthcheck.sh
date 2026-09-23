#!/bin/bash
# =============================================================================
# kkFileView 容器健康检查
# 探测 Spring Boot Actuator /actuator/health 是否返回 UP。
# 自动适配 KK_SERVER_PORT 与 KK_CONTEXT_PATH（反向代理场景下会变）。
# 不依赖 curl/wget，只用 /dev/tcp（bash 内建）。
# =============================================================================
set -u

PORT="${KK_SERVER_PORT:-8012}"
CTX="${KK_CONTEXT_PATH:-/}"

# 归一化 context-path：去掉首尾多余斜杠
CTX="${CTX%/}"
case "$CTX" in
    "/"|"") CTX="" ;;
    /*)     ;;
    *)      CTX="/$CTX" ;;
esac

PATH_URL="${CTX}/actuator/health"

if ! exec 3<>"/dev/tcp/127.0.0.1/${PORT}" 2>/dev/null; then
    echo "healthcheck: 端口 ${PORT} 未监听"
    exit 1
fi

printf 'GET %s HTTP/1.0\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n' "$PATH_URL" >&3
RESP="$(cat <&3 2>/dev/null)"
exec 3<&- 3>&- 2>/dev/null

if printf '%s' "$RESP" | grep -q '"status":"UP"'; then
    echo "healthcheck: UP (${PATH_URL})"
    exit 0
fi

echo "healthcheck: 异常 (${PATH_URL})"
printf '%s' "$RESP" | head -1
exit 1
