/**
 * 官方插件市场（Discover）索引注入 —— 让新装用户打开「插件市场」就能看到深鲸的插件。
 *
 * ── 为什么要有这一步（2026-10-28）───────────────────────────────────────
 * DSH 的插件市场**没有官方收录名单**：它就是「读用户配置的索引」（format 1 JSON）。
 * `@deepseek-ai/dsh-plugin-market` 的文档写得很直白：
 *   `indexes` 默认 `[]`，**没配索引时 Host 一个请求都不发** —— 新装用户的
 *   「插件市场 / 发现」页是空的。
 *
 * 我们的官网早就按官方格式生成了索引（67 个插件，且用官方校验器
 * `@deepseek-ai/dsh-plugin-market-index` 实测通过）。缺的只有一件事：
 * **把索引地址写进用户 profile**，让官方市场自己去读。
 *
 * 所以这里做两件事，都在**壳自己拥有的 profile 层**上，不碰用户的其它配置：
 *   ① profile `package.json` 的 `dsh.profile.bundles` 里补上官方市场 bundle
 *      （`@deepseek-ai/dsh-experimental-plugin-market-bundle`；自带 profile 默认不开它）；
 *   ② profile `cordis.patch.yml` 里补一行 `plugin-market` 的行级配置，把我们的索引放进
 *      `config.indexes` —— 和用户在设置页手动「添加索引」写进去的是**同一个位置**。
 *
 * ⚠️ 只播种一次（`<home>/.plugin-market-seeded`）：用户如果把这个索引删了，那是他的
 *    选择，下次启动**不能**又给他加回去。profile 被重置（package.json 里没有我们的
 *    bundle）时标记失效，会重新播种 —— 那才是真的"重来一次"。
 *
 * ⚠️ 绝不能因为这一步失败而影响启动：纯增量，失败只记日志。
 */

import * as fs from 'fs';
import * as path from 'path';
import { profileDirOf } from './profile';
import { writeFileAtomic } from './patch-heal';

/** 我们自己的市场索引（format 1，官方校验器验证过）。 */
export const MARKET_INDEX_URL = 'https://deepwhale.org.cn/plugin-market.json';

/** 挂载官方市场服务的实验性 bundle（自带 profile 默认不开）。 */
export const MARKET_BUNDLE = '@deepseek-ai/dsh-experimental-plugin-market-bundle';

/** 市场服务自己的包名（bundle 里的那一行）。 */
export const MARKET_ROW_NAME = '@deepseek-ai/dsh-plugin-market';

/** 行级配置的 id（与用户在设置页添加索引时写入的 id 相同）。 */
export const MARKET_ROW_ID = 'plugin-market';

/** 「已播种」标记，放在 home 根下。 */
const SEED_MARKER = '.plugin-market-seeded';

export interface PluginMarketResult {
  /** 本轮是否写过盘。 */
  changed: boolean;
  /** profile 还不存在（首启），这一轮写不进去，等下一轮。 */
  profilePending: boolean;
}

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** 只看有效内容（去注释与空行）—— 用于判断文件是不是"空数组"。 */
function effectiveContent(text: string): string {
  return text
    .split('\n')
    .filter((line) => line.trim() !== '' && !line.trim().startsWith('#'))
    .join('\n')
    .trim();
}

/** 打开官方 bundle：在 profile 的 `dsh.profile.bundles` 里补一项。 */
function ensureBundle(file: string): boolean {
  const current = readText(file);
  if (current === null) return false;
  let manifest: {
    dsh?: { profile?: { bundles?: string[] } };
    [key: string]: unknown;
  };
  try {
    manifest = JSON.parse(current) as typeof manifest;
  } catch {
    return false;
  }
  const profile = manifest.dsh?.profile ?? {};
  const bundles = [...(profile.bundles ?? [])];
  if (bundles.includes(MARKET_BUNDLE)) return false;
  bundles.push(MARKET_BUNDLE);
  manifest.dsh = { ...(manifest.dsh ?? {}), profile: { ...profile, bundles } };
  writeFileAtomic(file, `${JSON.stringify(manifest, null, 2)}\n`);
  return true;
}

/** 新行块（profile 里没有这一行时整段追加）。 */
function marketRowBlock(): string[] {
  return [
    `- id: ${MARKET_ROW_ID}`,
    `  name: "${MARKET_ROW_NAME}"`,
    '  config:',
    '    indexes:',
    `      - ${MARKET_INDEX_URL}`,
  ];
}

