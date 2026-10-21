/**
 * 宠物一键生成（petforge）：在主进程里调随包的 Python 脚本。
 *
 * 设计要点：
 * - **不提供算力**：用户自备图像生成 API Key，我们只发一次 HTTP 请求到用户自己的账号。
 * - Python 用随包 office-runtime 里的那个（自带 Pillow），不要求用户装环境。
 * - 脚本走 extraResources 外置（asar 内文件外部进程读不到）。
 * - Key 存在主进程 store（electron-store），不落到页面 localStorage。
 *
 * 2026-10-20 新增。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app } from 'electron';

export type ForgeProvider = 'agnes' | 'dashscope' | 'doubao' | 'zhipu' | 'siliconflow' | 'openai';
export type ForgeStyle =
  | 'generic' | 'lawyer' | 'judge' | 'prosecutor' | 'bailiff' | 'forensic' | 'clerk' | 'chef';

export interface ForgeOptions {
  description: string;
  name?: string;
  style?: ForgeStyle;
  provider?: ForgeProvider;
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  /** 动作生成方式：procedural=程序化变换（快）；video=AI 视频真动作（用用户自己的视频模型） */
  motion?: 'procedural' | 'video';
  /** 视频模型名（motion=video 时用） */
  videoModel?: string;
  /** 视频时长秒数 4~12 */
  videoSeconds?: string;
}

export interface ForgeResult {
  ok: boolean;
  name?: string;
  error?: string;
  log?: string;
}

/** 随包 Python（自带 Pillow）；开发态回退到系统 python3 */
function pythonBin(): string {
  const bundled = path.join(
    process.resourcesPath,
    'office-runtime',
    'dependencies',
    'python',
    'bin',
    'python3',
  );
  if (app.isPackaged && fs.existsSync(bundled)) return bundled;
  return 'python3';
}

/** petforge.py 路径：打包后走 extraResources/tools，开发态走仓库 assets */
function forgeScript(): string {
  const packed = path.join(process.resourcesPath, 'tools', 'petforge', 'petforge.py');
  if (fs.existsSync(packed)) return packed;
  // 开发态：<repo>/dist/main/../.. → 仓库根
  const dev = path.join(app.getAppPath(), '..', 'assets', 'tools', 'petforge', 'petforge.py');
  if (fs.existsSync(dev)) return dev;
  return path.join(app.getAppPath(), 'assets', 'tools', 'petforge', 'petforge.py');
}

/** 《宠物怎么捏》说明文档路径（随包外置在 tools/petforge 下） */
export function forgeDocPath(): string {
  // 优先打开图文版（用户看的是流程图，不是 markdown 源码）
  for (const f of ['宠物怎么捏.png', '宠物怎么捏.md']) {
    const packed = path.join(process.resourcesPath, 'tools', 'petforge', f);
    if (fs.existsSync(packed)) return packed;
    const dev = path.join(app.getAppPath(), '..', 'assets', 'tools', 'petforge', f);
    if (fs.existsSync(dev)) return dev;
  }
  return path.join(app.getAppPath(), 'assets', 'tools', 'petforge', '宠物怎么捏.png');
}

/** 用 Python 生成一只宠物。返回生成出来的宠物名（安装到 pets 目录后可见）。 */
export function forgePet(opts: ForgeOptions, petsDir: string): Promise<ForgeResult> {
  return new Promise((resolve) => {
    const desc = String(opts.description ?? '').trim();
    if (!desc) return resolve({ ok: false, error: '请先描述你想要的宠物' });
    if (desc.length > 200) return resolve({ ok: false, error: '描述太长（最多 200 字）' });

    // 视频模式耗时可能十几分钟（用户自己的模型排队），超时放宽；程序化 3 分钟足够
    let timeoutMs = opts.motion === 'video' ? 40 * 60 * 1000 : 180_000;

    const style = (opts.style ?? 'generic') as ForgeStyle;
    const name = (opts.name && opts.name.trim()) || desc.slice(0, 8);

    const args = [
      forgeScript(),
      desc,
      '--name', name,
      '--style', style,
      '--pets-dir', petsDir,
    ];
    if (opts.provider) args.push('--provider', opts.provider);
    if (opts.apiKey) args.push('--api-key', opts.apiKey);
    if (opts.model) args.push('--model', opts.model);
    if (opts.baseUrl) args.push('--base-url', opts.baseUrl);
    if (opts.motion === 'video') {
      args.push('--motion', 'video');
      if (opts.videoModel) args.push('--video-model', opts.videoModel);
      if (opts.videoSeconds) args.push('--video-seconds', String(opts.videoSeconds));
    }

    const env = {
      ...process.env,
      // Python 侧优先读这两个，避免把 Key 写进命令行参数（ps 可见）
      PETFORGE_API_KEY: opts.apiKey || process.env.PETFORGE_API_KEY || '',
      PYTHONIOENCODING: 'utf-8',
      PYTHONUNBUFFERED: '1',
      HOME: os.homedir(),
    } as NodeJS.ProcessEnv;

    let out = '';
    let child;
    try {
      child = spawn(pythonBin(), args, { env, cwd: os.tmpdir() });
    } catch (e) {
      return resolve({ ok: false, error: `无法启动 Python：${(e as Error).message}` });
    }

    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      resolve({ ok: false, error: `生成超时（超过 ${Math.round(timeoutMs/60000)} 分钟），请稍后重试`, log: out.slice(-800) });
    }, timeoutMs);

    child.stdout?.on('data', (b: Buffer) => { out += b.toString('utf8'); });
    child.stderr?.on('data', (b: Buffer) => { out += b.toString('utf8'); });

    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, error: `Python 启动失败：${e.message}` });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        return resolve({ ok: true, name, log: out.slice(-1200) });
      }
      // 把 Python 的报错摘要给到界面
      const lines = out.split('\n').map((s) => s.trim()).filter(Boolean);
      const key = lines.find((l) => /缺少|API Key|error|Error|失败|invalid|rate/i.test(l));
      resolve({
        ok: false,
        error: key || lines.slice(-3).join(' ') || `生成失败（退出码 ${String(code)}）`,
        log: out.slice(-1200),
      });
    });
  });
}
