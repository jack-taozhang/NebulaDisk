/* ==========================================================================
   NebulaDisk —— 图标库
   --------------------------------------------------------------------------
   两种图标要分清：
     1. UI 线性图标（ICONS）：Fluent 风格，1.5px 描边，currentColor 上色。
     2. 文件类型图标（FILE_ICONS）：Windows 风格的「彩色文档 + 扩展名」，
        自带配色，不跟随主题 —— 这正是资源管理器的观感。
   全部内联成 JS 对象，不引外部字体/图片，NAS 离线部署零外部依赖。
   ========================================================================== */

/* ---------- 1. UI 线性图标 ---------- */
const UI = {
  back:      '<path d="M10 3 4 8l6 5"/><path d="M4 8h7a4 4 0 0 1 0 8H9"/>',
  forward:   '<path d="M6 3l6 5-6 5"/><path d="M12 8H5a4 4 0 0 0 0 8h2"/>',
  up:        '<path d="M8 12V3"/><path d="M4 7l4-4 4 4"/>',
  refresh:   '<path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9"/><path d="M13.5 2v3.5H10"/>',
  // CAD 图纸：一把带刻度的尺（用于 CAD 预览窗口图标）
  ruler:     '<path d="M1.8 9.6 9.6 1.8a1 1 0 0 1 1.4 0l3.2 3.2a1 1 0 0 1 0 1.4L6.4 14.2a1 1 0 0 1-1.4 0L1.8 11a1 1 0 0 1 0-1.4z"/><path d="M4.4 7 5.8 8.4"/><path d="M6.6 4.8 8 6.2"/><path d="M8.8 2.6 10.2 4"/>',
  search:    '<circle cx="7.2" cy="7.2" r="4.6"/><path d="M10.6 10.6 14 14"/>',
  home:      '<path d="M2.5 7.5 8 3l5.5 4.5"/><path d="M4 7v6h8V7"/>',
  folder:    '<path d="M2 5.5A1.5 1.5 0 0 1 3.5 4h2.8l1.3 1.6h5A1.5 1.5 0 0 1 14 7.1v4.4a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z"/>',
  file:      '<path d="M4 2.5h5l3 3v8a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-10a1 1 0 0 1 1-1z"/><path d="M9 2.5v3h3"/>',
  grid:      '<rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1"/><rect x="9" y="2.5" width="4.5" height="4.5" rx="1"/><rect x="2.5" y="9" width="4.5" height="4.5" rx="1"/><rect x="9" y="9" width="4.5" height="4.5" rx="1"/>',
  list:      '<path d="M3 4h10"/><path d="M3 8h10"/><path d="M3 12h10"/>',
  upload:    '<path d="M8 11V3"/><path d="M4.5 6.5 8 3l3.5 3.5"/><path d="M2.5 12.5h11"/>',
  download:  '<path d="M8 3v8"/><path d="M4.5 7.5 8 11l3.5-3.5"/><path d="M2.5 12.5h11"/>',
  trash:     '<path d="M2.5 4.5h11"/><path d="M6.5 4.5V3h3v1.5"/><path d="M3.8 4.5l.6 8a1 1 0 0 0 1 1h5.2a1 1 0 0 0 1-1l.6-8"/><path d="M6.5 7v4"/><path d="M9.5 7v4"/>',
  plus:      '<path d="M8 3v10"/><path d="M3 8h10"/>',
  folderAdd: '<path d="M2 5.5A1.5 1.5 0 0 1 3.5 4h2.8l1.3 1.6h5A1.5 1.5 0 0 1 14 7.1v4.4a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z"/><path d="M8 7.5v4"/><path d="M6 9.5h4"/>',
  rename:    '<path d="M2.5 11.5 3.2 8.8 10 2l3 3-6.8 6.8-3.7.7z"/><path d="M9 3l3 3"/>',
  // 解压：一个盒子 + 向下的箭头（「从盒子里取出」的语义）
  unzip:     '<path d="M2 5.5A1.5 1.5 0 0 1 3.5 4h9A1.5 1.5 0 0 1 14 5.5v1.2H2z"/><path d="M3 6.7v5.3A1.5 1.5 0 0 0 4.5 13.5h7A1.5 1.5 0 0 0 13 12V6.7"/><path d="M8 8v3.4"/><path d="M6.5 10.2 8 11.7l1.5-1.5"/>',
  copy:      '<rect x="5.5" y="5.5" width="8" height="8" rx="1.2"/><path d="M10.5 5.5V3.2A1.2 1.2 0 0 0 9.3 2H3.2A1.2 1.2 0 0 0 2 3.2v6.1a1.2 1.2 0 0 0 1.2 1.2h2.3"/>',
  // 分享：三个节点连成的图（经典的"社交分享"符号）
  share:     '<circle cx="12" cy="3.6" r="2"/><circle cx="4" cy="8" r="2"/><circle cx="12" cy="12.4" r="2"/><path d="M5.8 7 10.2 4.6"/><path d="M5.8 9 10.2 11.4"/>',
  move:      '<path d="M8 2.5v11"/><path d="M4.5 6 8 2.5 11.5 6"/><path d="M4.5 10 8 13.5 11.5 10"/>',
  info:      '<circle cx="8" cy="8" r="6"/><path d="M8 7v4"/><circle cx="8" cy="5" r=".6" fill="currentColor"/>',
  warn:      '<path d="M8 2.4 14.4 13H1.6z"/><path d="M8 6.5v3.2"/><circle cx="8" cy="11.4" r=".6" fill="currentColor"/>',
  close:     '<path d="M3.5 3.5l9 9"/><path d="M12.5 3.5l-9 9"/>',
  min:       '<path d="M3 8h10"/>',
  max:       '<rect x="3" y="3.5" width="10" height="9" rx="1"/>',
  restore:   '<rect x="3" y="5" width="8" height="8" rx="1"/><path d="M5.5 5V3.6A1.1 1.1 0 0 1 6.6 2.5h6.8a1.1 1.1 0 0 1 1.1 1.1v6.3a1.1 1.1 0 0 1-1.1 1.1h-1.6"/>',
  power:     '<path d="M8 2.5v6"/><path d="M4.6 4.4a5 5 0 1 0 6.8 0"/>',
  user:      '<circle cx="8" cy="5.5" r="2.6"/><path d="M3 13.2c0-2.6 2.2-4.2 5-4.2s5 1.6 5 4.2"/>',
  settings:  '<circle cx="8" cy="8" r="2.1"/><path d="M8 1.8v1.5M8 12.7v1.5M2.1 8h1.5M12.4 8h1.5M3.8 3.8l1.1 1.1M11.1 11.1l1.1 1.1M12.2 3.8l-1.1 1.1M4.9 11.1l-1.1 1.1"/>',
  logout:    '<path d="M6 2.5H3.5A1 1 0 0 0 2.5 3.5v9a1 1 0 0 0 1 1H6"/><path d="M10 5.5 12.5 8 10 10.5"/><path d="M12.5 8H6"/>',
  edit:      '<path d="M11.5 2.2 13.8 4.5 6.3 12H4v-2.3z"/><path d="M2.5 13.5h11"/>',
  drive:     '<rect x="2" y="3.5" width="12" height="6" rx="1.4"/><path d="M2 9.5h12v3H2z"/><circle cx="12" cy="11" r=".6" fill="currentColor"/>',
  hdd:       '<rect x="2" y="4" width="12" height="8" rx="1.4"/><path d="M4.5 7.5h2"/><circle cx="11" cy="9.5" r=".7" fill="currentColor"/>',
  chevron:   '<path d="M6 4l4 4-4 4"/>',
  chevronD:  '<path d="M4 6l4 4 4-4"/>',
  check:     '<path d="M3 8.5 6.5 12 13 4.5"/>',
  dots:      '<circle cx="4" cy="8" r="1.2" fill="currentColor"/><circle cx="8" cy="8" r="1.2" fill="currentColor"/><circle cx="12" cy="8" r="1.2" fill="currentColor"/>',
  desktop:   '<rect x="2" y="3" width="12" height="8.5" rx="1.2"/><path d="M6 13.5h4"/><path d="M8 11.5v2"/>',
  star:      '<path d="m8 2 1.9 4 4.3.6-3.1 3 .7 4.3L8 11.9 4.2 14l.7-4.3-3.1-3L6.1 6z"/>',
  // 图钉（固定到开始菜单用）。斜置的推针：针身 + 帽 + 尖。
  pin:       '<path d="M6 2.2h4l-.6 3.1 2.4 2.4-3.3.8L5.6 11 3.2 8.6l2.5-2.7z"/><path d="M4.6 10.4 2.4 12.6"/>',
  sort:      '<path d="M4 3v10"/><path d="M2 11l2 2 2-2"/><path d="M8 4.5h6"/><path d="M8 8h4.5"/><path d="M8 11.5h3"/>',
  eye:       '<path d="M1.5 8S4 3.8 8 3.8 14.5 8 14.5 8 12 12.2 8 12.2 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="1.9"/>',
  share:     '<circle cx="12" cy="4" r="2"/><circle cx="4" cy="8" r="2"/><circle cx="12" cy="12" r="2"/><path d="M5.8 7 10.2 4.9"/><path d="M5.8 9l4.4 2.1"/>',
  cloud:     '<path d="M4.5 12.5a3 3 0 0 1 .3-6 3.8 3.8 0 0 1 7.3-.7 2.8 2.8 0 0 1 2.4 2.8 2.9 2.9 0 0 1-2.9 2.9z"/>',
  clock:     '<circle cx="8" cy="8" r="6"/><path d="M8 4.8V8l2.3 1.5"/>',
  image:     '<rect x="2" y="3" width="12" height="10" rx="1.3"/><circle cx="5.8" cy="6.3" r="1.1"/><path d="M2.6 11.5 6 8.2l2.4 2.2 2-1.9 3 2.9"/>',
  play:      '<circle cx="8" cy="8" r="6"/><path d="M6.6 5.6 10.4 8l-3.8 2.4z" fill="currentColor"/>',
  music:     '<circle cx="5.5" cy="12" r="1.8"/><circle cx="12" cy="10.4" r="1.8"/><path d="M7.3 12V5.4l6.5-1.6v6.6"/>',
  zip:       '<path d="M4 2.5h8v11H4z"/><path d="M8 2.5v2M8 5.6v2M8 8.7v2"/>',
  pdf:       '<path d="M4 2.5h5l3 3v8H4z"/><path d="M9 2.5v3h3"/>',
  table:     '<rect x="2" y="3" width="12" height="10" rx="1.2"/><path d="M2 6.5h12"/><path d="M6.5 6.5v6.5"/><path d="M2 10h12"/>',
  doc:       '<path d="M4 2.5h5l3 3v8H4z"/><path d="M9 2.5v3h3"/><path d="M6 8h4"/><path d="M6 10.4h4"/>',
  slide:     '<rect x="2" y="3" width="12" height="8.5" rx="1.2"/><path d="M8 11.5v2"/><path d="M5.5 13.5h5"/>',
  code:      '<path d="M6 5 2.8 8 6 11"/><path d="M10 5l3.2 3L10 11"/>',
  text:      '<path d="M3 3.5h10"/><path d="M3 6.8h10"/><path d="M3 10.1h6.5"/><path d="M3 13.4h8"/>',
  cad:       '<path d="M2.5 13 8 2.5 13.5 13z"/><circle cx="8" cy="9.5" r="1.6"/>',
  prev:      '<path d="M10.5 3.5 5 8l5.5 4.5"/>',
  next:      '<path d="M5.5 3.5 11 8l-5.5 4.5"/>',
  zoomIn:    '<circle cx="7.2" cy="7.2" r="4.6"/><path d="M10.6 10.6 14 14"/><path d="M5.2 7.2h4"/><path d="M7.2 5.2v4"/>',
  zoomOut:   '<circle cx="7.2" cy="7.2" r="4.6"/><path d="M10.6 10.6 14 14"/><path d="M5.2 7.2h4"/>',
  fit:       '<path d="M2.5 5.5v-3h3"/><path d="M13.5 5.5v-3h-3"/><path d="M2.5 10.5v3h3"/><path d="M13.5 10.5v3h-3"/>',
  save:      '<path d="M3 2.5h8l2.5 2.5v8.5H3z"/><path d="M5.5 2.5v4h5v-4"/><path d="M5.5 13.5v-4h5v4"/>',
  external:  '<path d="M9 3h4v4"/><path d="M13 3 7.5 8.5"/><path d="M11.5 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3"/>',
  lock:      '<rect x="3.5" y="7" width="9" height="6.5" rx="1.2"/><path d="M5.8 7V5.2a2.2 2.2 0 0 1 4.4 0V7"/>',
  key:       '<circle cx="5.5" cy="8" r="2.8"/><path d="M8.3 8H14"/><path d="M12 8v2.2"/><path d="M9.8 8v1.8"/>',
  users:     '<circle cx="6" cy="5.5" r="2.3"/><path d="M2 13c0-2.3 1.8-3.7 4-3.7S10 10.7 10 13"/><path d="M11 3.6a2.3 2.3 0 0 1 0 4.4"/><path d="M11.6 9.7c1.5.4 2.4 1.6 2.4 3.3"/>',
  shield:    '<path d="M8 2 3 4v4c0 3 2.1 5 5 6 2.9-1 5-3 5-6V4z"/><path d="M6 8l1.5 1.5L10.5 6"/>',
};

