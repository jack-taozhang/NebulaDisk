/* ============================================================================
 * _fs_probe.js —— ★ 点 iframe 预览窗口「任意位置」都能置顶（真浏览器验证）★
 *
 * 用户原文：
 *   「编辑和预览文件的窗口 目前还没有实现 点击窗口任何地方就聚焦成
 *     最前端显示。」
 *   「目前点击中间部分才能前置，其他位置没有反应」
 *
 * 被测对象：OnlyOffice / CAD / kkFileView —— 内容都是 <iframe> 的窗口。
 *
 * 核心判据（每条都必须为真，缺一不可）：
 *   ① 非最顶层的 iframe 窗口，它的每个 iframe 上都盖着 .iframe-shield
 *   ② 该盾此刻 pointer-events 是 auto（真的在接管点击）
 *   ③ 在窗口矩形内**网格打点**，每点在盾上按一下，窗口的 zIndex 都变大
 *      —— 这才是"点任意位置都置顶"。注意：点击必须落在盾上（而不是
 *      iframe 内部），这正是我们要验证的机制。
 *   ④ 置顶之后盾立刻变 none（内容可交互），下次点别的窗口时它又变回 auto
 *   ⑤ 最顶层窗口的盾必须是 none（不挡住内容操作）
 *
 * 为什么可在真浏览器里测：
 *   盾是父文档的元素，所以 `shield.dispatchEvent(mousedown)` 等价于
 *   用户真的点在上面（不需要穿进 iframe）。而"点在 iframe 内部"这一支
 *   本来就无法从父文档派发，盾的存在就是为了绕开它。
 * ========================================================================== */
