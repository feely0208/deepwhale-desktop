/**
 * dsh-shell-document-print —— 宿主半边。
 *
 * 本插件**不需要主进程能力**：打印走渲染层的 `window.print()`，
 * 所以宿主半边保持空实现（与 dsh-shell-session-actions 不同，后者要经
 * window.dsh.sessionAction 桥到 Electron 主进程做访达/剪贴板动作）。
 *
 * 宿主半边还有第二个意义（与 session-actions 相同）：它是客户端清单的**触发器** ——
 * `@deepseek-ai/dsh-client-modules` 只扫描**活动 loader 行**对应的包，
 * 发现 `dsh.client` 声明后才会把 `./client` 下发给浏览器。所以 name 必须与
 * cordis.patch.yml 里的行 id 一致（官方惯例）。
 */
export const name = 'shell-document-print';

export function apply() {
  // 无宿主侧行为。
}
