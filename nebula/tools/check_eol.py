#!/usr/bin/env python3
"""check_eol.py —— 检查交付给 Linux 的文本文件是不是 CRLF（\r\n）

=============================================================================
为什么需要它
=============================================================================
2026-09-21 在 Windows 上用 `pathlib.Path.write_text()` 给几个文件打补丁，
结果把 **整个文件的 LF 都变成了 CRLF** —— 因为 `write_text` 在 Windows 上
会按 `os.linesep` 做换行转换（写回去就是 `\r\n`）。

后果分两级：
  · `.py` —— Python 容忍 CRLF，**看不出来**，所以本地单测/自检全绿；
  · `.sh` —— Linux 的 bash **不容忍**。脚本一运行就报
        `set: pipefail: invalid option name`
        `syntax error near unexpected token $'{\\r'`
    整个脚本报废。而 **Git Bash 是容忍 CRLF 的**，所以在 Windows 上一直
    测不出来，直到把源码推到 NAS 才炸。

⇒ 边界很清晰：
    · **Git Bash 容忍 CRLF → Windows 上发现不了**
    · **Linux 不容忍 → 交付到 NAS/服务器上才炸**
  所以必须有一道**显式**检查，不能靠"跑一下试试"。

★ 只扫我们自己的目录（nebula/ deploy/ 根级脚本）★
  `src/` 是上游 kkFileView 仓库，它本来就有大量 CRLF（Windows-first 的
  Java 项目），**不能动、也不该报**。所以扫描根是显式列出来的，不是仓库根。
=============================================================================
"""

from __future__ import annotations

import sys
from pathlib import Path

# 明确列出扫描根 —— 故意**不含** `src/`（上游仓库，CRLF 是其原貌）
DEFAULT_ROOTS = ["nebula", "deploy", "."]

# 根级只挑这几个（`.` 作为扫描根时只扫下面这些名字）
ROOT_LEVEL_NAMES = {
    "build.sh", "Dockerfile", ".dockerignore", ".gitignore",
    "docker-compose.yml", ".env", ".env.example", ".gitattributes",
}

TEXT_SUFFIXES = {
    ".sh", ".bash", ".py", ".js", ".mjs", ".cjs", ".css", ".html", ".htm",
    ".json", ".yml", ".yaml", ".conf", ".md", ".txt", ".ftl", ".service",
    ".properties", ".env", ".example", ".template", ".ini",
}
TEXT_NAMES = {"Dockerfile", ".dockerignore", ".gitignore", ".env", ".env.example",
              ".gitattributes"}

SKIP_DIRS = {"__pycache__", "node_modules", ".git", "dist", "sample",
             "LibreOfficePortable", "_tf_tmp", ".unit_tmp", "_eol_fixtures"}
# ↑ _eol_fixtures 里故意放了一个 CRLF 样本给"护栏自检"用，所以默认跳过；
#   加 --include-fixtures 时才会扫它。


def is_text_file(p: Path) -> bool:
    if p.name in TEXT_NAMES:
        return True
    return p.suffix.lower() in TEXT_SUFFIXES


def scan(roots: list[Path], include_fixtures: bool) -> list[Path]:
    bad: list[Path] = []
    seen: set[Path] = set()
    for root in roots:
        if not root.exists():
            continue
        if root.is_file():
            cands = [root]
        elif root == Path("."):
            cands = [p for p in root.iterdir() if p.is_file() and p.name in ROOT_LEVEL_NAMES]
        else:
            cands = list(root.rglob("*"))
        for p in cands:
            if not p.is_file():
                continue
            parts = set(p.parts)
            if parts & SKIP_DIRS:
                if not (include_fixtures and "_eol_fixtures" in parts):
                    continue
            if not is_text_file(p):
                continue
            if p in seen:
                continue
            seen.add(p)
            try:
                b = p.read_bytes()
            except OSError:
                continue
            if b"\r\n" in b:
                bad.append(p)
    return sorted(bad)


def main(argv: list[str]) -> int:
    include_fixtures = "--include-fixtures" in argv
    args = [a for a in argv[1:] if not a.startswith("--")]
    roots = [Path(a) for a in args] if args else [Path(r) for r in DEFAULT_ROOTS]

    bad = scan(roots, include_fixtures)
    if not bad:
        print(f"✅ 换行符检查通过（扫描根：{', '.join(str(r) for r in roots)}）")
        return 0

    print(f"❌ 发现 {len(bad)} 个 CRLF 文件 —— Linux 上 bash 会直接语法错误：")
    for p in bad:
        n = p.read_bytes().count(b"\r\n")
        print(f"   {p}  ({n} 行 CRLF)")
    print()
    print("   修法（★ 不要用 write_text，Windows 上它会把 \\n 又写回 \\r\\n ★）：")
    print("     python -c \"import pathlib,sys;[pathlib.Path(f).write_bytes("
          "pathlib.Path(f).read_bytes().replace(b'\\\\r\\\\n', b'\\\\n')) for f in sys.argv[1:]]\" <文件…>")
    print("   或： sed -i 's/\\r$//' <文件…>")
    return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
