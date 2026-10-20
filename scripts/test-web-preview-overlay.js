#!/usr/bin/env node
/**
 * dsh-shell-web-preview 浮层生命周期回归测试（2026-10-20）
 *
 * 用户现场：点开聊天里一个 npm 链接 → 右栏预览被站点拒绝（X-Frame-Options）→
 * 插件在 iframe 上盖了一层「用浏览器打开」兜底浮层 → 用户用浏览器打开后关掉面板，
 * 浮层**留在 document.body 上**，iframe 没了 → 每次 scroll/resize 都把浮层钉到 (0,0)，
 * 表现为侧边栏上粘着一条竖着的「用浏览器打开」按钮，关不掉，只能刷新。
 *
 * 根因两条：
 *   ① iframe 的 destroy() 定义了但**没有任何调用方**（没有监听 removedNodes）；
 *   ② rec.sync() 无条件用 getBoundingClientRect() 定位，iframe 不在文档里时全是 0，
 *      宽度高度 0 但 padding/内容还在 → 左上角一根竖条。
 *
 * 这个测试用最小 DOM 替身跑真实 client.js，覆盖：
 *   [1] 正常情况：探测到「禁止内嵌」→ 浮层出现并贴住 iframe 矩形；
 *   [2] 关掉预览（iframe 被移除）→ 浮层必须被回收（不是隐藏，是移除）；
 *   [3] 竞态：探测还没回来，iframe 已经关了 → 不许再冒出浮层；
 *   [4] 兜底：iframe 还在但矩形塌缩（width/height < 2）→ 浮层隐藏，不许钉在 (0,0)。
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const CLIENT = path.join(REPO, 'shell-plugins/dsh-shell-web-preview/lib/client.js');

let failed = 0;
const ok = (m) => console.log(`  ✅ ${m}`);
const bad = (m) => {
  failed++;
  console.log(`  ❌ ${m}`);
};

// ── 最小 DOM 替身 ───────────────────────────────────────────────────
class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.nodeType = 1;
    this.style = {};
    this.children = [];
    this.parentNode = null;
    this._attrs = {};
    this._listeners = {};
    this.textContent = '';
    this.rect = { left: 0, top: 0, width: 0, height: 0 };
  }
  get isConnected() {
    let n = this;
    while (n.parentNode) n = n.parentNode;
    return n === FAKE_DOC.documentElement || n === FAKE_DOC.body;
  }
  setAttribute(k, v) {
    this._attrs[k] = String(v);
  }
  getAttribute(k) {
    return Object.prototype.hasOwnProperty.call(this._attrs, k) ? this._attrs[k] : null;
  }
  appendChild(c) {
    c.parentNode = this;
    this.children.push(c);
    return c;
  }
  remove() {
    if (this.parentNode) {
      const i = this.parentNode.children.indexOf(this);
      if (i >= 0) this.parentNode.children.splice(i, 1);
      this.parentNode = null;
    }
  }
  addEventListener(t, fn) {
    (this._listeners[t] = this._listeners[t] || []).push(fn);
  }
  removeEventListener(t, fn) {
    const a = this._listeners[t];
    if (a) this._listeners[t] = a.filter((x) => x !== fn);
  }
  querySelectorAll(sel) {
    const out = [];
    const want = String(sel).toUpperCase();
    const walk = (n) => {
      for (const c of n.children) {
        if (c.tagName === want) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  getBoundingClientRect() {
    return this.rect;
  }
}

const FAKE_DOC = {
  documentElement: new El('html'),
  body: null,
  _iframes: [],
  createElement(tag) {
    const el = new El(tag);
    if (el.tagName === 'IFRAME') FAKE_DOC._iframes.push(el);
    return el;
  },
  querySelectorAll(sel) {
    return FAKE_DOC.documentElement.querySelectorAll(sel);
  },
};

function newWindow() {
  const listeners = {};
  const observers = [];
  const win = {
    dsh: null,
    addEventListener(t, fn) {
      (listeners[t] = listeners[t] || []).push(fn);
    },
    removeEventListener(t, fn) {
      const a = listeners[t];
      if (a) listeners[t] = a.filter((x) => x !== fn);
    },
    __listeners: listeners,
    __observers: observers,
  };
  win.__ModuleLoader__ = { load: null };
  return win;
}

function makeEnv() {
  FAKE_DOC.documentElement = new El('html');
  FAKE_DOC.body = new El('body');
  FAKE_DOC.documentElement.appendChild(FAKE_DOC.body);
  FAKE_DOC._iframes = [];
  return newWindow();
}

const CLIENT_CODE = fs.readFileSync(CLIENT, 'utf8');

/**
 * 每个场景都在**独立的 vm 上下文**里重新执行一遍 client.js。
 * 不用 require：模块缓存会让第二次加载拿不到导出（实测），而这里需要干净环境。
 */
