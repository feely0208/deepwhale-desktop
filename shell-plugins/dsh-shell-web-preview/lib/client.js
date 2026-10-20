/**
 * dsh-shell-web-preview —— 客户端半边。
 *
 * ── 为什么需要它 ─────────────────────────────────────────────────────
 * 官方右栏「网页预览」（@deepseek-ai/dsh-client-ui-sidebar-browser）用 **iframe**
 * 渲染网页。iframe 受浏览器安全策略约束：站点只要声明下面任一条，跨域 iframe
 * 一律拒绝加载，而且**失败是静默的**（不报错、不弹提示）——
 *
 *     X-Frame-Options: DENY / SAMEORIGIN
 *     Content-Security-Policy: frame-ancestors 'none' / 'self'
 *
 * npm、GitHub、Google 以及大量登录页都声明了这条。用户看到的就是一片空白，
 * 以为是"应用坏了"。这不是网络问题，也不是官方插件写错了 ——
 * 官方那侧读不到跨域内容（它自己的注释就写着 reports loads without reading
 * cross-origin content），**它没有能力判断"是不是被拒绝了"**，所以空白。
 *
 * ── 判据为什么必须在宿主侧 ───────────────────────────────────────────
 * 客户端读 iframe 是跨域，**必然读不到**；往 iframe 里 fetch 也会被 CORS 挡。
 * 只有主进程（Node）能拿到真实响应头。所以这里只做两件事：
 *   ① 把目标地址交给 window.dsh.probeFrameable（主进程读响应头）
 *   ② 命中"禁止内嵌"时，在 iframe 上盖一层可操作的兜底提示
 *
 * ── 为什么不读官方插件的 DOM ─────────────────────────────────────────
 * 官方用 CSS Modules，类名是哈希，**跟着版本会变**，写死选择器迟早失效。
 * 这里改成"观察 document 里出现的 iframe"，与官方实现解耦：
 * 它换类名、换布局都不影响。
 *
 * 兜底层用 position:fixed 贴住 iframe 的实时矩形（随滚动/缩放同步），
 * 需要时显示、判断为可内嵌时隐藏 —— 不改变官方原有行为。
 */