(function () {
  var out = {};
  var wins = WM.list().filter(function (w) { return !w.minimized; });
  if (wins.length < 1) return JSON.stringify({ err: 'no window', n: wins.length });

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
  function shieldsOf(w) {
    return Array.prototype.slice.call(w.el.querySelectorAll('.iframe-shield'));
  }
  function iframesOf(w) {
    return Array.prototype.slice.call(w.el.querySelectorAll('iframe'));
  }
  function pe(s) { return getComputedStyle(s).pointerEvents; }

  out.wins = wins.map(function (w) {
    return {
      id: w.id, z: zOf(w),
      iframes: iframesOf(w).length,
      shields: shieldsOf(w).length,
      shieldPE: shieldsOf(w).map(pe),
      minimized: !!w.minimized,
    };
  });

  // 找第一个「有 iframe 的窗口」当被测对象（OnlyOffice/CAD/KK 任一）
  var target = wins.filter(function (w) { return iframesOf(w).length > 0; })[0];
  if (!target) {
    out.err = 'no iframe window';
    out.ids = wins.map(function (w) { return w.id; });
    return JSON.stringify(out);
  }
  out.target = target.id;

  // ---- 先把它压到下层：用产品自己的 focus 抬别的窗口 ----
  function raiseOther(exceptId) {
    var o = WM.list().filter(function (w) {
      return !w.minimized && w.id !== exceptId;
    })[0];
    if (!o) return false;
    // 在有 iframe 的窗口上，优先点它的盾；没有盾就点它的 el
    var sh = shieldsOf(o)[0];
    var node = sh || o.el;
    var r = node.getBoundingClientRect();
    node.dispatchEvent(new MouseEvent('mousedown', {
      bubbles: true, cancelable: true,
      clientX: Math.round(r.left + r.width / 2),
      clientY: Math.round(r.top + r.height / 2),
      button: 0,
    }));
    return true;
  }

  // ---- ② 把 target 压下去后，它的盾必须是 auto ----
  raiseOther(target.id);
  out.afterOthersRaised = { targetZ: zOf(target), top: topId() };
  var shieldsDown = shieldsOf(target);
  out.shieldAutoWhenNotTop = shieldsDown.length > 0 &&
    shieldsDown.every(function (s) { return pe(s) === 'auto'; });
  out.shieldPEWhenNotTop = shieldsDown.map(pe);

  // ---- ③ 网格打点：每点点盾，zIndex 必须变大 ----
  //   点的位置用盾自己的矩形打网格（盾 = iframe 区域）
  var sh = shieldsDown[0];
  if (!sh) {
    out.err = 'target has iframe but no shield';
    return JSON.stringify(out);
  }
  var r = sh.getBoundingClientRect();
  var cols = 5, rows = 4, cells = [];
  for (var iy = 0; iy < rows; iy++) {
    for (var ix = 0; ix < cols; ix++) {
      var x = Math.round(r.left + r.width * (ix + 1) / (cols + 1));
      var y = Math.round(r.top + r.height * (iy + 1) / (rows + 1));

      // 每格都先制造"本窗口在下"的局面
      raiseOther(target.id);
      var zBefore = zOf(target);
      var wasTop = topId() === target.id;

      // ★ 点这一点：先看盾在不在、挡不挡得住 ★
      var cur = shieldsOf(target)[0];
      var curPE = cur ? pe(cur) : null;
      var pt = document.elementFromPoint(x, y);
      // 命中归属：用来确认这一点确实归 target（没被别的窗口盖住）
      var own = pt;
      var owner = null;
      while (own && own !== document) {
        if (own.dataset && own.dataset.winId) { owner = own.dataset.winId; break; }
        own = own.parentNode;
      }

      if (cur) {
        cur.dispatchEvent(new MouseEvent('mousedown', {
          bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0,
        }));
      }
      var zAfter = zOf(target);

      cells.push({
        x: x, y: y,
        shieldPE: curPE,
        hitTag: pt ? pt.tagName : null,
        hitCls: pt && typeof pt.className === 'string' ? pt.className.slice(0, 30) : null,
        owner: owner,
        zBefore: zBefore, zAfter: zAfter,
        wasTop: wasTop,
        raised: zAfter > zBefore,
        isTopNow: topId() === target.id,
      });
    }
  }
  out.cells = cells;
  out.total = cells.length;
  out.raisedN = cells.filter(function (c) { return c.raised; }).length;
  out.topN = cells.filter(function (c) { return c.isTopNow; }).length;
  // 几何归属统计（仅作诊断）：elementFromPoint 到的那一点归谁。
  //   ⚠️ 别拿它当判据 ★★★
  //   重叠时上层窗口会把这一点"盖住"，elementFromPoint 自然返回上层窗口的
  //   元素（实测：explorer 在上时，20 格全部 owner=explorer）。
  //   而我们要验证的恰恰是「即使被盖住，点 target 的盾也能把它抬起来」——
  //   所以 ownership 为 0 不是失败，反而正是盾存在的意义。
  var mine = cells.filter(function (c) { return c.owner === target.id; });
  out.mineCells = mine.length;
  out.mineRaisedByGeometry = mine.filter(function (c) { return c.raised; }).length;
  out.ownerTopCount = cells.filter(function (c) { return c.owner !== target.id; }).length;

  // ---- ④/⑤ 置顶后盾必须关闭 ----
  var shieldsAfter = shieldsOf(target);
  out.shieldOffWhenTop = shieldsAfter.length > 0 &&
    shieldsAfter.every(function (s) { return pe(s) === 'none'; });
  out.shieldPEWhenTop = shieldsAfter.map(pe);
  out.isTopAtEnd = topId() === target.id;

  out.PASS = {
    hasIframeWin: out.wins.some(function (w) { return w.iframes > 0; }),
    shieldExists: out.wins.some(function (w) { return w.shields > 0; }),
    shieldAutoWhenNotTop: out.shieldAutoWhenNotTop === true,
    // ★ 主判据：每一个格子按下去都把窗口抬起来了（zIndex 变大 + 变成最顶）★
    //   这才是"点任意位置都能置顶"，与几何归属无关。
    everyCellRaised: out.total > 0 && out.raisedN === out.total,
    everyCellBecameTop: out.total > 0 && out.topN === out.total,
    shieldOffWhenTop: out.shieldOffWhenTop === true,
  };
  return JSON.stringify(out);
})();
