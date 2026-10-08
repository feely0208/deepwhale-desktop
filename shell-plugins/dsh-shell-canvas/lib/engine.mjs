/**
 * 引擎定位 + 模板目录 + 校验（含"人话提示"）。
 *
 * 引擎（`canvas/`）是**独立工程**：它可能在
 *   · 开发机的检出目录里，
 *   · 用户自己 clone 的地方，
 *   · 将来随桌面端分发的资源目录里。
 * 所以这里不去猜一个写死的路径，而是给一条**明确的探测链**，并把探测过程原样
 * 回报给界面（用户看得见"我找过哪些地方、都缺什么"），而不是一句"找不到引擎"。
 */

import { existsSync, readFileSync, readdirSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';

/** 判定"这就是深鲸画布引擎根目录"的必备文件。 */
const MARKERS = [
  'src/pipeline.mjs',
  'src/validate.mjs',
  'src/render/index.mjs',
  'packs/video/domain.json',
  'templates',
];

/** 面板里显示的分组名（纯展示层；模板目录本身不动）。 */
const GROUP_LABELS = {
  '01-narration': '旁白口播',
  '02-quote': '金句引用',
  '03-steps': '步骤清单',
};

/** 用户手动指定过的引擎目录（面板里可改）。 */
export function overrideFile() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  return join(home, 'dsh-canvas.json');
}

export function readOverride() {
  try {
    const j = JSON.parse(readFileSync(overrideFile(), 'utf8'));
    return typeof j?.canvasRoot === 'string' && j.canvasRoot ? j.canvasRoot : null;
  } catch {
    return null;
  }
}

export function writeOverride(canvasRoot) {
  const f = overrideFile();
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, JSON.stringify({ canvasRoot, updatedAt: new Date().toISOString() }, null, 2) + '\n');
}

/** 检查一个目录像不像引擎根；不像就回报缺了什么。 */
export function probe(root) {
  if (!root) return null;
  const abs = resolve(root);
  if (!existsSync(abs)) return { root: abs, ok: false, missing: ['（目录不存在）'] };
  const missing = MARKERS.filter((m) => !existsSync(join(abs, m)));
  return { root: abs, ok: missing.length === 0, missing };
}

/** 探测链：显式覆盖 → 环境变量 → 常见检出位置。 */
export function candidates(explicit) {
  const home = homedir();
  return [
    explicit,
    process.env.DSH_CANVAS_ROOT,
    readOverride(),
    join(home, 'DeepSeek Harness', 'canvas'),
    join(home, 'deepwhale-canvas'),
    join(home, 'canvas'),
  ].filter(Boolean);
}

/**
 * 定位引擎根。
 * @returns {{ok:boolean, root:string|null, tried:Array<{root:string,ok:boolean,missing:string[]}>}}
 */
export function resolveEngineRoot(explicit = null) {
  const tried = [];
  const seen = new Set();
  for (const c of candidates(explicit)) {
    const abs = resolve(c);
    if (seen.has(abs)) continue;
    seen.add(abs);
    const p = probe(abs);
    tried.push(p);
    if (p.ok) return { ok: true, root: p.root, tried };
  }
  return { ok: false, root: null, tried };
}

/** 加载引擎的校验器与领域包（进程内缓存：目录 + mtime 变了才重载）。 */
const engineCache = new Map();

export async function loadEngine(root) {
  const registryPath = join(root, 'src/registry.mjs');
  const key = `${root}:${statSync(registryPath).mtimeMs}`;
  if (engineCache.has(key)) return engineCache.get(key);

  const registryMod = await import(pathToFileURL(registryPath).href);
  const validateMod = await import(pathToFileURL(join(root, 'src/validate.mjs')).href);
  const packs = registryMod.loadRegistry(join(root, 'packs'));
  const pack = packs.get('video') || null;
  if (pack) pack.engineRangeCheck = registryMod.satisfiesEngineRange(pack.domain.engineRange, validateMod.ENGINE_VERSION);

  const engine = {
    root,
    engineVersion: validateMod.ENGINE_VERSION,
    validateDocument: validateMod.validateDocument,
    packs: [...packs.keys()],
    pack,
    packVersion: pack ? `${pack.domain.domain}@${pack.domain.version}` : null,
  };
  engineCache.set(key, engine);
  return engine;
}

