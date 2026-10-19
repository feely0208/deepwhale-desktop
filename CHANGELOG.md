# Changelog

本项目所有重要变更都会记录在此。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

> **关于 1.0.39 起的维护口径（2026-10-08 补记）**
>
> 自 1.0.39 起，面向用户的更新说明以 `assets/whatsnew.json` 为准（App 内「本版更新内容」与官网同步）。
> 本文件仅记录对开发者有影响的内部变更。1.0.39 ~ 1.0.53 未逐条维护，自 1.0.54 起恢复。

> **口径说明（2026-10-08 定）**：自 **1.0.39** 起，**面向用户的更新说明以 `assets/whatsnew.json` 为准**
>（App 内「本版更新内容」与官网同源）。本文件只记录对开发者有影响的变更；
> 1.0.39~1.0.54 未逐条维护，**自 1.0.55 起恢复**。

## [未发布] — 1.0.60 待办

- [ ] **用量面板浅色下文字发灰看不清**（2026-10-19 用户实测；源码已修，**待发版才生效**）
  - 根因：2026-10-18 把 `@media (prefers-color-scheme: dark)` 展开成 `body[data-ds-dark-theme]` 时，
    每组只给**第一个**选择器加了前缀，后面的（`.row .k = #9aa1ad`、`.row .v = #e6e8ec` 等 19 条）全漏了
    → 深色那套浅灰/近白文字在浅色底上照常生效。
  - 判断条件错在"行以 `{` 结尾"，而块里大量是单行规则 `xxx { color: ...; }`。
  - 已修（commit bcc9082）：按"以 `#` 开头且含 `{`"判断，正确前缀 19 条；34 条浅色基础规则保持无前缀；括号 53/53 配平。
  - ⚠️ **教训**：改主题相关样式必须**浅色和深色各看一遍**，只验当前模式就是假绿。
- [ ] **会话搜索（dsh-experimental-session-search）开了但不可用**
  - 工具能调用，但报 `SESSION_QUERY_PERSISTENCE_FAILED` / `session history storage is unavailable`。
  - 排查过：bundle 在 profile 里已启用、`dsh-session-query-sqlite` 在运行时里、`node:sqlite` 在 Electron 44（Node 24.18.1）里 `DatabaseSync` 可用 —— **但 sqlite 后端没被挂上**，需要看宿主插件加载日志。
- [ ] **主题修复整体待发版**（本板条目 1、2 与 10-18 的本机内文件卡片修复，用户端都要等 1.0.60）



> 记录待办，不代表已开工。

- [ ] **模型显示名跟到官方 `DeepSeek-V4.1-Flash-1017`**（律师端已于 2026-10-17 先跟上，只剩桌面端）
  - 做法：在 `cordis.patch.yml` 给 `llm-deepseek` 注入 `config.models`，照抄官方 catalog 那一条的全部字段，**只改 `name`**。
  - 官方依据：`dsh-llm-deepseek` 源码注释 *"Advisory official model entries; deployments may replace the catalog."*
  - ⚠️ **风险**：`models` 是**整个数组替换**，缺字段或写错字段名会让 `Schema.validate` 失败 → **DSH 起不来**（与 1.0.58 的 `host: 0.0.0.0` 是同一类死法）。
  - **发版前必须在隔离实例跑通冒烟**：DSH 能起来 + 模型名显示成 `-1017` + 能正常对话。
  - 不值得为它单独发版，随下一个有实质内容的版本一起走。
- [ ] **法律模式「全新安装首次启动」可见性**
  - 现象：全新 home 首次启动时客户端插件清单里没有 `ui-legal-mode`，重载一次才补上（`legal-mode setup: pending=true` 的时序）。
  - 不是 1.0.58 的回归（老用户无影响），但是新装体验瑕疵。
- [ ] **CDN 上无参数的 `whatsnew.json` 是旧版**（应用始终带 `?v=` 已规避；如需外部消费要刷新该对象）。

## [1.0.59] - 2026-10-18

**紧急修复：1.0.58 升级后「无法连接到 DSH 服务」（发布级事故，升级即砖）。**

### 根因
1.0.58 把随包运行时升到 DSH 0.2.1-rc.1，新版 `@deepseek-ai/dsh-host-webserver` 收紧了安全策略：
**拒绝通配地址** ——
`host "0.0.0.0" is an unspecified (wildcard) address, which is not supported;
binding every interface would expose remote code execution to the network`。
而壳的「手机连接」（`mobile-connect.ts` 的 `bindingBlock()`）把 `host: 0.0.0.0` **写死**进
`<home>/cordis.patch.yml`，于是：webserver 插件 `Schema.validate` 失败 → webServer 起不来 →
web-runtime / shell-canvas / shell-mobile 等 **8 个插件全在等它** → DSH 进程 `exit 1` →
壳弹「无法连接到 DSH 服务」。**点「重试」无效** —— 每次启动都会把 0.0.0.0 再写回去。

