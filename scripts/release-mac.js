/**
 * 正式发布 macOS 安装包（Developer ID 签名 + 公证）。
 * 模式参考 anywhere-labs/deepseek-harness-desktop 的 scripts/release-mac.ts：
 *   1) fail-loud 预检——凭据不全直接失败，不产出不可用的安装包
 *   2) npm run build（构建过程不接触任何发布凭据）
 *   3) electron-builder --mac dmg，强制签名 + 公证
 * 用法：node scripts/release-mac.js
 * 未配置签名/公证时请改用 npm run dist:mac（产出未签名包，仅供本地体验 / CI 验证）。
 */
'use strict'

const { spawnSync } = require('node:child_process')
const { resolve } = require('node:path')
const {
  adaptMacReleaseEnvironment,
  assertMacReleaseReady,
  withoutMacReleaseSecrets,
} = require('./release-preflight.js')

function run(command, args, cwd, env) {
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with ${String(result.status)}`)
  }
}

function listCodeSigningIdentities(env) {
  const result = spawnSync('security', ['find-identity', '-v', '-p', 'codesigning'], {
    encoding: 'utf8',
    env,
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(`security find-identity exited with ${String(result.status)}`)
  }
  return result.stdout
}

function main() {
  const root = resolve(__dirname, '..')
  const releaseEnvironment = adaptMacReleaseEnvironment(process.env)
  const buildEnvironment = withoutMacReleaseSecrets(releaseEnvironment)

  const result = assertMacReleaseReady({
    env: releaseEnvironment,
    platform: process.platform,
    listCodeSigningIdentities: () => listCodeSigningIdentities(buildEnvironment),
  })
  console.log(
    `macOS release preflight passed: ${result.identity}; signing via ${result.signing}; notarization via ${result.notarization}`,
  )

  // 构建/校验过程不接触签名与公证凭据
  run('npm', ['run', 'build'], root, buildEnvironment)
  run('npx', [
    'electron-builder', '--mac', 'dmg',
    '--config.forceCodeSigning=true', '--config.mac.notarize=true',
    '--publish', 'never',
  ], root, releaseEnvironment)
  console.log('macOS 发布包构建完成（已签名 + 公证）。')
}

main()
