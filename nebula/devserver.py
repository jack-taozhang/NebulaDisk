# -*- coding: utf-8 -*-
"""
NebulaDisk —— 本地端到端测试服务

在一台 Windows 机器上把后端跑起来（用临时测试目录），
供浏览器测试脚本驱动。真实部署走 Docker，这里只为验证前端交互。

用法：
    python devserver.py            # 默认 :8899
    python devserver.py 9000
"""

import os
import shutil
import sys
import tempfile
from pathlib import Path

# ---- 造测试数据（必须在 import app.* 之前设好环境变量） ----
ROOT = Path(__file__).resolve().parent
TMP = Path(tempfile.gettempdir()) / "nebula-dev"
if TMP.exists():
    shutil.rmtree(TMP, ignore_errors=True)

DOCS = TMP / "docs"
PHOTOS = TMP / "photos"
ALICE = TMP / "alice-private"
DATA = TMP / "data"
for d in (DOCS, PHOTOS, ALICE, DATA):
    d.mkdir(parents=True, exist_ok=True)

# 造一点目录结构，模拟 NAS 上的真实布局
(DOCS / "设计文档").mkdir(exist_ok=True)
(DOCS / "会议纪要").mkdir(exist_ok=True)
(DOCS / "归档").mkdir(exist_ok=True)
(DOCS / "归档" / "2025").mkdir(exist_ok=True)

files = {
    DOCS / "说明.txt": "这是一个测试文本文件。\n第二行内容。\n第三行看看自动换行效果，"
                       "这里写一段比较长的文字来测试换行，中英文混排 abc def ghi jkl mno。\n",
    DOCS / "readme.md": "# NebulaDisk\n\n仿 Windows 云盘。\n\n- 目录映射\n- 双击预览\n- OnlyOffice 编辑\n",
    DOCS / "report.csv": "月份,收入,支出\n1月,12000,8000\n2月,15000,9000\n3月,11000,10000\n",
    DOCS / "config.json": '{\n  "title": "NebulaDisk",\n  "version": "1.0.0",\n  "features": ["preview", "edit"]\n}\n',
    DOCS / "app.py": "def hello(name):\n    \"\"\"打招呼\"\"\"\n    return f'你好，{name}!'\n\n\nif __name__ == '__main__':\n    print(hello('世界'))\n",
    DOCS / "设计文档" / "架构说明.md": "# 架构\n\n单镜像双进程：kkFileView + NebulaDisk。\n",
    DOCS / "会议纪要" / "2026-09-20.txt": "与会人：张三、李四\n议题：云盘上线\n结论：本周内完成\n",
    ALICE / "私密笔记.txt": "只有 alice 能看到的文件。\n",
}
for p, content in files.items():
    p.write_text(content, encoding="utf-8")

# 造一张真实的小 PNG（用于测试缩略图/图片查看器）
import base64
PNG_1PX = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAMgAAADICAYAAACtWK6eAAAAAXNSR0IArs4c6QAAAARnQU1BAACx"
    "jwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAADQSURBVHhe7dExAQAADMOg+TfdmcgDkoDa"
    "3TsHhLsAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA4L0BXsAAAcKm4gQA"
    "AAAASUVORK5CYII=")
(DOCS / "示例图片.png").write_bytes(PNG_1PX)
(PHOTOS / "screenshot.png").write_bytes(PNG_1PX)

os.environ["NEBULA_MOUNTS"] = (
    f"文档|{DOCS.as_posix()}|*;"
    f"图片|{PHOTOS.as_posix()}|*;"
    f"私人|{ALICE.as_posix()}|admin"
)
os.environ["NEBULA_JWT_SECRET"] = "dev-secret-for-local-testing-only"
os.environ["NEBULA_DATA_DIR"] = DATA.as_posix()
os.environ["NEBULA_ADMIN_USER"] = "admin"
os.environ["NEBULA_ADMIN_PASSWORD"] = "admin123"
os.environ["NEBULA_TITLE"] = "NebulaDisk"
# OnlyOffice 指向本地 8082（如未启动，前端会显示离线，不影响其他功能测试）
os.environ["NEBULA_OO_URL"] = os.environ.get("NEBULA_OO_URL", "http://127.0.0.1:8082")
os.environ["NEBULA_OO_SECRET"] = os.environ.get("NEBULA_OO_SECRET", "dev-oo-secret-for-local-testing-only")
os.environ["NEBULA_OO_PUBLIC"] = os.environ.get("NEBULA_OO_PUBLIC", "http://127.0.0.1:8082")
os.environ["NEBULA_PREVIEW"] = os.environ.get("NEBULA_PREVIEW", "http://127.0.0.1:8012")

sys.path.insert(0, str(ROOT))

if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8899
    import uvicorn
    print("=" * 66)
    print(f"NebulaDisk 开发服务器  →  http://127.0.0.1:{port}")
    print(f"  文档目录: {DOCS}")
    print(f"  图片目录: {PHOTOS}")
    print(f"  私密目录: {ALICE}  (仅 admin)")
    print(f"  登录账号: admin / admin123")
    print("=" * 66)
    uvicorn.run("app.main:app", host="127.0.0.1", port=port,
                log_level="info", reload=False)
