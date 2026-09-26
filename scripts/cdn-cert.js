#!/usr/bin/env node
/**
 * CDN 证书管理 —— 查当前证书 / 推送新证书
 *
 * 用途：给 dl.deepwhale.org.cn 做自动续期。整条链路的最后一环。
 *
 * 为什么不用控制台：免费 DV 证书 90 天一到期，HTTPS 就失效、用户下载全被
 * 浏览器拦。这件事实质上必须自动化，否则半年后一定出事且没人记得。
 *
 * 凭据复用 CI 已有的那对（CDN 权限已加到同一个 IAM 用户上）：
 *   HW_AK / HW_SK   优先
 *   OBS_AK / OBS_SK 兜底（同一个用户，值相同）
 *
 * 用法：
 *   node scripts/cdn-cert.js check                      # 权限自检 + 查当前证书剩余天数
 *   node scripts/cdn-cert.js update --cert c.pem --key k.pem [--name 名称]
 *
 * 退出码：
 *   0 成功
 *   1 失败
 *   check 模式下用 --fail-if-expiring=N 可在剩余天数 <= N 时返回 2（供工作流判断
 *   是否该续期，避免把"该续了"当成"出错了"）
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DEFAULT_DOMAIN = 'dl.deepwhale.org.cn';
const ENDPOINT = 'https://cdn.myhuaweicloud.com';

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const k = argv[i];
    if (k.startsWith('--')) {
      const key = k.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else { out[key] = next; i += 1; }
    } else out._.push(k);
  }
  return out;
}

/** 按需安装华为云 SDK（不写进 package.json，避免长期依赖）。 */
function ensureSdk() {
  try {
    require('@huaweicloud/huaweicloud-sdk-cdn');
  } catch {
    console.log('[cdn] 未找到华为云 SDK，按需安装…');
    // uuid 是该 SDK 的隐式依赖，不一起装会在 require 阶段直接抛 MODULE_NOT_FOUND
    execFileSync(
      'npm',
      [
        'install', '--no-save', '--no-package-lock', '--no-audit', '--no-fund',
        '@huaweicloud/huaweicloud-sdk-cdn', '@huaweicloud/huaweicloud-sdk-core', 'uuid',
      ],
      { stdio: 'inherit' },
    );
  }
  return {
    cdn: require('@huaweicloud/huaweicloud-sdk-cdn'),
    core: require('@huaweicloud/huaweicloud-sdk-core'),
  };
}

function credentials() {
  const ak = process.env.HW_AK || process.env.OBS_AK;
  const sk = process.env.HW_SK || process.env.OBS_SK;
  if (!ak || !sk) throw new Error('缺少凭据：请设置 HW_AK/HW_SK（或 OBS_AK/OBS_SK）');
  return { ak, sk };
}

function buildClient() {
  const { cdn, core } = ensureSdk();
  const { ak, sk } = credentials();
  const cred = new core.BasicCredentials().withAk(ak).withSk(sk);
  return cdn.CdnClient.newBuilder().withCredential(cred).withEndpoint(ENDPOINT).build();
}

/** 把 SDK 抛出的错误整理成一句能读懂的话（尤其要区分"没权限"和"别的错"）。 */
function explain(error) {
  const msg = String(error?.message ?? error);
  if (/403|Forbidden|APIGW\.0301|not authorized|permission/i.test(msg)) {
    return {
      kind: 'permission',
      text:
        '权限不足（403）。请确认 IAM 用户 ci-uploader 已通过用户组拿到 deepwhale-cdn-cert 策略，' +
        '且策略里包含 cdn:configuration:queryDomains（查询）与 cdn:configuration:modifyHttpsConf（改证书）。',
    };
  }
  if (/401|Unauthorized/i.test(msg)) {
    return { kind: 'auth', text: '鉴权失败（401）。AK/SK 不对或已失效，检查 GitHub Secrets。' };
  }
  return { kind: 'other', text: msg.slice(0, 400) };
}

