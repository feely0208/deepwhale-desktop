import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

/**
 * 应用设置（极简 JSON store）。
 * 原则：settings.json 只存非敏感设置；API Key 等敏感信息用 safeStorage 加密后
 * 以 base64 存入 apiKeyEncrypted 字段（见 usage-manager.ts）。
 */
export interface Settings {
  /** 拉起 DSH 的命令，可覆盖为本地路径/自定义命令 */
  command: string;
  /** DSH Web UI 端口 */
  port: number;
  /** 原生界面主题：跟随系统 / 浅色 / 深色 */
  theme: 'system' | 'light' | 'dark';
  /** 背景皮肤图片文件名（userData/skins/ 下），null 表示无背景皮肤 */
  skinImage: string | null;
  /** 背景皮肤可见度（0.3~1，界面层透明度；越小图越透出） */
  skinOpacity: number;
  /** 是否启用 userData/custom.css 自定义样式 */
  customCssEnabled: boolean;
  /** 桌面宠物是否显示 */
  petVisible: boolean;
  /** 桌面宠物：当前宠物名（默认 AI小助理 帧动画宠物） */
  petGif: string | null;
  /** 帧动画宠物播放速度（每帧毫秒） */
  petFrameMs: number;
  /** 宠物显示大小（0.6~2 倍，窗口尺寸） */
  petScale: number;
  /** 宠物窗口穿透点击 */
  clickThrough: boolean;
  /** 关主窗口时最小化到托盘而非退出 */
  closeToTray: boolean;
  /** 用量面板是否显示 */
  usagePanelVisible: boolean;
  /** 余额拉取间隔（分钟） */
  usageRefreshMinutes: number;
  /** 低余额提醒阈值（元，按币种比较） */
  usageLowBalanceAlert: number;
  /** 手动填写的 API Key（safeStorage 加密后的 base64），null 表示未设置 */
  apiKeyEncrypted: string | null;
}

const DEFAULTS: Settings = {
  command: 'npx @deepseek-ai/dsh web',
  port: 3080,
  theme: 'system',
  skinImage: null,
  skinOpacity: 0.55,
  customCssEnabled: false,
  petVisible: true,
  petGif: 'AI小助理',
  petFrameMs: 130,
  petScale: 1,
  clickThrough: false,
  closeToTray: true,
  usagePanelVisible: true,
  usageRefreshMinutes: 5,
  usageLowBalanceAlert: 5,
  apiKeyEncrypted: null,
};

export class Store {
  private file: string;
  private data: Settings;
  private writeTimer: NodeJS.Timeout | null = null;

  constructor() {
    this.file = path.join(app.getPath('userData'), 'settings.json');
    this.data = { ...DEFAULTS };
    this.load();
  }

  private load(): void {
    try {
      const raw = fs.readFileSync(this.file, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<Settings>;
      this.data = { ...DEFAULTS, ...parsed };
      // 旧版本兼容：skin 字段迁移为 theme
      if ('skin' in parsed && !('theme' in parsed)) {
        this.data.theme = 'system';
      }
    } catch {
      // 首次运行或文件损坏：使用默认值
    }
  }

  get<K extends keyof Settings>(key: K): Settings[K] {
    return this.data[key];
  }

  getAll(): Settings {
    return { ...this.data };
  }

  set<K extends keyof Settings>(key: K, value: Settings[K]): void {
    this.data[key] = value;
    this.scheduleSave();
  }

  /** 同步落盘（退出前调用，确保设置保存） */
  save(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf-8');
    } catch (e) {
      console.error('[store] 保存设置失败:', e);
    }
  }

  private scheduleSave(): void {
    if (this.writeTimer) clearTimeout(this.writeTimer);
    this.writeTimer = setTimeout(() => this.save(), 300);
  }
}
