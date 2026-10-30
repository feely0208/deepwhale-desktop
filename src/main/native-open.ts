/**
 * 让 DSH 的「在文件管理器中显示 / 打开方式」在桌面壳里真的可用（2026-10-30）
 *
 * 现象：会话里的文件卡片点「显示文件位置」→「无法在文件管理器中显示」；「打开方式」→
 * 「无法获取应用列表」。根因不是权限，是 web 部署默认关闭了原生打开：
 * `@deepseek-ai/dsh-api-session-controller` 的 `canOpenPath()` 默认 false
 * （config.nativeOpen ?? 探测），于是 `canOpenWorkspacePath()` 返回 false，界面直接报错。
 *
 * 我们的桌面壳跑的就是本机，原生打开是安全的：在 `<home>/cordis.patch.yml` 里给
 * session-controller 行加 `config.nativeOpen: true`，DSH Host 就会用平台原生命令
 * （Windows explorer / macOS open / Linux xdg-open）执行 reveal/open。
 *
 * 与 plugin-market 的播种同一条纪律：文本级增量、可重复执行、失败不影响启动。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROW = `- id: session-controller
  name: '@deepseek-ai/dsh-api-session-controller'
  config:
    nativeOpen: true
`;

export function ensureNativeOpen(home: string): { changed: boolean } {
  try {
    const file = path.join(home, 'cordis.patch.yml');
    const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : '';
    if (/nativeOpen:\s*true/.test(current)) return { changed: false };
    const next = current.trim() === '' ? `${ROW}` : `${current.replace(/\s*$/, '')}\n\n${ROW}`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, next, 'utf-8');
    console.log('[native-open] 已开启原生文件管理器打开（session-controller.nativeOpen=true）');
    return { changed: true };
  } catch (e) {
    console.warn('[native-open] 写入失败（不影响启动）:', e);
    return { changed: false };
  }
}