/* ---------- 2. 文件类型图标（Windows 风格彩色文档） ---------- */
// 每个图标 = 纸张底 + 折角 + 类型色 + 类型标记
function _paper(color, inner) {
  return `<svg viewBox="0 0 32 32" fill="none">
    <path d="M6 3.5A1.5 1.5 0 0 1 7.5 2h12L26 8.5v20a1.5 1.5 0 0 1-1.5 1.5h-17A1.5 1.5 0 0 1 6 28.5z" fill="#fff" stroke="${color}" stroke-width="1.4"/>
    <path d="M19.5 2v5a1.5 1.5 0 0 0 1.5 1.5h5" fill="${color}" opacity=".22" stroke="${color}" stroke-width="1.4" stroke-linejoin="round"/>
    ${inner}
  </svg>`;
}
function _folder(color) {
  return `<svg viewBox="0 0 32 32" fill="none">
    <path d="M2 7.5A2.5 2.5 0 0 1 4.5 5h6.2a2 2 0 0 1 1.6.8L14 8h13.5A2.5 2.5 0 0 1 30 10.5v14A2.5 2.5 0 0 1 27.5 27h-23A2.5 2.5 0 0 1 2 24.5z"
          fill="${color}" fill-opacity=".16" stroke="${color}" stroke-width="1.5"/>
    <path d="M2 12h28" stroke="${color}" stroke-width="1.2" opacity=".5"/>
  </svg>`;
}

