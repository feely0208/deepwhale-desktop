import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * 手机连接：让桌面端的 DSH 对局域网开门。
 *
 * ── 为什么必须做（2026-09-30 用户的原话）────────────────────────
 *   「一个简单的不能再简单的 mobile，都用不了，还能做什么呢」
 *   「我当场能连不够，要用户从官网下载安装好后也能用才行」
 *
 * 根因只有一个：**DSH 默认只绑 127.0.0.1（只本机）**，手机在局域网上够不着。
 * 以前能用，是因为那时的 DSH 绑的是 0.0.0.0 —— 换了随包 0.2.0 之后默认值变了。
 * 手机 App 本身一个字都没坏。
 *
 * ── 光绑 0.0.0.0 还不够 ────────────────────────────────────────
 * DSH 还有一道 **host 信任闸门**：登录凭据是**绑定到签发时那个地址**的。
 * 实测：同一个凭据，`127.0.0.1` 上返回 200，换成 `192.168.1.25` 就 401。
 * 所以必须把**手机实际会用的那个地址**显式放行。
 *
 * ⚠️ 这里**绝不能写死 IP**：每个用户的局域网地址都不一样（192.168.x.x / 10.x.x.x…），
 *    而且换 WiFi 就会变。所以是**运行时探测本机网卡**，探测到几个就放行几个。
 *
 * ⚠️ 安全提示：绑 0.0.0.0 = 同一 WiFi 下别人也能访问到这个端口。
 *    所以 **DSH 的 token 鉴权必须保留**（我们不动它），这也是为什么
 *    「手机连接」界面要把 token 藏进二维码 —— 不给用户添麻烦，也不把口子敞开。
 */

/** 本机所有对内网卡地址（排除回环）。 */
export function lanAddresses(): string[] {
  const out: string[] = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const info of ifaces[name] ?? []) {
      // 只取 IPv4、非回环、非链路本地
      if (info.family !== 'IPv4' || info.internal) continue;
      if (info.address.startsWith('169.254.')) continue;
      if (!out.includes(info.address)) out.push(info.address);
    }
  }
  // 优先 192.168 / 10. 这两个最像家用/办公局域网，放在前面只是为了日志好看
  return out.sort((a, b) => {
    const rank = (x: string) => (x.startsWith('192.168.') ? 0 : x.startsWith('10.') ? 1 : 2);
    return rank(a) - rank(b);
  });
}

/** 生成要写进 patch 的那一段。host 固定 0.0.0.0，trustedHosts 来自运行时探测。 */
export function bindingBlock(port: number, addresses: string[]): string {
  const trusted = addresses.map((ip) => `          - ${ip}:${port}`).join('\n');
  return [
    '# ── 手机连接：让局域网里的手机能连上桌面端 ──',
    '# 为什么必须有这段：DSH 默认只绑 127.0.0.1（只本机），手机够不着 —— 这正是',
    '# 「以前手机能用、后来突然不能用了」的唯一原因（以前绑的是 0.0.0.0）。',
    '# host 那行负责"能连上"，trustedHosts 负责"连上之后不被信任闸门挡住"：',
    '# 实测同一个登录凭据在 127.0.0.1 上返回 200、换成局域网 IP 就 401，就是这个闸门。',
    '#',
    '# ⚠️ trustedHosts 里的地址是**壳启动时探测出来的**，不是写死的 ——',
    '#   每个用户的局域网地址不同，换 WiFi 也会变。不要手工把它固定成某个 IP。',
    '- insert:',
    '    - id: webserver',
    "      name: '@deepseek-ai/dsh-host-webserver'",
    '      config:',
    `        port: ${port}`,
    '        host: 0.0.0.0',
    '        trustedHosts:',
    trusted,
    '',
  ].join('\n');
}

/**
 * 幂等写入。地址变了（换了 WiFi）就重写 —— 否则用户换个网络就连不上了。
 * @returns 是否有改动
 */
export function ensureMobileAccess(home: string, port: number): { changed: boolean; addresses: string[] } {
  const addresses = lanAddresses();
  if (addresses.length === 0) return { changed: false, addresses };

  const file = path.join(home, 'cordis.patch.yml');
  let current = '';
  try {
    current = fs.readFileSync(file, 'utf8');
  } catch {
    current = '';
  }

  // 先把**旧的那一块**整块摘掉再写新的。
  //
  // ⚠️ 这里踩过一次：第一版用字符串下标去切旧块，切不干净 ——
  //    第二次调用本该 changed=false，结果又追加了一份，连调三次文件里堆了三份。
  //    现在改成按行扫：`- insert:` 块的内部只要出现 `- id: webserver`，整块
  //    （连同它上面我们写的注释）一起丢掉。跟 feedback.ts 里那套一样。
  const wanted = bindingBlock(port, addresses);
  const lines = current.split('\n');
  const kept: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() !== '- insert:') {
      kept.push(line);
      i += 1;
      continue;
    }
    let j = i + 1;
    const inner: string[] = [];
    while (j < lines.length && !lines[j].startsWith('- ') && !lines[j].startsWith('#')) {
      inner.push(lines[j]);
      j += 1;
    }
    // 是不是我们写的那块
    const isOurs = inner.some((l) => l.startsWith('    - id: ') && l.includes('webserver'));
    if (isOurs) {
      while (
        kept.length > 0 &&
        (kept[kept.length - 1].trim() === '' || kept[kept.length - 1].trim().startsWith('#'))
      ) {
        kept.pop();
      }
      i = j;
      continue;
    }
    kept.push(line);
    i += 1;
  }
  const base = kept.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s*$/, '');

  // 内容一致就不写盘（避免每次启动都改文件、也避免触发无意义的 reload）
  if (base.includes('- id: webserver') === false && current.trim() === `${base === '' ? '' : base + '\n\n'}${wanted}`.trim()) {
    return { changed: false, addresses };
  }
  const next = `${base === '' ? '' : `${base}\n\n`}${wanted}`;
  if (current === next) return { changed: false, addresses };
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(file, next);
  return { changed: true, addresses };
}
