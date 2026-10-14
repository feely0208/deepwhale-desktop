import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { EventEmitter } from 'events';
import { applyProfileToCommandArgs, profileLaunchArgs } from './profile';

/**
 * 杀进程树：优先用 tree-kill；**缺这个模块也必须能启动**（2026-10-05 事故）
 *
 * 用户实测：Windows 1.0.52 启动即崩 ——
 *   `Error: Cannot find module 'tree-kill'`（require stack: dist/main/service-manager.js）
 * 顶层 `import kill from 'tree-kill'` 一旦解析失败，整个主进程直接退出，应用完全打不开。
 * 这是不可接受的失败模式：**为了"能杀掉子进程树"而让应用起不来**，本末倒置。
 * 现在改为惰性加载 + 兜底（直接 kill 子进程；Windows 再用 taskkill /T 兜一层）。
 */
type KillFn = (pid: number, signal: string, cb: (err?: Error) => void) => void;

let cachedKill: KillFn | null | undefined;

function loadTreeKill(): KillFn | null {
  if (cachedKill !== undefined) return cachedKill;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('tree-kill') as KillFn | { default?: KillFn };
    cachedKill = typeof mod === 'function' ? mod : (mod.default ?? null);
  } catch (e) {
    console.warn('[service] 未能加载 tree-kill（缺模块也不影响启动），改用兜底杀进程:', e);
    cachedKill = null;
  }
  return cachedKill;
}

/** 统一入口：tree-kill 不在时退化成单进程 kill（必要时 taskkill /T） */
function killTree(pid: number, signal: string): Promise<void> {
  return new Promise<void>((resolve) => {
    const kill = loadTreeKill();
    if (kill) {
      try {
        kill(pid, signal, () => resolve());
        return;
      } catch (e) {
        console.warn('[service] tree-kill 执行失败，改用兜底:', e);
      }
    }
    // 兜底 ①：Windows 上用 taskkill 连子孙一起杀
    if (process.platform === 'win32') {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { execFile } = require('child_process') as typeof import('child_process');
        execFile('taskkill', ['/pid', String(pid), '/T', '/F'], () => resolve());
        return;
      } catch {
        /* 落到下面 */
      }
    }
    // 兜底 ②：直接给进程发信号（至少把直接子进程收掉）
    try {
      process.kill(pid, signal as NodeJS.Signals);
    } catch {
      /* 进程已经没了 */
    }
    resolve();
  });
}

export interface ServiceOptions {
  /** DSH Web UI 端口 */
  port: number;
  /** 就绪探测超时（毫秒），默认 60s */
  timeoutMs?: number;
  /** 追加到子进程环境变量（如 DSH_HOME 指向应用专属 home） */
  env?: NodeJS.ProcessEnv;
  /** 子进程 stdout/stderr 行回调（供用量统计解析 token） */
  onLogLine?: (line: string) => void;
  /** 子进程退出回调 */
  onExit?: (code: number | null) => void;
  /**
   * 随包 DSH 运行时入口（`…/dsh-runtime/node_modules/@deepseek-ai/dsh/lib/bin.js`）。
   * 存在时优先用它：以 Electron 自带的 Node 拉起（ELECTRON_RUN_AS_NODE），
   * 用户机器上无需安装 Node.js、无需 npx、无需联网下载。
   */
  bundledBin?: string;
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
  private recentOutput: string[] = [];
  /** 是否已看到 DSH 自己打印的 `dsh web: http://…` 那行（= 它宣布"可服务"） */
  private sawBanner = false;
  /** 探测过几次（写进失败详情，替代"只能猜"） */
  private probeAttempts = 0;
  /** spawn 失败（ENOENT/EACCES 之类）—— 这种失败不该让用户等满整个超时 */
  private spawnError: Error | null = null;
  /**
   * 最近一次子进程退出码。**必须单独记**：`child.on('exit')` 会把 `this.child` 置 null，
   * 于是"提前退出"这件事在 `this.child.exitCode` 上永远读不到（老代码的隐性 bug）。
   */
  private lastExitCode: number | null = null;

