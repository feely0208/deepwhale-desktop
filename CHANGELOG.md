# Changelog

本项目所有重要变更都会记录在此。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [1.0.21] - 2026-09-28

修掉「法律模式」不出现在 Agent 预设选择器里的问题（三平台都受影响），
并把 1.0.20 的 office 修复一并带出（1.0.20 已作废、release 与 tag 均已删除）。

### 修复
- **「法律模式」预设改用 bundle 声明（本轮核心）**

  用户反馈：装完壳之后，Agent 预设里**找不到「法律模式」**。

  根因：随包运行时（0.1.7-rc.2）起，预设**不再是目录**。它自带的技能文档写得很直白：

  > a user preset was a directory `$DSH_HOME/.agent-presets/<id>/` …
  > **Nothing reads that directory any more.**

  预设改由 bundle 的 patch 携带 `@deepseek-ai/dsh-agent-preset` 声明提供
  （随包预设的真实形态就是 `dsh-web-app/presets/*.patch.yml`）。
  而壳写的还是那个老目录，于是**三平台的选择器里都没有「法律模式」**。

  实测坐实：`dsh --profile web --dump-config` 组合出的树里只有 4 个随包预设
  （`preset-standard` / `ptc` / `minimal` / `cordis`），没有 `preset-legal`。

  修复：新增 `scripts/build-legal-preset-bundle.js`，从 `legal-mode/preset/`
  生成一个 bundle（`package.json` 带 `dsh.bundle.patch` + `cordis.patch.yml`，
  内含 `preset-legal` 声明），并列为第三个随包 bundle，复用壳已有的
  `dsh.profile.bundles` 机制（与中文合规、公文排版同一套）。
  persona 字段在**构建时**就写成 `prefix`（随包运行时形态）。

  旧的 `.agent-presets` 拷贝保留，作为用户自备旧 DSH 的兜底。

- **办公能力（1.0.20 的修复一并带出）**

  1.0.19 的打包裁剪规则 `-name '*.md'` 把运行时按路径读取的
  `assets/<子目录>/SKILL.md` 当成"依赖文档"删了，导致 `dsh-skill-office`
  激活失败 —— 表现是「装了但办公功能没有」。1.0.20 已验证修复，
  本轮一并发布。

### 新增
- **设置页显示深鲸壳版本号**：通用设置里「当前版本」原本只有 DSH 运行时版本，
  现在旁边补上壳的版本（如 `深鲸壳 1.0.21`）。

### 加固
- `scripts/check-legal-preset-roster.js`：造临时 home → 注入 →
  跑 `dsh --dump-config` → 断言花名册含 `preset-legal` 且 `config.name=法律模式`。
  接进发布流程的离线守卫。
  这条断言是补课：此前冒烟只断言客户端插件在不在（`COUNT=58 含 ui-legal-mode`）、
  成品包自检只断言载荷文件在不在 —— **没有任何一条断言过"用户能在选择器里选到它"**，
  所以全部是绿的而界面里什么都没有。

## [1.0.20] - 2026-09-28

**只做一件事：把 1.0.19 里被我误删的随包运行时资产加回去。**

### 修复
- **办公能力在 1.0.19 里是坏的（本次唯一改动）**

  1.0.19 为了让安装包小 120MB，加了一条打包裁剪规则 `-name '*.md'`，
  当时的前提是"`.md` 都是依赖自带的文档，运行期用不到"——**这个前提是错的**。

  实测（从 CDN 下载正式 1.0.19 安装包、装上、启动随包运行时）：

  ```
  dsh: warning: 1 entry did not activate
  skill-office: Error: ENOENT,
    dsh-runtime/node_modules/@deepseek-ai/dsh-skill-office/assets/office-docx/SKILL.md
    not found in .../Resources/app.asar
  ```

  核对包内清单：`dsh-skill-office/assets/` 下只剩 `scripts/check_office.py`，
  三个 `SKILL.md` 全被删；`dsh-agent-preset/skills/` 下 3 个也一起没了。
  macOS 与 Linux 包都实测确认，共 6 个文件。

  表现是**"装了但功能没有"**：包装得上、启动得了、法律模式也正常，从外面看不出问题。

  修复：裁剪规则去掉 `*.md`（共约 10MB，不值得冒这个险）。
  **运行时代码零改动** —— `git diff v1.0.19 HEAD -- src/` 只有 `if (SMOKE)` 里的一行冒烟日志。

