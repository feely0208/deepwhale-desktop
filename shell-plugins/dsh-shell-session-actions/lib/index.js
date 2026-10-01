/**
 * dsh-shell-session-actions —— 宿主半边。
 *
 * ── 为什么是空的 ─────────────────────────────────────────────────────
 * 本插件的全部界面都在客户端半边（`lib/client.js`）：DSH 的会话右键菜单是一个
 * 插槽（`sidebar.workspaces.session.menu.item`），只能由浏览器侧的客户端插件
 * 通过 `ctx.slots.register` 追加行。
 *
 * 宿主半边的存在意义只有两个：
 *   ① 让 profile 的 `dsh.profile.bundles` 有一个可挂载的 loader 行 ——
 *      这一步同时是客户端清单的触发器：`@deepseek-ai/dsh-client-modules` 只扫描
 *      **活动 loader 行**对应的包，发现 `dsh.client` 声明后才会把 `./client`
 *      作为客户端插件下发给浏览器。
 *   ② 万一将来需要宿主能力（例如自己找会话文件），有地方放。
 *
 * 因此这里只导出 cordis 插件的最小形态：name + 空 apply。
 */

export const name = 'shell-session-actions';

export function apply() {
  // 有意留空：功能在客户端半边。
}
