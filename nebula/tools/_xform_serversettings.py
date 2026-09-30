# -*- coding: utf-8 -*-
"""一次性结构变换：把 showServerSettings 从「模态弹窗」改成「WM 桌面窗口」。

为什么用脚本而不是手改：
    这个函数体有 ~740 行，要整体下沉一层（从函数体变成 WM.open 的 render
    回调调用者）。手工缩进极易漏行、错行，而 JS 又不会因为缩进错就报错 ——
    错误会以「某段代码跑到作用域外面」的形式在运行时才炸。
    所以这里用带断言的结构化变换：找不到预期文本就立刻 assert 失败，
    绝不静默产出半成品。

★ 换行符 ★
    必须保持 LF。用二进制读写 + 显式 \n，绝不用 write_text（Windows 上会按
    os.linesep 写成 \r\n，交付到 Linux 直接报废 —— 见记忆里的铁律 14）。
"""
import io
import sys

P = 'D:/Docker/NebulaDisk/nebula/web/js/app.js'
NL = '\n'

src = io.open(P, 'rb').read().decode('utf-8')
lines = src.split(NL)


def find(seq, start=0):
    for i in range(start, len(lines)):
        if lines[i] == seq:
            return i
    return -1


# ---------------------------------------------------------------- 定位
start = find('function showServerSettings() {')
assert start >= 0, '找不到 showServerSettings 定义'

h = [lines[start + k].strip() for k in range(1, 6)]
assert h[0].startswith("const dlg = Dialog.custom({ title: '服务器设置'"), h[0]
assert h[1] == 'const body = dlg.el;', h[1]
assert h[2].startswith('// 去掉对话框 body 默认 padding'), h[2]
assert h[3] == "body.style.padding = '0';", h[3]
assert h[4] == '', repr(h[4])

end = -1
for j in range(start + 1, len(lines)):
    if lines[j] == '}':
        end = j
        break
assert end > start, '找不到函数结尾'
assert lines[end - 1].strip() == 'load();', lines[end - 1]
print('函数范围: 第 %d 行 ~ 第 %d 行（共 %d 行）' % (start + 1, end + 1, end - start + 1))

# 已经不适用了：WM 窗口的 body 没有 .dialog 的默认 padding
content = lines[start + 5:end]          # 跳过 body.style.padding 那一行
while content and content[0].strip() == '':
    content.pop(0)

# ---------------------------------------------------------------- 下沉一层
indented = [('  ' + l) if l.strip() else '' for l in content]

# ---------------------------------------------------------------- 包上 win-col + 工具栏
inner = -1
for i, l in enumerate(indented):
    if l.strip() == 'body.innerHTML = `':
        inner = i
        break
assert inner >= 0, '找不到 body.innerHTML 模板起点'
assert indented[inner + 1].strip() == '<div class="settings-wrap">', indented[inner + 1]

indented[inner:inner + 2] = [
    '    // ★ WM 窗口的工具栏：左侧留空，右侧交给 WM 渲染窗口三键（— □ ×）★',
    '    //   这里**不能**再手写三键 —— 那正是「两层窗口按钮」的老毛病。',
    '    const bar = WM.Toolbar.build({ title: \'服务器设置\', left: [], right: [] });',
    '',
    '    body.innerHTML = `',
    '      <div class="win-col">',
    '        ${bar}',
    '        <div class="settings-wrap">',
]

# 模板末尾：第一行以 `; 结尾的
tpl_end = -1
for i in range(inner + 6, len(indented)):
    if indented[i].rstrip().endswith('`;'):
        tpl_end = i
        break
assert tpl_end > inner, '找不到模板收尾'
assert indented[tpl_end].strip() == '</div>`;', repr(indented[tpl_end])
# 原来那个 </div> 是关 .settings-wrap 的；现在多一层 .win-col 要收
indented[tpl_end:tpl_end + 1] = ['        </div>', '      </div>`;']

# ---------------------------------------------------------------- 取消按钮
CANCEL_OLD = ("body.querySelector('[data-role=\"cancel\"]')"
              ".addEventListener('click', () => dlg.close());")
hits = [i for i, l in enumerate(indented) if l.strip() == CANCEL_OLD]
assert len(hits) == 1, ('取消按钮绑定应恰好命中 1 处，实际 %d 处' % len(hits))
indented[hits[0]] = ("    body.querySelector('[data-role=\"cancel\"]')"
                     ".addEventListener('click', () => WM.close(WID));")

# ---------------------------------------------------------------- 组装
header = [
    'function showServerSettings() {',
    "  const WID = 'server-settings';",
    '',
    '  // ★ 2026-09-30 改版：从「模态遮罩弹窗」改为**桌面窗口** ★',
    '  //   用户报障原话：「目前服务器窗口，关于窗口 窗口界面打开，点击其他地方，',
    '  //   这个窗口会关闭。改为和用户管理窗口一下。」',
    '  //   旧实现是 `Dialog.custom(...)`（一层 `.modal-mask`），两个后果：',
    '  //     · 点遮罩就关 ⇒ 改设置的途中手一抖点到旁边，整页未保存的修改全没；',
    '  //     · 遮罩 z-index 9600 压住所有窗口 ⇒ 开着它就没法操作别的窗口。',
    '  //   用户管理窗口走的是 `WM.open({ chromeless:true })`，没有这两个问题；',
    '  //   这里按同一模型重写 ⇒ 可拖动 / 可最小化 / 可缩放 / 进任务栏，',
    '  //   并且点击别处不会消失。',
    '  if (WM.get(WID)) { WM.restore(WID); WM.focus(WID); return; }',
    '',
    '  WM.open({',
    '    id: WID,',
    "    title: '服务器设置',",
    "    icon: Icons.ui('settings', 16),",
    '    width: 940, height: 660,',
    '    minWidth: 640, minHeight: 440,',
    '    chromeless: true,',
    '    render: (b) => openBody(b),',
    '  });',
    '',
    '  /** 窗口内容构建（原 `dlg.el` 的函数体整体下沉到这里） */',
    '  function openBody(body) {',
]

tail = ['  }', '}']

out = lines[:start] + header + indented + tail + lines[end + 1:]
dst = NL.join(out)

assert 'Dialog.custom({ title: \'服务器设置\'' not in dst, '旧构造残留'
io.open(P, 'wb').write(dst.encode('utf-8'))
print('OK  新长度 %d 行（原 %d 行）' % (len(out), len(lines)))
