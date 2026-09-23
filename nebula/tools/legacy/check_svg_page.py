"""端到端验证 svg.ftl 修复：登录 → 取 DWG 预览页 → 断言页面里带上了「适应窗口」逻辑。

接口形状（实测，勿凭印象改）：
  POST /api/login  → **Form** 字段 username/password（不是 JSON）
  GET  /api/list?mount=&path=  → {"path":..., "entries":[{name,isDir,ext,route,mime,...}]}
  GET  /api/preview?mount=&path= → 预览地址（kkFileView）
只读探针，不改任何服务端状态。
用法: python3 check_svg_page.py [base]
"""
import re
import sys

import httpx

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8089").rstrip("/")
USER = "admin"
PWD = "dev-pass-not-real"

ok, bad, notes = [], [], []


def chk(cond, msg):
    (ok if cond else bad).append(msg)


with httpx.Client(base_url=BASE, timeout=60.0, follow_redirects=True) as c:
    r = c.post("/api/login", data={"username": USER, "password": PWD})
    chk(r.status_code == 200, f"登录 → {r.status_code}")
    if r.status_code != 200:
        print(r.text[:400])
        sys.exit(1)

    # 找 DWG
    dwg = None
    for mount in ("共享", "照片", "私密"):
        rr = c.get("/api/list", params={"mount": mount, "path": "/"})
        if rr.status_code != 200:
            notes.append(f"  列目录失败 {mount} → {rr.status_code}")
            continue
        for it in rr.json().get("entries", []):
            if str(it.get("name", "")).lower().endswith(".dwg"):
                dwg = (mount, it["name"])
                notes.append(f"  DWG route={it.get('route')} mime={it.get('mime')}")
                break
        if dwg:
            break
    chk(dwg is not None, f"找到 DWG 文件 → {dwg}")
    if not dwg:
        print("\n".join(bad))
        sys.exit(1)

    mount, name = dwg
    r = c.get("/api/preview", params={"mount": mount, "path": "/" + name})
    chk(r.status_code == 200, f"取预览信息 → {r.status_code}")
    info = r.json() if r.status_code == 200 else {}
    notes.append(f"  preview keys = {list(info.keys())}")
    url = info.get("url") or info.get("previewUrl") or info.get("src") or ""
    if not url:
        for k, v in info.items():
            if isinstance(v, str) and ("preview" in v or "http" in v):
                url = v
                break
    notes.append(f"  preview url = {url[:160]}")

    if url:
        pu = url if url.startswith("http") else BASE + url
        rp = c.get(pu)
        chk(rp.status_code == 200, f"取预览页 → {rp.status_code}")
        html = rp.text
        notes.append(f"  页面字节数 = {len(html)}")

        if "svg-container" in html:
            chk("computeFitZoom" in html, "页面含 computeFitZoom（适应窗口）")
            chk("readSvgIntrinsicSize" in html, "页面含 readSvgIntrinsicSize（固有尺寸解析）")
            chk("setAttribute" in html and "viewBox" in html, "页面含 viewBox 注入逻辑")
            chk(
                re.search(r"svgElement\.style\.width\s*=\s*'100%'", html) is None,
                "旧的写死 style.width='100%' 已移除（它是空白根因）",
            )
            chk("__intrinsic" in html, "页面记录固有尺寸供缩放使用")
        else:
            notes.append("  （该文件走的不是 svg 预览路径，跳过 svg 专项断言）")

print("=== 断言 ===")
for m in ok:
    print(f"  ✅ {m}")
for m in bad:
    print(f"  ❌ {m}")
print("=== 备注 ===")
for m in notes:
    print(m)
print(f"\n{'✅ 全部符合预期' if not bad else '❌ 存在失败项'} ({len(ok)}/{len(ok) + len(bad)})")
sys.exit(1 if bad else 0)
