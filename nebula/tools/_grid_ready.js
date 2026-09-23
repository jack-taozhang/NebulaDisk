/* 就绪闸门：等桌面图标渲染出来 + 窗口层存在 */
(function () {
  var icons = document.querySelector('#desktop-icons');
  var layer = document.querySelector('#window-layer');
  return JSON.stringify({
    ready: !!(icons && icons.children.length > 0 && layer),
    icons: icons ? icons.children.length : -1,
    layer: !!layer,
    w: window.innerWidth,
    h: window.innerHeight,
  });
})();
