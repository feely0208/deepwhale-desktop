/**
 * 手机连接面板（桌面端）——「开启手机访问」+ 二维码
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么从"弹框给地址"改成窗口（2026-10-16）
 * ──────────────────────────────────────────────────────────────────────
 * 以前的「手机连接」是一个 messageBox：给用户一串局域网地址 + token，让他自己去配。
 * 结果就是官方指南里那句实话 ——「转发层与认证要你自己处理」。第三方（Whaleness）用
 * "桌面出二维码 → 手机扫码"把这一步做成 10 秒，我们不能再让用户自己配。
 *
 * 现在：壳里直接跑一个**只监局域网的网关**（src/main/mobile-gateway.ts），
 * 面板负责开关 + 出二维码；配对码一次性、5 分钟有效；关闭面板/应用即停服。
 *
 * 安全边界（三条都要记住）
 *   ① 网关只在用户点「开启」后才监听；② 只监局域网地址，不监听公网；
 *   ③ 必须带令牌才能访问（无令牌 401，且有断言守着）；DSH 的凭据留在网关内、不下发手机。
 */

import { BrowserWindow, app, clipboard, ipcMain, shell } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { startMobileGateway, qrSvg, pairPayload, detectLanHost } from './mobile-gateway';
import { startMobileTunnel, makeTunnelSecret } from './mobile-tunnel';
import type { TunnelHandle } from './mobile-tunnel';
import type { GatewayHandle } from './mobile-gateway';

let panel: BrowserWindow | null = null;

/**
 * 记住上次用的网关端口。
 *
 * 为什么必须记住（2026-10-18 真机踩到）：网关每次开随机端口 → 手机里存的地址下次就失效 ✗
 * → 每次重启应用都要重新配对一次（用户被迫反复操作）。记住端口后，手机端不用重配。
 */
function portFile(): string {
  try {
    return path.join(app.getPath('userData'), 'mobile-gateway.json');
  } catch {
    return '';
  }
}
/** 上次使用的令牌（与端口一起持久化：否则重启后手机存的令牌失效 → 每次都要重新配对） */
let gatewaySessionToken: string | null = null;
function lastGatewayToken(): string | null {
  try {
    const f = portFile();
    if (!f || !fs.existsSync(f)) return null;
    const t = JSON.parse(fs.readFileSync(f, 'utf8'))?.token;
    return typeof t === 'string' && t.length >= 16 ? t : null;
  } catch {
    return null;
  }
}
function lastTunnelSecret(): string | null {
  try {
    const f = portFile();
    if (!f || !fs.existsSync(f)) return null;
    const sec = JSON.parse(fs.readFileSync(f, 'utf8'))?.secret;
    return typeof sec === 'string' && sec.length >= 16 ? sec : null;
  } catch {
    return null;
  }
}

/** 记下密钥（与 port/token 同一个文件，免得又多一个状态文件） */
function rememberTunnelSecret(secret: string): void {
  try {
    const f = portFile();
    if (!f) return;
    const cur = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {};
    fs.writeFileSync(f, JSON.stringify({ ...cur, secret, updatedAt: new Date().toISOString() }, null, 2));
  } catch {
    /* 记不住就下次换新隧道 ID（手机会需要重新填地址） */
  }
}

function lastGatewayPort(): number | null {
  try {
    const f = portFile();
    if (!f || !fs.existsSync(f)) return null;
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    const p = Number(j?.port);
    return Number.isInteger(p) && p > 1024 && p < 65536 ? p : null;
  } catch {
    return null;
  }
}
function gatewayEnabled(): boolean {
  try {
    const f = portFile();
    if (!f || !fs.existsSync(f)) return false;
    return JSON.parse(fs.readFileSync(f, 'utf8'))?.enabled === true;
  } catch {
    return false;
  }
}

/** 记住「上次是否开着手机访问」—— 应用重启后自动恢复，用户不用每次手点 ✗ */
function rememberEnabled(enabled: boolean): void {
  try {
    const f = portFile();
    if (!f) return;
    const cur = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {};
    fs.writeFileSync(f, JSON.stringify({ ...cur, enabled, updatedAt: new Date().toISOString() }, null, 2));
  } catch {
    /* 记不住就下次不自动开（不影响手动开） */
  }
}

