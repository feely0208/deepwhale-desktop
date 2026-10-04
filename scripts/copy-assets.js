// 构建后把静态资源复制到 dist/（tsc 只编译 TS，不搬运 css/html/js/图片）
// 用法：npm run build（tsc && node scripts/copy-assets.js）
//
// ⚠️ 2026-10-03 踩坑：`fs.cpSync` 只覆盖不清理 —— 源里已经删掉的资源会**一直留在 dist/**。
//    症状很隐蔽：打包后的应用读的是 `Resources/app/dist/assets/...`，于是早就删掉的
//    宠物（cat.svg / frog.svg / 绿领 / 改名前的大青鲸）每次启动又被复制进用户宠物目录，
//    "彻底删掉"根本删不干净。
//    → 复制前先把目标目录删掉，保证 dist 与源严格一致。
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const dist = path.join(root, 'dist');

const targets = ['src/pet', 'src/usage', 'src/apikey', 'src/settings', 'src/petstudio', 'src/welcome', 'src/localfiles', 'src/update-popup', 'assets'];
for (const t of targets) {
  const src = path.join(root, t);
  const dest = path.join(dist, t.replace(/^src\//, ''));
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(src, dest, { recursive: true });
  console.log('[copy-assets]', t, '->', dest);
}
console.log('[copy-assets] done');
