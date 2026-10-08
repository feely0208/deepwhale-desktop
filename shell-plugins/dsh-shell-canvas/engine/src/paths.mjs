/** 运行时路径探测：Chromium 与 ffmpeg 都优先用本机已有资源，不额外下载。 */
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

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
  if (process.env.CANVAS_FFMPEG && existsSync(process.env.CANVAS_FFMPEG)) return process.env.CANVAS_FFMPEG;
  for (const p of ['/usr/local/bin/ffmpeg', '/opt/homebrew/bin/ffmpeg']) {
    if (existsSync(p)) return p;
  }
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
