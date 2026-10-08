/**
 * dsh-shell-brand-mark —— 宿主半边（有意留空）。
 *
 * 功能全在客户端半边：把 `conversation.hero.brand.mark` 插槽占成青色大肥鱼。
 *
 * ⚠️ **踩坑记录（2026-10-04，第一次就是栽在这）**
 * 宿主半边**必须是 `name` + `apply()` 的最小 cordis 插件形态**，不能只导出 `name`。
 *
 * 原因：`@deepseek-ai/dsh-client-modules` 只扫描**活动 loader 行**对应的包 ——
 * 而"活动"取决于这个模块能不能作为 cordis 插件被挂起来。只导出 `name` 的模块挂不上，
 * 于是 `dsh.client` 声明**根本不会被扫到**，客户端半边不会下发，
 * 页面上什么都不变，而**所有日志都是安静的**（不报错、不警告）。
 *
 * 所以这里哪怕什么都不做，也必须把 `apply` 写出来。
 */

export const name = 'shell-brand-mark';

export function apply() {
  // 无宿主侧行为；存在的意义是让本行"可挂载"，从而触发客户端清单扫描。
}
