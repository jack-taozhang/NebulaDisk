#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""supervisord 事件监听：把进程异常退出打成一行显式日志。

为什么需要它：
  supervisord 的默认日志只写 "exited: kkfileview (exit status 1; not expected)"，
  而真正的报错在子进程自己的 stdout 里，两行可能隔很远。NAS 上排查时，
  往往只看 docker logs 的最后几十行，很容易漏掉。这里补一条带标记的行便于 grep。

★ 两个必须遵守的约束（都踩过）★
  1. **只能写 stdout，绝对不能写 stderr。**
     supervisord 用 stderr 与监听器通信；写进去会破坏事件协议。
     同理 supervisord.conf 里这个 section **不能**设 redirect_stderr=true，
     否则 supervisord 直接拒绝启动。
  2. **必须及时回 OK**（childutils.listener.ok），否则 supervisord 认为监听器
     卡死并重启它。异常路径也要保证回 OK，所以下面用 try/finally。

用法（由 supervisord 拉起，无需手动执行）：
    supervisor-exitmon.py
"""
import sys


def main() -> None:
    try:
        from supervisor import childutils  # type: ignore
    except ImportError:
        # 没有 supervisor 包时静默退出即可，不要刷屏。
        # supervisord.conf 里已把 autorestart 设为 false，不会再拉起。
        print("[nebula] exitmon: 未安装 supervisor 包，事件监听已跳过", flush=True)
        return

    try:
        rpc = childutils.getRPCInterface(None)
    except Exception:  # noqa: BLE001
        rpc = None

    while True:
        try:
            headers, payload = childutils.listener.wait(sys.stdin, sys.stdout)
        except (EOFError, KeyboardInterrupt):
            return

        try:
            event = headers.get("eventname", "")
            pname = headers.get("processname", "?")
            from_state = headers.get("from_state", "?")

            mark = "!!!" if event == "PROCESS_STATE_FATAL" else "***"

            if event == "PROCESS_STATE_FATAL":
                msg = (f"[nebula] {mark} 进程 {pname} 反复启动失败，已放弃。"
                       f"请检查该进程的配置与依赖后重启容器。")
            else:
                detail = " ".join(payload.split())
                msg = f"[nebula] {mark} 进程 {pname} 退出（{from_state}）：{detail}"

            # ★ 用 stdout，不用 stderr（见文件头说明）
            print(msg, flush=True)

            if pname == "nebula" and rpc is not None:
                try:
                    info = rpc.supervisor.getProcessInfo("nebula")
                    print(f"[nebula] nebula 状态：{info}", flush=True)
                except Exception:  # noqa: BLE001
                    pass
        except Exception as e:  # noqa: BLE001
            # 处理事件出错也不能让监听器挂掉，否则会丢后续事件
            print(f"[nebula] exitmon 处理事件异常：{e}", flush=True)
        finally:
            # ★ 无论成败都要回 OK，否则 supervisord 会重启监听器
            childutils.listener.ok(sys.stdout)


if __name__ == "__main__":
    main()
