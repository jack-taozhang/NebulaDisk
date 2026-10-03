<!DOCTYPE html>

<!--
  ===========================================================================
  online3D.ftl —— 3D 模型预览（Online 3D Viewer / o3dv）
  ===========================================================================

  ★ 为什么要有这个覆盖文件 ★
    kkFileView 原版模板把文件名**原样**拼进 URL 的 fragment：

        iframe.src = ".../website/index.html#model=" + url
                     + "&fullfilename=/" + 文件名

    文件名里只要出现 `#`（或 `&`、`?`、空格），这个 URL 就被浏览器拆错：
      - `#` 是 fragment 分隔符：它之后的内容全部被当成新的片段，
        于是 fullfilename 只剩 `#` 之前的部分，**扩展名被吃掉**；
      - `&` 会被当成本层 query 的参数分隔符，把后面的片段切断。

    Online 3D Viewer 判断"能不能导入"**只看扩展名**（其官方 FAQ 明确写着：
    "Online 3D Viewer tries to detect importable files by extension"）。
    扩展名一丢，它就弹：
        Something went wrong / No importable file found.

    实测本机就有一个这样的文件：`1.2.14.TFDF-6# F向.STEP`
    （名字里带 `#` 和空格），打开必然报上面那个错。

  ★ 修法 ★
    对文件名与 model 地址分别做 encodeURIComponent，拼进 fragment 后
    任何特殊字符都不会再破坏 URL 结构；o3dv 侧用 URLSearchParams 解析，
    会自动 decode 回原值。

  ★ 另一个坑：o3dv 是"扩展名驱动"的 ★
    注意区分两类错误，它们的含义完全不同（来自官方 FAQ）：
      - No importable file found  → 扩展名不在支持列表里（含被截断的情况）
      - Failed to import model    → 扩展名认出来了，但内容解析失败

  ★ 支持的扩展名（与 o3dv 官方一致）★
    3dm 3ds 3mf amf bim brep dae fbx fcstd gltf ifc iges step stl obj off ply wrl
    ⚠️ dwg / dxf **不在其中** —— 那两类由独立的 cad-viewer 服务负责，
      路由在 Nebula 侧就分开了，正常不会走到这个页面。
-->
<html lang="zh-CN">
<head>
    <meta charset="utf-8"/>
    <meta name="viewport" content="width=device-width, user-scalable=yes, initial-scale=1.0">
    <title>${file.name} 3D预览</title>
    <script src="js/base64.min.js" type="text/javascript"></script>
    <#include "*/commonHeader.ftl">
</head>
<#if currentUrl?contains("http://") || currentUrl?contains("https://") || currentUrl?contains("file://")>
    <#assign finalUrl="${currentUrl}">
<#elseif currentUrl?contains("ftp://") >
    <#assign finalUrl="${currentUrl}">
<#else>
    <#assign finalUrl="${baseUrl}${currentUrl}">
