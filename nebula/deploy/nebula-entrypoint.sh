#!/bin/sh
# =============================================================================
# NebulaDisk 容器启动前检查（由 supervisord 的 [program:nebula] 调用）
#
# 为什么要在启动前检查：
#   NAS 上最常见的三个错误配置 —— 映射路径写错、数据目录不可写、OnlyOffice
#   密钥没填 —— 如果只让 Python 抛栈，用户看到的是一串 traceback，
#   很难判断到底是哪一项没配对。这里提前检查并打印**人话**错误。
#
# 注意：这里**不**因为警告就退出。映射缺失只让该目录不可见，不致命；
#      真正的致命问题（数据目录不可写）才 exit 1，让 supervisord 报错。
# =============================================================================
set -u

echo "======================================================================"
echo "[nebula-entrypoint] 启动前检查"
echo "======================================================================"

# ---------- 1. 数据目录可写 ----------
DATA_DIR="${NEBULA_DATA_DIR:-/var/lib/nebula}"
mkdir -p "$DATA_DIR" 2>/dev/null
if [ ! -w "$DATA_DIR" ]; then
    echo "[nebula-entrypoint] ✗ 数据目录不可写：$DATA_DIR" >&2
    echo "[nebula-entrypoint]   该目录用来存 SQLite 用户库与会话密钥，" >&2
    echo "[nebula-entrypoint]   请检查宿主机挂载权限（容器内以 root 运行）。" >&2
    exit 1
fi
echo "[nebula-entrypoint] ✓ 数据目录可写：$DATA_DIR"

# ---------- 2. 目录映射 ----------
if [ -z "${NEBULA_MOUNTS:-}" ]; then
    echo "[nebula-entrypoint] ! 未配置 NEBULA_MOUNTS，云盘里不会有任何目录。" >&2
    echo "[nebula-entrypoint]   格式：显示名|容器内路径|可见用户" >&2
    echo "[nebula-entrypoint]   例：文档|/mnt/docs|alice,bob;公共|/mnt/public|*" >&2
else
    # 逐条解析并检查路径是否存在。用 | 分隔，与 app/config.py 保持一致。
    # shell 里按 ; 拆组、按 | 拆字段。
    old_ifs="$IFS"
    IFS=';'
    for chunk in $NEBULA_MOUNTS; do
        IFS="$old_ifs"
        # 去掉首尾空白
        chunk=$(printf '%s' "$chunk" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')
        [ -z "$chunk" ] && continue

        case "$chunk" in
          *"|"*)
            # 显示名|路径[|用户]
            label=$(printf '%s' "$chunk" | cut -d'|' -f1)
            path=$(printf '%s' "$chunk"  | cut -d'|' -f2)
            users=$(printf '%s' "$chunk" | cut -d'|' -f3)
            ;;
          *)
            # 旧冒号格式，仅提示
            label=""
            path="$chunk"
            users=""
            echo "[nebula-entrypoint] ! 映射用了旧冒号格式，建议改成 | 分隔：$chunk" >&2
            ;;
        esac

        if [ -z "$path" ]; then
            echo "[nebula-entrypoint] ! 映射解析不出路径，已跳过：$chunk" >&2
            IFS=';'
            continue
        fi

        if [ -d "$path" ]; then
            who="${users:-*}"
            echo "[nebula-entrypoint] ✓ 映射 $label -> $path  可见: $who"
        else
            echo "[nebula-entrypoint] ✗ 映射路径不存在：$path（显示名 $label）" >&2
            echo "[nebula-entrypoint]   该目录在云盘里会显示为不可用。" >&2
            echo "[nebula-entrypoint]   常见原因：docker-compose 里的 volumes 少写了这条。" >&2
        fi
        IFS=';'
    done
    IFS="$old_ifs"
fi

# ---------- 3. OnlyOffice ----------
if [ -n "${NEBULA_OO_URL:-}" ]; then
    if [ -z "${NEBULA_OO_SECRET:-}" ]; then
        echo "[nebula-entrypoint] ✗ NEBULA_OO_URL 已配置但 NEBULA_OO_SECRET 为空。" >&2
        echo "[nebula-entrypoint]   OnlyOffice 会拒绝签名，Office 文件打不开。" >&2
        echo "[nebula-entrypoint]   该密钥必须与 OnlyOffice 容器的 JWT_SECRET 完全一致。" >&2
    else
        echo "[nebula-entrypoint] ✓ OnlyOffice 服务端地址：$NEBULA_OO_URL"
        # 探一下可达性。注意：这里探的是**服务端**地址（容器间互通），
        # 不是浏览器地址；探不通不阻塞启动（OnlyOffice 可能稍后才起来）。
        if command -v curl >/dev/null 2>&1; then
            code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 4 \
                   "${NEBULA_OO_URL%/}/healthcheck" 2>/dev/null || echo 000)
            if [ "$code" = "200" ] || [ "$code" = "true" ]; then
                echo "[nebula-entrypoint] ✓ OnlyOffice 服务端可达"
            else
                echo "[nebula-entrypoint] ! OnlyOffice 暂时探不通（$code），稍后会自动重试。"
            fi
        fi
    fi
    if [ -z "${NEBULA_OO_PUBLIC:-}" ]; then
        echo "[nebula-entrypoint] ! 未配置 NEBULA_OO_PUBLIC —— 这是**浏览器**访问" >&2
        echo "[nebula-entrypoint]   OnlyOffice 的地址（如 http://192.168.1.10:8082）。" >&2
        echo "[nebula-entrypoint]   不配的话编辑器加载不出 api.js，页面会白屏。" >&2
    else
        echo "[nebula-entrypoint] ✓ OnlyOffice 浏览器地址：$NEBULA_OO_PUBLIC"
    fi
else
    echo "[nebula-entrypoint] ! 未配置 OnlyOffice，Office 文件将只读预览（走 kkFileView）。"
fi

# ---------- 4. 会话密钥 ----------
SECRET_FILE="$DATA_DIR/secret.key"
if [ -n "${NEBULA_JWT_SECRET:-}" ]; then
    echo "[nebula-entrypoint] ✓ 会话密钥来自环境变量 NEBULA_JWT_SECRET"
elif [ -f "$SECRET_FILE" ]; then
    echo "[nebula-entrypoint] ✓ 复用已持久化的会话密钥：$SECRET_FILE"
else
    echo "[nebula-entrypoint] · 首次启动，将生成会话密钥到 $SECRET_FILE"
    echo "[nebula-entrypoint]   该文件必须落在持久卷上，否则每次重启都会全员掉线。"
fi

echo "[nebula-entrypoint] 检查完毕，交给 uvicorn 启动"
echo "======================================================================"

# uvicorn 直接 exec 成为进程主体，SIGTERM 能正常传递
exec uvicorn app.main:app \
    --host 0.0.0.0 \
    --port "${NEBULA_PORT:-8088}" \
    --proxy-headers \
    --forwarded-allow-ips '*' \
    --no-access-log \
    --log-level "${NEBULA_LOG_LEVEL:-info}"