/** 读模板：按目录分组，一组 = 一份内容的两套版式（竖/横）。 */
export function readCatalog(root) {
  const tdir = join(root, 'templates');
  if (!existsSync(tdir)) return [];
  const groups = [];
  for (const dir of readdirSync(tdir).sort()) {
    const d = join(tdir, dir);
    if (!statSync(d).isDirectory()) continue;
    const files = readdirSync(d).filter((f) => f.endsWith('.json')).sort();
    if (!files.length) continue;

    const orientations = {};
    for (const f of files) {
      let doc;
      try { doc = JSON.parse(readFileSync(join(d, f), 'utf8')); } catch { continue; }
      const orientation = /horizontal|横/i.test(f) ? 'horizontal' : /vertical|竖/i.test(f) ? 'vertical' : f.replace(/\.json$/, '');
      orientations[orientation] = {
        file: `templates/${dir}/${f}`,
        meta: doc.meta,
        canvas: doc.canvas,
        vars: doc.vars || [],
      };
    }
    if (!Object.keys(orientations).length) continue;

    const first = Object.values(orientations)[0];
    groups.push({
      id: dir,
      name: GROUP_LABELS[dir] || first.meta?.name || dir.replace(/^\d+[-_]/, ''),
      orientations,
      vars: mergeVars(orientations),
      canvas: first.canvas,
      tags: first.meta?.tags || [],
      aiGenerated: !!first.meta?.aiGenerated,
      meta: first.meta,
    });
  }
  return groups;
}

/** 两套版式的变量取并集（同名合并；required 取"或"）。 */
function mergeVars(orientations) {
  const byKey = new Map();
  for (const o of Object.values(orientations)) {
    for (const v of o.vars || []) {
      const prev = byKey.get(v.key);
      if (!prev) { byKey.set(v.key, { ...v }); continue; }
      byKey.set(v.key, {
        ...prev,
        ...v,
        required: !!(prev.required || v.required),
        default: prev.default !== undefined ? prev.default : v.default,
        max: Math.max(prev.max || 1, v.max || 1),
      });
    }
  }
  return [...byKey.values()];
}

/** 取一组模板的两份文档（带完整节点）。 */
export function loadPair(root, groupId) {
  const d = join(root, 'templates', groupId);
  if (!existsSync(d) || !statSync(d).isDirectory()) throw new Error(`模板组不存在：${groupId}`);
  const pair = {};
  for (const f of readdirSync(d).filter((x) => x.endsWith('.json')).sort()) {
    const orientation = /horizontal|横/i.test(f) ? 'horizontal' : 'vertical';
    pair[orientation] = JSON.parse(readFileSync(join(d, f), 'utf8'));
  }
  return pair;
}

/**
 * 错误码 → 人话（"我该改哪里"）。
 * 引擎的 `msg` 说的是**是什么错**，这里补的是**怎么改**；两者一起给用户看。
 */
