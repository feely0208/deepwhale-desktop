/**
 * dsh-shell-reload —— 客户端半边。
 *
 * ── 它解决的问题 ─────────────────────────────────────────────────────
 * 深鲸桌面的应用菜单里**没有「视图」，也就没有 `reload` 角色**。macOS 的快捷键
 * 来自应用菜单，所以**按键从来没被绑上**：改了插件让用户"刷新一下看看"，
 * 用户按了没反应 —— 界面一直是旧的那份。而关窗口也不行（`mainWin` 关闭后置 null，
 * `activate → showMainWindow()` 在 null 时什么都不做，窗口就回不来了）。
 *
 * 这里用 **DSH 自己的快捷键服务**（`ctx.shortcuts`）把这一键补回来 ——
 * 好处是**不用改桌面端**：DSH 的 Web 载体、桌面载体都能用，装上就生效。
 *
 * ⚠️ 键位是 **⇧⌘R**，不是 ⌘R —— 理由见下面 `defaults` 的注释（⌘R 被官方占了）。
 *
 * ── 为什么走快捷键服务而不是自己监听 keydown ─────────────────────────
 * `ctx.shortcuts` 是宿主的能力：它管**冲突检测**（重复 id、默认组合重叠都会在注册时
 * 直接拒绝，而不是悄悄抢键）、管**按设备分平台**（desktop:macos / web:windows …）、
 * 管**用户改键**（改绑在同一个设备上跨刷新保留），还会把这条命令列进
 * 「快捷键」设置页与快捷键速查表。自己 `addEventListener('keydown')` 这些全都没有，
 * 而且会和宿主的按键处理打架。
 *
 * 官方 README 的原话：Feature plugins register commands through `ctx.shortcuts`
 * inside `ctx.effect()`.
 */

window.__ModuleLoader__.load({
  id: '@deepwhale-cn/dsh-shell-reload',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    /** 需要注入的客户端服务：快捷键注册表。 */
    const inject = ['shortcuts'];

    /**
     * 七个平台档位各给一份默认绑定：**⇧⌘R**（`primary + shift + KeyR`）。
     *
     * ⚠️ **不能用 ⌘R** —— 它已经被官方占了：`@deepseek-ai/dsh-client-ui-sidebar-right`
     * 的「刷新当前页面」(`page.refresh`) 在 `desktop:macos|windows|linux` 上绑的
     * 就是 `KeyR + primary`（`web:windows` 是 `primary+alt`）。
     * 而 `ctx.shortcuts.register()` 对**默认组合重叠**是直接抛错的：
     *
     *     if (other !== undefined && overlappingBindings(binding, normalizeBinding(other, platform)))
     *       throw new Error(`Conflicting shortcut defaults: ${command.id} and ${existing.id} …`);
     *
     * 也就是说：绑 ⌘R 不是"抢键"，而是**注册失败 → 本插件激活失败**，
     * 会在插件列表里变成一个红色的失败项。实测核对过：全库只有 page.refresh 绑 KeyR，
     * 而 `KeyR + primary + shift` 七个档位全都空着；⇧⌘R 本来也是浏览器里"重新加载"的通用手势。
     *
     * 几个档位：**只能写五个** —— `desktop:macos|windows|linux` + `web:macos|web:windows`。
     *
     * ⚠️ **绝对不能写 `web:linux`**（2026-10-08 实测踩到，整页变成 `Failed to load plugins`）。
     * 宿主的校验是**遍历全部 6 个 runtime×platform 组合**的（`dsh-client-shortcuts`）：
     *
     *     for (const runtime of ["desktop","web"])
     *       for (const platform of ["macos","windows","linux"]) {
     *         const candidate = resolveShortcutDefault(command, runtime, platform);
     *         if (candidate === undefined) continue;
     *         if (runtime === "web" && !isWebBindingAllowed(binding, platform))
     *           throw new Error(`Unsupported Web shortcut: ${command.id}`);
     *       }
     *
     * 而 `isWebBindingAllowed` 对 **linux 没有分支**，直接落到一个硬编码白名单
     *（只有 `Slash+primary` / `Comma+primary+shift` / `Period…` 这几个）——
     * `KeyR` 不在里面 → **`Unsupported Web shortcut: shell.reload` 抛错 → 本插件激活失败**。
     *
     * 为什么官方这么设计：Web 载体跑在浏览器里，Linux 上浏览器自己的快捷键不能被插件抢走，
     * 所以只放行极少数组合。官方自己的快捷键（如右侧栏 `page.refresh`）也**从不写 `web:linux`**。
     *
     * 诊断为什么费劲：这个错**只在浏览器侧**报（`web boot: N entry did not activate`），
     * 宿主进程一声不响 —— 而它又只在"插件真的被加载"时才发生，
     * 所以在本机手动装的 profile 里可能一直没暴露。
     *
     * 那为什么不只写一个档位：`defaults` 是**按设备**取的，省略某个档位就是"那一档不绑"——
     * 所以宁可把**允许的**档位写全，也不要漏一个让某类设备上没键可用。
     * `primary` 会展开成该设备的主修饰键（macOS ⌘ / 其它 Ctrl）。
     */
    const RELOAD_R = { code: 'KeyR', modifiers: ['primary', 'shift'] };
    const defaults = {
      'desktop:macos': { ...RELOAD_R },
      'desktop:windows': { ...RELOAD_R },
      'desktop:linux': { ...RELOAD_R },
      'web:macos': { ...RELOAD_R },
      'web:windows': { ...RELOAD_R },
      // 'web:linux' 故意不写：见上面的说明，写了会抛 Unsupported Web shortcut。
    };

    function apply(ctx) {
      ctx.effect(() => ctx.shortcuts.register({
        id: 'shell.reload',
        label: () => '重新加载界面',
        aliases: ['reload', 'refresh', '重新加载', '刷新界面', '重载'],
        defaults,
        // 输入框里也要能用：用户经常是在面板的文本框里敲完东西、发现界面是旧版，
        // 这时候按 ⌘R 应该照样重载（⌘R 不是任何文本编辑键，不会抢输入）。
        regions: ['page', 'editable'],
        modals: [],
        resolve: () => ({
          status: 'handled',
          run: () => {
            // 直接 reload 就够：DSH 的 index 出口每次请求都重新渲染启动图
            // （`frontend-static` 的 `renderIndex()` 在请求里现算），
            // 而且插件 bundle 的 URL 带 `rev=`，前端资源本身也不会拿旧的。
            // 不额外拼时间戳参数 —— index 出口带会话校验，塞未知查询参数有风险。
            window.location.reload();
          },
        }),
      }), 'shell-reload: ⇧⌘R 重新加载界面');
    }

    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  },
});
