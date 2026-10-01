/**
 * dsh-shell-session-actions —— 客户端半边。
 *
 * ── 它是什么 ─────────────────────────────────────────────────────────
 * DSH 的会话「…」右键菜单是一个**插槽**：`sidebar.workspaces.session.menu.item`
 * （list 槽，owner 是 client-ui-workspace，自带 pin=100 / rename=200 / fork=300 /
 * archive=400）。本插件往这个槽里追加五行，排在最后（500/510/520/530/540）：
 *
 *   在访达中打开（Windows：在文件资源管理器中显示 / Linux：在文件管理器中显示）
 *   打开所在文件夹
 *   复制文件路径
 *   复制会话 ID
 *   反馈问题（打开官网反馈页，并把本会话的 ID 与标题预填进去）
 *
 * 第五行只透传会话 ID 与标题，**不传任何文件路径** —— 反馈页那边只需要能定位到
 * 会话，路径是隐私，不送出去。
 *
 * 每行点击后经 `window.dsh.sessionAction(...)` 桥到 Electron 主进程完成真实动作
 * （找回话文件、showItemInFolder / openPath / clipboard）。浏览器里直接打开 DSH 时
 * 没有这个桥，此时**静默不报错**，只是点了没反应。
 *
 * ── 为什么是这种形态 ─────────────────────────────────────────────────
 * DSH 的客户端插件不是打包产物，而是宿主提供的模块加载器：`require("react")`
 * 等由宿主提供（见 @deepseek-ai/dsh-client-modules 的 boot 图）。所以这里手写
 * `__ModuleLoader__.load`，不引入任何依赖、不需要打包器。
 *
 * 菜单行的样子优先复用官方 `@deepseek-ai/dsh-client-ui-primitives` 的
 * `MenuItemButton`（与 DSH 自带的 pin/rename/fork/archive 完全同款，含
 * separatorBefore 分组线）；只有在运行期解析不到该模块时才退回一个自绘按钮。
 * 解析放在**组件渲染时**（而不是模块加载时）做：菜单只会由 client-ui-workspace
 * 渲染，而那时 ui-primitives 必然已被它 materialize，parse 一定命中。
 *
 * 关闭菜单走 owner 注入的 `useMenuOpenState`（DSH 自带各行都是这个写法）；
 * 菜单列表的键盘遍历读 DOM，因此任意 `role="menuitem"` 按钮都会自动加入。
 */
