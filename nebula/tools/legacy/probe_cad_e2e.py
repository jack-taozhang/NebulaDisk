#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""端到端验证：CAD 路由 + 深链地址是否为浏览器可达。

在 nebula 容器里跑（它自己就是服务端），验证三件事：
  1. dwg/dxf 的 route 是不是 'cad'
  2. /api/cad/preview 返回的 open= 地址里，host 是不是**浏览器侧**的
     （反例：出现 http://nebula:8088 —— 浏览器解析不了，页面会 Failed to fetch）
  3. 该地址在同容器内能否真的取到字节（200 + 非空）
"""
import json
import sys
import urllib.parse
import urllib.request
import http.cookiejar

BASE = "http://127.0.0.1:8088"
USER, PWD = "admin", "dev-pass-not-real"

jar = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))


def post(path, data):
    body = urllib.parse.urlencode(data).encode()
    req = urllib.request.Request(BASE + path, data=body)
    return json.loads(opener.open(req, timeout=15).read().decode())


def get_json(route, **params):
    """route 是 API 路径。注意参数名不能叫 path，会与形参冲突。"""
    url = BASE + route + ("?" + urllib.parse.urlencode(params) if params else "")
    return json.loads(opener.open(url, timeout=20).read().decode())


def get_raw(url):
    req = urllib.request.Request(url, headers={"Host": "localhost:8089"})
    r = opener.open(req, timeout=30)
    return r.status, r.read()


print("=" * 70)
print("1) 登录")
me = post("/api/login", {"username": USER, "password": PWD})
print("   ", me)

print("\n2) 取映射盘，定位 dwg 文件")
me2 = get_json("/api/me")
mounts = me2.get("mounts") or []
print("    mounts =", mounts)
share = mounts[0].get("label") if mounts else "共享"
print("    share =", share)

lst = get_json("/api/list", mount=share, path="/")
entries = lst.get("entries", [])
print(f"    共 {len(entries)} 项")
dwg = [e for e in entries if (e.get("ext") or "").lower() in ("dwg", "dxf")]
for e in dwg:
    print("     -", e.get("name"), " ext=", e.get("ext"))

if not dwg:
    print("    !! 共享目录里没有 dwg/dxf，无法继续")
    sys.exit(3)

target = dwg[0]
name = target["name"]

print("\n3) 前端路由表核对（route_of 是纯前端逻辑，这里用 /api/cad/preview 的可用性间接验证）")
print("    dwg/dxf 有 cad 引擎 -> 走 cad-viewer；其余 Office -> OnlyOffice；兜底 kkFileView")

print("\n4) /api/cad/preview 深链")
prev = get_json("/api/cad/preview", mount=share, path="/" + name)
print("    url =", prev.get("url"))
print("    raw =", prev.get("raw"))

open_url = urllib.parse.parse_qs(urllib.parse.urlparse(prev["url"]).query).get("open", [""])[0]
print("    open(解码) =", open_url)

problems = []
if "nebula:8088" in open_url:
    problems.append("open 里含容器名 nebula:8088 —— 浏览器解析不了！")
if "127.0.0.1:8088" in open_url:
    problems.append("open 里含容器回环 127.0.0.1:8088 —— 浏览器指向自己！")
if not open_url.startswith("http"):
    problems.append("open 不是绝对地址")

print("\n5) 取流可用性")
try:
    st, data = get_raw(prev["raw"])
    print(f"    HTTP {st}  {len(data)} bytes")
    if st != 200 or len(data) == 0:
        problems.append(f"取流异常：HTTP {st}, {len(data)} bytes")
except Exception as ex:
    problems.append(f"取流失败：{ex}")

print("\n" + "=" * 70)
if problems:
    print("❌ 发现问题：")
    for p in problems:
        print("   -", p)
    sys.exit(1)
print("✅ CAD 深链与取流验证通过")
sys.exit(0)
