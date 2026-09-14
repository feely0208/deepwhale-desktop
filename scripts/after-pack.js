const fs = require('fs');
const path = require('path');

// electron-builder afterPack 钩子：把随包 DSH 运行时的目录名改回 node_modules。
//
// 背景：electron-builder 会跳过 extraResources 里名为 node_modules 的目录
// （即使显式写 filter: ['**/*', 'node_modules/**'] 也无效，实测只复制到 package.json）。
// 因此构建时把运行时依赖装到 dsh-runtime/pkgs/，打进包之后在这里改回 node_modules/
// —— Node 的模块解析只认这个名字。afterPack 先于代码签名，不影响签名结果。

module.exports = async function afterPack(context) {
  const appOutDir = context.appOutDir;
  const platform = context.electronPlatformName;
  const productName = context.packager.appInfo.productFilename;
  const resourcesDir =
    platform === 'darwin'
      ? path.join(appOutDir, productName + '.app', 'Contents', 'Resources')
      : path.join(appOutDir, 'resources');

  const pkgs = path.join(resourcesDir, 'dsh-runtime', 'pkgs');
  const nodeModules = path.join(resourcesDir, 'dsh-runtime', 'node_modules');

  if (!fs.existsSync(pkgs)) {
    console.warn('[after-pack] 未找到 dsh-runtime/pkgs，跳过改名（运行时可能未随包）');
    return;
  }
  fs.rmSync(nodeModules, { recursive: true, force: true });
  fs.renameSync(pkgs, nodeModules);
  console.log('[after-pack] dsh-runtime: pkgs -> node_modules');
};
