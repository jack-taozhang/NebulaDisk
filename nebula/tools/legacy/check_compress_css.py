"""验证压缩包预览页（compress.ftl）已使用修正后的高度 CSS。

背景：压缩包预览「下半部分空白」的根因是整页高度写成 min-height:100vh，
而 iframe 与内部子元素用 height:100%，min-height 不提供可解析的高度基准，
导致整页高于视口、又被 overflow:hidden 裁掉。
"""
import re

import httpx

BASE = "http://127.0.0.1:8089"
MOUNT = "共享"
TARGET = "/00-Q3-1250.zip"

with httpx.Client(base_url=BASE, timeout=60, follow_redirects=True) as c:
    c.post("/api/login", data={"username": "admin", "password": "dev-pass-not-real"})
    j = c.get("/api/preview", params={"mount": MOUNT, "path": TARGET}).json()
    url = j["url"]
    if url.startswith("/"):
        url = BASE + url

r = httpx.get(url, timeout=90, follow_redirects=True)
html = r.text
print(f"状态: {r.status_code}  长度: {len(html)}")
print("--- 关键 CSS 断言 ---")
checks = [
    # 高度链必须是「确定值」，从 html/body 一路传递到 iframe
    ("html,body height:100%", re.search(r"html,\s*body\s*\{[^}]*height:\s*100%", html) is not None),
    (".compress-shell height:100%", re.search(r"\.compress-shell\s*\{[^}]*height:\s*100%", html) is not None),
    (".compress-page height:100%", re.search(r"\.compress-page\s*\{[^}]*height:\s*100%", html) is not None),
    (".workspace height:100%", re.search(r"\.workspace\s*\{[^}]*height:\s*100%", html) is not None),
    (".preview-frame min-height:0", re.search(r"\.preview-frame\s*\{[^}]*min-height:\s*0", html) is not None),
    ("min-height: 100vh（旧，应消失）", "min-height: 100vh" not in html),
    ("min-height: 520px（旧，应消失）", "min-height: 520px" not in html),
    ("min-height: 460px（旧，应消失）", "min-height: 460px" not in html),
    ("min-height: 240px（旧，应消失）", "min-height: 240px" not in html),
    ("min-height: 320px（旧，应消失）", "min-height: 320px" not in html),
    ("grid-template-rows（新行高约束）", "grid-template-rows" in html),
]
bad = 0
for label, v in checks:
    print(f"  [{'OK ' if v else 'BAD'}] {label}")
    if not v:
        bad += 1

print("--- 渲染用的变量 ---")
for m in re.findall(r"var\s+\w+\s*=\s*['\"][^'\"]{0,120}['\"]", html)[:8]:
    print("   ", m[:150])

print()
print("✅ 全部符合预期" if bad == 0 else f"❌ 有 {bad} 项不符")
