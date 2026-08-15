import { app, BrowserWindow, safeStorage } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { Store } from './store';

export interface BalanceInfo {
  currency: string;
  totalBalance: string;
  grantedBalance: string;
  toppedUpBalance: string;
}

export interface UsageSnapshot {
  /** 账号是否可用（is_available），null 表示尚未拉到数据 */
  available: boolean | null;
  balanceInfos: BalanceInfo[];
  fetchedAt: number | null;
  error: string | null;
  todayRequests: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  apiKeyConfigured: boolean;
  lowBalance: boolean;
}

interface DailyStats {
  date: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
}

/** 官方余额查询接口（留常量，便于未来替换/扩展） */
const BALANCE_URL = 'https://api.deepseek.com/user/balance';

/**
 * 用量与额度：
 * - 额度：官方 GET /user/balance，主进程 fetch，渲染层只拿脱敏展示数据；
 * - 用量：首版本地统计（解析 DSH 日志中的 token / 手动记录），在线明细接口留常量待接入；
 * - API Key：优先复用 DEEPSEEK_API_KEY 环境变量；手动填写用 safeStorage 加密，
 *   绝不明文写 settings.json、不打印日志、不在面板显示。
 */
export class UsageManager {
  private timer: NodeJS.Timeout | null = null;
  private snapshot: UsageSnapshot;
  private statsFile: string;
  private stats: DailyStats = { date: '', requests: 0, inputTokens: 0, outputTokens: 0 };
  private notifiedLowDate = '';

  constructor(
    private store: Store,
    private onUpdate: (s: UsageSnapshot) => void,
    private onLowBalance: (threshold: number) => void
  ) {
    this.statsFile = path.join(app.getPath('userData'), 'usage-stats.json');
    this.snapshot = this.emptySnapshot();
    this.loadStats();
  }

  get latest(): UsageSnapshot {
    return { ...this.snapshot };
  }

