# -*- coding: utf-8 -*-
"""一次性结构变换：把链接管理面板从「模态弹窗」改成「WM 桌面窗口」。

用户报障（原话）：
    「链接管理窗口打开时，其他窗口要求是可以操作。改为和用户管理窗口一下。」

旧实现是 `Dialog.custom({ ... maskClose:false })`：
    · 它本质是一层 `.modal-mask`（z-index 9600）⇒ 压住所有窗口，
      开着它就没法操作别的窗口（这正是用户第 6 条报的）；
    · 面板自己还挂了一个 capture 阶段的 Esc 收尾。
用户管理窗口走 `WM.open({ chromeless:true })`，天然非模态。这里按同一模型重写。

保持 LF：二进制读写 + 显式 \n（见铁律 14）。
"""
import io

P = 'D:/Docker/NebulaDisk/nebula/web/js/links.js'
NL = '\n'
src = io.open(P, 'rb').read().decode('utf-8')
lines = src.split(NL)

o = lines.index('  function open() {')
m1 = lines.index('    dlg.el.innerHTML = `', o)
m2 = lines.index('    const root = dlg.el;', m1)
r = lines.index('  return { open, _state: state };', m2)
close = r - 1
while lines[close].strip() == '':
    close -= 1
assert lines[close] == '  }', repr(lines[close])

# 断言旧结构的每一处锚点（少一个就说明文件已被改过，立即停下）
assert lines[o + 1].strip().startswith("const dlg = Dialog.custom({ title: '链接管理'")
assert "const box = dlg.mask.querySelector('.dialog');" in lines[o + 3]
assert lines[o + 7].strip() == 'state.sel.clear();', lines[o + 7]
assert lines[m1 + 1].strip() == '<div class="lm">', lines[m1 + 1]
assert any("data-role=\"sweep\"" in l for l in lines[m2:close]), '找不到页脚 sweep'
print('open(): 第 %d 行 ~ 第 %d 行' % (o + 1, close + 1))

header = [
    '  function open() {',
    "    const WID = 'link-manager';",
    '',
    '    // ★ 2026-09-30 改版：从「模态遮罩弹窗」改为**桌面窗口** ★',
    '    //   用户报障原话：「链接管理窗口打开时，其他窗口要求是可以操作。',
    '    //   改为和用户管理窗口一下。」',
    '    //   旧实现 `Dialog.custom(...)` 的本质是一层 `.modal-mask`',
    '    //   （z-index 9600，见 shell.js）—— 它把整个桌面压在下面，',
    '    //   开着链接管理就没法操作任何其他窗口。',
    '    //   用户管理窗口走 `WM.open({ chromeless:true })`，非模态、可拖动、',
    '    //   可最小化、进任务栏。这里按同一模型重写。',
    '    //   ⚠️ 副产物：面板不再有自建的 Esc 收尾 —— 桌面窗口本来就不该被',
    '    //      Esc 关掉（用户管理窗口也如此）。面板内部弹出的二维码 /',
    '    //      编辑子弹窗**仍然是模态 Dialog**，它们的 Esc 由',
    '    //      `Dialog` 自己的捕获监听 + `escClose()` 兜底负责。',
    '    if (WM.get(WID)) { WM.restore(WID); WM.focus(WID); return; }',
    '',
    '    // 筛选条件刻意**保留**（用户下次打开还在同一种视图）；勾选态则清空 ——',
    '    // 隔一次打开还留着“已选 3 条”，下次点批量撤销就是误伤。',
    '    state.sel.clear();',
    '',
    '    WM.open({',
    '      id: WID,',
    "      title: '链接管理',",
    "      icon: Icons.ui('share', 16),",
    '      width: 1040, height: 680,',
    '      minWidth: 700, minHeight: 460,',
    '      chromeless: true,',
    '      render: (b) => openPanel(b),',
    '    });',
    '',
    '    /** 窗口内容构建（原 `dlg.el` / `dlg.foot` 的用法全部改到这里） */',
    '    function openPanel(body) {',
    '      // 原页脚的两个动作上提到窗口工具栏（页脚已随模态弹窗一起取消）',
    '      const bar = WM.Toolbar.build({',
    "        title: '链接管理',",
    "        left: [WM.Toolbar.btn('sweep', 'trash', '清理失效链接')],",
    "        right: [WM.Toolbar.btn('csv', 'download', '导出 CSV')],",
    '      });',
    '',
    '      body.innerHTML = `',
    '      <div class="win-col">',
    '        ${bar}',
]