### 加固
- 新增「裁剪白名单断言」：裁剪前记录完整文件清单，事后逐文件核对，
  任何一个被删文件不属于预期类别（`*.map` / `*.d.ts` / `*.d.ts.map` /
  `.eslintrc*` / `.prettierrc*` / `tsconfig.json` / `.editorconfig`）即失败。
  想删新的一类必须显式改这条断言。
- 再点名断言三个 office `SKILL.md` 必须存在。

  这条断言的意义在于：原先的自检只跑 `dsh --version` / `--help`，
  它们**证明不了插件能激活**，所以 1.0.19 给了一个假通过。

## [1.0.19] - 2026-09-28

修掉 1.0.18 引入的回归，并解决「从 dmg 直接运行装不上 office」的问题。

### 修复
- **法律模式改注入 home 级 —— 首次启动即可用（本次的核心）**

  根因是 DSH 的客户端插件清单在**服务启动那一刻**定型，事后重载页面也不变
  （实测：注入后重拉界面，插件数仍是 58、不含法律模式；重启 DSH 才变成 59）。
  而 `<home>/profiles/web/` 是 **DSH 首次启动才创建**的，所以原先写在 profile 级的注入
  **天生晚于 DSH 启动** —— 首次启动必然看不到法律模式，用户以为"装完里面没有法律模式"。

  1.0.18 相对 1.0.17 又叠加了一层：注入改成了「重试 12 次 + 连续两轮稳定才停」，
  而重载条件读的是**最后一轮**的 `changed` —— 循环必然停在"什么都没改"的那一轮，
  于是**永远不重载**。1.0.17 只调一次，反而常常能重载。

  本版改为注入 `<home>/cordis.patch.yml` + `<home>/node_modules/`：`<home>` 是壳自己创建的，
  可以在拉起 DSH **之前**写好。实测（干净 home，只注入一次、不重启）：
  启动后插件清单**首次即包含** `ui-legal-mode`，零报错。

  已确认 home 级与 profile 级**同时存在**时插件仍只挂载一次、DSH 无告警，
  因此老用户**无需数据迁移**，profile 级那几行保留即可。

- **office 从挂载的 dmg 直接运行时装不上**

  包装脚本原先写在 App 包内（`<App>/Contents/Resources/office-runtime/bin/node`）。
  直接运行挂载的 dmg、或触发 macOS App Translocation（Gatekeeper 路径随机化）时，
  该位置**只读**，写入报 `ENOENT`，整个 office 注入被跳过。
  根本问题是「程序不该修改自己的安装目录」，改写到 `<home>/office-runtime/`；
  老用户 patch 里若仍指向旧路径，会在下次启动时原地替换。

- **壳菜单「顶级中文、子项英文」**：菜单子项只写了 `role` 没写 `label`，
  Electron 显示的是内置英文标签（Undo / Redo / Minimize / About…）。16 处补上中文标签。

### 改进
- **随包运行时裁掉约 120MB 运行期用不到的文件**（`*.map` 55.8MB / `*.d.ts` 53.9MB / `*.md` 10.1MB）。

  裁剪后实跑验证 `dsh --version` 与 `--help` 正常。构建期带 fail-loud 断言：
  源目录省不到 80MB 就构建失败，避免裁剪静默失效后发出一个大 120MB 的包。

  **实际影响（实测对比 1.0.18 → 1.0.19）**：

  | 安装包 | 1.0.18 | 1.0.19 | 变化 |
  |---|---|---|---|
  | macOS arm64 dmg | 285.3 MB | 274.4 MB | **−10.9 MB** |
  | macOS x64 dmg | 288.9 MB | 278.1 MB | −10.8 MB |
  | Windows x64 Setup | 229.6 MB | 223.4 MB | −6.2 MB |
  | Linux AppImage | 277.7 MB | 266.5 MB | −11.2 MB |

  ⚠️ 安装包只小约 **11MB**，不是 120MB —— 被裁掉的多是文本（source map / TS 声明），
  压缩后本来就占不了多少。**省下的是「装完之后占用的磁盘」**（asar 不压缩，约少 120MB）。

### 测试
- **冒烟新增界面级断言**：首次启动抓 DSH 界面，断言插件清单里含 `legal-mode`。
  本轮事故的本质是「注入写盘成功、冒烟报通过、用户却看不到」——
  只断言"注入成功"会给出**假通过**，断言必须落在用户实际能看到的结果上。

## [1.0.18] - 2026-09-26

只带一个修复，但它是用户能直接感知的那个。

