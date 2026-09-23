#!/usr/bin/env python3
"""check_undefined.py —— 静态检查「用了但没定义的名字」（pyflakes 的最小可用替身）

=============================================================================
为什么需要它
=============================================================================
2026-09-21 把 `app/main.py`（1445 行）拆成 `app/routers/` 包之后，
`make_raw_url` 留在了 `routers/rawlink.py`，而 `onlyoffice.py` / `preview.py` /
`cad.py` 都直接调用它、却没 import。

后果：**三条预览链路全部 500**
    · OnlyOffice  →「无法打开编辑器 Internal Server Error」
    · kkFileView  → 预览接口 500
    · CAD 查看器  → 预览接口 500
而且：`run_unit_tests.sh`（8 套 JS）全绿、`selfcheck.py` 报「全部自检通过」、
`python -c "import app.main"` 也能过 —— 因为
    · 单测只覆盖前端 JS；
    · selfcheck 只校验**路由是否存在**（`include_router` 会把 handler 原样挂上，
      名字解析要到**调用时**才发生）；
    · 导入模块不执行函数体。
⇒ 全绿 + 全坏。这类"只在调用路径上炸"的错误必须靠**静态名字解析**兜住。

=============================================================================
判据
=============================================================================
对 `app/` 下每个 .py：
  1. 收集模块级绑定（import / def / class / 赋值 / for / with / except / global）
  2. 逐作用域走 AST；每个 Name(Load) 依次在
        当前函数的局部绑定 → 外层函数 → 模块级 → 内置
     里找；都找不到就报一条。
  3. `from x import *` 的文件无法静态判定 → 跳过并明确提示（不假装通过）。

已知会漏的（可接受，别的工具兜）：
  · `getattr` / `globals()` 动态取名字
  · 属性名（`obj.foo` 里的 foo）—— 那是运行期才定的事
=============================================================================
"""

from __future__ import annotations

import ast
import builtins
import sys
from pathlib import Path

BUILTINS = set(dir(builtins)) | {
    "__file__", "__name__", "__doc__", "__package__", "__spec__",
    "__loader__", "__builtins__", "__debug__", "WindowsError",
}


class Scope:
    __slots__ = ("kind", "parent", "names")

    def __init__(self, kind: str, parent: "Scope | None"):
        self.kind = kind          # module | function | class | comprehension
        self.parent = parent
        self.names: set[str] = set()


def lexical_parent(scope: Scope) -> Scope:
    """函数的词法父作用域要**跳过 class**：方法体内看不见类体里的名字。"""
    s = scope
    while s is not None and s.kind == "class":
        s = s.parent
    return s if s is not None else scope


def collect_target(t, names: set[str]) -> None:
    """把赋值/for/with 的目标里出现的名字登记为「已绑定」。"""
    if t is None:
        return
    if isinstance(t, ast.Name):
        names.add(t.id)
    elif isinstance(t, (ast.Tuple, ast.List)):
        for e in t.elts:
            collect_target(e, names)
    elif isinstance(t, ast.Starred):
        collect_target(t.value, names)
    # Attribute / Subscript 不绑定新名字


