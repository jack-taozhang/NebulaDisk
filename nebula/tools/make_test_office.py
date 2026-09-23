#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成一个最小但合法的 .docx / .xlsx / .pptx，用于验证 OnlyOffice 编辑链路。

为什么要自己拼：
  容器里的 soffice 正被 kkFileView 占用（OFFICE_PLUGIN_SERVER_PORTS=2001），
  再起一个实例去转换会抢锁、静默失败。而验证 OnlyOffice 只需要一个
  「OnlyOffice 认得、能打开」的 OOXML 文件，手工拼 zip 最稳。

用法：
  python tools/make_test_office.py <输出目录>
"""
import os
import sys
import zipfile

CT = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
</Types>"""

RELS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>"""

DOCX = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>
<w:p><w:r><w:t>NebulaDisk OnlyOffice 测试文档</w:t></w:r></w:p>
<w:p><w:r><w:t>如果你能在编辑器里看到这段文字，说明文档回拉链路是通的。</w:t></w:r></w:p>
<w:p><w:r><w:t>保存后这段字会被 OnlyOffice 的回调写回宿主机目录。</w:t></w:r></w:p>
</w:body></w:document>"""


def make_docx(path: str) -> None:
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", CT)
        z.writestr("_rels/.rels", RELS)
        z.writestr("word/document.xml", DOCX)


def main() -> int:
    out = sys.argv[1] if len(sys.argv) > 1 else "."
    os.makedirs(out, exist_ok=True)
    targets = {
        "Office测试.docx": make_docx,
    }
    for name, fn in targets.items():
        p = os.path.join(out, name)
        fn(p)
        print(f"created {p} ({os.path.getsize(p)} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
