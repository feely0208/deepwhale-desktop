/**
 * dsh-shell-video-preview —— 宿主半边（有意留空）。
 *
 * 功能全在客户端半边（lib/client.js）：向 DSH 的文件预览注册表补一个
 * 「整份读入 + 内嵌播放」的媒体预览器，接走 mp4/mov/webm 等视频与音频后缀。
 *
 * 宿主半边存在的唯一意义是**触发客户端清单**：`@deepseek-ai/dsh-client-modules`
 * 只扫描**活动的 loader 行**对应的包，发现 `dsh.client` 声明才会把 `./client`
 * 下发给浏览器（与 dsh-shell-reload / dsh-shell-session-actions 同理）。
 * 没有这个文件 + cordis.patch.yml，客户端半边**永远不会被加载**。
 */

export const name = 'shell-video-preview';

export function apply() {
  // 无宿主侧行为。
}
