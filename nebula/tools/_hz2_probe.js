/* =============================================================================
   _hz2_probe.js —— 热区**相对窗口边缘**的精确定位（回答"应该调到边缘附近"）

   用户原文：「感应范围应该调整到窗口的边缘左右附近」

   要先搞清楚一个事实：热区到底贴在**哪条线**上？
     · 窗口 el 的 border-box 右沿 = el.getBoundingClientRect().right
     · e 热区是 `right:0; width:EDGE` → 它的 rect.right 应等于 el.right
     · 于是热区占据 [el.right - EDGE, el.right]，**完全在窗口内沿**

   如果产品是对的，那用户"感觉不在边缘"的原因可能是：
     a) 窗口有 1px 边框 / 圆角，视觉边缘比 border-box 略微内缩；
     b) 预览/编辑窗口被 iframe 铺满，iframe 内容自己也有视觉边距，
        用户把"内容边界"当成"窗口边缘"；
     c) 热区真的偏移了（本次要排除的）。

   本探针把三件事量清楚，用数据回答，不猜：
     1. 窗口 rect 与 8 个热区 rect 的**逐边重合度**（差几个像素）
     2. 热区是否**超出**窗口边界（超出会盖住相邻窗口 / 任务栏）
     3. 沿右缘垂直扫描：从 el.right 往里，命中 e 手柄的连续深度
        （这一条要选一个**没有被遮挡**的窗口来量，故本探针会先把
          目标窗口置顶，再量）

   ★ 置顶方法：直接点窗口标题栏（触发 shell 的 focus），
     而不是靠 elementFromPoint 硬找 —— 后者依赖当前叠放，不可控。
   ============================================================================= */
