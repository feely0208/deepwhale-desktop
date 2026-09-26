#!/usr/bin/env node
/**
 * ACME HTTP-01 验证文件 → OBS
 *
 * 用途：Let's Encrypt 验证域名归属时，会来取
 *   http://dl.deepwhale.org.cn/.well-known/acme-challenge/<token>
 * 由于该域名走 CDN、源站是 OBS 桶，我们只要把这个文件放进桶里，
 * CDN 就会通过回源把它交给 Let's Encrypt —— 不需要任何 DNS 写权限。
 *
 * 为什么要绕这一下：DNS-01 需要一个能改 DNS 记录的凭据，那等于把域名劫持
 * 权限交出去，为了自动续个证书不值得。HTTP-01 复用已有的 OBS 凭据即可。
 *
 * 由 certbot 的 --manual-auth-hook / --manual-cleanup-hook 调用，
 * 凭据与路径从 certbot 注入的环境变量读取：
 *   CERTBOT_TOKEN       验证文件名（key 的最后一段）
 *   CERTBOT_VALIDATION  验证内容
 *
 * 用法：node scripts/acme-obs.js put|delete
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const OP = process.argv[2];
const PREFIX = '.well-known/acme-challenge/';

function ensureSdk() {
  try {
    return require('esdk-obs-nodejs');
  } catch {
    console.log('[acme-obs] 未找到 OBS SDK，按需安装…');
    execFileSync(
      'npm',
      ['install', '--no-save', '--no-package-lock', '--no-audit', '--no-fund', 'esdk-obs-nodejs'],
      { stdio: 'inherit' },
    );
    return require('esdk-obs-nodejs');
  }
}

function client() {
  const ObsClient = ensureSdk();
  const need = (n) => {
    const v = process.env[n];
    if (!v) throw new Error(`缺少环境变量 ${n}`);
    return v;
  };
  return new ObsClient({
    access_key_id: need('OBS_AK'),
    secret_access_key: need('OBS_SK'),
    server: `https://${need('OBS_ENDPOINT')}`,
  });
}

async function main() {
  const token = process.env.CERTBOT_TOKEN;
  if (!token) throw new Error('缺少 CERTBOT_TOKEN（本脚本应由 certbot 的 hook 调用）');
  const key = `${PREFIX}${token}`;
  const bucket = process.env.OBS_BUCKET;
  if (!bucket) throw new Error('缺少环境变量 OBS_BUCKET');

  const obs = client();

  if (OP === 'put') {
    const validation = process.env.CERTBOT_VALIDATION;
    if (!validation) throw new Error('缺少 CERTBOT_VALIDATION');
    const tmp = path.join(os.tmpdir(), `acme-${token}`);
    fs.writeFileSync(tmp, validation);
    const res = await obs.putObject({ Bucket: bucket, Key: key, SourceFile: tmp });
    fs.rmSync(tmp, { force: true });
    if (res.CommonMsg.Status >= 300) {
      throw new Error(`上传失败 HTTP ${res.CommonMsg.Status} ${res.CommonMsg.Message}`);
    }
    console.log(`[acme-obs] ✅ 已放置验证文件 obs://${bucket}/${key}`);
  } else if (OP === 'delete') {
    // 清理验证文件时**预期会 403**：CI 凭据的 OBS 策略刻意只给了读+写，
    // 没给删除 —— 因为给 CI 删除权意味着"凭据泄露就能清空整个下载桶"，
    // 而这里要删的只是一个 43 字节、已用过的随机验证文件，代价不对等。
    // 残留物由桶的生命周期规则自动清理（前缀 .well-known/acme-challenge/）。
    // 所以这里把 403 当作正常结果说明，而不是报警 —— 报警会训练人忽略日志。
    try {
      const res = await obs.deleteObject({ Bucket: bucket, Key: key });
      const st = res.CommonMsg.Status;
      if (st === 403) {
        console.log(`[acme-obs] ℹ️ 无删除权限（预期内），验证文件留待生命周期规则清理：${key}`);
      } else if (st >= 300 && st !== 404) {
        console.warn(`[acme-obs] ⚠️ 删除返回 HTTP ${st}`);
      } else {
        console.log(`[acme-obs] ✅ 已清理 ${key}`);
      }
    } catch (e) {
      console.log(`[acme-obs] ℹ️ 清理跳过（预期内）：${e.message}`);
    }
  } else {
    throw new Error('用法：acme-obs.js put|delete');
  }

  obs.close();
}

main().catch((e) => {
  console.error('[acme-obs] failed:', e.message);
  process.exit(1);
});