const FILE_ICONS = {
  folder: _folder('#e8a33d'),

  // Office 三件套 —— 用各自的品牌色（Word 蓝 / Excel 绿 / PPT 橙红）
  doc: _paper('#2b579a', `
    <text x="16" y="25" font-size="9.5" font-weight="700" fill="#2b579a"
          text-anchor="middle" font-family="Segoe UI,sans-serif">W</text>`),
  xls: _paper('#217346', `
    <text x="16" y="25" font-size="9.5" font-weight="700" fill="#217346"
          text-anchor="middle" font-family="Segoe UI,sans-serif">X</text>`),
  ppt: _paper('#c43e1c', `
    <text x="16" y="25" font-size="9.5" font-weight="700" fill="#c43e1c"
          text-anchor="middle" font-family="Segoe UI,sans-serif">P</text>`),

  pdf: _paper('#c8102e', `
    <text x="16" y="24.5" font-size="8" font-weight="700" fill="#c8102e"
          text-anchor="middle" font-family="Segoe UI,sans-serif">PDF</text>`),

  txt: _paper('#5c6b7a', `
    <path d="M10 15h12M10 18.5h12M10 22h8" stroke="#5c6b7a" stroke-width="1.5"
          stroke-linecap="round"/>`),
  code: _paper('#7b3fa0', `
    <path d="M13 18l-3 3 3 3M19 18l3 3-3 3" stroke="#7b3fa0" stroke-width="1.6"
          stroke-linecap="round" stroke-linejoin="round"/>`),
  md: _paper('#3b6ea5', `
    <text x="16" y="25" font-size="8" font-weight="700" fill="#3b6ea5"
          text-anchor="middle" font-family="Segoe UI,sans-serif">MD</text>`),

  image: _paper('#0f7b0f', `
    <rect x="9.5" y="15" width="13" height="10" rx="1" stroke="#0f7b0f" stroke-width="1.4"/>
    <circle cx="12.8" cy="18.2" r="1.3" fill="#0f7b0f"/>
    <path d="M9.5 23.5l3.6-3.2 2.4 2.1 2.3-2 3.7 3.4" stroke="#0f7b0f"
          stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>`),

  video: _paper('#a4262c', `
    <rect x="9" y="15" width="14" height="10" rx="1.4" stroke="#a4262c" stroke-width="1.4"/>
    <path d="M14.4 17.6 20 20l-5.6 2.4z" fill="#a4262c"/>`),
  audio: _paper('#8764b8', `
    <circle cx="13" cy="23" r="2.2" stroke="#8764b8" stroke-width="1.4"/>
    <circle cx="20" cy="21.4" r="2.2" stroke="#8764b8" stroke-width="1.4"/>
    <path d="M15.2 23v-7.4l7-1.7v7.5" stroke="#8764b8" stroke-width="1.4"/>`),
  zip: _paper('#b8860b', `
    <path d="M16 14.5v2M16 17.6v2M16 20.7v1.9" stroke="#b8860b" stroke-width="1.7"
          stroke-linecap="round"/>
    <rect x="13.8" y="22.6" width="4.4" height="3.4" rx=".8"
          fill="#b8860b" fill-opacity=".3" stroke="#b8860b" stroke-width="1.3"/>`),
  cad: _paper('#0b6a8f', `
    <path d="M11 24 16 14.5 21 24z" stroke="#0b6a8f" stroke-width="1.4"
          stroke-linejoin="round"/>`),
  // 3D 模型（step/stl/obj/3mf/gltf...）—— 走 kkFileView 的 o3dv 预览。
  // 画一个等轴测立方体：三条可见棱 + 顶面，是「三维」最通用的视觉符号。
  model: _paper('#00838f', `
    <path d="M16 13.6 24.5 18l-8.5 4.4L7.5 18z" stroke="#00838f"
          stroke-width="1.4" stroke-linejoin="round"/>
    <path d="M7.5 18v5.6L16 28l8.5-4.4V18" stroke="#00838f"
          stroke-width="1.4" stroke-linejoin="round"/>
    <path d="M16 22.4V28" stroke="#00838f" stroke-width="1.4"/>`),
  eml: _paper('#4a5568', `
    <rect x="9.5" y="15.5" width="13" height="9.5" rx="1.1"
          stroke="#4a5568" stroke-width="1.4"/>
    <path d="M9.8 16.3 16 20.4l6.2-4.1" stroke="#4a5568" stroke-width="1.4"
          stroke-linejoin="round"/>`),
  unknown: _paper('#8a8a8a', ''),
};

