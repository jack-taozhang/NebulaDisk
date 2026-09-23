/* ============================================================================
 * _fs_open.js —— 打开一个 **有 iframe** 的预览窗口（OnlyOffice）
 *
 * 为什么要单独一个探针：
 *   用户报的问题只在 OnlyOffice / CAD / kkFileView 这三种窗口上出现，
 *   它们的内容都是 <iframe>。图片窗口是纯 DOM，不触发这个路径，
 *   所以必须专门打开一个 iframe 窗口来验证。
 *
 * 目标文件：测试文档.pdf（route = onlyoffice → 内嵌 iframe）
 *   找到 → 双击 → 等窗口出现（轮询由 shell 脚本负责）
 * ========================================================================== */
(function () {
  var TARGET = '测试文档.pdf';
  var node = document.querySelector('.tile[data-name="' + TARGET + '"]')
          || document.querySelector('.list-view tr[data-name="' + TARGET + '"]');
  if (!node) {
    var any = document.querySelectorAll('[data-name]');
    return JSON.stringify({
      notready: true, n: any.length,
      names: Array.prototype.map.call(any, function (x) { return x.dataset.name; }).slice(0, 25),
    });
  }
  node.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));

  // 立刻看一眼有没有 iframe 窗口冒出来（内容可能还在加载）
  var ids = WM.list().map(function (w) { return w.id; });
  var ifrWin = WM.list().filter(function (w) {
    return w.el.querySelectorAll('iframe').length > 0;
  })[0];
  return JSON.stringify({
    ok: 1,
    opened: TARGET,
    ids: ids,
    hasIframeWin: !!ifrWin,
    iframeWinId: ifrWin ? ifrWin.id : null,
  });
})();