**影响面**：`lanAccess=true` 的升级用户（`store.ts` 里 `lanAccessMigrated` 会把老用户强制置 true）。
**当时所有守卫都是绿的** —— 因为没一条覆盖「升级用户的历史配置」这条路径。

### 修法
1. `bindingBlock()`：`host: 0.0.0.0` → **`127.0.0.1`**（局域网那条路已由壳自己的
   `mobile-gateway.ts` 接管：它自己监听 0.0.0.0 + 配对码 + 会话令牌，不受 DSH 这条限制）。
2. 新增 `sanitizeWebserverHost()`：启动时**在拉起 DSH 之前**、**无条件**把
   `cordis.patch.yml` 里 webserver 块的 `0.0.0.0` 改写为 `127.0.0.1`。
   必须无条件 —— 把 `lanAccess` 关掉没用：**污染的是文件，不是开关**。
   只动 host 那一行，feedback 等其它 insert 块一行不碰；内容没变不写盘。
3. 新增守卫 `scripts/test-mobile-connect-host.js`（接进 release.yml）：断言
   `bindingBlock()` 永不产出通配地址、老配置能被迁移、**其它配置块不被误伤**、幂等。

### 另两个体验修复
- 「本版更新内容」偶发显示「暂未获取到」：弹窗打开时本地缓存还没刷到新版本；
  现在会强制回源一次再判定。
- 更新下载卡在某个百分比：`electron-updater` 的 `pending/` 里残留着**旧版本**的半截安装包，
  新版本误以为可续传（实测卡在 79%，`pending/DeepWhale-Desktop-1.0.57-arm64.zip` 289MB），
  校验永远对不上。现在开始下载前会清掉不属于当前目标版本的残留。

## [1.0.58] - 2026-10-17

**本版主体是「手机端」：桌面壳内置手机访问网关 + 手机端 App 打通核心回路。** 同时随包运行时升级到 DSH 0.2.1-rc.1。
自 `v1.0.57` 起共 27 个提交。

### 手机端（本版重点）
立项背景（2026-10-15）：DSH 只监听 `127.0.0.1`，手机无论如何连不上。过去把"这一公里"外包给用户
（自己搭转发层 + 认证），90% 用户卡在第一步；第三方用"桌面出二维码 + 手机扫码 + 隧道"做成 10 秒。
**我们手握桌面壳，这件事应当原生做掉，且不依赖任何第三方隧道。**

- `src/main/mobile-gateway.ts`：**纯 Node 原生 http 反向代理，零第三方依赖**，把请求转给 `127.0.0.1` 上的 DSH；
  局域网 + **一次性配对码** + 令牌。网关**自己持有 DSH 会话**，DSH 凭据留在网关内、不下发手机（有断言守）
- 桌面端**「手机连接」面板**（`mobile-panel.ts` + preload + 主进程 IPC `mobile:start/stop/rotate/status/copy`）：
  一键开启 + **本地生成二维码**（`qrSvg`）。守卫明确**禁止在线二维码服务** —— 配对载荷含一次性配对码，
  发给第三方等于把临时钥匙递出去。退出时 `disposeMobileGateway` 收掉服务，端口不留
- 手机端插件 `/mobile/api/*`：会话列表 / 新建会话 / 会话详情+消息 / 轨迹
- 手机端界面：连接页（扫码/配对，深链 `dshmobile://pair`）、列表、会话、轨迹；
  文字视觉换成桌面同款「辉光」；排版断言覆盖 3 页面 × 2 主题 × 4 机型
- **E2E（真 DSH，非替身）**：token 建 cookie → 打开 `/mobile/` → 断言真实会话 ≥1 行 → 页面里真发一条消息
  → 断言会话页渲染出真实消息且已切换。实测抓到并修掉"发完消息没切到会话页"
- 修：网关剥离 token 参数时破坏路径（`/mobile/&dshApp=1` → 404 白屏），并加 Android 壳流程守卫

### 设置页 / 菜单
- **新增「本版更新内容」按钮**（`caccbd7`，**只对 Windows/Linux 注入**——win/linux 菜单栏被 `autoHideMenuBar`
  藏着，用户实测"找不到"；mac 顶部菜单栏一眼就有，不重复放）
- 版本行改为「左侧两行文本 + 右侧三个按钮」同一行，严格等高 32px；含注入后**布局自检与回滚**
- 托盘菜单补「本版更新内容…」

### 更新 / 安装
- **关掉差分下载**：我们的 CDN 不支持多段 range，差分会令 Windows 更新"越下越慢"
- 更新弹窗按钮排版重排（单行 / 等高 / 主按钮最右）
- 安装器覆盖 `customCheckAppRunning`，能自己关掉运行中的旧版（此前漏提交）

### 修复
- **打包态 Office 文档预览空白**：平台引擎不进 asar + DSH 侧 `NODE_PATH`（P0-0）

