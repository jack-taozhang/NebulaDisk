/* ============================================================================
 * _tf_probe.js —— ★ 点「最顶上那条工具栏」也要能前置窗口（真浏览器验证）★
 *
 * 用户原文：
 *   「窗口点击聚焦显示所有窗口 最顶上的工具栏 （最小化，最大化，关闭这一行）
 *     目前没有涵盖在呢。 需要增加点击这个区域也能前置显示窗口。
 *     两种窗口都要修改。」
 *
 * 根因（与 _fs_probe 那条不同）：
 *   置顶原本只挂在 `el` 的 **mousedown** 捕获监听上；而 _bindDrag / _bindResize
 *   都在 **pointerdown** 里 `preventDefault()`，按 Pointer Events 规范这会
 *   抑制浏览器派生的 mousedown ⇒ 点工具栏/拖边框根本没有 mousedown ⇒ 不置顶。
 *   只有点内容区（不 preventDefault 的路径）才会置顶 —— 与用户观察一致。
 *
 * 被测对象：**两种窗口都要**
 *   · explorer  → 资源管理器窗口（explorer.js 手写工具栏）
 *   · iframe    → 预览窗口（WM.Toolbar.build，内容含 <iframe>）
 *   两者共用同一个 `.toolbar.win-toolbar[data-drag-handle]`，所以修复只有一处，
 *   但必须**分别验证**，否则「只好了其中一种」看不出来。
 *
 * 判据（对每一种窗口都跑一遍，全部为真才 PASS）：
 *   ① 工具栏「空白处」按下 → 该窗口 zIndex 变大且成为最顶层
 *   ② 工具栏「三键那一块（容器 div）」按下 → 同样前置
 *   ③ 内容区按下 → 同样前置（回归保护：这是原本就有的能力，不能修坏）
 *   ④ 缩放热区按下 → 同样前置（热区不在工具栏内，靠另一处 focus）
 *   ⑤ 每次按下后**不能**留下整屏拖拽遮罩（按下必须配一次抬起）
 * ========================================================================== */
