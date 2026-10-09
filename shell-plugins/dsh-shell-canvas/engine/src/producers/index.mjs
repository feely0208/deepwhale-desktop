/**
 * 生产者（Producer）注册表 —— 框架第 ③ 层。
 *
 * 为什么要有这一层（2026-10-09 定）：
 *   框架的定位是"每一层都能被换掉"。渲染器已经有了适配器机制，
 *   但"内容 → 分镜/片子"这一步是**写死**的：只会拿模板变量直接渲染。
 *   于是"换个内容形态"就必须改引擎 —— 这就是为什么它只能做图文成片。
 *
 *   生产者接口把这一步开放出来：
 *     produce(input) → { template, vars, assets, notes }
 *   任何内容形态（文案 / 文档 / 表格 / 数据库 / 外部 API）只要写一个 producer，
 *   就能接进同一条渲染管线。**引擎不用动。**
 *
 * 约定（保持极简，够用就好）：
 *   · id          唯一标识（`<域>.<名字>`，如 `text.storyboard`）
 *   · title       给人看的名字
 *   · describe    一句话说明（面板/文档里显示）
 *   · input       输入说明（字段名 → 类型/是否必填），供 UI 与 MCP 生成表单
 *   · produce(input, ctx) → { template, vars, assets, notes }
 *       template  模板 id 或模板文件相对路径（用引擎现有的模板机制）
 *       vars      模板变量（title/subtitle/...）
 *       assets    素材（shots=[绝对路径...]），**路径必须在 ctx.allowRoots 内**
 *       notes     给用户看的提示（可选）
 *
 * 安全：生产者可以读盘（输入就是文件），但**素材路径要过白名单**，
 *       免得一个第三方 producer 顺手把任意文件塞进成片。
 */

const registry = new Map();

/** 注册一个生产者。重复 id 直接报错（免得"安静地覆盖"）。 */
export function registerProducer(p) {
  if (!p || typeof p !== 'object') throw new Error('producer 必须是对象');
  const { id, title, produce } = p;
  if (!id || typeof id !== 'string') throw new Error('producer 缺 id');
  if (typeof produce !== 'function') throw new Error(`producer ${id} 缺 produce()`);
  if (registry.has(id)) throw new Error(`producer id 冲突：${id}`);
  const entry = {
    id,
    title: title || id,
    describe: p.describe || '',
    input: p.input || {},
    produce,
  };
  registry.set(id, entry);
  return entry;
}

/** 列出所有生产者（给面板 / MCP 用；不含函数本身）。 */
export function listProducers() {
  return [...registry.values()].map(({ id, title, describe, input }) => ({ id, title, describe, input }));
}

export function getProducer(id) {
  return registry.get(id) || null;
}

/**
 * 跑一个生产者。
 * @param {string} id
 * @param {object} input  生产者的输入
 * @param {object} ctx    { allowRoots?: string[], log?: (s)=>void }
 */
export async function runProducer(id, input, ctx = {}) {
  const p = registry.get(id);
  if (!p) throw new Error(`没有这个生产者：${id}（可用：${[...registry.keys()].join(', ') || '无'}）`);
  const out = await p.produce(input || {}, ctx);
  if (!out || typeof out !== 'object') throw new Error(`生产者 ${id} 没返回结果`);
  // 两种返回都合法：
  //   ① { template, vars, assets }          —— 单形态
  //   ② { variants: [{ template, vars, assets }, ...] } —— 一次多形态
  //      （用户要求：「一次预览就生成三种形态，这才是用户实际想要的」）
  const hasOne = !!out.template;
  const hasMany = Array.isArray(out.variants) && out.variants.length > 0;
  // 第三种：直接给**完整文档**（story.board 这种"每句一个镜头"的事，
  // 模板变量表达不了 —— 只有文档能表达。框架因此多一条能力。）
  const hasDoc = !!out.doc && typeof out.doc === 'object';
  if (!hasOne && !hasMany && !hasDoc) throw new Error(`生产者 ${id} 既没给 template、variants，也没给 doc`);
  if (hasOne && (!out.vars || typeof out.vars !== 'object')) throw new Error(`生产者 ${id} 没给 vars`);
  if (hasMany) {
    for (const [i, v] of out.variants.entries()) {
      if (!v || !v.template) throw new Error(`生产者 ${id} 的 variants[${i}] 缺 template`);
      if (!v.vars || typeof v.vars !== 'object') throw new Error(`生产者 ${id} 的 variants[${i}]（${v.template}）缺 vars`);
    }
  }
  return { ...out, producer: id };
}

/** 素材路径白名单校验（在没有 allowRoots 时只允许已有的绝对路径）。 */
export function assertAssetAllowed(file, allowRoots) {
  if (typeof file !== 'string' || !file.startsWith('/')) {
    throw new Error(`素材必须是绝对路径：${file}`);
  }
  if (!Array.isArray(allowRoots) || allowRoots.length === 0) return true;
  const ok = allowRoots.some((r) => file === r || file.startsWith(r.endsWith('/') ? r : r + '/'));
  if (!ok) throw new Error(`素材不在允许的目录内：${file}`);
  return true;
}

/* ── 内置生产者登记（新增一个就往这里加一行）─────────────────────────
 * 刻意**不在模块顶层 import 实现**：这样第三方想只带自己的 producer、
 * 不带内置的，也不会因为缺依赖而加载失败。
 */
const BUILTIN = ['./text-to-storyboard.mjs', './doc-to-storyboard.mjs', './ai-shots.mjs', './storyboard.mjs'];

let loaded = false;
/** 加载内置生产者（幂等）。 */
export async function loadBuiltins() {
  if (loaded) return;
  loaded = true;
  for (const m of BUILTIN) {
    try {
      const mod = await import(m);
      if (typeof mod.register === 'function') mod.register(registerProducer);
    } catch (e) {
      // 单个内置生产者挂了不该拖垮整个注册表 —— 但要让人看得见
      console.error(`[producer] 内置生产者加载失败 ${m}: ${e.message}`);
    }
  }
}
