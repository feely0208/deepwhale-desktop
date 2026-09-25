import { app, crashReporter, dialog, shell, BrowserWindow } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

/**
 * crash-guard.ts — 崩溃兜底与**仅本地**的故障日志
 *
 * ── 设计原则 ──────────────────────────────────────────────────────
 *  1. **纯增量**：不改变任何既有模块的行为，只在异常路径上补日志与提示。
 *  2. **日志只落本地，绝不上传**：写入 `<userData>/logs/`，与「数据不出端」
 *     的产品定位一致。Electron 的 crashReporter 也显式关闭上传。
 *  3. **不吞异常**：主进程致命错误仍按 Electron 默认行为处理，但在此之前
 *     先把现场写盘，便于事后定位。
 *  4. **日志有上限**：超过阈值自动截断，避免长期使用后无限增长。
 *
 * ── 覆盖的故障面 ──────────────────────────────────────────────────
 *  · 主进程未捕获异常        process.uncaughtException
 *  · 未处理的 Promise 拒绝   process.unhandledRejection
 *  · 渲染进程崩溃            app.render-process-gone
 *  · 子进程崩溃              app.child-process-gone
 *  · 启动失败（由调用方传入）见 index.ts 的可操作失败对话框
 */

/** 单个日志文件的大小上限（字节）。超过则把旧内容截半保留。 */
const MAX_LOG_BYTES = 512 * 1024;

export interface CrashGuardOptions {
  /**
   * 是否弹窗提示。冒烟测试/CI 下传 false，避免弹窗卡住自动化。
   * 默认 true。
   */
  interactive?: boolean;
  /** 取主窗口；返回 null 时使用无父窗口的对话框 */
  getWindow: () => BrowserWindow | null;
  /** 日志写入后的回调（例如同步给托盘菜单显示"查看故障日志"） */
  onLogged?: (entry: CrashLogEntry) => void;
}

export interface CrashLogEntry {
  /** 故障类别 */
  kind: string;
  /** 面向用户的短描述 */
  summary: string;
  /** 完整详情（含堆栈） */
  detail: string;
  at: string;
}

/** `<userData>/logs` — 与 Electron 的 app.getPath('logs') 保持同一位置 */
export function crashLogDir(): string {
  const dir = app.getPath('logs');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // 目录建不出来时退化为 userData 根目录，保证仍有地方写
  }
  return dir;
}

/** 故障日志文件路径（可在"查看日志"中直接打开） */
export function crashLogPath(): string {
  return path.join(crashLogDir(), 'fault.log');
}

/** 在"查看日志"里展示给用户的一行格式 */
function formatEntry(entry: CrashLogEntry): string {
  return [
    '────────────────────────────────────────',
    `时间：${entry.at}`,
    `类别：${entry.kind}`,
    `概要：${entry.summary}`,
    '详情：',
    entry.detail,
    '',
  ].join('\n');
}

/** 截断过大的日志，保留后半段（最新内容更重要） */
function trimIfTooLarge(file: string): void {
  try {
    const stat = fs.statSync(file);
    if (stat.size <= MAX_LOG_BYTES) {
      return;
    }
    const raw = fs.readFileSync(file, 'utf-8');
    fs.writeFileSync(file, raw.slice(Math.floor(raw.length / 2)), 'utf-8');
  } catch {
    // 截断失败不影响主流程
  }
}

/** 追加一条故障日志（本地） */
export function appendCrashLog(entry: CrashLogEntry): void {
  const file = crashLogPath();
  try {
    fs.appendFileSync(file, formatEntry(entry), 'utf-8');
    trimIfTooLarge(file);
  } catch (error) {
    console.error('[crash-guard] 日志写入失败:', error);
  }
}

/** 把任意异常整理成可读详情 */
function describe(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? `${error.name}: ${error.message}`;
  }
  try {
    return JSON.stringify(error, null, 2) ?? String(error);
  } catch {
    return String(error);
  }
}

/**
 * 安装全局崩溃兜底。
 * 幂等：重复调用不会重复注册监听器。
 */
export function installCrashGuard(options: CrashGuardOptions): void {
  if (installed) {
    return;
  }
  installed = true;

  const interactive = options.interactive ?? true;

  const record = (kind: string, summary: string, error: unknown): void => {
    const entry: CrashLogEntry = {
      kind,
      summary,
      detail: describe(error),
      at: new Date().toISOString(),
    };
    appendCrashLog(entry);
    options.onLogged?.(entry);
    console.error(`[crash-guard] ${kind}: ${summary}`);
  };

  // Electron 自带崩溃收集：**关闭上传**，只在本地留 minidump。
  // 放在最外层 try 里——crashReporter 在部分平台/沙箱下不可用，失败不能影响启动。
  try {
    crashReporter.start({
      productName: app.getName(),
      companyName: 'DeepWhale',
      submitURL: '',
      uploadToServer: false,
      compress: true,
    });
  } catch (error) {
    console.error('[crash-guard] crashReporter 初始化失败（不影响启动）:', error);
  }

  process.on('uncaughtException', (error) => {
    record('uncaughtException', '主进程发生未捕获异常', error);
    if (interactive) {
      void notify(
        options,
        '深鲸壳遇到一个内部错误',
        [
          '程序仍可继续使用，但建议重启一次。',
          '',
          '该错误已记录到本地日志（不会上传）。',
        ].join('\n'),
        ['继续使用', '查看日志'],
      );
    }
  });

  process.on('unhandledRejection', (reason) => {
    // 未处理的 Promise 拒绝通常不致命，只记录，不打扰用户
    record('unhandledRejection', '存在未处理的异步错误', reason);
  });

  app.on('render-process-gone', (_event, _webContents, details) => {
    record(
      'render-process-gone',
      `界面进程中断（${details.reason}）`,
      new Error(`reason=${details.reason} exitCode=${String(details.exitCode)}`),
    );
    if (!interactive) {
      return;
    }
    void notify(
      options,
      '界面需要重新加载',
      '界面进程意外中断，重新加载通常可以恢复。\n\n当前会话数据（案件、文书等）保存在本机，不会丢失。',
      ['重新加载', '稍后'],
    ).then((choice) => {
      if (choice !== 0) {
        return;
      }
      const win = options.getWindow();
      if (win !== null && !win.isDestroyed()) {
        win.reload();
      }
    });
  });

  app.on('child-process-gone', (_event, details) => {
    // 只记录：DSH 子进程的正常退出也会走这里，避免误报打扰
    record(
      'child-process-gone',
      `子进程结束（${details.type} / ${details.reason}）`,
      new Error(`type=${details.type} reason=${details.reason} exitCode=${String(details.exitCode)}`),
    );
  });
}

/** 提示框；选择"查看日志"时打开日志目录 */
async function notify(
  options: CrashGuardOptions,
  title: string,
  message: string,
  buttons: string[],
): Promise<number> {
  const win = options.getWindow();
  const dialogOptions = {
    type: 'warning' as const,
    title,
    message,
    buttons,
    defaultId: 0,
    cancelId: buttons.length - 1,
    noLink: true,
  };
  const result =
    win !== null && !win.isDestroyed()
      ? await dialog.showMessageBox(win, dialogOptions)
      : await dialog.showMessageBox(dialogOptions);
  if (buttons[result.response] === '查看日志') {
    void shell.openPath(crashLogDir());
  }
  return result.response;
}

let installed = false;