function rememberPairCode(code: string): void {
  try {
    const f = portFile();
    if (!f) return;
    const cur = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {};
    fs.writeFileSync(f, JSON.stringify({ ...cur, pairCode: code, pairCodeAt: Date.now() }, null, 2));
  } catch {
    /* 记不住不影响配对 */
  }
}

function rememberGatewayPort(port: number): void {
  try {
    const f = portFile();
    // ⚠️ 必须保留已有字段（尤其 secret）：之前只写 {port, token} 会把 secret 覆盖掉 →
    //    每次重启隧道 ID 都变 → 手机里的远程地址失效（用户实测被迫重填）。
    const cur = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {};
    fs.writeFileSync(f, JSON.stringify({ ...cur, port, token: gatewaySessionToken ?? '', updatedAt: new Date().toISOString() }, null, 2));
  } catch {
    /* 记不住不影响使用，只是下次要重新配对 */
  }
}
let gateway: GatewayHandle | null = null;
/** 外面用的固定地址（Cloudflare 隧道指向本机网关；地址固定、重启不变） */
const CLOUDFLARE_ORIGIN = 'https://mnkuil8bitiy.deepwhale.org';
/** 在外面用的隧道（随网关启停；手机连中继再回到本机） */
let tunnel: TunnelHandle | null = null;
/** 拿 DSH 的地址与令牌（由 index.ts 注入：只有那里知道 service-manager 的实例） */
let resolveDshEndpoint: (() => { base: string; token: string } | null) | null = null;

/** 注册 IPC 与依赖注入（在 app ready 之后调用一次） */
/** 开网关+隧道（IPC 与「自动开启」共用） */
async function startGatewayInternal(): Promise<Record<string, unknown>> {
    if (gateway) {
    // 已开着时也把配对码写进状态文件（否则自动化/排障读不到码 ✗）
    rememberPairCode(gateway.session.pairCode);
    return { ok: true, already: true, ...sessionInfo() };
    }
    const ep = resolveDshEndpoint?.() ?? null;
    if (!ep) {
    return { ok: false, reason: 'dsh-not-ready' };
    }
    try {
    const remembered = lastGatewayPort();
    const rememberedToken = lastGatewayToken() ?? undefined;
    try {
      gateway = await startMobileGateway({ dshBase: ep.base, dshToken: ep.token, port: remembered ?? undefined, token: rememberedToken });
    } catch (e) {
      // 上次的端口被别的程序占了 → 回落到随机端口（这次记新端口）
      if (remembered) gateway = await startMobileGateway({ dshBase: ep.base, dshToken: ep.token, token: rememberedToken });
      else throw e;
    }
    gatewaySessionToken = gateway.session.token;
    const gwPort = gateway.session.origin ? Number(new URL(gateway.session.origin).port) : 0;
    rememberGatewayPort(gwPort);
    // 隧道：手机在外面用（连中继 → 回到本机网关）。密钥持久化，重启后隧道 ID 不变。
    try {
      const secret = lastTunnelSecret() ?? makeTunnelSecret();
      rememberTunnelSecret(secret);
      tunnel = startMobileTunnel({
        gatewayPort: gwPort,
        secret,
        onLog: (line) => console.log(line),
      });
    } catch (e) {
      console.log('[mobile-panel] 隧道启动失败（不影响局域网使用）:', String((e as Error)?.message ?? e));
    }
    if (panel && !panel.isDestroyed()) panel.webContents.send('mobile:state', { running: true, ...sessionInfo() });
    return { ok: true, ...sessionInfo() };
    } catch (e) {
    gateway = null;
    return { ok: false, reason: 'start-failed', error: String((e as Error)?.message ?? e) };
    }
}

/**
 * 应用启动时自动开启手机访问（**如果上次是开着的**）。
 *
 * 为什么需要：以前每次重启都要手点「开启手机访问」✗ —— 用户出门忘了点，
 * 手机上就什么都连不上（用户原话："如果忘记扫码，那出门不是白搭了嘛"）。
 * 现在：开关状态持久化 + 启动自愈 → 一次开启，之后重启自动恢复 ✓。
 *
 * @returns 是否真的启动了（false = 上次是关着的，或 DSH 一直没就绪）
 */