function loadPlugin(win, probe) {
  win.dsh = { probeFrameable: probe };
  let exportsObj = null;
  win.__ModuleLoader__ = {
    load: (def) => {
      exportsObj = def.factory();
    },
  };
  class Obs {
    constructor(cb) {
      this.cb = cb;
      win.__observers.push(this);
    }
    observe() {}
    takeRecords() {
      return [];
    }
  }
  const sandbox = {
    window: win,
    document: FAKE_DOC,
    MutationObserver: Obs,
    setTimeout,
    clearTimeout,
    console,
  };
  sandbox.globalThis = sandbox;
  require('vm').runInNewContext(CLIENT_CODE, sandbox, { filename: CLIENT });
  assert(exportsObj, '插件没有导出');
  exportsObj.apply();
  return exportsObj;
}

const tick = () => new Promise((r) => setTimeout(r, 20));

async function main() {
  console.log('\n  dsh-shell-web-preview 浮层生命周期\n');

  // ── [1] 正常：被拒绝 → 浮层出现 ──
  {
    const WINDOW = makeEnv();
    loadPlugin(WINDOW, () => Promise.resolve({ frameable: false }));
    const iframe = FAKE_DOC.createElement('iframe');
    iframe.setAttribute('src', 'https://www.npmjs.com/package/foo');
    iframe.rect = { left: 100, top: 200, width: 400, height: 300 };
    FAKE_DOC.body.appendChild(iframe);
    // apply 时已扫描过一次（那时还没有 iframe），手动补一次 addedNodes
    WINDOW.__observers.forEach((o) =>
      o.cb([{ type: 'childList', addedNodes: [iframe], removedNodes: [] }]),
    );
    await tick();
    const box = FAKE_DOC.body.children.find((c) => c._attrs['data-dsh-frame-blocked']);
    if (box && box.style.display === 'flex' && box.style.left === '100px') ok('被拒站点 → 浮层出现并贴住 iframe');
    else bad(`浮层状态不对（display=${box && box.style.display} left=${box && box.style.left}）`);

    // ── [2] 关掉预览：iframe 被移除 → 浮层必须回收 ──
    iframe.remove();
    WINDOW.__observers.forEach((o) =>
      o.cb([{ type: 'childList', addedNodes: [], removedNodes: [iframe] }]),
    );
    const still = FAKE_DOC.body.children.some((c) => c._attrs['data-dsh-frame-blocked']);
    if (!still) ok('iframe 被移除 → 浮层已从 document.body 回收（不再有幽灵元素）');
    else bad('iframe 被移除后浮层还在 —— 就是用户看到的那条粘在侧边栏的按钮');

    // 再触发一次 scroll（旧实现会把它钉到 0,0）
    (WINDOW.__listeners.scroll || []).forEach((fn) => fn());
    const ghost = FAKE_DOC.body.children.some((c) => c._attrs['data-dsh-frame-blocked']);
    if (!ghost) ok('scroll 之后也不会再冒出浮层');
    else bad('scroll 之后浮层又出现了');
  }

  // ── [3] 竞态：探测未返回，iframe 已关闭 ──
  {
    const WINDOW = makeEnv();
    let resolveProbe;
    loadPlugin(WINDOW, () => new Promise((r) => (resolveProbe = r)));
    const iframe = FAKE_DOC.createElement('iframe');
    iframe.setAttribute('src', 'https://github.com/x/y');
    iframe.rect = { left: 10, top: 10, width: 300, height: 200 };
    FAKE_DOC.body.appendChild(iframe);
    WINDOW.__observers.forEach((o) =>
      o.cb([{ type: 'childList', addedNodes: [iframe], removedNodes: [] }]),
    );
    await tick();
    iframe.remove(); // 用户先关了面板
    WINDOW.__observers.forEach((o) =>
      o.cb([{ type: 'childList', addedNodes: [], removedNodes: [iframe] }]),
    );
    resolveProbe({ frameable: false }); // 探测这时才回来
    await tick();
    const box = FAKE_DOC.body.children.find((c) => c._attrs['data-dsh-frame-blocked']);
    if (!box) ok('竞态：iframe 关掉后探测才返回 → 不会冒出浮层');
    else bad('竞态：iframe 已关，浮层还是出现了');
  }

  // ── [4] 矩形塌缩：iframe 还在但尺寸为 0 → 隐藏，不钉 (0,0) ──
  {
    const WINDOW = makeEnv();
    loadPlugin(WINDOW, () => Promise.resolve({ frameable: false }));
    const iframe = FAKE_DOC.createElement('iframe');
    iframe.setAttribute('src', 'https://www.npmjs.com/package/bar');
    iframe.rect = { left: 0, top: 0, width: 0, height: 0 };
    FAKE_DOC.body.appendChild(iframe);
    WINDOW.__observers.forEach((o) =>
      o.cb([{ type: 'childList', addedNodes: [iframe], removedNodes: [] }]),
    );
    await tick();
    (WINDOW.__listeners.scroll || []).forEach((fn) => fn());
    const box = FAKE_DOC.body.children.find((c) => c._attrs['data-dsh-frame-blocked']);
    if (box && box.style.display === 'none') ok('iframe 尺寸塌缩 → 浮层隐藏（不会钉在左上角）');
    else bad(`尺寸塌缩时浮层仍然显示（display=${box && box.style.display}）`);
  }

  console.log(failed === 0 ? '\n  ✅ 浮层生命周期测试全过\n' : `\n  ❌ 失败 ${failed} 项\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('  ❌ 测试异常：', e);
  process.exit(1);
});
