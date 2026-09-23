<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="utf-8"/>
    <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
    <title>${file.name}压缩包预览</title>
    <script src="js/jquery-3.6.1.min.js"></script>
    <#include "*/commonHeader.ftl">
    <script src="js/base64.min.js" type="text/javascript"></script>
    <link href="css/zTreeStyle.css" rel="stylesheet" type="text/css">
    <script type="text/javascript" src="js/jquery.ztree.core.js"></script>
    <style type="text/css">
        :root {
            --page-bg: #eef1f4;
            --page-accent: #d9dee5;
            --panel-bg: rgba(255, 255, 255, 0.92);
            --panel-strong: #ffffff;
            --panel-muted: #f5f7fa;
            --line: rgba(15, 23, 42, 0.12);
            --line-strong: rgba(15, 23, 42, 0.18);
            --text: #18212f;
            --text-muted: #5f6b7a;
            --text-soft: #8090a3;
            --brand: #3562ff;
            --brand-soft: rgba(53, 98, 255, 0.12);
            --good: #13795b;
            --warn: #b75a1a;
            --danger: #c23b3b;
            --shadow: 0 18px 48px rgba(15, 23, 42, 0.08);
            --radius-xl: 28px;
            --radius-lg: 20px;
            --radius-md: 14px;
            /* ★ 目录栏宽度 ★
               原来是 320px，在 iframe 里（尤其是窄窗口）显得很占地方，
               用户反馈「整体宽度减小」，故收窄到 244px；收起态同步
               从 68px 收到 56px。树节点本身是省略号截断的，收窄不会
               挤坏内容，只是让右侧预览区拿到更多空间。 */
            --sidebar-width: 244px;
            --sidebar-collapsed-width: 56px;
        }

        * {
            box-sizing: border-box;
        }

        html, body {
            height: 100%;
            overflow: hidden;
        }

        body {
            min-height: 100%;
            font-family: "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
            color: var(--text);
            background:
                radial-gradient(circle at top left, rgba(255, 255, 255, 0.65), transparent 36%),
                linear-gradient(180deg, #f8fafc 0%, var(--page-bg) 100%);
        }

        /* ★ 高度必须是「确定值」而不是 min-height ★
           这个页面运行在 iframe 里。早先 .compress-page / .workspace 用
           min-height:100vh，而 .preview-frame 用 height:100%：
           min-height 不会给后代一个可解析的高度基准，于是 height:100%
           退化成 auto → 再由 min-height:520px 兜底。
           结果是整页比 iframe 视口高，而 .workspace 又是 overflow:hidden，
           下半部分就被裁掉，露出大片空白（树里第一行只显示了半截）。
           改成 height:100vh + flex 链路全用确定高度后，内容正好铺满视口。 */
        .compress-shell {
            height: 100%;
            padding: 0;
            display: flex;
            flex-direction: column;
            overflow: hidden;
        }

        .compress-page {
            display: flex;
            flex-direction: column;
            gap: 0;
            height: 100%;
            flex: 1;
            min-height: 0;
            width: 100%;
            max-width: none;
            margin: 0 auto;
        }

        .workspace {
            display: grid;
            grid-template-columns: var(--sidebar-width) minmax(0, 1fr);
            gap: 0;
            flex: 1;
            min-height: 0;
            height: 100%;
            border: 1px solid var(--line);
            border-radius: 0;
            background: linear-gradient(180deg, rgba(255, 255, 255, 0.94), rgba(244, 247, 251, 0.98));
            box-shadow: var(--shadow);
            overflow: hidden;
            backdrop-filter: blur(10px);
        }

        .workspace.is-tree-collapsed {
            grid-template-columns: var(--sidebar-collapsed-width) minmax(0, 1fr);
        }

        .panel {
            display: flex;
            flex-direction: column;
            min-height: 0;
            border: 0;
            border-radius: 0;
            background: transparent;
            box-shadow: none;
            overflow: hidden;
            backdrop-filter: none;
        }

        .tree-panel {
            border-right: 1px solid var(--line);
            background: linear-gradient(180deg, rgba(255, 255, 255, 0.65), rgba(248, 250, 252, 0.92));
        }

        .tree-panel .panel-header {
            align-items: center;
            /* ★ 目录栏收窄后，标题 + 状态徽标 + 收起按钮挤在一行会溢出，
               改为纵向堆叠：第一行标题，第二行状态与按钮。★ */
            flex-direction: column;
            align-items: stretch;
            gap: 8px;
            padding: 12px 14px 10px;
        }

        .panel-header {
            display: flex;
            align-items: flex-start;
            justify-content: space-between;
            gap: 16px;
            padding: 14px 20px 10px;
            border-bottom: 1px solid var(--line);
            background: linear-gradient(180deg, rgba(255, 255, 255, 0.5), rgba(245, 247, 250, 0.72));
        }

        .tree-header-main {
            display: flex;
            align-items: center;
            min-width: 0;
            flex: 1;
        }

        .tree-header-actions {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 8px;
            flex-shrink: 0;
        }

        .panel-title {
            margin: 0;
            font-size: 18px;
            line-height: 1.2;
        }

        .preview-title-row {
            display: flex;
            align-items: baseline;
            gap: 8px;
            flex-wrap: wrap;
        }

        .panel-description {
            margin: 8px 0 0;
            font-size: 13px;
            line-height: 1.6;
            color: var(--text-muted);
        }

        .panel-description strong {
            color: var(--text);
        }

        .status-pill {
            display: inline-flex;
            align-items: center;
            gap: 8px;
            padding: 9px 12px;
            border-radius: 999px;
            background: var(--panel-muted);
            color: var(--text-muted);
            font-size: 12px;
            white-space: nowrap;
        }

        .status-pill::before {
            content: "";
            width: 8px;
            height: 8px;
            border-radius: 50%;
            background: currentColor;
            opacity: 0.85;
        }

        .status-pill.is-loading {
            color: var(--warn);
            background: rgba(183, 90, 26, 0.12);
        }

        .status-pill.is-ready {
            color: var(--good);
            background: rgba(19, 121, 91, 0.12);
        }

        .status-pill.is-error {
            color: var(--danger);
            background: rgba(194, 59, 59, 0.12);
        }

        .status-pill.is-preview {
            color: var(--brand);
            background: var(--brand-soft);
        }

        .sidebar-toggle {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 36px;
            height: 36px;
            border: 1px solid rgba(53, 98, 255, 0.16);
            border-radius: 12px;
            background: rgba(255, 255, 255, 0.86);
            color: var(--text-muted);
            cursor: pointer;
            transition: border-color 0.2s ease, background-color 0.2s ease, color 0.2s ease;
        }

        .sidebar-toggle:hover {
            border-color: rgba(53, 98, 255, 0.28);
            background: rgba(53, 98, 255, 0.08);
            color: var(--brand);
        }

        .sidebar-toggle-icon {
            font-size: 14px;
            line-height: 1;
        }

        .tree-panel-body {
            position: relative;
            display: flex;
            flex-direction: column;
            gap: 14px;
            padding: 18px 20px 20px;
            flex: 1;
            min-height: 0;
        }

        .workspace.is-tree-collapsed .tree-panel .panel-header {
            align-items: center;
            justify-content: center;
            padding: 14px 10px;
            border-bottom: 0;
            background: transparent;
        }

        .workspace.is-tree-collapsed .tree-panel .tree-header-main,
        .workspace.is-tree-collapsed .tree-panel #treeStatus,
        .workspace.is-tree-collapsed .tree-panel .tree-panel-body {
            display: none;
        }

        .workspace.is-tree-collapsed .tree-panel .tree-header-actions {
            width: 100%;
            justify-content: center;
        }

        .tree-summary {
            font-size: 13px;
            color: var(--text-soft);
        }

        .tree-shell {
            flex: 1;
            min-height: 0;
            padding: 10px 8px;
            border: 1px solid var(--line);
            border-radius: var(--radius-lg);
            background: rgba(255, 255, 255, 0.72);
            overflow: auto;
        }

        .state-block {
            display: flex;
            flex-direction: column;
            align-items: flex-start;
            justify-content: center;
            gap: 12px;
            padding: 22px 18px;
            border: 1px dashed var(--line-strong);
            border-radius: var(--radius-lg);
            background: rgba(255, 255, 255, 0.68);
            color: var(--text-muted);
        }

        .state-title {
            font-size: 16px;
            font-weight: 600;
            color: var(--text);
        }

        .state-text {
            font-size: 14px;
            line-height: 1.65;
        }

        .hidden {
            display: none !important;
        }

        .spinner {
            width: 20px;
            height: 20px;
            border: 3px solid rgba(53, 98, 255, 0.16);
            border-top-color: var(--brand);
            border-radius: 50%;
            animation: spin 0.9s linear infinite;
        }

        .btn-inline {
            padding: 9px 14px;
            border: 1px solid rgba(53, 98, 255, 0.18);
            border-radius: 999px;
            background: var(--brand-soft);
            color: var(--brand);
            font-size: 13px;
            cursor: pointer;
        }

        .btn-inline:hover {
            background: rgba(53, 98, 255, 0.18);
        }

        .preview-panel {
            min-width: 0;
            background: linear-gradient(180deg, rgba(255, 255, 255, 0.52), rgba(242, 246, 251, 0.9));
        }

        .preview-panel-body {
            position: relative;
            display: flex;
            flex-direction: column;
            flex: 1;
            min-height: 0;
            background: linear-gradient(180deg, rgba(248, 250, 252, 0.82), rgba(241, 245, 249, 0.94));
        }

        .preview-placeholder,
        .preview-empty {
            display: flex;
            align-items: center;
            justify-content: center;
            flex: 1;
            min-height: 0;
            padding: 28px;
        }

        .preview-card {
            max-width: 520px;
            padding: 28px;
            border: 1px solid var(--line);
            border-radius: var(--radius-lg);
            background: rgba(255, 255, 255, 0.92);
            box-shadow: 0 14px 36px rgba(15, 23, 42, 0.06);
        }

        .preview-card h3 {
            margin: 0 0 10px;
            font-size: 24px;
        }

        .preview-card p {
            margin: 0;
            font-size: 14px;
            line-height: 1.7;
            color: var(--text-muted);
        }

        .preview-card .preview-tips {
            margin-top: 16px;
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
        }

        .preview-card .preview-tips span {
            padding: 8px 10px;
            border-radius: 999px;
            background: var(--panel-muted);
            color: var(--text-muted);
            font-size: 12px;
        }

        .preview-frame-wrap {
            position: relative;
            flex: 1;
            min-height: 0;
        }

        .preview-loading {
            position: absolute;
            inset: 18px 18px auto;
            display: flex;
            align-items: center;
            gap: 10px;
            padding: 12px 14px;
            border: 1px solid rgba(53, 98, 255, 0.12);
            border-radius: 999px;
            background: rgba(255, 255, 255, 0.94);
            color: var(--brand);
            box-shadow: 0 14px 36px rgba(15, 23, 42, 0.08);
            z-index: 2;
        }

        .preview-frame {
            width: 100%;
            height: 100%;
            min-height: 0;
            border: 0;
            background: #ffffff;
        }

        .preview-frame.is-loading {
            opacity: 0;
        }

        .preview-file {
            font-size: 13px;
            color: var(--text-muted);
            word-break: break-all;
        }

        #treeDemo {
            margin-top: 0;
            width: 100%;
            color: var(--text);
        }

        #treeDemo li {
            margin: 2px 0;
        }

        #treeDemo li a {
            width: calc(100% - 8px);
            height: auto;
            min-height: 34px;
            padding: 6px 10px 6px 4px;
            border: 1px solid transparent;
            border-radius: 10px;
            position: relative;
            transition: background-color 0.2s ease, border-color 0.2s ease, color 0.2s ease;
        }

        #treeDemo li a:hover {
            background: rgba(53, 98, 255, 0.08);
            border-color: rgba(53, 98, 255, 0.12);
        }

        #treeDemo li a.curSelectedNode {
            height: auto;
            background: var(--brand-soft);
            border-color: rgba(53, 98, 255, 0.16);
            color: var(--brand);
            opacity: 1;
        }

        #treeDemo li a span.node_name {
            display: inline-block;
            max-width: calc(100% - 48px);
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            line-height: 1.6;
            font-size: 14px;
            vertical-align: middle;
        }

        #treeDemo span.button.switch {
            margin-right: 4px;
        }

        #treeDemo span.button.ico_docu,
        #treeDemo span.button.ico_open,
        #treeDemo span.button.ico_close {
            margin-right: 6px;
        }

        #treeDemo span.button.ico_docu {
            display: none;
        }

        #treeDemo li a .tree-file-icon {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 28px;
            height: 20px;
            margin-right: 8px;
            border-radius: 7px;
            font-size: 9px;
            font-weight: 700;
            line-height: 1;
            letter-spacing: 0.04em;
            color: #ffffff;
            vertical-align: middle;
            box-shadow: inset 0 -1px 0 rgba(15, 23, 42, 0.12);
        }

        #treeDemo li a .tree-file-icon.type-pdf {
            background: #e24b4b;
        }

        #treeDemo li a .tree-file-icon.type-word {
            background: #2b6fff;
        }

        #treeDemo li a .tree-file-icon.type-excel {
            background: #1f8f5f;
        }

        #treeDemo li a .tree-file-icon.type-ppt {
            background: #ea7a2f;
        }

        #treeDemo li a .tree-file-icon.type-image {
            background: #9b59ff;
        }

        #treeDemo li a .tree-file-icon.type-text {
            background: #5f6b7a;
        }

        #treeDemo li a .tree-file-icon.type-code {
            background: #0f766e;
        }

        #treeDemo li a .tree-file-icon.type-audio {
            background: #c66a14;
        }

        #treeDemo li a .tree-file-icon.type-video {
            background: #c03ddb;
        }

        #treeDemo li a .tree-file-icon.type-model3d {
            background: #0e7490;
        }

        #treeDemo li a .tree-file-icon.type-cad {
            background: #7a4bd0;
        }

        #treeDemo li a .tree-file-icon.type-archive {
            background: #7c5cfa;
        }

        #treeDemo li a .tree-file-icon.type-file {
            background: #7b8794;
        }

        #treeDemo li a.tree-leaf-link {
            margin-left: -6px;
            width: calc(100% - 2px);
        }

        @keyframes spin {
            from {
                transform: rotate(0deg);
            }

            to {
                transform: rotate(360deg);
            }
        }

        @media (max-width: 1080px) {
            /* 单列时两栏改为上下堆叠；用 minmax(0, ...) 保证各自可滚动而不是撑高整页 */
            .workspace {
                grid-template-columns: 1fr;
                grid-template-rows: minmax(0, 40%) minmax(0, 60%);
            }

            .workspace.is-tree-collapsed {
                grid-template-columns: 1fr;
                grid-template-rows: auto minmax(0, 1fr);
            }

            .tree-panel {
                border-right: 0;
                border-bottom: 1px solid var(--line);
            }

            .workspace.is-tree-collapsed .tree-panel {
                border-bottom: 1px solid var(--line);
            }

            .workspace.is-tree-collapsed .tree-panel .panel-header {
                justify-content: space-between;
                padding: 14px 20px 10px;
                border-bottom: 1px solid var(--line);
                background: linear-gradient(180deg, rgba(255, 255, 255, 0.5), rgba(245, 247, 250, 0.72));
            }

            .workspace.is-tree-collapsed .tree-panel .tree-header-main {
                display: block;
            }

            .workspace.is-tree-collapsed .tree-panel #treeStatus,
            .workspace.is-tree-collapsed .tree-panel .tree-panel-body {
                display: none;
            }
        }

        @media (max-width: 720px) {
            .compress-shell {
                padding: 0;
            }

            .compress-page {
                height: 100%;
            }

            .panel-header,
            .tree-panel-body {
                padding-left: 18px;
                padding-right: 18px;
            }

            .panel-header {
                flex-direction: column;
            }

            .preview-placeholder,
            .preview-empty {
                padding: 18px;
            }

            .preview-card {
                padding: 22px;
            }
        }
    </style>
