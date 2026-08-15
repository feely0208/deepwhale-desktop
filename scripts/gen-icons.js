// 生成应用/托盘图标（纯 Node、零依赖）：蓝色圆角方块 + 白色 "D" 像素字
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
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// ---------- 绘制 ----------
const COLOR_BG = [77, 124, 254, 255]; // #4d7cfe
const COLOR_FG = [255, 255, 255, 255];
const COLOR_BORDER = [58, 95, 216, 255];

// 5x7 像素字体 "D"
const FONT_D = ['11110', '10001', '10001', '10001', '10001', '10001', '11110'];

function makeIcon(size) {
  const buf = Buffer.alloc(size * size * 4);
  const s = Math.max(1, Math.floor(size / 9)); // 每像素格边长
  const margin = Math.floor((size - 7 * s) / 2); // 垂直居中
  const left = Math.floor((size - 5 * s) / 2); // 水平居中
  const radius = Math.max(2, Math.floor(size * 0.12));

  function put(x, y, color) {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    buf[i] = color[0];
    buf[i + 1] = color[1];
    buf[i + 2] = color[2];
    buf[i + 3] = color[3];
  }

  function inRoundRect(x, y) {
    const cx = Math.min(Math.max(x, radius), size - 1 - radius);
    const cy = Math.min(Math.max(y, radius), size - 1 - radius);
    const dx = x - cx;
    const dy = y - cy;
    return dx * dx + dy * dy <= radius * radius;
  }

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const border = x < 1 || y < 1 || x >= size - 1 || y >= size - 1;
      if (inRoundRect(x, y)) put(x, y, border ? COLOR_BORDER : COLOR_BG);
    }
  }

  for (let row = 0; row < 7; row++) {
    for (let col = 0; col < 5; col++) {
      if (FONT_D[row][col] !== '1') continue;
      const px = left + col * s;
      const py = margin + row * s;
      for (let dy = 0; dy < s; dy++) {
        for (let dx = 0; dx < s; dx++) put(px + dx, py + dy, COLOR_FG);
      }
    }
  }
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
