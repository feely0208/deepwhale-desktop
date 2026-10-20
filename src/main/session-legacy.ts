/**
 * 会话搜索的兼容性归档（2026-10-20）。
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────
 * 用户在设置里打开了「会话搜索（实验性）」，工具也挂上了，但每次调用都报：
 *     SESSION_QUERY_PERSISTENCE_FAILED: session history storage is unavailable
 * 暴露真实错误（隔离实例 probe）后拿到根因：
 *     subagent/descriptor 0 uses unsupported descriptor version 2;
 *     source v0 artifact remains unchanged (raw log: …/session.jsonl.zstd)
 * 即 **早期 v0 格式的会话日志里有当前格式链不支持的 descriptor**；
 * 而实验性搜索会把**全部历史会话**建索引、遇到一条读不了的就整条查询失败
 * （不是跳过该条，是整体报错）。所以「一个老的坏会话」能让整个搜索不可用。
 *
 * 实测：把 v0/v1/v2 的会话目录移出 `sessions/` 后，`searchSessions` 立刻正常
 * （139 条语料 → 20 条命中）。
 *
 * ── 这里怎么做 ──────────────────────────────────────────────────────
 * **只移动、不删除**：把 `sessions/<project>/<session>/`（格式版本 < 3）
 * 整体搬到 `<home>/sessions-legacy/<日期>/<project>/<session>/`，
 * 并写一份 README 说明原因与还原命令。用户想找回，mv 回去即可。
 *
 * 触发条件：只有**检测到会话搜索已启用**（profile bundles 里有
 * `@deepseek-ai/dsh-experimental-session-search`）时才做 —— 没开搜索就不动用户数据。
 *
 * 不做的事：不改任何会话文件内容、不动 v3/v4、不删任何东西。
 */

import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';

/** 实验性会话搜索的 bundle 名（设置里那个开关打开后它会进 profile 的 bundles） */
export const SESSION_SEARCH_BUNDLE = '@deepseek-ai/dsh-experimental-session-search';

/** 低于这个格式版本的会话视为旧版（v0/v1/v2） */
const LEGACY_MAX_VERSION = 3;

/** 会话搜索是否已启用（任一 profile 的 bundles 里出现实验性搜索 bundle） */
export function sessionSearchEnabled(home: string): boolean {
  const dir = path.join(home, 'profiles');
  let profiles: string[] = [];
  try {
    profiles = fs.readdirSync(dir);
  } catch {
    return false;
  }
  for (const name of profiles) {
    const file = path.join(dir, name, 'package.json');
    try {
      const manifest = JSON.parse(fs.readFileSync(file, 'utf8')) as {
        dependencies?: Record<string, string>;
        dsh?: { profile?: { bundles?: string[] } };
      };
      const bundles = manifest.dsh?.profile?.bundles ?? [];
      if (bundles.includes(SESSION_SEARCH_BUNDLE)) return true;
      if (manifest.dependencies && SESSION_SEARCH_BUNDLE in manifest.dependencies) return true;
    } catch {
      // 读不了就跳过
    }
  }
  return false;
}

/** 读一个会话日志（zstd 多帧）第一帧的头部 version；读不了返回 null */
function headerVersion(file: string): number | null {
  try {
    const raw = zlib.zstdDecompressSync(fs.readFileSync(file));
    const first = raw.toString('utf8').split('\n', 1)[0];
    const header = JSON.parse(first) as { version?: number; formatVersion?: number };
    const v = header.version ?? header.formatVersion;
    return typeof v === 'number' ? v : null;
  } catch {
    return null;
  }
}

export interface LegacyScan {
  /** 需要归档的会话目录绝对路径 */
  dirs: string[];
  /** 检查过的会话目录总数 */
  total: number;
  /** 头部读不出来的会话数（计入「不确定」，不归档） */
  unreadable: number;
}

