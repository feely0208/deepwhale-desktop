/**
 * 渲染子进程（Electron 主进程入口，Electron OSR 后端）。
 *
 * ── 为什么渲染要跑在 Electron 进程里 ─────────────────────────────────
 * `ElectronOsrAdapter` 需要 `BrowserWindow`，而它**只能在 Electron 主进程**里造。
 * DSH 宿主本身是用 `ELECTRON_RUN_AS_NODE=1` 拉起来的纯 Node 进程，拿不到
 * `BrowserWindow`，所以 OSR 渲染只能另起一个 Electron 进程 —— 顺带也满足了
 * "渲染崩了不能拖垮主窗口"（同一个理由，见 lib/worker.mjs 的头注）。
 *
 * ── 与 lib/worker.mjs 的关系 ────────────────────────────────────────
 * 任务逻辑完全共用 `lib/pipeline-run.mjs`，本文件只做三件事：
 *   ① 按任务尺寸建**离屏**窗口，把 ElectronOsrAdapter 交给同一个执行体；
 *   ② 协议与 worker.mjs 逐字相同（stdout 一行一个 JSON），宿主不必分两套解析；
 *   ③ 收 SIGTERM 时走同一套 abort 流程（引擎落 partial manifest → 可续渲）。
 *
 * 用法：
 *   <Electron 二进制> lib/osr-main.cjs <job.json>
 * 注意：环境里**不能**带 `ELECTRON_RUN_AS_NODE`，否则会退化成纯 Node（没有 BrowserWindow）。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const spec = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const emit = (e) => { process.stdout.write(JSON.stringify(e) + '\n'); };

/**
 * 冲干净 stdout 再退。
 *
 * ⚠️ 这一步不能省（S3 实测）：stdout 是**管道**，`process.stdout.write` 是异步的，
 *    而 `app.exit()` 是立即终止 —— 最后那行 `{"t":"result"}` 还在缓冲区里就被丢掉了。
 *    宿主看到的是"退出码 0 但没有结果"，会判成失败，而任务其实**已经跑完了**。
 *    写法：再写一个哨兵块，等它的回调 —— Node 保证 FIFO，最后一块冲出去就说明前面都冲完了。
 */
function flushAndExit(code) {
  let done = false;
  const finish = () => { if (!done) { done = true; app.exit(code); } };
  process.stdout.write('\n', finish);
  setTimeout(finish, 2000).unref?.();
}

const { app, BrowserWindow } = require('electron');

// 绝不跟正在运行的主应用抢 userData（抢了会互相踢、还会动用户的设置）。
app.setPath('userData', path.join(os.tmpdir(), `dsh-canvas-osr-${process.pid}`));

// 确定性开关：与 Chromium 适配器 `DETERMINISM_FLAGS` 保持同一组，
// 否则两个后端逐帧对不上（S3 的验收项之一）。
for (const flag of [
  'force-color-profile=srgb',
  'font-render-hinting=none',
  'disable-lcd-text',
  'disable-partial-raster',
  'disable-threaded-animation',
  'disable-threaded-scrolling',
  'run-all-compositor-stages-before-draw',
  'hide-scrollbars',
  'mute-audio',
]) {
  const i = flag.indexOf('=');
  app.commandLine.appendSwitch(flag.slice(0, i), flag.slice(i + 1));
}
app.disableHardwareAcceleration();

const controller = new AbortController();
const abort = () => { if (!controller.signal.aborted) controller.abort(); };
process.on('SIGTERM', abort);
process.on('SIGINT', abort);

/**
 * ⚠️ 必须订阅 `window-all-closed`，否则整个任务会在**第一个方向渲完时静默死掉**。
 *
 * 每个方向渲完，`renderTemplate` 都会在 finally 里 `adapter.close()` → `destroy()` 掉那个离屏窗口。
 * 而 Electron 的默认行为是：**所有窗口关闭后直接退出 app**（不是"macOS 才不退出"——
 * 那条 macOS 惯例得由 app 自己写，框架默认就是退出）。
 * 于是竖版渲完 → 唯一的窗口被销毁 → 进程退出码 0 → 宿主看到"正常退出但没有结果"，
 * 判成失败 —— 而进度条上明明已经走到 100%。这个"成功却报失败"的形态极难从结果反推原因。
 *
 * 本进程的寿命由**任务**决定，不由窗口决定，所以这里明确不退出。
 */
app.on('window-all-closed', () => { /* 有意留空 */ });

/** 所有开出去的窗口，退出前一律销毁，别留僵尸离屏渲染。 */
const windows = [];

async function main() {
  if (app.dock) app.dock.hide();
  await app.whenReady();

  const { runJob } = await import(pathToFileURL(path.join(__dirname, 'pipeline-run.mjs')).href);
  const { ElectronOsrAdapter } = await import(
    pathToFileURL(path.join(spec.engineRoot, 'src/render/adapter-electron.mjs')).href
  );

  const makeAdapter = ({ width, height }) => {
    const win = new BrowserWindow({
      show: false,
      width,
      height,
      webPreferences: { offscreen: true, nodeIntegration: false, contextIsolation: true },
    });
    windows.push(win);
    return new ElectronOsrAdapter({
      window: win,
      width,
      height,
      fps: spec.fps || 30,
      // 断网由适配器自己装（按协议过滤，不会把自己那份 data: URL 也拦掉）。
      session: win.webContents.session,
    });
  };

  const value = await runJob(spec, { emit, makeAdapter, signal: controller.signal });
  for (const w of windows) { try { if (!w.isDestroyed()) w.destroy(); } catch { /* 退出中，忽略 */ } }
  emit({ t: 'result', value });
  flushAndExit(0);
}

main().catch((error) => {
  for (const w of windows) { try { if (!w.isDestroyed()) w.destroy(); } catch { /* ignore */ } }
  emit({
    t: 'error',
    message: error && error.message ? error.message : String(error),
    cancelled: !!(error && error.cancelled) || controller.signal.aborted,
    validation: (error && error.validation) || null,
  });
  flushAndExit(error && error.cancelled ? 3 : 1);
});
