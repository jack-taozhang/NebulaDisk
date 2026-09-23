"""校验 JAR 内模板是否已被 overlay 步骤替换为修复版。

只读：解出目标条目到内存，正则断言意图，不做任何写操作。
用法: python3 jar_check.py <jar> [entry ...]
"""
import re
import sys
import zipfile

jar = sys.argv[1]
entries = sys.argv[2:] or [
    "BOOT-INF/classes/web/compress.ftl",
    "BOOT-INF/classes/web/svg.ftl",
]

zf = zipfile.ZipFile(jar)
names = set(zf.namelist())

for ep in entries:
    if ep not in names:
        print(f"❌ 条目不存在: {ep}")
        continue
    src = zf.read(ep).decode("utf-8", "replace")
    print(f"\n=== {ep}  ({len(src)} chars) ===")
    if ep.endswith("compress.ftl"):
        checks = [
            ("grid-template-rows", bool(re.search(r"grid-template-rows", src))),
            ("min-height: 520px 已清除", "min-height: 520px" not in src),
            ("min-height: 240px 已清除", "min-height: 240px" not in src),
            ("min-height: 320px 已清除", "min-height: 320px" not in src),
            ("html,body height:100%", bool(re.search(r"html\s*,\s*body\s*\{[^}]*height:\s*100%", src))),
            (".preview-frame height:100%", bool(re.search(r"\.preview-frame\s*\{[^}]*height:\s*100%", src))),
        ]
    else:
        checks = [
            ("源码内出现 viewBox 字样", "viewBox" in src),
        ]
    for label, ok in checks:
        print(f"  {'✅' if ok else '❌'} {label}")