async function cmdCheck(args) {
  const domain = args.domain || DEFAULT_DOMAIN;
  // --renew-within=N：证书缺失、或剩余有效期 <= N 天时返回退出码 2，
  // 让工作流据此决定"该续期了"，而不是把这种情况当成错误（退出码 1）。
  // 把「该续期」和「出错了」分开，是无人值守任务能被信任的前提。
  const renewWithin = Number(args['renew-within'] ?? NaN);
  const client = buildClient();
  console.log(`[cdn] 查询 ${domain} 的证书信息…`);

  let resp;
  try {
    resp = await client.showCertificatesHttpsInfo(
      new (require('@huaweicloud/huaweicloud-sdk-cdn').ShowCertificatesHttpsInfoRequest)().withDomainName(domain),
    );
  } catch (error) {
    const e = explain(error);
    console.error(`[cdn] ❌ 查询失败（${e.kind}）：${e.text}`);
    process.exit(1);
  }

  console.log('[cdn] ✅ CDN 权限自检通过（能读到域名证书信息）');
  const items = resp.https || resp.Https || [];
  if (items.length === 0) {
    console.log(`[cdn] ⚠️ ${domain} 当前未配置证书`);
    if (!Number.isNaN(renewWithin)) {
      console.log('[cdn] → 需要签发');
      process.exit(2);
    }
    process.exit(0);
  }

  // 打印原始结构，字段名以实际返回为准（SDK 各版本略有差异）
  console.log('[cdn] 原始返回：');
  console.log(JSON.stringify(items, null, 2).split('\n').map((l) => `    ${l}`).join('\n'));

  let days = null;
  for (const it of items) {
    const exp = it.expiration_time || it.expirationTime;
    if (!exp) continue;
    const d = Math.floor((new Date(exp).getTime() - Date.now()) / 86400000);
    days = days === null ? d : Math.min(days, d);
  }
  if (days !== null) console.log(`\n[cdn] 证书剩余有效期：${days} 天`);

  if (!Number.isNaN(renewWithin)) {
    if (days === null) {
      console.log('[cdn] ⚠️ 返回里没有到期时间字段，无法判断 —— 保守起见按"需要签发"处理');
      process.exit(2);
    }
    if (days <= renewWithin) {
      console.log(`[cdn] 剩余 ${days} 天 <= 阈值 ${renewWithin} 天 → 需要续期`);
      process.exit(2);
    }
    console.log(`[cdn] 剩余 ${days} 天 > 阈值 ${renewWithin} 天 → 暂不续期`);
  }
  process.exit(0);
}

async function cmdUpdate(args) {
  const domain = args.domain || DEFAULT_DOMAIN;
  if (!args.cert || !args.key) throw new Error('需要 --cert <证书PEM> 与 --key <私钥PEM>');
  const cert = fs.readFileSync(args.cert, 'utf8').trim();
  const key = fs.readFileSync(args.key, 'utf8').trim();
  if (!cert.includes('BEGIN CERTIFICATE')) throw new Error(`${args.cert} 看起来不是 PEM 证书`);
  if (!/BEGIN .*PRIVATE KEY/.test(key)) throw new Error(`${args.key} 看起来不是 PEM 私钥`);

  const { cdn } = ensureSdk();
  const client = buildClient();
  const name = args.name || `deepwhale-le-${new Date().toISOString().slice(0, 10)}`;

  const body = new cdn.UpdateDomainMultiCertificatesRequestBody().withHttps(
    new cdn.UpdateDomainMultiCertificatesRequestBodyContent()
      .withDomainName(domain)
      .withHttpsSwitch(1)
      .withCertName(name)
      .withCertificate(cert)
      .withPrivateKey(key),
  );

  console.log(`[cdn] 推送证书到 ${domain}（名称 ${name}，证书 ${cert.length} 字节）…`);
  try {
    const resp = await client.updateDomainMultiCertificates(
      new cdn.UpdateDomainMultiCertificatesRequest().withBody(body),
    );
    console.log('[cdn] ✅ 推送成功：');
    console.log(JSON.stringify(resp, null, 2).slice(0, 1200));
  } catch (error) {
    const e = explain(error);
    console.error(`[cdn] ❌ 推送失败（${e.kind}）：${e.text}`);
    process.exit(1);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  if (cmd === 'check') return cmdCheck(args);
  if (cmd === 'update') return cmdUpdate(args);
  console.error('用法：cdn-cert.js <check|update> [选项]');
  process.exit(1);
}

main().catch((error) => {
  console.error('[cdn] failed:', error.message);
  process.exit(1);
});
