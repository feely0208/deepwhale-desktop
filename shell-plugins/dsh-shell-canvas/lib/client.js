/**
 * dsh-shell-canvas —— 客户端半边。
 *
 * ── 它挂在哪儿（先用 cordis_inspect_query 查过槽位才定的）────────────
 *   · `sidebar.panellist`（list 槽，owner 是 ui-sidebar）：全局面板图标。
 *     槽文档原话："Each list id addresses the matching main panel; the sidebar
 *     owns the button and resolves its label from list metadata."
 *     → 注册 `{ id:'canvas', order:20, label:'深鲸画布' }`，侧栏就多一个按钮，
 *       点击由 ui-sidebar 自己调 `ctx.layout.selectPanel('canvas')`。
 *   · `main`（keyed 槽）：中间那栏，按 key 渲染。已有 key 是 conversation / plugins /
 *     schedules（都是壳自己注册的），我们占 `canvas` 这个新 key。
 *   两个槽都是 `replaceRisk: none`／新增 key，不动任何自带界面。
 *
 * ── 为什么界面是自绘的 ──────────────────────────────────────────────
 * 官方插件规范明确要求：**不要 require 任何 Harness 客户端包**
 * （`@deepseek-ai/dsh-client-ui-primitives` 之类）—— 它们随时会变，而纯 JS 插件
 * 没有类型检查，一个组件抛错就会把整个槽位打白。所以这里按宿主的样子自绘控件，
 * 颜色只用主题令牌 `--dsw-alias-*`，明暗主题自动跟随。
 *
 * ── 与宿主半边怎么通信 ──────────────────────────────────────────────
 * 宿主把功能挂在 `ctx.webServer` 的 `/dsh-canvas` 前缀路由上（见 lib/index.js）。
 * 与页面同源，所以：状态/校验/起任务用 fetch，进度用 SSE，成片直接丢给 <video>。
 * 图片与配音这类"本地文件槽位"走一次上传（浏览器拿不到真实路径），
 * 宿主落盘后把绝对路径交给引擎。
 */

window.__ModuleLoader__.load({
  id: '@deepwhale-cn/dsh-shell-canvas',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const react = require('react');
    const h = react.createElement;
    const { useState, useEffect, useMemo, useRef, useCallback } = react;

    /** 本插件自己的 id 前缀。 */
    const NS = 'dsh-shell-canvas';
    /**
     * 界面构建号。
     *
     * 加它是因为踩过一次**分不清"页面到底加载到哪一版"**的坑：这个桌面端的应用菜单
     * 里没有「重新加载」，Cmd+R 是被吞掉的，而客户端半边的热替换又不一定生效 ——
     * 结果"我改了、你刷新了、界面没变"变成一场谁也说不清的扯皮。
     * 现在顶栏会显示这一串，对不上就说明页面跑的还是旧 bundle。
     */
    const BUILD = 'b4';
    /** 宿主半边的 HTTP 出口前缀。 */
    const API = '/dsh-canvas/api';
    /** 侧栏面板图标槽。 */
    const SLOT_ICON = 'sidebar.panellist';
    /** 中间主面板槽（按 key 渲染）。 */
    const SLOT_MAIN = 'main';
    /** 本面板的 key：侧栏 id 与 main 的 key 必须一致，点击才会切过来。 */
    const PANEL_ID = 'canvas';
    /** 管线自动生成的变量，表单不向用户要。 */
    const AUTO_VARS = new Set(['subtitle']);
    /** 单行输入的变量名（其余 text 变量给多行输入框）。 */
    const SHORT_KEYS = new Set(['kicker', 'title', 'step1', 'step2', 'step3', 'label', 'name']);

    // ── HTTP ──────────────────────────────────────────────────────────
    async function api(path, options) {
      const res = await fetch(`${API}${path}`, {
        headers: { 'content-type': 'application/json' },
        ...options,
        body: options && options.body !== undefined ? JSON.stringify(options.body) : undefined,
      });
      const text = await res.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = { error: text }; }
      if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
      return data;
    }

    /** 上传一个本地文件，拿回宿主上的绝对路径（引擎的素材槽位要的是路径）。 */
    async function upload(file) {
      const res = await fetch(`${API}/upload?name=${encodeURIComponent(file.name)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: file,
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error((data && data.error) || `上传失败 HTTP ${res.status}`);
      return data;
    }

    const fileUrl = (p) => (p ? `${API}/file?p=${encodeURIComponent(p)}` : null);

    // ── 样式（只用主题令牌；令牌改版最多是外观退化，不会渲染不出来）────
    /**
     * 样式：只引用宿主主题令牌 `--dsw-alias-*`（少数宿主 primitive 在用、但 Theme
     * 目录没列出来的令牌都带 fallback，令牌改名最多是外观退化，不会渲染不出来）。
     * 版式按宿主自己的页面来：白卡片 + 0.5px 描边 + 12px 圆角 + 克制的分隔线，
     * 不做重阴影、不做花哨渐变 —— 那些正是"廉价感"的来源。
     */
    const CSS = `
.dshcv-root{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:13.5px;line-height:1.6}

/* ── 顶栏 ───────────────────────────────────────────────────────── */
.dshcv-head{display:flex;align-items:center;gap:10px;padding:14px 20px;border-bottom:.5px solid var(--dsw-alias-border-l1);flex:none;flex-wrap:wrap}
.dshcv-title{font-weight:700;font-size:18px;letter-spacing:-.01em}
.dshcv-sub{color:var(--dsw-alias-label-secondary);font-size:12.5px;line-height:1.55}
.dshcv-spacer{flex:1}
.dshcv-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-success-primary);flex:none}
.dshcv-dot-off{background:var(--dsw-alias-state-idle-primary)}

/* ── 两栏骨架 ───────────────────────────────────────────────────── */
.dshcv-body{display:flex;flex:1;min-height:0}
.dshcv-col{display:flex;flex-direction:column;min-height:0;overflow:auto;gap:14px}
.dshcv-left{width:312px;flex:none;padding:16px 14px;border-right:.5px solid var(--dsw-alias-border-l1);gap:10px}
.dshcv-right{flex:1;min-width:0;padding:20px 24px}
/* 表单行宽超过 ~700px 就开始难读，所以给内容一个上限并居中 */
.dshcv-stack{display:flex;flex-direction:column;gap:18px;width:100%;max-width:700px;margin:0 auto}

/* ── 区块 ───────────────────────────────────────────────────────── */
.dshcv-card{border:1px solid var(--dsw-alias-border-l1);border-radius:14px;background:var(--dsw-alias-bg-layer-1);padding:20px}
.dshcv-sec{display:flex;align-items:center;gap:9px;margin:4px 0 12px}
.dshcv-sec-t::before{content:"";display:inline-block;width:3px;height:13px;border-radius:2px;background:var(--dsw-alias-brand-primary);margin-right:8px;vertical-align:-2px}
.dshcv-sec-t{font-size:13px;font-weight:700;letter-spacing:.02em;color:var(--dsw-alias-label-primary)}
.dshcv-sec-line{flex:1;height:.5px;background:var(--dsw-alias-border-l1)}

/* ── 模板卡片 ───────────────────────────────────────────────────── */
/* ── 模板墙（2026-10-08 改版：用户要"一眼看过去有食欲"）────────────
   改前是小横卡（62×110 缩略图 + 右侧两行小字），像一份报销单；
   改后是**竖排海报卡**：缩略图占满卡片上半部、信息在下，选中时品牌色描边 + 外发光，
   悬停轻微上浮。模板是"能出什么片子"的第一眼印象，必须让它当视觉主角。 */
.dshcv-tpl{display:flex;flex-direction:column;gap:0;align-items:stretch;width:100%;text-align:left;padding:0;border-radius:14px;overflow:hidden;border:1px solid transparent;background:var(--dsw-alias-bg-layer-1);color:inherit;cursor:pointer;font:inherit;transition:transform .14s ease,box-shadow .14s ease,border-color .14s ease,background .14s ease}
.dshcv-tpl:hover{transform:translateY(-2px);box-shadow:0 6px 18px color-mix(in srgb, var(--dsw-alias-label-primary) 14%, transparent);border-color:var(--dsw-alias-border-l2)}
.dshcv-tpl[aria-pressed="true"]{border-color:var(--dsw-alias-brand-primary);box-shadow:0 0 0 2px color-mix(in srgb, var(--dsw-alias-brand-primary) 30%, transparent),0 6px 18px color-mix(in srgb, var(--dsw-alias-label-primary) 12%, transparent)}
.dshcv-poster{width:100%;flex:none;height:104px;overflow:hidden;border:0;border-bottom:1px solid var(--dsw-alias-border-l1);object-fit:cover;display:block;background:var(--dsw-alias-bg-layer-2)}
/* ⚠️ 缩略图统一成 104px 高的"横条"：第一次改成 width:100%+aspect-ratio 后，
   竖版模板把卡片撑成 300×550 的巨块，**模板名/参数/标签全被挤出可视区**
   （静态预览截图一看就露）。列表是"选一个"，可比性比原比例重要 —— 版式信息用 chip 标。 */
.dshcv-poster-wide{width:100%;height:104px}
.dshcv-poster-ph{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;text-align:center;font-size:11.5px;line-height:1.4;letter-spacing:.02em;color:var(--dsw-alias-label-secondary);background:
  repeating-linear-gradient(135deg, transparent 0 7px, var(--dsw-alias-bg-layer-2) 7px 14px), var(--dsw-alias-bg-base)}
.dshcv-tpl-body{min-width:0;flex:1;padding:11px 12px 12px}
.dshcv-tpl-name{font-weight:650;font-size:14.5px;line-height:1.35;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshcv-tpl-meta{color:var(--dsw-alias-label-secondary);font-size:12px;margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshcv-tpl-chips{display:flex;gap:4px;margin-top:6px;flex-wrap:wrap}

/* ── 表单 ───────────────────────────────────────────────────────── */
.dshcv-field{margin-bottom:16px}
.dshcv-field:last-child{margin-bottom:0}
.dshcv-label{display:block;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);margin-bottom:7px}
.dshcv-req{color:var(--dsw-alias-state-error-primary);margin-left:3px}
.dshcv-hint{color:var(--dsw-alias-label-secondary);font-size:12px;margin-top:6px;line-height:1.55}
.dshcv-input,.dshcv-area{width:100%;box-sizing:border-box;padding:7px 10px;border-radius:9px;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;outline:none;transition:border-color .12s ease}
.dshcv-input{height:34px}
.dshcv-input:focus,.dshcv-area:focus{border-color:var(--dsw-alias-brand-primary)}
.dshcv-input::placeholder,.dshcv-area::placeholder{color:var(--dsw-alias-label-secondary);opacity:.75}
.dshcv-area{min-height:104px;resize:vertical;line-height:1.6;font-family:inherit}

/* ── 按钮 ───────────────────────────────────────────────────────── */
.dshcv-btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;height:36px;padding:0 16px;border-radius:10px;font-weight:550;border:.5px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;cursor:pointer;white-space:nowrap;transition:background .12s ease,opacity .12s ease}
.dshcv-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2))}
.dshcv-btn:disabled{opacity:.45;cursor:not-allowed}
.dshcv-btn.sm{height:26px;padding:0 10px;font-size:11.5px;border-radius:8px}
/* ⚠️ 主按钮**不许出现硬编码颜色**（2026-10-08）：第一版写了 #001014 和 #fff，
   浅色主题下按钮会变成"深色渐变 + 白字"，和整个浅色界面打架。
   现在只用宿主 token 自混：深色下自然变深、浅色下自然变亮。
   注意：这段在模板字符串里，**注释里不能出现反引号**（踩过）。 */
