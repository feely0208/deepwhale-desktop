# Changelog

本项目所有重要变更都会记录在此。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [1.0.5] - 2026-08-21

### 修复
- 桌面宠物：修复内置宠物打不开、只显示"pet"占位图标的问题。根因是内置宠物在 app.asar 内，此前用 `fs.cpSync` 从 asar 拷贝到用户目录在 Windows 下失败（asar 虚拟文件系统不支持 cpSync 递归拷贝），导致 spritesheet/manifest 拷不出来；改为 `readdirSync` + `mkdirSync` + `copyFileSync` 逐文件递归复制，并在内置宠物缺失时幂等补全

## [1.0.4] - 2026-08-20

### 修复
- Windows：修复 Node/npx 安装在含空格目录（如 `C:\Program Files\nodejs\`、`E:\Program Files\...`）时 DSH 启动失败的问题。可执行文件路径含空格时加引号执行，不再报 `'E:\Program' 不是内部或外部命令`、不再出现"等待 DSH Web UI 就绪超时"

## [1.0.3] - 2026-08-20

### 修复
- Windows：启动 DSH 服务时隐藏 cmd 窗口（`windowsHide`），不再弹出黑窗口、不再依赖 cmd 后台运行，打开桌面端即可直接使用

## [Unreleased]

### 变更
- 冷启动体验：先显示"正在启动 DSH"窗口，DSH 后台拉起（不再长时间无窗口）；启动失败弹窗附带 DSH 实际日志

### 变更
- 更新项目作者信息与打包元数据；文档清理

## [1.0.0] - 2026-08-16

### 新增
- 发布准备：GitHub Release 工作流（推送 `v*` 标签自动三平台打包并发布 Draft Release）、macOS 签名/公证 fail-loud 预检（`scripts/release-preflight.js`）、发布指南 [RELEASING.md](RELEASING.md)
- README 底部新增"联系方式"区块（微信/QQ 二维码位）与免责声明
- README 新增"永久免费 · 开源"卖点区块、相关项目列表与 FAQ；新增 `.gitattributes`（统一行尾）
- 新增英文版 README（`README.en.md`）与 GitHub Pages 双语主页（`docs/` + `pages.yml` 工作流）

## [0.1.0] - 2026-08-16

首个可运行版本（当前开发主线）。

### 新增
- Electron + TypeScript 跨平台桌面壳：拉起/复用 DSH 服务、退出时 tree-kill 回收进程树、托盘常驻
- 背景皮肤：图片完全覆盖原界面（深浅色模式都生效、不改变基础外观），可见度可调，工作区栏渐变
- 桌面宠物：帧动画精灵图播放（spritesheet + manifest），动作含走路/快走/慢跑/快跑/电脑前工作/挥手/跳跃；宠物工坊（SVG 编辑/导入图片去白底）
- 用量与额度：余额/赠送/充值/今日请求/tokens 展示、绿色进度条、低余额提醒、设置页用量栏内嵌 API Key 输入
- API Key：safeStorage 加密存储 + 兜底混淆；环境变量优先
- DSH 设置页注入"宠物/用量/皮肤"三栏
- macOS 规范应用菜单（关于/设置/隐藏/退出 + 编辑/窗口/帮助）
- electron-builder 三平台配置 + GitHub Actions CI

### 修复
- 设置页三栏面板空白（display 被 CSS 类兜底隐藏）
- 背景皮肤在浅色模式出现深色块（body::before 滤镜只作用于背景图）
- 宠物切换后默认水滴不退出（移除旧默认宠物）

### 说明
- 未签名本地构建；正式发布需配置 Apple Developer ID 签名与公证
