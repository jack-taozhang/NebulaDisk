<!DOCTYPE HTML>
<html>
<head>
    <title><#if file.name??>${file.name}<#else>文件预览</#if></title>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no" />
    <#include "*/commonHeader.ftl">
    <script src="js/jquery-3.6.1.min.js" type="text/javascript"></script>
    <script src="js/base64.min.js"></script>
    <style>
        #container {
            width: 100%;
            height: 100vh;
            overflow: hidden;
            position: relative;
            background: #f5f5f5;
        }
        
        #svg-container {
            position: absolute;
            top: 0;
            left: 0;
            transition: transform 0.3s ease;
        }
        
        #svg-container svg {
            display: block;
            max-width: 100%;
            max-height: 100%;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
        }
        
        .controls {
            position: fixed;
            bottom: 20px;
            right: 20px;
            display: flex;
            gap: 10px;
            z-index: 1000;
            background: rgba(255, 255, 255, 0.9);
            padding: 10px;
            border-radius: 8px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
        }
        
        .control-btn {
            width: 40px;
            height: 40px;
            border: none;
            border-radius: 50%;
            background: #007bff;
            color: white;
            font-size: 18px;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            transition: all 0.2s;
        }
        
        .control-btn:hover {
            background: #0056b3;
            transform: scale(1.1);
        }
        
        .control-btn:active {
            transform: scale(0.95);
        }
        
        .control-btn.reset {
            background: #6c757d;
        }
        
        .control-btn.reset:hover {
            background: #545b62;
        }
        
        .zoom-display {
            position: fixed;
            top: 20px;
            right: 20px;
            background: rgba(255, 255, 255, 0.9);
            padding: 8px 16px;
            border-radius: 20px;
            font-size: 14px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
            z-index: 1000;
        }
        
        .loading {
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            font-size: 18px;
            color: #666;
        }
    </style>
	   <#if currentUrl?contains("http://") || currentUrl?contains("https://") || currentUrl?contains("file://")|| currentUrl?contains("ftp://")>
        <#assign finalUrl="${currentUrl}">
    <#else>
        <#assign finalUrl="${baseUrl}${currentUrl}">
    </#if>
</head>
<body>
<div id="container">
    <div id="svg-container"></div>
    <div class="zoom-display">缩放: 100%</div>
    <div class="loading">正在加载SVG...</div>
    <div class="controls">
        <button class="control-btn" onclick="zoomIn()" title="放大">+</button>
        <button class="control-btn" onclick="zoomOut()" title="缩小">-</button>
        <button class="control-btn" onclick="rotateLeft()" title="向左旋转">↶</button>
        <button class="control-btn" onclick="rotateRight()" title="向右旋转">↷</button>
        <button class="control-btn reset" onclick="resetView()" title="重置视图">⟳</button>
    </div>
</div>

