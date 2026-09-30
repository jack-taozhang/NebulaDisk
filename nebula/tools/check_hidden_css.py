# -*- coding: utf-8 -*-
"""check_hidden_css.py —— 静态闸门：页面引用的每个本地样式表，都必须钉死 `[hidden]`

★★ 为什么要有它（2026-09-30 实测事故）★★
  `[hidden] { display: none }` 只存在于 **UA 样式表**，
  而任何**作者样式**里的 `display:` 声明都会把它盖掉 ——
  作者样式 > UA 样式，**不看特异性**。分享落地页就栽在这：

      web/share.html   <div class="sh-viewer" id="sh-viewer" hidden>   ← 想默认不显示
      web/share.css    .sh-viewer { display: flex; ... }               ← 又把它显示出来

  后果：分享页一打开就被「预览浮层」盖住 —— 一整屏半透明黑 + 一块空白白板，
  什么都看不到；而且 `viewer.hidden = true/false` **完全失效**
  （属性变了、渲染不变，所以连"点关闭"都没用）。
  排查时很容易误判成"接口没返回 / JS 报错"（其实 DOM 渲染得好好的）
  ⇒ 这种「DOM 对、渲染错」的坑只能由静态层兜住。

判据（只读源码，严格且不依赖 JS 行为）：
  **每一个**被 web/ 下页面 `<link rel="stylesheet">` 引用的**本地** CSS，
  都必须含一条 `[hidden]` 规则且声明 `display: none`。

  ★ 为什么是"每一个"而不是"用了 hidden 属性的页面才算" ★
    JS 里 `el.hidden = true` 的目标元素，在 HTML 里往往**并不带** hidden 属性
    （例如链接管理面板搜索框的 `#qclear`）。按 HTML 属性筛会漏掉这类，
    而且"今天没用到"不代表"明天不会加一行 display:"。
    这条兜底只有一行、写在哪里都无害，所以直接对**所有**样式表要求，
    规则简单到不可能理解错，也不可能出现假红。

  ⚠️ 只扫本地样式表（`/static/...` 或同目录相对路径）；外链 CDN 会明确说明跳过。

用法：
  python tools/check_hidden_css.py                 # 扫 web/
  python tools/check_hidden_css.py --selftest      # 自检（临时夹具，断言恰好报出预期数量）
"""

from __future__ import annotations

import re
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
WEB = HERE.parent / "web"          # selftest 会临时替换它

RE_LINK = re.compile(
    r"""<link\b[^>]*\brel\s*=\s*["']?stylesheet["']?[^>]*>""", re.IGNORECASE)
RE_HREF = re.compile(r"""\bhref\s*=\s*["']([^"']+)["']""", re.IGNORECASE)
# 一条 [hidden] 规则：选择器里有 [hidden]，声明块里有 display: none
RE_HIDDEN_RULE = re.compile(
    r"\[hidden\][^{}]*\{[^{}]*display\s*:\s*none", re.IGNORECASE)
# 仅用于信息输出：页面里有没有用 hidden **属性**
RE_HIDDEN_ATTR = re.compile(r"\shidden(?=[\s>/])", re.IGNORECASE)


def css_path_from_href(href: str, html_path: Path, web_dir: Path) -> Path | None:
    """把 <link href> 变成磁盘路径。非本地（http/https//）返回 None。"""
    if "://" in href or href.startswith("//"):
        return None
    if href.startswith("/static/"):
        return web_dir / href[len("/static/"):]
    return (html_path.parent / href).resolve()


