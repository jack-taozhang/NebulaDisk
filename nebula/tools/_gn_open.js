/* ============================================================================
 * _gn_open.js —— 真实 UI：开文件夹窗 → 双击一张图片，打开预览窗口
 * ========================================================================== */
(function () {
  try { Array.from(document.querySelectorAll('.window')).forEach(function (w) {
    var b = w.querySelector('.tb-btn.close, .tb-btn[data-act="close"]');
    if (b) b.click();
  }); } catch (e) {}
  var icons = document.querySelectorAll('#desktop-icons > *');
  if (!icons.length) return JSON.stringify({ err: 'no icons' });
  icons[0].dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
  return JSON.stringify({ ok: 1 });
})();
