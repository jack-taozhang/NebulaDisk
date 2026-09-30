/* =============================================================================
 * qr.js —— 极简二维码生成器（自有实现，零依赖、离线可用）
 *
 * 为什么不用现成的库 / 在线接口：
 *   1) 云盘容器**不保证能出网**，引入 npm 依赖会让构建变脆；
 *   2) ★ 绝对不能用第三方二维码图片接口 ★
 *      分享链接与直链都是「**免登录的链接即凭证**」（见后端 shortlink.py），
 *      把 token 发给 api.qrserver.com 之类的服务 = 把文件对外公开。
 *      任何"扫一下就能看"的功能都不允许让链接离开本机。
 *   ⇒ 自己在浏览器里画。
 *
 * 覆盖范围（够用即可，不求全）：
 *   · 字节模式（UTF-8），纠错等级 L/M/Q/H，版本 1~10（最大 216 个数据码字，
 *     足够放 200 字符以内的 URL）
 *   · 自动选版本与掩码（标准 4 条罚分规则）
 *
 * ★ 正确性是被**交叉验证**过的，不是"看着能扫"★
 *   分块表（RS_BLOCKS）直接从 Python `qrcode` 包的 RS_BLOCK_TABLE 导出，
 *   并且 tools/qr_crosscheck.mjs 会把本文件产出的矩阵与 Python 参考实现
 *   **逐模块比对**（8 种掩码全覆盖）。改这里必须重跑那个脚本。
 *
 * 对外接口：
 *   QR.matrix(text[, {ecl}])  -> { size, modules: boolean[][], version, mask, ecl }
 *   QR.svg(text[, {size, margin, ecl, dark, light}]) -> svg 字符串
 * ========================================================================== */
