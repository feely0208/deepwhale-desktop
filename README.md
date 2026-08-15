# DeepSeek Harness Desktop

> 把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的 Web UI 装进 Electron 原生窗口的跨平台桌面壳。
> Cross-platform desktop shell that wraps the DeepSeek Harness (DSH) web UI into a native Electron window.

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey)
![Electron](https://img.shields.io/badge/Electron-43-green)
![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen)

## 特性

- 🖥️ **原生窗口**：启动即拉起/复用本机 DSH 服务，退出时干净回收进程树（无孤儿 node 进程）；关窗口最小化到托盘
- 🎨 **背景皮肤**：选一张喜欢的图片完全覆盖原界面（深浅色模式都生效，不改变 DSH 基础深浅色外观），可见度可调、拓展到工作区栏并做渐变过渡
- 🐾 **桌面宠物**：帧动画精灵图（spritesheet）宠物，支持走路/快走/慢跑/快跑/电脑前工作/挥手/跳跃等动作；也支持自制 SVG/GIF/PNG 宠物与宠物工坊
- 💰 **用量与额度**：右下角面板 + DSH 设置页"用量"栏，展示余额/赠送/充值/今日请求/tokens，绿色进度条与低余额提醒
- 🔑 **API Key 安全**：`safeStorage`（系统钥匙串）加密存储，绝不落明文；或在设置页用量栏内嵌输入
- 📦 **三平台打包**：macOS `.dmg` / Windows `.nsis` / Linux `.AppImage`·`.deb`，GitHub Actions CI 已配置

> 参考社区项目 [anywhere-labs/deepseek-harness-desktop](https://github.com/anywhere-labs/deepseek-harness-desktop)（仅打包 mac/win），本项目壳从零编写并扩展以上功能。

## 快速开始

要求：Node.js ≥ 18（建议 ≥ 20）。

```bash
npm install
npm run dev        # 编译 + 启动（自动拉起或复用本机 DSH Web UI）
```

首次运行在 `userData/settings.json` 生成默认配置；若 3080 端口已有 DSH 在跑，直接复用，不会重复启动。

## 功能说明

### 背景皮肤（皮肤 = 背景图）
- 托盘菜单 → 皮肤 → **背景图片…** 选择图片，图片复制到 `userData/skins/`，data URI 内联（换图即时生效）
- 全窗口 cover 平铺，界面层自动半透明让图透出，背景可见度可调（30%~100%）
- 深浅色模式**都生效**：浅色提亮、深色压暗，只作用于背景图本身，**不改变 DSH 的基础深浅色外观**（在 DSH 通用设置里切换）
- 图片拓展到左侧工作区栏（该侧淡化 + 渐变过渡）

### 桌面宠物
- 内置 **AI小助理**（帧动画精灵图，192×208 格子、行=状态）：空闲呼吸、悬停挥手、点击跳跃、拖拽按速度走路/快走/慢跑/快跑、周期"电脑前工作"
- **帧动画宠物格式**：宠物目录放 `名字/` 文件夹（`manifest.json` + `spritesheet.png`）即可自动识别播放
- **自制宠物**：宠物工坊（SVG 实时编辑预览保存、导入图片自动去白底），或直接丢 `.gif`/`.svg`/`.png`/`.jpg`/`.webp` 到宠物目录
- 设置页 → 宠物 栏：预览、列表切换、显示/穿透开关、**动画帧率与大小滑块**

### 用量与额度
- 右下角可折叠面板 + DSH 设置页 → 用量 栏：总余额 / 赠送 / 充值 / 今日请求 / 累计 tokens
- 额度来源：官方接口 `GET https://api.deepseek.com/user/balance`；绿色进度条（余额充足度 + 额度构成）
- 低余额提醒（默认 ¥5 阈值）；默认每 5 分钟自动刷新，可手动刷新

### API Key 配置
- 两种入口，同一存储：托盘 → **设置 API Key…** 对话框，或 **设置页 → 用量** 栏内嵌输入框
- 加密：Electron `safeStorage`（系统钥匙串）；系统安全存储不可用时自动退化为混淆存储（不落明文）
- 也支持环境变量 `DEEPSEEK_API_KEY`（优先级最高，启动 DSH 时注入）
- 余额请求只在主进程发起，渲染层只接收脱敏数据

### 设置页集成
- 在 DSH 设置页左侧导航（通用设置/模型/插件/Agent 预设）下顺延注入 **宠物 / 用量 / 皮肤** 三个设置栏，与原生界面划一

## 配置（userData/settings.json）

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `command` | `npx @deepseek-ai/dsh web` | 拉起 DSH 的命令，可改为本地路径 |
| `port` | `3080` | DSH Web UI 端口 |
| `theme` | `system` | 原生界面主题（跟随系统/浅色/深色，由 nativeTheme 驱动） |
| `skinImage` | `null` | 背景皮肤图片文件名（userData/skins/ 下） |
| `skinOpacity` | `0.55` | 背景可见度（0.3~1） |
| `petVisible` | `true` | 宠物是否显示 |
| `petGif` | `AI小助理` | 当前宠物名 |
| `petFrameMs` | `130` | 帧动画宠物播放速度（毫秒/帧） |
| `petScale` | `1` | 宠物显示大小（0.6~2） |
| `clickThrough` | `false` | 宠物穿透点击 |
| `closeToTray` | `true` | 关窗口最小化到托盘 |
| `usagePanelVisible` | `true` | 用量面板显示 |
| `usageRefreshMinutes` | `5` | 余额刷新间隔（分钟） |
| `usageLowBalanceAlert` | `5` | 低余额提醒阈值（元） |
| `apiKeyEncrypted` | `null` | API Key（safeStorage 加密后 base64，勿手动改） |

## 开发

```bash
npm run build          # tsc 编译 + 复制静态资源到 dist/
npm run dev            # 构建并启动
npm run smoke          # 冒烟测试：自动启动、校验设置页注入、8 秒后退出（CI 可用）
npm run icons          # 重新生成图标
npm run dist:mac       # 打包 macOS dmg/zip
npm run dist:win       # 打包 Windows nsis（需 Windows 或 CI）
npm run dist:linux     # 打包 Linux AppImage/deb
```

### 目录结构

```
dsh-desktop/
├── src/
│   ├── main/                # 主进程模块
│   │   ├── index.ts         # 入口：装配各模块
│   │   ├── service-manager.ts  # 拉起/检测/回收 DSH 进程
│   │   ├── window.ts        # 主窗口 + 注入钩子
│   │   ├── skin-manager.ts  # 背景皮肤
│   │   ├── pet.ts           # 桌面宠物窗口 + 精灵图播放
│   │   ├── tray.ts          # 托盘 + 应用菜单
│   │   ├── usage-manager.ts # 用量/额度采集、刷新与提醒
│   │   ├── settings-inject.ts # 设置页三栏注入
│   │   └── store.ts         # JSON 设置读写
│   ├── preload/preload.ts   # 最小 IPC 桥（contextBridge）
│   ├── pet/                 # 宠物渲染页（canvas 精灵图播放）
│   ├── usage/               # 右下角用量面板
│   ├── settings/            # DSH 设置页扩展（宠物/用量/皮肤三栏）
│   ├── apikey/              # API Key 对话框
│   └── petstudio/           # 宠物工坊
├── assets/
│   ├── pets/                # 内置宠物（AI小助理 帧动画 + SVG 模板，首启复制到 userData/pets）
│   └── icons/               # 应用/托盘图标（npm run icons 生成）
└── scripts/                 # 构建辅助脚本
```

## 打包与 CI

- `electron-builder.yml` 已配置 mac（dmg/zip）、win（nsis）、linux（AppImage/deb）
- `.github/workflows/build.yml`：三平台矩阵构建，产出安装包上传为 Artifact
- 说明：跨平台二进制需在各自系统或 CI 上构建；正式发布建议配置 Apple Developer ID 签名与公证

## Roadmap

- [x] M1 骨架：Electron + TS、service-manager、主窗口、托盘
- [x] M2 背景皮肤：图片覆盖 + 深浅色自适应 + 工作区栏渐变
- [x] M3 宠物：帧动画精灵图 + 多动作 + 宠物工坊
- [x] M5 用量面板：余额接口 + 绿色进度条 + 低余额提醒
- [ ] M4 打包：三平台 CI 出包 + 签名公证
- [ ] 用量明细：DeepSeek 开放用量查询 API 后接入在线用量
- [ ] 设置项 UI 化（当前为 settings.json + 菜单 + DSH 设置页注入）

## 贡献

欢迎提交 Issue 与 PR。请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md)，保持模块职责单一、错误处理兜底、尽量不新增第三方依赖。

## 安全

API Key 相关处理见 [SECURITY.md](SECURITY.md)。

## License

[MIT](LICENSE)