const CODE_ADVICE = {
  E_FORBIDDEN_KEY: '模板里出现了脚本或事件处理代码。模板只能是数据 —— 把逻辑去掉，改由变量或领域包表达。',
  E_EXTERNAL_URL: '模板引用了外链。素材只能是包内路径或用户槽位（渲染进程是断网的）。',
  E_RESOURCE_PATH_ESCAPE: '素材路径用 `..` 或绝对路径逃出了领域包目录。改成包内相对路径。',
  E_CANVAS_LIMIT: '画布尺寸 / 帧率 / 帧数超过了领域包预设的上限。改小一点，或换一个预设。',
  E_NODE_TYPE_UNKNOWN: '用了白名单外的节点类型。看 `packs/video/domain.json` 的 `nodes` 列表。',
  E_ANIM_UNKNOWN: '用了白名单外的动效名。看 `packs/video/domain.json` 的 `animations` 列表。',
  E_RESOURCE_TOO_LARGE: '素材声明的体积合计超限。压缩素材或减少数量。',
  E_VAR_UNDEFINED: '模板里 `{{x}}` 用了一个没在 `vars` 里声明的变量。补上声明。',
  E_TIMELINE_NODE_UNKNOWN: '时间轴引用了一个不存在的节点 id。检查拼写。',
  E_TIMELINE_RANGE: '时间轴的 `from/to` 不合法（单位为帧，且 `from` 必须小于 `to`）。',
  E_NODE_COUNT_LIMIT: '节点总数超限。拆成多个模板。',
  E_DEPTH_LIMIT: '节点嵌套太深。减少 `children` 层级。',
  E_FONT_NOT_WHITELISTED: '字体不在白名单里。模板只能写**字体 ID**（不是字体名）—— 见领域包的 `fonts`。',
  E_BGM_NOT_IN_REGISTRY: '引用的音频不在 BGM 入库台账里。真实曲目必须走 `bgm-license-audit` 入库。',
  E_SCHEMA_INVALID: '结构不符合 JSON Schema。对照 `spec/v1/document.schema.json` 检查字段类型。',
  E_SPEC_MISSING: '缺少 `spec` 字段（应为 `"1"`）。',
  E_SPEC_UNSUPPORTED: '`spec` 版本不受支持（当前只支持 `1`）。',
  E_DOMAIN_UNKNOWN: '领域包注册表里没有这个 `domain`。',
  E_DOMAIN_VERSION_MISMATCH: '`domainVersion` 与已加载领域包版本不一致。',
  W_AI_LABEL_REQUIRED: '领域包要求声明 AI 标识，但模板没写 `meta.aiGenerated`。',
};

export function humanize(issue) {
  return {
    level: issue.level,
    code: issue.code,
    path: issue.path || '',
    msg: issue.msg,
    hint: issue.hint || '',
    advice: CODE_ADVICE[issue.code] || '',
  };
}

/** 由流水线自动生成、不向用户索要的变量（字幕来自配音后的真实时长）。 */
export const AUTO_VARS = new Set(['subtitle']);

/**
 * 校验一个模板组 + 用户填的变量。
 *
 * 两道闸门，都在**进入渲染之前**：
 *   ① 引擎的 `validateDocument`（规范层，10 条硬规则）；
 *   ② 必填变量是否都填了（`applyVars` 会抛，先在这里变成可读的提示）。
 */
export async function validateGroup(root, groupId, vars = {}) {
  const engine = await loadEngine(root);
  const pair = loadPair(root, groupId);
  const catalog = readCatalog(root).find((g) => g.id === groupId);
  const results = [];
  let ok = true;

  const missing = [];
  for (const v of catalog?.vars || []) {
    if (AUTO_VARS.has(v.key)) continue; // 由流水线填，见文件头
    if (v.required && !String(vars[v.key] ?? '').trim()) missing.push(v);
  }
  if (missing.length) {
    ok = false;
    results.push({
      orientation: 'vars',
      ok: false,
      errors: missing.length,
      warnings: 0,
      issues: missing.map((v) => ({
        level: 'error', code: 'E_VAR_REQUIRED', path: `vars.${v.key}`,
        msg: `必填变量还没填：${v.label || v.key}`,
        hint: '', advice: '在左边的表单里补上这一项。',
      })),
    });
  }

  for (const [orientation, doc] of Object.entries(pair)) {
    const v = engine.validateDocument(doc, engine.pack);
    if (!v.ok) ok = false;
    results.push({
      orientation,
      ok: v.ok,
      errors: v.errors,
      warnings: v.warnings,
      issues: v.issues.map(humanize),
    });
  }
  return { ok, engineVersion: engine.engineVersion, pack: engine.packVersion, templates: results };
}

/** 预览图缓存路径（由 posters 任务生成）。 */
export function posterPath(outputRoot, groupId, orientation) {
  return join(outputRoot, 'posters', `${groupId}-${orientation}`, 'frames', 'frame-000000.png');
}