  start(): void {
    void this.refresh();
    const minutes = Math.max(1, this.store.get('usageRefreshMinutes'));
    this.timer = setInterval(() => void this.refresh(), minutes * 60_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** 解析 API Key：优先环境变量，其次 safeStorage 加密存储 */
  resolveApiKey(): string | null {
    const fromEnv = process.env.DEEPSEEK_API_KEY;
    if (fromEnv) return fromEnv;
    const enc = this.store.get('apiKeyEncrypted');
    if (enc && safeStorage.isEncryptionAvailable()) {
      try {
        return safeStorage.decryptString(Buffer.from(enc, 'base64'));
      } catch {
        return null;
      }
    }
    return null;
  }

  /** 手动设置 API Key（safeStorage 加密后入 store，绝不明文落盘） */
  setApiKey(key: string): void {
    if (!key) {
      this.store.set('apiKeyEncrypted', null);
      return;
    }
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('系统安全存储不可用，无法保存 API Key');
    }
    this.store.set('apiKeyEncrypted', safeStorage.encryptString(key).toString('base64'));
    void this.refresh();
  }

  /** 拉取余额（失败静默，下次定时/手动重试，不阻塞主流程） */
  async refresh(): Promise<void> {
    const key = this.resolveApiKey();
    this.snapshot.apiKeyConfigured = !!key;
    if (!key) {
      this.snapshot.error = '未配置 API Key（可设置环境变量 DEEPSEEK_API_KEY）';
      this.emit();
      return;
    }
    try {
      const res = await fetch(BALANCE_URL, {
        headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`余额接口 HTTP ${res.status}`);
      const data = (await res.json()) as {
        is_available?: boolean;
        balance_infos?: Array<{
          currency?: string;
          total_balance?: string;
          granted_balance?: string;
          topped_up_balance?: string;
        }>;
      };
      this.snapshot.available = data.is_available !== false;
      this.snapshot.balanceInfos = Array.isArray(data.balance_infos)
        ? data.balance_infos.map((b) => ({
            currency: b.currency ?? '?',
            totalBalance: b.total_balance ?? '0',
            grantedBalance: b.granted_balance ?? '0',
            toppedUpBalance: b.topped_up_balance ?? '0',
          }))
        : [];
      this.snapshot.error = null;
      this.snapshot.fetchedAt = Date.now();
      this.checkLowBalance();
      this.emit();
    } catch (e) {
      this.snapshot.error = e instanceof Error ? e.message : String(e);
      this.emit();
    }
  }

  /** 记录一次请求（含 token 用量，供面板展示本地累计） */
  recordUsage(inputTokens: number, outputTokens: number): void {
    this.ensureToday();
    this.stats.requests += 1;
    this.stats.inputTokens += Math.max(0, inputTokens);
    this.stats.outputTokens += Math.max(0, outputTokens);
    this.saveStats();
    this.snapshot.todayRequests = this.stats.requests;
    this.snapshot.totalInputTokens = this.stats.inputTokens;
    this.snapshot.totalOutputTokens = this.stats.outputTokens;
    this.emit();
  }

  /** 从 DSH 子进程日志行解析 token 统计（常见 JSON/日志格式兜底） */
  consumeLogLine(line: string): void {
    const input = this.matchNum(line, /("?(?:prompt|input)_tokens"?\s*[:=]\s*)(\d+)/i);
    const output = this.matchNum(line, /("?(?:completion|output)_tokens"?\s*[:=]\s*)(\d+)/i);
    const total = this.matchNum(line, /("?total_tokens"?\s*[:=]\s*)(\d+)/i);
    if (input >= 0 || output >= 0 || total >= 0) {
      this.recordUsage(input >= 0 ? input : total >= 0 ? total : 0, output >= 0 ? output : 0);
    }
  }

  /** 注入用量面板到主窗口（did-finish-load 后调用） */
  async applyPanel(win: BrowserWindow): Promise<void> {
    try {
      const css = fs.readFileSync(path.join(__dirname, '../usage/usage-panel.css'), 'utf-8');
      await win.webContents.insertCSS(css, { cssOrigin: 'author' });
    } catch (e) {
      console.error('[usage] 面板样式注入失败:', e);
    }
    try {
      const js = fs.readFileSync(path.join(__dirname, '../usage/usage-panel.js'), 'utf-8');
      await win.webContents.executeJavaScript(js);
    } catch (e) {
      console.error('[usage] 面板脚本注入失败:', e);
    }
    this.emit();
  }

  /** 隐藏面板（executeJavaScript 移除注入的 DOM） */
  async hidePanel(win: BrowserWindow): Promise<void> {
    try {
      await win.webContents.executeJavaScript(
        "const el = document.getElementById('dsh-usage-panel'); if (el) el.remove();"
      );
    } catch {
      // 页面未就绪，忽略
    }
  }

  private emit(): void {
    this.onUpdate(this.latest);
  }

  private checkLowBalance(): void {
    const threshold = this.store.get('usageLowBalanceAlert');
    const today = todayKey();
    const low = this.snapshot.balanceInfos.some((b) => {
      const v = parseFloat(b.totalBalance);
      return !Number.isNaN(v) && v < threshold;
    });
    this.snapshot.lowBalance = low;
    if (low && this.notifiedLowDate !== today) {
      this.notifiedLowDate = today;
      this.onLowBalance(threshold);
    }
  }

  private ensureToday(): void {
    const key = todayKey();
    if (this.stats.date !== key) {
      this.stats = { date: key, requests: 0, inputTokens: 0, outputTokens: 0 };
    }
  }

  private loadStats(): void {
    try {
      const raw = fs.readFileSync(this.statsFile, 'utf-8');
      const parsed = JSON.parse(raw) as DailyStats;
      this.stats = { date: parsed.date, requests: parsed.requests ?? 0, inputTokens: parsed.inputTokens ?? 0, outputTokens: parsed.outputTokens ?? 0 };
      this.ensureToday(); // 跨天自动清零
      this.snapshot.todayRequests = this.stats.requests;
      this.snapshot.totalInputTokens = this.stats.inputTokens;
      this.snapshot.totalOutputTokens = this.stats.outputTokens;
    } catch {
      this.ensureToday();
    }
  }

  private saveStats(): void {
    try {
      fs.mkdirSync(path.dirname(this.statsFile), { recursive: true });
      fs.writeFileSync(this.statsFile, JSON.stringify(this.stats, null, 2), 'utf-8');
    } catch (e) {
      console.error('[usage] 保存用量统计失败:', e);
    }
  }

  private matchNum(line: string, re: RegExp): number {
    const m = line.match(re);
    return m ? parseInt(m[2], 10) : -1;
  }

  private emptySnapshot(): UsageSnapshot {
    return {
      available: null,
      balanceInfos: [],
      fetchedAt: null,
      error: null,
      todayRequests: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      apiKeyConfigured: !!process.env.DEEPSEEK_API_KEY,
      lowBalance: false,
    };
  }
}

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}
