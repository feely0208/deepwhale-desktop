/**
 * macOS 发布预检：签名 + 公证凭据的 fail-loud 校验。
 * 模式参考 anywhere-labs/deepseek-harness-desktop 的 dsh-plugin-desktop/scripts/release-preflight.ts。
 * 用法：node scripts/release-preflight.js
 *
 * 环境变量（与 electron-builder 对齐）：
 *   签名（二选一）：
 *     - CSC_LINK + CSC_KEY_PASSWORD + CSC_NAME
 *     - MAC_CERT_P12_BASE64 + MACOS_SIGN_IDENTITY + CSC_KEY_PASSWORD
 *   公证（三选一）：
 *     - APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID
 *     - APPLE_API_KEY + APPLE_API_KEY_ID + APPLE_API_ISSUER
 *     - APPLE_KEYCHAIN_PROFILE
 * 凭据不全会直接失败（exit code 1），绝不产出不可用的安装包。
 */
'use strict'

const { spawnSync } = require('node:child_process')

const DEVELOPER_ID_PREFIX = 'Developer ID Application:'
const P12_DATA_PREFIX = 'data:application/x-pkcs12;base64,'

const RELEASE_VARIABLES = [
  'APPLE_API_ISSUER', 'APPLE_API_KEY', 'APPLE_API_KEY_ID',
  'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_ID', 'APPLE_KEYCHAIN',
  'APPLE_KEYCHAIN_PROFILE', 'APPLE_TEAM_ID', 'CSC_IDENTITY_AUTO_DISCOVERY',
  'CSC_KEY_PASSWORD', 'CSC_LINK', 'CSC_NAME', 'MACOS_SIGN_IDENTITY',
  'MAC_CERT_P12_BASE64',
]

function environmentValue(env, name) {
  const value = env[name] && env[name].trim()
  return value === '' ? undefined : value
}

function normalizeP12Base64(value) {
  const compact = value.replace(/\s/g, '')
  if (
    compact.length === 0
    || compact.length % 4 !== 0
    || !/^(?:[A-Za-z\d+/]{4})*(?:[A-Za-z\d+/]{2}==|[A-Za-z\d+/]{3}=)?$/.test(compact)
  ) {
    throw new Error('MAC_CERT_P12_BASE64 must contain a valid Base64-encoded PKCS#12 file')
  }
  const decoded = Buffer.from(compact, 'base64')
  if (decoded.length === 0 || decoded[0] !== 0x30) {
    throw new Error('MAC_CERT_P12_BASE64 must contain a Base64-encoded PKCS#12 file')
  }
  return compact
}

function normalizeSigningIdentity(value) {
  return value.replace(/\\([ ()])/g, '$1')
}

function electronBuilderIdentity(identity) {
  return identity.slice(DEVELOPER_ID_PREFIX.length).trim()
}

/** 把发布秘密映射为 electron-builder 的签名变量。 */
function adaptMacReleaseEnvironment(env) {
  const adapted = { ...env }
  const p12 = environmentValue(env, 'MAC_CERT_P12_BASE64')
  const identityValue = environmentValue(env, 'MACOS_SIGN_IDENTITY')
  const identity = identityValue === undefined ? undefined : normalizeSigningIdentity(identityValue)
  if (p12 === undefined && identity === undefined) return adapted
  if (p12 === undefined) throw new Error('Incomplete macOS signing credentials: missing MAC_CERT_P12_BASE64')
  if (identity === undefined) throw new Error('Incomplete macOS signing credentials: missing MACOS_SIGN_IDENTITY')
  if (environmentValue(env, 'CSC_KEY_PASSWORD') === undefined) {
    throw new Error('Incomplete macOS signing credentials: missing CSC_KEY_PASSWORD')
  }
  if (!identity.startsWith(DEVELOPER_ID_PREFIX)) {
    throw new Error('MACOS_SIGN_IDENTITY must select a Developer ID Application identity')
  }
  if (environmentValue(env, 'CSC_LINK') !== undefined) {
    throw new Error('Set MAC_CERT_P12_BASE64 or CSC_LINK for macOS signing, not both')
  }
  const configuredIdentity = environmentValue(env, 'CSC_NAME')
  const builderIdentity = electronBuilderIdentity(identity)
  if (
    configuredIdentity !== undefined
    && configuredIdentity !== identity
    && configuredIdentity !== builderIdentity
  ) {
    throw new Error('MACOS_SIGN_IDENTITY and CSC_NAME select different signing identities')
  }
  adapted.CSC_LINK = `${P12_DATA_PREFIX}${normalizeP12Base64(p12)}`
  adapted.CSC_NAME = builderIdentity
  delete adapted.MAC_CERT_P12_BASE64
  delete adapted.MACOS_SIGN_IDENTITY
  return adapted
}

