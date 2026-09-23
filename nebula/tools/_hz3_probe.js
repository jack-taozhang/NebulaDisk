/* _hz3_probe.js —— 热区「跨边框」几何验算（真实浏览器）
 *
 * 目的（对应 Request D）：确认 8 个 resize 手柄的**外沿**是否越过窗口边框，
 *   即 handle.outer = win.edge + OUT，而**内沿**仍是 win.edge - EDGE/CORNER。
 *
 * 与 _hz2_probe.js 的区别：
 *   _hz2 只量「外沿 vs 窗口边沿」的 gap（当时期望 ≈0，因为热区全在窗口内）。
 *   _hz3 量的是**跨边框**：期望 外沿 gap ≈ +OUT（向外突出），内沿 gap ≈ -EDGE（向内）。
 *   并且向右/左/上/下四个方向各扫一条**窗外的带**，确认那条带真的可命中手柄
 *   （用 elementFromPoint，因为窗外没有别的元素遮挡，命中是可信的）。
 *
 * 注意：本探针**必须**通过 agent-browser eval 注入执行，返回值是 JSON 字符串。
 *       不要在窗内用 elementFromPoint 量厚度（边框像素会抢命中），
 *       所以厚度一律读手柄自身的 getBoundingClientRect()。
 */
(() => {
  const out = { ok: false, err: null };

  try {
    // ---- 0. 前置：必须已有窗口 ----
    const win = document.querySelector('#window-layer .window');
    if (!win) { out.err = 'no-window'; return JSON.stringify(out); }

    // 让窗口有确定尺寸（避免最大化/最小化干扰）
    if (win.classList.contains('maximized') || win.classList.contains('minimized')) {
      out.err = 'window-maximized-or-minimized';
      return JSON.stringify(out);
    }

    const R0 = win.getBoundingClientRect();

    // ---- 1. 读产品源码里的常量（不写死数字）----
    //   从 handles 的 inline style 反推 OUT：任一角的 width 一定是 (CORNER+OUT)px
    const get = (d) => win.querySelector(`[data-resize="${d}"]`);
    const rect = (d) => { const h = get(d); if (!h) return null; return h.getBoundingClientRect(); };

    const dirs = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];
    const R = {};
    dirs.forEach((d) => { const r = rect(d); R[d] = r ? { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height } : null; });

    out.win = { l: R0.left, t: R0.top, r: R0.right, b: R0.bottom, w: R0.width, h: R0.height };
    out.handles = R;
    out.missing = dirs.filter((d) => !R[d]);

    // ---- 2. 跨边框判定：外沿越过窗口边沿 OUT 像素 ----
    //   n/s 用 top/bottom 判；e/w 用 right/left 判；四角用两个方向各判一次。
    const gaps = {};
    if (R.n) gaps.n_top = R.n.t - out.win.t;                 // 期望 ≈ -OUT
    if (R.s) gaps.s_bottom = R.s.b - out.win.b;              // 期望 ≈ +OUT
    if (R.e) gaps.e_right = R.e.r - out.win.r;               // 期望 ≈ +OUT
    if (R.w) gaps.w_left = R.w.l - out.win.l;                // 期望 ≈ -OUT
    if (R.nw) { gaps.nw_left = R.nw.l - out.win.l; gaps.nw_top = R.nw.t - out.win.t; }
    if (R.ne) { gaps.ne_right = R.ne.r - out.win.r; }
    if (R.sw) { gaps.sw_left = R.sw.l - out.win.l; gaps.sw_bottom = R.sw.b - out.win.b; }
    if (R.se) { gaps.se_right = R.se.r - out.win.r; gaps.se_bottom = R.se.b - out.win.b; }
    out.gaps = gaps;

    // ---- 3. 内侧厚度（仍在窗内那部分）----
    //   e: 左沿 = win.r - EDGE → 内厚 = win.r - R.e.l
    const inner = {};
    if (R.e) inner.e = out.win.r - R.e.l;
    if (R.w) inner.w = R.w.r - out.win.l;
    if (R.n) inner.n = R.n.b - out.win.t;
    if (R.s) inner.s = out.win.b - R.s.t;
    if (R.se) inner.se = out.win.r - R.se.l;
    out.innerThickness = inner;

    // ---- 4. 窗外可命中性：在窗口外 OUT/2 处取点，看命中的是不是该手柄 ----
    //   窗外无遮挡，elementFromPoint 可信。
    //   注：agent-browser 的 viewport 要足够大，否则窗外点会落在视口外。
    const probe = (x, y, expect) => {
      if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return 'out-of-viewport';
      const el = document.elementFromPoint(x, y);
      if (!el) return 'null';
      const d = el.dataset ? el.dataset.resize : null;
      if (d === expect) return 'ok:' + d;
      return 'hit:' + (d || el.className || el.tagName);
    };
    const outside = {};
    const midY = (out.win.t + out.win.b) / 2;
    const midX = (out.win.l + out.win.r) / 2;
    // 右侧窗外 2px（OUT=4，取 2 在带内）
    outside.rightBand = probe(out.win.r + 2, midY, 'e');
    // 左侧窗外 2px
    outside.leftBand = probe(out.win.l - 2, midY, 'w');
    // 下侧窗外 2px
    outside.bottomBand = probe(midX, out.win.b + 2, 's');
    // 上侧窗外 2px（注意：上方可能被别的窗口/桌面遮挡；仍记录结果）
    outside.topBand = probe(midX, out.win.t - 2, 'n');
    // 右下角窗外（对角）
    outside.seBand = probe(out.win.r + 2, out.win.b + 2, 'se');
    // 左上角窗外
    outside.nwBand = probe(out.win.l - 2, out.win.t - 2, 'nw');
    out.outsideProbe = outside;

    // ---- 5. 周长零缝隙扫描（含窗外带）----
    //   沿窗口周长逐像素取点，看是否被某个 [data-resize] 覆盖。
    //   ★ 只用手柄自身的 rect 判定（不用 elementFromPoint），避免遮挡干扰。
    const cover = (x, y) => {
      for (const d of dirs) {
        const r = R[d];
        if (!r) continue;
        if (x >= r.l - 0.01 && x <= r.r + 0.01 && y >= r.t - 0.01 && y <= r.b + 0.01) return d;
      }
      return null;
    };
    const holes = { top: [], bottom: [], left: [], right: [], outRight: [], outLeft: [], outTop: [], outBottom: [] };
    const TBH = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--toolbar-h')) || 29;

    for (let x = Math.ceil(out.win.l); x <= Math.floor(out.win.r); x++) {
      if (!cover(x, out.win.t)) holes.top.push(x);
      if (!cover(x, out.win.b)) holes.bottom.push(x);
    }
    for (let y = Math.ceil(out.win.t); y <= Math.floor(out.win.b); y++) {
      if (!cover(out.win.l, y)) holes.left.push(y);
      if (!cover(out.win.r, y)) holes.right.push(y);
    }
    // 窗外 4px 带（在 OUT 之内，取 +2）
    for (let y = Math.ceil(out.win.t); y <= Math.floor(out.win.b); y++) {
      if (!cover(out.win.r + 2, y)) holes.outRight.push(y);
      if (!cover(out.win.l - 2, y)) holes.outLeft.push(y);
    }
    for (let x = Math.ceil(out.win.l); x <= Math.floor(out.win.r); x++) {
      if (!cover(x, out.win.t - 2)) holes.outTop.push(x);
      if (!cover(x, out.win.b + 2)) holes.outBottom.push(x);
    }
    // 汇总成「区间」更易读
    const rng = (arr) => {
      if (!arr.length) return [];
      const res = []; let s = arr[0], p = arr[0];
      for (let i = 1; i < arr.length; i++) {
        if (arr[i] === p + 1) { p = arr[i]; continue; }
        res.push(s === p ? [s, s] : [s, p]); s = p = arr[i];
      }
      res.push(s === p ? [s, s] : [s, p]);
      return res;
    };
    out.holes = {
      top: rng(holes.top), bottom: rng(holes.bottom),
      left: rng(holes.left), right: rng(holes.right),
      outRight: rng(holes.outRight), outLeft: rng(holes.outLeft),
      outTop: rng(holes.outTop), outBottom: rng(holes.outBottom),
    };
    out.toolbarH = TBH;
    // 右上「让位带」：ne 从 y = win.t + TBH 起 → y∈[win.t, win.t+TBH) 无 ne 覆盖
    out.neGiveWayBand = [out.win.t, out.win.t + TBH];

    out.ok = true;
    return JSON.stringify(out);
  } catch (e) {
    out.err = String(e && e.stack || e);
    return JSON.stringify(out);
  }
})();
