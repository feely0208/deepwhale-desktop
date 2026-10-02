/**
 * dsh-shell-document-print —— 客户端半边。
 *
 * ── 它是什么 ─────────────────────────────────────────────────────────
 * 右侧「文档预览」的工具栏是一个**插槽**：`sidebar.right.tab.document.actions`
 * （list 槽，owner 是 client-ui-sidebar-documentpreview，声明见该包的
 * document/contract.d.ts：「作用于被预览文件的头部工具栏贡献项，渲染在预览自身
 * 控件之后，且此时文件的 Host 路径已知」，owner 自带 `absolutePath`）。
 *
 * DSH 自带的 `@deepseek-ai/dsh-client-ui-open-in-app`（「打开方式」）就往同一插槽
 * 注册过一项，本插件与它同款：**一项、一个按钮**，只是默认排在更后面。
 *
 * 现有能力对照：官方只在 **Excel 预览**（client.excel.js）里有打印，PDF / Word /
 * PPT / Markdown / 文本 / 图片都没有 —— 本插件补的正是这块。
 *
 * ── 打印怎么做的（两级降级）──────────────────────────────────────────
 *   ① 同源 iframe：`iframe.contentWindow.print()` —— 打印的是**文档本身**，
 *      由 Chromium 自带打印视图接管（可选页、缩放、双面、另存 PDF），体验最好。
 *   ② 跨源 iframe（例如 PDF 的 chrome-extension 查看器）：拿不到 contentWindow
 *      的 document，于是退回「**只打印预览区**」—— 临时注入一段 @media print
 *      样式，把 body 下除预览区以外的所有内容设为 visibility:hidden，再调
 *      window.print()。这样打印出来的就是当前文档，而不是整个应用界面。
 *
 * 关掉打印窗口后会清理注入的样式与属性（afterprint + 60s 兜底），不留残余。
 *
 * ── 为什么是这种形态 ─────────────────────────────────────────────────
 * DSH 的客户端插件不是打包产物，而是宿主提供的模块加载器：`require("react")`
 * 由宿主提供（见 @deepseek-ai/dsh-client-modules 的 boot 图）。所以这里手写
 * `__ModuleLoader__.load`，**只用 react，不用 jsx 运行时**（用 createElement），
 * 不引入任何依赖、不需要打包器。
 *
 * 按钮样式抄官方 `OpenTargetButton.module.css` 的实测量：高 24px、0.5px 边框、
 * radius-sm、字号 11px、hover 背景用 `--dsw-alias-interactive-bg-hover`。
 * 打印机图标官方图标集里没有，这里用内联 SVG（currentColor，随主题变色）。
 */