### 运行时
- `dsh-runtime.version`：`0.2.0-rc.2` → **`0.2.1-rc.1`**
  （官方 2026-10-17：V4.1 Flash 升级至 `DeepSeek-V4.1-Flash-1017`，API 与价格不变、模型名仍 `deepseek-flash`；
  并要求 DSH ≥ 0.2.1-rc.1。基准：Terminal-Bench 4.0 `31.2→42.3`、DeepSWE `74.2→77.0`、ProgramBench `20.3→29.1`）
- 运行时自带**网页搜索/抓取**：`dsh-web-search-deepseek`（native `web_search` via Anthropic 兼容 API）、
  `dsh-web-fetch-http`、`dsh-tool-web`、`dsh-client-ui-settings-web-search`。
  官方说明：DSH/Claude Code/Codex 用户经 Server 端工具调用已可用，**2026-11-01 00:00 起按次计费**
- 9 个随包插件补 `engines.dsh = >=0.1.0-rc.6 <0.3.0`（声明后单独决定兼容性、peerDependencies 被忽略；
  **必须带上界**，否则跨大版本会"先放行后炸"）；画布插件 `1.0.6` → `1.0.7`

### 采用注意
`npm install` 从 npmjs 装 DSH 极慢（本机实测单个 tarball 19 分钟，70 分钟仍失败），
**改用 `--registry=https://registry.npmmirror.com` 后 900MB 依赖 32 秒装完**。

## [1.0.57] - 2026-10-15

**紧急热修复：1.0.56 会让界面完全打不开**（用户实测：整页 `Failed to load plugins`）。

### 根因
`dsh-shell-web-preview/lib/client.js` 的 `factory` 在缺少 Electron 桥时会**提前 `return;`**
（返回 undefined）。cordis 拿到 undefined 就判定"不是插件"并**整页失败** ——
一个坏 bundle 让所有插件都加载不了，应用等于打不开。
（浏览器打开 `127.0.0.1:3095` 时没有 `window.dsh` 桥 → 必中；Electron 窗口里有桥 →
本机冒烟是绿的，所以问题只在真实浏览器/无桥宿主上暴露。修复本身 2026-10-15 04:47 已在工作区，
但**没有进 v1.0.56 的构建** —— 这是这次事故的直接原因：修了没提交、提交了没进包。）

### 修复
- `shell-plugins/dsh-shell-web-preview/lib/client.js`：factory 现在一定会
  `return module.exports`（原来的提前 return 移进 `apply()` 内部）。
- **兜底（重要）**：`ensureBundledPlugins()` 在注入前自检每个插件的客户层 bundle，
  不合格的**整个跳过**并把它从 profile 的 bundles 里摘掉 —— 以后一个坏插件最多自己不生效，
  不会再拖垮整个界面（`clientBundleLoadable()`，无法读取时不拦）。
- 新增离线守卫 `scripts/check-client-bundles.js`：所有 `*/lib/client.js` 必须能解析、
  是 `__ModuleLoader__.load` 形态、factory 必须返回插件对象且导出 `apply`。
  **用 v1.0.56 里那份坏文件当反例验证过会红**。已接进 release CI。

### 发布侧处置
- CDN 的 `latest*.yml` 与官网下载页**已回滚到 1.0.55**（避免更多用户装到 1.0.56）。
- GitHub 上 `v1.0.56` 已标为 **Pre-release** 并取消 Latest（`v1.0.55` 重新成为 Latest）。
- 用户侧的更新检查运行在壳（主进程）里、不依赖 Web 界面 —— 所以卡在 1.0.56 的用户仍能收到本次修复。

## [1.0.56] - 2026-10-14

> 面向用户的说明见 `assets/whatsnew.json` 的 1.0.56 条目；这里只记对开发者有影响的变更。
> 本轮的主线是**「从旧版升级上来的用户」**：三个长期潜伏的遗留问题都做了启动自愈，
> 并且每一条都配了能红的离线守卫（见 §工程）。

### 新增
- **Windows 安装目录可自选**（`oneClick:false` + `allowToChangeInstallationDirectory:true` + `allowElevation:true`），
  同时把自动更新的安装目标钉死在当前安装目录（`installDirectory = dirname(app.getPath('exe'))`）
  —— 2026-10-04「更新后应用消失」的正解，见 `scripts/check-installer-config.js` 的成对约束。
- **更新由用户掌控**：`autoDownload=false` + 带 `CancellationToken` 的下载；
  弹窗新增「现在更新 / 停止更新 / 这个版本不再提醒」，跳过记录持久化到 `<userData>/update-skip.json`。
- **聊天与侧栏的视频/音频内嵌预览插件进随包清单**（`shell-plugins/dsh-shell-video-preview`，2026-10-10 只做了插件与验证，漏了声明与拷贝）。
- 故障日志带 `版本 / 平台 / 安装目录`，并对 `token=` / `prefill_token=` / `Authorization` 打码。

