"""把 kkFileView 返回的 DWG 预览页原文抓下来，看它到底写了什么。"""
import os
import re
import sys

import httpx

BASE = os.environ.get("NEBULA_BASE", "http://127.0.0.1:8089")
USER = os.environ.get("NEBULA_USER", "admin")
PW = os.environ.get("NEBULA_PASS", "dev-pass-not-real")
MOUNT = os.environ.get("NEBULA_TEST_MOUNT") or "共享"
TARGET = os.environ.get("NEBULA_DWG", "/立库规划图块.dwg")
OUT = os.environ.get("NEBULA_DWG_OUT", "D:/Docker/kkFileView/nebula/tools/_dwg_preview.html")


def main() -> int:
    with httpx.Client(base_url=BASE, timeout=90, follow_redirects=True) as c:
        c.post("/api/login", data={"username": USER, "password": PW})
        j = c.get("/api/preview", params={"mount": MOUNT, "path": TARGET}).json()
        url = j["url"]
        if url.startswith("/"):
            url = BASE + url

    body = httpx.get(url, timeout=90, follow_redirects=True).text
    with open(OUT, "w", encoding="utf-8") as f:
        f.write(body)
    print(f"已保存到 {OUT}（{len(body)} 字符）\n")

    # 只打印有信息量的片段：错误提示、脚本变量、状态文案
    print("=" * 60)
    for pat, label in [
        (r"[^<>]*失败[^<>]*", "含「失败」的文本"),
        (r"[^<>]*不支持[^<>]*", "含「不支持」的文本"),
        (r"[^<>]*转换[^<>]*", "含「转换」的文本"),
        (r'var\s+\w+\s*=\s*[\'"][^\'"]{0,200}[\'"]', "JS 变量赋值"),
        (r"currentUrl[^\n]{0,200}", "currentUrl 用法"),
        (r"<script[^>]*src=[\"'][^\"']+[\"']", "外链脚本"),
    ]:
        found = re.findall(pat, body)
        uniq = list(dict.fromkeys(x.strip() for x in found if x.strip()))[:12]
        if uniq:
            print(f"\n--- {label} ---")
            for x in uniq:
                print("  " + x[:200])
    return 0


if __name__ == "__main__":
    sys.exit(main())