def scan(web_dir: Path):
    """返回 (问题列表, 检查过的页面数, 用了 hidden 属性的页面数)"""
    problems: list[str] = []
    n_html = n_hidden_attr = 0
    for html_path in sorted(web_dir.rglob("*.html")):
        try:
            html = html_path.read_text(encoding="utf-8")
        except OSError:
            continue
        links = RE_LINK.findall(html)
        if not links:
            continue
        n_html += 1
        if RE_HIDDEN_ATTR.search(html):
            n_hidden_attr += 1
        rel = html_path.relative_to(web_dir)
        for tag in links:
            m = RE_HREF.search(tag)
            if not m:
                problems.append(f"{rel}: <link rel=stylesheet> 没有 href：{tag[:80]}")
                continue
            href = m.group(1)
            css = css_path_from_href(href, html_path, web_dir)
            if css is None:
                print(f"  ⊘ {rel}: 外链样式表 {href} —— 无法静态检查，跳过")
                continue
            if not css.exists():
                problems.append(f"{rel}: 引用的样式表不存在：{href}")
                continue
            text = css.read_text(encoding="utf-8", errors="replace")
            if not RE_HIDDEN_RULE.search(text):
                try:
                    shown = css.relative_to(web_dir.parent)
                except ValueError:
                    shown = css
                problems.append(
                    f"{shown} 缺 `[hidden] {{ display: none }}` 规则"
                    f"（被 {rel} 引用）"
                )
    return problems, n_html, n_hidden_attr


def selftest() -> int:
    """★ 护栏自己没被验证过 = 没有护栏 ★"""
    with tempfile.TemporaryDirectory() as td:
        d = Path(td)
        # ⚠️ href 是 `/static/css/x.css` ⇒ 磁盘上必须落在 `<web>/css/x.css`
        #   （第一版把 css 直接写在根目录，被本自检当场抓出来 —— 这正是自检的价值）
        (d / "css").mkdir()
        # 坏例：css 里有 display:flex，却没有 [hidden] 兜底
        (d / "bad.html").write_text(
            '<link rel="stylesheet" href="/static/css/bad.css">'
            '<div class="v" hidden></div>', encoding="utf-8")
        (d / "css" / "bad.css").write_text(".v { display: flex; }", encoding="utf-8")
        # 正例：同样结构 + 一条 [hidden] 兜底
        (d / "good.html").write_text(
            '<link rel="stylesheet" href="/static/css/good.css">'
            '<div class="v" hidden></div>', encoding="utf-8")
        (d / "css" / "good.css").write_text(
            ".v { display: flex; }\n[hidden] { display: none !important; }",
            encoding="utf-8")
        # 没写 hidden 属性、但同样引用了缺兜底的 css ⇒ 严格规则下**也要报**
        #   （JS 里 el.hidden = true 的目标常常在 HTML 里没有 hidden 属性）
        (d / "js-toggled.html").write_text(
            '<link rel="stylesheet" href="/static/css/toast.css">'
            '<div class="t"></div>', encoding="utf-8")
        (d / "css" / "toast.css").write_text(
            ".t { position: fixed; display: flex; }", encoding="utf-8")

        global WEB
        old = WEB
        WEB = d
        try:
            probs, n_html, n_attr = scan(d)
        finally:
            WEB = old

        want = {"bad.css", "toast.css"}
        got = {p.split(" 缺 ")[0].split("\\")[-1].split("/")[-1] for p in probs}
        ok = True
        print(f"  自检：页面 {n_html} 个（应为 3）/ 其中带 hidden 属性 {n_attr} 个（应为 2）"
              f" / 报出问题 {len(probs)} 个（应为 2）")
        for p in probs:
            print("    ->", p)
        if n_html != 3:
            print(f"  ❌ 页面数应为 3，实得 {n_html}"); ok = False
        if len(probs) != 2 or got != want:
            print(f"  ❌ 期望恰好点名 {sorted(want)}，实得 {sorted(got)}"); ok = False
        print("  ✅ 自检通过" if ok else "  ❌ 自检失败")
        return 0 if ok else 1


def main() -> int:
    if "--selftest" in sys.argv:
        return selftest()

    web = WEB
    if not web.is_dir():
        print(f"❌ 找不到 {web}")
        return 2

    problems, n_html, n_attr = scan(web)
    print(f"  带样式表的页面：{n_html} 个（其中 {n_attr} 个用了 hidden 属性）")
    if problems:
        print(f"  ❌ 有 {len(problems)} 处问题：")
        for p in problems:
            print("     -", p)
        print("     修法：在该样式表顶部加一行 `[hidden] { display: none !important; }`")
        return 1
    if n_html == 0:
        print("  ⓘ web/ 下没有任何带样式表的页面 —— 闸门空转（不算失败，但要留意）")
    print("  ✅ 通过")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
