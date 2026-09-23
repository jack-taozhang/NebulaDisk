#!/usr/bin/env bash
# NebulaDisk 后端语法与导入自检（在 WSL 内运行）
set -euo pipefail

APP_DIR="${1:-/mnt/d/Docker/kkFileView/nebula}"
VENV="/opt/nebula-venv"

echo "=== 1. 语法编译检查 ==="
cd "$APP_DIR"
python3 -m py_compile app/*.py && echo "OK 所有 .py 编译通过"

echo
echo "=== 2. 建立测试用 venv ==="
if [ ! -d "$VENV" ]; then
  python3 -m venv "$VENV"
fi
# shellcheck disable=SC1091
source "$VENV/bin/activate"
pip install -q --disable-pip-version-check -r requirements.txt

echo
echo "=== 3. 导入检查（用假环境变量） ==="
export NEBULA_MOUNTS="测试目录:/tmp/nebula-test:*,共享:/tmp/nebula-test2:alice"
export NEBULA_JWT_SECRET="test-secret-for-selfcheck"
export NEBULA_DATA_DIR="/tmp/nebula-data"
export NEBULA_OO_URL="http://127.0.0.1:8082"
export NEBULA_OO_SECRET="dev-oo-secret-for-local-testing-only"
mkdir -p /tmp/nebula-test /tmp/nebula-test2 /tmp/nebula-data

python3 - <<'PY'
from app.config import settings, route_of, parse_mounts
print("挂载解析:", [(m.label, m.path, sorted(m.users)) for m in settings.mounts])
assert len(settings.mounts) == 2, "映射数量不对"
assert settings.mounts[0].public
assert not settings.mounts[1].public
assert settings.mounts[1].visible_to("alice")
assert not settings.mounts[1].visible_to("bob")

print("路由判定:")
for n in ["a.docx", "b.xlsx", "c.pptx", "d.pdf", "e.png", "f.zip", "g.rar", "h.exe", "i.unknownext"]:
    print(f"  {n:16s} -> {route_of(n)}")
assert route_of("a.docx") == "onlyoffice"
assert route_of("b.xlsx") == "onlyoffice"
assert route_of("e.png") == "kkfileview"

from app.auth import issue_session, read_session, jwt_encode, jwt_decode
tok = issue_session("alice", False)
s = read_session(tok)
print("会话:", s)
assert s == {"username": "alice", "is_admin": False}
assert read_session(tok + "x") is None, "篡改后应失效"

# OnlyOffice 风格签名往返
p = {"documentType": "word", "document": {"fileType": "docx", "title": "中文名.docx"}}
t = jwt_encode(p, "dev-oo-secret-for-local-testing-only")
assert jwt_decode(t, "dev-oo-secret-for-local-testing-only") == p
print("JWT 往返: OK（含中文）")

from app import files
# 安全测试：路径穿越
class FakeMount:
    label = "t"; path = "/tmp/nebula-test"; users = {"*"}
    @property
    def public(self): return True
    def visible_to(self, u): return True
mk = FakeMount()
for bad in ["../etc/passwd", "..%2f..%2fetc", "a/../../etc/passwd", "/etc/passwd"]:
    try:
        r = files.resolve(mk, bad)
        print(f"  ⚠️ 穿越未被拦截?: {bad} -> {r}")
    except files.FileError as e:
        print(f"  OK 拦截 {bad!r}: {e.message}")

# 正常路径
open("/tmp/nebula-test/hello.txt", "w").write("hi")
p1 = files.resolve(mk, "hello.txt")
print("正常解析:", p1)
print("列目录:", files.list_dir(mk, "", "alice")["entries"][0]["name"])

from app.integrations import kk_preview_url, build_editor_config, _doc_type
print("kk 预览 URL:", kk_preview_url("", "http://nebula:8088/api/raw?x=1")[:90], "...")
assert _doc_type("docx") == "word" and _doc_type("xlsx") == "cell" and _doc_type("pptx") == "slide"

cfg = build_editor_config(
    file_key="k1", title="报告.docx", doc_url="http://nebula:8088/api/raw?a=1",
    callback_url="http://nebula:8088/api/oo/callback", mode="edit",
    user_id="alice", user_name="alice",
)
assert "token" in cfg
dec = jwt_decode(cfg["token"], "dev-oo-secret-for-local-testing-only")
assert "token" not in dec, "签名时不应把 token 自身算进去"
print("OnlyOffice config 签名: OK, documentType =", dec["documentType"])

import app.main as main
print("FastAPI 路由数:", len(main.app.routes))
print()
print("✅ 全部自检通过")
PY