  constructor(private command: string, private options: ServiceOptions) {
    super();
    this.port = options.port;
  }

  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  /**
   * 确保 DSH Web UI 就绪。已运行则直接返回；否则拉起并轮询等待。
   * @throws 超时/提前退出/spawn 失败时抛出，由调用方决定是否弹错误提示
   */
  async ensureReady(): Promise<void> {
    if (this.stopping) throw new Error('正在停止，无法启动服务');
    const ready = await this.isPortReady();
    if (ready) return; // 复用已有实例

    // ⚠️ 重试/二次启动前，先把上一个子进程收掉（2026-10-14 用户日志的形状）：
    //    原来这里直接 spawn，于是"重试"会在**同一个端口上再拉一个 DSH** ——
    //    后一个绑不上端口，前一个还在慢慢启动，日志里就会出现
    //    "URL 已经打印出来了、壳却报启动超时"这种自相矛盾的现场。
    await this.reapChildIfRunning();

    this.sawBanner = false;
    this.spawnError = null;
    this.lastExitCode = null;
    this.probeAttempts = 0;
    this.spawn();

    // 首次冷启动要过一遍杀软扫描（Windows 上尤其慢），60s 偏紧；90s 是"慢但还没死"的量级。
    const timeoutMs = this.options.timeoutMs ?? 90_000;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      // ⚠️ 这两个值由**异步回调**写入（child 的 error / exit 事件），
      //    TS 的控制流分析看不到那层写入，会把字段窄化成 null → 这里显式断言。
      const spawnErr = this.spawnError as Error | null;
      if (spawnErr !== null) {
        throw new Error(`无法启动 DSH：${spawnErr.message}`);
      }
      // ⚠️ 必须以 `lastExitCode` 判"提前退出"：`child.on('exit')` 会把 `this.child` 置 null，
      //    用 `this.child.exitCode` 判就**永远判不到**（这正是老代码里那句
      //    「DSH 进程提前退出」从来没生效过、只能干等满超时的原因）。
      const exitCode = this.lastExitCode as number | null;
      if (exitCode !== null) {
        throw new Error(`DSH 进程提前退出（exit code ${exitCode}）`);
      }
      this.probeAttempts += 1;
      if (await this.isPortReady()) return;
      // 第二条就绪信号：DSH 已经打印了 `dsh web: http://…`（它宣布可服务的那一刻）。
      // 2026-10-14 的日志里，这一行明明打出来了、壳却还在报"等待就绪超时" ——
      // 因为壳只有"端口探测"一条判据。这里给它补几次确认的机会就返回。
      if (this.sawBanner) {
        for (let i = 0; i < 4; i += 1) {
          if (await this.isPortReady()) return;
          await sleep(300);
        }
      }
      await sleep(500);
    }
    throw new Error(this.timeoutMessage());
  }

  /** 失败详情的诊断行（端口 / pid / 退出码 / 探测次数 / 是否见到 URL 行 / spawn 错误） */
  diagnostics(): string {
    const exitCode = this.lastExitCode as number | null;
    const spawnErr = this.spawnError as Error | null;
    return [
      `端口 ${this.port}`,
      `pid ${this.child?.pid ?? '无'}`,
      `退出码 ${exitCode ?? '未退出'}`,
      `探测 ${this.probeAttempts} 次`,
      `见到 dsh web 地址行：${this.sawBanner ? '是' : '否'}`,
      spawnErr !== null ? `spawn 错误：${spawnErr.message}` : '',
    ]
      .filter((s) => s !== '')
      .join(' · ');
  }

  private timeoutMessage(): string {
    // 文案分叉：随包运行时根本不需要 Node/npx，照抄那句只会把人带偏
    const head =
      this.options.bundledBin !== undefined
        ? 'DSH 服务启动超时：随包运行时已拉起，但端口始终没有应答'
        : 'DSH 服务启动超时（自定义启动命令）：请确认命令可执行、Node/npx 已安装';
    return `${head}。${this.diagnostics()}`;
  }

  /**
   * 收掉当前子进程（**不改 `stopping`**，因此之后还能再启动）。
   * 与 `stop()` 的区别：那是"整机停止、不再启动"，这是"重试前清场"。
   */
  private async reapChildIfRunning(): Promise<void> {
    const pid = this.child?.pid;
    if (pid === undefined || this.child?.exitCode !== null) {
      this.child = null;
      return;
    }
    await killTree(pid, 'SIGTERM');
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      if (this.child?.exitCode != null) break;
      await sleep(200);
    }
    if (this.child !== null && this.child.exitCode === null) {
      await killTree(pid, 'SIGKILL');
    }
    this.child = null;
  }

  /** 停止并回收进程树（幂等） */
  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;

    const pid = this.child?.pid;
    if (pid) {
      await killTree(pid, 'SIGTERM');
      // 等端口释放（优雅退出），超时强杀
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        if (!(await this.isPortReady())) break;
        await sleep(300);
      }
      if (this.child && this.child.exitCode === null) {
        await killTree(pid, 'SIGKILL');
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
    const env: NodeJS.ProcessEnv = { ...process.env };
    // 壳注入的环境变量（如 DSH_HOME）优先于继承来的环境
    if (this.options.env) Object.assign(env, this.options.env);

    // 随包 DSH 运行时优先：用户机器上无需 Node.js / npx / 联网
    if (this.options.bundledBin) {
      this.spawnBundled(env, this.options.bundledBin);
      return;
    }

    const parsed = parseCommand(this.command);
    const command = parsed.command;
    // 兜底命令（settings.command，通常是 `npx @deepseek-ai/dsh@x web --port …`）里
    // 那个裸的 profile 名要换成我们自己的 profile —— 否则 DSH 会启动到自带 `web`，
    // 而注入全写在 `profiles/<我们的>/`，插件会**静默失效**。详见 ./profile.ts。
    const applied = applyProfileToCommandArgs(parsed.args, this.options.env?.DSH_HOME);
    const args = applied.args;
    if (!applied.ok) {
      console.warn(
        '[service] 兜底命令没能保证使用自有 profile（命令里既没有可替换的自带 profile 名，' +
          '也没有 --profile）—— 插件注入可能不生效。建议把它写成 ' +
          '`… --profile deepwhale …`。',
      );
    }
    const resolved = resolveExecutable(command);
    // Windows 下 npx 常装在带空格的目录（如 C:\Program Files\nodejs\ 或 E:\Program Files\...），
    // 经 cmd（shell: true）执行时路径会被按空格截断（报错形如 'E:\Program' 不是内部或外部命令），
    // 因此路径含空格时必须给可执行文件整体加引号，否则 DSH 启动失败、端口就绪超时。
    const exec =
      process.platform === 'win32' && /\s/.test(resolved) ? `"${resolved}"` : resolved;
    // Finder 启动的 App PATH 极简（无 /usr/local/bin 等），npx 内部会再调 node 会失败。
    // 把可执行文件所在目录补进子进程 PATH（node 与 npx 通常同目录）。
    const exeDir = path.dirname(resolved);
    if (exeDir && exeDir !== '.') {
      env.PATH = env.PATH ? `${exeDir}:${env.PATH}` : exeDir;
    }
    console.log(`[service] 启动 DSH: ${this.command}（可执行文件: ${resolved}）`);
    this.child = spawn(exec, args, {
      env,
      // Windows 上 npx 是 .cmd，需要 shell 执行
      shell: process.platform === 'win32',
      // Windows 隐藏子进程窗口（避免弹出 cmd 黑窗口，DSH 后台静默运行）
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.attachChildHandlers();
  }

  /**
   * 用 Electron 自带的 Node 拉起随包 DSH 运行时（`ELECTRON_RUN_AS_NODE=1`）。
   * 安装包自带运行时，用户无需安装 Node.js、无需 npx、无需联网下载。
   */
  private spawnBundled(env: NodeJS.ProcessEnv, bin: string): void {
    env.ELECTRON_RUN_AS_NODE = '1';
    // `--expose-internals` 必须放在 Electron 自己的参数位（脚本路径之前）：
    // dsh-base 的 cordis.patch.yml 里 `hmr` 行在 web profile 下会被激活，而
    // cordis-plugin-hmr 的构造器要求 `ctx.loader.internal`，该属性只有当
    // process.execArgv 含 `--expose-internals` 时才由 loader 建立；否则整个
    // profile 加载失败、进程立刻退出（报 `--expose-internals is required for
    // HMR service`），壳这边表现为"DSH 服务启动失败"。Electron-as-Node 支持该开关。
    //
    // profile：不再用 DSH 自带的 `web`，而是我们自己的 profile（首启会带上
    // `--from-default-profile web` 从自带模板派生）。原因与两个硬约束见 ./profile.ts。
    const profileArgs = profileLaunchArgs(this.options.env?.DSH_HOME);
    const args = [
      '--expose-internals',
      bin,
      ...profileArgs,
      '--port',
      String(this.port),
      '--no-open',
    ];
    console.log(
      `[service] 启动随包 DSH 运行时（Electron 内置 Node）: ${bin}  profile=${profileArgs.join(' ')}`,
    );
    this.child = spawn(process.execPath, args, {
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.attachChildHandlers();
  }

  private attachChildHandlers(): void {
    const child = this.child;
    if (!child) return;
    child.stdout?.on('data', (chunk: Buffer) => this.handleOutput(chunk));
    child.stderr?.on('data', (chunk: Buffer) => this.handleOutput(chunk));
    child.on('exit', (code) => {
      console.log(`[service] DSH 进程退出（code ${code}）`);
      // 先记退出码再置空 child —— 否则"提前退出"这条判据永远读不到（见 lastExitCode 的说明）
      this.lastExitCode = code;
      this.child = null;
      this.options.onExit?.(code);
      this.emit('exit', code);
    });
    child.on('error', (err) => {
      // ⚠️ 必须记进 recentOutput：以前只 console.error，于是"DSH 启动失败"弹窗里的
      //    输出尾巴是**空的**（2026-10-04 09:54:55 那条日志就是），用户和我们都没线索。
      this.spawnError = err;
      this.recentOutput.push(`[spawn error] ${err.message}`);
      console.error(
        '[service] 启动 DSH 失败:',
        err,
        '（若从访达/Finder 启动找不到 npx，请在 settings.json 把 command 改为绝对路径，如 /usr/local/bin/npx @deepseek-ai/dsh web）'
      );
      // ⚠️ 必须在有监听者时才 emit：EventEmitter 的 `error` 事件**没有监听者会直接抛**
      //    （`Unhandled 'error' event`）→ 主进程崩掉。而这条路径正是"用户把启动命令写错 /
      //    Finder 启动找不到 npx"的现场，2026-10-14 实测：壳里没有任何 `service.on('error')`。
      //    失败信息本身已经通过 spawnError + recentOutput 交给 ensureReady 与失败弹窗了，
      //    这里只做"有人要才发"。
      if (this.listenerCount('error') > 0) this.emit('error', err);
    });
  }

  private handleOutput(chunk: Buffer): void {
    const text = chunk.toString('utf-8');
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      // DSH 打印 `dsh web: http://127.0.0.1:<port>/?token=…` 的那一刻，服务已经能应答 ——
      // 把这行当**第二条就绪信号**（见 ensureReady 里的说明）。
      if (/^dsh web:\s*https?:\/\//.test(trimmed)) this.sawBanner = true;
      this.recentOutput.push(trimmed);
      if (this.recentOutput.length > 50) this.recentOutput.shift();
      this.options.onLogLine?.(trimmed);
    }
  }

  /** 最近 20 行子进程输出（用于"DSH 启动失败"弹窗定位问题） */
  lastOutput(): string {
    return this.recentOutput.slice(-20).join('\n');
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
