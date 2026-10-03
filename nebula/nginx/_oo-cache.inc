# ===========================================================================
#  OnlyOffice **静态资源**的缓存策略 —— 由 nebula-front.conf 里 ①a 那条
#  location 显式 include（只给静态目录用，动态路径一律不进来）。
#
#  ⚠️ 文件名必须**不是** .conf 结尾：nginx 默认 `include conf.d/*.conf;`
#     会把它当顶层配置读，而 proxy_cache 一族的指令在 http 上下文里非法
#     ⇒ nginx 会直接起不来。所以用 .inc。
#
#  ⚠️ 为什么不设 `proxy_cache_valid`：
#     设了它等于我们替 OO 决定"这份资源能存多久"。而 OO 自己已经把话
#     说得清清楚楚（静态资源 immutable 一年、api.js no-store）。
#     不设 ⇒ 完全跟随上游的 Cache-Control，它说能存才存、说不存就不存。
#     实测效果：sdkjs/web-apps/fonts 会 HIT，api.js 永远 MISS（正确）。
# ===========================================================================

# ★★ 铁律：要走缓存，就必须 buffering on ★★
#    nginx 在 `proxy_buffering off` 时**根本不会把响应写进缓存**
#    （内部直接置为不可缓存）。实测症状非常隐蔽：
#      缓存管理进程正常启动、缓存目录权限也对、配置 `nginx -t` 全过，
#      但 X-OO-Cache 永远是 MISS、/var/cache/nginx/oo 里 0 个文件。
#    `_oo-proxy.inc` 里刻意不再统一设 off，就是为了让这条能生效。
proxy_buffering on;
proxy_buffers 16 64k;              # 命中缓存后回给客户端时用的读缓冲
proxy_busy_buffers_size 128k;
proxy_max_temp_file_size 1024m;    # 单文件超过内存缓冲就落临时盘（同在这个卷里）

proxy_cache oo_cache;

# ★★ 关键：cache key 必须带上 Accept-Encoding ★★
#    OO 的响应带 `Vary: Accept-Encoding`，而 nginx **不会**自动把 Vary
#    纳入 cache key。不带的话会出现：先来的未压缩请求（28.8MB）被缓存，
#    随后所有支持 gzip 的浏览器都拿到这份 28.8MB 的版本 —— 体积直接差 6 倍，
#    正好把"加了缓存反而更慢"这个坑踩实。
#    ⚠️ key 里**故意不含 host/scheme**：局域网 IP、ZeroTier IP、域名
#       访问的是同一份内容，共用一个 key 才能共享缓存。
proxy_cache_key "$request_method$request_uri$http_accept_encoding";

# 冷启动时浏览器会**并发**请求同一个资源（一个页面里被多处引用）。
# 没有 lock 的话每个请求都去回源一次；有 lock 则只有一个回源，其余等结果。
proxy_cache_lock on;
proxy_cache_lock_age 30s;
proxy_cache_lock_timeout 60s;

# 上游抖一下/正在更新时，宁可先拿旧的顶上，别让用户看到白屏
proxy_cache_use_stale error timeout updating http_500 http_502 http_503 http_504;
proxy_cache_background_update on;
proxy_cache_revalidate on;

# ★★ 错误码不许进**我们这层**缓存（2026-10-04）★★
#   理由与 `_oo-proxy.inc` 的「铁律 3」同一条：上游连 404 都发 immutable，
#   不拦的话我们自己的 oo_cache 也会把一次抖动的 404 存一年。
#   `$oo_no_cache` 的 map 定义在 nebula-front.conf。
proxy_no_cache $oo_no_cache;

# 命中状态直接回给客户端 —— 探针/curl 看这个头就知道缓存在不在工作
add_header X-OO-Cache $upstream_cache_status always;