export async function autoStartMobileGateway(): Promise<boolean> {
  if (!gatewayEnabled()) return false;
  if (gateway) return true;
  // DSH 就绪需要时间（壳要先拉起 DSH 再拿到 token）→ 最多等 30 秒
  for (let i = 0; i < 30; i += 1) {
    const ep = resolveDshEndpoint?.() ?? null;
    if (ep) {
      try {
        const r = await startGatewayInternal();
        return r?.ok === true;
      } catch (e) {
        console.log('[mobile-panel] 自动开启失败:', String((e as Error)?.message ?? e));
        return false;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  console.log('[mobile-panel] 自动开启跳过：DSH 30 秒内未就绪');
  return false;
}

export function initMobilePanel(getEndpoint: () => { base: string; token: string } | null): void {
  resolveDshEndpoint = getEndpoint;

  ipcMain.handle('mobile:status', () => ({
    running: gateway !== null,
    origin: gateway?.session.origin ?? null,
    pairCode: gateway?.session.pairCode ?? null,
    lanHint: detectLanHost(),
  }));

  ipcMain.handle('mobile:start', async () => startGatewayInternal());

  ipcMain.handle('mobile:stop', async () => {
    if (!gateway) return { ok: true, already: true };
    rememberEnabled(false);
    try {
      tunnel?.stop();
      tunnel = null;
    } catch {
      /* 隧道停止失败不影响网关停止 */
    }
    try {
      await gateway.stop();
    } catch {
      /* 停服失败也让状态归零，避免"以为在跑" */
    }
    gateway = null;
    if (panel && !panel.isDestroyed()) panel.webContents.send('mobile:state', { running: false });
    return { ok: true };
  });

  ipcMain.handle('mobile:rotate', () => {
    if (!gateway) return { ok: false, reason: 'not-running' };
    gateway.rotate();
    rememberPairCode(gateway.session.pairCode);
    return { ok: true, ...sessionInfo() };
  });

  ipcMain.handle('mobile:copy', (_e, text: string) => {
    clipboard.writeText(String(text ?? ''));
    return { ok: true };
  });

  ipcMain.handle('mobile:open-external', (_e, url: string) => {
    // 只允许 http(s)，避免把奇怪协议丢给系统
    if (/^https?:\/\//i.test(String(url))) void shell.openExternal(String(url));
  });
}

function sessionInfo(): { origin: string; pairCode: string; qr: string; payload: string; remoteOrigin: string; tunnelConnected: boolean } {
  if (!gateway) return { origin: '', pairCode: '', qr: '', payload: '', remoteOrigin: '', tunnelConnected: false };
  const s = gateway.session;
  const payload = pairPayload(s);
  return {
    origin: s.origin,
    pairCode: s.pairCode,
    qr: qrSvg(payload),
    payload,
    // 在外面用的地址（同一套配对码/令牌，只是入口换成中继）
    remoteOrigin: tunnel?.remoteOrigin ?? '',
    tunnelConnected: tunnel?.connected() ?? false,
  };
}

/** 打开（或聚焦）面板窗口 */
export function showMobilePanel(): void {
  if (panel && !panel.isDestroyed()) {
    panel.show();
    panel.focus();
    panel.webContents.send('mobile:state', { running: gateway !== null, ...sessionInfo() });
    return;
  }
  panel = new BrowserWindow({
    width: 460,
    height: 620,
    resizable: true,
    minimizable: false,
    maximizable: false,
    title: '手机连接',
    autoHideMenuBar: true,
    backgroundColor: '#0f1115',
    webPreferences: {
      preload: path.join(__dirname, '../preload/mobile-panel-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  panel.on('closed', () => {
    panel = null;
  });
  void panel.loadFile(path.join(__dirname, '../mobile-panel/index.html'));
}

/** 应用退出时收掉网关（否则端口留着、别人还能连） */
export async function disposeMobileGateway(): Promise<void> {
  try {
    tunnel?.stop();
  } catch {
    /* 退出路径不阻塞 */
  }
  tunnel = null;
  if (!gateway) return;
  try {
    await gateway.stop();
  } catch {
    /* 退出路径不阻塞 */
  }
  gateway = null;
}

/** 供测试/诊断：当前网关是否在跑 */
export function mobileGatewayRunning(): boolean {
  return gateway !== null;
}
