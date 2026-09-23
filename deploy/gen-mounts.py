#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
gen-mounts.py —— 从 .env 的 NB_MOUNTS 派生「共享盘挂载」叠加编排

    python3 deploy/gen-mounts.py [部署目录] [--out <文件>] [--env <env文件>]\n                               [--merge-into <编排>] [--check]

输入：<部署目录>/.env  里的 **NB_MOUNTS**（唯一真相）
输出：<部署目录>/docker-compose.mounts.yml

-----------------------------------------------------------------------------
为什么要有这个生成器
-----------------------------------------------------------------------------
compose 的 `volumes:` 是**静态**的，不能从环境变量里动态长出几条挂载。所以
「加一个盘」原本要在**两个文件、三处**同时改：

    deploy/docker-compose.yml   volumes:        - ${NB_XXX_DIR}:/mnt/xxx
    deploy/docker-compose.yml   environment:    NEBULA_MOUNTS: ...;xxx|/mnt/xxx|*
    .env                                        NB_XXX_DIR=/vol1/1000/xxx

而 compose 里那两处还必须是**逐字一致**的契约（右侧容器路径 = NEBULA_MOUNTS
第二段）。加第 4、5 个盘时这是最典型的出错点，而且错了之后的表现只是
「某个盘不见了」，很难联想到是拼写不一致。

⇒ 改成：**只有 `.env` 的 `NB_MOUNTS` 一处是真相**，本脚本机械派生
  ①`volumes:` 的绑定 与 ②容器内的 `NEBULA_MOUNTS`。
  盘的数量不设上限，加盘 = 加一行。

格式（`|` 分隔字段，`;` 分隔多条）：

    显示名|宿主机路径|容器内路径|可见用户

    · 显示名     界面上看到的盘符名，可用中文
    · 宿主机路径 可写绝对路径，也可写相对**部署目录**的相对路径（如 ./mnt/share）
    · 容器内路径 必须以 /mnt/ 开头（避免误盖 /var/lib/nebula 等）
    · 可见用户   `*` 所有人；或 alice,bob；省略等同 `*`

为什么用 PyYAML：**不用**。这个脚本要在目标机（NAS）上跑，NAS 不一定装了
PyYAML。输入是我们自己维护的、结构极简单，手工拼 YAML + 全程断言已经足够，
而且形状一变就报错、不会静默产出坏文件（与 gen-run-compose.py 同一套思路）。
-----------------------------------------------------------------------------
"""
import os
import re
import sys

DEFAULT_MOUNTS = "共享|./mnt/share|/mnt/share|*;照片|./mnt/photos|/mnt/photos|*;私密|./mnt/private|/mnt/private|admin"

HEADER = """\
# =============================================================================
# 共享盘挂载（叠加编排）★ 本文件是**生成**的，不要手改 ★
#
#   由 deploy/gen-mounts.py 从**部署目录的 .env** 里的 NB_MOUNTS 生成：
#     · volumes:         —— 宿主机目录 → 容器内路径 的绑定
#     · NEBULA_MOUNTS    —— 容器内的「显示名|容器内路径|可见用户」声明
#   两处由同一条数据派生，所以**不可能对不上**（手写就很容易对不上）。
#
#   要增删盘 → 改 .env 的 NB_MOUNTS，然后重新生成并起栈：
#       bash deploy/up.sh <部署目录>
#   （up.sh 会自动调用本生成器；也可单独跑：
#       python3 deploy/gen-mounts.py <部署目录>  ）
#
#   本文件被 docker compose 以 `-f` **追加**在 docker-compose.yml 之后，
#   所以它只补充挂载与环境变量，不动其它任何设置。
# =============================================================================
"""


def fail(msg):
    print("✗ " + msg, file=sys.stderr)
    sys.exit(1)


def env_get(env_path, key):
    """从 .env 里取一个变量（不展开 ${} —— .env 里这些值不该有引用）。"""
    try:
        with open(env_path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                if k.strip() == key:
                    v = v.strip()
                    # 允许 "值" 或 '值'
                    if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
                        v = v[1:-1]
                    return v
    except FileNotFoundError:
        return None
    return None


def parse_mounts(raw):
    """解析 NB_MOUNTS → [(显示名, 宿主机路径, 容器内路径, 可见用户)]"""
    out = []
    for i, chunk in enumerate(raw.split(";"), 1):
        chunk = chunk.strip()
        if not chunk:
            continue
        parts = [p.strip() for p in chunk.split("|")]
        if len(parts) < 3:
            fail(f"NB_MOUNTS 第 {i} 条字段不足（需要 显示名|宿主机路径|容器内路径|可见用户）：{chunk}")
        if len(parts) > 4:
            fail(f"NB_MOUNTS 第 {i} 条字段过多（最多 4 段；路径里请勿使用 |）：{chunk}")
        label, host, container = parts[0], parts[1], parts[2]
        users = parts[3] if len(parts) == 4 and parts[3] else "*"

        if not label:
            fail(f"NB_MOUNTS 第 {i} 条缺显示名：{chunk}")
        if not host:
            fail(f"NB_MOUNTS 第 {i} 条缺宿主机路径：{chunk}")
        if not container:
            fail(f"NB_MOUNTS 第 {i} 条缺容器内路径：{chunk}")

        # 容器内路径必须是干净的绝对路径，且落在 /mnt/ 下
        if not container.startswith("/"):
            fail(f"NB_MOUNTS 第 {i} 条的容器内路径必须是绝对路径：{container}")
        if not container.startswith("/mnt/"):
            fail(f"NB_MOUNTS 第 {i} 条的容器内路径必须以 /mnt/ 开头（避免误盖数据目录）：{container}")
        if ".." in container.split("/") or container.endswith("/"):
            fail(f"NB_MOUNTS 第 {i} 条的容器内路径不合法（不要以 / 结尾、不要含 ..）：{container}")

        for bad, what in (("|", "|"), (";", ";"), (",", "英文逗号")):
            if bad in label and what != ",":
                fail(f"显示名里不能出现 {what}：{label}")
        out.append((label, host, container, users))

    if not out:
        fail("NB_MOUNTS 解析后为空 —— 至少配一个盘")

    # 重复检查：显示名重复会让用户看到两个同名盘；容器路径重复会互相覆盖
    for idx, what in ((0, "显示名"), (2, "容器内路径")):
        seen = {}
        for m in out:
            v = m[idx]
            if v in seen:
                fail(f"{what}重复：{v}（第 {seen[v]+1} 条与第 {len(seen)+1} 条之外的第 {out.index(m)+1} 条）")
            seen[v] = out.index(m)
    return out


def yq(s):
    """YAML 双引号标量：转义 \\ 和 " """
    return '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"'


