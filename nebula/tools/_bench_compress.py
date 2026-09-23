#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""测量压缩包预览各阶段的真实耗时 —— 定位「慢」到底慢在哪一环。

分阶段计时，找出瓶颈：
  1. /api/preview          （拿预览地址）
  2. /onlinePreview 首字节 （这步就是压缩包解压+渲染，最可疑）
  3. /directory 探测
  4. 成员取字节
"""
import base64
import os
import re
import sys
import time
import urllib.parse

import requests

BASE = os.environ.get("NEBULA_BASE", "http://127.0.0.1:8089").rstrip("/")
USER = os.environ.get("NEBULA_TEST_USER", "admin")
PWD = os.environ.get("NEBULA_TEST_PASSWORD", "dev-pass-not-real")
MOUNT = os.environ.get("NEBULA_TEST_MOUNT", "共享")

CASES = [
    ("00-Q3-1250.zip", "00-Q3-1250.stp"),
    ("1.2.14.TFDF-6# F向.zip", "1.2.14.TFDF-6# F向.STEP"),
]


def step(label, fn):
    t0 = time.time()
    try:
        r = fn()
        dt = time.time() - t0
        print(f"    {label:<38} {dt:7.2f}s   {r}")
        return dt
    except Exception as e:
        dt = time.time() - t0
        print(f"    {label:<38} {dt:7.2f}s   !! {type(e).__name__}: {e}")
        return dt


def main():
    s = requests.Session()
    r = s.post(f"{BASE}/api/login", data={"username": USER, "password": PWD}, timeout=20)
    if r.status_code != 200:
        print(f"登录失败 {r.status_code}")
        return 2
    print(f"登录成功 {BASE}\n")

    for arch, member in CASES:
        print(f"===== {arch} =====")

        def get_prev_url():
            pr = s.get(f"{BASE}/api/preview",
                       params={"mount": MOUNT, "path": "/" + arch}, timeout=30)
            pr.raise_for_status()
            return pr.json()["url"]

        t0 = time.time()
        url = get_prev_url()
        print(f"    {'/api/preview':<38} {time.time()-t0:7.2f}s")

        t0 = time.time()
        try:
            page = s.get(BASE + url, timeout=600)
            dt = time.time() - t0
            has = "buildPreviewUrl" in page.text
            print(f"    {'/onlinePreview（解压+渲染）':<38} {dt:7.2f}s   "
                  f"status={page.status_code} bytes={len(page.content)} "
                  f"buildPreviewUrl={'有' if has else '无'}")
        except requests.RequestException as e:
            print(f"    {'/onlinePreview':<38} {time.time()-t0:7.2f}s   "
                  f"!! {type(e).__name__}: {e}")
            continue

        m = re.search(r"var url = \"http://\" \+ '([^']*)'", page.text)
        tree = m.group(1) if m else ""
        print(f"    fileTree = {tree!r}")

        if tree:
            url_tree = "http://" + tree
            b64 = base64.b64encode(url_tree.encode()).decode()

            def probe():
                d = s.get(f"{BASE}/preview/directory?urls={urllib.parse.quote(b64)}",
                          timeout=120)
                try:
                    j = d.json()
                    ch = j[0].get("children") if j else None
                    return f"HTTP {d.status_code} children={'非空' if ch else 'null'}"
                except ValueError:
                    return f"HTTP {d.status_code} (非JSON)"

            step("/directory 探测", probe)

            # 成员取字节
            key = arch + "_"
            rel = key + "/" + member
            murl = (f"http://127.0.0.1:8012/{urllib.parse.quote(rel, safe='/')}?"
                    + urllib.parse.urlencode({
                        "kkCompressfileKey": key,
                        "kkCompressfilepath": rel,
                        "fullfilename": member,
                    }))
            gq = (f"{BASE}/preview/getCorsFile?urlPath="
                  + urllib.parse.quote(base64.b64encode(murl.encode()).decode())
                  + "&fullfilename=" + urllib.parse.quote(member))

            def get_member():
                rr = s.get(gq, timeout=600)
                return f"HTTP {rr.status_code} bytes={len(rr.content)}"

            step("成员取字节 (getCorsFile)", get_member)

        # 第二次打开：走缓存应该快
        t0 = time.time()
        page2 = s.get(BASE + url, timeout=600)
        print(f"    {'  第二次 /onlinePreview（走缓存）':<38} "
              f"{time.time()-t0:7.2f}s")
        print()

    return 0


if __name__ == "__main__":
    sys.exit(main())
