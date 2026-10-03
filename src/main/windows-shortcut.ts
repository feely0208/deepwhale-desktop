/**
 * Windows 快捷方式自愈（2026-10-03）
 *
 * 背景（Windows 用户实测）：
 *   自动更新后，桌面快捷方式的【目标】变成了
 *   `…\AppData\Local\Temp\…\old-install\DeepWhale Desktop.exe`，【起始位置】也跟着偏。
 *
 * 根因（两层，见 待办-Windows自动更新把快捷方式指到临时目录.md）：
 *   ① `appId` 从 `com.dsh.desktop` 改成 `com.deepwhale.desktop` → NSIS 读不到旧安装目录
 *      （它用 appId 拼注册表键），于是退到默认目录，旧目录被挪进 $_TEMP\…\old-install，
 *      快捷方式最终指向那里；
 *   ② 更新时 `quitAndInstall(false, …)` 弹了完整安装向导，放大了目录漂移
 *      （已在 update-manager.ts 改成静默安装）。
 *
 * 为什么还要这个模块：对普通用户来说，"去开始菜单重新建一个快捷方式"根本不现实
 * （对接人原话：「我是没问题，处理这种小事毛毛雨，但要是普通用户他不一定知道点开始菜单」）。
 * 所以每次启动自愈一次：**只修我们自己名字的那几个快捷方式**，指向当前 exe。
 *
 * 覆盖 per-user 与 per-machine 两种安装（四种落点都查）。
 * 非 Windows、未打包、或读取失败时一律安静返回，绝不打扰用户。
 */
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** 与 electron-builder.yml 的 `nsis.shortcutName` 必须一致 */
const SHORTCUT_BASENAME = 'DeepWhale Desktop';

/** Windows 上 PowerShell 的绝对路径（避免 PATH 被改坏时找不到） */
function powershellPath(): string {
  const root = process.env.SystemRoot || 'C:\\Windows';
  return path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/** 候选快捷方式落点：用户桌面 / 公共桌面 / 用户开始菜单 / 全局开始菜单 */
function shortcutCandidates(): string[] {
  const home = os.homedir();
  const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const programData = process.env.ProgramData || 'C:\\ProgramData';
  const publicDir = process.env.PUBLIC || 'C:\\Users\\Public';
  return [
    path.join(home, 'Desktop', `${SHORTCUT_BASENAME}.lnk`),
    path.join(publicDir, 'Desktop', `${SHORTCUT_BASENAME}.lnk`),
    path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', `${SHORTCUT_BASENAME}.lnk`),
    path.join(programData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', `${SHORTCUT_BASENAME}.lnk`),
  ];
}

function runPowerShell(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      powershellPath(),
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, timeout: 15000 },
      (error, stdout, stderr) => {
        if (error) reject(new Error(String(stderr || error.message)));
        else resolve(String(stdout || ''));
      },
    );
  });
}

/** 目标是否"指歪了"：不是当前 exe，或落在临时目录 / old-install 里 */
export function isShortcutTargetStale(target: string, exePath: string): boolean {
  if (!target) return true;
  const t = target.toLowerCase();
  const exe = exePath.toLowerCase();
  if (t === exe) return false;
  // 明确的坏路径特征（用户实测的那两种）
  if (t.includes('\\temp\\') || t.includes('/temp/') || t.includes('old-install')) return true;
  // 只要不是当前 exe，就认为需要纠正（安装目录变了、App 被移动过都算）
  return true;
}

/**
 * 检查并修复一个快捷方式。
 * 返回 'ok' | 'repaired' | 'missing' | 'error'
 */
async function repairOne(lnkPath: string, exePath: string): Promise<string> {
  if (!fs.existsSync(lnkPath)) return 'missing';
  const readScript = [
    "$ErrorActionPreference='Stop'",
    `$s=(New-Object -ComObject WScript.Shell).CreateShortcut('${lnkPath.replace(/'/g, "''")}')`,
    "Write-Output ($s.TargetPath)",
  ].join('; ');
  let target: string;
  try {
    target = (await runPowerShell(readScript)).trim();
  } catch (e) {
    console.warn('[win-shortcut] 读取失败:', lnkPath, e instanceof Error ? e.message : String(e));
    return 'error';
  }
  if (!isShortcutTargetStale(target, exePath)) return 'ok';

  const writeScript = [
    "$ErrorActionPreference='Stop'",
    `$s=(New-Object -ComObject WScript.Shell).CreateShortcut('${lnkPath.replace(/'/g, "''")}')`,
    `$s.TargetPath='${exePath.replace(/'/g, "''")}'`,
    `$s.WorkingDirectory='${path.dirname(exePath).replace(/'/g, "''")}'`,
    '$s.Save()',
    'Write-Output "saved"',
  ].join('; ');
  try {
    await runPowerShell(writeScript);
    console.log(`[win-shortcut] 已修复快捷方式：${lnkPath}（原来指向 ${target}）`);
    return 'repaired';
  } catch (e) {
    console.warn('[win-shortcut] 修复失败:', lnkPath, e instanceof Error ? e.message : String(e));
    return 'error';
  }
}

/**
 * 启动时自愈：只动我们自己名字的快捷方式；只修"指向"，绝不改安装目录。
 * 全程 try/catch —— 任何失败都只记日志，不影响启动。
 */
export async function repairWindowsShortcuts(
  opts: { exePath?: string; isPackaged?: boolean; platform?: string } = {},
): Promise<{ checked: number; repaired: number; skipped: string }> {
  const platform = opts.platform ?? process.platform;
  const isPackaged = opts.isPackaged ?? true;
  if (platform !== 'win32') return { checked: 0, repaired: 0, skipped: '非 Windows' };
  if (!isPackaged) return { checked: 0, repaired: 0, skipped: '开发态（未打包）' };

  const exePath = opts.exePath ?? process.execPath;
  if (!exePath || !exePath.toLowerCase().endsWith('.exe')) {
    return { checked: 0, repaired: 0, skipped: 'execPath 不是 exe' };
  }

  let checked = 0;
  let repaired = 0;
  for (const lnk of shortcutCandidates()) {
    try {
      const r = await repairOne(lnk, exePath);
      if (r === 'missing') continue;
      checked += 1;
      if (r === 'repaired') repaired += 1;
    } catch (e) {
      console.warn('[win-shortcut] 处理异常（已忽略）:', lnk, e instanceof Error ? e.message : String(e));
    }
  }
  if (checked === 0) console.log('[win-shortcut] 没找到我们的快捷方式（跳过自愈）');
  return { checked, repaired, skipped: '' };
}