(function () {
  var out = { cases: [], PASS: {} };

  function zOf(w) { return parseInt(w.el.style.zIndex || '0', 10); }
  function topId() {
    var t = null, tz = -Infinity;
    WM.list().forEach(function (w) {
      if (w.minimized) return;
      var z = zOf(w);
      if (z >= tz) { tz = z; t = w; }
    });
    return t ? t.id : null;
  }
  function vis() { return WM.list().filter(function (w) { return !w.minimized; }); }
  function byId(id) {
    var r = null;
    WM.list().forEach(function (w) { if (w.id === id) r = w; });
    return r;
  }
  /** 命中点归属哪个窗口（工具栏本身没有 data-win-id，只能靠 .window 祖先） */
  function ownerWinOf(node) {
    var n = node;
    while (n && n !== document) {
      if (n.classList && n.classList.contains('window')) return n;
      n = n.parentNode;
    }
    return null;
  }
  function dragShieldOn() {
    var s = document.body.querySelector('.wm-drag-shield');
    return !!(s && s.classList.contains('on'));
  }

  /** 用**产品自己的**方式把某个窗口抬起来（点它内容区的非按钮处） */
  function raise(w) {
    var body = w.el.querySelector('.win-body') || w.el;
    var r = body.getBoundingClientRect();
    fire(body, 'mousedown', Math.round(r.left + r.width / 2), Math.round(r.top + 20));
  }
  function lower(w) {
    var o = vis().filter(function (x) { return x.id !== w.id; })[0];
    if (!o) return false;
    raise(o);
    return true;
  }
  function fire(node, type, x, y) {
    var isPtr = type.indexOf('pointer') === 0;
    var Ctor = isPtr
      ? (window.PointerEvent || window.MouseEvent)
      : window.MouseEvent;
    var ev = new Ctor(type, {
      bubbles: true, cancelable: true, composed: true,
      clientX: x, clientY: y, button: 0,
      buttons: type === 'pointerup' || type === 'mouseup' ? 0 : 1,
      pointerId: 1, pointerType: 'mouse', isPrimary: true,
    });
    node.dispatchEvent(ev);
  }
  /** 完整鼠标序列（按下→抬起），避免把整屏遮罩留在屏上 */
  function pressRelease(node, x, y) {
    fire(node, 'pointerdown', x, y);
    fire(node, 'pointerup', x, y);
    fire(node, 'mousedown', x, y);
    fire(node, 'mouseup', x, y);
  }

  /** 找「工具栏空白处」的按下目标。
   *
   *  ★ 为什么要分两级 ★
   *   两个窗口默认开在同一位置、几乎完全重叠，被测窗口的工具栏往往**被另一个
   *   窗口盖住**。此时用 elementFromPoint 做「物理可点 + 归本窗口」的门禁会
   *   一个点都找不到（第一版就是这样：toolbar-blank 全部 err）。
   *   而本用例要验证的是**事件机制**（工具栏上的 pointerdown 会不会置顶），
   *   不是布局遮挡 —— 所以：
   *     ① 先几何扫描，找到「物理可点、归本窗口、且不是按钮」的点就用它
   *        （这也是最贴近真实点击的路径）
   *     ② 找不到就退化为直接派发到 `.tb-spacer`（产品专门留的空白拖拽区，
   *        占位 flex:1，就是用户会点的"工具栏空白处"）
   *   扫描结果作为 trace 一并输出，便于判断「到底是被谁盖住了」。
   */
  function toolbarBlankTarget(bar, winEl) {
    var trace = [];
    var r = bar.getBoundingClientRect();
    if (r.width >= 40 && r.height >= 8) {
      var cols = 24;
      for (var i = 1; i < cols; i++) {
        var x = Math.round(r.left + r.width * i / cols);
        var y = Math.round(r.top + r.height / 2);
        var pt = document.elementFromPoint(x, y);
        var own = pt ? ownerWinOf(pt) : null;
        var isBtn = !!(pt && pt.closest && pt.closest(
          'button, input, textarea, select, a, [contenteditable], [data-no-drag]'));
        if (trace.length < 6) {
          trace.push({
            x: x, y: y,
            hit: pt ? pt.tagName : null,
            hitCls: pt && typeof pt.className === 'string' ? pt.className.slice(0, 20) : null,
            ownIsTarget: own === winEl,
            isBtn: isBtn,
          });
        }
        if (pt && own === winEl && !isBtn) {
          return { x: x, y: y, node: pt, via: 'geometry', trace: trace };
        }
      }
    }
    var sp = bar.querySelector('.tb-spacer');
    if (sp) {
      var sr = sp.getBoundingClientRect();
      return {
        x: Math.round(sr.left + sr.width / 2),
        y: Math.round(sr.top + sr.height / 2),
        node: sp, via: 'tb-spacer', trace: trace,
      };
    }
    return { err: 'no blank point', trace: trace };
  }

  /* ---------- 选两种窗口各一个 ---------- */
  var all = vis();
  var exWin = all.filter(function (w) { return /^explorer:/.test(w.id); })[0];
  var ifrWin = all.filter(function (w) { return w.el.querySelectorAll('iframe').length > 0; })[0];

  out.windows = all.map(function (w) {
    return {
      id: w.id, z: zOf(w),
      iframes: w.el.querySelectorAll('iframe').length,
      hasToolbar: !!(w.el.querySelector('.toolbar.win-toolbar')),
      hasHandle: !!(w.el.querySelector('[data-resize="e"]')),
    };
  });
  out.hasExplorer = !!exWin;
  out.hasIframe = !!ifrWin;

  var targets = [];
  if (exWin) targets.push({ kind: 'explorer', w: exWin });
  if (ifrWin && (!exWin || ifrWin.id !== exWin.id)) targets.push({ kind: 'iframe', w: ifrWin });
  if (!targets.length) {
    out.err = 'no usable window';
    return JSON.stringify(out);
  }

  function record(kind, what, w, before, after, extra) {
    var c = {
      kind: kind, what: what, id: w.id,
      zBefore: before.z, zAfter: after.z,
      wasTop: before.top === w.id,
      isTopNow: after.top === w.id,
      raised: after.z > before.z,
      shieldLeftOn: dragShieldOn(),
    };
    if (extra) Object.keys(extra).forEach(function (k) { c[k] = extra[k]; });
    out.cases.push(c);
    return c;
  }

  targets.forEach(function (t) {
    var w = t.w, kind = t.kind;
    if (!lower(w)) return;                      // 先把它压到下层
    var bar = w.el.querySelector('.toolbar.win-toolbar') || w.el.querySelector('[data-role="titlebar"]');

    /* ① 工具栏空白处 */
    if (bar) {
      var bp = toolbarBlankTarget(bar, w.el);
      if (bp.err) {
        out.cases.push({ kind: kind, what: 'toolbar-blank', err: bp.err, trace: bp.trace });
      } else {
        var before = { z: zOf(w), top: topId() };
        pressRelease(bp.node, bp.x, bp.y);
        record(kind, 'toolbar-blank', w, before, { z: zOf(w), top: topId() },
          { x: bp.x, y: bp.y, via: bp.via, trace: bp.trace });
      }
    }

    /* ② 三键那一块（容器 div，不是某个按钮） */
    lower(w);
    var ctl = w.el.querySelector('.wt-right .win-controls') || w.el.querySelector('.win-controls') || w.el.querySelector('.tb-controls');
    if (ctl) {
      var r2 = ctl.getBoundingClientRect();
      var before2 = { z: zOf(w), top: topId() };
      pressRelease(ctl, Math.round(r2.left + 2), Math.round(r2.top + r2.height / 2));
      record(kind, 'window-controls-block', w, before2, { z: zOf(w), top: topId() });
    }

    /* ②b 真正的三键按钮本身
     *   只派发 pointerdown/up + mousedown/up，**不派发 click**
     *   ⇒ 不会真的最小化/最大化/关闭，但足以验证「按下就前置」这条。
     *   （用 max 键：它没有 pointerdown 侧的副作用。） */
    lower(w);
    var maxBtn = w.el.querySelector('.tb-btn[data-act="max"]');
    if (maxBtn) {
      var r2b = maxBtn.getBoundingClientRect();
      var before2b = { z: zOf(w), top: topId() };
      pressRelease(maxBtn, Math.round(r2b.left + r2b.width / 2), Math.round(r2b.top + r2b.height / 2));
      record(kind, 'real-window-button', w, before2b, { z: zOf(w), top: topId() });
    }

    /* ③ 内容区（回归：原本就能前置） */
    lower(w);
    var body = w.el.querySelector('.win-body');
    if (body) {
      var rb = body.getBoundingClientRect();
      var before3 = { z: zOf(w), top: topId() };
      pressRelease(body, Math.round(rb.left + rb.width / 2), Math.round(rb.top + 12));
      record(kind, 'content-body', w, before3, { z: zOf(w), top: topId() });
    }

    /* ④ 缩放热区（不在工具栏内，靠另一处 focus） */
    var h = w.el.querySelector('[data-resize="e"]');
    if (h) {
      lower(w);
      var rh = h.getBoundingClientRect();
      var before4 = { z: zOf(w), top: topId() };
      pressRelease(h, Math.round(rh.left + rh.width / 2), Math.round(rh.top + rh.height / 2));
      record(kind, 'resize-handle-e', w, before4, { z: zOf(w), top: topId() });
    }
  });

  /* ---------- 汇总判据 ---------- */
  function okFor(what, kind) {
    var cs = out.cases.filter(function (c) { return c.what === what && (!kind || c.kind === kind); });
    return cs.length > 0 && cs.every(function (c) { return c.raised && c.isTopNow && !c.shieldLeftOn; });
  }
  out.counts = {
    toolbarBlank: out.cases.filter(function (c) { return c.what === 'toolbar-blank'; }).length,
    controls: out.cases.filter(function (c) { return c.what === 'window-controls-block'; }).length,
    realButton: out.cases.filter(function (c) { return c.what === 'real-window-button'; }).length,
    body: out.cases.filter(function (c) { return c.what === 'content-body'; }).length,
    handle: out.cases.filter(function (c) { return c.what === 'resize-handle-e'; }).length,
  };
  // 自检：必须真的测到了两种窗口的工具栏
  out.probeBroken = !(out.counts.toolbarBlank >= 1 && out.hasExplorer && out.hasIframe);
  // 诊断：工具栏空白处分别走的哪条路（geometry=物理可点归本窗口 / tb-spacer=退化）
  out.blankVias = out.cases.filter(function (c) {
    return c.what === 'toolbar-blank' && c.via;
  }).map(function (c) { return c.kind + ':' + c.via; });
  out.PASS = {
    hasTwoKinds: out.hasExplorer && out.hasIframe,
    toolbarBlankRaisesExplorer: okFor('toolbar-blank', 'explorer'),
    toolbarBlankRaisesIframe: okFor('toolbar-blank', 'iframe'),
    controlsBlockRaises: okFor('window-controls-block'),
    realButtonRaises: okFor('real-window-button'),
    contentBodyStillRaises: okFor('content-body'),
    resizeHandleRaises: okFor('resize-handle-e'),
    noShieldLeft: out.cases.every(function (c) { return !c.shieldLeftOn; }),
  };
  return JSON.stringify(out);
})();