window.__ModuleLoader__.load({
  id: '@deepwhale-cn/dsh-shell-session-actions',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const react = require('react');

    /** 目标插槽：一个会话的「…」菜单行，按 order 升序。 */
    const SLOT = 'sidebar.workspaces.session.menu.item';
    /** 本插件自己的 id 前缀（插槽文档要求 id 带包命名空间，避免与自带行冲突）。 */
    const NS = 'dsh-shell-session-actions';

    /** 需要注入的客户端服务：slots（插槽注册表）。 */
    const inject = ['slots'];

    // ── 平台判定（只影响第一行的文案）─────────────────────────────────
    // navigator.platform 已废弃但仍有值；userAgent 作兜底。两者都拿不到时按 Linux
    // 文案（最中性的「文件管理器」）。
    const UA = typeof navigator === 'object' && navigator ? String(navigator.userAgent || '') : '';
    const PLATFORM = typeof navigator === 'object' && navigator ? String(navigator.platform || '') : '';
    const IS_WINDOWS = /Windows/i.test(UA) || /Win/i.test(PLATFORM);
    const IS_MAC = !IS_WINDOWS && (/Mac/i.test(UA) || /Mac/i.test(PLATFORM));

    /** 第一行：macOS「在访达中打开」/ Windows「在文件资源管理器中显示」/ 其它「在文件管理器中显示」。 */
    const REVEAL_LABEL = IS_WINDOWS
      ? '在文件资源管理器中显示'
      : IS_MAC
        ? '在访达中打开'
        : '在文件管理器中显示';

    // ── 轻量提示（仅失败时用；不引入 Toast 服务，避免多一份注入依赖）──
    function showToast(message) {
      try {
        const ID = 'dsh-shell-session-actions-toast';
        const previous = document.getElementById(ID);
        if (previous && previous.parentNode) previous.parentNode.removeChild(previous);
        const el = document.createElement('div');
        el.id = ID;
        el.setAttribute('role', 'status');
        el.textContent = String(message);
        el.style.cssText =
          'position:fixed;left:50%;bottom:42px;transform:translateX(-50%);z-index:2147483647;' +
          "max-width:70vw;padding:10px 16px;border-radius:10px;background:rgba(24,24,27,.94);color:#fff;" +
          "font:500 13px/1.45 -apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;" +
          'box-shadow:0 8px 28px rgba(0,0,0,.28);pointer-events:none;opacity:0;transition:opacity .16s ease;' +
          'white-space:pre-wrap;word-break:break-all;';
        document.body.appendChild(el);
        requestAnimationFrame(() => {
          el.style.opacity = '1';
        });
        setTimeout(() => {
          el.style.opacity = '0';
          setTimeout(() => {
            if (el.parentNode) el.parentNode.removeChild(el);
          }, 220);
        }, 2800);
      } catch {
        // 提示本身失败就算了，不能影响主流程
      }
    }

    /**
     * 调壳的桥。`window.dsh` 不存在（浏览器里直接开 DSH）时静默返回。
     * @param kind - reveal | openFolder | copyPath | copyId | feedback
     * @param sessionId - 目标会话
     * @param title - 会话显示名（feedback 会把它预填进反馈页的标题栏）
     */
    function sessionAction(kind, sessionId, title) {
      const bridge = typeof window === 'object' && window ? window.dsh : undefined;
      if (!bridge || typeof bridge.sessionAction !== 'function') return;
      let result;
      try {
        result = bridge.sessionAction({ kind, sessionId, title });
      } catch (error) {
        showToast(`操作失败：${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      if (result && typeof result.then === 'function') {
        result
          .then((response) => {
            if (response && response.ok === false) showToast(response.message || '操作失败');
          })
          .catch((error) => {
            showToast(`操作失败：${error instanceof Error ? error.message : String(error)}`);
          });
      }
    }

    // ── 官方 primitives 的惰性解析（渲染时做，见文件头说明）──────────
    let primitivesResolved = false;
    let primitivesValue = null;
    function primitives() {
      if (!primitivesResolved) {
        primitivesResolved = true;
        try {
          primitivesValue = require('@deepseek-ai/dsh-client-ui-primitives') || null;
        } catch {
          primitivesValue = null;
        }
      }
      return primitivesValue;
    }

    /** 兜底行：拿不到 primitives 时用，仍保证 role="menuitem" / 点击关闭菜单。 */
    function FallbackMenuItem(props) {
      const [active, setActive] = react.useState(false);
      const children = [];
      if (props.separatorBefore) {
        children.push(
          react.createElement('div', {
            key: 'sep',
            role: 'separator',
            style: { height: 1, margin: '4px 6px', background: 'currentColor', opacity: 0.12 },
          }),
        );
      }
      children.push(
        react.createElement(
          'button',
          {
            key: 'btn',
            type: 'button',
            role: 'menuitem',
            onClick: props.onSelect,
            onMouseEnter: () => setActive(true),
            onMouseLeave: () => setActive(false),
            onFocus: () => setActive(true),
            onBlur: () => setActive(false),
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              width: '100%',
              padding: '7px 10px',
              border: 'none',
              borderRadius: 6,
              background: active ? 'color-mix(in srgb, currentColor 10%, transparent)' : 'transparent',
              color: 'inherit',
              font: 'inherit',
              textAlign: 'left',
              cursor: 'pointer',
            },
          },
          [
            props.icon !== undefined
              ? react.createElement('span', { key: 'i', style: { display: 'inline-flex', opacity: 0.75 } }, props.icon)
              : null,
            react.createElement('span', { key: 'l' }, props.children),
          ],
        ),
      );
      return react.createElement('div', { style: { padding: '2px 4px' } }, children);
    }

    /**
     * 造一行菜单项。
     * @param key - 动作名（同时是桥的 kind 与 id 后缀）
     * @param order - 在菜单里的位置（自带行到 400 为止）
     * @param label - 显示文案
     * @param iconName - primitives 里的图标组件名（拿不到就不画图标）
     * @param separatorBefore - 是否在本行前画一条分组线
     */
    function makeItem(key, order, label, iconName, separatorBefore) {
      function ShellSessionActionMenuItem(props) {
        const owner = props || {};
        const sessionId = owner.sessionId;
        const title = owner.displayTitle;
        // owner 通过槽声明的 inject 注入 useMenuOpenState；没有时不做关闭动作。
        // 该 prop 的有无对同一实例是稳定的，所以这里的条件调用不会破坏 Hooks 顺序。
        const menuState =
          typeof owner.useMenuOpenState === 'function' ? owner.useMenuOpenState() : null;
        const setMenuOpen = Array.isArray(menuState)
          ? menuState[1]
          : menuState && typeof menuState.setMenuOpen === 'function'
            ? menuState.setMenuOpen
            : undefined;

        const lib = primitives();
        const MenuItemButton = lib && lib.MenuItemButton;
        const IconComponent = lib && iconName ? lib[iconName] : undefined;
        const icon =
          typeof IconComponent === 'function' ? react.createElement(IconComponent, {}) : undefined;

        const onSelect = () => {
          try {
            if (typeof setMenuOpen === 'function') setMenuOpen(false);
          } catch {
            // 关闭菜单失败不影响动作本身
          }
          if (!sessionId) return;
          sessionAction(key, sessionId, title);
        };

        if (typeof MenuItemButton === 'function') {
          return react.createElement(MenuItemButton, {
            icon,
            separatorBefore: !!separatorBefore,
            onSelect,
            children: label,
          });
        }
        return react.createElement(FallbackMenuItem, {
          icon,
          separatorBefore: !!separatorBefore,
          onSelect,
          children: label,
        });
      }
      ShellSessionActionMenuItem.displayName = `ShellSessionActionMenuItem(${key})`;
      return { id: `${NS}.${key}`, order, component: ShellSessionActionMenuItem };
    }

    /** 五行，按 order 排在自带 archive(400) 之后。 */
    const ROWS = [
      makeItem('reveal', 500, REVEAL_LABEL, 'IconFolderOpenOutlineRegular', true),
      makeItem('openFolder', 510, '打开所在文件夹', 'IconFolderOpenOutlineRegular', false),
      makeItem('copyPath', 520, '复制文件路径', 'IconCopyOutlineRegular', false),
      makeItem('copyId', 530, '复制会话 ID', 'IconCopyOutlineRegular', false),
      // 反馈问题：与上面四行（文件操作）分开一组，所以再画一条分组线。
      makeItem('feedback', 540, '反馈问题', 'IconQuestionOutlineRegular', true),
    ];

    function apply(ctx) {
      ctx.slots.inject(SLOT, function* () {
        for (const row of ROWS) {
          yield ctx.slots.register({ name: SLOT, id: row.id, order: row.order }, row.component);
        }
      });
    }

    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  },
});
