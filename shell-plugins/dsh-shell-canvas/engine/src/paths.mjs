/** 运行时路径探测：Chromium 与 ffmpeg 都优先用本机已有资源，不额外下载。 */
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, delimiter } from 'node:path';

const PW_CACHE = join(homedir(), 'Library/Caches/ms-playwright');

/** 找 Chromium：环境变量 > Playwright 缓存（headless shell 优先，体积小启动快） */
export function findChromium() {
  if (process.env.CANVAS_CHROMIUM && existsSync(process.env.CANVAS_CHROMIUM)) return process.env.CANVAS_CHROMIUM;
  if (!existsSync(PW_CACHE)) return null;
  const dirs = readdirSync(PW_CACHE).filter((d) => d.startsWith('chromium'));
  const cands = [];
  for (const d of dirs) {
    cands.push(join(PW_CACHE, d, 'chrome-headless-shell-mac-arm64', 'chrome-headless-shell'));
    cands.push(join(PW_CACHE, d, 'chrome-headless-shell-mac-x64', 'chrome-headless-shell'));
    cands.push(
      join(PW_CACHE, d, 'chrome-mac-arm64', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
      join(PW_CACHE, d, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
    );
  }
  return cands.find((p) => existsSync(p)) || null;
}

/** 找 ffmpeg：环境变量 > PATH > Homebrew Cellar */
export function findFfmpeg() {
  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  if (process.env.CANVAS_FFMPEG && existsSync(process.env.CANVAS_FFMPEG)) return process.env.CANVAS_FFMPEG;

  // ① 先扫 PATH —— 这是三平台最通用的一条（Windows 用 ; 分隔，Node 的 delimiter 会自动处理）
  for (const dir of String(process.env.PATH || '').split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, exe);
    if (existsSync(p)) return p;
  }

  // ② 各平台常见安装位置
  //   ⚠️ 2026-10-09：这里原来**只有 macOS 的两个路径**，Windows/Linux 上必然找不到 ffmpeg，
  //      而 ffmpeg 是合成编码的硬依赖 → 那两个平台**根本出不了片**。
  const guesses = process.platform === 'win32'
    ? [
      'C:\\ffmpeg\\bin\\ffmpeg.exe',
      'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe',
      join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links', 'ffmpeg.exe'),
      join(process.env.ProgramData || '', 'chocolatey', 'bin', 'ffmpeg.exe'),
      join(process.env.USERPROFILE || '', 'scoop', 'shims', 'ffmpeg.exe'),
    ]
    : process.platform === 'darwin'
      ? ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg']
      : ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/snap/bin/ffmpeg', '/var/lib/flatpak/exports/bin/ffmpeg'];
  for (const p of guesses) {
    if (p && existsSync(p)) return p;
  }

  // ③ macOS Homebrew Cellar（版本目录，保留原逻辑）
  for (const root of ['/opt/homebrew/Cellar/ffmpeg', '/usr/local/Cellar/ffmpeg']) {
    if (!existsSync(root)) continue;
    for (const v of readdirSync(root).sort().reverse()) {
      const p = join(root, v, 'bin', 'ffmpeg');
      if (existsSync(p)) return p;
    }
  }
  return null;
}

export function findFfprobe(ffmpegPath) {
  if (process.env.CANVAS_FFPROBE && existsSync(process.env.CANVAS_FFPROBE)) return process.env.CANVAS_FFPROBE;
  if (ffmpegPath) {
    const p = ffmpegPath.replace(/ffmpeg$/, 'ffprobe');
    if (existsSync(p)) return p;
  }
  return null;
}