/** 扫描出格式版本 < 3 的会话目录（只读，不改任何东西） */
export function findLegacySessionDirs(home: string): LegacyScan {
  const root = path.join(home, 'sessions');
  const out: LegacyScan = { dirs: [], total: 0, unreadable: 0 };
  let projects: string[] = [];
  try {
    projects = fs.readdirSync(root);
  } catch {
    return out;
  }
  for (const project of projects) {
    const projectDir = path.join(root, project);
    let sessions: string[] = [];
    try {
      if (!fs.statSync(projectDir).isDirectory()) continue;
      sessions = fs.readdirSync(projectDir);
    } catch {
      continue;
    }
    for (const session of sessions) {
      const dir = path.join(projectDir, session);
      let logs: string[] = [];
      try {
        if (!fs.statSync(dir).isDirectory()) continue;
        logs = fs.readdirSync(dir).filter((n) => n.endsWith('.zstd'));
      } catch {
        continue;
      }
      if (logs.length === 0) continue;
      out.total += 1;
      // ⚠️ 一个会话目录里可能同时留着**旧日志**（session.jsonl.zstd, v0）和
      //    **升级后的当前日志**（session.v4.jsonl.zstd）。只看"有旧日志"就归档，
      //    会把用户正在用的会话整目录搬走 → 打开时报
      //    ENOENT .../sessions/<project>/<session>/session.v4.jsonl.zstd。
      //    正确判据：只要存在任何一版 >= LEGACY_MAX_VERSION 的日志，这个会话就是"活的"，
      //    不能归档（旧日志留着也不影响它正常打开；搜索索引以最新日志为准）。
      let legacy = false;
      let modern = false;
      let unreadable = false;
      for (const log of logs) {
        const v = headerVersion(path.join(dir, log));
        if (v === null) {
          unreadable = true;
          continue;
        }
        if (v < LEGACY_MAX_VERSION) legacy = true;
        else modern = true;
      }
      if (legacy && !modern) out.dirs.push(dir);
      else if (unreadable && !modern) out.unreadable += 1;
    }
  }
  return out;
}

function readmeText(archived: number, stamp: string, home: string): string {
  return [
    '# 旧版会话归档（sessions-legacy）',
    '',
    `归档时间：${stamp}`,
    `归档数量：${archived} 个会话目录`,
    '',
    '## 为什么在这里',
    '',
    '深鲸桌面的「会话搜索（实验性）」会把全部历史会话建立索引。',
    '早期版本（会话格式 v0/v1/v2）的日志里含有当前格式链不支持的记录',
    '（例如 `subagent/descriptor version 2`），遇到一条读不了的，',
    '**整条搜索查询**都会失败，表现为设置里开关是开的、但搜索一直报错。',
    '',
    '为了不动旧数据，这里只做「移到旁边」：',
    '- 会话文件一个字节都没改',
    '- 想找回：把本目录下的 `<project>/<session>/` 搬回',
    `  \`${path.join(home, 'sessions')}/<project>/<session>/\``,
    '  然后重启应用即可；搜索会再次因这些旧会话而不可用。',
    '',
    '## 如果不想归档',
    '',
    '在设置里关闭「会话搜索（实验性）」即可 —— 下次启动不会再动这些目录。',
    '',
  ].join('\n');
}

/**
 * 把旧版会话目录移到 `<home>/sessions-legacy/<日期>/`（保留 project 层级）。
 * @returns 归档数量与目标目录（没有可归档的返回 0 / null）
 */
export function archiveLegacySessions(
  home: string,
  stamp = new Date().toISOString().slice(0, 10),
): { archived: number; dest: string | null; scan: LegacyScan } {
  const scan = findLegacySessionDirs(home);
  if (scan.dirs.length === 0) return { archived: 0, dest: null, scan };

  const dest = path.join(home, 'sessions-legacy', stamp);
  let archived = 0;
  for (const dir of scan.dirs) {
    const project = path.basename(path.dirname(dir));
    const target = path.join(dest, project, path.basename(dir));
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.renameSync(dir, target);
      archived += 1;
    } catch (error) {
      console.warn('[sessions-legacy] 移动会话失败（跳过）：', dir, error);
    }
  }
  if (archived > 0) {
    try {
      fs.writeFileSync(path.join(dest, 'README-为什么旧会话在这里.md'), readmeText(archived, stamp, home));
    } catch {
      // README 写不了不影响归档本身
    }
  }
  return { archived, dest, scan };
}
