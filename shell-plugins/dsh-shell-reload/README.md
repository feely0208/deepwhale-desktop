# dsh-shell-reload · ⇧⌘R 重新加载界面

> 给深鲸桌面补一个 **⇧⌘R（Windows/Linux：Shift+Ctrl+R）重新加载界面**。

## 为什么需要它

深鲸桌面的应用菜单里没有「视图」，也就没有 Electron 的 `reload` 角色 ——
而 macOS 的快捷键来自应用菜单，所以**按键从来没被绑上，按了什么都不会发生**。

踩到的场景很具体：改完一个 DSH 插件，让用户"刷新一下看看" —— 用户按 ⌘R，
界面纹丝不动，于是变成"我改了、你刷新了、界面没变"的扯皮。
而且**关窗口也救不了**：主窗口 `closed` 之后 `mainWin = null`，
而 `app.on('activate')` → `showMainWindow()` 是 `if (mainWin) { … }`，
null 时什么都不做 —— 窗口再也回不来，只能从托盘退出重开。

## 怎么做的

**不改桌面端**，用 DSH 自己的**快捷键服务**（`ctx.shortcuts`）注册一条命令：

```js
ctx.effect(() => ctx.shortcuts.register({
  id: 'shell.reload',
  label: () => '重新加载界面',
  defaults: { 'desktop:macos': { code: 'KeyR', modifiers: ['primary'] }, …七档全给… },
  regions: ['page', 'editable'],
  resolve: () => ({ status: 'handled', run: () => window.location.reload() }),
}), 'shell-reload: ⇧⌘R');
```

**为什么不自己监听 keydown**：`ctx.shortcuts` 是宿主能力，它顺带给了四件自己写就没有的东西 ——
冲突检测（重复 id / 默认组合重叠会在注册时直接拒绝，而不是悄悄抢键）、
按设备分平台（`desktop:macos` / `web:windows` …）、
用户改键（改绑在同一设备上跨刷新保留）、
以及自动进入「快捷键」设置页与速查表。

`regions` 带上 `editable` 是有意的：用户常在面板的文本框里敲完才发现界面是旧版，
这时候按 ⇧⌘R 应该照样重载（它不是任何文本编辑键，不会抢输入）。

## 为什么是 ⇧⌘R 而不是 ⌘R

**⌘R 已经被官方占了**：`@deepseek-ai/dsh-client-ui-sidebar-right` 的
「刷新当前页面」(`page.refresh`) 在 `desktop:macos|windows|linux` 上绑的就是
`KeyR + primary`（`web:windows` 是 `primary+alt`）。

而 `ctx.shortcuts.register()` 对**默认组合重叠**是**直接抛错**的：

```js
if (other !== undefined && overlappingBindings(binding, normalizeBinding(other, platform)))
  throw new Error(`Conflicting shortcut defaults: ${command.id} and ${existing.id} (${runtime}:${platform})`);
```

所以绑 ⌘R 不是"抢键"，而是**注册失败 → 本插件激活失败**，会在插件列表里变成一个失败项。
桌面端菜单那条同理：菜单快捷键会**吞掉按键、不再传给页面**，用 ⌘R 会把右侧栏的刷新抢掉。

⇧⌘R 全库无占用（逐包核对过），而且它本来就是浏览器里"重新加载"的通用手势。

## 为什么 `location.reload()` 就够

DSH 的 index 出口**每次请求都重新渲染启动图**（`dsh-host-frontend-static` 的
`renderIndex()` 在请求里现算），插件 bundle 的 URL 又带 `rev=` ——
所以一次普通重载拿到的就是当前这份插件图与当前这份代码。
不额外拼时间戳参数：index 出口带会话校验，塞未知查询参数有风险。

## 装了之后

- ⇧⌘R / Shift+Ctrl+R：重新加载界面（七个平台档位都绑了 `primary + shift + KeyR`）
- 想改键：设置 → 快捷键（这是 `ctx.shortcuts` 自带的，我们没做额外工作）
