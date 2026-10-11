/**
 * dsh-shell-web-preview —— 宿主半边。
 *
 * 本插件**不需要宿主侧行为**：探测逻辑走 Electron 主进程的 IPC
 * （window.dsh.probeFrameable，见 src/preload/preload.ts 与 src/main/index.ts
 * 的 `webframe:probe`），真正的界面在客户端半边 lib/client.js。
 *
 * 但宿主半边**必须存在且被挂载**，原因是个容易踩的坑（dsh-shell-brand-mark
 * 就栽在这上面安静地不生效过两个月）：
 *   @deepseek-ai/dsh-client-modules 只扫描**活动 loader 行**对应的包，
 *   发现 `dsh.client` 声明后才把 `./client` 下发给浏览器。
 * 所以 cordis.patch.yml 里必须有 `- insert:` 本包这一行，name 与 package.json 一致。
 */
export const name = 'shell-web-preview';

export function apply() {
  // 无宿主侧行为：探测在主进程，界面在客户端半边。
}