</#if>
<body>
<iframe src="" width="100%" frameborder="0"></iframe>
</body>
<script type="text/javascript">
    // 原始值（可能含 # & ? 空格 中文，甚至单引号）
    //
    // ★ 用 ?js_string 转义 ★
    //   ${file.name} 直接塞进单引号 JS 字符串里，若文件名含单引号会把脚本
    //   提前闭合（语法错误 → 整个页面白屏）。?js_string 会把 ' " \ 换行
    //   等转义成 \\xXX，保证字符串安全闭合。
    var rawUrl   = '${finalUrl?js_string}';
    var fileName = '${file.name?js_string}';
    var baseUrl  = '${baseUrl?js_string}';

    if (!baseUrl.endsWith('/')) { baseUrl = baseUrl + '/'; }

    // 说明：早先这里按 kkagent / 同源与否分两条分支，一条直连 rawUrl，
    // 一条走 getCorsFile。现在**统一走 getCorsFile 代理**（原因见下方注释：
    // rawUrl 的 query 里带 %23，原样拼进 fragment 会破坏 URL 结构；
    // 而代理只需 Base64，天然安全）。因此下面直接构造 modelUrl。

    // ★★ 关键修复：扩展名必须落在 **model URL 自己的 query** 里 ★★
    //
    //   症状：文件名里带 '#' 的模型打不开，报
    //         Something went wrong / No importable file found.
    //   典型受害者：`1.2.14.TFDF-6# F向.STEP`
    //
    //   ── 先排除两个错误假设（都已实测证伪）──
    //   (a) 与「大写扩展名」无关。o3dv 的 nr() 会 toLowerCase()，
    //       白名单同时含两者：
    //         CanImportExtension(e){return e==="stp"||e==="step"||...}
    //       所以 .STEP 与 .stp 在它眼里完全等价。
    //   (b) 与「扩展名被 # 截断」也无关（那是老判断，只对了一小半）。
    //
    //   ── o3dv 的真实取值路径（从 jar 内 bundle 反查得到）──
    //     1. app 读 location.hash，交给 Hu(paramList, "$") 解析；
    //        GetKeywordParams(key) 的算法是：
    //            paramList.split("$") → 找 startsWith(key+"=") 的段 →
    //            返回其 **原文子串，不做任何 decode**
    //        ⇒ 分隔符是 '$' 而不是 '&'；且值原样返回、不解码！
    //     2. 取到的 model 值原样进入 Es() → new ba(url)：
    //            this.name      = In(url)
    //            this.extension = nr(url)
    //        In(url) 才用 URLSearchParams 取 url 的 'fullfilename'，
    //        取不到就退回 pathname 的最后一段。
    //
    //   ⇒ 结论：**fullfilename 放在 fragment 里毫无用处**（o3dv 的
    //     keyword 词表里根本没有 'fullfilename' 这一项）；
    //     它必须出现在被解析为「主模型」的那条 URL 的 query 上。
    //
    //   ── 因此正确拼法 ──
    //        model=<模型URL，其 query 里带 fullfilename>
    //      并且 model 的值 **必须原样拼接、不能 encodeURIComponent**
    //      —— 因为 o3dv 不解码；一旦编码，它拿到的就是
    //      "%2Fpreview%2FgetCorsFile%3F..." 这种串，
    //      new URL() 解析出的末段没有扩展名，仍然报 No importable。
    //      （这一条是实测出来的：hook XHR 看到它请求的正是编码后的串。）
    //
    //   ── 为什么走 getCorsFile 代理反而更安全 ──
    //      rawUrl（/api/raw/xxx?mount=..&path=..）里 path 带 %23；
    //      原样拼进 fragment 后 '#','?' 会破坏 URL 结构。
    //      而 getCorsFile?urlPath=<Base64>&key=<k> 本身不含 '#'、'?'、
    //      '&' 之外的特殊字符，Base64 又是 URL 安全的，因此原样拼接
    //      不会破坏 fragment —— 条件是 **强制走代理**。
    //
    //   注意 kkFileView 原版模板走的是 `model=<rawUrl>` 直连，
    //   文件名带 '#' 时必然崩；这里统一改为经 getCorsFile 代理。
    var fileNameEnc = encodeURIComponent(fileName);

    // 把 fullfilename 挂到 model URL 的 query 上；同时对其中的
    // urlPath 做 Base64（getCorsFile 的既定协议）。
    // fullfilename 这里用 encodeURIComponent，o3dv 侧 URLSearchParams
    // 取出来会 decode 回原名（In() 内部有 decodeURIComponent）。
    var modelUrl = baseUrl + 'getCorsFile?urlPath='
                 + encodeURIComponent(Base64.encode(rawUrl))
                 + '&fullfilename=' + fileNameEnc
                 + '&key=${kkkey?js_string}';

    // ★ model 的值原样拼接（**不** encodeURIComponent），原因见上 ★
    var hash = 'model=' + modelUrl;

    var frame = document.getElementsByTagName('iframe')[0];
    // 注释更正：fragment 里只能有**一个**未编码的 '#'。
    // 上面拼进 model 的 getCorsFile URL 不含 '#'（文件名已转成
    // fullfilename 参数并做了 encodeURIComponent），所以这里安全。
    frame.src = baseUrl + 'website/index.html#' + hash;

    frame.height = document.documentElement.clientHeight - 10;

    /**
     * 页面变化调整高度
     */
    window.onresize = function () {
        frame.height = window.document.documentElement.clientHeight - 10;
    }
</script>

<script type="text/javascript">
    /*初始化水印*/
    if (!!window.ActiveXObject || "ActiveXObject" in window) {
    } else {
        initWaterMark();
    }
</script>
</html>
