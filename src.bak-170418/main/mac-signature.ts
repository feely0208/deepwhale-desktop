/**
 * macOS 自动更新的「能不能」判定 —— 纯函数，刻意不依赖 electron。
 *
 * 为什么单独拆一个文件：update-manager.ts 依赖 electron，没法在纯 Node 下跑回归测试
 * （同 test-inject-race.js / test-migrate-attachments.js 的做法）。这里的判定逻辑是
 * 「能不能自动更新」这件事的关键分支，必须可测。
 *
 * ── 结论从哪来（2026-09-30 实测，不是推测）────────────────────────────
 *   Electron 的 autoUpdater 在 macOS 上就是 Squirrel.Mac，安装新版本前 ShipIt 会拿
 *   **当前正在运行的 App 的 designated requirement** 去校验新下载的包
 *   （ShipIt 内有 `currentApplicationSignature:` / `verifyBundleAtURL:usingSignature:`）。
 *   Electron 官方文档也写明："Your application must be signed for automatic updates on
 *   macOS. This is a requirement of Squirrel.Mac."
 *
 *   我们的包是 ad-hoc 签名（electron-builder `identity: '-'`），designated requirement
 *   退化成 **cdhash**，而 cdhash 每次构建都变：
 *     1.0.24 → cdhash H"7d23145201cc418de987fb38ef02454985630e71"
 *     1.0.25 → cdhash H"e5622bcdadaec5fc9c177aec695e7c22dfb71f14"
 *   于是「旧版校验新版」必然失败。实测（用系统自己的判定机制）：
 *     codesign --verify -R=<1.0.24 的 requirement> "DeepWhale Desktop.app" → 退出码 3
 *     codesign --verify -R=<1.0.25 自己的 requirement> 同包           → 退出码 0
 */

/**
 * codesign -dv 的输出里有没有一枚**正式的苹果开发者签名**。
 *
 * ad-hoc 签名（我们现在的包）输出的是 `Signature=adhoc`，且没有
 * `Authority=Developer ID Application`；正式签名则会有这一行。
 */
export function hasDeveloperIdSignature(codesignOutput: string): boolean {
  return /Authority=Developer ID Application/.test(codesignOutput);
}

/** 读取签名信息；拿不到时返回 null（视为"说不清"）。 */
export type SignatureProbe = () => string | null;

/**
 * macOS 上是否必须走「手动下载安装」这条路。
 *
 * ⚠️ 判定不出来时**一律按"需要手动"**处理：宁可少承诺一句"能自动更新"，
 *    也不能再演一次「显示下载完成 → 点了立即重启 → 其实什么都没发生」——
 *    那正是用户抱怨的「点了没反应」。
 *
 * 非 macOS 返回 false（Windows 的 NSIS 更新不要求代码签名，照常走自动更新）。
 */
export function needsManualUpdate(platform: string, probe: SignatureProbe): boolean {
  if (platform !== 'darwin') return false;
  const output = probe();
  if (output === null) return true;
  return !hasDeveloperIdSignature(output);
}