/**
 * 把我们的索引塞进 patch 文本里的 `plugin-market` 行。
 *
 * 纯文本手术，**不整段重写 YAML**：这个文件里有用户/壳手工维护的注释与其它行
 * （主题、聊天、模型显示名…），整段 dump 会把它们全丢掉。
 * 只在"找不到该行"或"该行是空数组/空文件"时才追加整块。
 *
 * @returns 新文本；无法安全处理时返回 null（宁可不写，也不要把配置文件改坏）。
 */
export function upsertMarketIndexRow(text: string): string | null {
  // 已经有我们的索引（老用户自己加过，或上一轮播种过）—— 一个字节都不动。
  if (text.includes(MARKET_INDEX_URL)) return text;

  const lines = text.split('\n');
  const start = lines.findIndex((line) => /^-\s+id:\s*['"]?plugin-market['"]?\s*$/.test(line));

  if (start === -1) {
    const block = marketRowBlock();
    const effective = effectiveContent(text);
    if (effective === '' || effective === '[]') {
      const comments = lines.filter((line) => line.trim().startsWith('#')).join('\n');
      return `${comments === '' ? '' : `${comments}\n`}${block.join('\n')}\n`;
    }
    return `${text.replace(/\s*$/, '')}\n\n${block.join('\n')}\n`;
  }

  // 定位这一行的结束位置：下一个顶层列表项（行首 `-`）之前都算这一行。
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^-\s/.test(lines[i])) {
      end = i;
      break;
    }
  }
  const span = lines.slice(start, end);

  const findLine = (pattern: RegExp): number => span.findIndex((line) => pattern.test(line));

  const indexesAt = findLine(/^\s+indexes:\s*$/);
  const indexesInlineAt = findLine(/^\s+indexes:\s*\[.*\]\s*$/);

  if (indexesAt >= 0) {
    // 已有块状 indexes：保持原有条目，把我们的 URL 追加到列表末尾。
    const indexesIndent = (span[indexesAt].match(/^(\s*)/)?.[1] ?? '  ').length;
    let itemIndent = indexesIndent + 2;
    let insertAt = start + indexesAt + 1;
    for (let i = indexesAt + 1; i < span.length; i += 1) {
      const item = span[i].match(/^(\s*)-\s+/);
      if (item) {
        itemIndent = item[1].length;
        insertAt = start + i + 1;
        continue;
      }
      if (span[i].trim() === '' || span[i].trim().startsWith('#')) continue;
      break; // 走到下一个键了
    }
    lines.splice(insertAt, 0, `${' '.repeat(itemIndent)}- ${MARKET_INDEX_URL}`);
    return lines.join('\n');
  }

  if (indexesInlineAt >= 0) {
    // 内联写法（`indexes: []` / `indexes: [a, b]`）：换成块状，保留已有条目。
    const indent = span[indexesInlineAt].match(/^(\s*)/)?.[1] ?? '    ';
    const inner = span[indexesInlineAt].replace(/^\s+indexes:\s*\[/, '').replace(/\]\s*$/, '');
    const existing = inner
      .split(',')
      .map((item) => item.trim().replace(/^['"]|['"]$/g, ''))
      .filter((item) => item !== '');
    const replacement = [
      `${indent}indexes:`,
      ...existing.map((item) => `${indent}  - ${item}`),
      `${indent}  - ${MARKET_INDEX_URL}`,
    ];
    lines.splice(start + indexesInlineAt, 1, ...replacement);
    return lines.join('\n');
  }

  // 没有 indexes：补在 config 下；连 config 都没有就在行尾起一个。
  const configAt = findLine(/^\s+config:\s*$/);
  const configInlineAt = findLine(/^\s+config:\s*\{\s*\}\s*$/);
  if (configAt >= 0) {
    const indent = span[configAt].match(/^(\s*)/)?.[1] ?? '  ';
    lines.splice(start + configAt + 1, 0, `${indent}  indexes:`, `${indent}    - ${MARKET_INDEX_URL}`);
    return lines.join('\n');
  }
  if (configInlineAt >= 0) {
    const indent = span[configInlineAt].match(/^(\s*)/)?.[1] ?? '  ';
    lines.splice(
      start + configInlineAt,
      1,
      `${indent}config:`,
      `${indent}  indexes:`,
      `${indent}    - ${MARKET_INDEX_URL}`,
    );
    return lines.join('\n');
  }
  lines.splice(end, 0, '  config:', '    indexes:', `      - ${MARKET_INDEX_URL}`);
  return lines.join('\n');
}

/** 结构自检：写回前用 js-yaml 确认"文件仍是数组、且我们的行里真有这个索引"。 */
function patchLooksRight(text: string): boolean {
  try {
    const yaml = require('js-yaml') as { load?: (input: string) => unknown };
    if (typeof yaml.load !== 'function') return true; // 没有 js-yaml 就不拦（可选依赖）
    const parsed = yaml.load(text);
    if (!Array.isArray(parsed)) return false;
    const row = parsed.find(
      (entry) => entry !== null && typeof entry === 'object' && (entry as { id?: unknown }).id === MARKET_ROW_ID,
    ) as { config?: { indexes?: unknown } } | undefined;
    const indexes = row?.config?.indexes;
    return Array.isArray(indexes) && indexes.includes(MARKET_INDEX_URL);
  } catch {
    return false;
  }
}

/**
 * 幂等注入：把官方市场 bundle + 我们的索引写进 profile。
 *
 * @param home - 本应用专属的 DSH home。
 * @param runtimeNodeModules - 随包运行时的 node_modules（用于确认这个运行时里确实有
 *                             官方市场 bundle；没有就整体跳过，别往 profile 里写一个装不上的 bundle）。
 */
export function ensurePluginMarket(home: string, runtimeNodeModules?: string): PluginMarketResult {
  // 运行时里没有官方市场 bundle（旧运行时 / 被裁剪）：跳过，不留半截配置。
  if (runtimeNodeModules) {
    try {
      const pkg = path.join(runtimeNodeModules, ...MARKET_BUNDLE.split('/'), 'package.json');
      if (!fs.existsSync(pkg)) return { changed: false, profilePending: false };
    } catch {
      return { changed: false, profilePending: false };
    }
  }

  const profileDir = profileDirOf(home);
  const manifestPath = path.join(profileDir, 'package.json');
  const patchPath = path.join(profileDir, 'cordis.patch.yml');

  // 与 legal-mode / office / bundled-plugins 同一套时序约定：
  // 目录先于文件落盘，文件还没就位就是 pending（DSH 首启会先建目录再写文件）。
  const profilePending =
    !fs.existsSync(profileDir) ||
    !fs.existsSync(manifestPath) ||
    !fs.existsSync(patchPath);
  if (profilePending) return { changed: false, profilePending: true };

  // 已播过种、且 profile 里确实还挂着官方市场 bundle → 一个字节都不动。
  // 这一条是为了**尊重用户的删除**：他在设置里把我们的索引删掉，是他的选择，
  // 下次启动不能又给他加回去。只有 profile 被重置（bundle 也没了）才重新播种。
  if (fs.existsSync(path.join(home, SEED_MARKER))) {
    const manifestText = readText(manifestPath) ?? '';
    if (manifestText.includes(MARKET_BUNDLE)) {
      return { changed: false, profilePending: false };
    }
  }

  let changed = false;

  // ① bundle
  changed = ensureBundle(manifestPath) || changed;

  // ② 索引行
  const current = readText(patchPath);
  if (current === null) return { changed, profilePending: false };
  const next = upsertMarketIndexRow(current);
  if (next === null) {
    console.warn('[plugin-market] patch 结构无法安全改写，跳过索引注入（不影响启动）');
    return { changed, profilePending: false };
  }
  if (next !== current) {
    if (!patchLooksRight(next)) {
      console.warn('[plugin-market] 写入前自检不通过，跳过索引注入（不影响启动）');
      return { changed, profilePending: false };
    }
    writeFileAtomic(patchPath, next);
    changed = true;
  }

  // ③ 播种标记：只播一次，之后用户删掉索引是他自己的选择。
  try {
    fs.writeFileSync(path.join(home, SEED_MARKER), `${new Date().toISOString()}\n`);
    changed = true;
  } catch {
    /* 标记写不了不致命：下一轮还会再判断一次，幂等 */
  }

  return { changed, profilePending: false };
}

/** 是否已经播过种（导出给测试与诊断用）。 */
export function marketSeeded(home: string): boolean {
  try {
    return fs.existsSync(path.join(home, SEED_MARKER));
  } catch {
    return false;
  }
}
