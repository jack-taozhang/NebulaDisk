#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""校验 supervisord 配置能否被解析（含 eventlistener 的禁止项检查）。

为什么单独写个脚本：
  supervisord 的配置错误只有在**启动时**才暴露，而且报错是一行 Error，
  容器还会不停重启刷屏。在本地先跑一遍能省很多事。
  注意：supervisor 包只能在 Linux 下 import（依赖 pwd 模块），
  所以这个脚本要在容器里跑，或在 WSL 里跑。
"""
import sys

CONF = sys.argv[1] if len(sys.argv) > 1 else "/etc/supervisor/conf.d/nebula.conf"

try:
    from supervisor.options import ServerOptions
except Exception as e:  # noqa: BLE001
    print(f"[skip] 无法 import supervisor（Windows 上正常）：{e}")
    sys.exit(0)

o = ServerOptions()
o.realize([])
o.configfile = CONF

try:
    o.process_config()
except Exception as e:  # noqa: BLE001
    print(f"[FAIL] 配置解析失败：{e}")
    sys.exit(1)

print(f"[OK] 配置解析通过：{CONF}")
for g in o.process_group_configs:
    for p in g.process_configs:
        print(f"  program: {p.name:<12} autostart={p.autostart} "
              f"autorestart={p.autorestart} priority={p.priority}")
        print(f"    cmd: {p.command}")
for e in o.eventlistener_configs:
    print(f"  listener: {e.name:<12} events={e.events} "
          f"autorestart={e.autorestart}")
    print(f"    cmd: {e.command}")

# 额外断言：eventlistener 不能设 redirect_stderr
for e in o.eventlistener_configs:
    if getattr(e, "redirect_stderr", False):
        print(f"[FAIL] 监听器 {e.name} 设了 redirect_stderr=true，"
              f"supervisord 会拒绝启动")
        sys.exit(1)

print("[OK] 无阻塞性配置问题")
