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

/**
 * 把日志里的凭据打码（2026-10-14 加）。
 *
 * 为什么必须做：DSH 的访问地址长这样
 *   `dsh web: http://127.0.0.1:3095/?token=lzhWxG3uN7xuLuZKGNffPMKh7JJjjqPlwNr9Gh6OBJA`
 * 而它就出现在我们**要用户发给我们**的故障日志里（2026-10-14 那位 Windows 用户的
 * fault.log 里就有两条带 token 的 URL，还有 `prefill_token=`）——
 * 用户把日志发出来 = 把本机凭据一起发了。日志可以共享，凭据不行。
 */
export function redactSecrets(text: string): string {
  return String(text)
    .replace(/([?&]token=)[A-Za-z0-9_\-+/=.]+/gi, '$1<已打码>')
    .replace(/(prefill_token=)[A-Za-z0-9_\-+/=.]+/gi, '$1<已打码>')
    .replace(/(authorization:\s*bearer\s+)[A-Za-z0-9_\-+/=.]+/gi, '$1<已打码>');
}

/** 运行环境事实（版本 / 平台 / 安装目录）—— 每条日志都带上，否则跨版本回溯只能靠猜 */
export function envFacts(): { version: string; platform: string; installDir: string } {
  const anyApp = app as unknown as
    | { getVersion?: () => string; getPath?: (name: 'exe') => string }
    | undefined;
  let version = 'unknown';
  let installDir = 'unknown';
  try {
    version = typeof anyApp?.getVersion === 'function' ? anyApp.getVersion() : 'unknown';
  } catch {
    /* 非 Electron 环境（离线守卫脚本直接 require 本模块）*/
  }
  try {
    installDir =
      typeof anyApp?.getPath === 'function' ? path.dirname(anyApp.getPath('exe')) : 'unknown';
  } catch {
    /* 同上 */
  }
  return { version, platform: `${process.platform} ${process.arch}`, installDir };
}

/** 在"查看日志"里展示给用户的一段格式（含环境事实 + 凭据打码） */
export function formatEntry(entry: CrashLogEntry): string {
  const env = envFacts();
  return [
    '────────────────────────────────────────',
    `时间：${entry.at}`,
    `类别：${entry.kind}`,
    `概要：${entry.summary}`,
    `版本：${env.version}　平台：${env.platform}`,
    `安装目录：${env.installDir}`,
    '详情：',
    redactSecrets(entry.detail),
    '',
  ].join('\n');
}

/**
 * 这个未处理拒绝是不是"导航被抢占"（ERR_ABORTED / (-3) loading）？
 *
 * 是的话**不记入故障日志**：它是正常的导航中止（同一时刻两次 loadURL 的结果），
 * 不是缺陷。2026-10-14 那份用户日志里 5 条 unhandledRejection 全是这个 ——
 * 把噪音写进"要给用户看的故障日志"，等于让真正的故障被淹没。
 */
export function isBenignNavigationAbort(reason: unknown): boolean {
  const text =
    reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason ?? '');
  return /ERR_ABORTED/i.test(text) || /\(-3\)\s*loading/i.test(text);
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
  // ⚠️ 连"算出日志路径"也要在 try 里：`app.getPath()` 在某些异常启动状态下会抛，
  //    而这条路径是**崩溃处理链**的一部分 —— 记不下日志可以接受，把异常再抛出去不行。
  try {
    const file = crashLogPath();
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
        '深鲸桌面遇到一个内部错误',
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
    // 未处理的 Promise 拒绝通常不致命，只记录，不打扰用户。
    // ⚠️ 但"导航被抢占"（ERR_ABORTED / (-3) loading）不是缺陷 —— 它是同一时刻两次
    //    loadURL 的正常结果（2026-10-14 用户日志里 5 条里全是它）。写进故障日志只会
    //    把真故障淹没，用户发给我们看时也多一堆噪音。
    if (isBenignNavigationAbort(reason)) {
      console.warn('[crash-guard] 忽略一次正常的导航中止（ERR_ABORTED）');
      return;
    }
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
