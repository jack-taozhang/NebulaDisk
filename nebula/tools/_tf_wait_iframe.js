/* ============================================================================
 * _tf_wait_iframe.js —— 等「iframe 预览窗」真正长出 iframe
 *
 * 为什么需要它：
 *   OnlyOffice 窗口是**两段式**渲染 —— 先出「正在连接 OnlyOffice…」的
 *   boot 占位（**没有 iframe**），等 DocsAPI 脚本加载 + 文档转换完成后，
 *   才把 <iframe> 插进 `[data-role="host"]`。而转换耗时随文档大小/冷热波动
 *   （首次冷启动可达十几秒）。
 *
 *   _tf_run.sh 原来写的是固定 `sleep 6` —— 机器一忙就等不够，
 *   于是 _tf_probe.js 报 `hasIframeWin:false`，runner 把它当成
 *   「预览窗口点工具栏没置顶」。**那是脚本的锅，不是产品的**。
 *   ⇒ 改成轮询，并给出足以区分「还在加载」/「真失败」的诊断。
 *
 * 判据：
 *   ready=true  ⇔ 某个窗口里已经出现 <iframe>
 *   若一直不 ready，用 diag 判断是 OO 侧没连上（有错误文案）
 *   还是仅仅还没加载完（boot 文案仍是「正在连接」）。
 * ========================================================================== */
(function () {
  function txt(el, n) {
    if (!el) return '';
    return (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, n || 120);
  }

  var wins = WM.list().map(function (w) {
    var boot = w.el.querySelector('[data-role="boot"]');
    var host = w.el.querySelector('[data-role="host"]');
    return {
      id: w.id,
      iframes: w.el.querySelectorAll('iframe').length,
      hasToolbar: !!w.el.querySelector('.toolbar.win-toolbar'),
      boot: boot ? (boot.style.display === 'none' ? 'hidden' : 'shown') : null,
      bootText: boot ? txt(boot) : '',
      host: host ? (host.style.display === 'none' ? 'hidden' : 'shown') : null,
      // OnlyOffice 的编辑器实例挂在 host 上（DocsAPI 建完才有）
      editorIframes: host ? host.querySelectorAll('iframe').length : 0,
    };
  });

  var withIframe = wins.filter(function (w) { return w.iframes > 0; });
  return JSON.stringify({
    ready: withIframe.length > 0,
    iframeWinId: withIframe.length ? withIframe[0].id : null,
    totalWindows: wins.length,
    totalIframes: wins.reduce(function (a, w) { return a + w.iframes; }, 0),
    // 诊断用：能分清「OO 还没连上」与「只是慢」
    docsApi: typeof window.DocsAPI !== 'undefined',
    windows: wins,
  });
})();
