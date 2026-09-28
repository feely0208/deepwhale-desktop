#!/usr/bin/env node
/**
 * 把「法律模式」预设打包成一个 **bundle**，产物写到 `bundled-plugins/dsh-legal-preset/`。
 *
 * ── 为什么必须这么做（2026-09-28，用户在 Windows 上发现的真 bug）──────────
 * 壳原来把预设写成 `<home>/.agent-presets/legal-mode/`（`preset.yml` + `agent.cordis.yml`）。
 * 那是**老机制**。随包运行时（0.1.7-rc.2）自带的技能文档写得很直白：
 *
 *   a user preset was a directory `$DSH_HOME/.agent-presets/<id>/` …
 *   **Nothing reads that directory any more.**
 *
 * 实测坐实：`dsh --profile web --dump-config` 组合出来的树里只有 4 个预设
 * （`preset-standard` / `ptc` / `minimal` / `cordis`，全是运行时自带的），
 * **没有 preset-legal** —— 所以"法律模式"永远不会出现在预设选择器里，三平台都一样。
 *
 * 新机制：预设是 `@deepseek-ai/dsh-agent-preset` 的**声明**，由 bundle 的 patch 携带。
 * 随包预设的真实形态就是 `@deepseek-ai/dsh-web-app/presets/*.patch.yml`，
 * 通过 package.json 的 `dsh.bundle.patch` 声明。本脚本照这个形态生成。
 *
 * ── persona 字段名 ─────────────────────────────────────────────────
 * 老预设用 `text:`（0.1.2 形态），而随包运行时用 `prefix:`。
 * 壳原来是在**注入时**改写（adaptPresetToRuntime）；改成 bundle 之后，
 * patch 是静态文件，必须在**构建时**就写对 —— 所以这里直接产出 `prefix:`。
 *
 * 用法：node scripts/build-legal-preset-bundle.js [--out <bundled-plugins 目录>]
 */
'use strict';

const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const PRESET_DIR = path.join(REPO, 'legal-mode', 'preset');
const OUT_DIR = path.join(REPO, 'bundled-plugins');
const DIR_NAME = 'dsh-legal-preset';

/** 必须与 bundled-plugins.ts 的清单、以及 profile `dsh.profile.bundles` 里的条目完全一致。 */
const PKG_NAME = '@deepwhale-cn/dsh-legal-preset';
/** 预设 id：选择器里显示的名字取自 config.name，id 用于 Loader 行 `preset-<id>`。 */
const PRESET_ID = 'legal';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out') {
      out.out = argv[i + 1];
      i += 1;
    }
  }
  return out;
}

/** 从 preset.yml 取展示用的 name / description / order（不引 yaml 依赖，格式固定）。 */
function readMetadata(text) {
  const pick = (key) => {
    const m = text.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
    return m ? m[1].trim() : undefined;
  };
  return {
    name: pick('name') ?? '法律模式',
    description: pick('description'),
    order: Number(pick('order') ?? 5),
  };
}

/**
 * 老预设的 persona 行用 `text:`，随包运行时要 `prefix:` —— 只改这一行，其余原样。
 * 与壳里 `adaptPresetToRuntime` 的判定一致（它只在 `- id: persona` 之后 6 行内找）。
 */
function toPrefixForm(content) {
  const lines = content.split('\n');
  const at = lines.findIndex((line) => /^- id:\s*persona\s*$/.test(line));
  if (at < 0) return content;
  for (let i = at + 1; i < lines.length && i < at + 6; i += 1) {
    if (lines[i].startsWith('    text:')) {
      lines[i] = `    prefix:${lines[i].slice('    text:'.length)}`;
      return lines.join('\n');
    }
  }
  return content;
}

function build(outRoot) {
  const presetYml = fs.readFileSync(path.join(PRESET_DIR, 'preset.yml'), 'utf8');
  const composition = fs.readFileSync(path.join(PRESET_DIR, 'agent.cordis.yml'), 'utf8');
  const meta = readMetadata(presetYml);

  // 顶层行列表整体缩进到 config.plugins: 之下。
  // 注释也一起缩进 —— YAML 里注释的缩进无所谓，但保持结构整齐便于人工核对。
  const plugins = toPrefixForm(composition)
    .split('\n')
    // ⚠️ 必须比 `plugins:` 那一行更深。第一版缩进成 6 空格（比键还浅），
    //    YAML 直接解析失败 —— 别想当然，改完要跑校验。
    .map((line) => (line.trim() === '' ? line : `          ${line}`))
    .join('\n');

  const patch = `# ${PKG_NAME} 的组合层：把「法律模式」声明插进花名册。
#
# 这个文件由 scripts/build-legal-preset-bundle.js 从 legal-mode/preset/ 生成，
# **不要手改产物** —— 改 legal-mode/preset/agent.cordis.yml 再重新构建。
#
# 为什么是这种形态：随包运行时（0.1.7-rc.2）起，预设不再是
# \`$DSH_HOME/.agent-presets/<id>/\` 目录，而是 \`@deepseek-ai/dsh-agent-preset\`
# 的声明，由 bundle 的 patch 携带（随包预设就是 dsh-web-app/presets/*.patch.yml）。
- insert:
    - id: preset-${PRESET_ID}
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: ${PRESET_ID}
        name: ${JSON.stringify(meta.name)}
${meta.description ? `        description: ${JSON.stringify(meta.description)}\n` : ''}        order: ${meta.order}
        plugins:
${plugins}
`;

  const pkg = {
    name: PKG_NAME,
    version: '1.0.0',
    description: '深鲸壳随包的「法律模式」Agent 预设：以 bundle 声明的方式挂进 DSH 花名册。',
    private: true,
    type: 'module',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  };

  const dest = path.join(outRoot, DIR_NAME);
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(path.join(dest, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
  fs.writeFileSync(path.join(dest, 'cordis.patch.yml'), patch);
  return { dest, meta, bytes: Buffer.byteLength(patch) };
}

const args = parseArgs(process.argv.slice(2));
const outRoot = args.out ? path.resolve(args.out) : OUT_DIR;
const { dest, meta, bytes } = build(outRoot);
console.log(`[legal-preset] 已生成 ${path.relative(REPO, dest)}`);
console.log(`  name=${meta.name} id=${PRESET_ID} order=${meta.order}`);
console.log(`  cordis.patch.yml ${bytes} 字节`);
