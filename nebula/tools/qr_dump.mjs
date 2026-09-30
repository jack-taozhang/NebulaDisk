#!/usr/bin/env node
/* =============================================================================
 * qr_dump.mjs —— 把 web/js/qr.js 对一组内容的产出**倒出来**（JSON 到 stdout）。
 *
 * ★ 为什么单独一个文件、由 Python 反向调用它 ★
 *   本机沙箱里 **Node 的 spawnSync/execSync 一律 EBUSY**（子进程起不来，
 *   见 tools/nbssh.py 的头部注释）。所以交叉验证不能由 Node 去叫 Python，
 *   只能由 **Python 去叫 Node**（Python 的 subprocess 正常）。
 *   于是拆成：本文件只负责"算 + 吐 JSON"，判据与比对放在
 *   tools/qr_crosscheck.py 里（那里会调用本文件）。
 *
 * 用法（一般不用手跑）：
 *   node tools/qr_dump.mjs            # 打印 JSON
 * ========================================================================== */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const require = createRequire(import.meta.url);
const QR = require(path.join(ROOT, 'web/js/qr.js'));

/** 覆盖真实场景：短直链、长分享（旧 32 字符 token）、长域名、中文、边界长度 */
export const CASES = [
  'http://127.0.0.1:8089/f/y6KK_6Yc93YK',
  'http://192.168.193.70:8089/f/y6KK_6Yc93YK',
  'http://192.168.193.70:8089/s/y77W5A-3jjHHr-nRHka-DrNsd_UMSuEM',
  'https://disk.example.com/f/AbCdEfGhIjKl',
  'https://pan.my-very-long-company-domain.example:8443/s/XyZ012345678',
  'http://127.0.0.1:8089/f/中文测试abcd',
  'x',
  'https://a.b/f/0123456789abcdef',
  'https://a.b/s/0123456789abcdef0123456789abcdef',
  'http://192.168.193.70:8089/oo?mount=%E5%94%AE%E5%89%8D&path=/a.pdf',
];

const ECL = 'M';
const rows = (m) => m.map((r) => r.map((v) => (v ? '1' : '0')).join(''));

const out = { ecl: ECL, cases: [] };
for (const text of CASES) {
  const auto = QR.matrix(text, { ecl: ECL });
  const masks = [];
  for (let k = 0; k < 8; k++) masks.push(rows(QR.matrix(text, { ecl: ECL, mask: k }).modules));
  out.cases.push({
    text,
    version: auto.version,
    size: auto.size,
    autoMask: auto.mask,
    auto: rows(auto.modules),
    masks,
  });
}

process.stdout.write(JSON.stringify(out));