### 修复
- **升级用户 Word/Excel/PPT 文档能力静默失效**：`dsh-home` 里 office 行的 `cli:` 仍是 asar 时代路径
  （`asar: false` 之后该路径不存在，DSH 报 `Invalid package <归档根>` + `1 entry did not activate`）。
  `ensureOfficePatchRows` 原先只对齐 `node:` —— 现在 `node/cli/source` 三者都按当前值重写。
  **连带挖出一个真 bug**：`materializeOfficeKit()` 末尾 `path.join(kitRoot, ...cliRel)` 少了一层 `node_modules`
  → 该函数永远返回 null，物化结果被静默丢弃（所以注入的一直是随包运行时那份）。
- **右侧栏全屏透底/叠字**：我们的皮肤把 `--dsw-alias-bg-base` 打薄，而 1.0.55 的做实只覆盖 `[class*="_overlay"]`；
  框架列与文档预览 iframe 不在里面。现在按 DSH 的稳定属性 `[data-sidebar-right-panel='fullscreen']` 做实
  （面板本身 + 子树 token），停靠态仍保持半透明。
- **「新建会话建不了」**：旧版写进会话投影的 preset id `legal` 在新花名册里不存在。
  新增 `src/main/preset-heal.ts`，启动时把 `<home>/storages/session_projcache/sessions/*.json` 里的
  `record.rows.agentPreset.val` 从 `legal` 改写成 `legal-mode`（原子写 + `.legal-bak` 备份）。
- **启动失败误报与无信息**：`dsh web:` 行成为第二条就绪信号；失败文案按 bundled/自定义命令分叉并带诊断。
  修掉两个真 bug：① `child.on('exit')` 把 `this.child` 置 null，导致"提前退出"永远判不到；
  ② `emit('error')` 没有监听者会直接抛（壳里从来没监听）→ 现在有人听才 emit，spawn 错误也进输出尾巴。
- **patch 自愈判据扩大**：从"只认空字节/控制字符"扩到"YAML 解析抛错"（截断的半截 ASCII 文件同样让应用起不来）。

### 工程
- **运行时打包改回 asar**（`asar: true`）：本机打包实测文件数 **17,925 → 4,109（-77%）**、`app.asar` 单文件 184.9MB。
  前提是两条：引擎/kit 在 `asarUnpack` 里解包；`office-runtime.ts` 的物化改走 asar 安全的 `copyTree()`
  （实测 `fs.cpSync` 读不了 asar：`statSync/readFileSync/readdirSync/import` 都行，唯独它抛 ENOENT）。
- 新增离线守卫（全部接进 release CI，且每个都做过反例验证）：
  `test-office-row-heal` · `test-service-readiness` · `test-preset-heal` · `test-asar-copy` ·
  `test-fault-log` · `check-shell-plugins-shipped` · `check-update-cancel` · `check-skin-fullscreen` ·
  `check-asar-packaging`；`check-installer-config` 的判据从"不许开目录选择"改成"必须成对"。
- 冒烟皮肤探针扩到右栏全屏，并如实报告"本次有没有真的进入全屏"（没进入就说未覆盖，不把没测到当通过）。

## [1.0.55] - 2026-10-08

### 新增
- 侧栏「本机内文件」支持视频预览（mp4/m4v/mov/webm/ogv，走 data URI 通路，上限 120MB）
- `.html` 走**沙箱 iframe** 真渲染（`sandbox=""`，不给脚本与同源权限），不再显示源码

### 修复
- 全屏/最大化浮层透底（用户反复报的「怪白页」）：皮肤把 `--dsw-alias-bg-base` 打薄导致；
  只覆盖浮层子树，主界面像素逐位不变
- **「防白屏」自检本身失效**：探针类名匹配不到任何规则 + `rgba(0,0,0,0)` 被判成"不透明"，
  导致它永远通过、白屏反复复发。改为按 alpha 数值判定并从真实规则取值（现在会真的报错）
- 引导层 `_onboardingOverlay` 漏在覆盖范围外（大小写不敏感匹配）
- 空白会话顶部标记回归官方原生（自制的品牌标记插件已**彻底删除**）

### 工程
- 新增 `npm run smoke:isolated`：冒烟必须换端口 + 独立 DSH_HOME，否则会复用用户实例并产生假红

## [1.0.38] - 2026-10-02

**修一个会让应用彻底打不开的问题 —— 而且是用户报上来的。**

