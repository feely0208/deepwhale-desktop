// 生成应用/托盘图标（纯 Node、零依赖）：白底 + 流线型蓝色鲸鱼剪影（DeepSeek 风格极简）
// 4x 超采样 + 盒式降采样实现抗锯齿，曲线用 Catmull-Rom 样条。
// 用法：npm run icons
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

// ---------- PNG 编码 ----------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}
function encodePNG(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// ---------- 曲线与多边形 ----------
const BG = [255, 255, 255, 255];      // 白底
const WHALE = [77, 124, 254, 255];    // 深鲸蓝 #4d7cfe
const EYE = [30, 52, 110, 255];       // 深蓝眼睛
const BORDER = [226, 232, 244, 255];  // 极浅描边

// 鲸鱼剪影控制点（0-100 归一化，头朝左），Catmull-Rom 闭合样条
const CTRL = [
  [12, 50], [28, 30], [52, 26], [76, 38], [88, 52],
  [97, 34], [90, 58], [97, 76], [82, 64], [54, 74],
  [30, 70], [17, 60],
];

function catmullRom(pts, samplesPerSeg) {
  const out = [];
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n];
    const p1 = pts[i];
    const p2 = pts[(i + 1) % n];
    const p3 = pts[(i + 2) % n];
    for (let s = 0; s < samplesPerSeg; s++) {
      const t = s / samplesPerSeg;
      const t2 = t * t;
      const t3 = t2 * t;
      const x =
        0.5 * (2 * p1[0] + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3);
      const y =
        0.5 * (2 * p1[1] + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3);
      out.push([x, y]);
    }
  }
  return out;
}

function pointInPoly(px, py, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1];
    const xj = poly[j][0], yj = poly[j][1];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// ---------- 渲染（4x 超采样 → 盒式降采样） ----------
const SS = 4;

function makeIcon(size) {
  const big = size * SS;
  const buf = Buffer.alloc(big * big * 4);
  const putBig = (x, y, c) => {
    if (x < 0 || y < 0 || x >= big || y >= big) return;
    const i = (y * big + x) * 4;
    buf[i] = c[0]; buf[i + 1] = c[1]; buf[i + 2] = c[2]; buf[i + 3] = c[3];
  };
  const X = (u) => (u / 100) * big;
  const Y = (u) => (u / 100) * big;

  // 鲸鱼多边形（采样）
  const poly = catmullRom(CTRL, 24);
  const eye = [X(26), Y(48)];
  const eyeR = (4.2 / 100) * big;
  const finPoly = catmullRom(
    [
      [58, 40], [68, 44], [72, 56], [63, 52], [55, 47],
    ],
    12
  );

  // 白底圆角方（圆角半径 18%）
  const radius = big * 0.18;
  for (let y = 0; y < big; y++) {
    for (let x = 0; x < big; x++) {
      const cx = Math.min(Math.max(x, radius), big - 1 - radius);
      const cy = Math.min(Math.max(y, radius), big - 1 - radius);
      const dx = x - cx;
      const dy = y - cy;
      const inRound = dx * dx + dy * dy <= radius * radius;
      if (!inRound) continue;
      // 描边：距边缘 < 2% 用浅色
      const edge = x < big * 0.012 || y < big * 0.012 || x > big * 0.988 || y > big * 0.988;
      putBig(x, y, edge ? BORDER : BG);
    }
  }

  // 鲸鱼
  for (let y = 0; y < big; y++) {
    for (let x = 0; x < big; x++) {
      const u = (x / big) * 100;
      const v = (y / big) * 100;
      if (pointInPoly(u, v, poly)) putBig(x, y, WHALE);
      else if (pointInPoly(u, v, finPoly)) putBig(x, y, WHALE);
      const dx = x - eye[0];
      const dy = y - eye[1];
      if (dx * dx + dy * dy <= eyeR * eyeR) putBig(x, y, EYE);
    }
  }

  // 盒式降采样
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const i = ((y * SS + sy) * big + (x * SS + sx)) * 4;
          r += buf[i]; g += buf[i + 1]; b += buf[i + 2]; a += buf[i + 3];
        }
      }
      const n = SS * SS;
      const o = (y * size + x) * 4;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
      out[o + 3] = Math.round(a / n);
    }
  }
  return encodePNG(size, size, out);
}

const outDir = path.join(__dirname, '..', 'assets', 'icons');
fs.mkdirSync(outDir, { recursive: true });
const targets = [
  ['icon.png', 512],
  ['icon-256.png', 256],
  ['icon-32.png', 32],
  ['icon-16.png', 16],
  ['tray.png', 32],
];
for (const [name, size] of targets) {
  fs.writeFileSync(path.join(outDir, name), makeIcon(size));
  console.log('generated', name, size + 'x' + size);
}
console.log('icons done ->', outDir);
