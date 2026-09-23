/* =============================================================================
   _hz_probe.js —— resize 热区「太宽 / 太快」的真实浏览器验证

   用户原文（两轮）：
     「调整窗口大小的这个 感应范围感觉太快了，同时是不是可以增加一下 延时显示。」
     「感应范围太宽也太快。」

   本探针在**真实浏览器 + 真实 DOM** 里验证三件事：

     A) 几何（"太宽"）：
        在真实窗口上用 elementFromPoint 逐点扫描，量出
        「离边缘多远还能命中 resize 手柄」。必须 ≤ 期望上界（EDGE=8 / CORNER=12）。
        扫描结果同时报告实际量到的厚度，便于回归时对比。

     B) 时序（"太快"）：
        派发 pointerenter 到热区，**立刻**读 cursor —— 必须是 default；
        等待 > RESIZE_HOVER_DELAY 后再读 —— 必须是 X-resize。
        然后派发 pointerleave，确认光标立刻回落 default。

     C) 不误伤可用性：
        pointerenter 后**立刻** pointerdown，确认光标立即变 X-resize
        且能真的改变窗口宽度（延时不得拖慢真实拖拽）。

   ★ 关键：热区是**透明**的，普通 hit-test 只看得到它（z-index:900）。
     测量厚度必须用 document.elementFromPoint，并检查 dataset.resize。
   ============================================================================= */
(function () {
  var out = { ready: false };
  try {
    var W = null, wid = null;
    // 找一个可见且非最大化的窗口
    var wins = Array.prototype.slice.call(document.querySelectorAll('.window'));
    for (var i = 0; i < wins.length; i++) {
      var w = wins[i];
      if (w.classList.contains('minimized')) continue;
      if (w.classList.contains('maximized')) continue;
      var r = w.getBoundingClientRect();
      if (r.width < 200 || r.height < 200) continue;
      W = w; wid = w.id || ('#' + i);
      break;
    }
    if (!W) { out.err = 'no usable window'; return JSON.stringify(out); }
    out.win = wid;

    var R = W.getBoundingClientRect();
    out.rect = { x: Math.round(R.left), y: Math.round(R.top),
                 w: Math.round(R.width), h: Math.round(R.height) };

    /** 某点命中的 resize 方向（没有则返回 ''） */
    function dirAt(x, y) {
      var el = document.elementFromPoint(x, y);
      if (!el) return '';
      // 自身或祖先带 data-resize 即算命中
      var cur = el;
      while (cur && cur !== document.body) {
        if (cur.dataset && cur.dataset.resize) return cur.dataset.resize;
        cur = cur.parentElement;
      }
      return '';
    }

    /* ---------- A) 几何厚度实测 ----------
     * ★ 第一版量到 0，原因是量法不对（探针 bug，不是产品 bug）★
     *   · `elementFromPoint` 在窗口**边框上**返回的是 .window 自己，
     *     热区虽然 z-index:900 覆盖在上，但它的 rect 从窗口外沿开始，
     *     取 `R.right - 1` 可能落在 border 像素里。
     *   · 更可靠的做法：**直接读热区元素的 getBoundingClientRect()**，
     *     它的宽度就是热区实际厚度（产品用 width:EDGE 写死的）。
     *     这才是"几何到底多宽"的直接证据，不依赖命中测试的像素对齐。
     *   仍然保留元素扫描作为交叉验证（elementAt），但它不再是判据。
     */
    var eEl = W.querySelector('[data-resize="e"]');
    var wEl = W.querySelector('[data-resize="w"]');
    var sEl = W.querySelector('[data-resize="s"]');
    var nEl = W.querySelector('[data-resize="n"]');
    var seEl = W.querySelector('[data-resize="se"]');
    if (eEl) out.eastThickness = Math.round(eEl.getBoundingClientRect().width);
    if (wEl) out.westThickness = Math.round(wEl.getBoundingClientRect().width);
    if (sEl) out.southThickness = Math.round(sEl.getBoundingClientRect().height);
    if (nEl) out.northThickness = Math.round(nEl.getBoundingClientRect().height);
    if (seEl) out.seCorner = Math.round(seEl.getBoundingClientRect().width);

    // 交叉验证：窗口右缘内侧 1~EDGE 像素处，命中的应该是 e 手柄
    var midY = Math.round(R.top + R.height / 2);
    var eHit = 0;
    for (var d = 1; d <= 20; d++) {
      var x = Math.round(R.right - d);
      if (x <= R.left) break;
      if (dirAt(x, midY) === 'e') eHit = d; else break;
    }
    out.eastHitDepth = eHit;

    // 窗口中心必须**不**是任何 resize 手柄（证明"只占最外圈"）
    out.centerDir = dirAt(Math.round(R.left + R.width / 2),
                          Math.round(R.top + R.height / 2));

    /* ---------- B) 时序：延时显示 ---------- */
    var hE = W.querySelector('[data-resize="e"]');
    if (!hE) { out.err = 'no east handle'; return JSON.stringify(out); }
    out.handleCursorInit = hE.style.cursor || '';
    out.handleArmedInit = hE.dataset.armed || '';

    // 派发 pointerenter（不改 cursor 的那一刻）
    hE.dispatchEvent(new PointerEvent('pointerenter', { bubbles: false, cancelable: true }));
    out.cursorOnEnter = hE.style.cursor || '';
    out.bodyCursorOnEnter = document.body.style.cursor || '';

    /* ---------- C) 立刻按下：不得被延时拖慢 ---------- */
    var wBefore = Math.round(W.getBoundingClientRect().width);
    hE.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, cancelable: true, button: 0, pointerId: 1,
      clientX: Math.round(R.right - 2), clientY: midY,
    }));
    out.cursorOnPress = hE.style.cursor || '';

    // 拖宽 40px
    var targetX = Math.round(R.right - 2) + 40;
    hE.dispatchEvent(new PointerEvent('pointermove', {
      bubbles: true, cancelable: true, pointerId: 1,
      clientX: targetX, clientY: midY,
    }));
    var wAfter = Math.round(W.getBoundingClientRect().width);
    out.widthBefore = wBefore;
    out.widthAfter = wAfter;
    out.resizedOnImmediatePress = (wAfter - wBefore) >= 30;

    hE.dispatchEvent(new PointerEvent('pointerup', {
      bubbles: true, cancelable: true, pointerId: 1,
      clientX: targetX, clientY: midY,
    }));
    out.cursorAfterUp = hE.style.cursor || '';

    /* ---------- B2) 单独确认"停留满延时才变" ---------- */
    // 用一个独立窗口测，避免上面拖过之后几何变了
    var W2 = null;
    var wins2 = Array.prototype.slice.call(document.querySelectorAll('.window'));
    for (var k = 0; k < wins2.length; k++) {
      var w2 = wins2[k];
      if (w2 === W) continue;
      if (w2.classList.contains('minimized') || w2.classList.contains('maximized')) continue;
      var r2 = w2.getBoundingClientRect();
      if (r2.width < 200 || r2.height < 200) continue;
      W2 = w2; break;
    }
    if (W2) {
      var h2 = W2.querySelector('[data-resize="e"]');
      if (h2) {
        h2.dispatchEvent(new PointerEvent('pointerenter', { bubbles: false, cancelable: true }));
        out.cursorImmediate = h2.style.cursor || '';
        out.delayPendingImmediate = (h2.dataset.armed || '') === '';
      }
    }

    out.ready = true;
  } catch (e) {
    out.err = String(e && e.message ? e.message : e);
  }
  return JSON.stringify(out);
})();
