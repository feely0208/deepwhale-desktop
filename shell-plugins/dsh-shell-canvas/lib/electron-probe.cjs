/**
 * Electron 可用性探针 —— 由 `lib/jobs.mjs` 的 `probeElectron()` 拉起。
 *
 * 只做一件事：证明"这个 Electron 二进制愿意跑我们给的脚本"。
 * 打包过的 .app 会无视 argv 里的脚本路径、直接加载自己的 app.asar，
 * 所以**不能靠文件存在来判断**，必须真跑一次。
 *
 *   <electron> lib/electron-probe.cjs <输出 json 路径>
 */
const fs = require('node:fs');

try {
  const electron = require('electron');
  fs.writeFileSync(process.argv[2], JSON.stringify({
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    appPath: typeof electron.app?.getAppPath === 'function' ? electron.app.getAppPath() : null,
  }, null, 2));
} catch (error) {
  try {
    fs.writeFileSync(process.argv[2], JSON.stringify({ error: String(error && error.message) }, null, 2));
  } catch { /* 写不了就算了，调用方按"没有产出"处理 */ }
}
process.exit(0);