### 修复
- **启动自愈：配置文件被写坏时自动修复，应用不再打不开。**

  真实用户（Windows）实测：更新到 1.0.37 后，**第二天早上打不开**，界面只有
  「重试 / 查看日志 / 打开设置 / 退出」，日志里是：

  ```
  dsh: failed to parse overlay
    ...\dsh-home\profiles\deepwhale\cordis.patch.yml:
  YAMLException: null byte is not allowed in input (1:1)
  ```

  也就是那个 patch 文件**开头多了一个空字节**。它是**两个进程都在写**的
  （壳写 home 级、DSH 写 profile 级），叠加 Windows 上的杀软过滤驱动，
  写坏在现实里会发生 —— 而后果是**应用从此再也起不来**。

  现在壳会在**拉起 DSH 之前**先体检这些文件：含空字节 / 非法 UTF-8 /
  去掉注释空行后不是数组 → **先把坏文件改名备份**（`.bad-<时间戳>`，
  万一里头还有配置可人工找回）→ 再写一个合法的空数组，DSH 会在它基础上重建。
  **用户不需要做任何操作**，装上新版打开就好。

- **写这些文件一律改为原子写**（先写临时文件再改名覆盖）。
  原来直接写是「先截断再写」，中途被打断（进程被杀 / 断电 / 杀软拦截）
  就会留下半截或带空洞的文件 —— 正是上面那个空字节的来源。

- **法律模式：切换预设后覆盖层不弹** —— 预设 id 三方不一致（生成器写成 `legal`，
  而壳与覆盖层插件约定的都是 `legal-mode`），已统一；并加了**四方一致性自检**
  （生成器 / 壳 / 插件 / 产物），任一处不一致立刻失败。

### 验证
- 新增 `scripts/test-patch-selfheal.js`（11 条断言），用**用户那次的同样字节**验证：
  能救回坏文件、**正常文件绝不误伤**（`- insert` 块 / `[]` / CRLF 全部原样不动）、
  文件不存在时不乱建。
- 十套测试全绿。

## [1.0.37] - 2026-10-01

**会话右键菜单：能一键定位到这个会话的文件，也能就这个会话直接反馈。**

### 新增
- **会话「...」菜单新增四行**（走 DSH 官方插槽 `sidebar.workspaces.session.menu.item`，
  与它自带的置顶/重命名/分叉/归档同款外观）：
  - **在访达中打开**（Windows 是「在文件资源管理器中显示」，Linux 是「在文件管理器中显示」）
  - 打开所在文件夹
  - 复制文件路径
  - 复制会话 ID

  为什么要它：会话文件在磁盘上是有明确位置的（`session.jsonl.zstd`），
  但此前界面里没有任何入口能到那儿 —— 排查问题、发日志时只能靠人肉找目录。

- **菜单第五行「反馈问题」：会话级反馈**（借鉴 zcode 的做法）
  - 从某个会话的菜单点进去，反馈表单会**自动预填该会话的标题与 ID**，
    用户不用自己抄；我们收到时也能直接对上是哪个会话，省一轮来回。
  - **不传任何文件路径**（工作区/会话文件/日志路径一律不发）——
    会话 ID 够我们定位，少传隐私。
  - 预填内容在**可编辑的描述框**里，用户看得见、能改能删再提交，并附敏感信息提醒。

### 修复 / 加固
- **随包插件载荷改为"先写临时目录、成功了再原子替换"**。
  原来是先 `rmSync` 清空目录 —— 中途任何失败（例如 npm registry 抖动）都会留下
  **空载荷目录**，而打包脚本只看目录在不在，于是能打出一个**没有随包插件**的安装包。
  实测对照：故意让构建失败后，旧载荷四个插件原样都在。

### 说明
- 1.0.30–1.0.36 是同一天的连续迭代（其中 1.0.36 已发布），变更记录未逐版补写 ——
  主要内容是插件页启用失败修复、皮肤深浅色修正、手机连接，详见对应 Release 说明。

### 验证
- 八套测试全绿；打包后插件确实进客户端清单（curl 实测命中）。
- 会话菜单四行为**用户在本机实测确认**（在访达中显示、复制会话 ID 均可用）。
- 会话级反馈链路端到端实测：表单预填 → 提交 → 后端落库 → 运营面板显示独立字段。

## [1.0.29] - 2026-10-01

**「手机连接」补上用户要的那一环：桌面上给一份带 token 的地址文件。**

### 新增
- 「手机连接…」面板增加 **「写到桌面文件」**：点一次即在桌面生成
  **「手机连接地址.txt」**，里面是**带 token 的完整地址**（局域网 + 外网），
  可以整段复制发到手机上。

  此后面板每次启动、以及 DSH 重启换了 token 时，**这个文件会自动刷新** ——
  用户不用自己盯着它是不是过期了。（用户原话："我复制，这样我也不知道 token 啊"，
  面板里的复制按钮对他这种"要把地址发到手机"的场景不好用。）

### 说明
- 该文件**默认不开**：往所有用户的桌面丢文件是失礼的。用户点过一次之后才持续维护。

### 测试
- `scripts/test-mobile-urls.js` 增加 E 段：桌面地址文件正文（含"没网卡时不谎报"）。

## [1.0.28] - 2026-10-01

**「手机连接」做全了** —— 手机第一次打开我们给的地址，之后就直接输 IP / 隧道地址即可。

