/* ============================================================================
 * _grid_scan.js —— 逐点"真实按下"扫描：哪一点上窗口会被置顶
 *
 * ★ 上一版的致命测试伪影（必须先说清楚，否则误判产品）★
 *   第一次 press 落在 nw 角 resize 热区上 → 它的 pointerdown 里调了
 *   _shieldOn()，于是整屏铺上 div.wm-drag-shield.on（z-index 9998，
 *   pointer-events 默认 auto）。我**没有补 pointerup**，遮罩就永久留着，
 *   后面每一次 elementFromPoint 命中的都是这层遮罩 ——
 *   于是 36/37 个点都"点不到窗口"，得出「到处都不能置顶」的假结论。
 *   这层遮罩是**测试没收拾干净**造成的，不是产品稳态行为。
 *
 *   本版修正：
 *     · 每次 press 后立刻派发 pointerup/mouseup，让手势正常收尾；
 *     · 每个采样点开始前强制把遮罩摘掉（保险起见）。
 * ========================================================================== */
(function () {
  var w = WM.get('__g1');
  if (!w) return JSON.stringify({ err: 'no window __g1', ids: WM.list().map(function (x) { return x.id; }) });

  var SHIELD = document.querySelector('.wm-drag-shield');
  function shieldOff() {
    if (SHIELD) SHIELD.classList.remove('on');
    document.body.style.userSelect = '';
    document.body.style.cursor = '';
  }

  function chain(node) {
    var out = [], n = node, k = 0;
    while (n && k < 7) {
      var tag = (n.tagName || '?').toLowerCase();
      var cls = (n.className && typeof n.className === 'string' && n.className.trim())
        ? '.' + n.className.trim().split(/\s+/).join('.') : '';
      var rz = (n.dataset && n.dataset.resize) ? '[rz=' + n.dataset.resize + ']' : '';
      var wid = (n.dataset && n.dataset.winId) ? '{win=' + n.dataset.winId + '}' : '';
      out.push(tag + cls + rz + wid);
      n = n.parentNode; k++;
    }
    return out.join(' < ');
  }

  function z() { return parseInt(w.el.style.zIndex || '0', 10); }

  function mk(type, x, y) {
    try {
      return new PointerEvent(type, {
        bubbles: true, cancelable: true, composed: true,
        clientX: x, clientY: y, button: 0, buttons: 1, pointerId: 1,
        pointerType: 'mouse', isPrimary: true,
      });
    } catch (e) {
      return new MouseEvent(type, {
        bubbles: true, cancelable: true, composed: true,
        clientX: x, clientY: y, button: 0, buttons: 1,
      });
    }
  }

  /** 一次完整的"按下再松开"，落在真实命中元素上 */
  function clickAt(x, y) {
    var hit = null;
    try { hit = document.elementFromPoint(x, y); } catch (e) { hit = null; }
    var before = z();
    if (hit) {
      hit.dispatchEvent(mk('pointerdown', x, y));
      hit.dispatchEvent(mk('mousedown', x, y));
      // ★ 立刻收尾：松开指针，撤销手势遮罩 ★
      hit.dispatchEvent(mk('pointerup', x, y));
      hit.dispatchEvent(mk('mouseup', x, y));
    }
    shieldOff();
    return { hit: hit, raised: z() > before, z0: before, z1: z() };
  }

  var r = w.el.getBoundingClientRect();
  var rows = [];

  // 采样：外侧 3px（在 14px 热区内）、中间、中心
  var offs = [
    { dx: 3,  dy: 3,  label: 'outer' },
    { dx: 8,  dy: 8,  label: 'edge8' },
    { dx: 40, dy: 40, label: 'inner40' },
  ];

  offs.forEach(function (o) {
    var pts = [
      { x: Math.round(r.left + o.dx),       y: Math.round(r.top + o.dy),        n: 'NW' },
      { x: Math.round(r.right - o.dx),      y: Math.round(r.top + o.dy),        n: 'NE' },
      { x: Math.round(r.left + o.dx),       y: Math.round(r.bottom - o.dy),     n: 'SW' },
      { x: Math.round(r.right - o.dx),      y: Math.round(r.bottom - o.dy),     n: 'SE' },
      { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + o.dy),       n: 'Nmid' },
      { x: Math.round(r.left + r.width / 2), y: Math.round(r.bottom - o.dy),    n: 'Smid' },
      { x: Math.round(r.left + o.dx),       y: Math.round(r.top + r.height / 2), n: 'Wmid' },
      { x: Math.round(r.right - o.dx),      y: Math.round(r.top + r.height / 2), n: 'Emid' },
      { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + 40),         n: 'toolbar' },
      { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), n: 'CENTER' },
      { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height - 40), n: 'body-low' },
    ];
    pts.forEach(function (p) {
      var res = clickAt(p.x, p.y);
      rows.push({
        pt: o.label + '/' + p.n, x: p.x, y: p.y,
        raised: res.raised, z: res.z0 + '->' + res.z1,
        hit: res.hit ? chain(res.hit) : 'null',
      });
    });
  });

  var raised = 0, no = 0;
  rows.forEach(function (a) { a.raised ? raised++ : no++; });

  return JSON.stringify({
    rect: { l: Math.round(r.left), t: Math.round(r.top), r: Math.round(r.right), b: Math.round(r.bottom) },
    stat: { RAISED: raised, 'NO-RAISE': no },
    fails: rows.filter(function (a) { return !a.raised; }),
  });
})();
