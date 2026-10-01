import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { DSH_RUNTIME_VERSION } from './dsh-version.generated';
import { PROFILE_NAME } from './profile';

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
  /**
   * 是否让 DSH 对局域网开门（手机连接）。
   *
   * **默认关闭，且目前没有界面入口。** 原因不是功能做不出来，而是做不全就是有害的：
   * 只把 DSH 绑到 0.0.0.0、却不给用户「地址 + token」的入口（用户从来没见过 token），
   * 等于只开门、不发钥匙 —— 用户拿不到任何好处，却平白让同 WiFi 下的其他人多了一个入口。
   *
   * 用户已明确叫停手机端方向（见 2026-09-30 交接文档第五节），要求「要做就一次做全」：
   * 绑 0.0.0.0 + 运行时探测地址 + 桌面端露出地址/token + 发正式版，缺一个用户就用不了。
   * 接口在 src/main/mobile-connect.ts 里是现成的、测过的，等那三步齐了再把这里改成 true。
   */
  lanAccess: boolean;
  /** 原生界面主题：跟随系统 / 浅色 / 深色 */
  theme: 'system' | 'light' | 'dark';
  /** 背景皮肤图片文件名（userData/skins/ 下），null 表示无背景皮肤 */
  skinImage: string | null;
  /**
   * 内置背景预设（纯 CSS 画的，不需要图片文件）。
   * 设了它、又没设 skinImage 时用它；设了图片则以图片为准。
   *
   * 为什么要有：用户看了官方 harness 官网（deepseek.com/harness）的深蓝辉光背景，
   * 明确说"我很喜欢，能做成新版深鲸壳的默认背景吗"。那个背景不是图片，
   * 是三层带模糊的径向渐变（#1A3870 / #2D5F9E / #4A8AC4）——
   * 用 CSS 复刻的好处是**任意分辨率都清晰、零字节、不用下载**。
   */
  skinPreset: 'none' | 'deepseek-blue';
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
  /** 退出应用时是否保留 DSH 服务（保留则下次启动秒开，不保留则退出时回收） */
  keepDshRunning: boolean;
  /** 余额拉取间隔（分钟） */
  usageRefreshMinutes: number;
  /** 低余额提醒阈值（元，按币种比较） */
  usageLowBalanceAlert: number;
  /** 手动填写的 API Key（safeStorage 加密后的 base64），null 表示未设置 */
  apiKeyEncrypted: string | null;
  /**
   * 是否已完成首次启动引导。
   * 仅在**全新安装的第一次**弹引导；老用户升级时 settings.json 已存在，
   * 主进程据文件存在性直接跳过，不依赖本字段（本字段是第二道保险）。
   */
  onboarded: boolean;
}

const DEFAULTS: Settings = {
  // 钉住 harness 版本：法律模式联动的插件按该版本的客户端 API 实测通过，不随上游漂移。
  // 版本号唯一的出处是仓库根目录的 dsh-runtime.version（见 scripts/dsh-runtime-version.js），
  // 别在这里手写 —— 手写就会出现「CI 装的是 A 版、开发机兜底命令是 B 版」的分裂。
  // profile：用我们自己的（不写 DSH 自带的 `web`）。首启时壳会自动补
  // `--from-default-profile web` 把 profile 从自带模板派生出来，见 src/main/profile.ts。
  // 老用户 settings.json 里存着的旧默认串（结尾是裸 `web`）也会被壳改写，无需手工迁移。
  command: `npx @deepseek-ai/dsh@${DSH_RUNTIME_VERSION} --profile ${PROFILE_NAME} --port 3095 --no-open`,
  port: 3095,
  // 默认关：见 Settings.lanAccess 的说明 —— 手机端没一次做全之前不能开
  lanAccess: false,
  theme: 'system',
  skinImage: null,
  skinPreset: 'deepseek-blue',
  skinOpacity: 0.55,
  customCssEnabled: false,
  petVisible: true,
  petGif: 'AI小助理',
  petFrameMs: 130,
  petScale: 1,
  clickThrough: false,
  closeToTray: true,
  usagePanelVisible: true,
  keepDshRunning: true,
  usageRefreshMinutes: 5,
  usageLowBalanceAlert: 5,
  apiKeyEncrypted: null,
  onboarded: false,
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