window.__ModuleLoader__.load({
  id: '@deepwhale-cn/dsh-shell-document-print',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const react = require('react');

    /** 目标插槽：文档预览的头部工具栏。 */
    const SLOT = 'sidebar.right.tab.document.actions';
    /** 本插件自己的 id（插槽文档要求带包命名空间，避免与自带项冲突）。 */
    const NS = 'dsh-shell-document-print';
    /** 排在自带项（「打开方式」）之后：order 越大越靠后。 */
    const ORDER = 60;

    const PRINTABLE_ATTR = 'data-dsh-print-root';
    const STYLE_ID = 'dsh-print-action-style';
    const ISOLATION_ID = 'dsh-print-isolation';

    // ── 一次性注入按钮样式（含 hover；不依赖任何构建期 CSS 方案）────────
    function ensureStyle() {
      if (document.getElementById(STYLE_ID)) return;
      const el = document.createElement('style');
      el.id = STYLE_ID;
      el.textContent = [
        '.dsh-print-action{flex:none;align-self:center;display:inline-flex;align-items:center;',
        'gap:4px;height:24px;padding:3px 7px;box-sizing:border-box;',
        'border:.5px solid var(--dsw-alias-border-l4, rgba(0,0,0,.14));',
        'border-radius:var(--dsw-radius-sm, 6px);background:transparent;',
        'color:var(--dsw-alias-label-primary, inherit);cursor:pointer;',
        "font-family:var(--dsw-font-family, inherit);font-size:11px;line-height:16px;white-space:nowrap;}",
        '.dsh-print-action:hover{background:var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.05));}',
        '.dsh-print-action:focus-visible{outline:2px solid var(--dsw-alias-border-l2, #6b7280);outline-offset:1px;}',
        '.dsh-print-action:disabled{cursor:default;opacity:.55;}',
      ].join('');
      document.head.appendChild(el);
    }

    // ── 轻量提示（只在失败时用；不引入 Toast 服务，避免多一份注入依赖）──
    function showToast(message) {
      try {
        const ID = 'dsh-document-print-toast';
        const previous = document.getElementById(ID);
        if (previous && previous.parentNode) previous.parentNode.removeChild(previous);
        const el = document.createElement('div');
        el.id = ID;
        el.setAttribute('role', 'status');
        el.textContent = String(message);
        el.style.cssText =
          'position:fixed;left:50%;bottom:42px;transform:translateX(-50%);z-index:2147483647;' +
          'max-width:70vw;padding:10px 16px;border-radius:10px;background:rgba(24,24,27,.94);color:#fff;' +
          "font:500 13px/1.45 -apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;" +
          'box-shadow:0 8px 28px rgba(0,0,0,.28);pointer-events:none;opacity:0;transition:opacity .16s ease;' +
          'white-space:pre-wrap;word-break:break-all;';
        document.body.appendChild(el);
        requestAnimationFrame(() => { el.style.opacity = '1'; });
        setTimeout(() => {
          el.style.opacity = '0';
          setTimeout(() => { if (el.parentNode) el.parentNode.removeChild(el); }, 200);
        }, 2600);
      } catch (_) { /* 提示失败不影响主流程 */ }
    }

    /**
     * 从按钮往上找「预览区」：第一个**高度占到视口 45% 以上**的祖先。
     *
     * 为什么这么判：按钮自身很小，往上第一层是工具栏，再往上依次是预览面板、
     * 侧栏、应用外壳 —— 预览面板是第一个「够高」的容器（侧栏与外壳更高，但都排在
     * 它后面），因此自下而上遇到的第一个高度过半的祖先就是预览面板。
     */
    function findPreviewRoot(startEl) {
      // ① 有 iframe（PDF / Office）：取「离 iframe 最近、再往上就会包住工具栏」的那个祖先
      //    —— 它就是文档画布。这样打印范围天然**不含工具栏**（实测原来会把工具栏一起打出来）。
      const frames = findFrames(document.body);
      for (let i = 0; i < frames.length; i += 1) {
        let node = frames[i];
        while (node.parentElement && node.parentElement !== document.body) {
          if (node.parentElement.contains(startEl)) break;   // 再往上会包住按钮/工具栏
          node = node.parentElement;
        }
        return node;
      }
      // ② 无 iframe（Markdown / 文本）：退回「第一个高度过半的祖先」
      let el = startEl;
      while (el && el !== document.body && el !== document.documentElement) {
        const r = el.getBoundingClientRect();
        if (r.height >= window.innerHeight * 0.45 && r.width >= window.innerWidth * 0.15) return el;
        el = el.parentElement;
      }
      return null;
    }

    /** 预览区里**可见且够大**的 iframe。 */
    function findFrames(root) {
      const out = [];
      const list = root.querySelectorAll('iframe');
      for (let i = 0; i < list.length; i += 1) {
        const f = list[i];
        const r = f.getBoundingClientRect();
        if (r.width >= 120 && r.height >= 120) out.push(f);
      }
      return out;
    }

    /**
     * ① 同源 iframe 直接打印。
     * 拿不到 contentWindow.document（跨源，例如 PDF 的扩展查看器）就跳过，
     * 由调用方降级处理 —— 这里**不吞掉**真实原因，只返回是否成功。
     */
    function tryPrintFrames(root) {
      const frames = findFrames(root);
      for (let i = 0; i < frames.length; i += 1) {
        const frame = frames[i];
        try {
          const win = frame.contentWindow;
          if (!win || !win.document) continue;   // 跨源：交给降级路径
          win.focus();
          win.print();
          return true;
        } catch (_) { /* 跨源或已被销毁，试下一个 */ }
      }
      return false;
    }

    /** ② 降级：只打印预览区（临时注入 @media print 隔离样式）。 */
    function printIsolated(root) {
      const previous = document.getElementById(ISOLATION_ID);
      if (previous && previous.parentNode) previous.parentNode.removeChild(previous);

      root.setAttribute(PRINTABLE_ATTR, '');
      const style = document.createElement('style');
      style.id = ISOLATION_ID;
      style.textContent =
        '@media print{' +
        'body *{visibility:hidden !important;}' +
        '[' + PRINTABLE_ATTR + '],[' + PRINTABLE_ATTR + '] *{visibility:visible !important;}' +
        // 打印根铺满页面，并解开自身的高度/溢出限制（否则只打出一屏）
        '[' + PRINTABLE_ATTR + ']{position:absolute !important;left:0 !important;top:0 !important;' +
        'width:100% !important;height:auto !important;max-height:none !important;overflow:visible !important;' +
        'margin:0 !important;padding:0 !important;border:0 !important;box-shadow:none !important;}' +
        '[' + PRINTABLE_ATTR + '] *{overflow:visible !important;max-height:none !important;}' +
        // 内嵌文档框（PDF 查看器 / Office 渲染）撑满整页，避免"窄面板缩到 A4 中间"
        '[' + PRINTABLE_ATTR + '] iframe{width:100% !important;height:250mm !important;border:0 !important;}' +
        '}';
      document.head.appendChild(style);

      let done = false;
      const cleanup = () => {
        if (done) return;
        done = true;
        root.removeAttribute(PRINTABLE_ATTR);
        if (style.parentNode) style.parentNode.removeChild(style);
        window.removeEventListener('afterprint', cleanup);
      };
      window.addEventListener('afterprint', cleanup);
      setTimeout(cleanup, 60000);   // 兜底：某些环境下 afterprint 不触发

      window.print();
    }

    /** 主进程能直接打印的文件类型（PDF 与图片；Office 文档交给预览区打印）。 */
    const HOST_PRINTABLE = /\.(pdf|png|jpe?g|webp|gif|bmp|svg)$/i;

    /**
     * ① 首选：让主进程把**文件本身**装进隐藏窗口交给系统打印。
     *
     * 为什么 PDF 一定要走这条：PDF 在预览里是 Chromium 的**扩展查看器**
     * （chrome-extension:// 跨源），渲染层拿不到它的 contentWindow，只能退回
     * "打印预览区" —— 结果就是照片里那样：窄面板缩到 A4 上，顶部还带着工具栏、
     * 四周大片留白。交给主进程打印文件本身则是满版，且能选页/缩放/另存 PDF。
     */
    function tryHostPrint(props) {
      const api = typeof window === 'object' && window ? window.dsh : null;
      if (!api || typeof api.printDocument !== 'function') return false;
      const file = props && typeof props.absolutePath === 'string' ? props.absolutePath : '';
      if (!file || !HOST_PRINTABLE.test(file)) return false;
      api
        .printDocument({ path: file })
        .then((result) => {
          if (result && result.ok === false && result.message) showToast('打印：' + result.message);
        })
        .catch((error) => {
          showToast('打印失败：' + (error && error.message ? error.message : String(error)));
        });
      return true;
    }

    function doPrint(event, props) {
      const button = event && event.currentTarget;
      if (tryHostPrint(props)) return;      // ① 文件本身（PDF/图片，满版）
      const root = findPreviewRoot(button) || findPreviewRoot(event && event.target);
      if (!root) {
        showToast('没有找到可打印的预览区域');
        return;
      }
      try {
        if (tryPrintFrames(root)) return;   // ② 同源 iframe：打印文档本身
        printIsolated(root);                // ③ 否则只打印文档画布
      } catch (error) {
        showToast('打印失败：' + (error && error.message ? error.message : String(error)));
      }
    }

    /** 打印机图标（官方图标集里没有，用内联 SVG，随 currentColor 变色）。 */
    function PrintIcon() {
      return react.createElement(
        'svg',
        { width: 13, height: 13, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true' },
        react.createElement('path', {
          d: 'M7 9V4h10v5M7 19H5a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-2',
          stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round',
        }),
        react.createElement('rect', {
          x: 7, y: 14, width: 10, height: 6, rx: 1,
          stroke: 'currentColor', strokeWidth: 1.6, strokeLinejoin: 'round',
        }),
      );
    }

    /**
     * 工具栏贡献项。
     * props 里带 owner 的 `absolutePath`（被预览文件的宿主机绝对路径）——
     * 本插件不用它（打印不需要路径），但保留在签名里以备后续做「导出 PDF」。
     */
    function PrintAction(props) {
      ensureStyle();
      return react.createElement(
        'button',
        {
          type: 'button',
          className: 'dsh-print-action',
          title: '打印当前预览的文档',
          'aria-label': '打印',
          onClick: (event) => doPrint(event, props),
        },
        react.createElement(PrintIcon, null),
        react.createElement('span', null, '打印'),
      );
    }

    /** 需要注入的客户端服务：slots（插槽注册表）。 */
    const inject = ['slots'];

    function apply(ctx) {
      ctx.slots.inject(SLOT, function* () {
        yield ctx.slots.register({ name: SLOT, id: NS, order: ORDER }, PrintAction);
      });
    }

    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  },
});
