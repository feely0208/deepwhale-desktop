import * as fs from 'fs';
import * as path from 'path';

/**
 * 更新源（feed）—— 纯函数，刻意不依赖 electron，方便离线回归测试。
 *
 * ── 背景：为什么要有"自建更新源"────────────────────────────────────
 * 原来 App 检查更新只有一条路：GitHub Releases。国内用户经常连不上 GitHub，
 * 表现是"点检查更新没反应"——**根本不知道有新版本**。
 * 现在把安装包与 `latest*.yml` 都放到了自建 CDN（`dl.deepwhale.org.cn`），
 * 让它当主源，GitHub 只作兜底。
 *
 * ── 为什么必须留回退，不能只写 CDN ────────────────────────────────
 * CDN 是自建的：某个版本的 `latest*.yml` 忘了传、或者 CDN 抽风，
 * 只写 CDN 就等于**所有用户都收不到更新**，比原来更糟。
 * 所以回退配置不硬编码 owner/repo，而是**直接读打包时写好的 `app-update.yml`** ——
 * 那是 electron-builder 依据 `electron-builder.yml` 生成的，永远不会和构建配置脱节。
 */

/** 自建 CDN 的更新源地址。electron-updater 会在这里取 `latest.yml` / `latest-mac.yml` / `latest-linux.yml`。 */
export const CDN_FEED_URL = 'https://dl.deepwhale.org.cn';

/** 主源：自建 CDN（generic provider）。 */
export function cdnFeedConfig(): { provider: 'generic'; url: string } {
  return { provider: 'generic', url: CDN_FEED_URL };
}

/**
 * 读打包时生成的更新源配置（`<Resources>/app-update.yml`），用作回退。
 *
 * 这个文件是扁平的 `key: value`，没有嵌套结构，所以不用引入 YAML 解析器
 * （少一个依赖就少一处将来会坏的地方）。解析不出来就返回 null，调用方据此决定
 * "没有回退可用"，而不是拿一个半成品配置去 setFeedURL。
 *
 * @param resourcesPath - 打包态的 `process.resourcesPath`。
 */
export function readPackagedUpdateConfig(resourcesPath: string): Record<string, unknown> | null {
  let text: string;
  try {
    text = fs.readFileSync(path.join(resourcesPath, 'app-update.yml'), 'utf8');
  } catch {
    return null;
  }

  const out: Record<string, unknown> = {};
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const at = line.indexOf(':');
    if (at <= 0) continue;
    const key = line.slice(0, at).trim();
    const value = line
      .slice(at + 1)
      .trim()
      .replace(/^['"]|['"]$/g, '');
    if (key !== '' && value !== '') out[key] = value;
  }

  // provider 是必需的 —— 没有它 setFeedURL 会拿到一个用不了的配置
  return typeof out.provider === 'string' ? out : null;
}
