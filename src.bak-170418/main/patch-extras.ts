/**
 * 壳往 home 级 patch（`<DSH_HOME>/cordis.patch.yml`）里追加的**配置补丁块**。
 *
 * 为什么单独一个文件：legal-mode / office / bundled-plugins / feedback / mobile-connect
 * 各自管各自的注入；这里放的是「不需要本地路径、块内容固定」的小补丁，
 * 用同一个幂等追加套路，避免每个都写一遍。
 *
 * 现有块：
 *   - shell:model-label  模型显示名跟官方 V4.1-Flash-1017
 */

import * as fs from 'fs';
import * as path from 'path';

/** 幂等标记：文件里出现这一行就认为块已写入 */
export const MODEL_LABEL_MARKER = '# == shell:model-label';

/**
 * 模型目录补丁。
 *
 * ── 为什么需要它（2026-10-20）──────────────────────────────────────
 * DSH 0.2.1-rc.2 适配了 `DeepSeek-V4.1-Flash-1017` 检查点，但包内
 * `@deepseek-ai/dsh-llm-deepseek` 的 DEFAULT_MODELS 里 `name` 仍是
 * `DeepSeek-V4.1-Flash`（官方 /models 只返回 id `deepseek-flash`）。
 * 壳要显示官方的检查点名，只能在 patch 里覆盖 `llm-deepseek` 的 `config.models`。
 *
 * ── 风险（已在隔离实例冒烟过）─────────────────────────────────────
 * ① `models` 是**整个数组替换**：数组里少写一个模型，它就从选择器里消失；
 *    字段名写错 / 缺字段会让 Schema.validate 失败 → **DSH 起不来**
 *    （与 1.0.58 的 `host: 0.0.0.0` 是同一类死法）。
 * ② 上游以后新增模型**不会自动出现** —— 升级随包运行时后，要回来核对
 *    `dsh-runtime/node_modules/@deepseek-ai/dsh-llm-deepseek/lib/index.js`
 *    里的 DEFAULT_MODELS，把缺的条目补进下面的数组。
 *
 * 冒烟结论（2026-10-20，隔离实例 DSH 0.2.1-rc.2）：
 *   dump-config 里 name 已是 `DeepSeek-V4.1-Flash-1017`，服务启动干净、
 *   无 startup 错误、schema 校验通过。
 */
export const MODEL_LABEL_BLOCK = [
  MODEL_LABEL_MARKER + ' —— 模型显示名跟官方检查点（DeepSeek-V4.1-Flash-1017）',
  '# ⚠️ config.models 是【整数组替换】：DSH 上游以后新增的模型不会自动出现；',
  '#    升级随包运行时后，核对 dsh-llm-deepseek 的 DEFAULT_MODELS 并补齐下面条目。',
  '- id: llm-deepseek',
  '  config:',
  '    models:',
  '      - id: deepseek-flash',
  '        name: DeepSeek-V4.1-Flash-1017',
  '        contextWindow: 1000000',
  '        inputModalities:',
  '          - text',
  '          - image',
  '        systemPromptUpdate: in-history',
  '        toolUpdate: addition-only',
  '      - id: deepseek-v4-pro',
  '        name: DeepSeek-V4-Pro',
  "        description: 'Stronger agentic coding, knowledge, and difficult reasoning; suited to complex or quality-critical tasks at higher cost.'",
  '        contextWindow: 1000000',
  '',
].join('\n');

function patchFileOf(home: string): string {
  return path.join(home, 'cordis.patch.yml');
}

function readText(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/**
 * 幂等写入模型显示名块。
 * @returns 是否真的写了盘（内容已存在时返回 false，避免每次启动都改文件）
 */
export function ensureModelLabelPatch(home: string): boolean {
  const file = patchFileOf(home);
  const current = readText(file);
  if (current.includes(MODEL_LABEL_MARKER)) return false;

  const base = current.replace(/\s*$/, '');
  const next = `${base === '' ? '' : `${base}\n\n`}${MODEL_LABEL_BLOCK}`;
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(file, `${next.replace(/\s*$/, '')}\n`);
  return true;
}