middle = lines[m1 + 1:m2]
while middle and middle[-1].strip() == '':
    middle.pop()
# middle 末尾还挂着旧的 `dlg.foot.innerHTML = ...` 页脚块 —— 整块删掉
fi = next((i for i, l in enumerate(middle) if l.strip().startswith('dlg.foot.innerHTML')), -1)
assert fi > 0, '找不到 dlg.foot 页脚块'
fj = next(i for i in range(fi, len(middle)) if middle[i].rstrip().endswith('`;'))
assert 'data-role="close"' in ' '.join(middle[fi:fj + 1]), '页脚块范围不对'
removed = middle[fi:fj + 1]
del middle[fi:fj + 1]
while middle and middle[-1].strip() == '':
    middle.pop()
# 模板收尾：`</div>` 原本关 .lm，现在还要关 .win-col
assert middle[-1].strip() == '</div>`;', repr(middle[-1])
middle[-1] = '        </div>' + NL + '      </div>`;'
middle = [('  ' + l) if l.strip() else '' for l in middle]
print('删除旧页脚 %d 行: %s' % (len(removed), removed[0].strip()))

rest = lines[m2:close]
rest[0] = '    const root = body;'

# 砍掉整段页脚/Esc 绑定，换成工具栏绑定
# ⚠️ `renderAll();` 在这个区间里出现过**两次**，必须从 foot_a 之后开始找，
#    否则 foot_b < foot_a，切片 [.. foot_a] + [foot_b ..] 会把旧页脚又拼回来。
foot_a = next(i for i, l in enumerate(rest) if l.strip() == '/* ---- 事件：页脚 ---- */')
foot_b = next(i for i in range(foot_a, len(rest))
              if rest[i].strip().startswith('renderAll();'))
assert foot_b > foot_a
new_foot = [
    '    /* ---- 事件：工具栏 ---- */',
    '    // 面板现在是**桌面窗口**：动作按钮走工具栏的 [data-a]（见 WM.Toolbar.btn），',
    '    // 关闭交给 WM 自己的 ✕（Toolbar.build 默认带三键），',
    '    // 所以不再有「关闭」按钮，也没有自建的 Esc 收尾。',
    '    // ⚠️ 别把这里改回 `dlg.foot` —— 那会重新引入一层模态遮罩。',
    '    const closeAll = () => WM.close(WID);',
    '',
    "    const sweepBtn = root.querySelector('[data-a=\"sweep\"]');",
    '    if (sweepBtn) sweepBtn.onclick = async () => {',
    '      try {',
    '        const r = await API.linkRevokeDead();',
    "        Toast.ok('已清理', `删除了 ${r.revoked || 0} 条失效链接`);",
    '        await refresh();',
    "      } catch (e) { Toast.error('清理失败', e.message); }",
    '    };',
    '',
    "    const csvBtn = root.querySelector('[data-a=\"csv\"]');",
    "    if (csvBtn) csvBtn.onclick = () => exportCSV(visibleItems(), '链接清单');",
    '',
]
rest = rest[:foot_a] + new_foot + rest[foot_b:]
rest = [('  ' + l) if l.strip() else '' for l in rest]

out = lines[:o] + header + middle + rest + ['    }', '  }'] + lines[close + 1:]
dst = NL.join(out)

assert "Dialog.custom({ title: '链接管理'" not in dst, '旧的模态构造残留'
seg = out[o:out.index('  return { open, _state: state };')]
# 注释里提到 `dlg.el` 是用来解释历史的，允许；真正要拦的是还活着的代码引用
bad = [l for l in seg
       if 'dlg.' in l and not l.lstrip().startswith('//') and '（原' not in l and '别把' not in l]
assert not bad, bad
io.open(P, 'wb').write(dst.encode('utf-8'))
print('OK  新长度 %d 行（原 %d 行）' % (len(out), len(lines)))
