# dsh-shell-canvas · 深鲸画布面板

> 深鲸桌面（DSH）里的一块面板：**选模板 → 填参数 → 校验 → 预览 → 出横竖双版成片 → 打开成片**。
> 引擎是 `canvas/`（深鲸画布内核，S0–S2 已冻结）——**这个插件只是外壳，一行业务内核都没改**。

---

## 一、它挂在宿主的哪儿（先用 `cordis_inspect_query` 查过，没猜）

| 挂点 | 槽位 | 为什么是它 |
|---|---|---|
| 侧栏图标 | `sidebar.panellist`（list，owner `ui-sidebar`） | 槽文档原话："Each list id addresses the matching main panel; the sidebar owns the button and resolves its label from list metadata." 注册 `{id:'canvas', order:20, label:'深鲸画布'}`，侧栏多一个按钮，点击由 ui-sidebar 自己调 `ctx.layout.selectPanel('canvas')` |
| 中间面板 | `main`（keyed） | 已有的 key 是 `conversation` / `plugins` / `schedules`（壳自己注册的）；我们占一个新 key `canvas`，不动任何自带界面 |
| 数据出口 | `ctx.webServer.register({kind:'prefix', path:'/dsh-canvas'})` | 与页面同源：`<video>` 能直接播、进度能用 SSE 推、不需要额外握手。DSH 的 `/api` 桥有会话鉴权，而**具名路由是公开的**，所以出口自己做回环校验 + 目录越界校验 |

两个槽的 `replaceRisk` 都是 `none`（新增 id / 新增 key），不会遮蔽任何自带 UI。

**界面是自绘的**：官方规范要求"不要 `require` 任何 Harness 客户端包"
（`@deepseek-ai/dsh-client-ui-primitives` 之类随时会变，纯 JS 插件没有类型检查，
一个组件抛错就把整个槽位打白）。所以控件按宿主的样子自己写，颜色只用主题令牌
`--dsw-alias-*`，明暗主题自动跟随。

---

## 二、三半边

```
lib/index.js        宿主半边（cordis 插件）
                    · 定位引擎目录（探测链 + 用户可覆盖）
                    · 校验闸门（校验不过 → 422，**不起子进程**）
                    · 起渲染子进程、收 JSONL 进度、取消、续渲
                    · /dsh-canvas HTTP 出口（state/validate/job/cancel/events/file/upload/reveal）
lib/engine.mjs      引擎定位 + 模板目录 + 校验 + 错误码人话提示
lib/jobs.mjs        任务管理器（子进程生命周期、进度、取消、续渲、运行时探测）
lib/pipeline-run.mjs  **任务执行体**：真正调引擎的那段（两个入口共用）
lib/worker.mjs      Node 子进程入口（Chromium 后端）
lib/osr-main.cjs    Electron 主进程入口（Electron OSR 后端）
lib/client.js       客户端半边（面板 UI，单文件、`__ModuleLoader__.load`）
```

### 为什么要子进程（不是"最好"，是"必须"）

交接文档 §4.3 第一条：本地神经 TTS 走 `sherpa-onnx-node`，**原生库崩了会 abort 整个进程**，
JS 的 `try/catch` 拦不住。跑在子进程里，最坏情况只死这一个任务。
顺带满足 §4.2 第 4 条"插件不阻塞 UI"。

两个入口的 stdout 协议**逐字相同**（一行一个 JSON），宿主只有一套解析：

```
{"t":"gate","value":{...}}        校验闸门结果
{"t":"step"|"log","..."}          人看的进度
{"t":"progress", done,total,pct,msPerFrame,etaMs}
{"t":"result","value":{...}}      成功
{"t":"error", message, cancelled, validation}
```

### 取消 vs 被杀 —— 两件不同的事

§4.2 第 2 条把这两件事分开要求，所以实现上也分开：

| 场景 | 做法 | 结果 |
|---|---|---|
| **取消**（界面按钮） | SIGTERM → 引擎优雅收手（落 `partial` manifest）→ 宿主**删掉产物目录** | "取消后不残留半成品" |
| **被杀**（`kill -9` / 进程崩） | 宿主来不及清理，帧与 manifest 留在盘上 | 重跑时 `resume:true` 跳过已渲帧，日志出现 **`续用 N`** |

界面上两个按钮都给了：**取消并清理** / **取消但留断点**。

### 断点续渲落在哪一层

引擎的 `renderTemplate({resume:true})` 会读 `frames/manifest.json`，
把已渲好且指纹一致的帧标成 `resumed`。要让它生效需要**保帧**
（`keepFrames:true`），否则成片合流后逐帧 PNG 就被删了。

`produce()` 没有对外暴露 `resume`，而 S3 的约束是**不改内核**，
所以 `pipeline-run.mjs` 把同一条链路按阶段拼出来（顺序与 `produce()` 完全一致）：

```
拆句 → 配音(synthVoiceTrack) → 字幕(buildCuesFromText) → 横竖双版(renderTemplate, resume:true)
     → 混音(mixVoiceAndBgm) → 合流(muxAudio)
```