/** 移除签名/公证凭据，供普通构建检查使用（凭据不泄漏给构建子进程）。 */
function withoutMacReleaseSecrets(env) {
  const sanitized = { ...env }
  for (const name of RELEASE_VARIABLES) delete sanitized[name]
  return sanitized
}

function resolveCredentialGroup(env, names, source) {
  const present = names.filter((name) => environmentValue(env, name) !== undefined)
  if (present.length === 0) return undefined
  if (present.length !== names.length) {
    const missing = names.filter((name) => !present.includes(name))
    throw new Error(`Incomplete macOS notarization credentials: missing ${missing.join(', ')}`)
  }
  return source
}

function resolveNotarizationCredentials(env) {
  const appleId = resolveCredentialGroup(
    env,
    ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID'],
    'apple-id',
  )
  if (appleId !== undefined) return appleId

  const apiKey = resolveCredentialGroup(
    env,
    ['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER'],
    'api-key',
  )
  if (apiKey !== undefined) return apiKey

  const keychainProfile = environmentValue(env, 'APPLE_KEYCHAIN_PROFILE')
  if (keychainProfile !== undefined) return 'keychain-profile'
  if (environmentValue(env, 'APPLE_KEYCHAIN') !== undefined) {
    throw new Error('Incomplete macOS notarization credentials: missing APPLE_KEYCHAIN_PROFILE')
  }
  throw new Error(
    'macOS notarization credentials are required: set APPLE_KEYCHAIN_PROFILE, the Apple ID trio, or the App Store Connect API key trio',
  )
}

function developerIdApplications(output) {
  return [...output.matchAll(/"((?:Developer ID Application|Developer ID Installer):[^"]+)"/g)]
    .map((match) => match[1])
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

/**
 * 断言 macOS 发布（签名 + 公证）无法被跳过。
 * @returns {{identity: string, notarization: string, signing: string}} 已确认的非敏感选择
 */
function assertMacReleaseReady({ env, platform, listCodeSigningIdentities }) {
  if (platform !== 'darwin') {
    throw new Error('The signed macOS release must be built on macOS')
  }
  if (environmentValue(env, 'CSC_IDENTITY_AUTO_DISCOVERY') === 'false') {
    throw new Error('CSC_IDENTITY_AUTO_DISCOVERY=false would disable macOS release signing')
  }

  const configuredIdentity = environmentValue(env, 'CSC_NAME')
  if (configuredIdentity && configuredIdentity.startsWith('Apple Development:')) {
    throw new Error('CSC_NAME must select a Developer ID Application identity for a macOS release')
  }
  if (configuredIdentity && configuredIdentity.startsWith(DEVELOPER_ID_PREFIX)) {
    throw new Error('CSC_NAME must omit the Developer ID Application certificate-type prefix')
  }
  const cscLink = environmentValue(env, 'CSC_LINK')
  let identity
  let signing
  if (cscLink !== undefined) {
    if (environmentValue(env, 'CSC_KEY_PASSWORD') === undefined) {
      throw new Error('CSC_KEY_PASSWORD is required when CSC_LINK supplies a macOS signing certificate')
    }
    if (configuredIdentity === undefined) {
      throw new Error('CSC_NAME is required when CSC_LINK supplies a macOS signing certificate')
    }
    identity = `${DEVELOPER_ID_PREFIX} ${configuredIdentity}`
    signing = 'p12'
  } else {
    const identities = developerIdApplications(listCodeSigningIdentities())
    if (identities.length === 0) {
      throw new Error('A valid Developer ID Application certificate with its private key is required in the Keychain')
    }
    const matchedIdentity = configuredIdentity === undefined
      ? identities[0]
      : identities.find((candidate) => electronBuilderIdentity(candidate) === configuredIdentity)
    if (matchedIdentity === undefined) {
      throw new Error(`CSC_NAME does not match a valid Keychain identity: ${configuredIdentity}`)
    }
    identity = matchedIdentity
    signing = 'keychain'
  }

  return {
    identity,
    notarization: resolveNotarizationCredentials(env),
    signing,
  }
}

function main() {
  try {
    const env = adaptMacReleaseEnvironment(process.env)
    const safeEnvironment = withoutMacReleaseSecrets(env)
    const result = assertMacReleaseReady({
      env,
      platform: process.platform,
      listCodeSigningIdentities: () => listCodeSigningIdentities(safeEnvironment),
    })
    console.log(
      `macOS release preflight passed: ${result.identity}; signing via ${result.signing}; notarization via ${result.notarization}`,
    )
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}

module.exports = {
  adaptMacReleaseEnvironment,
  assertMacReleaseReady,
  withoutMacReleaseSecrets,
}

if (require.main === module) main()
