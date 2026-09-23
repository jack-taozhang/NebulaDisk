# -*- coding: utf-8 -*-
"""从 web/js/icons.js 生成「图标 → 文件类型」对照表。

为什么不手写这份表：
  icons.js 里的 EXT_KIND 是**唯一事实来源**（前端选图标就读它）。
  手写文档必然与代码漂移；这里直接解析代码，文档跟着代码走。
若哪天 EXT_KIND 改了，重跑本脚本即可刷新 nebula/docs/图标对照表.md。
"""
import json
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, ".."))
SRC = os.path.join(ROOT, "web", "js", "icons.js")
OUT = os.path.join(ROOT, "docs", "图标对照表.md")

js = open(SRC, encoding="utf-8").read()

# --- 1) 抓 EXT_KIND 映射 ----------------------------------------------------
m = re.search(r"const EXT_KIND = \{(.*?)\n\};", js, re.S)
block = m.group(1)
pairs = re.findall(r"([\w'\"-]+):\s*'([\w-]+)'", block)
ext2kind = {}
for ext, kind in pairs:
    ext2kind[ext.strip("'\"").lower()] = kind

# --- 2) 抓 FILE_ICONS 里实际存在的图标名与配色 ------------------------------
#     _paper('#2b579a', ...) / _folder('#e8a33d') 形式
icon_colors = {}
for name, call, color in re.findall(
        r"(\w+):\s*(_paper|_folder)\(\s*'([#0-9a-fA-F]+)'", block_iter := js):
    icon_colors[name] = color

# FILE_ICONS 块内更准确地再扫一遍
fm = re.search(r"const FILE_ICONS = \{(.*?)\n\};", js, re.S)
fblock = fm.group(1)
icon_colors = {}
for name, call, color in re.findall(
        r"(\w+):\s*(_paper|_folder)\(\s*'([#0-9a-fA-F]+)'", fblock):
    icon_colors[name] = color

# 反查：kind -> [扩展名]
kind2ext = {}
for ext, kind in ext2kind.items():
    kind2ext.setdefault(kind, []).append(ext)
for k in kind2ext:
    kind2ext[k].sort()

# --- 3) 类型的中文名 -------------------------------------------------------
KIND_CN = {
    "doc": "Word 文档", "xls": "Excel 表格", "ppt": "PowerPoint 演示",
    "pdf": "PDF 文档", "txt": "纯文本", "md": "Markdown",
    "code": "源代码", "image": "图片", "video": "视频", "audio": "音频",
    "zip": "压缩包", "cad": "CAD 图纸", "eml": "邮件", "folder": "文件夹",
    "unknown": "未知类型",
}

lines = []
lines.append("# NebulaDisk 图标对照表\n")
lines.append("> 本表由 `nebula/tools/gen_icon_table.py` 从 `web/js/icons.js` 自动生成，"
             "**请勿手工编辑**。\n"
             "> 改图标或扩展名后重跑脚本即可刷新。\n")
lines.append(f"来源：`nebula/web/js/icons.js`　｜　"
             f"共 {len(icon_colors)} 个文件类型图标、"
             f"{len(ext2kind)} 条扩展名映射\n")

lines.append("\n## 一、文件类型图标总览\n")
lines.append("| 图标名 | 中文含义 | 主色 | 覆盖扩展名 |")
lines.append("| --- | --- | --- | --- |")
kind2color = {k: icon_colors.get(k, "—") for k in kind2ext}
for kind in sorted(kind2ext, key=lambda k: -len(kind2ext[k])):
    exts = kind2ext[kind]
    shown = ", ".join(exts[:8]) + ("…" if len(exts) > 8 else "")
    lines.append(f"| `{kind}` | {KIND_CN.get(kind, kind)} | "
                 f"`{kind2color.get(kind, '—')}` | {shown} |")
lines.append(f"| `unknown` | 未知类型 | `{icon_colors.get('unknown', '—')}` | "
             "（未命中的一切扩展名） |")

lines.append("\n## 二、完整扩展名 → 图标 映射\n")
lines.append("| 扩展名 | 图标 | 中文含义 |")
lines.append("| --- | --- | --- |")
for ext in sorted(ext2kind):
    k = ext2kind[ext]
    lines.append(f"| `.{ext}` | `{k}` | {KIND_CN.get(k, k)} |")

lines.append("\n## 三、本机实测抽样\n")
lines.append("对本机「共享」目录实际文件逐个调 `Icons.file(name)` 的结果：\n")
lines.append("| 文件名 | 命中图标 |")
lines.append("| --- | --- |")
samples = [
    "子文件夹A", "00-Q3-1250.zip", "1.2.14.TFDF-6# F向.STEP",
    "1.2.14.TFDF-6# F向.zip", "测试图片.png", "测试文档.pdf",
    "工时表.csv", "脚本.py", "立库规划图块.dwg", "配置.json",
    "清单.csv", "示例.txt", "说明.txt", "肖连梅-简历.pdf", "Office测试.docx",
]
for s in samples:
    if "." not in s:
        lines.append(f"| {s}（目录） | `folder` |")
        continue
    ext = s.rsplit(".", 1)[-1].lower()
    kind = ext2kind.get(ext, "unknown")
    lines.append(f"| {s} | `{kind}` |")

# STEP 是 3D 模型，不在 EXT_KIND 里 → unknown，这是**待补项**，明确标出
lines.append("\n> ⚠️ 注意：`.step` / `.stp` / `.iges` / `.igs` / `.stl` / `.obj` / "
             "`.3mf` 等 3D 模型格式**当前未登记**，会落到 `unknown` 图标。\n"
             "> 这些格式 kkFileView 是能预览的（走 o3dv），建议补一个 `model` 图标。\n")

os.makedirs(os.path.dirname(OUT), exist_ok=True)
open(OUT, "w", encoding="utf-8").write("\n".join(lines) + "\n")
print("已生成", OUT)
print(f"  类型图标 {len(icon_colors)} 个 / 扩展名 {len(ext2kind)} 条")
