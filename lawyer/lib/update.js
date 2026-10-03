/**
 * 律师端的自动更新（0.1.8 起）。
 *
 * ── 为什么要有这个文件 ───────────────────────────────────────────────
 * 0.1.5 / 0.1.7 里**完全没有**更新能力（app.asar 里连 autoUpdater 都没有），
 * 所以每次升级只能"去官网下载 → 覆盖安装"。用户原话：
 *   "要不然又是下载安装覆盖那套"
 * 这个模块把桌面端已经验证过的做法搬过来。
 *
 * ── 与桌面端的关键区别：清单文件名 ───────────────────────────────────
 * 桌面端和律师端都用 electron-updater，**默认清单都叫 latest-mac.yml /
 * latest.yml** —— 同一个 CDN 目录下会互相覆盖 ⚠️。
 * 所以律师端用独立 channel：`lawyer-latest`
 *   → 生成 lawyer-latest-mac.yml / lawyer-latest.yml / lawyer-latest-linux.yml
 * （electron-builder 的 build.publish[0].channel 已设成 lawyer-latest；
 *   本模块的 feedURL 也必须带同样的 channel，两边要一致。）
 *
 * ── macOS 的限制（和桌面端一样）──────────────────────────────────────
 * 没有苹果开发者签名 → Squirrel 装不了更新 → **自动安装永远做不到**。
 * 但"下载"可以替用户做：自动把 dmg 下到「下载」目录，弹窗让他点
 * 「打开安装包」→ 拖进「应用程序」。同时把进度画在 Dock 图标上，
 * 免得 130MB 静默下载看起来像卡死。
 *
 * ── 反馈纪律（今天在桌面端踩过的坑）──────────────────────────────────
 * 「检查更新」**手动**点时必须给反馈：已是最新也要弹一句，
 * 不能因为 electron-updater 走的是 update-not-available 事件就静默。
 */
'use strict';

const { app, dialog, shell, BrowserWindow } = require('electron');
const { autoUpdater } = require('electron-updater');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

/** 自建 CDN（与桌面端同一个站点，但清单文件名不同）。 */
const FEED_BASE = 'https://dl.deepwhale.org.cn';
/** 独立 channel —— 必须与 package.json 里 build.publish[0].channel 一致。 */
const CHANNEL = 'lawyer-latest';
/** 官网下载页（mac 手动安装时的兜底入口）。 */
const DOWNLOAD_PAGE = 'https://deepwhale.org.cn/download.html';
/** 启动后多久做第一次检查（别和窗口初始化抢时间）。 */
const FIRST_CHECK_DELAY_MS = 15_000;
/** 之后每 6 小时一次。 */
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

let promptOpen = false;
let interactivePending = false;
let snoozeUntil = 0;

/** 该 .app 有没有苹果开发者签名？没有就只能"下载 dmg + 用户手拖"。 */
function macNeedsManualUpdate() {
  if (process.platform !== 'darwin') return false;
  try {
    const bundle = path.resolve(process.execPath, '..', '..', '..');
    const r = spawnSync('/usr/bin/codesign', ['-dv', '--verbose=2', bundle], {
      encoding: 'utf8',
      timeout: 10_000,
    });
    const text = `${r.stdout || ''}${r.stderr || ''}`;
    return !/Developer ID Application/.test(text);
  } catch {
    return true;
  }
}

/** electron-builder 的产物命名：DeepWhale-Lawyer-<ver>-<arch>.dmg */
function dmgName(version) {
  return `DeepWhale-Lawyer-${version}-${process.arch === 'arm64' ? 'arm64' : 'x64'}.dmg`;
}

function setDockProgress(value) {
  for (const w of BrowserWindow.getAllWindows()) {
    try {
      w.setProgressBar(value);
    } catch {
      /* 窗口可能已销毁 */
    }
  }
}

/** mac 专用：把 dmg 下到「下载」目录，返回本地路径；失败返回 null。 */
async function downloadMacDmg(version, onProgress) {
  const file = path.join(app.getPath('downloads'), dmgName(version));
  try {
    // 已下过就不重复下
    if (fs.existsSync(file) && fs.statSync(file).size > 1024 * 1024) return file;
    const res = await fetch(`${FEED_BASE}/${dmgName(version)}`);
    if (!res.ok || res.body === null) return null;
    const total = Number(res.headers.get('content-length') || '0');
    const stream = fs.createWriteStream(file);
    let received = 0;
    let last = -1;
    for await (const chunk of res.body) {
      received += chunk.length;
      stream.write(chunk);
      if (total > 0) {
        const percent = Math.round((received / total) * 100);
        if (percent !== last) {
          last = percent;
          if (typeof onProgress === 'function') onProgress(percent);
        }
      }
    }
    await new Promise((resolve) => stream.end(() => resolve()));
    setDockProgress(-1);
    return fs.existsSync(file) && fs.statSync(file).size > 1024 * 1024 ? file : null;
  } catch {
    setDockProgress(-1);
    try {
      fs.rmSync(file, { force: true });
    } catch {
      /* 清理失败无所谓 */
    }
    return null;
  }
}

