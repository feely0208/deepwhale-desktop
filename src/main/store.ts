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
   * 是否让 DSH 对局域网开门（手机连接）。**默认开启（2026-10-01 起）。**
   *
   * 为什么现在敢默认开：这个功能原来"做不全就是有害的" —— 只绑 0.0.0.0、却不给用户
   * 「地址 + token」的入口，等于只开门不发钥匙。现在三件事齐了：
   *   ① 绑 0.0.0.0 + 运行时探测本机地址写进 trustedHosts（换 WiFi 自动更新）；
   *   ② 桌面端有「手机连接…」入口，给出**带 token 的完整地址**（用户不用手打 token）；
   *   ③ 鉴权**保持开启** —— 同一 WiFi 下别人没有这个地址进不来。
   *
   * ⚠️ 保持鉴权开启是硬约束：0.0.0.0 意味着同网段可达，关掉 token 就等于把
   *    用户的会话记录和文件对同 WiFi 的所有人敞开。
   */
  lanAccess: boolean;
  /**
   * `lanAccess` 的一次性迁移标记。
   *
   * 为什么需要：1.0.25 引入 lanAccess 时默认 false，而 `store.save()` 会把**所有**设置
   * 写进 settings.json —— 所以升级上来的用户文件里已经存着 `lanAccess: false`，
   * 光改 DEFAULTS 不会生效。第一次读到旧文件时强制置为 true 并打上本标记，
   * 之后用户自己关掉就尊重他的选择（标记已在，不再强制）。
   */
  lanAccessMigrated: boolean;
  /**
   * 外网访问地址（用户自建的隧道/反向代理），例如 `https://xxx.example.org`。
   * 留空则「手机连接」只显示局域网地址。默认空 —— 不能替用户假设他有隧道。
   */
  publicUrl: string;
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
  // 默认开：三件事齐了（绑 0.0.0.0 + 运行时探测 trustedHosts + 桌面露出带 token 的地址），
  // 鉴权保持开启。见 Settings.lanAccess 的说明。
  lanAccess: true,
  // 一次性迁移标记：升级上来的用户文件里存着旧的 false，第一次读到要强制改成 true
  lanAccessMigrated: false,
  // 外网地址默认空 —— 不能替用户假设他配了隧道
  publicUrl: '',
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
      // 一次性迁移：1.0.25/1.0.26 存下来的 lanAccess=false 是老默认值，不是用户的选择 ——
      // 而 store.save() 会把所有设置写进文件，所以光改 DEFAULTS 对老用户无效。
      // 打上标记之后就不再强制，用户自己关掉会被尊重。
      if (!this.data.lanAccessMigrated) {
        this.data.lanAccess = true;
        this.data.lanAccessMigrated = true;
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