/* ---------- 3. 扩展名 → 类型 ---------- */
const EXT_KIND = {
  doc: 'doc', docx: 'doc', docm: 'doc', dot: 'doc', dotx: 'doc',
  odt: 'doc', rtf: 'doc', wps: 'doc',
  xls: 'xls', xlsx: 'xls', xlsm: 'xls', xlt: 'xls', ods: 'xls',
  csv: 'xls', et: 'xls',
  ppt: 'ppt', pptx: 'ppt', pptm: 'ppt', pot: 'ppt', potx: 'ppt',
  odp: 'ppt', dps: 'ppt',
  pdf: 'pdf',
  txt: 'txt', log: 'txt', ini: 'txt', conf: 'txt', properties: 'txt',
  md: 'md', markdown: 'md',
  js: 'code', ts: 'code', jsx: 'code', tsx: 'code', json: 'code',
  xml: 'code', html: 'code', htm: 'code', css: 'code', java: 'code',
  py: 'code', go: 'code', rs: 'code', c: 'code', cpp: 'code', h: 'code',
  cs: 'code', php: 'code', rb: 'code', sh: 'code', bat: 'code',
  sql: 'code', yaml: 'code', yml: 'code', vue: 'code', toml: 'code',
  jpg: 'image', jpeg: 'image', png: 'image', gif: 'image', bmp: 'image',
  webp: 'image', svg: 'image', ico: 'image', tif: 'image', tiff: 'image',
  mp4: 'video', webm: 'video', mkv: 'video', mov: 'video', avi: 'video',
  flv: 'video', wmv: 'video', m4v: 'video',
  mp3: 'audio', wav: 'audio', flac: 'audio', aac: 'audio', ogg: 'audio',
  m4a: 'audio', wma: 'audio',
  zip: 'zip', rar: 'zip', '7z': 'zip', tar: 'zip', gz: 'zip', bz2: 'zip',
  xz: 'zip', iso: 'zip',
  dwg: 'cad', dxf: 'cad',
  // 3D 模型 —— kkFileView 走 Online 3D Viewer (o3dv) 预览，
  // o3dv 支持的格式清单见其官方 FAQ（按扩展名判定可导入性）。
  // ★ 只登记 o3dv 真正认得的扩展名 ★
  //   漏登记只会显示 unknown 图标；错误登记则会让用户以为能开、
  //   点开却报「No importable file found」，后者危害更大。
  step: 'model', stp: 'model', iges: 'model', igs: 'model',
  stl: 'model', obj: 'model', off: 'model', ply: 'model',
  wrl: 'model', '3mf': 'model', amf: 'model', '3ds': 'model',
  '3dm': 'model', dae: 'model', fbx: 'model', gltf: 'model',
  glb: 'model', brep: 'model', fcstd: 'model', bim: 'model',
  ifc: 'model',
  eml: 'eml', msg: 'eml',
};