</head>
<body class="compress-shell">
<div class="compress-page">
    <main class="workspace">
        <aside class="panel tree-panel">
            <div class="panel-header">
                <div class="tree-header-main">
                    <h2 class="panel-title">压缩包目录</h2>
                </div>
                <div class="tree-header-actions">
                    <span id="treeStatus" class="status-pill is-loading">目录加载中</span>
                    <button id="toggleTreePanel" class="sidebar-toggle" type="button" aria-expanded="true" aria-label="收起目录栏">
                        <span id="toggleTreePanelIcon" class="sidebar-toggle-icon">&lt;</span>
                    </button>
                </div>
            </div>

            <div class="tree-panel-body">
                <div id="treeSummary" class="tree-summary">正在准备目录结构...</div>

                <div id="treeLoading" class="state-block">
                    <div class="spinner"></div>
                    <div>
                        <div class="state-title">正在加载压缩包目录</div>
                        <div class="state-text">目录数据准备完成后，会在左侧展示文件树。你可以直接点击包内文件，在右侧查看预览。</div>
                    </div>
                </div>

                <div id="treeError" class="state-block hidden">
                    <div>
                        <div class="state-title">目录加载失败</div>
                        <div class="state-text">暂时无法读取压缩包目录结构，请稍后重试。</div>
                    </div>
                    <button id="retryTree" class="btn-inline" type="button">重新加载目录</button>
                </div>

                <div id="treeEmpty" class="state-block hidden">
                    <div class="state-title">目录为空</div>
                    <div class="state-text">当前压缩包内没有可展示的目录项。</div>
                </div>

                <div id="treeShell" class="tree-shell hidden">
                    <ul id="treeDemo" class="ztree"></ul>
                </div>
            </div>
        </aside>

        <section class="panel preview-panel">
            <div class="panel-header">
                <div>
                    <div class="preview-title-row">
                        <h2 class="panel-title">kkFileView</h2>
                        <p id="previewFile" class="preview-file">未选择文件</p>
                    </div>
                </div>
                <span id="previewStatus" class="status-pill">等待选择文件</span>
            </div>

            <div class="preview-panel-body">
                <div id="previewPlaceholder" class="preview-placeholder">
                    <div class="preview-card">
                        <h3>选择文件后可在此预览</h3>
                        <p>支持在当前页面预览压缩包内的文本、图片、PDF、Office 等文件。</p>
                        <div class="preview-tips">
                            <span>文本预览</span>
                            <span>图片预览</span>
                            <span>Office 预览</span>
                        </div>
                    </div>
                </div>

                <div id="previewFrameWrap" class="preview-frame-wrap hidden">
                    <div id="previewLoading" class="preview-loading hidden">
                        <div class="spinner"></div>
                        <span>预览加载中...</span>
                    </div>
                    <iframe id="previewFrame" class="preview-frame is-loading" title="压缩包内文件预览"></iframe>
                </div>
            </div>
        </section>
    </main>
