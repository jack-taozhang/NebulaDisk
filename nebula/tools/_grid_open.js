/* ============================================================================
 * _grid_open.js —— 开两个「形状与预览窗口一致」的合成窗口
 *
 * ★ 修正：WM.open 的签名是 open(opts)（单个对象，id 是对象内的字段），
 *   上一版写成 open(id, opts) → id 被忽略，窗口名变成自动的 win-N，
 *   于是后续扫描找不到 __g1。这里改为传对象。
 * ========================================================================== */
(function () {
  var made = [];
  [['__g1', 40, 60], ['__g2', 300, 200]].forEach(function (spec) {
    var id = spec[0];
    try { if (WM.get(id)) WM.close(id); } catch (e) {}
    WM.open({
      id: id,
      title: 'grid-' + id,
      icon: '',
      width: 560, height: 420,
      x: spec[1], y: spec[2],
      resizable: true,
      noIframeFocus: false,     // 与 OnlyOffice/kk/CAD 预览一致的路径
      render: function (body) {
        body.innerHTML =
          '<div class="content" style="flex:1;display:flex;flex-direction:column;min-width:0">' +
            '<div class="toolbar" style="height:29px;flex:0 0 29px">' +
              '<span style="font-size:12px;padding-left:8px">' + id + '</span>' +
            '</div>' +
            '<div class="kk-frame-wrap" style="flex:1;min-height:0">' +
              '<iframe style="width:100%;height:100%;border:0" ' +
                'src="about:blank"></iframe>' +
            '</div>' +
          '</div>';
      },
    });
    made.push(id);
  });
  return JSON.stringify({ ok: 1, made: made, ids: WM.list().map(function (w) { return w.id; }) });
})();
