"""从 jar 里把 o3dv（Online 3D Viewer）的 bundle 挖出来，反查扩展名判定逻辑。

要回答的问题（用户报的现象）：
    压缩包里的 `1.2.14.TFDF-6# F向.STEP`（大写 .STEP）打不开，
    报 "No importable file found."；而 `.stp` 的能打开。
    同一个 .STEP 文件**不在压缩包里**时又能打开。

o3dv 官方 FAQ 明确说它「by extension」判断能否导入，所以重点看：
    1. 它拿扩展名时有没有 toLowerCase()
    2. 它认哪些扩展名（step / stp 在不在里面）
    3. 它从哪里取文件名（fragment 的 fullfilename？还是 model url？）
"""
import zipfile
import re
import sys

JAR = "/opt/kkFileView-5.0.2/bin/kkFileView-5.0.2.jar"

z = zipfile.ZipFile(JAR)

# 1) 列出 website 下的 js 资源
names = [n for n in z.namelist() if "/website/" in n and n.endswith(".js")]
print("=== website 下的 js 资源 ===")
for n in names:
    info = z.getinfo(n)
    print("  %-64s %d bytes" % (n, info.file_size))

# 2) 找出主 bundle（体积最大的那个）
if not names:
    print("没有找到 website 下的 js，改为搜索所有 3d/3D 相关资源")
    for n in z.namelist():
        if re.search(r"(3d|three|o3dv)", n, re.I) and n.endswith(".js"):
            print("  ", n, z.getinfo(n).file_size)
    sys.exit(0)

main = max(names, key=lambda n: z.getinfo(n).file_size)
print("\n=== 主 bundle：%s ===" % main)
src = z.read(main).decode("utf-8", "replace")
print("长度：%d 字符" % len(src))

# 3) 找扩展名相关代码
print("\n=== 含 'importable' / 'extension' 的片段 ===")
for m in re.finditer(r".{160}importable.{200}", src):
    print("  ...", m.group(0).replace("\n", " "), "...\n")

print("\n=== 找 toLowerCase 附近的扩展名比对 ===")
for m in re.finditer(r".{120}toLowerCase\(\).{160}", src):
    seg = m.group(0).replace("\n", " ")
    if re.search(r"(ext|suffix|type)", seg, re.I):
        print("  ...", seg, "...\n")

# 4) 找扩展名白名单数组
print("\n=== 疑似扩展名白名单数组 ===")
for m in re.finditer(r'\[\s*"(3dm|step|stp|stl|obj)"[^\]]{0,400}\]', src):
    print("  ", m.group(0)[:500].replace("\n", " "), "\n")

# 5) 找 fullfilename 的读取点
print("\n=== fullfilename 读取点 ===")
for m in re.finditer(r".{140}fullfilename.{200}", src):
    print("  ...", m.group(0).replace("\n", " "), "...\n")