</div>

<script>
    var zTreeObj;
    var treeNodes = [];
    var settings = {
        view: {
            selectedMulti: false,
            dblClickExpand: false,
            showLine: false,
            addDiyDom: decorateTreeNode
        },
        data: {
            simpleData: {
                enable: true,
                idKey: "id",
                pIdKey: "pid",
                rootPId: ""
            }
        },
        callback: {
            onClick: handleNodeClick
        }
    };

    var currentUrl = window.location.href;
    var keyword = getQueryParam(currentUrl, "watermarkTxt");
    var workspaceEl = document.querySelector(".workspace");
    var treeStatusEl = document.getElementById("treeStatus");
    var treeSummaryEl = document.getElementById("treeSummary");
    var treeLoadingEl = document.getElementById("treeLoading");
    var treeErrorEl = document.getElementById("treeError");
    var treeEmptyEl = document.getElementById("treeEmpty");
    var treeShellEl = document.getElementById("treeShell");
    var toggleTreePanelEl = document.getElementById("toggleTreePanel");
    var toggleTreePanelIconEl = document.getElementById("toggleTreePanelIcon");
    var previewStatusEl = document.getElementById("previewStatus");
    var previewFileEl = document.getElementById("previewFile");
    var previewPlaceholderEl = document.getElementById("previewPlaceholder");
    var previewFrameWrapEl = document.getElementById("previewFrameWrap");
    var previewFrameEl = document.getElementById("previewFrame");
    var previewLoadingEl = document.getElementById("previewLoading");

    function isNotEmpty(value) {
        return value !== null && value !== undefined && value !== "" && value !== 0 && !(value instanceof Array && value.length === 0) && !isNaN(value);
    }

    function getQueryParam(url, param) {
        var urlObj = new URL(url);
        return urlObj.searchParams.get(param);
    }

    function setTreeStatus(label, type) {
        treeStatusEl.textContent = label;
        treeStatusEl.className = "status-pill";
        if (type) {
            treeStatusEl.classList.add(type);
        }
    }

    function showTreeState(state) {
        treeLoadingEl.classList.toggle("hidden", state !== "loading");
        treeErrorEl.classList.toggle("hidden", state !== "error");
        treeEmptyEl.classList.toggle("hidden", state !== "empty");
        treeShellEl.classList.toggle("hidden", state !== "ready");
    }

    function setPreviewStatus(label, type) {
        previewStatusEl.textContent = label;
        previewStatusEl.className = "status-pill";
        if (type) {
            previewStatusEl.classList.add(type);
        }
    }

    function setPreviewFile(name) {
        previewFileEl.textContent = name || "未选择文件";
    }

    function setTreeCollapsed(collapsed) {
        workspaceEl.classList.toggle("is-tree-collapsed", collapsed);
        toggleTreePanelEl.setAttribute("aria-expanded", collapsed ? "false" : "true");
        toggleTreePanelEl.setAttribute("aria-label", collapsed ? "展开目录栏" : "收起目录栏");
        toggleTreePanelIconEl.textContent = collapsed ? ">" : "<";
    }

    function isDirectoryNode(node) {
        return !!node && Array.isArray(node.children);
    }

    function countTreeStats(nodes) {
        var stats = { folders: 0, files: 0 };
        var queue = [].concat(nodes || []);
        while (queue.length) {
            var node = queue.shift();
            if (!node) {
                continue;
            }
            if (isDirectoryNode(node)) {
                stats.folders += 1;
                queue = queue.concat(node.children);
            } else {
                stats.files += 1;
            }
        }
        return stats;
    }

    function getFileExtension(name) {
        if (!name || name.lastIndexOf(".") === -1) {
            return "";
        }
        return name.substring(name.lastIndexOf(".") + 1).toLowerCase();
    }

    function getFileTypeMeta(name) {
        var extension = getFileExtension(name);
            var groups = {
                pdf: ["pdf"],
                word: ["doc", "docx", "wps", "odt", "rtf"],
                excel: ["xls", "xlsx", "csv", "et", "ods"],
                ppt: ["ppt", "pptx", "dps", "odp"],
                image: ["png", "jpg", "jpeg", "gif", "bmp", "webp", "svg", "tif", "tiff"],
                text: ["txt", "md", "log", "ini", "properties", "yaml", "yml", "json"],
                code: ["java", "js", "ts", "jsx", "tsx", "html", "htm", "css", "scss", "xml", "sql", "py", "go", "sh", "vue"],
                audio: ["mp3", "wav", "aac", "flac", "ogg", "m4a"],
                video: ["mp4", "mov", "avi", "mkv", "wmv", "flv", "webm"],
                // ★ CAD / 3D 模型 ★
                //   压缩包里 3D 文件很常见（step/stp/igs/stl/obj/3mf/gltf...），
                //   早先没有这一组，它们会落到兜底的
                //   `extension.slice(0,4).toUpperCase()`，既没有配色也容易
                //   被当成未知类型。这里单独归组，标签统一显示 "3D"。
                //   注意大小写：getFileExtension() 已 toLowerCase()，
                //   所以 .STEP / .STP 都能命中。
                model3d: ["step", "stp", "iges", "igs", "brep", "brp", "stl", "obj", "off", "ply", "3mf", "amf", "gltf", "glb", "fbx", "dae", "3ds", "3dm", "wrl", "bim", "ifc", "fcstd"],
                // ★ CAD 二维图纸（kkFileView 走独立的 cad-viewer 服务）★
                cad: ["dwg", "dxf"],
                archive: ["zip", "rar", "7z", "tar", "gz", "bz2", "xz"]
            };
            var labels = {
                pdf: "PDF",
                word: "DOC",
                excel: "XLS",
                ppt: "PPT",
                image: "IMG",
                text: "TXT",
                code: "CODE",
                audio: "AUDIO",
                video: "VIDEO",
                model3d: "3D",
                cad: "CAD",
                archive: "ZIP",
                file: "FILE"
            };
        for (var type in groups) {
            if (groups[type].indexOf(extension) > -1) {
                return { type: type, label: labels[type] };
            }
        }
        return { type: "file", label: extension ? extension.slice(0, 4).toUpperCase() : labels.file };
    }

    function normalizeTreeNodes(nodes) {
        (nodes || []).forEach(function (node) {
            if (isDirectoryNode(node)) {
                node.isParent = true;
                normalizeTreeNodes(node.children);
                return;
            }
            node.fileTypeMeta = getFileTypeMeta(node.name);
        });
        return nodes;
    }

    function decorateTreeNode(treeId, treeNode) {
        if (isDirectoryNode(treeNode)) {
            return;
        }
        var anchor = $("#" + treeNode.tId + "_a");
        if (!anchor.length || anchor.find(".tree-file-icon").length) {
            return;
        }
        anchor.addClass("tree-leaf-link");
        var nameEl = $("#" + treeNode.tId + "_span");
        var typeMeta = treeNode.fileTypeMeta || getFileTypeMeta(treeNode.name);
        var icon = $('<span class="tree-file-icon"></span>');
        icon.addClass("type-" + typeMeta.type);
        icon.text(typeMeta.label);
        nameEl.before(icon);
    }

    function updateTreeSummary(nodes) {
        var stats = countTreeStats(nodes);
        treeSummaryEl.textContent = "共 " + stats.folders + " 个目录，" + stats.files + " 个文件。";
    }

    /* ------------------------------------------------------------------
       压缩包成员预览地址

       ★ 上游原实现有三个坑，这里一并修掉（用户反馈：压缩包内文件预览不了，
         报 The remote server refused to fulfill the request / CORS）★

       原实现：
         var path = '${baseUrl}' + treeNode.id + "?kkCompressfileKey=" + '${fileTree}' + ...

       坑 1 —— 服务端回拉失败（CORS 表象的真因）
         `${baseUrl}` 被注入成「浏览器访问源 + /preview」，例如
         http://127.0.0.1:8089/preview。但 kkFileView 拿到这条 URL 后是
         **在服务端**去 GET 的（getCorsFile）。容器里 127.0.0.1:8089 没有监听
         （8089 只是宿主机端口映射），于是必然 Connection refused。
         实测日志：
             Connect to http://127.0.0.1:8089 failed: Connection refused

         修法：不再自己拼绝对主机，改用**相对路径**（见下面 urlPath）。
         相对路径交给浏览器解析时指向当前源，天然正确；
         而 kkFileView 需要回拉的那一段，由网关在反代时改写成内网地址
         （见 nebula/app/main.py 的 proxy_preview）。

       坑 2 —— 文件名含 `#` 直接崩
         treeNode.id 原样拼进 URL，遇到 `1.2.14.TFDF-6# F向.zip` 这种名字，
         `#` 被当成 fragment 起点，Java 抛：
             java.net.URISyntaxException: Illegal character in fragment
         修法：对 treeNode.id 做 encodeURIComponent（保留 / 以便表达目录层级）。

       坑 3 —— 绝对地址写死 127.0.0.1
         NAS 上用户用 192.168.x.x 访问时，会把请求打到**用户自己的电脑**上。
         相对路径一并解决这个问题。

       注意 encodeURIComponent 会把 `/` 也编码成 %2F，
       而 kkCompressfileKey 机制需要保留目录层级（服务端按 `压缩包名_/内部路径`
       拆分）。所以用 encodeURI 后再补掉 `#`、`?`、空格等会破坏 URL 的字符。
       ------------------------------------------------------------------ */
    function encodeMemberPath(p) {
        // encodeURI 保留 / : @ 等结构字符，但**不**编码 # ? 空格的中文等；
        // 这里手动补编码那些会截断 URL 的字符。
        return encodeURI(p)
            .replace(/#/g, '%23')
            .replace(/\?/g, '%3F')
            .replace(/ /g, '%20');
    }

    function buildPreviewUrl(treeNode) {
        var memberPath = encodeMemberPath(treeNode.id);
        var zipKey = encodeMemberPath('${fileTree}');

        /* ==================================================================
           ★ 压缩包成员地址为什么必须用 kkFileView **自己的根地址** ★

           成员文件在解压后被放在：
               <fileDir>/<压缩包名>_/<包内路径>
           例如
               /opt/kkFileView-5.0.2/file/00-Q3-1250.zip_/00-Q3-1250.stp

           而 kkFileView 的 WebConfig 把 `/**` 映射到了
               "file:" + fileDir
           也就是说这些文件是**由 kkFileView 自己当静态资源**服务的。

           ⇒ 成员地址必须是：
                  http://<kkFileView 自己>:<端口>/<压缩包名>_/<包内路径>

           为什么不能用网关地址 `http://nebula:8088/preview/`（曾经这么写）：
           实测（两个压缩包 × 三种 base）：
               00-Q3-1250.zip          + nebula:8088/preview/  → 200 ✅ 48,996,086 B
               1.2.14.TFDF-6# F向.zip  + nebula:8088/preview/  → 404 ❌
               00-Q3-1250.zip          + 127.0.0.1:8012/       → 200 ✅ 48,996,086 B
               1.2.14.TFDF-6# F向.zip  + 127.0.0.1:8012/       → 200 ✅  3,709,570 B

           即：**经过网关时，含 `#` 的压缩包必然 404；直连 kkFileView 根地址
           则两个都成功。** 这正是用户报的「一个压缩包能预览、一个不能」。

           根因：网关的 /preview/ 前缀并不是 kkFileView 的路由（kkFileView
           把它当普通路径段），而且 `#` 在再解析一轮后会被截断。kkFileView
           自己的根地址不经过这一层重新解析，所以稳定。

           ⇒ 所以这里**不要**任何「浏览器可达」的 base，直接写 kkFileView
             的容器内地址；这个 URL 只会被 kkFileView 服务端/同源浏览器使用。
           ================================================================== */
        var serverBase = '__SERVER_BASE_URL__';
        if (serverBase.indexOf('__SERVER') === 0 || serverBase === '') {
            // 退化为同源相对路径（直接访问 kkFileView 原生端口时）
            serverBase = '/';
        }

        var path = serverBase + memberPath
                 + "?kkCompressfileKey=" + zipKey
                 + "&kkCompressfilepath=" + encodeURIComponent(treeNode.id)
                 + "&fullfilename=" + encodeURIComponent(treeNode.name);
        var previewUrl = "${baseUrl}onlinePreview?url=" + encodeURIComponent(Base64.encode(path));
        if (isNotEmpty(keyword)) {
            previewUrl += "&watermarkTxt=" + encodeURIComponent(keyword);
        }
        previewUrl += "&key=${kkkey}";
        return previewUrl;
    }

    function showPreviewPlaceholder() {
        previewPlaceholderEl.classList.remove("hidden");
        previewFrameWrapEl.classList.add("hidden");
        previewLoadingEl.classList.add("hidden");
        previewFrameEl.classList.add("is-loading");
        previewFrameEl.removeAttribute("src");
        setPreviewFile("");
        setPreviewStatus("等待选择文件", "");
    }

    function loadPreview(treeNode) {
        previewPlaceholderEl.classList.add("hidden");
        previewFrameWrapEl.classList.remove("hidden");
        previewLoadingEl.classList.remove("hidden");
        previewFrameEl.classList.add("is-loading");
        setPreviewFile(treeNode.name);
        setPreviewStatus("正在加载预览", "is-preview");
        previewFrameEl.src = buildPreviewUrl(treeNode);
    }

    function handleNodeClick(event, treeId, treeNode) {
        if (isDirectoryNode(treeNode)) {
            zTreeObj.expandNode(treeNode, !treeNode.open, false, false, false);
            return false;
        }
        loadPreview(treeNode);
        return true;
    }

    function expandTopLevelNodes() {
        if (!zTreeObj || !treeNodes || !treeNodes.length) {
            return;
        }
        treeNodes.forEach(function (item) {
            var node = zTreeObj.getNodeByParam("id", item.id);
            if (node) {
                zTreeObj.expandNode(node, true, false, false, false);
            }
        });
    }

    function initTree(res) {
        treeNodes = normalizeTreeNodes(res || []);
        if (!treeNodes.length) {
            showTreeState("empty");
            setTreeStatus("目录为空", "is-error");
            treeSummaryEl.textContent = "当前压缩包内没有可展示的目录项。";
            return;
        }
        zTreeObj = $.fn.zTree.init($("#treeDemo"), settings, treeNodes);
        expandTopLevelNodes();
        updateTreeSummary(treeNodes);
        showTreeState("ready");
        setTreeStatus("目录已就绪", "is-ready");
    }

    function loadTree() {
        var url = "http://" + '${fileTree}';
        setTreeStatus("目录加载中", "is-loading");
        treeSummaryEl.textContent = "正在准备目录结构...";
        showTreeState("loading");
        $.ajax({
            type: "get",
            url: "${baseUrl}directory?urls=" + encodeURIComponent(Base64.encode(url)),
            success: function (res) {
                initTree(res);
            },
            error: function () {
                showTreeState("error");
                setTreeStatus("目录加载失败", "is-error");
                treeSummaryEl.textContent = "目录读取失败，请重试。";
            }
        });
    }

    document.getElementById("retryTree").addEventListener("click", function () {
        loadTree();
    });

    toggleTreePanelEl.addEventListener("click", function () {
        setTreeCollapsed(!workspaceEl.classList.contains("is-tree-collapsed"));
    });

    previewFrameEl.addEventListener("load", function () {
        previewLoadingEl.classList.add("hidden");
        previewFrameEl.classList.remove("is-loading");
        setPreviewStatus("预览已加载", "is-ready");
    });

    $(document).ready(function () {
        setTreeCollapsed(false);
        showPreviewPlaceholder();
        loadTree();
    });

    window.onload = function () {
        initWaterMark();
    };
</script>
</body>
</html>
