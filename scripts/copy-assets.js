// 构建后把静态资源复制到 dist/（tsc 只编译 TS，不搬运 css/html/js/图片）
// 用法：npm run build（tsc && node scripts/copy-assets.js）
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const dist = path.join(root, 'dist');

const targets = ['src/skins', 'src/pet', 'src/usage', 'src/apikey', 'src/settings', 'assets'];
for (const t of targets) {
  const src = path.join(root, t);
  const dest = path.join(dist, t.replace(/^src\//, ''));
  fs.cpSync(src, dest, { recursive: true });
  console.log('[copy-assets]', t, '->', dest);
}
console.log('[copy-assets] done');
