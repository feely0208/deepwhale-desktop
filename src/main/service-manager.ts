import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import kill from 'tree-kill';
import { EventEmitter } from 'events';

export interface ServiceOptions {
  /** DSH Web UI 端口 */
  port: number;
  /** 就绪探测超时（毫秒），默认 60s */
  timeoutMs?: number;
  /** 子进程 stdout/stderr 行回调（供用量统计解析 token） */
  onLogLine?: (line: string) => void;
  /** 子进程退出回调 */
  onExit?: (code: number | null) => void;
}

/**
 * DSH 进程生命周期管理：
 * - 启动时先探测端口，已就绪则复用（不重复拉起）；
 * - 否则 spawn 配置命令（默认 `npx @deepseek-ai/dsh web`）；
 * - 退出时用 tree-kill 杀掉整棵进程树，避免 npx 派生出的 node 孤儿进程。
 */
export class ServiceManager extends EventEmitter {
  private child: ChildProcess | null = null;
  private stopping = false;
  private port: number;

  constructor(private command: string, private options: ServiceOptions) {
    super();
    this.port = options.port;
  }

  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  /**
   * 确保 DSH Web UI 就绪。已运行则直接返回；否则拉起并轮询等待。
   * @throws 超时未就绪时抛出，由调用方决定是否弹错误提示
   */
  async ensureReady(): Promise<void> {
    if (this.stopping) throw new Error('正在停止，无法启动服务');
    if (await this.isPortReady()) return; // 复用已有实例

    this.spawn();
    const timeoutMs = this.options.timeoutMs ?? 60_000;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.child && this.child.exitCode !== null) {
        throw new Error(`DSH 进程提前退出（exit code ${this.child.exitCode}）`);
      }
      if (await this.isPortReady()) return;
      await sleep(500);
    }
    throw new Error('等待 DSH Web UI 就绪超时（请确认 Node/npx 已安装，或检查自定义命令）');
  }

  /** 停止并回收进程树（幂等） */
  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;

    const pid = this.child?.pid;
    if (pid) {
      await new Promise<void>((resolve) => kill(pid, 'SIGTERM', () => resolve()));
      // 等端口释放（优雅退出），超时强杀
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        if (!(await this.isPortReady())) break;
        await sleep(300);
      }
      if (this.child && this.child.exitCode === null) {
        await new Promise<void>((resolve) => kill(pid, 'SIGKILL', () => resolve()));
      }
    }
    this.child = null;
  }

  /** 探测端口是否已有 Web 服务（任意 HTTP 响应即视为就绪） */
  private isPortReady(): Promise<boolean> {
    return new Promise((resolve) => {
      const req = http.get(
        { host: '127.0.0.1', port: this.port, path: '/', timeout: 2000 },
        (res) => {
          res.resume();
          resolve(true);
        }
      );
      req.on('timeout', () => {
        req.destroy();
        resolve(false);
      });
      req.on('error', () => resolve(false));
    });
  }

  private spawn(): void {
    const { command, args } = parseCommand(this.command);
    const resolved = resolveExecutable(command);
    const env: NodeJS.ProcessEnv = { ...process.env };
    console.log(`[service] 启动 DSH: ${this.command}（可执行文件: ${resolved}）`);
    this.child = spawn(resolved, args, {
      env,
      // Windows 上 npx 是 .cmd，需要 shell 执行
      shell: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    this.child.stdout?.on('data', (chunk: Buffer) => this.handleOutput(chunk));
    this.child.stderr?.on('data', (chunk: Buffer) => this.handleOutput(chunk));
    this.child.on('exit', (code) => {
      console.log(`[service] DSH 进程退出（code ${code}）`);
      this.child = null;
      this.options.onExit?.(code);
      this.emit('exit', code);
    });
    this.child.on('error', (err) => {
      console.error(
        '[service] 启动 DSH 失败:',
        err,
        '（若从访达/Finder 启动找不到 npx，请在 settings.json 把 command 改为绝对路径，如 /usr/local/bin/npx @deepseek-ai/dsh web）'
      );
      this.emit('error', err);
    });
  }

  private handleOutput(chunk: Buffer): void {
    const text = chunk.toString('utf-8');
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed) this.options.onLogLine?.(trimmed);
    }
  }
}

/** 极简命令解析：按空白拆分（Windows 由 shell 处理，无需引号逻辑） */
function parseCommand(cmd: string): { command: string; args: string[] } {
  const parts = cmd.trim().split(/\s+/).filter(Boolean);
  return { command: parts[0] ?? 'npx', args: parts.slice(1) };
}

/**
 * 解析可执行文件绝对路径。
 * Finder 启动的 App PATH 极简（/usr/bin:/bin:/usr/sbin:/sbin），
 * npx 常装在 /usr/local/bin 或 ~/.nvm 下，这里做 PATH 搜索 + 常见位置兜底。
 */
function resolveExecutable(command: string): string {
  if (command.includes('/') || command.includes('\\')) return command;

  const pathDirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const exts = process.platform === 'win32' ? ['', '.cmd', '.exe', '.bat'] : [''];
  for (const dir of pathDirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, command + ext);
      try {
        if (fs.existsSync(candidate)) return candidate;
      } catch {
        // 目录不可读，继续
      }
    }
  }

  if (command === 'npx') {
    const home = os.homedir();
    // ~/.nvm/versions/node/<ver>/bin/npx（取最新版本）
    try {
      const nvmDir = path.join(home, '.nvm', 'versions', 'node');
      if (fs.existsSync(nvmDir)) {
        const versions = fs.readdirSync(nvmDir).sort().reverse();
        for (const v of versions) {
          const c = path.join(nvmDir, v, 'bin', 'npx');
          if (fs.existsSync(c)) return c;
        }
      }
    } catch {
      // ignore
    }
    for (const c of ['/usr/local/bin/npx', '/opt/homebrew/bin/npx', '/usr/bin/npx']) {
      if (fs.existsSync(c)) return c;
    }
  }
  return command; // 原样返回，让 spawn 报 ENOENT
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
