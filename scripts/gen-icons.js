// 生成应用/托盘图标（纯 Node、零依赖）：深色圆角底 + 原创卡通小鲸鱼（借鉴 DeepSeek 鲸鱼造型）
// 用法：npm run icons
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

// ---------- 极简 PNG 编码器 ----------
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

// ---------- 绘制（0-100 归一化坐标） ----------
const BG = [14, 28, 51, 255];        // 深海军蓝底 #0e1c33
const WHALE = [219, 238, 254, 255];  // 鲸身 浅蓝白 #dbeafe
const BELLY = [157, 184, 232, 255];  // 肚皮 #9db8e8
const DARK = [22, 35, 61, 255];      // 眼/鳍 #16233d
const SPOUT = [255, 255, 255, 255];  // 水花

function makeIcon(size) {
  const buf = Buffer.alloc(size * size * 4);
  const put = (x, y, c) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    buf[i] = c[0]; buf[i + 1] = c[1]; buf[i + 2] = c[2]; buf[i + 3] = c[3];
  };
  const X = (u) => Math.round((u / 100) * size);
  const Y = (u) => Math.round((u / 100) * size);

  // 圆角方底
  const radius = Math.max(2, Math.round(size * 0.2));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const cx = Math.min(Math.max(x, radius), size - 1 - radius);
      const cy = Math.min(Math.max(y, radius), size - 1 - radius);
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy <= radius * radius) put(x, y, BG);
    }
  }

  // 椭圆/圆
  const fillEllipse = (cx, cy, rx, ry, color) => {
    for (let y = Math.max(0, Y(cy) - Y(ry)); y <= Math.min(size - 1, Y(cy) + Y(ry)); y++) {
      for (let x = Math.max(0, X(cx) - X(rx)); x <= Math.min(size - 1, X(cx) + X(rx)); x++) {
        const nx = (x - X(cx)) / Math.max(1, X(rx));
        const ny = (y - Y(cy)) / Math.max(1, Y(ry));
        if (nx * nx + ny * ny <= 1) put(x, y, color);
      }
    }
  };
  const fillCircle = (cx, cy, r, color) => fillEllipse(cx, cy, r, r, color);

  // 三角形
  const fillTri = (p1, p2, p3, color) => {
    const xs = [X(p1[0]), X(p2[0]), X(p3[0])];
    const ys = [Y(p1[1]), Y(p2[1]), Y(p3[1])];
    const minX = Math.max(0, Math.min(...xs));
    const maxX = Math.min(size - 1, Math.max(...xs));
    const minY = Math.max(0, Math.min(...ys));
    const maxY = Math.min(size - 1, Math.max(...ys));
    const sign = (ax, ay, bx, by, px, py) => (bx - ax) * (py - ay) - (by - ay) * (px - ax);
    const d1 = sign(xs[0], ys[0], xs[1], ys[1], xs[0] + 1, ys[0]);
    const d2 = sign(xs[1], ys[1], xs[2], ys[2], xs[1] + 1, ys[1]);
    const d3 = sign(xs[2], ys[2], xs[0], ys[0], xs[2] + 1, ys[2]);
    const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
    const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const a = sign(xs[0], ys[0], xs[1], ys[1], x, y);
        const b = sign(xs[1], ys[1], xs[2], ys[2], x, y);
        const c = sign(xs[2], ys[2], xs[0], ys[0], x, y);
        const hasNeg2 = a < 0 || b < 0 || c < 0;
        const hasPos2 = a > 0 || b > 0 || c > 0;
        if (!(hasNeg2 && hasPos2)) put(x, y, color);
      }
    }
  };

  // 鲸鱼（头朝左，正在游）
  fillEllipse(46, 58, 36, 21, WHALE);           // 身体
  fillEllipse(44, 66, 24, 10, BELLY);           // 肚皮
  fillCircle(20, 44, 13, WHALE);                // 头部圆润
  fillTri([80, 50], [96, 34], [90, 56], WHALE); // 尾鳍上
  fillTri([80, 50], [96, 66], [90, 58], WHALE); // 尾鳍下
  fillEllipse(30, 56, 7, 4, DARK);              // 胸鳍
  fillCircle(22, 44, 4.2, DARK);                // 眼睛
  fillCircle(20.5, 42.5, 1.4, SPOUT);           // 眼睛高光
  // 微笑（近似短弧）
  for (let i = 0; i < 5; i++) {
    const px = 16 + i * 1.6;
    const py = 54 + Math.round(Math.abs(i - 2) * 0.8);
    put(X(px), Y(py), DARK);
  }
  // 水花
  fillCircle(15, 22, 4, SPOUT);
  fillCircle(10, 16, 2.6, SPOUT);
  fillCircle(21, 15, 2.6, SPOUT);

  return encodePNG(size, size, buf);
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