def merge_into(base_text, mounts, base_name):
    """把绑定的两段插进 base_text 的 `nebula:` 服务里，返回合并后的完整文本。

    为什么需要它：群晖 Container Manager / 威联通 Container Station 这类**图形化
    容器管理器只吃一个 compose 文件**，用不了 `-f a.yml -f b.yml`。所以离线包里
    那份要能**单文件自洽**。

    为什么不用 `docker compose config` 来合并：那会**把相对路径解析成绝对路径**
    并写进产物，于是导出的包里会带上导出机自己的目录（`/d/...`、`/mnt/...`），
    拷到别的机器就废了。所以这里做纯文本插入，保留相对路径原样。
    """
    lines = base_text.split("\n")

    # 1) 定位 nebula 服务的块 [start, end)
    start = None
    for i, ln in enumerate(lines):
        if ln.rstrip() == "  nebula:":
            start = i
            break
    if start is None:
        fail(f"{base_name} 里找不到 `  nebula:` 服务块 —— 无法合并")
    end = len(lines)
    for j in range(start + 1, len(lines)):
        ln = lines[j]
        if ln.strip() and not ln.startswith("  "):
            end = j
            break
        if ln.strip() and ln.startswith("  ") and not ln.startswith("    ") \
           and re.match(r"^  [A-Za-z0-9_.-]+:", ln):
            end = j
            break

    vol_lines = [f"      - {yq(h + ':' + c)}" for _l, h, c, _u in mounts]
    joined = ";".join(f"{l}|{c}|{u}" for l, _h, c, u in mounts)
    env_line = f"      NEBULA_MOUNTS: {yq(joined)}"

    def find_block(name, indent):
        """在 [start,end) 里找 `    volumes:` 这类块，返回它的插入点下标。"""
        head = " " * indent + name + ":"
        for k in range(start + 1, end):
            if lines[k].rstrip() == head:
                ins = k + 1
                while ins < end:
                    ln = lines[ins]
                    if ln.strip() and not ln.startswith(" " * (indent + 1)):
                        break
                    ins += 1
                return ins
        return None

    ins_env = find_block("environment", 4)
    if ins_env is None:
        # 没有 environment: 就新建一块，放在 nebula 块末尾
        block = ["    environment:"] + [env_line]
    else:
        block = [env_line]

    ins_vol = find_block("volumes", 4)
    volblock = vol_lines
    if ins_vol is None:
        meta = ["    volumes:"] + vol_lines
    else:
        meta = None

    # 从后往前插，避免下标位移
    if ins_env is not None and ins_vol is not None:
        if ins_env > ins_vol:
            lines[ins_env:ins_env] = block
            lines[ins_vol:ins_vol] = volblock
        else:
            lines[ins_vol:ins_vol] = volblock
            lines[ins_env:ins_env] = block
    elif ins_env is not None:
        lines[ins_env:ins_env] = block
        lines[end:end] = meta
    elif ins_vol is not None:
        lines[ins_vol:ins_vol] = volblock
        lines[end:end] = ["    environment:"] + block
    else:
        lines[end:end] = ["    volumes:"] + vol_lines + ["    environment:"] + block

    out = "\n".join(lines)
    # ★ 断言只数**配置行**，不能数裸 substring ★
    #   本项目注释非常详尽，注释里本来就会提到 NEBULA_MOUNTS（"共享盘不在这里…"），
    #   用 `out.count("NEBULA_MOUNTS:")` 会数出 2 次 → 假红。
    #   教训同 gen-run-compose.py 的 pull_policy 那次：用 `^\\s*KEY:` 这种形状匹配。
    for _l, _h, c, _u in mounts:
        if f":{c}" not in out:
            fail(f"合并后找不到容器路径 {c}")
    n_env = len(re.findall(r"^\s+NEBULA_MOUNTS:", out, re.M))
    if n_env != 1:
        fail(f"合并后 NEBULA_MOUNTS 配置行有 {n_env} 处（期望 1）")
    n_vol = len(re.findall(r"^\s+- \"?" + re.escape(mounts[0][1] + ":" + mounts[0][2]), out, re.M))
    if n_vol != 1:
        fail(f"合并后第一条第绑定出现 {n_vol} 处（期望 1）")
    return out