def collect_bindings(stmts, names: set[str]) -> None:
    """收集这一层语句引入的名字。

    只下钻「控制流块」，**不进** FunctionDef/AsyncFunctionDef/ClassDef 的函数体
    —— 那些属于子作用域（但它们的**名字**本身是在本层绑定的）。
    """
    for s in stmts:
        if isinstance(s, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            names.add(s.name)
        elif isinstance(s, ast.Import):
            for a in s.names:
                names.add(a.asname or a.name.split(".")[0])
        elif isinstance(s, ast.ImportFrom):
            for a in s.names:
                names.add(a.asname or a.name)      # a.name == '*' 时登记 '*'
        elif isinstance(s, ast.Assign):
            for tg in s.targets:
                collect_target(tg, names)
        elif isinstance(s, (ast.AugAssign, ast.AnnAssign)):
            collect_target(s.target, names)
        elif isinstance(s, (ast.For, ast.AsyncFor)):
            collect_target(s.target, names)
            collect_bindings(s.body, names)
            collect_bindings(s.orelse, names)
        elif isinstance(s, (ast.With, ast.AsyncWith)):
            for it in s.items:
                if it.optional_vars is not None:
                    collect_target(it.optional_vars, names)
            collect_bindings(s.body, names)
        elif isinstance(s, ast.Try) or type(s).__name__ == "TryStar":
            collect_bindings(s.body, names)
            for h in s.handlers:
                if h.name:
                    names.add(h.name)
                collect_bindings(h.body, names)
            collect_bindings(s.orelse, names)
            collect_bindings(s.finalbody, names)
        elif isinstance(s, (ast.If, ast.While)):
            collect_bindings(s.body, names)
            collect_bindings(s.orelse, names)
        elif type(s).__name__ == "Match":
            for c in s.cases:
                _collect_pattern(c.pattern, names)
                collect_bindings(c.body, names)
        elif isinstance(s, (ast.Global, ast.Nonlocal)):
            # 声明本身不绑定，但说明这些名字在本函数被当作外层名使用
            pass


def _collect_pattern(p, names: set[str]) -> None:
    if p is None:
        return
    if isinstance(p, ast.MatchAs):
        if p.name:
            names.add(p.name)
        _collect_pattern(p.pattern, names)
    elif isinstance(p, ast.MatchStar):
        if p.name:
            names.add(p.name)
    elif isinstance(p, ast.MatchMapping):
        if p.rest:
            names.add(p.rest)
        for sp in p.patterns:
            _collect_pattern(sp, names)
    elif isinstance(p, ast.MatchSequence):
        for sp in p.patterns:
            _collect_pattern(sp, names)
    elif isinstance(p, ast.MatchClass):
        for sp in p.patterns:
            _collect_pattern(sp, names)
        for sp in p.kwd_patterns:
            _collect_pattern(sp, names)
    elif isinstance(p, ast.MatchOr):
        for sp in p.patterns:
            _collect_pattern(sp, names)


def bind_args(args: ast.arguments, names: set[str]) -> None:
    for a in (list(args.posonlyargs) + list(args.args) + list(args.kwonlyargs)):
        names.add(a.arg)
    if args.vararg:
        names.add(args.vararg.arg)
    if args.kwarg:
        names.add(args.kwarg.arg)


class Checker:
    def __init__(self, path: Path, tree: ast.Module):
        self.path = path
        self.tree = tree
        self.problems: list[tuple[int, str]] = []
        self.module = Scope("module", None)
        self.has_star_import = False

    # ---------------- 名字解析 ----------------
    def resolve(self, name: str, scope: Scope) -> bool:
        s: Scope | None = scope
        while s is not None:
            if name in s.names:
                return True
            if s.kind == "class" and s.parent is not None:
                # 类体内的代码能看见类体名字；但方法体看不见 —— 由调用方保证
                pass
            s = s.parent
        return name in BUILTINS

    # ---------------- 语句 ----------------
    def stmts(self, body, scope: Scope) -> None:
        collect_bindings(body, scope.names)
        for s in body:
            self.stmt(s, scope)

    def stmt(self, s, scope: Scope) -> None:
        if isinstance(s, (ast.FunctionDef, ast.AsyncFunctionDef)):
            # 装饰器 / 默认值 / 注解 在外层作用域求值
            for d in s.decorator_list:
                self.expr(d, scope)
            for d in list(s.args.defaults) + [x for x in s.args.kw_defaults if x]:
                self.expr(d, scope)
            for a in (list(s.args.posonlyargs) + list(s.args.args)
                      + list(s.args.kwonlyargs) + [x for x in (s.args.vararg, s.args.kwarg) if x]):
                if a.annotation is not None:
                    self.expr(a.annotation, scope)
            if s.returns is not None:
                self.expr(s.returns, scope)
            inner = Scope("function", lexical_parent(scope))
            bind_args(s.args, inner.names)
            self.stmts(s.body, inner)
            return

        if isinstance(s, ast.ClassDef):
            for d in s.decorator_list:
                self.expr(d, scope)
            for b in s.bases:
                self.expr(b, scope)
            for k in s.keywords:
                self.expr(k.value, scope)
            inner = Scope("class", scope)
            self.stmts(s.body, inner)
            return

        if isinstance(s, ast.Lambda):
            self.expr(s, scope)
            return

        if isinstance(s, (ast.If, ast.While, ast.For, ast.AsyncFor, ast.With, ast.AsyncWith)):
            if isinstance(s, ast.If):
                self.expr(s.test, scope)
            elif isinstance(s, ast.While):
                self.expr(s.test, scope)
            elif isinstance(s, (ast.For, ast.AsyncFor)):
                self.expr(s.iter, scope)
            else:
                for it in s.items:
                    self.expr(it.context_expr, scope)
            for sub in ast.iter_child_nodes(s):
                if isinstance(sub, ast.expr):
                    self.expr(sub, scope)
            for b in getattr(s, "body", []):
                self.stmt(b, scope)
            for b in getattr(s, "orelse", []):
                self.stmt(b, scope)
            return

        if isinstance(s, ast.Try) or type(s).__name__ == "TryStar":
            for sub in ast.iter_child_nodes(s):
                if isinstance(sub, ast.expr):
                    self.expr(sub, scope)
            for b in list(s.body) + list(s.orelse) + list(s.finalbody):
                self.stmt(b, scope)
            for h in s.handlers:
                if h.type is not None:
                    self.expr(h.type, scope)
                for b in h.body:
                    self.stmt(b, scope)
            return

        if type(s).__name__ == "Match":
            self.expr(s.subject, scope)
            for c in s.cases:
                if c.guard is not None:
                    self.expr(c.guard, scope)
                for b in c.body:
                    self.stmt(b, scope)
            return

        # 其余语句：把所有子表达式当 Load 走一遍
        for sub in ast.iter_child_nodes(s):
            if isinstance(sub, ast.expr):
                self.expr(sub, scope)
            else:
                # 罕见：语句嵌在语句里（如 ast.If 已处理）。保守起见继续递归
                if isinstance(sub, ast.stmt):
                    self.stmt(sub, scope)

    # ---------------- 表达式 ----------------
    def expr(self, e, scope: Scope) -> None:
        if e is None:
            return
        if isinstance(e, ast.Name):
            if isinstance(e.ctx, ast.Load) and not self.resolve(e.id, scope):
                self.problems.append((e.lineno, e.id))
            return

        if isinstance(e, ast.Lambda):
            for d in list(e.args.defaults) + [x for x in e.args.kw_defaults if x]:
                self.expr(d, scope)
            inner = Scope("function", lexical_parent(scope))
            bind_args(e.args, inner.names)
            self.expr(e.body, inner)
            return

        if isinstance(e, (ast.ListComp, ast.SetComp, ast.GeneratorExp, ast.DictComp)):
            inner = Scope("comprehension", scope)
            # 第一个 for 的 iter 在外层作用域求值；其余在推导式作用域
            for i, g in enumerate(e.generators):
                self.expr(g.iter, scope if i == 0 else inner)
                collect_target(g.target, inner.names)
                for c in g.ifs:
                    self.expr(c, inner)
            if isinstance(e, ast.DictComp):
                self.expr(e.key, inner)
                self.expr(e.value, inner)
            else:
                self.expr(e.elt, inner)
            return

        if isinstance(e, ast.NamedExpr):      # (x := ...) 绑定到最近的函数/模块作用域
            self.expr(e.value, scope)
            owner = scope
            while owner is not None and owner.kind == "comprehension":
                owner = owner.parent
            collect_target(e.target, (owner or scope).names)
            return

        for sub in ast.iter_child_nodes(e):
            if isinstance(sub, ast.expr):
                self.expr(sub, scope)

    def run(self) -> None:
        # 星号导入无法静态判定
        for n in ast.walk(self.tree):
            if isinstance(n, ast.ImportFrom) and any(a.name == "*" for a in n.names):
                self.has_star_import = True
        self.stmts(self.tree.body, self.module)


def main(argv: list[str]) -> int:
    roots = [Path(a) for a in argv[1:]] or [Path("nebula/app")]
    files: list[Path] = []
    for r in roots:
        files.extend(sorted(r.rglob("*.py")) if r.is_dir() else [r])
    files = [f for f in files if "__pycache__" not in f.parts]

    total = 0
    skipped = 0
    for f in files:
        try:
            tree = ast.parse(f.read_text(encoding="utf-8"), filename=str(f))
        except SyntaxError as exc:
            print(f"  ✗ 语法错误 {f}:{exc.lineno}: {exc.msg}")
            total += 1
            continue
        ck = Checker(f, tree)
        ck.run()
        if ck.has_star_import:
            print(f"  ~ 跳过（含 `import *`，无法静态判定）：{f}")
            skipped += 1
            continue
        seen = set()
        for line, name in sorted(ck.problems):
            if (line, name) in seen:
                continue
            seen.add((line, name))
            print(f"  ✗ {f}:{line}: 名字 `{name}` 静态不可解析（漏 import / 拼错）")
            total += 1

    print()
    if total == 0:
        print(f"✅ 名字解析检查通过（{len(files) - skipped} 个文件，"
              f"跳过 {skipped} 个）")
        return 0
    print(f"❌ 发现 {total} 处未定义名（{len(files) - skipped} 个文件，跳过 {skipped} 个）")
    return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
