/**
 * 旧 preset id 自愈（2026-10-14）
 *
 * ── 事故（Windows 用户实测）────────────────────────────────────────────
 *   「新建会话建不了 / 会话区点不上」，报
 *   `agent-preset/not-found: Unknown agent preset: legal`。
 *
 * ── 为什么 ───────────────────────────────────────────────────────────
 *   早期 shell 的 bundle 声明的 preset id 是 `legal`，后来统一改成 `legal-mode`
 *   （见 src/main/legal-mode.ts 的 PRESET_ID、bundled-plugins/dsh-legal-preset、
 *   客户端插件的覆盖层比对值）。但**已经写进用户 dsh-home 的旧值不会自己变**：
 *   DSH 把每个会话的 preset 存在 session projection 里 ——
 *     `<home>/storages/session_projcache/sessions/<id>.json`
 *     → `record.rows.agentPreset.val`
 *   新建会话会沿用上次的 preset，于是 roster 里找不到 `legal` → 直接报错，
 *   用户看不到任何会话、也建不了新的。
 *   影响面：**全新安装不受影响，从旧版升上来的用户会踩**（和 office 那个 asar 路径同一类病）。
 *
 * ── 做法 ─────────────────────────────────────────────────────────────
 *   启动时（**必须在拉起 DSH 之前**）扫一遍这些投影文件，把 `agentPreset.val === 'legal'`
 *   改写成 `legal-mode`，原子写回、并留一份 `.legal-bak` 备份。
 *   只动这一个字段、只认这一个已知的旧 id —— 不去猜"哪个 id 现在还有效"。
 */
import * as fs from 'fs';
import * as path from 'path';
import { writeFileAtomic } from './patch-heal';

/** 旧 id → 现行 id */
const LEGACY_PRESET_IDS: Record<string, string> = {
  legal: 'legal-mode',
};

export interface PresetHealResult {
  /** 扫过的投影文件数 */
  scanned: number;
  /** 被改写的文件绝对路径 */
  healed: string[];
}

/** 会话投影目录（DSH 自己建的；不存在就是还没跑过，属正常） */
function projectionSessionsDir(home: string): string {
  return path.join(home, 'storages', 'session_projcache', 'sessions');
}

/**
 * 把会话投影里遗留的旧 preset id 改写成现行 id。幂等；任何异常都不向上抛
 * （自愈失败最多是"情况没有变好"，绝不能让应用起不来）。
 */
export function healLegacyAgentPreset(home: string): PresetHealResult {
  const result: PresetHealResult = { scanned: 0, healed: [] };
  const dir = projectionSessionsDir(home);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return result; // 目录还不存在：正常（从没启动过 DSH）
  }

  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(dir, name);
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf-8');
    } catch {
      continue;
    }
    // 便宜的前置过滤：绝大多数会话里根本没有 "legal" 这个词
    if (!Object.keys(LEGACY_PRESET_IDS).some((id) => raw.includes(`"${id}"`))) continue;
    result.scanned += 1;

    let doc: unknown;
    try {
      doc = JSON.parse(raw);
    } catch {
      continue; // 读不懂就别动（不是我们的文件格式 / 正在被 DSH 写）
    }
    const row = (
      doc as {
        record?: { rows?: { agentPreset?: { val?: unknown } } };
      }
    ).record?.rows?.agentPreset;
    if (row === undefined) continue;
    const current = row.val;
    if (typeof current !== 'string') continue;
    const next = LEGACY_PRESET_IDS[current];
    if (next === undefined) continue;

    try {
      // 先留证据再改（万一里面还有别的东西要人工找回）
      const backup = `${file}.legal-bak`;
      if (!fs.existsSync(backup)) fs.writeFileSync(backup, raw, 'utf-8');
      row.val = next;
      writeFileAtomic(file, JSON.stringify(doc));
      result.healed.push(file);
      console.warn(`[preset-heal] 旧 preset id "${current}" → "${next}"：${file}`);
    } catch (error) {
      console.error('[preset-heal] 改写失败（保持原样）:', file, error);
    }
  }

  // 改写失败时不能让内存里的 doc 影响别的文件 —— 每个文件都是独立读取解析的，无共享状态。
  return result;
}