每一步都调**引擎自己导出的函数**，外壳只负责"顺序 + 进度 + 取消 + 续渲"。
配音也做了复用：`<outDir>/.voice-cache.json` 里记着脚本 SHA-256，
重跑时脚本没变就直接用现成的 `voice.wav`（TTS 是整条链路里最慢的一步）。

> **建议（留给 S4）**：把 `resume` / `keepFrames` 提升为 `produce()` 的正式参数，
> 外壳就能回到"只调 produce()"，这份分步编排也就不必存在了。

---

### 客户端半边踩过的坑（第一次上线就翻车）

**`...(cond ? arr.map(…) : el)` 会在首屏炸掉整个槽位。**

首屏 `state` 还是 `null`、`templates` 是空数组，于是三元表达式走了 `el` 分支 ——
那是一个 **React 元素对象**，而 `...` 展开要求可迭代对象 → `TypeError`。
DSH 对槽位组件抛错的处置是**把整块打白**（控制台留一句
`slot entry crashed in '<slot>'`），所以用户看到的是：侧栏入口在、点进去一片空白，
**没有任何线索**。查了半天才发现是这一行。

两条教训：
1. `...(a ? xs : y)` 里 `y` 一定要是数组 —— 写成 `[y]`。
2. **给面板加错误边界**（`PanelBoundary`）：再出这种问题，面板会把错误原文画出来，
   而不是留白。这不是替代修 bug，是让"什么都没显示"不再是无解的。

另外：**图片加载失败要显式兜底**。模板海报一度因为文件被误删而变成"裂图 + 空框"，
比"没有图"更显廉价 —— 现在 `Poster` 组件 `onError` 会退回占位样式。

## 三、插件图标规格（**踩过一次，照这个来**）

第一版图标是 24×24 viewBox + 1.8px **细描边** + 单色青。用户看了一眼插件列表就说：
"其他插件的图标比较有逼格，我们这个太普通了，没点科技感。"

对照宿主自己的默认插件图标（`@deepseek-ai/dsh-client-ui-primitives` 的
`PluginArtworkDefault`，直接读的源码）才发现差在哪：

| 项 | 宿主默认 | 我们（第一版） |
|---|---|---|
| viewBox | **36×36** | 24×24 |
| 画法 | **纯填充块面** | 1.8px 细描边 |
| 配色 | **线性渐变 `#54ECE7 → #658EFF`**（青→蓝） | 平面单色 `#3FD0E0` |
| 容器 | 48×48 卡片框（`.cardIcon`：radius-lg + 0.5px 描边），图形 36px | 同 |

**规格（照抄宿主，就不会显得是外人）**
1. `viewBox="0 0 36 36"`，按 36px 呈现；
2. **填充**而不是描边；确需描边时线宽给到 **3.2 左右**（36px 下细线会糊成灰）；
3. 渐变用宿主那一对色：`#54ECE7 → #658EFF`（`linearGradient` + `userSpaceOnUse`）；
4. **图形占约 25×20，不要满框** —— 满框会顶到 48px 卡片框的边，显得挤；
5. 深色/浅色都不用两套：填充形状自带色，不依赖 `currentColor`。

> 侧栏那个图标（`sidebar.panellist`）**相反**：它和「插件」「自动化任务」并排，
> 邻居都是 `currentColor` 的单色线性图标 —— 那里就该保持单色描边，别放渐变。

## 四、引擎从哪来
引擎（`canvas/`）是**独立工程**，不随本插件分发。定位链（`lib/engine.mjs`）：

1. 面板里「引擎设置」指定的目录（写进 `$DSH_HOME/dsh-canvas.json`，持久化）
2. 环境变量 `DSH_CANVAS_ROOT`
3. `~/DeepSeek Harness/canvas` → `~/deepwhale-canvas` → `~/canvas`

判定"这是引擎根"要看这五样都在：`src/pipeline.mjs`、`src/validate.mjs`、
`src/render/index.mjs`、`packs/video/domain.json`、`templates/`。
**找不到时不报一句"找不到"**，而是把"探测过哪些位置、各自缺什么"原样列在界面上。

---

## 五、Electron OSR（S1 留的验收，S3 补上）

### 接线方式

`lib/osr-main.cjs` 是一个 **Electron 主进程**入口，用 `ELECTRON_RUN_AS_NODE` 之外的方式启动，
在离屏 `BrowserWindow` 上跑引擎**自己那个** `ElectronOsrAdapter`。
两个后端（Chromium / Electron OSR）在 `pipeline-run.mjs` 里只差 `makeAdapter` 一行。

渲染尺寸不同的两版要各建一个窗口（`renderTemplate` 会在 finally 里 `close()` 适配器），
所以 `makeAdapter` 是"每个方向造一个"。

### 顺手逮到的两个 S1 真 bug

`src/render/adapter-electron.mjs` 在 S1 **从没被执行过**（它是"接口形态与实现路径"），
一跑就露了两个：

