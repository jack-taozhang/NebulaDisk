#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""验证 /api/cad/preview 的 open= 地址是否随请求 Host 正确切换。

这是本项目最核心的一条规则：
  · 浏览器可达地址必须来自**本次请求的 Host**（_origin），
    而不是容器间配置（NEBULA_BASE_URL=http://nebula:8088）。
验证方法：用不同的 Host 头各请求一次，看 open= 里的 host 是否跟着变。
"""
import json
import http.cookiejar
import urllib.parse
import urllib.request

BASE = "http://127.0.0.1:8088"
PWD = "dev-pass-not-real"
TARGET = "/api/cad/preview?" + urllib.parse.urlencode(
    {"mount": "共享", "path": "/立库规划图块.dwg"})


def session(host):
    """用指定 Host 登录并返回 opener（cookie 绑定在该 host 上）。"""
    jar = http.cookiejar.CookieJar()
    op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    body = urllib.parse.urlencode({"username": "admin", "password": PWD}).encode()
    req = urllib.request.Request(BASE + "/api/login", data=body,
                                headers={"Host": host})
    op.open(req, timeout=15).read()
    return op


def preview(op, host):
    req = urllib.request.Request(BASE + TARGET,
                                 headers={"Host": host, "X-Forwarded-Proto": "http"})
    return json.loads(op.open(req, timeout=20).read().decode())


CASES = [
    "192.168.1.10:8089",
    "nas.local:8089",
    "cloud.example.com",
    "10.0.0.5:18089",
]

print("=" * 72)
fails = []
for host in CASES:
    op = session(host)
    d = preview(op, host)
    open_url = urllib.parse.parse_qs(
        urllib.parse.urlparse(d["url"]).query).get("open", [""])[0]
    got_host = urllib.parse.urlsplit(open_url).netloc
    ok = got_host == host
    print(f"{'✅' if ok else '❌'} 请求Host={host:<24} open.host={got_host}")
    if not ok:
        fails.append((host, got_host))
    for bad in ("nebula:8088",):
        if bad in open_url:
            fails.append((host, f"含容器名 {bad}"))
            print(f"    ⚠ open 里出现容器内部名 {bad}")

print("=" * 72)
if fails:
    print("❌ 失败：")
    for f in fails:
        print("   ", f)
    raise SystemExit(1)
print("✅ open= 地址完全跟随请求 Host，浏览器不会被指向容器内网名")