### 新增
- **桌面端新增「手机连接…」入口**（托盘右键 + 帮助菜单），直接给出**带 token 的完整地址**：
  局域网地址（同一 WiFi）、外网地址（配了隧道就有），一键复制。

  为什么由我们拼 token：用户的原话是「以前只需要输入 ip 就可以，从来没有让输入过什么 token」，
  而现在的 DSH 不带 token 一律 401。DSH 的行为是「用带 token 的根地址访问一次 → 种 cookie
  → 跳到干净的 `./`」，所以**第一次用我们给的完整地址打开，之后浏览器记住登录状态，
  再直接输 IP / 隧道地址就能进** —— 正是他记忆里的体验。

- **局域网访问改为默认开启**：壳把 DSH 绑到 `0.0.0.0`，并把**运行时探测到的本机地址**
  写进 `trustedHosts`（换 WiFi 会自动更新），所以换网络也不会连不上。

  ⚠️ **鉴权保持开启**：`0.0.0.0` 意味着同网段可达，关掉 token 等于把用户的会话记录和文件
  对同一 WiFi 下的所有人敞开。这是硬约束，不做成"图省事关掉校验"。

- 新增可选设置 **`publicUrl`**：填了自建隧道/反代的地址，面板就会一并显示外网那条；
  留空则只显示局域网。（默认空 —— 不能替用户假设他有隧道。）

### 说明
- **局域网绑定在"下一次 DSH 服务重启"后生效**：当前正在跑的 DSH 进程是按旧配置拉起的
  （`keepDshRunning=true` 会保留它），壳会复用，不会强制重启它。
- 老用户有一次**一次性迁移**：1.0.25/1.0.26 写进 settings.json 的 `lanAccess:false`
  是当时的默认值、不是用户的选择，会被改成开；之后用户自己关掉就尊重他的选择。

### 测试
- 新增 `scripts/test-mobile-urls.js`：带 token 的地址拼装（含"拿不到 token 时不谎报可用"）。
- 局域网绑定实测：独立 home + 独立端口起 DSH，确认监听 `*:3195`、局域网 IP 可连（401 而非拒绝）。

## [1.0.27] - 2026-10-01

**更新源从"只有 GitHub"改成"自建 CDN 为主、GitHub 兜底"。**

### 变更
- **接上自建更新源（`dl.deepwhale.org.cn`）。** 原来检查更新只有一条路：GitHub Releases。
  国内用户经常连不上 GitHub，表现就是「点检查更新没反应」——**根本不知道有新版本**。
  现在主源改成我们自己的 CDN（安装包与 `latest*.yml` 都已经在那里），
  **失败自动回退**到打包时写好的更新源。

  为什么必须留回退：CDN 是自建的 —— 某个版本忘了传 `latest*.yml`、或者 CDN 抽风，
  只写 CDN 就等于**所有用户都收不到更新**，比原来更糟。回退配置直接读打包时的
  `Resources/app-update.yml`，不硬编码 owner/repo，免得哪天改名两边不一致。

  实现上有两个不显然的点：
  · `checkForUpdates()` **既 emit('error') 又 reject** —— 试 CDN 期间的 error 事件
    先用标记按住，否则会出现"回退成功了、但界面闪了一次假报错"；
  · generic provider 会自动给 channel 文件加 `noCache=<时间戳>`（见 `update-feed.ts` 注释），
    正好绕开 CDN 缓存 —— 所以**不需要每次发版人工刷 CDN**。

### 新增测试
- `scripts/test-update-feed.js`（16 项），三段：
  · A 段离线：回退配置的解析（含"缺 provider 就返回 null，不给半成品配置"）；
  · B 段联网**发布守卫**：CDN 上三个 `latest*.yml` 都要能取到，且**版本号 == 最新的 v\* 标签**
    —— 专门挡"推了 tag 却忘了补传 yml"这种无声故障（客户端只会一直读到旧版本，没有任何报错）；
  · C 段端到端：用**真实的 `GenericProvider`**（只把 HTTP 层换成 Node fetch）请求我们的 CDN，
    确认它能解析出版本号、请求确实带 `noCache`，并有负向对照证明不是"永远成功"。

## [1.0.26] - 2026-10-01

两件事：把 macOS 上「点了没反应」的升级提示改成真能用的出口；并让壳启动 DSH 时
改用**我们自己的 profile**，不再往 DSH 自带的 profile 里写东西。

### 修复
- **macOS 上点「立即下载」之后什么都没发生。** 原因是 macOS 的自动更新要求 App 具备
  苹果开发者签名（Squirrel.Mac 的硬要求），我们的是 ad-hoc 签名 —— 下载能完成，
  **安装那一步必然被系统拒绝**。实测：ad-hoc 的 designated requirement 是 cdhash，
  每次构建都变，用 1.0.24 的要求校验 1.0.25 的包，系统判定不合格（退出码 3）。
  现在 macOS 上改成如实告知「需要手动下载」并给「打开下载页」按钮，不再演一遍
  「下载完成 → 重启 → 什么都没发生」。签名与否是**运行时探测**的（读 `codesign -dv`
  找 Developer ID），将来真去签名了会自动回到自动更新，不需要改代码。
