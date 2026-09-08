// 设备指纹：优先读稳定的机器 UUID，读不到则回退 hash(主机名+硬件)。
const os = require('os')
const { createHash } = require('crypto')
const { readFileSync, writeFileSync } = require('fs')
const { execSync } = require('child_process')
function stableId() {
  try {
    if (os.platform() === 'darwin') {
      const out = execSync("ioreg -rd1 -c IOPlatformExpertDevice").toString()
      const m = out.match(/"IOPlatformUUID"\s*=\s*"([0-9A-Fa-f-]+)"/)
      if (m) return m[1]
    } else if (os.platform() === 'linux') {
      const t = readFileSync('/etc/machine-id', 'utf8').trim()
      if (t) return t
    } else if (os.platform() === 'win32') {
      const out = execSync('reg query "HKLM\\SOFTWARE\\Microsoft\\Cryptography" /v MachineGuid').toString()
      const m = out.match(/MachineGuid\s+REG_SZ\s+([0-9A-Fa-f-]+)/)
      if (m) return m[1]
    }
  } catch {}
  return null
}
function machineCode() {
  const id = stableId()
  let seed = id
  if (!seed) {
    const net = os.networkInterfaces()
    const macs = Object.values(net).flat().filter(i => i && i.mac && i.mac !== '00:00:00:00:00:00').map(i => i.mac).sort().join(',')
    seed = [os.hostname(), os.platform(), os.arch(), (os.cpus()[0] || {}).model, macs].join('|')
  }
  return createHash('sha256').update(seed).digest('hex').slice(0, 20).toUpperCase()
}
module.exports = { machineCode }
