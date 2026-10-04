/**
 * 「本机内文件」的宿主半边（2026-10-04）
 *
 * 用户需求原话：「侧边栏里面貌似只能选工作区文件，我们可以增加可选本机文件吗，
 *   如果在跑的项目需要对比曾经的本机其他文件又得打开其他软件，很不方便」
 * 并明确要求：「可以并列与原生项目文件、终端来占第三个位置显示，就列为本机内文件」
 *
 * 分工：
 *   · 本文件（主进程）= 真实文件系统操作（列目录 / 用系统默认程序打开 / 在访达显示）
 *   · src/localfiles/localfiles.js（注入到渲染层）= 往「开始」面板加第三张卡片 + 面板 UI
 *
 * 安全边界（相对宽松但可控）：
 *   · 只接受**绝对路径**，先 path.resolve + fs.realpath 归一化
 *   · 只列目录，不递归遍历；单目录最多 400 条
 *   · 不删除、不写入、不改名 —— 只读 + 交给系统打开
 *   · 一切失败都返回 {ok:false,error}，绝不抛出到渲染层
 */
import { app, ipcMain, shell } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

interface LocalDirEntry {
  name: string;
  path: string;
  dir: boolean;
  size: number;
  mtime: number;
}

interface LocalShortcut {
  label: string;
  path: string;
}

/** 侧栏面板顶部那几个快捷位置 */
function shortcuts(): LocalShortcut[] {
  const out: LocalShortcut[] = [];
  const push = (label: string, p: string): void => {
    try {
      if (p && fs.existsSync(p)) out.push({ label, path: p });
    } catch {
      /* 忽略 */
    }
  };
  push('主目录', app.getPath('home'));
  push('桌面', app.getPath('desktop'));
  push('下载', app.getPath('downloads'));
  push('文稿', app.getPath('documents'));
  return out;
}

/** 归一化并校验：必须是绝对路径，且（尽力）解析软链接 */
function normalizeDir(input: unknown): string | null {
  if (typeof input !== 'string' || !input || !path.isAbsolute(input)) return null;
  const resolved = path.resolve(input);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved; // 目录不存在也让上层给出友好错误
  }
}

export function registerLocalFilesIpc(): void {
  ipcMain.handle('localfiles:roots', () => ({
    home: app.getPath('home'),
    sep: path.sep,
    shortcuts: shortcuts(),
  }));

  ipcMain.handle('localfiles:list', (_e, dir: unknown) => {
    const target = normalizeDir(dir);
    if (!target) return { ok: false, error: '需要绝对路径' };
    try {
      const st = fs.statSync(target);
      if (!st.isDirectory()) return { ok: false, error: '不是目录' };
      const names = fs.readdirSync(target).slice(0, 400);
      const entries: LocalDirEntry[] = [];
      for (const name of names) {
        // 跳过 macOS 的隐藏噪声，但保留用户可见的隐藏文件夹开关交给 UI（这里先不返回以 . 开头的）
        if (name.startsWith('.')) continue;
        const full = path.join(target, name);
        try {
          const s = fs.lstatSync(full);
          const isDir = s.isDirectory();
          entries.push({
            name,
            path: full,
            dir: isDir,
            size: isDir ? 0 : s.size,
            mtime: s.mtimeMs,
          });
        } catch {
          /* 单个条目读不到就跳过（权限/已删除） */
        }
      }
      entries.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name, 'zh') : a.dir ? -1 : 1));
      return { ok: true, dir: target, parent: path.dirname(target), entries, truncated: names.length >= 400 };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, error: '读取目录失败：' + msg, dir: target };
    }
  });

  // 用系统默认程序打开（视频/图片/PDF/文档都能用，等于"不用开别的软件"）
  ipcMain.handle('localfiles:open', async (_e, target: unknown) => {
    const p = normalizeDir(target) ?? (typeof target === 'string' && path.isAbsolute(target) ? path.resolve(target) : null);
    if (!p) return { ok: false, error: '需要绝对路径' };
    const err = await shell.openPath(p);
    return err ? { ok: false, error: err } : { ok: true };
  });

  ipcMain.handle('localfiles:reveal', (_e, target: unknown) => {
    try {
      if (typeof target !== 'string' || !path.isAbsolute(target)) return { ok: false, error: '需要绝对路径' };
      shell.showItemInFolder(path.resolve(target));
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });
}
