// 一次性完成：登录 → 进桌面 → 开 DWG → 等转换 → 测量渲染几何 → 截图前快照。
// 必须整段在同一个 eval 里跑，因为 agent-browser 的 eval 每次都可能是新上下文。
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = { steps: [] };

  // 1) 登录
  await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'username=admin&password=' + encodeURIComponent('dev-pass-not-real'),
    credentials: 'include',
  });
  const me = await (await fetch('/api/me', { credentials: 'include' })).json();
  out.steps.push('login ok, mounts=' + (me.mounts || []).map((m) => m.label).join(','));

  // 2) 进桌面
  enterDesktop(me);
  await sleep(1200);
  out.desktopDisplay = getComputedStyle(document.getElementById('desktop')).display;

  // 3) 开 DWG
  Viewer.openKK('共享', '/立库规划图块.dwg', '立库规划图块.dwg');
  out.steps.push('openKK called');

  // 4) 等 iframe 内出现真正的 svg（最多 ~40s，首次要转换）
  let svg = null, doc = null;
  for (let i = 0; i < 80; i++) {
    await sleep(500);
    for (const f of document.querySelectorAll('iframe')) {
      try {
        const fd = f.contentDocument;
        if (fd && fd.querySelector('#svg-container svg')) { doc = fd; svg = fd.querySelector('#svg-container svg'); break; }
      } catch (e) { /* 跨域 */ }
    }
    if (svg && svg.querySelectorAll('*').length > 100) break;
  }
  if (!svg) { out.found = false; out.iframeCount = document.querySelectorAll('iframe').length; return out; }
  out.found = true;
  out.steps.push('svg appeared, waiting for size to settle');

  // 5) 等容器尺寸稳定（连续两次相同）
  const cont = doc.querySelector('#container');
  let lastW = -1, lastH = -1, stable = 0;
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    const cw = cont.clientWidth, ch = cont.clientHeight;
    if (cw === lastW && ch === lastH && cw > 0) { stable++; if (stable >= 3) break; }
    else { stable = 0; }
    lastW = cw; lastH = ch;
  }

  const rect = svg.getBoundingClientRect();
  const cr = cont.getBoundingClientRect();
  out.viewBox = svg.getAttribute('viewBox');
  out.intrinsic = { w: svg.getAttribute('width'), h: svg.getAttribute('height') };
  out.container = { w: cont.clientWidth, h: cont.clientHeight };
  out.svgOnScreen = { w: Math.round(rect.width), h: Math.round(rect.height), top: Math.round(rect.top), left: Math.round(rect.left) };
  out.svgChildren = svg.querySelectorAll('*').length;

  const ix = Math.max(0, Math.min(rect.right, cr.right) - Math.max(rect.left, cr.left));
  const iy = Math.max(0, Math.min(rect.bottom, cr.bottom) - Math.max(rect.top, cr.top));
  out.intersectAreaPct = +((ix * iy) / (cr.width * cr.height) * 100).toFixed(1);
  out.coveragePct = +((rect.width * rect.height) / (cr.width * cr.height) * 100).toFixed(1);

  // 6) 画布真的画了东西吗？抽样非透明像素
  try {
    const c = doc.createElement('canvas');
    const s = new XMLSerializer().serializeToString(svg);
    const img = new Image();
    const b64 = btoa(unescape(encodeURIComponent(s)));
    await new Promise((res) => { img.onload = res; img.onerror = res; img.src = 'data:image/svg+xml;base64,' + b64; });
    c.width = 400; c.height = 200;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0, c.width, c.height);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let nonBlank = 0, nonWhite = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] > 0) {
        nonBlank++;
        if (d[i] < 240 || d[i + 1] < 240 || d[i + 2] < 240) nonWhite++;
      }
    }
    out.pixelSample = { total: (d.length / 4), nonBlank, nonWhite, nonWhitePct: +((nonWhite / (d.length / 4)) * 100).toFixed(2), imgLoaded: img.width > 0 };
  } catch (e) { out.pixelSample = { error: String(e).slice(0, 120) }; }

  const z = doc.querySelector('.zoom-display');
  out.zoomText = z ? z.textContent : null;
  return out;
})()
