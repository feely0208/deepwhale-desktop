/**
 * 启动 cookie 守护（2026-10-31）
 *
 * 背景（实测复现，见 ~/深鲸运营/生态调研-2026-10-31.md）：
 *   DSH host 每次启动绑随机端口，会话 cookie 名 = `dsh-auth-<base64url(sha256(authority))>`，
 *   而 authority 含端口；浏览器按**域名**存 cookie（端口不进键），每次换端口就多一条
 *   30 天有效的持久 cookie，全链路没有删除路径。
 *   Node 默认 maxHeaderSize=16384，单条约 224B → 约 72 条后 Cookie 头超限，
 *   请求在 HTTP 解析层直接 431，进不到应用层 → 欢迎页/主窗永久打不开且不可自愈。
 *
 * 本模块做两件事：
 *   ① 启动自检：dsh-auth-* 条数 > 60 或总字节 > 13KB 时，按创建时间保留最新 4 条，
 *      其余用 `Max-Age=0` 从浏览器 jar 删除（只读 cookie 名字，不解码值，不参与认证）。
 *   ② 头部预算：由 service-manager 给 host 进程注入
 *      `NODE_OPTIONS=--max-http-header-size=65536`（64 KiB，Chromium 单域上限约 40KB）。
 *
 * 为什么不装第三方插件：两行改动就够，少一个跟版依赖；插件方案保留为外部参考
 * （jitianjiyan/dsh-auth-cookie-guard，MIT）。
 */
import { createHash } from 'node:crypto';
import { session as electronSession, type Cookie, type Session } from 'electron';

/** 只认 dsh-auth-<43 位 base64url> 的精确形状；值不解析 */
const AUTH_NAME = /^dsh-auth-[A-Za-z0-9_-]{43}$/;
const KEEP = 4;
const MAX_COUNT = 60;
const MAX_BYTES = 13 * 1024;

export interface CookieGuardResult {
  before: number;
  beforeBytes: number;
  removed: number;
  after: number;
  skipped?: string;
}

function 名字字节(c: Cookie): number {
  return c.name.length + (typeof c.value === 'string' ? c.value.length : 0) + 2;
}

function 删一条(ses: Session, c: Cookie) {
  const host = String(c.domain || '127.0.0.1').replace(/^\./, '');
  const scheme = c.secure ? 'https' : 'http';
  const url = `${scheme}://${host}${c.path || '/'}`;
  return ses.cookies.remove(url, c.name);
}

/**
 * 启动时调用一次（不要阻塞启动：调用方 `void` 掉即可）。
 * @param ses Electron session（一般传 session.defaultSession）
 * @param 端口 当前 DSH 端口，仅用于日志（保留策略只按创建时间取最新 KEEP 条）
 */
export async function guardAuthCookies(
  ses: Session = electronSession.defaultSession,
  端口?: number,
): Promise<CookieGuardResult> {
  try {
    const 全部 = await ses.cookies.get({});
    const 候选 = 全部.filter((c) => AUTH_NAME.test(c.name));
    const 前字节 = 候选.reduce((n, c) => n + 名字字节(c), 0);
    const 结果: CookieGuardResult = { before: 候选.length, beforeBytes: 前字节, removed: 0, after: 候选.length };
    if (候选.length <= MAX_COUNT && 前字节 <= MAX_BYTES) return 结果;

    // Electron 的 Cookie 没有创建时间字段，无法按「新旧」排序。
    // 改为**按当前端口反推 cookie 名**：authority = `${host}:${port}`，名 = dsh-auth-<base64url(sha256(authority))>。
    // 保留这些（以及最多 KEEP-当前 条兜底），其余一律视为旧端口残留清掉。
    const 当前名 = new Set(
      ['127.0.0.1', 'localhost'].map(
        (host) => 'dsh-auth-' + createHash('sha256').update(`${host}:${端口 ?? 0}`).digest('base64url'),
      ),
    );
    const 保留 = 候选.filter((c) => 当前名.has(c.name));
    const 其余 = 候选.filter((c) => !当前名.has(c.name));
    const 兜底 = Math.max(0, KEEP - 保留.length);
    const 要删 = 其余.slice(0, Math.max(0, 其余.length - 兜底));

    for (const c of 要删) {
      try {
        await 删一条(ses, c);
        结果.removed += 1;
      } catch {
        /* 单条失败不影响其它；下次启动会再试 */
      }
    }
    结果.after = Math.max(0, 候选.length - 结果.removed);
    console.log(
      `[cookie-guard] 启动自检：dsh-auth-* ${结果.before} 条 / ${结果.beforeBytes} B（端口 ${端口 ?? '?'}）` +
        (结果.removed ? ` → 退休 ${结果.removed} 条，剩 ${结果.after} 条` : ' → 无需清理'),
    );
    return 结果;
  } catch (e) {
    const 原因 = e instanceof Error ? e.message : String(e);
    console.warn('[cookie-guard] 自检失败（已忽略，不影响启动）:', 原因);
    return { before: 0, beforeBytes: 0, removed: 0, after: 0, skipped: 原因 };
  }
}
