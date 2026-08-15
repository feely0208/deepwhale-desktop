# DeepSeek Harness Desktop

把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的 Web UI 装进 Electron 原生窗口的跨平台桌面壳。

- 🖥️ 启动即拉起/复用 DSH 服务，退出时干净回收进程树（无孤儿 node 进程）
- 🎨 皮肤系统：内置多套主题 + 自定义 CSS（保存即时生效）
- 🐾 桌面宠物：透明置顶小窗口，可拖拽、可穿透点击、支持自定义 GIF
- 💰 用量与额度面板：余额（额度）+ 本地累计用量，低余额自动提醒
- 🗂️ 托盘常驻：关窗口不退出，托盘菜单快速控制
- 📦 三平台打包：macOS `.dmg` / Windows `.nsis` / Linux `.AppImage`·`.deb`

> 参考社区项目 [anywhere-labs/deepseek-harness-desktop](https://github.com/anywhere-labs/deepseek-harness-desktop)（仅打包 mac/win），本项目的壳从零编写并扩展以上功能。

## 快速开始

要求：Node.js ≥ 18（建议 ≥ 20）。

```bash
npm install
npm run dev        # 编译 + 启动桌面壳（自动拉起或复用本机 DSH Web UI）
```

首次运行会在 `userData/settings.json` 生成默认配置；如果 3080 端口已有 DSH Web UI 在跑，直接复用，不会重复启动。

## 功能说明

### 主题与背景皮肤
- **原生界面主题**：跟随系统 / 浅色 / 深色 三档（`nativeTheme`，默认跟随系统）。
- **背景皮肤**：选一张你喜欢的图片，**完全覆盖原界面**——图片复制到 `userData/skins/`，全窗口 cover 平铺，界面层自动半透明让图透出，背景可见度可调（30%~100%）。
- 入口：托盘菜单 → 皮肤，或 **设置页 → 皮肤** 栏（在 通用设置/模型/插件/Agent 预设 四项之下顺延）。
- 自定义 CSS（`userData/custom.css`）保存即时重注入，可做精细微调。

### 桌面宠物
- 默认宠物：Codex 风格橙色小团子（SVG 渐变 + CSS 动画：呼吸弹跳 / 眨眼 / 落地压扁，悬停开心蹦跶，随机挥手/打盹）。
- 切换入口：右键宠物，或 **设置页 → 宠物** 栏（含预览 / 开关 / 穿透点击 / 打开目录）。
- **自制宠物**：托盘菜单 → 宠物 → "打开宠物目录…"（或右键宠物 → 打开宠物目录），把 `.gif` **或 `.svg`** 丢进弹出的目录，右键宠物 → 宠物皮肤 即可切换。
  - 首次启动会把内置示例（`_TEMPLATE.svg`）自动复制到该目录（`userData/pets`）。
  - SVG 宠物最容易上手：复制 `_TEMPLATE.svg` 改名编辑即可，支持在文件里写 CSS 动画。
- 右键宠物：切换皮肤 / 穿透点击（可点到宠物后面的内容）/ 隐藏。

### 用量与额度面板
- 右下角可折叠面板 + 设置页 → 用量 栏：总余额 / 赠送余额 / 充值余额 / 今日请求数 / 累计 tokens（估）。
- 额度来源：官方接口 `GET https://api.deepseek.com/user/balance`。
- 用量来源：首版本地统计（解析 DSH 日志中的 token 计数），在线明细待 DeepSeek 开放用量 API 后接入。
- 低余额提醒：余额低于阈值（默认 ¥5）时系统通知一次，面板状态点标红。
- 刷新：默认每 5 分钟（可在设置中改 `usageRefreshMinutes`），面板点击"立即刷新"或托盘菜单刷新。

### API Key 安全
- 优先复用环境变量 `DEEPSEEK_API_KEY`（启动 DSH 时注入）。
- 手动填写的 Key 用系统钥匙串（Electron `safeStorage`）加密存储，**绝不明文写入 settings.json、不打印日志、不在面板显示**。
- 余额请求只在主进程发起，渲染层只接收脱敏后的展示数据。

## 配置（userData/settings.json）

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `command` | `npx @deepseek-ai/dsh web` | 拉起 DSH 的命令，可改为本地路径 |
| `port` | `3080` | DSH Web UI 端口 |
| `theme` | `system` | 原生界面主题（跟随系统/浅色/深色） |
| `skinImage` | `null` | 背景皮肤图片文件名（userData/skins/ 下） |
| `skinOpacity` | `0.85` | 背景可见度（0.3~1） |
| `customCssEnabled` | `false` | 是否启用自定义 CSS |
| `petVisible` | `true` | 宠物是否显示 |
| `petGif` | `null` | 自定义宠物 GIF 文件名 |
| `clickThrough` | `false` | 宠物穿透点击 |
| `closeToTray` | `true` | 关窗口最小化到托盘 |
| `usagePanelVisible` | `true` | 用量面板显示 |
| `usageRefreshMinutes` | `5` | 余额刷新间隔（分钟） |
| `usageLowBalanceAlert` | `5` | 低余额提醒阈值（元） |

## 开发

```bash
npm run build          # tsc 编译 + 复制静态资源到 dist/
npm run dev            # 构建并启动
npm run smoke          # 冒烟测试：自动启动、打印关键事件、8 秒后退出（CI 可用）
npm run icons          # 重新生成图标
npm run dist:mac       # 打包 macOS dmg/zip
npm run dist:win       # 打包 Windows nsis（需在 Windows 或 CI 上构建）
npm run dist:linux     # 打包 Linux AppImage/deb
```

### 目录结构

```
dsh-desktop/
├── src/
│   ├── main/               # 主进程模块
│   │   ├── index.ts        # 入口：装配各模块
│   │   ├── service-manager.ts  # 拉起/检测/回收 DSH 进程
│   │   ├── window.ts       # 主窗口 + 注入钩子
│   │   ├── skin-manager.ts # 皮肤装载/切换/自定义 CSS
│   │   ├── pet.ts          # 桌面宠物窗口
│   │   ├── tray.ts         # 托盘 + 菜单
│   │   ├── usage-manager.ts # 用量/额度采集、刷新与提醒
│   │   └── store.ts        # JSON 设置读写
│   ├── preload/preload.ts  # 最小 IPC 桥
│   ├── skins/              # 内置主题（.css）
│   ├── pet/                # 宠物渲染页
│   └── usage/              # 注入式用量面板
├── assets/
│   ├── pets/               # 内置宠物示例（首次启动复制到 userData/pets）
│   └── icons/              # 应用/托盘图标（npm run icons 生成）
└── scripts/                # 构建辅助脚本
```

## Roadmap

- [x] M1 骨架：Electron + TS、service-manager、主窗口、托盘
- [x] M2 皮肤：内置主题 + 菜单切换 + 自定义 CSS + 持久化
- [x] M3 宠物：透明置顶窗口、拖拽、右键菜单、穿透开关
- [x] M5 用量面板：余额接口 + 本地用量统计 + 注入式面板 + 低余额提醒
- [ ] M4 打包：三平台 CI（GitHub Actions）出 dmg/nsis/AppImage
- [ ] 用量明细：DeepSeek 开放用量查询 API 后接入在线用量
- [ ] 设置界面（当前为 settings.json + 菜单）

## 贡献

欢迎提交 Issue 和 PR。请保持模块职责单一、错误处理兜底、无新增第三方依赖（除非必要）。

## License

[MIT](LICENSE)