/* ---------- 4. 对外 API ---------- */
const Icons = {
  /** UI 线性图标，返回 svg 字符串。size 默认 16 */
  ui(name, size = 16) {
    const d = UI[name] || UI.file;
    return `<svg viewBox="0 0 16 16" width="${size}" height="${size}" fill="none"
      stroke="currentColor" stroke-width="1.5" stroke-linecap="round"
      stroke-linejoin="round">${d}</svg>`;
  },

  /** 文件类型图标：传文件名或扩展名都行 */
  file(nameOrExt, isDir = false) {
    if (isDir) return FILE_ICONS.folder;
    const ext = String(nameOrExt).includes('.')
      ? String(nameOrExt).split('.').pop().toLowerCase()
      : String(nameOrExt).toLowerCase();
    return FILE_ICONS[EXT_KIND[ext]] || FILE_ICONS.unknown;
  },

  /** 应用图标（任务栏 / 开始菜单）—— 云盘自己的 logo */
  app(size = 22) {
    return `<svg viewBox="0 0 32 32" width="${size}" height="${size}" fill="none">
      <defs>
        <linearGradient id="ng${size}" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#4cc2ff"/>
          <stop offset="1" stop-color="#0067c0"/>
        </linearGradient>
      </defs>
      <path d="M9 25a7 7 0 0 1 .7-13.9A8.8 8.8 0 0 1 26 13.3 6.4 6.4 0 0 1 25.3 25z"
            fill="url(#ng${size})"/>
      <path d="M16 19.5V12M12.6 15.2 16 11.8l3.4 3.4" stroke="#fff" stroke-width="2"
            stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`;
  },
};