### 修复
- **首次启动「选法律模式弹不出律师端」**：profile 注入改为「按文件内容校验 + 60 秒看护补回」。
  根因是 DSH 首次启动会把旧 home 的设置**分阶段**写进 `profiles/web/cordis.patch.yml`，
  这一次写入可能落在我们追加三行之后，把三行整段覆盖掉；而旧实现只看"函数是否返回 changed"，
  判定为成功，于是注入静默丢失。实测同一个包用全新隔离 home 连跑：修复前 4 次里 2 次失败，
  加看护后 6 次全部成功

## [1.0.17] - 2026-09-26

装完即用：把 AI 运行环境、文档生成能力与两个合规插件全部随包带走，用户无需再装 Node.js、无需按需下载。

### 新增
- **随包 DSH 运行时升到 0.1.7-rc.2**：Electron 随之升到 44.0.0（0.1.7 按 Node/V8 指纹精确匹配运行时白名单），用户机器上不再需要 Node.js
- **office 能力**：随包精简 CPython 3.12 + 文档库（python-docx / python-pptx / openpyxl / XlsxWriter / Pillow / lxml），可直接生成 Word / Excel / PPT；PDF 渲染由随 dsh 0.1.7 自带的 LibreOffice Kit 提供。按平台各自打包，macOS Intel 与 Apple 芯片拿到的是各自架构的解释器
- **随包合规插件**：中文合规扫描 + 公文排版两个插件默认注入，无需另行安装
- **深鲸·律师端 macOS Intel 版**：此前只有 Apple 芯片包，Intel Mac 用户现在也有对应产物（Windows / Linux / macOS 两个架构共 5 个包）
- **深鲸套装改为脚本化构建**：四平台（含 macOS Intel）一键组装，不再手工压缩、手工核对

### 修复
- 律师端：Windows 上因 `process.env.HOME` 为空导致 `path.dirname(null)`，表现为"提交失败：请重试"
- 律师端：`lawyer:submit` 未上报后台核验接口，补齐
- 律师端：实习律师模式下 `license` 字段为空时抛 TypeError

### 变更
- 打包体积上升（每个安装包约 +80 MB），换来的是装完即用：不再要求用户有 Node.js，也不再依赖按需下载
- 官网与 GitHub 版本对齐：两个站点、五个平台，桌面端与律师端指向同一版本
- 官网同步排除桌面端 `.zip`（官网下载页不提供该格式，约占同步量 29%）

> ⚠️ 已知缺陷（已在下一版修复）：首次启动时 profile 注入存在偶发失败，
> 表现为「选法律模式弹不出律师端」，重启一次即恢复。根因与修复见 [Unreleased]。

## [1.0.16] - 2026-09-25

三项均为纯增量，不改动既有行为。

### 新增
- **自动更新**：启动 15 秒后静默检查一次，之后每 6 小时轮询。**不静默下载**——发现新版本先弹原生对话框，用户确认后才下载，下载完再问是否重启安装。仅打包版生效（开发态不触发）。检查失败只写日志，不打扰用户
- **手动检查更新**：托盘右键菜单与「帮助」菜单新增「检查更新…」，有结果如实告知（含"已是最新"与具体失败原因）
- **崩溃恢复**：捕获主进程未捕获异常、未处理的 Promise 拒绝、渲染进程崩溃、子进程崩溃；故障日志只落本地 `<userData>/logs/fault.log`（超过 512 KB 自动截断），**不上传任何服务器**
- **启动失败可自救**：DSH 启动失败的弹窗从"只有一个确定按钮"改为可重试循环——**重试 / 查看日志 / 打开设置 / 退出**，不必再重启应用
- **首次启动引导**：新用户首次打开显示一页式引导（填写 API Key + 说明下一步该做什么）。已装过的老用户不触发

### 变更
- 文档措辞对齐广告法合规：去掉「绝不」「永远」等绝对化表述（不改动任何功能）

> ⚠️ 版本 1.0.6 – 1.0.15 的变更未记录在本文件（历史遗漏）。如需回溯，见 `git log v1.0.5..v1.0.15`。

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
- README 新增"免费 · 开源"卖点区块、相关项目列表与 FAQ；新增 `.gitattributes`（统一行尾）
- 新增英文版 README（`README.en.md`）与 GitHub Pages 双语主页（`docs/` + `pages.yml` 工作流）

## [0.1.0] - 2026-08-16

第一个可运行版本（当前开发主线）。

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
