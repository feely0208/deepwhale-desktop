/**
 * dsh-shell-document-print —— 宿主半边。
 *
 * 本插件**不需要主进程能力**：打印走渲染层的 `window.print()`，
 * 所以宿主半边保持空实现（与 dsh-shell-session-actions 不同，后者要经
 * window.dsh.sessionAction 桥到 Electron 主进程做访达/剪贴板动作）。
 */
export const name = '@deepwhale-cn/dsh-shell-document-print';

export function apply() {
  // 无宿主侧行为。
}