<script type="text/javascript">
    // 初始化变量
    let svgElement = null;
    let svgContainer = document.getElementById('svg-container');
    let container = document.getElementById('container');
    let zoomLevel = 1;
    let rotationAngle = 0;
    let minZoom = 0.1;
    let maxZoom = 10;
    let zoomStep = 0.2;
    // ★ CAD 类图纸的「适应窗口」比例。由 SVG 固有尺寸与容器尺寸算得。
    //   放在这里是因为它的语义和 100% 不同：100% == 1 个 SVG 用户单位 = 1 CSS px。
    let fitZoom = 1;
    // 是否还在等容器拿到尺寸（此时 fitZoom 未定，需要重试）
    let pendingFit = false;
    // 用户是否手动动过视图（滚轮/按钮/拖拽）。动过之后就不再用 fitZoom 覆盖。
    let userAdjusted = false;
    let isDragging = false;
    let startX, startY, startTranslateX, startTranslateY;
    let panStartX, panStartY;
	let url = '${finalUrl}';
	var kkagent = '${kkagent}';
    var baseUrl = '${baseUrl}'.endsWith('/') ? '${baseUrl}' : '${baseUrl}' + '/';
    if (kkagent === 'true' || !url.startsWith(baseUrl)) {
        url = baseUrl + 'getCorsFile?urlPath=' + encodeURIComponent(Base64.encode(url))+ "&key=${kkkey}";
    }

    // ★ 从 SVG 根元素上解析固有尺寸与 viewBox ★
    //   Aspose.CAD 转出来的 SVG 只有 width/height（本例 1604832 × 765792），
    //   且 **不带 viewBox**。此时给 svg 设 style.width='100%' 毫无意义：
    //   浏览器没有 viewBox 可做等比映射，就按 1 用户单位 = 1 CSS px 渲染，
    //   1200px 的窗口只能看到图纸的 0.075%，肉眼看就是「一片空白」。
    //   解决办法：把 width/height 归一化成 viewBox，让 100% 真正生效。
    function readSvgIntrinsicSize(svg) {
        var w = parseFloat(svg.getAttribute('width'));
        var h = parseFloat(svg.getAttribute('height'));
        var vb = (svg.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);

        if (vb.length === 4 && vb.every(function (v) { return isFinite(v); }) && vb[2] > 0 && vb[3] > 0) {
            return { x: vb[0], y: vb[1], w: vb[2], h: vb[3], hadViewBox: true };
        }
        if (isFinite(w) && isFinite(h) && w > 0 && h > 0) {
            return { x: 0, y: 0, w: w, h: h, hadViewBox: false };
        }
        // 实在没有尺寸信息，退回到 CSS 尺寸兜底，避免整页空白。
        var r = svg.getBoundingClientRect();
        return { x: 0, y: 0, w: r.width || 1000, h: r.height || 1000, hadViewBox: false };
    }

    // 加载并显示SVG
    function loadSVG() {
        if (!url) {
            showError('URL参数缺失');
            return;
        }
        
        fetch(url)
            .then(response => {
                if (!response.ok) {
                    throw new Error('网络响应不正常');
                }
                return response.text();
            })
            .then(svgText => {
                document.querySelector('.loading').style.display = 'none';
                svgContainer.innerHTML = svgText;
                svgElement = svgContainer.querySelector('svg');
                
                if (svgElement) {
                    // ★ 关键修复：把固有尺寸写进 viewBox ★
                    //   这是让 style.width='100%' 生效的前提；缺了它，
                    //   上面的 100% 会被当成 1:1 像素尺寸，图纸看起来是空白。
                    var size = readSvgIntrinsicSize(svgElement);
                    if (!size.hadViewBox || svgElement.getAttribute('viewBox') === '') {
                        svgElement.setAttribute(
                            'viewBox',
                            size.x + ' ' + size.y + ' ' + size.w + ' ' + size.h
                        );
                    }
                    // 去掉可能存在的 max-width/max-height 限制（CSS 里为了别的用途留着），
                    // 否则 100% 会被 CSS 的 max-* 再截一刀。
                    svgElement.style.maxWidth = 'none';
                    svgElement.style.maxHeight = 'none';
                    svgElement.style.display = 'block';

                    // ★ 改用「适应窗口」而不是 1:1 ★
                    //   图纸实际尺寸（size.w × size.h）往往上百万像素，
                    //   直接把 style.width 设成 100% 时，若外层没有确定尺寸，
                    //   仍会退化成固有尺寸。所以这里显式计算 fitZoom。
                    svgElement.style.transformOrigin = 'center center';

                    // 重置视图（内含 fitZoom 计算）
                    resetView();

                    // 记录固有尺寸，供 resetView / 缩放使用
                    svgElement.__intrinsic = size;
                    
                    // 添加拖拽功能
                    setupDragAndDrop();
                    
                    // 添加鼠标滚轮缩放
                    setupWheelZoom();
                    
                    // 添加键盘快捷键
                    setupKeyboardShortcuts();
                    
                    // 添加触摸事件支持
                    setupTouchEvents();
                    
                    // 初始更新显示
                    updateDisplay();
                } else {
                    showError('SVG解析失败');
                }
            })
            .catch(error => {
                console.error('加载SVG失败:', error);
                showError('加载SVG文件失败: ' + error.message);
            });
    }

    // 显示错误信息
    function showError(message) {
        document.querySelector('.loading').style.display = 'none';
        svgContainer.innerHTML = '<div style="color: red; text-align: center; padding: 50px; font-size: 16px;">' + message + '</div>';
    }

    // 设置拖拽功能
    function setupDragAndDrop() {
        svgContainer.addEventListener('mousedown', startDrag);
        document.addEventListener('mousemove', drag);
        document.addEventListener('mouseup', stopDrag);
    }

    // 设置触摸事件
    function setupTouchEvents() {
        svgContainer.addEventListener('touchstart', handleTouchStart, { passive: false });
        svgContainer.addEventListener('touchmove', handleTouchMove, { passive: false });
        svgContainer.addEventListener('touchend', handleTouchEnd);
    }

    // 处理触摸开始
    function handleTouchStart(e) {
        if (e.touches.length === 1) {
            isDragging = true;
            panStartX = e.touches[0].clientX;
            panStartY = e.touches[0].clientY;
            
            const transform = svgContainer.style.transform;
            const match = transform.match(/translate\(([^)]+)\)/);
            if (match) {
                const parts = match[1].split(',');
                startTranslateX = parseFloat(parts[0]) || 0;
                startTranslateY = parseFloat(parts[1]) || 0;
            } else {
                startTranslateX = 0;
                startTranslateY = 0;
            }
            
            e.preventDefault();
        } else if (e.touches.length === 2) {
            e.preventDefault();
        }
    }

    // 处理触摸移动
    function handleTouchMove(e) {
        if (!isDragging || e.touches.length !== 1) return;
        
        const dx = e.touches[0].clientX - panStartX;
        const dy = e.touches[0].clientY - panStartY;
        
        updateTransform(startTranslateX + dx, startTranslateY + dy);
        e.preventDefault();
    }

    // 处理触摸结束
    function handleTouchEnd(e) {
        isDragging = false;
    }

    // 鼠标拖拽开始
    function startDrag(e) {
        isDragging = true;
        startX = e.clientX;
        startY = e.clientY;
        
        const transform = svgContainer.style.transform;
        const match = transform.match(/translate\(([^)]+)\)/);
        if (match) {
            const parts = match[1].split(',');
            startTranslateX = parseFloat(parts[0]) || 0;
            startTranslateY = parseFloat(parts[1]) || 0;
        } else {
            startTranslateX = 0;
            startTranslateY = 0;
        }
        
        svgContainer.style.cursor = 'grabbing';
    }

    // 拖拽中
    function drag(e) {
        if (!isDragging) return;
        
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        
        updateTransform(startTranslateX + dx, startTranslateY + dy);
    }

    // 停止拖拽
    function stopDrag() {
        isDragging = false;
        svgContainer.style.cursor = 'grab';
    }

    // 设置鼠标滚轮缩放
    function setupWheelZoom() {
        svgContainer.addEventListener('wheel', function(e) {
            e.preventDefault();
            
            // 滚轮是用户主动操作，标记一下，之后 resetView 也要尊重它。
            userAdjusted = true;

            const rect = svgContainer.getBoundingClientRect();
            const mouseX = e.clientX - rect.left;
            const mouseY = e.clientY - rect.top;
            
            const delta = e.deltaY > 0 ? -zoomStep : zoomStep;
            const newZoom = Math.min(maxZoom, Math.max(minZoom, zoomLevel + delta));
            
            // 获取当前变换
            const transform = svgContainer.style.transform;
            let translateX = 0, translateY = 0;
            const match = transform.match(/translate\(([^)]+)\)/);
            if (match) {
                const parts = match[1].split(',');
                translateX = parseFloat(parts[0]) || 0;
                translateY = parseFloat(parts[1]) || 0;
            }
            
            // 计算缩放中心点相对于容器中心的位置
            const centerX = rect.width / 2;
            const centerY = rect.height / 2;
            const offsetX = mouseX - centerX;
            const offsetY = mouseY - centerY;
            
            // 更新缩放级别
            const zoomChange = newZoom / zoomLevel;
            zoomLevel = newZoom;
            
            // 调整位置以保持鼠标点位置不变
            translateX = translateX - offsetX * (zoomChange - 1);
            translateY = translateY - offsetY * (zoomChange - 1);
            
            updateTransform(translateX, translateY);
            updateDisplay();
        });
    }

    // 设置键盘快捷键
    function setupKeyboardShortcuts() {
        document.addEventListener('keydown', function(e) {
            // 避免在输入框中触发快捷键
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
            
            switch(e.key) {
                case '+':
                case '=':
                    if (e.ctrlKey || e.metaKey) {
                        e.preventDefault();
                        zoomIn();
                    }
                    break;
                case '-':
                case '_':
                    if (e.ctrlKey || e.metaKey) {
                        e.preventDefault();
                        zoomOut();
                    }
                    break;
                case '0':
                    if (e.ctrlKey || e.metaKey) {
                        e.preventDefault();
                        resetView();
                    }
                    break;
                case '[':
                    if (e.ctrlKey || e.metaKey) {
                        e.preventDefault();
                        rotateLeft();
                    }
                    break;
                case ']':
                    if (e.ctrlKey || e.metaKey) {
                        e.preventDefault();
                        rotateRight();
                    }
                    break;
            }
        });
    }

    // 放大
    function zoomIn() {
        // ★ 相对于「适应窗口」基准放大，而不是相对于 1:1 ★
        //   否则面对 160 万像素宽的图纸，1.2 倍仍然看不到任何东西。
        userAdjusted = true;
        zoomLevel = Math.min(maxZoom, zoomLevel * (1 + zoomStep));
        updateTransform();
        updateDisplay();
    }

    // 缩小
    function zoomOut() {
        userAdjusted = true;
        zoomLevel = Math.max(minZoom, zoomLevel / (1 + zoomStep));
        updateTransform();
        updateDisplay();
    }

    // 向左旋转
    function rotateLeft() {
        rotationAngle -= 90;
        updateTransform();
    }

    // 向右旋转
    function rotateRight() {
        rotationAngle += 90;
        updateTransform();
    }

    // ★ 计算「适应窗口」比例 ★
    //   把固有尺寸映射到容器可视尺寸。CAD 图纸固有尺寸动辄上百万 px，
    //   不这么做就是「明明转出来了，屏幕上却什么都没有」。
    function computeFitZoom() {
        if (!svgElement) return 1;
        var size = svgElement.__intrinsic || readSvgIntrinsicSize(svgElement);
        var cw = container.clientWidth || container.getBoundingClientRect().width || 0;
        var ch = container.clientHeight || container.getBoundingClientRect().height || 0;
        if (!size.w || !size.h) return 1;

        // ★ 容器还没拿到尺寸（0×0）时**不能**退回 1 ★
        //   退回 1 意味着「1 用户单位 = 1px」，对百万像素图纸就是彻底空白。
        //   更糟的是算出接近 0 的比例（如 0.96px 宽）。两种都是错的。
        //   这里统一返回 null，交给调用方走「等尺寸就绪再算」的路径。
        if (cw <= 0 || ch <= 0) return null;

        // 留 4% 边距避免贴边。
        var pad = 0.96;
        var z = Math.min((cw * pad) / size.w, (ch * pad) / size.h);
        // 单调边界保护：极端长条图纸不要缩到看不见
        if (!isFinite(z) || z <= 0) return null;
        return z;
    }

    // 重置视图
    function resetView() {
        rotationAngle = 0;
        userAdjusted = false;

        var fz = computeFitZoom();
        if (fz === null) {
            // 容器暂无尺寸：先把 svg 保持「占满容器」状态（不设死像素尺寸），
            // 等 resize / 首次有效布局回调里再算。
            if (svgElement) {
                svgElement.style.width = '100%';
                svgElement.style.height = '100%';
            }
            pendingFit = true;
            updateDisplay();
            return;
        }
        pendingFit = false;
        fitZoom = fz;
        // ★ zoomLevel 的语义是「相对 fitZoom 的倍数」，不是绝对比例 ★
        //   fitZoom 只通过 svg 的 style.width/height 生效一次；
        //   transform 上的 scale 必须从 1 开始，否则同一个比例会被乘两遍
        //   （958px × 0.000597 ≈ 0.6px，图纸直接缩成一个点 —— 就是本 bug）。
        zoomLevel = 1;

        // 把「适应窗口」的比例固化到 svg 的实际像素尺寸上。
        // 这是唯一应用 fitZoom 的地方。
        if (svgElement) {
            var size = svgElement.__intrinsic || readSvgIntrinsicSize(svgElement);
            svgElement.style.width = (size.w * fitZoom) + 'px';
            svgElement.style.height = (size.h * fitZoom) + 'px';
        }

        // 计算居中位置
        const containerRect = container.getBoundingClientRect();
        if (svgElement) {
            const svgRect = svgContainer.getBoundingClientRect();
            const translateX = (containerRect.width - svgRect.width) / 2;
            const translateY = (containerRect.height - svgRect.height) / 2;
            updateTransform(translateX, translateY);
        } else {
            updateTransform(0, 0);
        }
        
        updateDisplay();
    }

    // 更新变换
    function updateTransform(translateX, translateY) {
        let transform = '';
        
        // 如果有传入的平移值，使用它
        if (translateX !== undefined && translateY !== undefined) {
            transform += 'translate(' + translateX + 'px, ' + translateY + 'px)';
        } else {
            // 否则保持当前的平移
            const currentTransform = svgContainer.style.transform;
            const match = currentTransform.match(/translate\(([^)]+)\)/);
            if (match) {
                transform += match[0];
            } else {
                transform += 'translate(0px, 0px)';
            }
        }

        // ★ 缩放策略（务必别改错）★
        //   fitZoom 已经固化进 svg 的 style.width/height，**只生效一次**。
        //   所以 transform 里的 scale 只放「相对 fitZoom 的倍数」zoomLevel。
        //   若这里再乘 fitZoom，就会变成 fitZoom² —— 图纸缩成一个小点。
        //   resetView 把 zoomLevel 置 1 → 此时不该输出 scale（保持 transform 干净）。
        if (zoomLevel !== 1 && isFinite(zoomLevel) && zoomLevel > 0) {
            transform += ' scale(' + zoomLevel + ')';
        }
        
        // 应用旋转
        if (rotationAngle !== 0) {
            transform += ' rotate(' + rotationAngle + 'deg)';
        }
        
        svgContainer.style.transform = transform;
    }

    // 更新显示
    function updateDisplay() {
        var zoomDisplay = document.querySelector('.zoom-display');
        if (zoomDisplay) {
            // ★ 显示「相对适应窗口」的百分比，配合括注真实比例 ★
            //   图纸固有尺寸上百万 px 时，真实比例会是 0.1% 这种反直觉数字；
            //   只显示它会让人以为坏了。所以主显示用相对值（适应窗口=100%），
            //   再括注真实屏幕比例，两者都给到，谁都不会误解。
            var relPct = Math.round(zoomLevel * 100);
            var realPct = zoomLevel * (fitZoom || 1) * 100;
            var realStr = realPct >= 1
                ? Math.round(realPct) + '%'
                : (Math.round(realPct * 10) / 10) + '%';

            var displayText = '缩放: ' + relPct + '%';
            if (pendingFit) {
                displayText = '适配中…';
            } else if (Math.abs(zoomLevel - 1) > 0.02) {
                displayText += ' (实际 ' + realStr + ')';
            }
            if (rotationAngle !== 0) {
                // 将角度规范到0-360度
                var normalizedAngle = ((rotationAngle % 360) + 360) % 360;
                displayText += ' | 旋转: ' + normalizedAngle + '°';
            }
            zoomDisplay.textContent = displayText;
        }
    }

    // 页面加载完成后初始化
    window.onload = function () {
        // 设置初始光标
        svgContainer.style.cursor = 'grab';
        
        // 加载SVG
        loadSVG();
        
        // 如果有水印初始化函数，调用它
        if (typeof initWaterMark === 'function') {
            initWaterMark();
        }

        // ★ 窗口尺寸变化时重新适配 ★
        //   预览窗口可以最大化/拖动，容器一变，「适应窗口」的比例就得跟着变，
        //   否则最大化后图纸只占左上角一小块。用户手动调过视图则尊重其选择。
        var resizeTimer = null;
        window.addEventListener('resize', function () {
            if (userAdjusted) return;
            clearTimeout(resizeTimer);
            resizeTimer = setTimeout(function () {
                if (userAdjusted || !svgElement) return;
                resetView();
            }, 150);
        });

        // ★ 首帧可能拿不到容器尺寸（iframe 尚未参与布局等）★
        //   此时 computeFitZoom 返回 null、fitZoom 未定，图纸会保持 100%
        //   也就是对百万像素图纸「空白」。这里轮询等尺寸就绪后补算一次，
        //   最多等约 3 秒；期间用户若已手动操作则让位。
        var fitTries = 0;
        (function waitForSize() {
            if (!pendingFit || userAdjusted || !svgElement || fitTries > 30) return;
            fitTries++;
            var cw = container.clientWidth || 0;
            var ch = container.clientHeight || 0;
            if (cw > 0 && ch > 0) {
                resetView();
                return;
            }
            setTimeout(waitForSize, 100);
        })();
    }
</script>
</body>
</html>