- **注入看护循环在 profile 尚未创建时空转。** 老用户升级后 DSH 进程仍是上一版拉起的
  （`keepDshRunning=true` 会保留），新 profile 不会立刻出现；此时看护循环会每 2 秒
  白跑一次并刷「注入行被覆盖，已补回」的假告警，持续 60 秒。现在 profile 不存在时
  按「无可看护」处理。

### 变更
- **DSH 启动改用自有 profile（`deepwhale`），不再用自带的 `web`。**
  `web` 是 DSH 自带的 profile，会在设置导入、版本升级时被 reconcile 重写 ——
  2026-09-27 实测到的「设置导入把注入的三行整段覆盖」就是它。现在从自带模板派生一个
  归我们所有的 profile（首启带 `--from-default-profile web`，之后不再带 —— 重复带会
  让 DSH 直接报 `already exists`）。注入、启动参数、兜底命令共 6 处统一走
  `src/main/profile.ts` 的常量。
  · 会话 / 设置 / 凭据都在 `$DSH_HOME` 级，**不在 profile 里，不会因此丢数据**；
  · 老用户的 `profiles/web` 原样保留，不做迁移、不删除；
  · 首次启动的可见性仍由 **home 级 patch** 保证（它是主力机制，先于 DSH 启动即可写），
    profile 级只是兼容性兜底。
- **`scripts/sync-to-obs.js` 新增 `--no-exclude` 开关**：更新链路要用的
  `latest*.yml` / `*.blockmap` 平时被默认排除（官网不需要），补传时用开关而不是
  去改默认行为。

### 测试
- 新增 `scripts/test-profile.js`（17 项：profile 名的两个硬约束、首启判断、
  兜底命令改写、以及「源码里不许再写死 `profiles/web`」的静态守卫）。
- 新增 `scripts/test-mac-update-gate.js`（15 项，含本机实证与对照组）。
- `test-inject-race.js` / `check-legal-preset-roster.js` 改为跟随 profile 常量，
  不再写死 `web`（写死会去 dump 另一个 profile 而**误报**花名册缺预设）。
- 新增 `npm run test:profile` / `npm run test:mac-gate`。

## [1.0.25] - 2026-09-30

把已经改好、但**没进上一个包**的两件事真正发出去；并关掉一处会默认改变用户环境的改动。

> 背景：1.0.24 的 asar 构建于当天 10:41，而 `attachments` 修复（16:42）与下载进度（16:44）
> 两个提交都在其后 —— 也就是说**用户手上那份 1.0.24 不含这两个修复**。本版是把它俩补进包里。

### 修复
- **迁移旧 home 时 `attachments` 整个目录被跳过，图片全丢。**
  症状是会话里引用图片时报 `TRANSPORT`（"DeepSeek Messages transport failed"），
  看起来像网络故障，实际是附件一个都没搬过来（真实事故里丢了 44 个对象）。
  根因在 `src/main/legal-mode.ts`：迁移循环按**目录**粒度判断「目标已存在就跳过」，
  而 DSH 首次启动会先建一个空的 `attachments/`，于是整目录被跳过。
  改为 `mergeDirTree()` 逐文件补缺、已有文件不覆盖（避免半覆盖出乱状态）。
  附离线回归测试：`npm run build && node scripts/test-migrate-attachments.js`。
- **点「立即下载」之后界面毫无反应。** `download-progress` 一直在采集，但
  `onStateChange` 是个可选回调、没有任何人接，采到的进度被直接丢掉。
  现在接上两处可见反馈：托盘提示文字（悬停显示「正在下载更新 N%」）与 Dock/任务栏进度条；
  非下载阶段还原。整段包在 `try` 里 —— 进度显示失败绝不影响更新本身。

### 变更
- **「手机连接」（让局域网里的手机连上桌面端）改为默认关闭。**
  用户已叫停手机端方向，并要求「要做就一次做全」：只把 DSH 绑到 `0.0.0.0`、
  却不给用户「地址 + token」的入口，用户拿不到任何好处，同 WiFi 下的其他人却多了一个入口。
  接口代码保留在 `src/main/mobile-connect.ts`（幂等、已测），开关为设置里的 `lanAccess`，默认 `false`。
  已核查：本机随包环境的 `cordis.patch.yml` 不含 `webserver` 块，未被此前调试污染。

## [1.0.24] - 2026-09-29

**随时打开律师端**：新增 `/lawyer` 命令；并把「法律模式」改回"每次手动选"，不再改默认预设。

