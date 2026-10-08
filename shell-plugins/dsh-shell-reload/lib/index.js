/**
 * dsh-shell-reload —— 宿主半边（有意留空）。
 *
 * 功能全在客户端半边：往 DSH 的快捷键服务注册一条 `shell.reload`。
 *
 * 宿主半边存在的唯一意义是**触发客户端清单**：`@deepseek-ai/dsh-client-modules`
 * 只扫描**活动 loader 行**对应的包，发现了 `dsh.client` 声明才会把 `./client`
 * 下发给浏览器（与 dsh-shell-session-actions / dsh-shell-document-print 同理）。
 */

export const name = 'shell-reload';

export function apply() {
  // 无宿主侧行为。
}