def main(argv):
    args = [a for a in argv[1:] if not a.startswith("--")]
    check_only = "--check" in argv
    out_arg = None
    if "--out" in argv:
        out_arg = argv[argv.index("--out") + 1]
    merge_into_arg = None
    if "--merge-into" in argv:
        merge_into_arg = argv[argv.index("--merge-into") + 1]

    deploy = args[0] if args else "."
    deploy = os.path.abspath(deploy)
    # --env 允许指定别处的 .env（离线包导出时会拿 .env.example 当输入，
    # 免得为了生成一份默认产物而先创建 .env）
    env_path = argv[argv.index("--env") + 1] if "--env" in argv else os.path.join(deploy, ".env")
    if not os.path.exists(env_path):
        fail(f"找不到 {env_path}（先 cp deploy/.env.example <部署目录>/.env）")

    raw = env_get(env_path, "NB_MOUNTS")
    used_default = False
    if raw is None or raw.strip() == "":
        raw = DEFAULT_MOUNTS
        used_default = True

    mounts = parse_mounts(raw)

    # ---- 模式 A：把挂载合并进一个已有的 compose，产出单文件 ----
    if merge_into_arg:
        base_path = merge_into_arg
        if not os.path.exists(base_path):
            fail(f"找不到要合并的编排：{base_path}")
        with open(base_path, encoding="utf-8") as f:
            base_text = f.read().replace("\r\n", "\n")
        merged = merge_into(base_text, mounts, os.path.basename(base_path))
        out_path = out_arg or base_path
        with open(out_path, "w", encoding="utf-8", newline="\n") as f:
            f.write(merged if merged.endswith("\n") else merged + "\n")
        try:
            shown = os.path.relpath(out_path)
        except ValueError:      # Windows 跨盘符（D: → E:）会抛，见下面同样处理的说明
            shown = out_path
        print(f"✓ 已把 {len(mounts)} 个盘合并进 {shown}（单文件自洽）")
        return 0

    out_path = out_arg or os.path.join(deploy, "docker-compose.mounts.yml")

    # ---- 组装产物 ----
    lines = [HEADER.rstrip("\n"), "", "services:", "  nebula:", "    volumes:"]
    for _label, host, container, _users in mounts:
        lines.append(f"      - {yq(host + ':' + container)}")
    lines.append("    environment:")
    joined = ";".join(f"{l}|{c}|{u}" for l, _h, c, u in mounts)
    lines.append(f"      NEBULA_MOUNTS: {yq(joined)}")
    text = "\n".join(lines) + "\n"

    # ---- 输出侧断言 ----
    n_host = len(re.findall(r"^      - ", text, re.M))
    if n_host != len(mounts):
        fail(f"产物里绑定数 {n_host} != 声明数 {len(mounts)} —— 生成逻辑有问题")
    if text.count("NEBULA_MOUNTS:") != 1:
        fail("产物里 NEBULA_MOUNTS 出现次数不为 1")
    for _l, h, c, _u in mounts:
        if f":{c}" not in text:
            fail(f"产物里找不到容器路径 {c}")

    if check_only:
        print(f"✓ NB_MOUNTS 校验通过（{len(mounts)} 个盘）")
        return 0

    with open(out_path, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)

    # ★ 显示路径要安全 ★ Windows 下 os.path.relpath 跨盘符（D: → E:）会抛
    #   ValueError: path is on mount 'E:', start on mount 'D:'。
    #   生成动作已经完成了，却因为一句 print 崩掉 —— 不要在这种地方留坑。
    try:
        shown = os.path.relpath(out_path)
    except ValueError:
        shown = out_path
    print(f"✓ 已生成 {shown}")
    if used_default:
        print("  （.env 里没设 NB_MOUNTS，用了内置默认的三个盘）")
    print(f"  共 {len(mounts)} 个盘：")
    for label, host, container, users in mounts:
        exist = "" if host.startswith("/") and not os.path.isdir(host) else ""
        if host.startswith("/") and not os.path.isdir(host):
            exist = "   ← 宿主机目录还不存在（up.sh 会创建）"
        print(f"    {label:<10} {host}  →  {container}   可见: {users}{exist}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
