# DeepWhale Desktop（深鲸桌面）

> 把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的 Web UI 装进 Electron 原生窗口的跨平台桌面壳。
> Cross-platform desktop shell that wraps the DeepSeek Harness (DSH) web UI into a native Electron window.

[English](README.en.md) · **中文**

> 🏠 [项目主页](https://feely0208.github.io/deepwhale-desktop) · [下载 Releases](https://github.com/feely0208/deepwhale-desktop/releases)

![Free Forever](https://img.shields.io/badge/永久免费-forever-brightgreen)
![Open Source](https://img.shields.io/badge/开源-Open%20Source-4CAF50)
![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey)
![Electron](https://img.shields.io/badge/Electron-43-green)
![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen)

## ✨ 永久免费 · 开源 · 无套路

- 💯 **永久免费**：软件本身完全免费——无内购、无订阅、无广告、无隐藏收费，而且会一直保持
- 🌍 **开源透明**：全部源码在 GitHub 公开（MIT），可审计、可提 PR、可自由二次开发
- 🔒 **数据自主**：API Key 由系统钥匙串加密存储在本机，余额直连 DeepSeek 官方接口，无第三方中转
- 🚫 **拒绝倒卖**：如果有人向您以任何形式出售此软件，请拒绝交易并告诉我们

## 特性

- 🖥️ **原生窗口**：启动即拉起/复用本机 DSH 服务，退出时干净回收进程树（无孤儿 node 进程）；关窗口最小化到托盘
- 🎨 **背景皮肤**：选一张喜欢的图片完全覆盖原界面（深浅色模式都生效，不改变 DSH 基础深浅色外观），可见度可调、拓展到工作区栏并做渐变过渡
- 🐾 **桌面宠物**：帧动画精灵图（spritesheet）宠物，支持走路/快走/慢跑/快跑/电脑前工作/挥手/跳跃等动作；也支持自制 SVG/GIF/PNG 宠物与宠物工坊
- 💰 **用量与额度**：右下角面板 + DSH 设置页"用量"栏，展示余额/赠送/充值/今日请求/tokens，绿色进度条与低余额提醒
- 🔑 **API Key 安全**：`safeStorage`（系统钥匙串）加密存储，绝不落明文；或在设置页用量栏内嵌输入
- 📦 **三平台打包**：macOS `.dmg` / Windows `.nsis` / Linux `.AppImage`·`.deb`，GitHub Actions CI 已配置


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
- ⚠️ **启用用量监测需先配置 API Key**：在"设置 → 用量"栏输入 `sk-...` 并点 **保存 Key**（或在 DSH 设置页任意位置填入 `sk-` 开头的 Key，失焦后自动同步）。未配置时余额/用量面板显示"—"不可用，**不影响 DSH 本身正常使用**
- 🔍 **为什么需要 Key**：余额/用量数据来自 DeepSeek **官方接口** `api.deepseek.com`，官方接口要求用**你自己的 Key** 认证——不是应用收集密钥。Key 用系统钥匙串加密存储在本机，只直连 DeepSeek 官方接口，**源码完全公开可审计**（见 [SECURITY.md](SECURITY.md)）

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

- `electron-builder.yml` 已配置 mac（dmg/zip）、win（nsis）、linux（AppImage/deb）；产物命名带版本与架构，发布目标为 GitHub Releases 草稿
- `.github/workflows/build.yml`：三平台矩阵构建（PR/推送），产出安装包上传为 Artifact
- `.github/workflows/release.yml`：推送 `v*` 标签自动三平台打包并发布 **Draft Release**（人工确认后公开），详见 [RELEASING.md](RELEASING.md)
- macOS 正式发布走 Developer ID 签名 + 公证（`npm run preflight:mac` fail-loud 预检，流程见 [RELEASING.md](RELEASING.md)）
- 说明：跨平台二进制需在各自系统或 CI 上构建；未配置签名证书时 CI 产出未签名包（仅用于体验/验证）

## Roadmap

- [x] M1 骨架：Electron + TS、service-manager、主窗口、托盘
- [x] M2 背景皮肤：图片覆盖 + 深浅色自适应 + 工作区栏渐变
- [x] M3 宠物：帧动画精灵图 + 多动作 + 宠物工坊
- [x] M5 用量面板：余额接口 + 绿色进度条 + 低余额提醒
- [ ] M4 打包：三平台 CI 出包 + 签名公证
- [ ] 用量明细：DeepSeek 开放用量查询 API 后接入在线用量
- [ ] 设置项 UI 化（当前为 settings.json + 菜单 + DSH 设置页注入）

## 常见问题（FAQ）

**收费吗？** 永久免费、开源（MIT）。无内购、无订阅、无广告、无试用期。

**需要注册或登录吗？** 不需要。唯一可选的是你自己的 DeepSeek API Key（用于在应用内查看余额/用量；不填也能正常使用 DSH）。

**用量面板不显示余额？** 需要在 **设置 → 用量** 栏输入 `sk-...` API Key 并点"保存 Key"后才会拉取余额（DSH 设置页任意位置填入 `sk-` 开头的 Key 也会自动同步）。未配置时用量面板不可用，但不影响 DSH 正常使用。

**我的 API Key 安全吗？** 由系统钥匙串（`safeStorage`）加密存储在本机，只在主进程使用，绝不落明文、绝不上传（详见 [SECURITY.md](SECURITY.md)）。

**和 DeepSeek Harness 是什么关系？** 本项目是社区桌面壳，基于 DeepSeek Harness 构建，**并非 DeepSeek 官方产品**，也不代表官方立场。

**支持哪些系统？** macOS（dmg/zip）、Windows（nsis）、Linux（AppImage/deb）。

## 贡献

欢迎提交 Issue 与 PR。请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md)，保持模块职责单一、错误处理兜底、尽量不新增第三方依赖。

## 联系方式

扫码添加，交流使用问题、建议与反馈：

<table>
  <thead>
    <tr>
      <th align="center">微信群</th>
      <th align="center">QQ群</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td align="center"><img src="assets/contact-wechat.png" alt="微信群二维码" width="180"></td>
      <td align="center"><img src="assets/contact-qq.jpg" alt="QQ群二维码" width="180"></td>
    </tr>
  </tbody>
</table>

> 图片放 `assets/` 下：`contact-wechat.png`（微信群）、`contact-qq.jpg`（QQ群），尺寸建议 ≥ 180×180。

## 安全

API Key 相关处理见 [SECURITY.md](SECURITY.md)。

## 特别感谢

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 与 DeepSeek AI 团队：DSH 本身

## 相关项目

DeepSeek Harness 生态与周边项目：

| 项目 | 简介 | 链接 |
| --- | --- | --- |
| DeepSeek Harness | DeepSeek 官方智能体框架（本项目的基础）。 | [GitHub](https://github.com/deepseek-ai/deepseek-harness) |
| DeepSeek Harness 橙皮书 | DSH 社区实测手册。 | [GitHub](https://github.com/alchaincyf/deepseek-harness-orange-book) |
| Awesome DSH Plugin | DSH 社区插件精选列表。 | [GitHub](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) |
| dsh-web-ui | DSH Web UI 插件与皮肤合集。 | [GitHub](https://github.com/zhu1090093659/dsh-web-ui) |
| dsh-TUI | DSH 全屏交互式终端界面。 | [GitHub](https://github.com/ccch1mneyyy/dsh-TUI) |
| DSH-better-sidebar | DSH 侧边栏工作台（文件/终端/Git/子代理）。 | [GitHub](https://github.com/omdsh-dev/DSH-better-sidebar) |
| Awesome DeepSeek Harness | DSH 插件、工具与基础设施精选列表。 | [GitHub](https://github.com/0xsline/awesome-deepseek-harness) |

<sub>如果希望收录您的项目，欢迎通过上方联系方式联系我们。</sub>

## License

[MIT](LICENSE)

> 本项目是基于 DeepSeek Harness 构建的社区桌面版本，并非 DeepSeek 官方产品，也不代表 DeepSeek 官方立场。
> 本项目完全开源免费。如果有人向您以任何形式出售此软件，请拒绝交易。