1. **断网过滤把页面自己也拦了**。原来是无条件 `onBeforeRequest(cb => cancel:true)`，
   而这个适配器是用 `data:text/html,...` 装载页面本身的 —— 全量 cancel 让
   `loadURL` 直接 `ERR_BLOCKED_BY_CLIENT(-20)`。
   → 改成按协议过滤（只拦 http/https/ws/wss/ftp），`data:`/`blob:` 放过。

2. **首帧抓到的是"setFrame 之前"的合成结果**。`prepare()` 只等 `loadURL`，
   没等页面的 `window.__canvas.ready`（字体 + 图片解码 + 第一遍 `setFrame(0)`），
   于是第 0 帧画面看着像、状态不对。
   → `prepare()` 里等 ready，并显式丢掉一次加载期的 paint 做预热。

3. **paint 会偶发落在"上一次提交"上**（8 帧里偶发 1 帧，且**不是固定偏移** ——
   实测第 199 帧交出的是第 45 帧的画面）。固定"多等一拍"治不干净。
   → 改成**自证式取帧**：同一帧连取两次，两次哈希一致才认。要的是"结果可复现"，
   而不是"等够久"。

### 验收结果

| 项 | 结果 |
|---|---|
| OSR 出帧 vs Chromium 出帧，同一模板同一帧 PNG 字节 | ✅ **29/29 帧逐字节一致**（帧号 0–23、45、120、199、200、299，1080×1920） |
| 重复运行自洽 | ✅ 4 次独立运行，8 帧哈希全同 |
| 速度 | ≈170–220 ms/帧（Chromium 是 ≈82 ms/帧，所以默认仍是 Chromium，OSR 作为可选后端） |
| Electron 版本 | 44.0.0（Chromium 152.0.7977.54），与深鲸桌面 1.0.53 自带的一致 |

> ⚠️ **一个必须知道的边界**：能跑 OSR 的 Electron 必须是"**愿意执行我们给的脚本**"的那种。
> 打包过的 `DeepWhale Desktop.app` 会无视 argv 里的脚本路径、直接加载自己的 `app.asar`，
> 所以它自己**不能**当 OSR 宿主。`lib/jobs.mjs` 的 `probeElectron()` 因此是
> **真跑一个探针脚本**来判断可用性，而不是看文件存不存在；
> 找不到就明说"OSR 不可用"，并且**照常可以用 Chromium 后端出片**。

### 接这一路时踩到的三个坑（都写进代码注释了）

1. **Electron 默认"所有窗口关闭就退出 app"**。横竖双版是两个窗口，竖版渲完 `destroy()` 掉窗口，
   整个进程静默退出：退出码 0、没有任何结果，而进度条已经 100%。
   → `app.on('window-all-closed', () => {})` 显式关掉默认行为。
2. **`process.exit()` / `app.exit()` 会吞掉还没冲出去的 stdout**。stdout 是管道、`write` 是异步的，
   最后一行往往正是 `{"t":"result"}`。→ 收尾"再写一个哨兵块、等它的回调"（Node 保证 FIFO）。
3. **`ELECTRON_RUN_AS_NODE` 会传染**：DSH 宿主自己就是它起来的，子进程若原样继承，
   Electron 退化成纯 Node，`require('electron')` 拿不到 `BrowserWindow` —— 报错却是"找不到模块"。
   → 起子进程时 `delete env.ELECTRON_RUN_AS_NODE`。

---

## 六、合规边界（一条都没松）

- **AI 标识**：模板的 `meta.aiGenerated` 会显示在模板卡片上（立项决策 10）。
- **BGM**：S3 **不提供 BGM 选择**。台账里只有一条标注 `inApp:false / 禁止用于对外发布物`
  的合成测试音，真实曲目必须先走 `bgm-license-audit` 入库。
- **音色**：**不做音色库、不做音色选择 UI**（立项决策 6）。界面只有两个选项：
  内置兜底音色（中英切段混读，华言 + lessac），或**你自己的配音文件**（`voiceoverFile`，完全跳过我们的 TTS）。
- **素材不出本机**：图片/配音走一次回环 HTTP 交给宿主落盘（浏览器拿不到真实路径），
  落到本机产物目录下的 `uploads/`，只有绝对路径给渲染子进程。
- **渲染进程断网**：两个适配器都装了按协议过滤的 `webRequest` 拦截。
- **出口只对本机开放**：`/dsh-canvas` 只接受回环地址来的请求；`/api/file` 只肯读产物目录内的文件。

---

## 七、怎么装、怎么验

源码在 `shell-plugins/dsh-shell-canvas/`（随仓库提交）。
`scripts/build-bundled-plugins.js` 会把它拷进 `bundled-plugins/`，
`src/main/bundled-plugins.ts` 的清单会在启动时注入到 `$DSH_HOME/plugins/` 并软链进 profile。

```bash
node scripts/build-bundled-plugins.js     # 生成 bundled-plugins/dsh-shell-canvas/
```

改完源码记得重跑这一步 —— 漏了它，**本机能用、用户装了没有**（这是这个仓库踩过的老坑）。
