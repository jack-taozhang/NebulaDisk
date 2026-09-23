// 在**真实浏览器**里验证 DWG 是否真的画出来了。
// 判据不是「有没有报错」，而是渲染后的可见性指标：
//   1. SVG 根元素拿到了 viewBox
//   2. svg 的显示尺寸落在容器可视范围内（不是 160 万 px）
//   3. 变换后的包围盒与容器有交集 —— 也就是「有东西在屏幕上」
//   4. 缩放标签显示接近 100%（适应窗口）
(async () => {
  const out = {};
  // 预览窗口是 iframe，进它的 contentDocument
  const iframes = document.querySelectorAll('iframe');
  out.iframeCount = iframes.length;
  let doc = document, win = window;
  for (const f of iframes) {
    try {
      if (f.contentDocument && f.contentDocument.querySelector('#svg-container')) {
        doc = f.contentDocument; win = f.contentWindow; break;
      }
    } catch (e) { /* 跨域，跳过 */ }
  }
  out.usedIframe = doc !== document;

  const svg = doc.querySelector('#svg-container svg');
  if (!svg) {
    out.found = false;
    out.html = doc.body ? doc.body.innerHTML.slice(0, 500) : '(no body)';
    return out;
  }
  out.found = true;

  const rect = svg.getBoundingClientRect();
  out.viewBox = svg.getAttribute('viewBox');
  out.widthAttr = svg.getAttribute('width');
  out.heightAttr = svg.getAttribute('height');
  out.styleW = svg.style.width;
  out.styleH = svg.style.height;
  out.rect = { w: Math.round(rect.width), h: Math.round(rect.height), top: Math.round(rect.top), left: Math.round(rect.left) };
  out.svgChildren = svg.querySelectorAll('*').length;

  const c = doc.querySelector('#container');
  const cr = c.getBoundingClientRect();
  out.containerRect = { w: Math.round(cr.width), h: Math.round(cr.height) };

  // 交集面积占比 —— 「屏幕上有多少东西」
  const ix = Math.max(0, Math.min(rect.right, cr.right) - Math.max(rect.left, cr.left));
  const iy = Math.max(0, Math.min(rect.bottom, cr.bottom) - Math.max(rect.top, cr.top));
  out.intersectAreaPct = +((ix * iy) / (cr.width * cr.height) * 100).toFixed(1);

  // 尺寸合理性：显示宽度不应超过容器太多（否则就是没缩放）
  out.fitsWidth = rect.width <= cr.width * 1.5;
  out.fitsHeight = rect.height <= cr.height * 1.5;

  const z = doc.querySelector('.zoom-display');
  out.zoomText = z ? z.textContent : null;
  out.loadingVisible = !!doc.querySelector('.loading') && doc.querySelector('.loading').style.display !== 'none';

  return out;
})()
