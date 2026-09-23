"""诊断 DWG 预览为什么停在「正在加载SVG...」。

思路：把整条链路拆开逐段验证，而不是盯着前端页面猜。
  1. 登录 → 取 /api/preview 拿到的 kkFileView 预览地址
  2. 打开该地址，看它返回的是「等待转换」页还是「SVG 展示」页
  3. 直接问 kkFileView 的转换状态接口，看状态码说明卡在哪一步
"""
import os
import re
import sys

import httpx

BASE = os.environ.get("NEBULA_BASE", "http://127.0.0.1:8089")
KK = os.environ.get("NEBULA_KK", "http://127.0.0.1:8012")
USER = os.environ.get("NEBULA_USER", "admin")
PW = os.environ.get("NEBULA_PASS", "dev-pass-not-real")
MOUNT = os.environ.get("NEBULA_TEST_MOUNT") or "共享"
TARGET = os.environ.get("NEBULA_DWG", "/立库规划图块.dwg")


def main() -> int:
    with httpx.Client(base_url=BASE, timeout=90, follow_redirects=True) as c:
        r = c.post("/api/login", data={"username": USER, "password": PW})
        print(f"[1] 登录 {r.status_code}")
        if r.status_code != 200:
            print("    登录失败，后续无法进行")
            return 1

        # 路径可能不在根目录，先按名字找一下
        target = TARGET
        r = c.get("/api/list", params={"mount": MOUNT, "path": "/"})
        if r.status_code == 200:
            for e in r.json().get("entries", []):
                if not e.get("isDir") and e.get("ext", "").lower() in ("dwg", "dxf"):
                    target = "/" + e["name"]
                    print(f"[2] 在根目录找到 CAD 文件：{target}（route={e.get('route')}）")
                    break
            else:
                print(f"[2] 根目录没有 dwg/dxf，沿用 {target}")

        r = c.get("/api/preview", params={"mount": MOUNT, "path": target})
        print(f"[3] /api/preview {r.status_code}  {r.text[:200]}")
        if r.status_code != 200:
            return 1
        j = r.json()
        print(f"    返回字段：{list(j.keys())}")
        url = j.get("url") or j.get("previewUrl") or j.get("preview") or ""
        if not url:
            print("    没拿到预览地址！")
            return 1
        print(f"    kk 预览地址：{url[:200]}")
        # /api/preview 返回的是站内相对地址，要补上 base 才能直接请求
        if url.startswith("/"):
            url = BASE + url

    # 单独请求 kkFileView 页面（签名地址自带鉴权，无需 session）
    rr = httpx.get(url, timeout=90, follow_redirects=True)
    body = rr.text
    print(f"[4] kkFileView 预览页 {rr.status_code} 长度={len(body)}")

    low = body.lower()
    for kw, desc in [
        ("正在转换", "「正在转换」等待页"),
        ("waiting", "waiting（等待转换）"),
        ("cadviewer", "CADViewer 展示页"),
        ("svg", "SVG 展示页"),
        ("aspose", "aspose 相关"),
        ("不支持", "不支持提示"),
        ("失败", "失败提示"),
        ("error", "error 字样"),
    ]:
        if kw in low:
            print(f"    命中 {desc}")

    # 抓页面里所有可见文案提示
    for m in re.findall(r"<title>([^<]{0,80})</title>", body):
        print(f"    title: {m}")
    for m in re.findall(r"message\s*[:=]\s*['\"]([^'\"]{0,150})", body):
        print(f"    message: {m}")
    for m in re.findall(r"文件正在转换中[^<\"']{0,60}", body):
        print(f"    提示: {m}")

    # kkFileView 有转换状态查询接口，直接问它卡在哪
    print("[5] 查询转换状态")
    for path in ("/getConvertStatus", "/convertStatus", "/checkConvertStatus"):
        try:
            s = httpx.get(KK + path, timeout=20)
            print(f"    {path} → {s.status_code} {s.text[:200]}")
        except Exception as e:  # noqa: BLE001
            print(f"    {path} → 不可达 {e}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