window.__ModuleLoader__.load({
  id: '@deepwhale-cn/dsh-shell-web-preview',
  factory: () => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    /** 不需要注入客户端服务：探测在主进程，这里只做界面兜底。 */
    const inject = [];

    function apply() {
      const bridge = window.dsh || {};
      // 桥不在（例如非 Electron 宿主）→ 不介入，保持官方原样。
      if (typeof bridge.probeFrameable !== 'function') return;

      /** 同一个地址只探一次 */
      const probes = new Map();
      const attached = new WeakMap();

      function probe(url) {
        if (probes.has(url)) return probes.get(url);
        const p = bridge
          .probeFrameable(url)
          .catch(() => ({ frameable: true, unknown: true })); // 探测失败 → 不拦
        probes.set(url, p);
        return p;
      }

      const CSS = {
        box: 'position:fixed;z-index:2147483000;display:none;box-sizing:border-box;'
          + 'flex-direction:column;align-items:center;justify-content:center;gap:12px;'
          + 'background:#0b1526;color:#e7f1ff;text-align:center;padding:24px;'
          + 'font:14px/1.7 "PingFang SC","Microsoft YaHei","Segoe UI",sans-serif',
        title: 'font-size:16px;font-weight:600',
        desc: 'color:#9fb3cc;max-width:420px;font-size:13.5px',
        btn: 'padding:9px 20px;border-radius:9px;border:1px solid rgba(120,180,255,.25);'
          + 'background:#14A5B8;color:#04222b;font-weight:600;font-size:14px;cursor:pointer;'
          + 'font-family:inherit',
        hint: 'color:#6f8299;font-size:12px;max-width:420px;word-break:break-all',
      };

      function createOverlay(iframe) {
        let url = '';
        const box = document.createElement('div');
        box.setAttribute('data-dsh-frame-blocked', '1');
        box.style.cssText = CSS.box;

        const title = document.createElement('div');
        title.textContent = '这个网站不允许被内嵌预览';
        title.style.cssText = CSS.title;

        const desc = document.createElement('div');
        desc.textContent = '它出于自身安全策略，拒绝了在应用内打开。'
          + '换成浏览器访问就能正常显示。';
        desc.style.cssText = CSS.desc;

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = '用浏览器打开';
        btn.style.cssText = CSS.btn;
        btn.addEventListener('click', () => {
          if (url && typeof bridge.openExternal === 'function') bridge.openExternal(url);
        });

        const hint = document.createElement('div');
        hint.style.cssText = CSS.hint;

        box.appendChild(title);
        box.appendChild(desc);
        box.appendChild(btn);
        box.appendChild(hint);
        document.body.appendChild(box);

        const rec = {
          box, url: () => url,
          setUrl: (u) => { url = u; hint.textContent = u; },
          hide: () => { box.style.display = 'none'; },
          show: () => {
            // ⚠️ 2026-10-20 用户现场：iframe 已经被移除后还 show 出来，
            // 会变成一个钉在 (0,0)、盖住左侧边栏的"幽灵浮层"。
            if (!iframe.isConnected) return;
            box.style.display = 'flex';
          },
          destroy: () => {
            window.removeEventListener('scroll', rec.sync, true);
            window.removeEventListener('resize', rec.sync);
            box.remove();
          },
          sync: () => {
            // ⚠️ 2026-10-20：原来无条件按 iframe 的实时矩形定位。
            // 一旦 iframe 被移除（关掉右栏预览 / 切会话 / SPA 换页），
            // getBoundingClientRect() 全是 0 → 浮层被钉到左上角，
            // 宽度高度 0 但 padding 和按钮还在 → 表现为一条竖着的
            // 「用浏览器打开」按钮压在侧边栏上，关不掉（只能刷新）。
            // 现在：iframe 不在文档里 / 矩形已塌缩 → 直接隐藏。
            if (!iframe.isConnected) {
              box.style.display = 'none';
              return;
            }
            const r = iframe.getBoundingClientRect();
            if (!r || r.width < 2 || r.height < 2) {
              box.style.display = 'none';
              return;
            }
            box.style.left = r.left + 'px';
            box.style.top = r.top + 'px';
            box.style.width = r.width + 'px';
            box.style.height = r.height + 'px';
          },
        };
        return rec;
      }

      function ensure(iframe) {
        let rec = attached.get(iframe);
        if (rec) return rec;
        rec = createOverlay(iframe);
        attached.set(iframe, rec);
        // 用 capture 才能收到容器内部（非 window）的滚动
        window.addEventListener('scroll', rec.sync, true);
        window.addEventListener('resize', rec.sync);
        return rec;
      }

      async function handle(iframe) {
        const url = iframe.getAttribute('src') || iframe.src || '';
        if (!/^https?:\/\//i.test(url)) return;
        const verdict = await probe(url);
        // 探测是异步的：等它回来时，预览面板可能已经被用户关掉了。
        if (!iframe.isConnected) {
          const stale = attached.get(iframe);
          if (stale) {
            stale.destroy();
            attached.delete(iframe);
          }
          return;
        }
        let rec = attached.get(iframe);
        if (verdict && verdict.frameable === false) {
          rec = ensure(iframe);
          rec.setUrl(url);
          rec.sync();
          rec.show();
        } else if (rec) {
          rec.hide(); // 之前盖过、现在能内嵌（换地址了）→ 撤掉
        }
      }

      function watch(iframe) {
        if (iframe.__dshWebPreviewWatched) return;
        iframe.__dshWebPreviewWatched = true;
        // 被拒绝时 Chromium 也会触发 load（装载的是错误页），所以这里挂 load 有效。
        iframe.addEventListener('load', () => { void handle(iframe); });
        void handle(iframe);
      }

      /** iframe 从文档里消失时，把它身上的浮层一起回收（destroy 之前没有任何调用方） */
      function unmount(node) {
        if (!node || node.nodeType !== 1) return;
        const iframes = [];
        if (node.tagName === 'IFRAME') iframes.push(node);
        if (node.querySelectorAll) node.querySelectorAll('iframe').forEach((f) => iframes.push(f));
        for (const iframe of iframes) {
          const rec = attached.get(iframe);
          if (rec) {
            rec.destroy();
            attached.delete(iframe);
          }
          iframe.__dshWebPreviewWatched = false;
        }
      }

      function scan(root) {
        if (!root || root.nodeType !== 1) return;
        if (root.tagName === 'IFRAME') watch(root);
        else if (root.querySelectorAll) root.querySelectorAll('iframe').forEach(watch);
      }

      document.querySelectorAll('iframe').forEach(watch);

      // 官方是 SPA：iframe 出现/换地址都不刷新页面，所以靠 MutationObserver。
      new MutationObserver((muts) => {
        for (const m of muts) {
          if (m.type === 'childList') {
            m.addedNodes.forEach(scan);
            m.removedNodes.forEach(unmount);
          } else if (m.type === 'attributes' && m.target.tagName === 'IFRAME') {
            void handle(m.target);
          }
        }
      }).observe(document.documentElement, {
        childList: true, subtree: true, attributes: true, attributeFilter: ['src'],
      });
    }

    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  },
});