const QR = (() => {
  'use strict';

  /* -------------------------------------------------------------------------
     1. GF(256) 与 Reed-Solomon
     ---------------------------------------------------------------------- */
  const EXP = new Uint8Array(512);
  const LOG = new Uint8Array(256);
  (function () {
    let x = 1;
    for (let i = 0; i < 255; i++) {
      EXP[i] = x;
      LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;   // 本原多项式 x^8+x^4+x^3+x^2+1
    }
    for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  })();

  const mul = (a, b) => (a === 0 || b === 0) ? 0 : EXP[LOG[a] + LOG[b]];

  /** 生成多项式 (x-α^0)(x-α^1)…(x-α^(n-1))，返回降幂系数，[0] 恒为 1 */
  function genPoly(n) {
    let g = [1];
    for (let i = 0; i < n; i++) {
      const ng = new Array(g.length + 1).fill(0);
      for (let j = 0; j < g.length; j++) {
        ng[j] ^= g[j];
        ng[j + 1] ^= mul(g[j], EXP[i]);
      }
      g = ng;
    }
    return g;
  }

  /** 多项式除法取余（= 该块的纠错码字） */
  function rsEncode(data, ecLen) {
    const gen = genPoly(ecLen);
    const rem = new Array(ecLen).fill(0);
    for (let i = 0; i < data.length; i++) {
      const factor = data[i] ^ rem[0];
      rem.shift();
      rem.push(0);
      for (let j = 0; j < ecLen; j++) rem[j] ^= mul(gen[j + 1], factor);
    }
    return rem;
  }

  /* -------------------------------------------------------------------------
     2. 分块表 —— ★ 由 Python qrcode 的 RS_BLOCK_TABLE 导出（版本 1~10）★
        每组形如 [块数, 总码字数, 数据码字数]；一条记录里可能有 2 组
        （此时两组的数据码字数不同、纠错码字数相同）。
     ---------------------------------------------------------------------- */
  const RS_BLOCKS = [
    /* v1  */ [[1, 26, 19], [1, 26, 16], [1, 26, 13], [1, 26, 9]],
    /* v2  */ [[1, 44, 34], [1, 44, 28], [1, 44, 22], [1, 44, 16]],
    /* v3  */ [[1, 70, 55], [1, 70, 44], [2, 35, 17], [2, 35, 13]],
    /* v4  */ [[1, 100, 80], [2, 50, 32], [2, 50, 24], [4, 25, 9]],
    /* v5  */ [[1, 134, 108], [2, 67, 43], [2, 33, 15, 2, 34, 16], [2, 33, 11, 2, 34, 12]],
    /* v6  */ [[2, 86, 68], [4, 43, 27], [4, 43, 19], [4, 43, 15]],
    /* v7  */ [[2, 98, 78], [4, 49, 31], [2, 32, 14, 4, 33, 15], [4, 39, 13, 1, 40, 14]],
    /* v8  */ [[2, 121, 97], [2, 60, 38, 2, 61, 39], [4, 40, 18, 2, 41, 19],
              [4, 40, 14, 2, 41, 15]],
    /* v9  */ [[2, 146, 116], [3, 58, 36, 2, 59, 37], [4, 36, 16, 4, 37, 17],
              [4, 36, 12, 4, 37, 13]],
    /* v10 */ [[2, 86, 68, 2, 87, 69], [4, 69, 43, 1, 70, 44], [6, 43, 19, 2, 44, 20],
              [6, 43, 15, 2, 44, 16]],
  ];
  const MAX_VERSION = RS_BLOCKS.length;
  const ECL_INDEX = { L: 0, M: 1, Q: 2, H: 3 };
  // 格式信息里的纠错等级编码（注意不是顺序值）
  const ECL_FORMAT_BITS = { L: 1, M: 0, Q: 3, H: 2 };

  /** 版本 v（1-based）、纠错等级 → [{total, data}] 列表 */
  function blocksOf(version, ecl) {
    const row = RS_BLOCKS[version - 1][ECL_INDEX[ecl]];
    const out = [];
    for (let i = 0; i < row.length; i += 3) {
      const count = row[i], total = row[i + 1], data = row[i + 2];
      for (let k = 0; k < count; k++) out.push({ total, data, ec: total - data });
    }
    return out;
  }

  const dataCodewords = (version, ecl) =>
    blocksOf(version, ecl).reduce((n, b) => n + b.data, 0);

  /** 校正图案中心坐标（版本 1~10 的官方取值） */
  const ALIGN_POS = [
    [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
    [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50],
  ];

  /* -------------------------------------------------------------------------
     3. 位流与编码
     ---------------------------------------------------------------------- */
  function utf8Bytes(str) {
    if (typeof TextEncoder !== 'undefined') return Array.from(new TextEncoder().encode(str));
    const out = [];
    for (const ch of unescape(encodeURIComponent(str))) out.push(ch.charCodeAt(0));
    return out;
  }

  class BitBuf {
    constructor() { this.bits = []; }
    put(value, len) {
      for (let i = len - 1; i >= 0; i--) this.bits.push(((value >>> i) & 1) !== 0);
    }
    get length() { return this.bits.length; }
  }

  /** 把文本编成最终的码字序列（含纠错、交错） */
  function encodeCodewords(text, version, ecl) {
    const bytes = utf8Bytes(text);
    const blocks = blocksOf(version, ecl);
    const dataCw = blocks.reduce((n, b) => n + b.data, 0);
    const ccBits = version <= 9 ? 8 : 16;

    const bb = new BitBuf();
    bb.put(0b0100, 4);              // 字节模式
    bb.put(bytes.length, ccBits);
    bytes.forEach((b) => bb.put(b, 8));

    // 结束符（最多 4 个 0）+ 补齐到字节边界
    const cap = dataCw * 8;
    bb.put(0, Math.min(4, cap - bb.length));
    while (bb.length % 8 !== 0) bb.put(0, 1);

    // 填充码字 0xEC / 0x11
    const data = [];
    for (let i = 0; i < bb.length; i += 8) {
      let v = 0;
      for (let j = 0; j < 8; j++) v = (v << 1) | (bb.bits[i + j] ? 1 : 0);
      data.push(v);
    }
    for (let i = 0; data.length < dataCw; i++) data.push(i % 2 === 0 ? 0xec : 0x11);

    // 分块求纠错
    let p = 0;
    const parts = blocks.map((b) => {
      const d = data.slice(p, p + b.data);
      p += b.data;
      return { data: d, ec: rsEncode(d, b.ec) };
    });

    // 交错：先按列取数据码字，再按列取纠错码字
    const out = [];
    const maxData = Math.max(...parts.map((x) => x.data.length));
    for (let i = 0; i < maxData; i++) {
      parts.forEach((x) => { if (i < x.data.length) out.push(x.data[i]); });
    }
    const ecLen = parts[0].ec.length;
    for (let i = 0; i < ecLen; i++) parts.forEach((x) => out.push(x.ec[i]));
    return { codewords: out, dataCw };
  }

  /* -------------------------------------------------------------------------
     4. 矩阵
     ---------------------------------------------------------------------- */
  function newMatrix(size) {
    return {
      size,
      mod: Array.from({ length: size }, () => new Array(size).fill(false)),
      fn: Array.from({ length: size }, () => new Array(size).fill(false)),
    };
  }

  function setFn(m, x, y, dark) {
    m.mod[y][x] = !!dark;
    m.fn[y][x] = true;
  }

  function drawFinder(m, cx, cy) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx, y = cy + dy;
        if (x < 0 || y < 0 || x >= m.size || y >= m.size) continue;
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        setFn(m, x, y, d !== 2 && d !== 4);
      }
    }
  }

  function drawAlign(m, cx, cy) {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        setFn(m, cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
  }

  function drawFunctionPatterns(m, version) {
    for (let i = 0; i < m.size; i++) {
      setFn(m, 6, i, i % 2 === 0);      // 竖向时序
      setFn(m, i, 6, i % 2 === 0);      // 横向时序
    }
    drawFinder(m, 3, 3);
    drawFinder(m, m.size - 4, 3);
    drawFinder(m, 3, m.size - 4);

    const pos = ALIGN_POS[version - 1];
    for (let i = 0; i < pos.length; i++) {
      for (let j = 0; j < pos.length; j++) {
        const skip = (i === 0 && j === 0)
          || (i === 0 && j === pos.length - 1)
          || (i === pos.length - 1 && j === 0);
        if (!skip) drawAlign(m, pos[j], pos[i]);
      }
    }
    drawFormat(m, version, 'M', 0);     // 先占位（选定掩码后重画）
    drawVersionInfo(m, version);
  }

  /** 15 位格式信息（BCH(15,5) + 掩码 0x5412） */
  function formatBits(ecl, mask) {
    const data = (ECL_FORMAT_BITS[ecl] << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    return ((data << 10) | rem) ^ 0x5412;
  }

  function getBit(v, i) { return ((v >>> i) & 1) !== 0; }

  function drawFormat(m, version, ecl, mask) {
    const bits = formatBits(ecl, mask);
    const size = m.size;
    for (let i = 0; i < 6; i++) setFn(m, 8, i, getBit(bits, i));
    setFn(m, 8, 7, getBit(bits, 6));
    setFn(m, 8, 8, getBit(bits, 7));
    setFn(m, 7, 8, getBit(bits, 8));
    for (let i = 9; i < 15; i++) setFn(m, 14 - i, 8, getBit(bits, i));

    for (let i = 0; i < 8; i++) setFn(m, size - 1 - i, 8, getBit(bits, i));
    for (let i = 8; i < 15; i++) setFn(m, 8, size - 15 + i, getBit(bits, i));
    setFn(m, 8, size - 8, true);        // 恒暗模块
  }

  function drawVersionInfo(m, version) {
    if (version < 7) return;
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const b = getBit(bits, i);
      const a = m.size - 11 + (i % 3);
      const c = Math.floor(i / 3);
      setFn(m, a, c, b);
      setFn(m, c, a, b);
    }
  }

  function maskFn(mask, x, y) {
    switch (mask) {
      case 0: return (x + y) % 2 === 0;
      case 1: return y % 2 === 0;
      case 2: return x % 3 === 0;
      case 3: return (x + y) % 3 === 0;
      case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
      case 5: return (x * y) % 2 + (x * y) % 3 === 0;
      case 6: return ((x * y) % 2 + (x * y) % 3) % 2 === 0;
      default: return ((x + y) % 2 + (x * y) % 3) % 2 === 0;
    }
  }

  /** 把码字按之字形填进矩阵（跳过功能图案） */
  function placeData(m, codewords) {
    let i = 0;
    for (let right = m.size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;                 // 跳过竖向时序列
      for (let vert = 0; vert < m.size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? m.size - 1 - vert : vert;
          if (!m.fn[y][x] && i < codewords.length * 8) {
            const byte = codewords[i >> 3];
            m.mod[y][x] = ((byte >>> (7 - (i & 7))) & 1) !== 0;
            i++;
          }
          // 剩余的"剩余位"（remainder bits）保持 false，标准即如此
        }
      }
    }
  }

  function applyMask(m, mask) {
    for (let y = 0; y < m.size; y++) {
      for (let x = 0; x < m.size; x++) {
        if (!m.fn[y][x] && maskFn(mask, x, y)) m.mod[y][x] = !m.mod[y][x];
      }
    }
  }

  /* ---- 罚分（标准 4 条；用于自动挑掩码）---- */
  const PENALTY_N1 = 3, PENALTY_N2 = 3, PENALTY_N3 = 40, PENALTY_N4 = 10;

  function penalty(m) {
    const n = m.size;
    let score = 0;

    // 规则 1：行/列中 ≥5 个同色连续模块
    for (let y = 0; y < n; y++) {
      let run = 1;
      for (let x = 1; x < n; x++) {
        if (m.mod[y][x] === m.mod[y][x - 1]) {
          run++;
          if (run === 5) score += PENALTY_N1;
          else if (run > 5) score += 1;
        } else run = 1;
      }
    }
    for (let x = 0; x < n; x++) {
      let run = 1;
      for (let y = 1; y < n; y++) {
        if (m.mod[y][x] === m.mod[y - 1][x]) {
          run++;
          if (run === 5) score += PENALTY_N1;
          else if (run > 5) score += 1;
        } else run = 1;
      }
    }

    // 规则 2：2×2 同色块
    for (let y = 0; y < n - 1; y++) {
      for (let x = 0; x < n - 1; x++) {
        const c = m.mod[y][x];
        if (c === m.mod[y][x + 1] && c === m.mod[y + 1][x] && c === m.mod[y + 1][x + 1]) {
          score += PENALTY_N2;
        }
      }
    }

    // 规则 3：类定位图案 1011101 0000 / 0000 1011101
    const pat = [true, false, true, true, true, false, true];
    const check = (get, len) => {
      for (let i = 0; i <= len - 11; i++) {
        let a = true, b = true;
        for (let k = 0; k < 7; k++) if (get(i + k) !== pat[k]) a = false;
        for (let k = 0; k < 7; k++) if (get(i + 4 + k) !== pat[k]) b = false;
        if (a) {
          let ok = true;
          for (let k = 7; k < 11; k++) if (get(i + k)) ok = false;
          if (ok) score += PENALTY_N3;
        }
        if (b) {
          let ok = true;
          for (let k = 0; k < 4; k++) if (get(i + k)) ok = false;
          if (ok) score += PENALTY_N3;
        }
      }
    };
    for (let y = 0; y < n; y++) check((i) => m.mod[y][i], n);
    for (let x = 0; x < n; x++) check((i) => m.mod[i][x], n);

    // 规则 4：暗模块比例偏离 50%
    let dark = 0;
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (m.mod[y][x]) dark++;
    const pct = (dark * 100) / (n * n);
    score += Math.floor(Math.abs(pct - 50) / 5) * PENALTY_N4;
    return score;
  }

  /* -------------------------------------------------------------------------
     5. 对外接口
     ---------------------------------------------------------------------- */
  function matrix(text, opts) {
    opts = opts || {};
    const ecl = ECL_INDEX[opts.ecl || 'M'] === undefined ? 'M' : (opts.ecl || 'M');
    const bytes = utf8Bytes(String(text));

    let version = 0, codewords = null;
    for (let v = 1; v <= MAX_VERSION; v++) {
      const ccBits = v <= 9 ? 8 : 16;
      if (4 + ccBits + bytes.length * 8 <= dataCodewords(v, ecl) * 8) {
        version = v;
        codewords = encodeCodewords(String(text), v, ecl).codewords;
        break;
      }
    }
    if (!version) throw new Error('二维码内容过长（超出本实现支持的范围）');

    const build = (mask) => {
      const size = version * 4 + 17;
      const m = newMatrix(size);
      drawFunctionPatterns(m, version);
      placeData(m, codewords);
      applyMask(m, mask);
      drawFormat(m, version, ecl, mask);
      return m;
    };

    let best = null, bestMask = 0, bestScore = Infinity;
    if (typeof opts.mask === 'number') {
      // 交叉验证用：强制某个掩码（任何掩码都是合法可扫的）
      bestMask = opts.mask % 8;
      best = build(bestMask);
    } else {
      for (let mask = 0; mask < 8; mask++) {
        const m = build(mask);
        const s = penalty(m);
        if (s < bestScore) { bestScore = s; best = m; bestMask = mask; }
      }
    }
    return { size: best.size, modules: best.mod, version, mask: bestMask, ecl };
  }

  /** 画成 SVG（矢量，缩放不糊；用 currentColor 与主题变量无关，交给调用方定色） */
  function svg(text, opts) {
    opts = opts || {};
    const q = matrix(text, opts);
    const margin = opts.margin === undefined ? 3 : opts.margin;
    const px = opts.size || 240;
    const total = q.size + margin * 2;
    const dark = opts.dark || '#000';
    const light = opts.light || '#fff';

    let path = '';
    for (let y = 0; y < q.size; y++) {
      let x = 0;
      while (x < q.size) {
        if (!q.modules[y][x]) { x++; continue; }
        let w = 1;
        while (x + w < q.size && q.modules[y][x + w]) w++;
        path += `M${x + margin} ${y + margin}h${w}v1h-${w}z`;
        x += w;
      }
    }
    return `<svg width="${px}" height="${px}" viewBox="0 0 ${total} ${total}" `
      + `shape-rendering="crispEdges" xmlns="http://www.w3.org/2000/svg">`
      + `<rect width="${total}" height="${total}" fill="${light}"/>`
      + `<path d="${path}" fill="${dark}"/></svg>`;
  }

  return { matrix, svg, versions: MAX_VERSION };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = QR;
