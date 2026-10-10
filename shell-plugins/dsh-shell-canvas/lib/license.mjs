/**
 * 授权与试用（2026-10-10）
 *
 * 商业模型（用户拍板）：
 *   · 免费版：**不限条数**，出片带水印
 *   · ¥199/年：去水印 + 批量 + 台账
 *   · 14 天专业版试用：试用期内按"已授权"对待（去水印）
 *
 * 设计取舍（为什么不做重方案）：
 *   · ¥199 的产品不值得上"在线激活 + 设备指纹 + 服务端签名"这一套 ✗
 *     —— 维护成本比收入还高，而且用户离线就废了 ✗
 *   · 所以：**离线签名**。授权码 = base64(载荷) + "." + HMAC(载荷)
 *     载荷里写明：类型、到期日、给谁。用内嵌密钥验签。
 *     伪造需要拿到密钥；密钥在插件里**理论上可被逆向** ✗ ——
 *     但对 199 元的产品，这个强度是合理的（挡的是随手改日期的人 ✓，
 *     不是挡专业破解团队 ✗）。**真要硬扛，再上服务端激活。**
 *   · 试用：首次运行时间写进 DSH home 的小文件；改系统时间也绕不过
 *     首次记录（除非删文件 —— 删了就重新计时，这是可接受的代价 ✓）
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

const TRIAL_DAYS = 14;
// 签发密钥（我们自己发码用）。⚠️ 换密钥会让已发出的码全部失效，别随便换。
const SECRET = 'deepwhale-canvas-2026-license-v1';

const file = () => join(process.env.DSH_HOME || homedir(), '.dsh-canvas-license.json');

function read() {
  try { return JSON.parse(readFileSync(file(), 'utf8')); } catch { return {}; }
}
function write(patch) {
  const next = { ...read(), ...patch };
  try {
    // 目录不存在就先建 —— 否则新机器上首次写授权/试用记录会 ENOENT，
    // 表现是"激活了却还是试用"（自测时真踩到了）。
    mkdirSync(dirname(file()), { recursive: true });
    writeFileSync(file(), JSON.stringify(next, null, 2));
  } catch (e) { console.warn('[license] 写不进去：' + e.message); }
  return next;
}

/** 签发授权码（我们自己用：node -e 调一下，或者做个小工具） */
export function issueCode({ days = 365, to = '' } = {}) {
  const payload = { v: 1, exp: Date.now() + days * 86400000, to };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', SECRET).update(body).digest('base64url').slice(0, 32);
  return body + '.' + sig;
}

/** 校验授权码 → 载荷 或 null */
export function verifyCode(code) {
  const s = String(code || '').trim();
  const i = s.lastIndexOf('.');
  if (i <= 0) return null;
  const body = s.slice(0, i);
  const sig = s.slice(i + 1);
  const want = createHmac('sha256', SECRET).update(body).digest('base64url').slice(0, 32);
  if (sig !== want) return null;                       // 签名不对：伪造
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload || payload.v !== 1 || !payload.exp) return null;
    return payload;
  } catch { return null; }
}

/** 当前状态：{ plan: 'trial'|'licensed'|'expired', watermark: boolean, ... } */
export function getState() {
  const d = read();
  // 首次运行打点（用于试用计时）
  if (!d.firstRunAt) write({ firstRunAt: Date.now() });
  const first = read().firstRunAt || Date.now();

  // 已激活且未过期 → 专业版
  if (d.code) {
    const p = verifyCode(d.code);
    if (p) {
      if (p.exp > Date.now()) return { plan: 'licensed', watermark: false, expiresAt: p.exp, to: p.to || '' };
      return { plan: 'expired', watermark: true, reason: '授权已到期', expiresAt: p.exp, trialUsed: true };
    }
    // 码无效（伪造/换密钥）→ 当未授权处理，但要说清原因
    return { plan: 'free', watermark: true, reason: '授权码无效', trialUsed: true };
  }

  const leftMs = first + TRIAL_DAYS * 86400000 - Date.now();
  if (leftMs > 0) {
    return {
      plan: 'trial', watermark: false,
      daysLeft: Math.ceil(leftMs / 86400000), trialDays: TRIAL_DAYS, expiresAt: first + TRIAL_DAYS * 86400000,
    };
  }
  return { plan: 'free', watermark: true, reason: `试用已结束（${TRIAL_DAYS} 天）`, trialUsed: true };
}

/** 激活：校验通过才写入 */
export function activate(code) {
  const p = verifyCode(code);
  if (!p) return { ok: false, error: '授权码无效，请核对后重试' };
  if (p.exp <= Date.now()) return { ok: false, error: '这个授权码已经过期了' };
  write({ code: String(code).trim(), activatedAt: Date.now() });
  return { ok: true, state: getState() };
}

/** 注销（换机器/重置用；我们内部工具） */
export function deactivate() {
  const d = read();
  delete d.code;
  write(d);
  return getState();
}

export const __testing = { TRIAL_DAYS, file };
