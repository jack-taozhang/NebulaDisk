/* ============================================================================
 * _gb_buttons.js —— ★ 真实按下整个序列，验证业务按钮「真的生效」★
 *
 * 为什么必须派发**完整序列**（pointerdown→mousedown→pointerup→mouseup→click）：
 *   用户报的 bug 正是「按下被 preventDefault 掐断了后续 click」。
 *   只派发一个 click 事件是**测不出**这个 bug 的 —— 那样必然通过，
 *   正是典型的假绿。必须从 pointerdown 开始，模拟浏览器真实的派生链。
 *
 * 关键判据（每条都对应一个按钮的真实可观测副作用）：
 *   · view-list  → .files-wrap 里出现 table.list-view
 *   · view-grid  → .files-wrap 里出现 div.grid-view
 *   · info       → .info-panel 出现/切换（有 .open 或宽高变化）
 *   · sort       → 弹出 #ctx-menu
 *   另外负向：这些动作**不应**让窗口 left/top 发生变化（不许把窗口拖走）。
 * ========================================================================== */
(function () {
  var wins = WM.list();
  var w = wins.filter(function (x) { return /^explorer:/.test(x.id); })[0] || wins[0];
  if (!w) return JSON.stringify({ err: 'no window' });

  var body = w.el.querySelector('[data-role="body"]');
  if (!body) return JSON.stringify({ err: 'no body' });
  var bar = body.querySelector('.toolbar');
  if (!bar) return JSON.stringify({ err: 'no toolbar' });

  function mk(type, x, y) {
    try {
      return new PointerEvent(type, {
        bubbles: true, cancelable: true, composed: true,
        clientX: x, clientY: y, button: 0, buttons: type === 'pointerup' ? 0 : 1,
        pointerId: 1, pointerType: 'mouse', isPrimary: true,
      });
    } catch (e) {
      return new MouseEvent(type, {
        bubbles: true, cancelable: true, composed: true,
        clientX: x, clientY: y, button: 0, buttons: 1,
      });
    }
  }

  /** 在元素中心派发一整套真实鼠标序列 */
  function realClick(el) {
    if (!el) return { err: 'no el' };
    var r = el.getBoundingClientRect();
    var x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
    if (!x || !y) { x = 200; y = 60; }
    var seq = [];
    ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(function (t) {
      var ev = mk(t, x, y);
      var ok = el.dispatchEvent(ev);
      seq.push(t + (ok ? '' : '(prevented)'));
    });
    return { x: x, y: y, seq: seq };
  }

  function findBtn(act) {
    var b = bar.querySelector('[data-act="' + act + '"]');
    return b && !b.disabled ? b : null;
  }

  var geoBefore = { l: w.el.style.left, t: w.el.style.top };
  var out = {};

  // ---- 1) view-list ----
  var r1 = realClick(findBtn('view-list'));
  out.viewList = {
    click: r1.seq ? r1.seq.join(',') : r1.err,
    hasTable: !!body.querySelector('table.list-view'),
    hasGrid: !!body.querySelector('.grid-view'),
  };

  // ---- 2) view-grid ----
  var r2 = realClick(findBtn('view-grid'));
  out.viewGrid = {
    click: r2.seq ? r2.seq.join(',') : r2.err,
    hasGrid: !!body.querySelector('.grid-view'),
    hasTable: !!body.querySelector('table.list-view'),
  };

  // ---- 3) info ----
  var ipBefore = !!body.querySelector('.info-panel.open');
  var r3 = realClick(findBtn('info'));
  var ipAfter = !!body.querySelector('.info-panel.open');
  out.info = { click: r3.seq ? r3.seq.join(',') : r3.err, before: ipBefore, after: ipAfter };

  // ---- 4) sort（应弹出上下文菜单）----
  var r4 = realClick(findBtn('sort'));
  var menu = document.querySelector('#ctx-menu');
  out.sort = {
    click: r4.seq ? r4.seq.join(',') : r4.err,
    menuOpen: !!(menu && menu.classList.contains('open')),
  };
  // 关掉菜单，避免污染后续
  try { document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); } catch (e) {}

  var geoAfter = { l: w.el.style.left, t: w.el.style.top };
  out.moved = (geoBefore.l !== geoAfter.l) || (geoBefore.t !== geoAfter.t);
  out.geo = { before: geoBefore, after: geoAfter };

  // 自判
  out.PASS = {
    viewListWorks: out.viewList.hasTable === true && out.viewList.hasGrid === false,
    viewGridWorks: out.viewGrid.hasGrid === true && out.viewGrid.hasTable === false,
    infoWorks: out.info.after !== out.info.before,
    sortWorks: out.sort.menuOpen === true,
    notMoved: out.moved === false,
  };
  return JSON.stringify(out);
})();
