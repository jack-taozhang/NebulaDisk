#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
gen-run-compose.py —— 从可 build 的编排生成「纯运行版」

    python3 deploy/gen-run-compose.py

输入：deploy/docker-compose.yml          （唯一真相：带 build:）
输出：deploy/docker-compose.run.yml      （机械生成：无 build: + pull_policy: never）

-----------------------------------------------------------------------------
为什么要有这个生成器，而不是手写第二份 compose
-----------------------------------------------------------------------------
「可 build 版」和「纯运行版」的差异只有两处、且是完全机械的：
    · 去掉 build:            ← NAS 图形化容器管理器不支持 build，
                               且运行时不希望它去联网拉取
    · 每个服务加 pull_policy: never

手抄两份必然漂移 —— 本项目就吃过：dist 里同时存在 run-only / cad / allinone
三份 compose，各自演进了几轮之后，只有 allinone 那份是对的，
排查时先在错的那份上花掉了一轮。**所以这里改成生成。**

为什么用文本变换而不是 PyYAML：
    这个脚本要在**目标机**（NAS）上也能跑，而 NAS 上不一定装了 PyYAML。
    输入文件是自己维护的、结构稳定，所以按缩进做文本变换足够可靠；
    并且每一步都带断言，形状一变就报错，不会静默产出坏文件。
-----------------------------------------------------------------------------
"""
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "docker-compose.yml")
DST = os.path.join(HERE, "docker-compose.run.yml")

HEADER = """\
# =============================================================================
# NebulaDisk —— 部署编排（纯运行版）★ 本文件是**生成**的，不要手改 ★
#
#   由 deploy/gen-run-compose.py 从 docker-compose.yml 生成：
#     · 剥掉所有 build: 段（运行期不需要、图形化容器管理器也不支持）
#     · 每个服务加 pull_policy: never（只用本地已导入的镜像，绝不联网拉取）
#
#   要改行为 → 改 docker-compose.yml，然后重新生成：
#       python3 deploy/gen-run-compose.py
#
#   用法（离线 / 图形化容器管理器）：
#       docker compose -f <源码>/deploy/docker-compose.run.yml \\
#                      --project-directory <部署目录> up -d
# =============================================================================
"""


def fail(msg):
    print("✗ " + msg, file=sys.stderr)
    sys.exit(1)


def main():
    if not os.path.exists(SRC):
        fail("找不到 %s" % SRC)
    raw = open(SRC, encoding="utf-8").read().replace("\r\n", "\n")
    lines = raw.split("\n")

    out = []
    services = []            # [服务名, 该服务 image: 行在 out 里的下标]
    cur = None               # 当前服务名
    in_services = False      # 只在顶层 services: 段内才把「缩进 2 的 key」当服务
    i = 0
    stripped_build = 0

    while i < len(lines):
        ln = lines[i]

        # ---- 顶层 key（列 0）：决定是否还在 services 段内 ----
        #   ★ 必须有这个开关 ★ 顶层 volumes: 下面的 `  oo-data:` 也是「缩进 2 的 key」，
        #   不开开关就会被误当成第 4、5 个服务 → 断言直接失败。
        if re.match(r"^[A-Za-z]", ln):
            in_services = (ln.strip() == "services:")
            cur = None
            out.append(ln)
            i += 1
            continue

        # ---- 服务头（缩进 2 且以 : 结尾）----
        m = re.match(r"^  ([A-Za-z0-9_.-]+):\s*$", ln)
        if in_services and m:
            cur = m.group(1)
            services.append([cur, None])
            out.append(ln)
            i += 1
            continue

        # ---- 该服务的 image: 行（记下位置，稍后插 pull_policy）----
        if cur and re.match(r"^    image:\s", ln):
            out.append(ln)
            services[-1][1] = len(out) - 1
            i += 1
            continue

        # ---- build: 段：连同其下所有更深缩进的行一起丢掉 ----
        if cur and re.match(r"^    build:\s*$", ln):
            base = len(ln) - len(ln.lstrip())
            i += 1
            while i < len(lines):
                nxt = lines[i]
                if nxt.strip() == "":
                    i += 1
                    continue
                ind = len(nxt) - len(nxt.lstrip())
                if ind <= base:
                    break
                i += 1
            stripped_build += 1
            continue

        out.append(ln)
        i += 1

    # ---------------- 断言：形状没变 ----------------
    if len(services) != 3:
        fail("期望 3 个服务，实际 %d 个：%s" % (len(services), [s[0] for s in services]))
    missing_img = [n for n, idx in services if idx is None]
    if missing_img:
        fail("这些服务没有 image: 行：%s（纯运行版必须写死镜像名）" % missing_img)
    if stripped_build != 1:
        fail("期望剥掉 1 个 build: 段（只有 nebula 需要构建），实际 %d 个" % stripped_build)

    # ---------------- 插入 pull_policy: never ----------------
    # 从后往前插，避免下标位移
    for name, idx in sorted(services, key=lambda x: -x[1]):
        out.insert(idx + 1, "    pull_policy: never          # 只用本地已导入的镜像")

    text = HEADER + "\n" + "\n".join(out).lstrip("\n")

    # ---------------- 输出侧再断言一次 ----------------
    for bad, what in ((r"^\s*build:", "build:"), ):
        if re.search(bad, text, re.M):
            fail("产物里仍有 %s —— 生成逻辑有问题" % what)
    n_pull = len(re.findall(r"^    pull_policy: never", text, re.M))
    if n_pull != 3:
        fail("产物里 pull_policy 有 %d 处（期望 3）" % n_pull)

    with open(DST, "w", encoding="utf-8", newline="\n") as f:
        f.write(text if text.endswith("\n") else text + "\n")

    print("✓ 已生成 %s" % os.path.relpath(DST, os.path.dirname(HERE)))
    print("  服务：%s" % ", ".join(n for n, _ in services))
    print("  剥掉 build: %d 段；插入 pull_policy: %d 处" % (stripped_build, n_pull))
    return 0


if __name__ == "__main__":
    sys.exit(main())