async function onAvailable(info) {
  if (promptOpen) return;
  promptOpen = true;
  try {
    if (macNeedsManualUpdate()) {
      // mac：Squirrel 装不了 → 替用户把 dmg 下好，只留"拖一下"
      const dmg = await downloadMacDmg(info.version, (percent) => setDockProgress(percent / 100));
      if (dmg) {
        const choice = await dialog.showMessageBox({
          type: 'info',
          title: '新版本已下载好',
          message: `深鲸·律师端 ${info.version} 的安装包已经下载完成。`,
          detail:
            'macOS 版没有苹果开发者签名，系统不允许自动替换应用 —— ' +
            '所以最后一步要你亲手拖一下（不是网络问题）：\n\n' +
            '   ① 点「打开安装包」\n' +
            '   ② 把里面的图标拖进「应用程序」\n' +
            '   ③ 系统问「替换吗」→ 替换\n\n' +
            `文件位置：${dmg}`,
          buttons: ['打开安装包', '稍后再说'],
          defaultId: 0,
          cancelId: 1,
        });
        if (choice.response === 0) {
          await shell.openPath(dmg);
        } else {
          shell.showItemInFolder(dmg);
          snoozeUntil = Date.now() + 24 * 60 * 60 * 1000;
        }
        return;
      }
      // 下载失败 → 老实退回下载页
      const fallback = await dialog.showMessageBox({
        type: 'info',
        title: '发现新版本',
        message: `深鲸·律师端 ${info.version} 已发布（当前 ${app.getVersion()}）。`,
        detail:
          'macOS 版需要手动下载安装（未做苹果开发者签名，系统会拒绝自动替换应用）。\n\n' +
          '要现在打开下载页吗？',
        buttons: ['打开下载页', '稍后再说'],
        defaultId: 0,
        cancelId: 1,
      });
      if (fallback.response === 0) await shell.openExternal(DOWNLOAD_PAGE);
      else snoozeUntil = Date.now() + 24 * 60 * 60 * 1000;
      return;
    }
    // Windows / Linux：electron-updater 自己会下（autoDownload），这里只提示
    dialog.showMessageBox({
      type: 'info',
      title: '发现新版本',
      message: `深鲸·律师端 ${info.version} 正在后台下载，下载完成后会提示你重启。`,
      buttons: ['好'],
    });
  } finally {
    promptOpen = false;
  }
}

/** 初始化：设置 feed、事件、定时器。在 app.whenReady 之后调用。 */
function init() {
  autoUpdater.autoDownload = !macNeedsManualUpdate();
  autoUpdater.autoInstallOnAppQuit = !macNeedsManualUpdate();
  autoUpdater.channel = CHANNEL;
  autoUpdater.setFeedURL({ provider: 'generic', url: FEED_BASE, channel: CHANNEL });

  autoUpdater.on('update-available', (info) => {
    void onAvailable(info);
  });
  autoUpdater.on('update-not-available', () => {
    // 手动检查必须有反馈（桌面端踩过：这里静默 = 用户以为功能坏了）
    if (interactivePending) {
      interactivePending = false;
      void dialog.showMessageBox({
        type: 'info',
        title: '检查更新',
        message: `当前已是最新版本（${app.getVersion()}）。`,
        buttons: ['知道了'],
      });
    }
  });
  autoUpdater.on('download-progress', (p) => {
    setDockProgress(Math.max(0, Math.min(1, (p.percent || 0) / 100)));
  });
  autoUpdater.on('update-downloaded', () => {
    setDockProgress(-1);
    void dialog.showMessageBox({
      type: 'info',
      title: '新版本已下载好',
      message: '重启深鲸·律师端即可完成更新。',
      buttons: ['稍后', '立即重启'],
      defaultId: 1,
    }).then((r) => {
      if (r.response === 1) autoUpdater.quitAndInstall();
    });
  });
  autoUpdater.on('error', (error) => {
    setDockProgress(-1);
    console.error('[lawyer-update] 更新出错:', error && error.message ? error.message : error);
  });

  setTimeout(() => {
    void check(false);
  }, FIRST_CHECK_DELAY_MS);
  setInterval(() => {
    void check(false);
  }, CHECK_INTERVAL_MS);
}

/** 检查更新；interactive=true 表示用户在菜单里手动点的。 */
async function check(interactive) {
  if (!interactive && Date.now() < snoozeUntil) return;
  interactivePending = !!interactive;
  try {
    const result = await autoUpdater.checkForUpdates();
    // result 为空 = 没有可用更新；此时 electron-updater 也会发 update-not-available，
    // 但两条路都可能走到，靠 interactivePending 保证只弹一次。
    if (result === null && interactive && interactivePending) {
      interactivePending = false;
      await dialog.showMessageBox({
        type: 'info',
        title: '检查更新',
        message: `当前已是最新版本（${app.getVersion()}）。`,
        buttons: ['知道了'],
      });
    }
  } catch (error) {
    if (interactive) {
      interactivePending = false;
      await dialog.showMessageBox({
        type: 'warning',
        title: '检查更新失败',
        message: '无法连接到更新服务器。',
        detail: error && error.message ? error.message : String(error),
        buttons: ['知道了'],
      });
    }
  } finally {
    interactivePending = false;
  }
}

/** 供菜单/托盘调用：手动检查。 */
function checkNow() {
  return check(true);
}

module.exports = { init, checkNow, macNeedsManualUpdate };
