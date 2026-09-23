"""压缩包成员预览回归测试。

覆盖本次修复：
  1) 压缩包内文件能正常预览（不再 Connection refused / CORS）
  2) 压缩包名含 `#`、空格时不抛 URISyntaxException

用法：
    NEBULA_BASE=http://127.0.0.1:8089 python _test_compress.py
"""
from __future__ import annotations

import base64
import os
import re
import sys

import requests

BASE = os.environ.get("NEBULA_BASE", "http://127.0.0.1:8089")
USER = os.environ.get("NEBULA_TEST_USER", "admin")
PWD = os.environ.get("NEBULA_TEST_PASSWORD", "dev-pass-not-real")
MOUNT = "共享"

ok = fail = 0


def check(name: str, cond: bool, detail: str = "") -> None:
    global ok, fail
    if cond:
        ok += 1
        print(f"  [PASS] {name}")
    else:
        fail += 1
        print(f"  [FAIL] {name} :: {detail}")


def main() -> int:
    s = requests.Session()
    r = s.post(f"{BASE}/api/login", data={"username": USER, "password": PWD}, timeout=10)
    r.raise_for_status()
    print(f"登录 OK: {r.json().get('display')}")

    print("\n== 1. 压缩包成员预览：无特殊字符的名字 ==")
    # 先取压缩包自身的预览地址
    r = s.get(f"{BASE}/api/preview", params={"mount": MOUNT, "path": "/00-Q3-1250.zip"}, timeout=15)
    check("拿到压缩包预览地址", r.status_code == 200, str(r.status_code))
    if r.status_code != 200:
        return 1
    preview_url = r.json()["url"]
    check("预览地址走同源反代 /preview/", preview_url.startswith("/preview/"), preview_url[:60])

    # 抓取 compress 页，确认 buildPreviewUrl 已修
    page = s.get(f"{BASE}{preview_url}", timeout=30)
    check("compress 页可加载", page.status_code == 200, str(page.status_code))
    html = page.text

    check(
        "占位符 __SERVER_BASE_URL__ 已被网关替换",
        "__SERVER_BASE_URL__" not in html,
        "占位符仍残留在页面里",
    )
    check(
        "buildPreviewUrl 使用内网 base",
        "var serverBase = 'http://nebula:8088/preview/'" in html
        or "var serverBase = 'http://127.0.0.1:8088/preview/'" in html,
        "未找到预期的 serverBase 注入值",
    )
    check("模板里有 encodeMemberPath 编码函数", "function encodeMemberPath" in html)

    # 用真实 treeNode.id 模拟构造一次成员预览 URL，验证不再有裸 #
    m = re.search(r"var serverBase = '([^']*)'", html)
    server_base = m.group(1) if m else ""
    print(f"     serverBase = {server_base}")

    print("\n== 2. 压缩包名含 `#` 与空格：不应抛 URISyntaxException ==")
    r = s.get(f"{BASE}/api/preview", params={"mount": MOUNT, "path": "/1.2.14.TFDF-6# F向.zip"}, timeout=15)
    check("含 # 的压缩包能取到预览地址", r.status_code == 200, str(r.status_code))
    if r.status_code == 200:
        pu2 = r.json()["url"]
        page2 = s.get(f"{BASE}{pu2}", timeout=30)
        check("含 # 的压缩包 compress 页可加载", page2.status_code == 200, str(page2.status_code))
        # 直接请求成员预览端点，确认服务端不再报错
        # 构造一个成员预览请求（用页面里同样的方式）
        member = "1.2.14.TFDF-6# F向.STEP"
        b64 = base64.b64encode(
            (server_base + member.replace("#", "%23").replace(" ", "%20")
             + "?kkCompressfileKey=" + "1.2.14.TFDF-6%23%20F%E5%90%91.zip_"
             + "&kkCompressfilepath=" + member.replace("#", "%23").replace(" ", "%20")
             + "&fullfilename=" + member.replace("#", "%23").replace(" ", "%20")
             ).encode()
        ).decode()
        rr = s.get(f"{BASE}/preview/onlinePreview", params={"url": b64}, timeout=60)
        check("成员预览端点返回 200", rr.status_code == 200, str(rr.status_code))
        check(
            "成员预览页不含错误提示",
            ("URISyntaxException" not in rr.text) and ("Connection refused" not in rr.text),
            "页面里出现异常关键字",
        )

    print("\n== 3. 普通（非压缩包）预览未受影响 ==")
    r = s.get(f"{BASE}/api/preview", params={"mount": MOUNT, "path": "/readme.md"}, timeout=15)
    check("普通文件预览地址正常", r.status_code == 200, str(r.status_code))

    print(f"\n===== 结果：{ok} 通过 / {fail} 失败 =====")
    return 0 if fail == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
