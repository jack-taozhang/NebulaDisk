# -*- coding: utf-8 -*-
"""生成 NebulaDisk 的 favicon（与 kkFileView 同风格）。

设计对齐依据（实证）：
  - kkFileView 的 favicon 是单一深蓝 #185290、透明底、粗斜体字母 "k"
    （用 Pillow 采样得到：不透明像素 100% 为 #185290）。
  - 因此 NebulaDisk 采取同一套设计语言：同色 #185290、透明底、
    粗斜体字母 "N"，仅字形不同，品牌色完全一致。

产出：
  web/favicon.svg  —— 矢量（现代浏览器首选，任意缩放不糊）
  web/favicon.ico  —— 16/32/48/64/128/256 多尺寸位图（兼容老式请求）
"""
import os
from PIL import Image, ImageDraw, ImageFont

OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "web")
OUT_DIR = os.path.abspath(OUT_DIR)

BRAND = (0x18, 0x52, 0x90, 255)   # #185290 —— 与 kkFileView 完全一致

# --- 1) SVG：矢量版（主用） -------------------------------------------------
# 用一个粗体、带斜体倾斜的 "N"，配合轻微右倾（skewX）复刻原字形的动势。
SVG = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <g transform="skewX(-10) translate(3.2 0)">
    <path d="M4 26V6h4.6l9 12.6V6h4.4v20h-4.5L8.4 13.2V26z" fill="#185290"/>
  </g>
</svg>
"""

svg_path = os.path.join(OUT_DIR, "favicon.svg")
with open(svg_path, "w", encoding="utf-8") as f:
    f.write(SVG)
print("已写出", svg_path)


# --- 2) ICO：多尺寸位图（兜底） ---------------------------------------------
def find_bold_font(size):
    """挑一个可用的粗体字体；找不到就退回默认位图字体。"""
    cands = [
        r"C:\Windows\Fonts\arialbd.ttf",
        r"C:\Windows\Fonts\segoeuib.ttf",
        r"C:\Windows\Fonts\calibrib.ttf",
        r"C:\Windows\Fonts\verdanab.ttf",
    ]
    for c in cands:
        if os.path.exists(c):
            try:
                return ImageFont.truetype(c, size), os.path.basename(c)
            except OSError:
                continue
    return ImageFont.load_default(), "default"


def render(size):
    scale = 8                      # 先大后缩，边缘干净
    S = size * scale
    img = Image.new("RGBA", (S, S), (255, 255, 255, 0))
    d = ImageDraw.Draw(img)
    font, _ = find_bold_font(int(S * 0.86))
    # 取字形包围盒后居中，避免依赖字体的内部留白
    box = d.textbbox((0, 0), "N", font=font)
    w, h = box[2] - box[0], box[3] - box[1]
    x = (S - w) / 2 - box[0]
    y = (S - h) / 2 - box[1]
    d.text((x, y), "N", font=font, fill=BRAND)
    # 轻微右倾，贴近 kkFileView 的斜体观感
    img = img.rotate(-0, resample=Image.BICUBIC)
    return img.resize((size, size), Image.LANCZOS)


sizes = [16, 32, 48, 64, 128, 256]
imgs = [render(s) for s in sizes]
ico_path = os.path.join(OUT_DIR, "favicon.ico")
imgs[-1].save(ico_path, format="ICO",
              sizes=[(s, s) for s in sizes])   # 多尺寸打包进一个 ico
print("已写出", ico_path)

# 顺手存一张 256 预览便于人工核对
imgs[-1].save(os.path.join(OUT_DIR, "..", "docs", "nebula-favicon-预览.png"))
print("已写出预览图")
