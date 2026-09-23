"""把 overrides/ 下的模板覆盖进 kkFileView jar —— 无需 Maven 重新编译。

为什么需要它：
  kkFileView 的页面模板（compress.ftl 等）被编译进 BOOT-INF/classes/web/*.ftl，
  随 jar 发布。改动这些模板时，常规做法是重建基础镜像 kkfileview:5.0.2，
  但那条路要走完整 Maven package（400MB+ 的 jar，几分钟且依赖网络）。
  这些模板是**纯资源文件**，改它们不需要碰 Java 代码，所以直接替换 jar 内
  的条目即可，几秒钟完成。

用法（在镜像构建期或容器内执行）：
    python3 overlay_templates.py <jar路径> <overrides目录>

约定：
  - overrides 目录下按 jar 内的相对路径组织，例如
        overrides/web/compress.ftl   ->  BOOT-INF/classes/web/compress.ftl
  - 找不到目标条目会直接报错退出（避免「静默替换失败」——那种情况下
    镜像看起来构建成功，但页面还是旧的，极难排查）
"""
import os
import shutil
import sys
import zipfile

# overrides 下的顶层目录 -> jar 内前缀
PREFIX_MAP = {
    "web": "BOOT-INF/classes/web",
    "static": "BOOT-INF/classes/static",
    "config": "BOOT-INF/classes/config",
}


def collect(overrides_dir):
    """返回 [(jar内路径, 本地文件绝对路径), ...]"""
    items = []
    for top, prefix in PREFIX_MAP.items():
        base = os.path.join(overrides_dir, top)
        if not os.path.isdir(base):
            continue
        for root, _dirs, files in os.walk(base):
            for fn in files:
                src = os.path.join(root, fn)
                rel = os.path.relpath(src, base).replace(os.sep, "/")
                items.append((f"{prefix}/{rel}", src))
    return items


def main():
    if len(sys.argv) != 3:
        sys.exit("用法: overlay_templates.py <jar路径> <overrides目录>")

    jar, overrides = sys.argv[1], sys.argv[2]
    if not os.path.isfile(jar):
        sys.exit(f"找不到 jar: {jar}")
    if not os.path.isdir(overrides):
        sys.exit(f"找不到 overrides 目录: {overrides}")

    items = collect(overrides)
    if not items:
        sys.exit(f"{overrides} 下没有可覆盖的文件（期望 web/ static/ config/ 子目录）")

    zin = zipfile.ZipFile(jar, "r")
    names = set(zin.namelist())

    missing = [dst for dst, _ in items if dst not in names]
    if missing:
        zin.close()
        sys.exit("jar 内不存在这些条目，拒绝静默跳过：\n  " + "\n  ".join(missing))

    print(f"将覆盖 {len(items)} 个模板：")
    for dst, src in items:
        print(f"  {dst}  <-  {src}")

    tmp = jar + ".overlay"
    total = len(zin.infolist())
    done = 0
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as zout:
        for item in zin.infolist():
            data = zin.read(item.filename)
            for dst, src in items:
                if item.filename == dst:
                    with open(src, "rb") as f:
                        data = f.read()
                    break
            zout.writestr(item, data)
            done += 1
            if done % 2000 == 0:
                print(f"  ...已处理 {done}/{total}")
    zin.close()

    shutil.move(tmp, jar)
    print(f"✅ 覆盖完成，jar 已更新：{jar}")


if __name__ == "__main__":
    main()