### 新增
- **`/lawyer` 命令：在任何会话里随时打开深鲸·律师端**

  为什么需要它：DSH **锁死会话的 Agent 预设** —— 一个会话只要跑过一轮 AI，它的预设就写进日志了，
  再切会被宿主直接拒绝（`PresetLockedError`）。所以"聊到一半想用律师端，就去选法律模式"
  这条路天生走不通，而律师端又是个独立 App，本来不必绑在预设上。

  用法：在输入框里打 `/lawyer` 回车 → 律师端弹出（`/` 菜单里显示「打开深鲸·律师端（律师工作台）」）。
  命令名只能是英文小写（DSH 的规则 `^[a-z][a-z0-9_-]*$`，中文名不合法），描述是中文。

  实现：命令跑在 **DSH 宿主**里（不是界面里），按平台调系统打开器
  （macOS `open` / Windows `start` / Linux `xdg-open`），所以**三系统同一套代码**；
  打不开时给出明确提示（没装 / 没打开过一次 / 被移走）。
  macOS 本机实测：handler 执行后律师端确实被拉起。

### 变更
- **「法律模式」不再影响默认预设**（用户决定）：1.0.23 曾经做成"首页选了法律模式，默认预设就跟着变"，
  但那会导致**以后每个新会话都自动是法律模式、一进去就弹律师端** —— 用户明确不要这个效果
  （"不要默认法律模式，需要再手动选择"）。现在默认预设只由设置页写，法律模式是**每次按需选**。
  「设置 → Agent 预设 → 设为默认」这条仍会让律师端弹出（只读不写）。

### 修复
- 上一版 1.0.23 的其余修复保持不变：预设 id 兼容（`legal` / `legal-mode`）、同一次切换只弹一次。

## [1.0.23] - 2026-09-29

把「法律模式」从"看起来在"修到"真的能用"：**切到法律模式会拉起律师端**，
**首页选什么模式，Agent 预设的默认值就跟着变成什么**。

### 修复
- **切到法律模式弹不出律师端（本轮核心）**

  1.0.22 让「法律模式」进了花名册、也能正常加载，但**拉起律师端的两条路径一次都没触发过**。

  根因：插件 `ui-legal-mode` 认的预设 id 是 `legal-mode`，而 1.0.22 把预设从
  `.agent-presets/<id>/` 目录改成 bundle 声明时，声明的 id 是 **`legal`** ——
  会话投影实测就是 `"agentPreset": "legal"`，两边对不上，判断永远为假。

  修复：插件按 `legal` / `legal-mode` 两个 id 都认（后者兜住旧布局下建立的会话）。

- **首页选的模式与 Agent 预设不同步（用户要求：必须同步）**

  DSH 上游的行为是：首页那颗 chip 只**暂存下一个会话**要用的预设，它不写"默认预设"；
  设置里写的才是默认预设。所以首页切到法律模式后，设置里仍显示 Standard，
  下一次新建会话又回到 Standard。

  修复：首页 chip 把选中的预设交给会话后，**壳的插件把同一个值写进默认预设**
  （实测抓到的写入帧：`settings/update {"ns":"agent-preset-registry","selectedDefault":"legal"}`），
  设置里的默认值随即跟随；切回 Standard 时同样跟回去。

  写入的命名空间用**新运行时的** `agent-preset-registry.selectedDefault`；
  老运行时的 `agent-presets.default` 作为兜底一并尝试，两种 DSH 都能用。

### 加固
- **同一次切换只弹一次律师端**：会话路径与默认预设路径会同时观察到同一次切换，
  加了 2 秒去重窗口，避免在"没装律师端"的机器上弹两次失败提示。

## [1.0.22] - 2026-09-29

修掉「法律模式」预设显示**加载失败**的问题，并按你的要求改掉版本号文案。

### 修复
- **「法律模式」预设加载失败（本轮核心）**

  1.0.21 让「法律模式」出现在了 Agent 预设列表里（上一版三平台都找不到它），
  但卡片上标着**加载失败**。

  根因：预设引用的 `@deepseek-ai/dsh-workflow-worker-thread` **在这个运行时里已经被改名**
  成 `@deepseek-ai/dsh-workflow-ptc`。DSH 的花名册对"引用了解析不到的包"的预设
  会标成 broken —— 用户看到的就是「加载失败」。

  运行时自带的技能文档早就警告过这一点（"check each plugin name … because packages
  renamed since the preset was written fail at activation"），而我当时只验了
  "声明出现在组合树里"，**没验"里面每个包都能解析"** —— 又是一次断言没落在终点上。

  修复：把该行改成 `@deepseek-ai/dsh-workflow-ptc`（与随包 standard 预设同位置同配置）。

- **版本号文案**：设置页「当前版本」旁边原本显示「深鲸壳 1.0.21」，
  改为 **`DeepWhale Desktop 1.0.22`**（与产品名一致）。

### 加固
- `build-legal-preset-bundle.js` 新增断言：预设里**每一个插件名**都必须能在随包运行时
  解析到，否则构建直接失败并列出缺失的包名。
  否定测试：把包名改回已废弃的 `dsh-workflow-worker-thread` → 退出码 1 并点名。

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
