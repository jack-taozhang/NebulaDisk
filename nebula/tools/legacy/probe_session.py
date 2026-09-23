#!/usr/bin/env python3
"""端到端确认：会话 token 在「服务端」与「独立进程」之间能互相验证。

步骤：
  1. 独立进程读同一份 secret.key，签发 token
  2. 用该 token 走真实 HTTP 打 /api/me
  3. 再用密码走 /api/login 拿服务端下发的 cookie，打 /api/me
两者都应 200。
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
# devserver.py 固定用这个密钥（它不读 secret.key），探针必须保持一致，
# 否则自签的 token 服务端验不过 —— 会误判成"鉴权坏了"。
os.environ.setdefault("NEBULA_JWT_SECRET", "dev-secret-for-local-testing-only")
os.environ.setdefault("NEBULA_DATA_DIR", r"E:\TEMP\nebula-dev\data")
os.environ.setdefault("NEBULA_MOUNTS", "文档|E:\\TEMP\\nebula-dev\\docs|*")

import httpx  # noqa: E402

from app import auth, config  # noqa: E402

BASE = os.environ.get("BASE", "http://127.0.0.1:8899")
print(f"本进程读到的 secret 前 8 位: {config.settings.jwt_secret[:8]}...")

ok = 0
bad = 0

# --- 路径 A：独立进程自签 token ---
tok = auth.issue_session("admin", True)
with httpx.Client(base_url=BASE, timeout=20) as c:
    r = c.get("/api/me", headers={"Cookie": f"{auth.COOKIE_NAME}={tok}"})
    print(f"[A] 自签 token 打 /api/me -> {r.status_code} {r.text[:100]}")
    ok += r.status_code == 200
    bad += r.status_code != 200

    r = c.get("/api/list", params={"mount": "文档", "path": "/"},
              headers={"Cookie": f"{auth.COOKIE_NAME}={tok}"})
    print(f"[A] 自签 token 列目录 -> {r.status_code} {r.text[:120]}")
    ok += r.status_code == 200
    bad += r.status_code != 200

    # --- 路径 B：真实登录，服务端下发 cookie ---
    u = os.environ.get("NU", "admin")
    pw = os.environ.get("NP", "")
    r = c.post("/api/login", data={"username": u, "password": pw})
    print(f"[B] 密码登录 -> {r.status_code} {r.text[:100]}")
    print(f"[B] 收到 cookie: {list(c.cookies.keys())}")
    r2 = c.get("/api/me")
    print(f"[B] 登录 cookie 打 /api/me -> {r2.status_code} {r2.text[:100]}")
    ok += r2.status_code == 200
    bad += r2.status_code != 200

print()
print(f"通过 {ok} 项，失败 {bad} 项")
sys.exit(0 if bad == 0 else 1)
