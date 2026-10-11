/**
 * 授权与试用（2026-10-10 重做：HMAC 对称密钥 → Ed25519 非对称）
 *
 * 商业模型（用户拍板）：
 *   · 免费版：**不限条数**，出片带水印
 *   · ¥199/年：去水印 + 批量 + 台账
 *   · 14 天专业版试用：试用期内按"已授权"对待（去水印）
 *
 * ── 为什么推翻了上一版（这次是真踩了坑）──────────────────────────────
 * 上一版用**对称密钥** HMAC 验签，密钥字符串直接写在文件里。问题是：
 * 对称密钥 = 验证能力和签发能力是同一把钥匙。插件发给用户，密钥就发出去了 ——
 * **任何人解包读出密钥，就能自己签发无限张 ¥199 授权码。** 那道门是虚设的。
 *
 * 当时注释里还写着"对 199 元的产品这个强度是合理的" —— 那是自我说服。
 * 挡得住"随手改到期日的人"，挡不住"会读代码的人"，而后者才是白嫖的主力。
 *
 * 现在改成非对称验签：
 *   · 私钥（签发）只在开发者服务器上，**绝不进这个包**
 *   · 公钥（验证）随插件分发 —— 公开无妨，它只能验证、不能生成签名
 *   · 授权码 = base64url(载荷) + "." + base64url(Ed25519 签名 64 字节)
 * 拿到插件包最多能验签，**伪造不出一张码**。
 *
 * 离线可用：验签不需要联网，用户断网也能激活 ✓
 * 换密钥会让已发出的码全部失效 —— 私钥丢了要重新发码，务必备份私钥。
 *
 * 试用：首次运行时间写进 DSH home 的小文件；改系统时间也绕不过首次记录。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { verify as cryptoVerify } from 'node:crypto';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

const TRIAL_DAYS = 14;

/**
 * 验签公钥。⚠️ 这里只能放公钥 —— 任何私钥/对称密钥都不许出现在插件里。
 * 配套私钥在服务器上（环境变量 CANVAS_LICENSE_KEY 或 /opt/deepwhale-backend/canvas-license-key.pem）。
 */
const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAO6SOh/Ol1n7Z/Hol6KywxPJqE1vDnaMS20Azb+bEpqI=
-----END PUBLIC KEY-----`;

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

/** 校验授权码 → 载荷 或 null */
export function verifyCode(code) {
  const s = String(code || '').trim();
  const i = s.lastIndexOf('.');
  if (i <= 0) return null;
  const body = s.slice(0, i);
  const sig = s.slice(i + 1);
  // 用公钥验签：签名必须由持有私钥的一方生成。插件里没有私钥，伪造不出来。
  let ok = false;
  try {
    ok = cryptoVerify(null, Buffer.from(body, 'ascii'), PUBLIC_KEY, Buffer.from(sig, 'base64url'));
  } catch { ok = false; }
  if (!ok) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload || payload.v !== 1 || !payload.exp) return null;
    return payload;
  } catch { return null; }
}

/** 当前状态：{ plan: 'trial'|'licensed'|'expired'|'free', watermark: boolean, ... } */
export function getState() {
  const d = read();
  // 首次运行打点（用于试用计时）
  if (!d.firstRunAt) write({ firstRunAt: Date.now() });
  const first = read().firstRunAt || Date.now();

  if (d.code) {
    const p = verifyCode(d.code);
    if (p) {
      if (p.exp > Date.now()) return { plan: 'licensed', watermark: false, expiresAt: p.exp, to: p.to || '' };
      return { plan: 'expired', watermark: true, reason: '授权已到期', expiresAt: p.exp, trialUsed: true };
    }
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
