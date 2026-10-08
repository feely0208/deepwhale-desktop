/**
 * dsh-shell-web-preview —— 宿主半边（占位）。
 *
 * ⚠️ 本包**不插入任何 loader 行**：它的组合层只是一条对官方 `ui-sidebar-browser` 的
 * `disabled` 覆盖（见 cordis.patch.yml）。所以这个文件在运行期**不会被 import**。
 *
 * 留着它是一个防御：万一将来有人给它加一条 insert 行，模块形态已经是可挂载的
 * （`name` + `apply()`），不会重复踩 dsh-shell-brand-mark 那个
 * 「只导出 name → 挂不上 → 客户端清单扫不到 → 安静地不生效」的坑。
 */

export const name = 'shell-web-preview';

export function apply() {
  // 无宿主侧行为。
}