.dshcv-btn-primary{background:var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary));border-color:transparent;color:var(--dsw-alias-label-primary-foreground);font-weight:650;box-shadow:0 3px 14px color-mix(in srgb, var(--dsw-alias-brand-primary) 34%, transparent)}
.dshcv-btn-primary:hover:not(:disabled){background:color-mix(in srgb, var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary)) 90%, var(--dsw-alias-label-primary))}
/* 主操作（出片）按钮再大一号：一屏里最想让用户点的就是它 */
.dshcv-btn-main{height:42px;padding:0 22px;border-radius:12px;font-size:14.5px}
.dshcv-btn-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover, var(--dsw-alias-brand-primary))}
.dshcv-btn-danger{color:var(--dsw-alias-state-error-primary)}
.dshcv-row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.dshcv-actions{display:flex;gap:10px;align-items:center;justify-content:flex-end;margin-top:18px;padding-top:16px;border-top:.5px solid var(--dsw-alias-border-l1)}

/* ── 选项（单选/复选）──────────────────────────────────────────── */
.dshcv-opts{display:flex;flex-direction:column;gap:8px}
.dshcv-opt{display:flex;gap:9px;align-items:flex-start;padding:10px 12px;border-radius:10px;border:.5px solid var(--dsw-alias-border-l1);cursor:pointer;transition:border-color .12s ease,background .12s ease}
.dshcv-opt:hover{background:var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2))}
.dshcv-opt[data-on="true"]{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-2)}
.dshcv-opt input{margin:2px 0 0;flex:none;accent-color:var(--dsw-alias-brand-primary)}
.dshcv-opt-t{font-size:12.5px}
.dshcv-opt-d{color:var(--dsw-alias-label-secondary);font-size:11px;margin-top:2px;line-height:1.5}

/* ── 素材槽 ─────────────────────────────────────────────────────── */
.dshcv-slot{display:flex;gap:8px;align-items:center}
.dshcv-slot .dshcv-input{flex:1;color:var(--dsw-alias-label-secondary)}
.dshcv-slot-preview{width:34px;height:34px;flex:none;border-radius:8px;object-fit:cover;border:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2)}
/* ⚠️ 2026-10-09：多素材缩略图必须是**有约束的容器**。
   原来只有 .dshcv-slot-preview（给单个 <img> 用的 34×34）；
   我改成 <div> 包 <img> 后，内层图片没有任何尺寸约束 →
   按原始尺寸铺开，把下面的按钮全盖住了（用户截图：素材"溢出"遮挡）。
   容器固定尺寸 + overflow:hidden，内层 img 填满，角标绝对定位。 */
.dshcv-slot-thumb{position:relative;width:36px;height:36px;flex:none;border-radius:8px;overflow:hidden;border:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);display:flex;align-items:center;justify-content:center}
.dshcv-slot-thumb img{width:100%;height:100%;object-fit:cover;display:block}
.dshcv-slot-thumb .n{position:absolute;right:0;bottom:0;font-size:9px;line-height:1;padding:2px 3px;border-top-left-radius:4px;background:rgba(0,0,0,.6);color:#fff}

/* ── 状态标记 ───────────────────────────────────────────────────── */
.dshcv-chip{display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:999px;font-size:10.5px;line-height:1.6;border:.5px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-base)}
.dshcv-chip-brand{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.dshcv-ok{color:var(--dsw-alias-state-success-primary)}
.dshcv-err{color:var(--dsw-alias-state-error-primary)}
.dshcv-warn{color:var(--dsw-alias-state-warn-primary)}
.dshcv-issue{border-left:2px solid var(--dsw-alias-state-error-primary);padding:9px 12px;margin:8px 0 0;background:var(--dsw-alias-bg-layer-2);border-radius:0 9px 9px 0;font-size:12px;line-height:1.6}
.dshcv-issue-warn{border-left-color:var(--dsw-alias-state-warn-primary)}
.dshcv-code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10.5px;color:var(--dsw-alias-label-secondary)}

/* ── 任务 ───────────────────────────────────────────────────────── */
.dshcv-bar{height:4px;border-radius:99px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}
.dshcv-bar>i{display:block;height:100%;border-radius:99px;background:var(--dsw-alias-brand-primary);transition:width .25s ease}
.dshcv-job{display:flex;flex-direction:column;gap:9px;padding:12px 14px;border:.5px solid var(--dsw-alias-border-l1);border-radius:11px;background:var(--dsw-alias-bg-base)}
.dshcv-job+.dshcv-job{margin-top:8px}
.dshcv-job-h{display:flex;align-items:center;gap:9px;flex-wrap:wrap}
.dshcv-job-t{font-weight:600;font-size:12.5px}
.dshcv-log{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10.5px;line-height:1.65;color:var(--dsw-alias-label-secondary);max-height:170px;overflow:auto;white-space:pre-wrap;margin:0;padding:10px 12px;border-radius:9px;background:var(--dsw-alias-bg-layer-2);border:.5px solid var(--dsw-alias-border-l1)}
/* 成片并排（2026-10-08）：以前是 flex-wrap 上下堆，两个成片各占一行、
   还把视频挤到 330px 高。评审要看"横竖两版一起"，改成两列网格，窄屏才堆叠。 */
