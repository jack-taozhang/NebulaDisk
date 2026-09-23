// 验证 svg.ftl 的「适应窗口」数学：用真实 DWG 的 SVG 固有尺寸跑一遍。
// 目的：证明修复前后可见面积差异，避免把错误公式烘焙进镜像。

function pad(str, n) { return String(str).padEnd(n); }

const SVG_W = 1604832, SVG_H = 765792;   // 立库规划图块.dwg 转出的真实尺寸
const CW = 1000, CH = 660;               // 预览窗口内容区（近似真实）

// 修复前：无 viewBox，style.width='100%' → 浏览器按 1 用户单位 = 1 CSS px
const beforeVisibleX = (CW / SVG_W) * 100;
const beforeVisibleY = (CH / SVG_H) * 100;

// 修复后：viewBox 生效 + fitZoom 计算
const fitZoom = Math.min((CW * 0.96) / SVG_W, (CH * 0.96) / SVG_H);
const afterVisibleX = Math.min(100, (CW / (SVG_W * fitZoom)) * 100);
const afterVisibleY = Math.min(100, (CH / (SVG_H * fitZoom)) * 100);

console.log('=== 修复前（无 viewBox，1:1 渲染）===');
console.log(`  可见比例  x: ${CW}/${SVG_W} = ${beforeVisibleX.toFixed(6)}%`);
console.log(`            y: ${CH}/${SVG_H} = ${beforeVisibleY.toFixed(6)}%`);
console.log(`  => 屏幕上几乎全白（只有约 ${(beforeVisibleX * beforeVisibleY / 100).toFixed(4)}% 的图纸面积可见）`);

console.log('\n=== 修复后（注入 viewBox + fitZoom）===');
console.log(`  fitZoom = min(${CW}*0.96/${SVG_W}, ${CH}*0.96/${SVG_H}) = ${fitZoom.toExponential(4)}`);
console.log(`  显示尺寸 = ${(SVG_W * fitZoom).toFixed(0)} × ${(SVG_H * fitZoom).toFixed(0)} px`);
console.log(`  可见比例  x: ${afterVisibleX.toFixed(2)}%  y: ${afterVisibleY.toFixed(2)}%`);
console.log(`  zoom-display 显示: 缩放: ${(fitZoom * 100).toFixed(1)}%`);

// 断言：修复后图纸必须完整落在容器内
const fits = SVG_W * fitZoom <= CW + 0.5 && SVG_H * fitZoom <= CH + 0.5;
console.log(`\n${fits ? '✅' : '❌'} 整张图纸完整落入窗口`);
console.log(`${afterVisibleX > 99 && afterVisibleY > 99 ? '✅' : '❌'} 可见比例 > 99%（不再是空白）`);
console.log(`${fitZoom < 1 && fitZoom > 0 ? '✅' : '❌'} fitZoom 是合法的缩小比例`);

// 顺带验证 zoomIn/zoomOut 现在相对 fitZoom 是乘法，能真正拉近
let z = fitZoom;
for (let i = 0; i < 5; i++) z = Math.min(10, z * 1.2);
console.log(`\n连点 5 次放大后: ${z.toFixed(3)}（相对固有尺寸 ${(z * 100).toFixed(1)}%）`);
console.log(`${z > fitZoom * 2 ? '✅' : '❌'} 放大按钮有实际效果（旧版固定在 1~10，对百万像素图纸无效）`);
