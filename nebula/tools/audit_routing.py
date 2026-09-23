#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""对照用户需求逐项核对「扩展名 → 预览引擎」路由表。

用户要求（2026-09-21 收窄后）：
  · OnlyOffice 只负责「确实是 Office、编辑需求强」的那批：
      doc/docx/docm · xls/xlsx/xlsm · ppt/pptx/pptm
      + pdf / csv / tsv / rtf（用户点名要与 Office 关联处理）
  · dwg / dxf 用 cad-viewer 打开
  · 其余（Office 模板 / 加载项 / OpenDocument / txt / 压缩包 / 图元…）
    一律交给 kkFileView 只读预览
所以期望的路由优先级是：cad > onlyoffice > kkfileview > download

★ 运行前提：必须让 settings.oo_enabled 为真，否则 route_of() 会跳过
  OnlyOffice 分支，于是所有 Office 类型都显示成 kkfileview，
  审计会报一堆"期望 onlyoffice 实际 kkfileview"的**假红**。
  正确跑法（本地）：
      NEBULA_OO_URL=http://onlyoffice NEBULA_OO_SECRET=test \
        python tools/audit_routing.py
  容器内由部署环境自然带上这两个变量，直接跑即可。

本脚本把用户列举的每个扩展名跑一遍 route_of()，把结果与期望比对，
把「用户要求支持但实际落不到任何引擎」的类型单独列出来。
"""
import io
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "app"))

# 让 config 在 import 时不要因为缺数据目录而报错
os.environ.setdefault("NEBULA_DATA_DIR", "/tmp/nebula-audit")
os.environ.setdefault("NEBULA_CAD_URL", "http://cad:8080")   # 假装已配置，才能测出 cad 分支

from config import route_of, CAD_EXT, OO_EDIT_EXT, KK_EXT  # noqa: E402

# --- 用户原话里列出的类型，按分组整理 --------------------------------------
GROUPS = {
    "Office": "doc docx xls xlsx xlsm ppt pptx csv tsv dotm xlt xltm dot dotx xlam xla pages pptm".split(),
    "WPS": "wps dps et ett wpt".split(),
    "OpenOffice": "odt ods ots odp otp six ott fodt fods".split(),
    "Visio": "vsd vsdx".split(),
    "Windows图元": "wmf emf".split(),
    "Photoshop": "psd eps".split(),
    "文档": "pdf ofd rtf".split(),
    "思维导图": "xmind".split(),
    "工作流": "bpmn".split(),
    "邮件": "eml msg".split(),
    "电子书": "epub".split(),
    "3D模型": "obj 3ds stl ply gltf glb off 3dm fbx dae wrl 3mf ifc brep step iges fcstd bim".split(),
    "CAD": "dwg dxf dwf iges igs dwt dng ifc dwfx stl cf2 plt".split(),
    "纯文本": "txt xml xbrl md java php py js css".split(),
    "压缩包": "zip rar jar tar gzip 7z".split(),
    "图片": "jpg jpeg png gif bmp ico jfif webp heic heif".split(),
    "TIFF": "tif tiff".split(),
    "TGA": "tga".split(),
    "SVG": "svg".split(),
    "音视频": "mp3 wav mp4 flv".split(),
    "视频转码": "avi mov rm webm ts mkv mpeg ogg mpg rmvb wmv 3gp".split(),
    "医疗影像": "dcm".split(),
    "绘图": "drawio".split(),
}


def expected(ext: str) -> str:
    """依据用户的三条规则推出期望路由。"""
    if ext in CAD_EXT:
        return "cad"
    if ext in OO_EDIT_EXT:
        return "onlyoffice"
    if ext in KK_EXT:
        return "kkfileview"
    return "download"


def main() -> int:
    total = 0
    missing = []      # 用户要求支持，但落到 download（= 没有预览能力）
    downgraded = []   # 期望 A 实际 B

    # ★ 前置提醒：oo_enabled 为假时，本审计对 Office 类型的结论**无意义** ★
    #   route_of() 会跳过 OnlyOffice 分支 → 所有 Office 类型都报 kkfileview，
    #   与 expected() 的 onlyoffice 期望冲突，产出一片假红。
    from config import settings as _s
    if not _s.oo_enabled:
        print("=" * 74)
        print("⚠  NEBULA_OO_URL / NEBULA_OO_SECRET 未配置 → settings.oo_enabled=False")
        print("   Office 类型会全部落到 kkfileview，下面的 onlyoffice 判定不可信。")
        print("   本地复核请用：")
        print("     NEBULA_OO_URL=http://onlyoffice NEBULA_OO_SECRET=test \\")
        print("       python tools/audit_routing.py")
        print("=" * 74)
        print()

    print("=" * 74)
    print(f"{'分组':<12}{'类型数':<7}{'cad':>5}{'onlyoffice':>12}{'kkfileview':>12}{'无预览':>8}")
    print("=" * 74)

    for gname, exts in GROUPS.items():
        tally = {"cad": 0, "onlyoffice": 0, "kkfileview": 0, "download": 0}
        for e in exts:
            total += 1
            got = route_of(f"sample.{e}")
            tally[got] = tally.get(got, 0) + 1
            exp = expected(e)
            if got == "download":
                missing.append((gname, e))
            elif got != exp:
                downgraded.append((gname, e, exp, got))
        print(f"{gname:<12}{len(exts):<7}{tally['cad']:>5}{tally['onlyoffice']:>12}"
              f"{tally['kkfileview']:>12}{tally['download']:>8}")

    print("=" * 74)
    print(f"合计类型：{total}")

    if downgraded:
        print(f"\n⚠ 与期望路由不一致（{len(downgraded)} 项）：")
        for g, e, exp, got in downgraded:
            print(f"   {g:<10} .{e:<8} 期望 {exp:<11} 实际 {got}")
    else:
        print("\n✅ 所有类型路由与「cad > onlyoffice > kkfileview」规则一致")

    if missing:
        print(f"\n❌ 用户要求支持但当前**没有任何预览引擎**（只能下载，{len(missing)} 项）：")
        for g, e in missing:
            print(f"   {g:<10} .{e}")
    else:
        print("\n✅ 用户列举的所有类型都至少有一个预览引擎覆盖")

    return 0 if not missing else 2


if __name__ == "__main__":
    sys.exit(main())