.dshcv-result{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;margin-top:2px}
@media (max-width:900px){.dshcv-result{grid-template-columns:1fr}}
/* 全屏浮层看片：点 ⛶ 后铺满整块面板，点空白关闭 */
.dshcv-big{position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,.9);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;cursor:zoom-out}
.dshcv-big video{max-width:94vw;max-height:86vh;border-radius:12px;background:#000}
.dshcv-big-hint{color:rgba(255,255,255,.75);font-size:12.5px}
.dshcv-video{display:flex;flex-direction:column;gap:7px}
.dshcv-video video{border-radius:10px;border:.5px solid var(--dsw-alias-border-l1);background:#000;width:100%;max-height:min(48vh,460px);display:block}

/* ── 空态 ───────────────────────────────────────────────────────── */
.dshcv-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;color:var(--dsw-alias-label-secondary);font-size:12px;padding:34px 18px;text-align:center;border:.5px dashed var(--dsw-alias-border-l1);border-radius:12px;line-height:1.6}
.dshcv-empty-mark{opacity:.5}
.dshcv-banner{padding:11px 13px;border-radius:10px;background:var(--dsw-alias-bg-layer-2);border:.5px solid var(--dsw-alias-border-l1);font-size:12px;line-height:1.6}
.dshcv-pre{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;word-break:break-all;line-height:1.7}
`;

    function StyleTag() {
      // 组件内渲染 <style>：卸载时随 DOM 一起消失，不需要额外清理。
      return h('style', { 'data-plugin': NS }, CSS);
    }

    // ── 小控件 ────────────────────────────────────────────────────────
    function Btn({ children, primary, danger, size, main, ...rest }) {
      return h('button', {
        type: 'button',
        className: `dshcv-btn${primary ? ' dshcv-btn-primary' : ''}${danger ? ' dshcv-btn-danger' : ''}${size === 'sm' ? ' sm' : ''}${main ? ' dshcv-btn-main' : ''}`,
        ...rest,
      }, children);
    }

    /** 区块：一条细线 + 一个小标题，用来替代"一堆输入框糊在一起"。 */
    function Section({ title, right, children }) {
      return h('div', null, [
        h('div', { className: 'dshcv-sec', key: 'h' }, [
          h('span', { className: 'dshcv-sec-t', key: 't' }, title),
          h('span', { className: 'dshcv-sec-line', key: 'l' }),
          right || null,
        ]),
        h('div', { key: 'b' }, children),
      ]);
    }

    function Field({ label, required, hint, children }) {
      return h('div', { className: 'dshcv-field' }, [
        h('label', { className: 'dshcv-label', key: 'l' }, [
          label,
          required ? h('span', { className: 'dshcv-req', key: 'r' }, '*') : null,
        ]),
        h('div', { key: 'c' }, children),
        hint ? h('div', { className: 'dshcv-hint', key: 'h' }, hint) : null,
      ]);
    }

    /** 单选项卡片：整块可点，选中时描边高亮 —— 比裸 radio + 一行小字清楚得多。 */
    function Opt({ type, checked, onChange, title, desc }) {
      return h('label', { className: 'dshcv-opt', 'data-on': String(!!checked) }, [
        h('input', { key: 'i', type: type || 'radio', checked: !!checked, onChange: (e) => onChange(e.target.checked) }),
        h('span', { key: 'b', style: { minWidth: 0 } }, [
          h('span', { className: 'dshcv-opt-t', key: 't' }, title),
          desc ? h('span', { className: 'dshcv-opt-d', key: 'd', style: { display: 'block' } }, desc) : null,
        ]),
      ]);
    }

    function Empty({ children }) {
      return h('div', { className: 'dshcv-empty' }, [
        h('svg', {
          key: 'i', className: 'dshcv-empty-mark', width: 26, height: 26, viewBox: '0 0 24 24',
          fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round',
        }, [
          h('rect', { key: 'r', x: 3, y: 5, width: 18, height: 14, rx: 2.5 }),
          h('path', { key: 'p', d: 'M3 15.5c2.4-2 4.3.8 5.2 2.1.9-2.2 2.4-4.2 4.6-4.2 2.2 0 3.1 2.4 8.2 1.5' }),
        ]),
        h('span', { key: 't' }, children),
      ]);
    }

    /** 模板缩略图：图挂了就退回占位，而不是留一个空框（"图片裂了"比"没有图"更廉价）。 */
    function Poster({ url, wide, alt }) {
      const [broken, setBroken] = useState(false);
      const cls = `dshcv-poster${wide ? ' dshcv-poster-wide' : ''}`;
      if (!url || broken) {
        return h('div', { className: `${cls} dshcv-poster-ph` }, [
          h('span', { key: 'a' }, '暂无'),
          h('span', { key: 'b' }, '预览图'),
        ]);
      }
      return h('img', {
        className: cls, src: url, alt: alt || '',
        onError: () => setBroken(true),
      });
    }

    /**
     * 侧栏图标：一块屏 + 一个播放键 —— 与 `icon.svg` 同一套图形。
     *
     * 第一版画的是"画框 + 鲸尾 + 一个点"，结果在 16px 下被读成了**图片/相册**图标
     * （用户原话："我们这个不是搞视频的吗，怎么感觉像是处理图片的呢"）。
     * 播放键是"视频"最不容误读的符号，所以留它；鲸的品牌感交给配色（青色）去承担。
     * 播放键比几何中心右偏一点（视觉居中）。
     */
    function CanvasIcon({ size = 18, active }) {
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: active ? 2 : 1.8,
        strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true',
      }, [
        h('rect', { key: 'f', x: 2.2, y: 4.2, width: 19.6, height: 15.6, rx: 4.2 }),
        h('path', { key: 'p', d: 'M10.2 8.7 16.4 12l-6.2 3.3z', fill: 'currentColor', stroke: 'none' }),
      ]);
    }

    // ── 主面板 ────────────────────────────────────────────────────────
    function CanvasPanel() {
      const [state, setState] = useState(null);
      const [error, setError] = useState(null);
      const [busy, setBusy] = useState(null);
      const [jobs, setJobs] = useState([]);
      const [selected, setSelected] = useState(null);
      const [values, setValues] = useState({});
      const [assets, setAssets] = useState({});
      const [script, setScript] = useState('');
      const [voiceMode, setVoiceMode] = useState('builtin');
      const [voiceover, setVoiceover] = useState(null);
      // 背景音乐（2026-10-09 用户："我看不能上传 BGM 哦"）
      //   不加 / 用我自己的文件 —— 版权责任在用户，我们只做混音（引擎侧记一条日志）
      // 成片保存位置（用户要求：不能是默认位置，尤其 Win 上不能塞 C 盘）
      const [outDir, setOutDir] = useState('');
      const [outDirMsg, setOutDirMsg] = useState('');
      /** 选文件夹：用 webkitdirectory 让用户挑目录，从文件真实路径推出目录。
       *  ⚠️ 不能走 upload() —— 它会把文件复制进临时上传目录，原目录就丢了。 */
      const pickDir = (onPicked) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.webkitdirectory = true;
        input.multiple = true;
        input.style.display = 'none';
        const cleanup = () => { if (input.parentNode) input.parentNode.removeChild(input); };
        document.body.appendChild(input);
        input.addEventListener('change', () => {
          const f = input.files && input.files[0];
          cleanup();
          const real = f && (f.path || '');
          if (!real) {
            // ⚠️ 浏览器只能"选文件夹里的文件"来反推目录 —— 空文件夹（比如什么都没放的桌面）
            //    不会触发 change。这不是 bug，是 web 平台的限制，所以**给明确出路**，
            //    不许静默无反应（用户实测："选桌面还不行，一定要选一个文件夹吗，这个不可取"）。
            setError('这个文件夹里没有文件，浏览器拿不到路径 —— 请直接把路径填进输入框，再点「确定」。');
            return;
          }
          onPicked(String(real).replace(/[\\/][^\\/]+$/, ''));
        });
        input.addEventListener('cancel', cleanup);
        input.click();
      };
      const saveOutDir = (dir) => run('保存位置', async () => {
        // 空着就保存默认位置（用户点"保存"不该什么都不发生）
        const use = (dir && String(dir).trim()) || (state && state.runtime && state.runtime.outputRoot) || '';
        const r = await api('/output-dir', { method: 'POST', body: { dir: use } });
        if (r && r.dir) {
          setOutDir(r.dir);
          setError(null);
          // 成功必须有回执 —— 否则用户按了"确定"却什么都没变，就是"用不了"
          setOutDirMsg(`✅ 已保存：${r.dir}（之后的任务都存这儿）`);
        }
        return r;
      });
      const [bgmMode, setBgmMode] = useState('none');
      const [bgmFile, setBgmFile] = useState('');
      // 分镜表（2026-10-09 用户核心需求）：每句 → 配哪张素材、从第几秒、停多久
      const [board, setBoard] = useState(null);   // null=不用分镜表；数组=正在用
      // ⚠️ 以前这里写死 'chromium'，要用户**手动勾选**才走非 playwright 后端 ——
      //   于是默认任务全部走 Playwright Chromium，而真机上没有它 →
      //   任务失败「Cannot find package 'playwright-core'」，用户完全看不懂。
      //   改成**自动选可用的后端**：宿主报告 ok 就用它，否则才回落 playwright。
      const [renderer, setRenderer] = useState('chromium');
      const [rendererTouched, setRendererTouched] = useState(false);   // 用户手动改过就不再自动覆盖
      const [previewSeconds, setPreviewSeconds] = useState(4);
      const [validation, setValidation] = useState(null);
      const [engineEdit, setEngineEdit] = useState('');
      const [osr, setOsr] = useState(null);
      // 任务列表默认只显示"在跑的 + 最近几条已结束的"：历史任务堆一屏纯属噪声。
      const [showAllJobs, setShowAllJobs] = useState(false);

      const refresh = useCallback(async () => {
        try {
          const s = await api('/state');
          setState(s);
          setJobs(s.jobs || []);
          setError(null);
          if (!s.engine.ok) setEngineEdit(s.engine.tried?.[0]?.root || '');
          if (!selected && s.templates && s.templates.length) setSelected(s.templates[0].id);
          // 自动选渲染后端：宿主报告有可用后端（系统浏览器 / 进程内 OSR）就用它。
          // 以前默认写死 'chromium' → 真机上必然走 Playwright → 报
          // 「Cannot find package 'playwright-core'」，用户完全看不懂。
          // 用户手动勾过复选框之后不再自动覆盖（rendererTouched 由勾选处置位）。
          if (s.runtime && s.runtime.electron && s.runtime.electron.ok) setRenderer('electron-osr');
        } catch (e) {
          setError(e.message);
        }
      }, [selected]);

      useEffect(() => { refresh(); }, []);

      // 进度走 SSE：与轮询相比不会漏掉中间态，也不会有刷新延迟。
      useEffect(() => {
        let es;
        try { es = new EventSource(`${API}/events`); } catch { return undefined; }
        es.onmessage = (ev) => {
          let d;
          try { d = JSON.parse(ev.data); } catch { return; }
          if (d.t === 'hello') { setJobs(d.jobs || []); return; }
          if (d.job) {
            setJobs((prev) => {
              const next = prev.filter((j) => j.id !== d.job.id);
              next.unshift(d.job);
              return next;
            });
          }
        };
        return () => { try { es.close(); } catch { /* 已关 */ } };
      }, []);

      const templates = state?.templates || [];
      const current = useMemo(() => templates.find((t) => t.id === selected) || null, [templates, selected]);

      // 切模板时清掉上一份模板的变量，并把 default 填上。
      useEffect(() => {
        if (!current) return;
        const v = {};
        for (const d of current.varDefs || []) if (d.default !== undefined) v[d.key] = d.default;
        setValues(v);
        setAssets({});
        setValidation(null);
        setError(null);
      }, [current && current.id]);

      const builderVars = (current?.varDefs || []).filter((v) => v.type !== 'image' && v.type !== 'audio' && !AUTO_VARS.has(v.key));
      const assetVars = (current?.varDefs || []).filter((v) => v.type === 'image' || v.type === 'audio');

      async function run(label, fn) {
        setBusy(label);
        setError(null);
        try { return await fn(); } catch (e) { setError(e.message); return null; } finally { setBusy(null); }
      }

      // multiple=true → 一次选多个（素材要能多张图/一个视频；用户原话：
      // 「素材上传只能传一张？那就没得搞了」）
      const pickFile = (accept, onPicked, multiple) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = accept || '';
        if (multiple) input.multiple = true;
        input.style.display = 'none';
        const cleanup = () => { if (input.parentNode) input.parentNode.removeChild(input); };
        document.body.appendChild(input);
        input.addEventListener('change', () => {
          const files = input.files ? [...input.files] : [];
          cleanup();
          if (files.length) onPicked(multiple ? files : files[0]);
        });
        // 用户按 Esc 取消时不会有 change 事件，不清理就会往 body 里堆隐藏 input。
        input.addEventListener('cancel', cleanup);
        input.click();
      };

      const doValidate = () => run('校验', async () => {
        const r = await api('/validate', { method: 'POST', body: { group: selected, vars: values } });
        setValidation(r);
        return r;
      });

      /** 起任务前先过校验闸门 —— 校验不过就不许进入渲染（§4.2 第 5 条）。 */
      async function startJob(kind, extra) {
        if (!current) return;
        const v = await api('/validate', { method: 'POST', body: { group: selected, vars: values } });
        setValidation(v);
        if (!v.ok) {
          setError('校验没通过，已拦下（看下面的错误码与提示）');
          return;
        }
        const body = {
          kind,
          group: selected,
          vars: values,
          assets,
          script,
          renderer,
          previewSeconds,
          voiceoverFile: voiceMode === 'file' ? voiceover : null,
          bgmFile: bgmMode === 'file' && bgmFile ? bgmFile : null,
          ...extra,
        };
        const job = await api('/job', { method: 'POST', body });
        setJobs((prev) => [job, ...prev.filter((j) => j.id !== job.id)]);
      }

      /** 把旁白稿按标点拆句，生成分镜表（每句一行，素材/时间可改） */
      const buildBoard = () => {
        const textVar2 = current && current.vars ? (current.vars.find((x) => x.type === 'text' && x.key !== 'title') || {}).key : null;
        const text = script || (textVar2 ? String(values[textVar2] || '') : '');
        const sents = String(text).split(/(?<=[。！？!?；;])/).map((x) => x.trim()).filter(Boolean);
        if (!sents.length) { setError('先填旁白稿，再点「分镜表」'); return; }
        const shotsAll = Object.values(assets).flat().map((x) => (typeof x === 'string' ? x : x && x.path)).filter(Boolean);
        let cur = 0;
        setBoard(sents.map((t, i) => {
          const dur = Math.max(1.5, Math.round((t.replace(/\s/g, '').length / 4) * 10) / 10);
          const row = { text: t, shot: shotsAll[i] || '', start: cur, duration: dur };
          cur = Math.round((cur + dur) * 10) / 10;
          return row;
        }));
        setError(null);
      };

      /** 用分镜表出片：交给 story.board 产出完整文档，再按文档起任务 */
      const doBoard = () => run('分镜表出片', async () => {
        if (!board || !board.length) throw new Error('先点「分镜表」生成分镜行');
        const items = board.map((r) => ({ text: r.text, shot: r.shot || null, start: Number(r.start) || 0, duration: Number(r.duration) || 0 }));
        for (const it of items) if (!it.text) throw new Error('有分镜行是空的');
        const r = await api('/produce', { method: 'POST', body: {
          producer: 'story.board',
          input: { title: values.title || '', items, orientation: 'vertical' },
        } });
        const out = r && r.doc ? r.doc : null;
        if (!out || !out.doc) throw new Error('分镜没产出文档（引擎返回为空）');
        const job = await api('/job', { method: 'POST', body: {
          kind: 'preview', group: 'storyboard', orientation: 'vertical',
          doc: out.doc, vars: out.vars, assets: out.assets || {},
          renderer, previewSeconds, bgmFile: bgmMode === 'file' && bgmFile ? bgmFile : null,
        } });
        if (job) setJobs((prev) => [job, ...prev.filter((j) => j.id !== job.id)]);
      });

      const doPreview = () => run('预览', () => startJob('preview', {}));
      /**
       * 一次出多形态（用户要求：「一次预览就生成三种形态，这个才是用户实际想要的」）。
       * 做法：把内容交给**引擎的生产者**去映射各模板需要的变量（映射逻辑不抄到前端，
       * 否则两边会漂），拿到多份 {template, vars, assets} 后**逐个起任务** ——
       * 于是三个形态各自出现在任务列表里，各自有可播放的预览。
       */
      const doVariants = () => run('三形态', async () => {
        const shotList = Object.values(assets).flat().map((x) => (typeof x === 'string' ? x : x && x.path)).filter(Boolean);
        // 旁白稿：优先用"文案"那个变量（各模板第一个文本必填项）
        const textVar = current && current.vars ? (current.vars.find((x) => x.type === 'text' && x.key !== 'title') || {}).key : null;
        const text = script || (textVar ? String(values[textVar] || '') : '');
        if (!text) throw new Error('先填文案（旁白稿）再点三形态');
        const r = await api('/produce', { method: 'POST', body: {
          producer: 'text.storyboard',
          input: { text, title: values.title || '', shots: shotList, variants: true },
        } });
        const list = (r && r.doc && r.doc.variants) || [];
        if (!list.length) throw new Error('没拿到多形态（引擎返回为空）');
        for (const v of list) {
          const [group, orientation] = String(v.template).split('/');
          const job = await api('/job', { method: 'POST', body: {
            kind: 'preview', group, orientation: orientation || 'vertical',
            vars: v.vars, assets: v.assets || {},
            script, renderer, previewSeconds,
            voiceoverFile: voiceMode === 'file' ? voiceover : null,
            bgmFile: bgmMode === 'file' && bgmFile ? bgmFile : null,
          bgmFile: bgmMode === 'file' && bgmFile ? bgmFile : null,
          } });
          if (job) setJobs((prev) => [job, ...prev.filter((j) => j.id !== job.id)]);
        }
        return list.length;
      });
      const doFinal = () => run('出终版', () => startJob('final', {}));

      const cancelJob = (id, cleanup) => run('取消', () => api('/cancel', { method: 'POST', body: { id, cleanup } }));
      const resumeJob = (job) => run('续渲', () => {
        const req = job.request || {};
        return api('/job', { method: 'POST', body: { ...req, kind: job.kind, resume: true, resumeFrom: job.outDir } });
      }).then((j) => { if (j) setJobs((prev) => [j, ...prev]); });
      const reveal = (p) => run('打开', () => api('/reveal', { method: 'POST', body: { path: p } }));

      const checkOsr = () => run('检测渲染能力', async () => {
        const r = await api('/osr', { method: 'POST', body: { force: true } });
        setOsr(r);
        return r;
      });


      // ── 引擎未就绪：给一条"试过哪些路径"的清单，而不是一句"找不到"──
      if (state && !state.engine.ok) {
        return h('div', { className: 'dshcv-root' }, [
          h(StyleTag, { key: 's' }),
          h('div', { className: 'dshcv-head', key: 'h' }, [
            h('span', { className: 'dshcv-title', key: 't' }, '深鲸画布'),
            h('span', { className: 'dshcv-dot dshcv-dot-off', key: 'dot' }),
            h('span', { className: 'dshcv-sub', key: 'd' }, '还没找到引擎目录'),
          ]),
          h('div', { className: 'dshcv-col dshcv-right', key: 'b' }, [
            h('div', { className: 'dshcv-stack', key: 's' }, [
              h('div', { className: 'dshcv-card', key: 'setup' }, [
                h(Section, { key: 'sec', title: '指定引擎目录' },
                  h('div', null, [
                    h('div', { className: 'dshcv-sub', key: 'p', style: { marginBottom: 10 } },
                      '深鲸画布引擎（canvas/）是一个独立工程，本插件只做外壳。指到它的根目录即可 —— 判定标准是这几样都在：src/pipeline.mjs、src/validate.mjs、src/render/index.mjs、packs/video/domain.json、templates/。'),
                    h('input', {
                      key: 'i', className: 'dshcv-input', value: engineEdit, placeholder: '/path/to/canvas',
                      onChange: (e) => setEngineEdit(e.target.value),
                    }),
                    h('div', { className: 'dshcv-actions', key: 'a' }, [
                      h(Btn, { key: 'r', onClick: refresh }, '重新探测'),
                      h(Btn, {
                        key: 'go', primary: true, disabled: !!busy,
                        onClick: () => run('设置引擎', async () => {
                          const r = await api('/engine', { method: 'POST', body: { root: engineEdit } });
                          if (!r.ok) throw new Error(`这个目录不像引擎根，缺少：${(r.missing || []).join('、')}`);
                          await refresh();
                        }),
                      }, busy === '设置引擎' ? '检查中…' : '使用这个目录'),
                    ]),
                  ])),
              ]),
              h('div', { className: 'dshcv-card', key: 'tried' }, [
                h(Section, { key: 'sec', title: '探测过的位置' },
                  h('div', null, (state.engine.tried || []).map((t, i) => h('div', {
                    key: i, className: 'dshcv-pre',
                  }, `${t.ok ? '✅' : '❌'} ${t.root}${t.ok ? '' : `\n     缺 ${(t.missing || []).join('、')}`}`)))),
              ]),
              error ? h('div', { className: 'dshcv-issue', key: 'err' }, error) : null,
            ]),
          ]),
        ]);
      }

      // ── 主界面 ────────────────────────────────────────────────────
      const engineOk = state?.engine?.ok;
      const isRunning = (j) => j.status === 'running' || j.status === 'queued';
      const runningCount = jobs.filter(isRunning).length;
      // 未结束的全显示；已结束的默认只留最近 3 条。
      const RECENT_DONE = 3;
      const visibleJobs = showAllJobs ? jobs : jobs.filter((j, i) => isRunning(j) || jobs.slice(0, i + 1).filter((x) => !isRunning(x)).length <= RECENT_DONE);
      const hiddenCount = jobs.length - visibleJobs.length;

      return h('div', { className: 'dshcv-root' }, [
        h(StyleTag, { key: 's' }),

        // 顶栏：一眼看到"引擎通不通 / 用哪个后端 / 有几个任务在跑"
        h('div', { className: 'dshcv-head', key: 'head' }, [
          h('span', { className: 'dshcv-title', key: 't' }, '深鲸画布'),
          h('span', { className: 'dshcv-dot', key: 'dot', title: engineOk ? '引擎就绪' : '引擎未就绪' }),
          h('span', { className: 'dshcv-sub', key: 'e' },
            engineOk
              ? `引擎 ${state.engine.version || '?'} · 领域包 ${state.engine.pack || '?'} · 界面 ${BUILD}`
              : `引擎未就绪 · 界面 ${BUILD}`),
          h('span', { className: 'dshcv-chip', key: 'r' }, renderer === 'electron-osr' ? '极速渲染' : '兼容渲染'),
          runningCount ? h('span', { className: 'dshcv-chip dshcv-chip-brand', key: 'j' }, `${runningCount} 个任务在跑`) : null,
          h('span', { className: 'dshcv-spacer', key: 'sp' }),
          h(Btn, { key: 'ref', size: 'sm', onClick: refresh, disabled: !!busy }, '刷新'),
          h(Btn, {
            key: 'poster', size: 'sm', disabled: !!busy,
            onClick: () => run('预览图', () => api('/posters', { method: 'POST', body: {} })),
          }, busy === '预览图' ? '已排队…' : '重做模板预览图'),
        ]),

        h('div', { className: 'dshcv-body', key: 'body' }, [
          // 左：模板库
          h('div', { className: 'dshcv-col dshcv-left', key: 'l' }, [
            h('div', { className: 'dshcv-sec', key: 'h' }, [
              h('span', { className: 'dshcv-sec-t' }, `模板库 ${templates.length ? `· ${templates.length}` : ''}`),
              h('span', { className: 'dshcv-sec-line' }),
            ]),
            ...(templates.length
              ? templates.map((t) => {
                  const vertical = t.orientations.vertical;
                  const o = vertical || Object.values(t.orientations)[0];
                  const wide = !vertical;
                  const poster = (vertical ? t.poster.vertical : t.poster.horizontal) || t.poster.horizontal || t.poster.vertical;
                  return h('button', {
                    key: t.id, type: 'button', className: 'dshcv-tpl',
                    'aria-pressed': String(selected === t.id),
                    onClick: () => setSelected(t.id),
                  }, [
                    h(Poster, { key: 'p', url: poster, wide, alt: `${t.name} 预览` }),
                    h('div', { key: 'i', className: 'dshcv-tpl-body' }, [
                      h('div', { key: 'n', className: 'dshcv-tpl-name' }, t.name),
                      h('div', { key: 'c', className: 'dshcv-tpl-meta' }, `${o.canvas.w}×${o.canvas.h} · ${o.canvas.fps}fps`),
                      h('div', { key: 'ch', className: 'dshcv-tpl-chips' }, [
                        Object.keys(t.orientations).length > 1
                          ? h('span', { key: 'o', className: 'dshcv-chip' }, '横 + 竖')
                          : h('span', { key: 'o', className: 'dshcv-chip' }, wide ? '横版' : '竖版'),
                        t.aiGenerated ? h('span', { key: 'ai', className: 'dshcv-chip' }, 'AI 标识') : null,
                      ]),
                    ]),
                  ]);
                })
              // ⚠️ 必须包成数组再展开：`...(cond ? arr.map(...) : el)` 里的 el 是**单个
              // React 元素对象**，不是可迭代对象 —— 首屏（还没 fetch 到 state、templates 为空）
              // 会直接 TypeError，整个槽位被 DSH 打白。踩过一次。
              : [h('div', { key: 'none', className: 'dshcv-empty' }, '正在读取模板…')]),
          ]),

          // 右：参数表单 + 校验 + 任务
          h('div', { className: 'dshcv-col dshcv-right', key: 'r' }, [
            h('div', { className: 'dshcv-stack', key: 'stack' }, [
              current ? h('div', { className: 'dshcv-card', key: 'form' }, [
                h(Section, { key: 'content', title: `内容 · ${current.name}` },
                  h('div', null, [
                    h(Field, {
                      key: 'script', label: '旁白稿', required: true,
                      hint: '按标点自动拆句 → 逐句配音 → 字幕按**真实配音时长**对齐（不是估的）。',
                    }, h('textarea', {
                      className: 'dshcv-area', value: script,
                      placeholder: '把要念的稿子整段贴进来即可。',
                      onChange: (e) => setScript(e.target.value),
                    })),
                    ...builderVars.map((v) => h(Field, {
                      key: v.key, label: v.label || v.key, required: v.required,
                    }, SHORT_KEYS.has(v.key)
                      ? h('input', {
                        className: 'dshcv-input', value: values[v.key] ?? '',
                        onChange: (e) => setValues((s) => ({ ...s, [v.key]: e.target.value })),
                      })
                      : h('textarea', {
                        className: 'dshcv-area', value: values[v.key] ?? '',
                        onChange: (e) => setValues((s) => ({ ...s, [v.key]: e.target.value })),
                      }))),
                  ])),

                assetVars.length ? h('div', { key: 'assets', style: { marginTop: 22 } },
                  h(Section, { title: '素材' },
                    h('div', null, assetVars.map((v) => h(Field, {
                      key: v.key, label: v.label || v.key,
                      hint: `${v.max ? `建议 ${v.max} 张以内（多了按时间轮播）` : '可多张图 / 一个视频'}。素材不出本机：只把本机绝对路径交给渲染子进程。`,
                    }, h('div', { className: 'dshcv-slot' }, [
                      // 多素材（2026-10-09）：可以是多张图，也可以是一个视频。
                      // 显示：第一个的缩略图 + "共 N 个"，不再只当一个路径。
                      (() => {
                        const cur = assets[v.key];
                        const list = Array.isArray(cur) ? cur : (cur ? [cur] : []);
                        if (!list.length) return null;
                        const isVid = /\.(mp4|mov|webm|m4v|ogv)$/i.test(String(list[0]));
                        return h('div', { key: 'th', className: 'dshcv-slot-thumb', title: list.join('\n') },
                          isVid
                            ? h('span', { style: { fontSize: '14px' } }, '🎬')
                            : h('img', { src: fileUrl(list[0]), alt: '' }),
                          list.length > 1 ? h('span', { className: 'n', key: 'n' }, String(list.length)) : null);
                      })(),
                      h('input', {
                        key: 'i', className: 'dshcv-input',
                        value: (() => { const cur = assets[v.key]; return Array.isArray(cur) ? cur.join('、') : (cur || ''); })(),
                        readOnly: true,
                        placeholder: '还没选素材（可多选图片，或选一个视频）',
                      }),
                      h(Btn, {
                        key: 'b', size: 'sm',
                        onClick: () => pickFile('image/*,video/*', (files) => run('上传', async () => {
                          // 插件不是大型软件：素材给个**明确上限**（12），
                          // 选超了只取前 12 并当场告诉用户（不静默截断）。
                          const MAX_SHOTS = 12;
                          let arr = Array.isArray(files) ? files : [files];
                          if (arr.length > MAX_SHOTS) {
                            arr = arr.slice(0, MAX_SHOTS);
                            setError(`一次最多 ${MAX_SHOTS} 张素材，已取前 ${MAX_SHOTS} 张`);
                          }
                          const ups = [];
                          for (const f of arr) {
                            const up = await upload(f);
                            ups.push(up.path);
                          }
                          setAssets((st) => ({ ...st, [v.key]: ups }));
                        }), true),
                      }, assets[v.key] ? '换一批' : '选择…（可多选）'),
                      assets[v.key] ? h(Btn, {
                        key: 'x', size: 'sm', onClick: () => setAssets((st) => ({ ...st, [v.key]: '' })),
                      }, '清除') : null,
                    ])))))) : null,

                h('div', { key: 'voice', style: { marginTop: 22 } },
                  h(Section, { title: '配音' },
                    h('div', null, [
                      h('div', { className: 'dshcv-opts', key: 'o' }, [
                        h(Opt, {
                          key: 'a', checked: voiceMode === 'builtin', onChange: () => setVoiceMode('builtin'),
                          title: '内置兜底音色',
                          desc: '中英切段混读（华言 + lessac），开箱有声。不做音色库、不做音色选择（立项决策 6）。',
                        }),
                        h(Opt, {
                          key: 'b', checked: voiceMode === 'file', onChange: () => setVoiceMode('file'),
                          title: '我自己的配音文件',
                          desc: '给一个 mp3 / wav / m4a，完全跳过我们的 TTS —— 你自己的录音、买的声音都能直接用。',
                        }),
                      ]),
                      voiceMode === 'file' ? h('div', { className: 'dshcv-slot', key: 'f', style: { marginTop: 10 } }, [
                        h('input', {
                          className: 'dshcv-input', value: voiceover || '', readOnly: true, placeholder: '还没选配音文件',
                        }),
                        h(Btn, {
                          size: 'sm',
                          onClick: () => pickFile('audio/*', (f) => run('上传', async () => {
                            const up = await upload(f);
                            setVoiceover(up.path);
                          })),
                        }, voiceover ? '换一个' : '选择…'),
                      ]) : null,
                    ]))),

                h('div', { key: 'outdir', style: { marginTop: 22 } },
                  h(Section, { title: '保存位置' },
                    h('div', null, [
                      h('div', { className: 'dshcv-slot', key: 'o' }, [
                        h('input', {
                          key: 'i', className: 'dshcv-input', value: outDir || (state && state.runtime && state.runtime.outputRoot) || '',
                          placeholder: '成片保存到哪儿（可以改）',
                          onChange: (e) => setOutDir(e.target.value),
                          onKeyDown: (e) => { if (e.key === 'Enter') saveOutDir(e.target.value); },
                        }),
                        // 常用位置：一键填进去（不依赖系统对话框 —— 那个在嵌入式窗口里是残缺的）
                        ...(((state && state.runtime && state.runtime.commonDirs) || [])
                          .filter((d2) => d2.exists)
                          .map((d2) => h(Btn, {
                            key: 'q-' + d2.label, size: 'sm',
                            onClick: () => setOutDir(d2.dir),
                          }, d2.label))),
                        h(Btn, { key: 's', size: 'sm', primary: true, onClick: () => saveOutDir(outDir) }, '确定'),
                        h(Btn, { key: 'x', size: 'sm', onClick: () => { setOutDir(''); setError(null); } }, '取消'),
                        h(Btn, { key: 'o2', size: 'sm', onClick: () => reveal(outDir || (state && state.runtime && state.runtime.outputRoot) || '') }, '打开位置'),
                      ]),
                      h('div', { key: 'h', className: 'dshcv-sub', style: { marginTop: 6 } },
                        '默认放在你自己的影片目录下（不是插件目录、不是系统盘深处）。改完对之后的任务都生效。'),
                      outDirMsg ? h('div', { key: 'm', className: 'dshcv-sub', style: { marginTop: 6, color: '#3FD0E0' } }, outDirMsg) : null,
                    ]))),

                h('div', { key: 'bgm', style: { marginTop: 22 } },
                  h(Section, { title: '背景音乐' },
                    h('div', null, [
                      h('div', { className: 'dshcv-opts', key: 'o' }, [
                        h(Opt, {
                          key: 'n', checked: bgmMode === 'none', onChange: () => setBgmMode('none'),
                          title: '不加背景音乐', desc: '只有配音。',
                        }),
                        h(Opt, {
                          key: 'f', checked: bgmMode === 'file', onChange: () => setBgmMode('file'),
                          title: '用我自己的音乐',
                          desc: '给一个 mp3 / wav / m4a。配音说话时音乐会自动变轻。版权请自行确认。',
                        }),
                      ]),
                      bgmMode === 'file' ? h('div', { className: 'dshcv-slot', key: 'f', style: { marginTop: 10 } }, [
                        h('input', { key: 'i', className: 'dshcv-input', value: bgmFile || '', readOnly: true, placeholder: '还没选音乐' }),
                        h(Btn, {
                          key: 'b', size: 'sm',
                          onClick: () => pickFile('audio/*', (f) => run('上传', async () => {
                            const up = await upload(f);
                            setBgmFile(up.path);
                          })),
                        }, bgmFile ? '换一个' : '选择…'),
                        bgmFile ? h(Btn, { key: 'x', size: 'sm', onClick: () => setBgmFile('') }, '清除') : null,
                      ]) : null,
                    ]))),

                h('div', { key: 'board', style: { marginTop: 22 } },
                  h(Section, { title: '分镜表（可选 · 控制每句配哪张素材、停多久）' },
                    h('div', null, [
                      h('div', { className: 'dshcv-row', key: 'act' }, [
                        h(Btn, { key: 'b', size: 'sm', onClick: buildBoard }, board ? '重新按旁白稿生成' : '按旁白稿生成分镜'),
                        board ? h(Btn, { key: 'c', size: 'sm', onClick: () => setBoard(null) }, '不用分镜表') : null,
                      ]),
                      board ? h('div', { key: 'tbl', style: { marginTop: 10 } }, board.map((row, i) => h('div', {
                        key: i, className: 'dshcv-row', style: { gap: '6px', marginBottom: '6px', alignItems: 'center' },
                      }, [
                        h('span', { key: 'n', className: 'dshcv-sub', style: { width: '20px', flex: 'none' } }, String(i + 1)),
                        h('input', {
                          key: 't', className: 'dshcv-input', value: row.text, readOnly: true,
                          style: { flex: '1 1 auto', minWidth: '120px' },
                        }),
                        h('input', {
                          key: 's', className: 'dshcv-input', type: 'text', value: row.shot || '', readOnly: true,
                          placeholder: '不加图', style: { width: '150px', flex: 'none' },
                        }),
                        h(Btn, {
                          key: 'p', size: 'sm',
                          onClick: () => pickFile('image/*,video/*', (f) => run('上传', async () => {
                            const up = await upload(f);
                            setBoard((rows) => rows.map((r2, k) => (k === i ? { ...r2, shot: up.path } : r2)));
                          })),
                        }, '选图'),
                        h('input', {
                          key: 'st', className: 'dshcv-input', value: String(row.start), title: '开始秒数',
                          onChange: (e) => { const v2 = e.target.value; setBoard((rows) => rows.map((r2, k) => (k === i ? { ...r2, start: v2 } : r2))); },
                          style: { width: '58px', flex: 'none' },
                        }),
                        h('input', {
                          key: 'du', className: 'dshcv-input', value: String(row.duration), title: '持续秒数',
                          onChange: (e) => { const v2 = e.target.value; setBoard((rows) => rows.map((r2, k) => (k === i ? { ...r2, duration: v2 } : r2))); },
                          style: { width: '58px', flex: 'none' },
                        }),
                      ]))) : null,
                      board ? h('div', { key: 'go', className: 'dshcv-row', style: { marginTop: 8 } }, [
                        h(Btn, { key: 'r', primary: true, size: 'sm', onClick: doBoard }, '按分镜表出片'),
                        h('span', { key: 'h', className: 'dshcv-sub' }, `共 ${board.length} 句 · 总时长 ${(board.reduce((a, r2) => Math.max(a, (Number(r2.start) || 0) + (Number(r2.duration) || 0)), 0)).toFixed(1)}s`),
                      ]) : null,
                    ]))),

                h('div', { key: 'out', style: { marginTop: 22 } },
                  h(Section, { title: '渲染与输出' },
                    h('div', null, [
                      h('div', { className: 'dshcv-opts', key: 'o' }, [
                        h(Opt, {
                          key: 'osr', type: 'checkbox', checked: renderer === 'electron-osr',
                          onChange: (on) => { setRendererTouched(true); setRenderer(on ? 'electron-osr' : 'chromium'); },
                          title: '用桌面自带渲染（推荐）',
                          desc: '用桌面端自带的渲染能力出片（更快、更稳）。关掉也能出片，只是慢一点 —— 普通用户不用管这个开关。',
                        }),
                      ]),
                      h('div', { className: 'dshcv-row', key: 'sec', style: { marginTop: 12 } }, [
                        h('span', { className: 'dshcv-label', key: 'l', style: { margin: 0 } }, '预览秒数'),
                        h('input', {
                          key: 'i', className: 'dshcv-input', type: 'number', min: 1, max: 30,
                          style: { width: 76 }, value: previewSeconds,
                          onChange: (e) => setPreviewSeconds(Number(e.target.value) || 4),
                        }),
                        h('span', { className: 'dshcv-sub', key: 'h' }, '预览是半分辨率 + 隔帧、不出配音，先看版式与动效。'),
                      ]),
                    ]))),

                error ? h('div', { key: 'err', className: 'dshcv-issue' }, error) : null,

                h('div', { className: 'dshcv-actions', key: 'actions' }, [
                  h(Btn, { key: 'v', onClick: doValidate, disabled: !!busy }, busy === '校验' ? '校验中…' : '校验'),
                  h(Btn, { key: 'p', onClick: doPreview, disabled: !!busy }, busy === '预览' ? '起任务…' : '预览'),
                  h(Btn, { key: 'f', primary: true, main: true, onClick: doFinal, disabled: !!busy },
                    busy === '出终版' ? '起任务…' : '出终版（横竖双版）'),
                  h(Btn, { key: 't', onClick: doVariants, disabled: !!busy },
                    busy === '三形态' ? '起任务…' : '一次出三形态'),
                ]),
              ]) : h('div', { className: 'dshcv-card', key: 'noform' },
                h(Empty, null, '左边选一个模板开始')),

              validation ? h('div', { className: 'dshcv-card', key: 'val' }, [
                h(Section, {
                  key: 'sec',
                  title: '校验结果',
                  right: h('span', {
                    key: 's', className: `dshcv-chip${validation.ok ? ' dshcv-ok' : ''}`,
                  }, validation.ok ? '✅ 通过' : '⛔ 已拦下渲染'),
                }, h('div', null, [
                  h('div', { key: 'meta', className: 'dshcv-sub' },
                    `引擎 ${validation.engineVersion} · 领域包 ${validation.pack} · ${validation.ok ? '可以出片了' : '修完下面这些再出片'}`),
                  ...validation.templates.flatMap((t) => (t.issues || []).filter((i) => i.level === 'error').map((i, k) => h('div', {
                    key: `${t.orientation}-${k}`, className: 'dshcv-issue',
                  }, [
                    h('div', { key: 'm' }, [
                      h('span', { key: 'o', className: 'dshcv-code' }, `${t.orientation} `),
                      h('span', { key: 'c', className: 'dshcv-code' }, `[${i.code}] `),
                      i.msg,
                    ]),
                    i.advice ? h('div', { key: 'a', className: 'dshcv-sub', style: { marginTop: 3 } }, `→ ${i.advice}`) : null,
                    i.path ? h('div', { key: 'p', className: 'dshcv-code', style: { marginTop: 2 } }, i.path) : null,
                  ]))),
                  ...validation.templates.flatMap((t) => (t.issues || []).filter((i) => i.level === 'warn').map((i, k) => h('div', {
                    key: `w-${t.orientation}-${k}`, className: 'dshcv-issue dshcv-issue-warn',
                  }, `⚠️ [${i.code}] ${i.msg}`))),
                ])),
              ]) : null,

              h('div', { className: 'dshcv-card', key: 'jobs' }, [
                h(Section, {
                  key: 'sec',
                  title: `任务${jobs.length ? ` · ${jobs.length}` : ''}`,
                  right: h('div', { key: 'r', className: 'dshcv-row' }, [
                    h(Btn, { key: 'o', size: 'sm', onClick: checkOsr, disabled: !!busy },
                      busy === '检测渲染能力' ? '检测中…' : '检测渲染能力'),
                  ]),
                }, h('div', null, [
                  osr ? h('div', {
                    key: 'osr', className: `dshcv-banner ${osr.ok ? 'dshcv-ok' : 'dshcv-warn'}`, style: { marginBottom: 10 },
                  }, osr.ok
                    ? `✅ 渲染就绪（极速模式）`
                    : `⚠️ 极速渲染不可用，已自动改用兼容渲染（也能出片，稍慢）。`) : null,
                  jobs.length === 0
                    ? h(Empty, { key: 'e' }, '还没有任务 —— 填好参数，点「预览」或「出终版」')
                    : h('div', { key: 'list' }, [
                        ...visibleJobs.map((j) => h(JobCard, {
                          key: j.id, job: j,
                          onCancel: cancelJob, onResume: resumeJob, onReveal: reveal,
                        })),
                        (hiddenCount > 0 || showAllJobs)
                          ? h('div', { key: 'more', className: 'dshcv-row', style: { justifyContent: 'center', marginTop: 10 } }, [
                              h(Btn, {
                                key: 'b', size: 'sm',
                                onClick: () => setShowAllJobs(!showAllJobs),
                              }, showAllJobs ? '只看最近几条' : `显示全部 ${jobs.length} 条`),
                            ])
                          : null,
                      ]),
                ])),
              ]),
            ]),
          ]),
        ]),
      ]);
    }

    // ── 任务卡片 ──────────────────────────────────────────────────────
    function JobCard({ job, onCancel, onResume, onReveal }) {
      const [open, setOpen] = useState(false);
      // ⚠️ 必须声明在 **JobCard 自己** 里面（2026-10-09 栽了两次）：
      //   第一次声明在 Panel 根组件、用在 JobCard → 渲染成片时
      //   `big is not defined` 直接崩 → 用户出完片看不到成片，只看到一句报错。
      //   教训：**先看清组件边界再放状态**，别凭"附近有 useState"就塞。
      const [big, setBig] = useState(null);   // 全屏看片：存视频 URL
      const pct = job.progress && typeof job.progress.pct === 'number' ? Math.round(job.progress.pct * 100) : null;
      const running = job.status === 'running' || job.status === 'queued';
      const finals = (job.result && job.result.finals) || [];
      const srt = job.result && job.result.subtitle && job.result.subtitle.file;

      const tone = { done: 'dshcv-ok', failed: 'dshcv-err', cancelled: 'dshcv-sub' }[job.status] || 'dshcv-chip-brand';
      const statusText = {
        queued: '排队中', running: '进行中', done: '完成', failed: '失败', cancelled: '已取消',
      }[job.status] || job.status;

      const progressText = job.progress
        ? (job.progress.phase === 'tts'
          ? (job.progress.text || '配音')
          : `${job.progress.orientation === 'vertical' ? '竖版' : job.progress.orientation === 'horizontal' ? '横版' : ''} ${job.progress.done || 0}/${job.progress.total || 0} 帧`) +
          (pct != null ? ` · ${pct}%` : '') +
          (job.progress.msPerFrame ? ` · ${Math.round(job.progress.msPerFrame)} ms/帧` : '') +
          (job.progress.etaMs ? ` · 剩余约 ${Math.round(job.progress.etaMs / 1000)}s` : '')
        : '启动中…';

      return h('div', { className: 'dshcv-job' }, [
        h('div', { className: 'dshcv-job-h', key: 'h' }, [
          h('span', { key: 't', className: 'dshcv-job-t' }, job.title || job.kind),
          h('span', { key: 's', className: `dshcv-chip ${tone}` }, statusText),
          running && job.renderer === 'electron-osr' ? h('span', { key: 'osr', className: 'dshcv-chip' }, '极速') : null,
          h('span', { key: 'sp', className: 'dshcv-spacer' }),
          running ? h(Btn, { key: 'ck', size: 'sm', onClick: () => onCancel(job.id, false) }, '取消但留断点') : null,
          running ? h(Btn, { key: 'c', size: 'sm', danger: true, onClick: () => onCancel(job.id, true) }, '取消并清理') : null,
          !running && job.retryable ? h(Btn, {
            key: 'r', size: 'sm', primary: true, onClick: () => onResume(job),
          }, `续渲（已渲 ${job.renderedAlready || 0} 帧）`) : null,
          h(Btn, { key: 'l', size: 'sm', onClick: () => setOpen(!open) }, open ? '收起' : '详情'),
        ]),

        running ? h('div', { key: 'p' }, [
          h('div', { className: 'dshcv-bar', key: 'b' }, h('i', { style: { width: `${pct == null ? 8 : pct}%` } })),
          h('div', { className: 'dshcv-sub', key: 't', style: { marginTop: 6 } }, progressText),
        ]) : null,

        job.error ? h('div', { key: 'e', className: 'dshcv-issue' }, [
          h('div', { key: 'm' }, job.error.message),
          job.error.advice ? h('div', { key: 'a', className: 'dshcv-sub', style: { marginTop: 3 } }, `→ ${job.error.advice}`) : null,
        ]) : null,

        finals.length ? h('div', { key: 'f' }, [
          h('div', { className: 'dshcv-result' }, finals.map((f) => h('div', { key: f.orientation, className: 'dshcv-video' }, [
            h('video', { key: 'v', src: fileUrl(f.file), controls: true, preload: 'metadata' }),
            h('div', { key: 'c', className: 'dshcv-row' }, [
              h('span', { className: 'dshcv-sub', key: 'l' },
                `${f.orientation === 'vertical' ? '竖版' : '横版'}` +
                (typeof f.bytes === 'number' ? ` · ${(f.bytes / 1048576).toFixed(2)} MB` : '') +
                (typeof f.durationSec === 'number' ? ` · ${f.durationSec}s` : '')),
              h(Btn, { key: 'z', size: 'sm', onClick: () => setBig(fileUrl(f.file)) }, '⛶ 放大'),
              h(Btn, { key: 'p', size: 'sm', onClick: () => run('打开', () => api('/open', { method: 'POST', body: { path: f.file } })) }, '播放器打开'),
              h(Btn, {
                key: 'cp', size: 'sm',
                onClick: () => { try { navigator.clipboard.writeText(f.file); } catch (e) { /* 剪贴板不可用就算了 */ } },
              }, '复制路径'),
              h(Btn, { key: 'o', size: 'sm', onClick: () => onReveal(f.file) }, '打开位置'),
            ]),
          ]))),
          big ? h('div', {
            key: 'big', className: 'dshcv-big', onClick: () => setBig(null),
          }, [
            h('video', { key: 'bv', src: big, controls: true, autoPlay: true, onClick: (e) => e.stopPropagation() }),
            h('div', { key: 'h', className: 'dshcv-big-hint' }, '点空白处关闭'),
          ]) : null,
          srt ? h('div', { key: 'srt', className: 'dshcv-row', style: { marginTop: 10 } }, [
            h('span', { className: 'dshcv-sub', key: 'l' }, `字幕 ${job.result.subtitle.cues} 条`),
            h(Btn, { key: 'b', size: 'sm', onClick: () => onReveal(srt) }, '打开字幕'),
            h(Btn, { key: 'd', size: 'sm', onClick: () => onReveal(job.outDir) }, '打开产物目录'),
          ]) : null,
        ]) : null,

        open ? h('div', { key: 'd' }, [
          h('div', { className: 'dshcv-sub', key: 'p', style: { marginBottom: 6 } }, `产物目录：${job.outDir}`),
          job.result && job.result.renders ? h('div', { key: 'r', className: 'dshcv-sub', style: { marginBottom: 8 } },
            job.result.renders.map((r) => `${r.orientation === 'vertical' ? '竖版' : '横版'} ${r.frames} 帧（新渲 ${r.rendered}、续用 ${r.resumed}）${r.msPerFrame} ms/帧 · ${r.adapter}`).join('　｜　')) : null,
          h('pre', { key: 'log', className: 'dshcv-log' }, (job.logs || []).map((l) => l.msg).join('\n')),
        ]) : null,
      ]);
    }

    // ── 兜底错误边界 ──────────────────────────────────────────────────
    /**
     * 面板里任何一次渲染抛错，DSH 的做法是**把整个槽位打白**（控制台留一句
     * `slot entry crashed in '<slot>'`）——用户看到的是一片空白，什么线索都没有。
     * 第一次上线就踩了：首屏 `...(cond ? arr.map() : el)` 展开了一个非可迭代的
     * 单个元素对象，面板从头到尾没画出来过。
     *
     * 所以这里加一层边界：出错时把**错误原文**画在面板位置，而不是留白。
     * 这不能替代修 bug，但能让下一次"什么都没显示"不再是无解的。
     */
    class PanelBoundary extends react.Component {
      constructor(props) {
        super(props);
        this.state = { error: null };
      }

      static getDerivedStateFromError(error) {
        return { error };
      }

      componentDidCatch(error, info) {
        // eslint-disable-next-line no-console
        console.error(`[${NS}] 面板渲染失败：`, error, info);
      }

      render() {
        if (this.state.error) {
          const message = this.state.error && this.state.error.message
            ? this.state.error.message
            : String(this.state.error);
          return h('div', { className: 'dshcv-root' }, [
            h(StyleTag, { key: 's' }),
            h('div', { className: 'dshcv-col' }, [
              h('div', { className: 'dshcv-issue' }, [
                h('div', { key: 'm' }, `深鲸画布面板出错了：${message}`),
                h('div', { key: 'h', className: 'dshcv-sub', style: { marginTop: 6 } },
                  '先按 Cmd+R 刷新重试；还不行就把这句话发给 DSH 会话。'),
              ]),
              h('div', { key: 'stack', className: 'dshcv-log' }, String(this.state.error && this.state.error.stack || '').slice(0, 800)),
            ]),
          ]);
        }
        return this.props.children;
      }
    }

    function CanvasPanelSafe(props) {
      return h(PanelBoundary, null, h(CanvasPanel, props));
    }
    CanvasPanelSafe.displayName = 'CanvasPanelSafe';

    // ── 注册 ──────────────────────────────────────────────────────────
    const inject = ['slots'];

    function apply(ctx) {
      ctx.slots.inject(SLOT_MAIN, function* () {
        yield ctx.slots.register({ name: SLOT_MAIN, key: PANEL_ID }, CanvasPanelSafe);
      });
      ctx.slots.inject(SLOT_ICON, function* () {
        yield ctx.slots.register(
          { name: SLOT_ICON, id: PANEL_ID, order: 20, label: '深鲸画布' },
          CanvasIcon,
        );
      });
    }

    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  },
});