(function () {
  var out = { ready: false };
  try {
    var wins = Array.prototype.slice.call(document.querySelectorAll('.window'));
    var W = null;
    for (var i = 0; i < wins.length; i++) {
      var w = wins[i];
      if (w.classList.contains('minimized') || w.classList.contains('maximized')) continue;
      var r = w.getBoundingClientRect();
      if (r.width < 300 || r.height < 250) continue;
      W = w; break;
    }
    if (!W) { out.err = 'no usable window'; return JSON.stringify(out); }

    // ★ 先置顶：往标题栏派发完整的按下序列，让 shell 把本窗口提到最上层
    var bar = W.querySelector('.toolbar.win-toolbar') || W.querySelector('[data-role="titlebar"]');
    if (bar) {
      var br = bar.getBoundingClientRect();
      var cx = Math.round(br.left + br.width / 2);
      var cy = Math.round(br.top + br.height / 2);
      ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(function (t) {
        if (t === 'click') return;   // 工具栏空白点击无副作用，派发前三步已足够触发 focus
        bar.dispatchEvent(new (t.indexOf('pointer') === 0 ? PointerEvent : MouseEvent)(t, {
          bubbles: true, cancelable: true, button: 0, pointerId: 1, clientX: cx, clientY: cy,
        }));
      });
      out.raisedBy = 'titlebar';
    }
    // 兜底：如果 shell 暴露了 focus，直接调（不同版本可能没有）
    if (window.NebulaShell && typeof window.NebulaShell.focus === 'function' && W.id) {
      try { window.NebulaShell.focus(W.id); out.raisedBy = 'NebulaShell.focus'; } catch (e) {}
    }

    var R = W.getBoundingClientRect();
    out.winRect = { l: +R.left.toFixed(1), t: +R.top.toFixed(1),
                    r: +R.right.toFixed(1), b: +R.bottom.toFixed(1),
                    w: +R.width.toFixed(1), h: +R.height.toFixed(1) };

    var cs = getComputedStyle(W);
    out.winBorder = { left: cs.borderLeftWidth, right: cs.borderRightWidth,
                      top: cs.borderTopWidth, bottom: cs.borderBottomWidth,
                      radius: cs.borderTopLeftRadius };

    // 工具栏实际高度。ne 角为了让出右上角三个窗口键，其上沿被下移到工具栏下沿，
    // 所以 ne.top 的合理上限就是「工具栏高」——把这个值一起报出去，
    // runner 就不必写死常量（旧版 runner 引用了未定义的 NE_ALLOW 直接崩）。
    var tbEl = W.querySelector('.toolbar.win-toolbar');
    out.toolbarH = tbEl ? +tbEl.getBoundingClientRect().height.toFixed(1) : null;

    function rectOf(d) {
      var el = W.querySelector('[data-resize="' + d + '"]');
      if (!el) return null;
      var r = el.getBoundingClientRect();
      return { l: +r.left.toFixed(1), t: +r.top.toFixed(1),
               r: +r.right.toFixed(1), b: +r.bottom.toFixed(1),
               w: +r.width.toFixed(1), h: +r.height.toFixed(1) };
    }
    var dirs = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];
    var rects = {};
    dirs.forEach(function (d) { rects[d] = rectOf(d); });
    out.rects = rects;

    /* ---- 1. 逐边外沿差值：热区外沿 vs 窗口外沿 ----
     * Request D 起热区**跨边框**（向外突出 OUT px），所以这里不再是「≈0」，
     * 而是「= ±OUT 量级」。正=热区外沿在窗口外沿之外（靠右/靠下），
     * 负=在外沿之外（靠左/靠上）。 */
    out.gap = {
      // e 热区右沿 应贴 窗口右沿；n 热区上沿 应贴 窗口上沿……
      e_right:  rects.e  ? +(rects.e.r  - R.right).toFixed(1) : null,
      w_left:   rects.w  ? +(rects.w.l  - R.left ).toFixed(1) : null,
      n_top:    rects.n  ? +(rects.n.t  - R.top  ).toFixed(1) : null,
      s_bottom: rects.s  ? +(rects.s.b  - R.bottom).toFixed(1) : null,
      ne_right: rects.ne ? +(rects.ne.r - R.right).toFixed(1) : null,
      ne_top:   rects.ne ? +(rects.ne.t - R.top  ).toFixed(1) : null,
      sw_left:  rects.sw ? +(rects.sw.l - R.left ).toFixed(1) : null,
      sw_bottom:rects.sw ? +(rects.sw.b - R.bottom).toFixed(1) : null,
    };

    /* ---- 2. 越界方向清单 ----
     * ★ 这里的语义在 Request D 之后变了 ★
     *   旧：越界 = bug（热区跑到窗口外会盖住相邻窗口）
     *   新：越界 = **设计意图**（热区故意向外跨边框）。
     *   但仍然要报出来，因为「从哪一条边、往哪个方向越」是有明确契约的：
     *   只允许在朝外的那一侧越，不允许往窗口里侧/相邻方向乱越。
     *   runner 会拿这份清单跟白名单比对。 */
    var over = [];
    dirs.forEach(function (d) {
      var q = rects[d]; if (!q) return;
      if (q.l < R.left - 1)   over.push(d + '.left');
      if (q.r > R.right + 1)  over.push(d + '.right');
      if (q.t < R.top - 1)    over.push(d + '.top');
      if (q.b > R.bottom + 1) over.push(d + '.bottom');
    });
    out.overflow = over;

    /* ---- 3. 沿右缘垂直扫描：命中 e 手柄的连续深度 ---- */
    function dirAt(x, y) {
      var el = document.elementFromPoint(x, y);
      var cur = el;
      while (cur && cur !== document.body) {
        if (cur.dataset && cur.dataset.resize) return cur.dataset.resize;
        cur = cur.parentElement;
      }
      return '';
    }
    var midY = Math.round(R.top + R.height / 2);
    // 从窗口右沿内侧 0 像素开始往里扫
    var depth = 0, hits = [];
    for (var d2 = 0; d2 <= 16; d2++) {
      var x = Math.round(R.right) - 1 - d2;
      if (x <= R.left) break;
      var hit = dirAt(x, midY);
      hits.push(hit);
      if (hit === 'e') depth = d2 + 1; else if (d2 > 0) break;
    }
    out.eastScanDepth = depth;
    out.eastScanHits = hits.join(',');
    out.topmostAtEdge = dirAt(Math.round(R.right) - 2, midY);

    out.ready = true;
  } catch (e) {
    out.err = String(e && e.message ? e.message : e);
  }
  return JSON.stringify(out);
})();
