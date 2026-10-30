/**
 * 首次启动的「插件指南」浮标（2026-10-29 用户定）
 *
 * 要求原话：
 *   「只留记忆，画布、拆解、工序都不要，用户下载好就是空白的最好，可以写一个提示弹窗
 *    （一个浮动小按钮，点击有具体细节）我们有什么类型的插件，需要什么可以让他们自行下载
 *    就好，下载步骤，相应名称看我们怎么来告诉用户；这个功能只有初次使用我们的桌面端才有，
 *    升级或者重装之后就不要有了」
 *
 * 落法：
 *   · 随包插件只留「深鲸记忆」，侧栏对新用户是干净的；
 *   · 首次启动在右下角注入一个小浮标「插件指南」，点开是分类清单 + 安装命令 + 官网入口；
 *   · 用 `<home>/.plugin-guide-shown` 标记，只显示一次；升级/重装复用同一个 dsh-home，
 *     所以不会再来打扰（用户若删掉标记 = 想再看一次，也尊重）。
 */
import { app, BrowserWindow } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';

const MARKER = '.plugin-guide-shown';

const 分类: Array<{ 标题: string; 说明: string; 包: Array<[string, string]> }> = [
  {
    标题: '办公与文档',
    说明: '批量处理 Word / Excel / PDF、文档质检、文件整理、交付打包',
    包: [
      ['深鲸文档批量处理', '@deepwhale-cn/dsh-docx-batch'],
      ['Excel 批量处理', '@deepwhale-cn/dsh-xlsx-batch'],
      ['PDF 工具箱', '@deepwhale-cn/dsh-pdf-kit'],
      ['深鲸文档质检', '@deepwhale-cn/dsh-doc-qc'],
      ['深鲸文件整理', '@deepwhale-cn/dsh-file-organizer'],
      ['深鲸交付包', '@deepwhale-cn/dsh-deliverable-pack'],
    ],
  },
  {
    标题: '设计与工序',
    说明: 'PS 出图、CAD 标准化、3ds Max / Blender 批渲染的流水线与交付凭证',
    包: [['深鲸工序（设计流水线）', '@deepwhale-cn/dsh-design-line']],
  },
  {
    标题: '行业合规体检',
    说明: '医疗 / 财税 / 招聘 / 制造 / 房产 / 档案 / 工程，一个面板管七个行业',
    包: [['深鲸行业合规体检', '@deepwhale-cn/dsh-industry-checkup']],
  },
  {
    标题: '安全与运维',
    说明: '上线前暴露面扫描、代码能力清单、远程访问加固',
    包: [
      ['深鲸远程门禁', '@deepwhale-cn/dsh-remote-gate'],
      ['深鲸能力清单', '@deepwhale-cn/dsh-capability-audit'],
    ],
  },
  {
    标题: '凭据与记忆',
    说明: '本机密钥保险箱（只显示掩码）与记忆工具',
    包: [
      ['深鲸密钥箱', '@deepwhale-cn/dsh-key-vault'],
      ['深鲸记忆体检', 'dsh-memory-doctor'],
    ],
  },
];

function 页面(): string {
  const 分组 = 分类
    .map(
      (g) => `
      <section class="g">
        <h3>${g.标题}</h3>
        <p class="d">${g.说明}</p>
        ${g.包
          .map(
            ([名称, 包名]) => `
          <div class="row">
            <div class="n">${名称}</div>
            <code class="cmd">dsh plugin --profile web add ${包名}</code>
          </div>`,
          )
          .join('')}
      </section>`,
    )
    .join('');

  return `(() => {
  if (document.getElementById('dwh-plugin-guide')) return true;
  const css = document.createElement('style');
  css.textContent = \`
    #dwh-plugin-guide-btn{position:fixed;right:18px;bottom:18px;z-index:2147483000;display:inline-flex;align-items:center;gap:6px;
      padding:9px 14px;border-radius:999px;border:1px solid rgba(0,0,0,.12);background:#fff;color:#111;font:13px/1 -apple-system,'PingFang SC',sans-serif;
      box-shadow:0 6px 24px rgba(0,0,0,.18);cursor:pointer}
    #dwh-plugin-guide-btn:hover{box-shadow:0 8px 28px rgba(0,0,0,.24)}
    #dwh-plugin-guide{position:fixed;inset:0;z-index:2147483001;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;
      font:14px/1.6 -apple-system,'PingFang SC',sans-serif}
    #dwh-plugin-guide .box{width:min(720px,92vw);max-height:82vh;overflow:auto;background:#fff;color:#111;border-radius:16px;
      box-shadow:0 24px 80px rgba(0,0,0,.35);padding:22px 24px 18px}
    #dwh-plugin-guide h2{margin:0 0 4px;font-size:18px}
    #dwh-plugin-guide .lead{margin:0 0 14px;color:#666;font-size:13px}
    #dwh-plugin-guide h3{margin:16px 0 2px;font-size:14px}
    #dwh-plugin-guide .d{margin:0 0 8px;color:#888;font-size:12px}
    #dwh-plugin-guide .row{display:flex;align-items:center;gap:10px;padding:6px 0;border-top:1px solid #f0f0f0;flex-wrap:wrap}
    #dwh-plugin-guide .n{min-width:170px;font-weight:500}
    #dwh-plugin-guide .cmd{flex:1;min-width:0;padding:6px 8px;border-radius:8px;background:#f6f7f9;border:1px solid #e6e8ec;
      font:12px ui-monospace,Menlo,monospace;word-break:break-all;cursor:copy}
    #dwh-plugin-guide .foot{display:flex;gap:10px;justify-content:flex-end;margin-top:16px}
    #dwh-plugin-guide button{font:13px -apple-system,'PingFang SC',sans-serif;padding:8px 16px;border-radius:9px;cursor:pointer;
      border:1px solid #d9dde3;background:#fff}
    #dwh-plugin-guide .primary{background:#1f6feb;border-color:#1f6feb;color:#fff}
  \`;
  document.head.appendChild(css);

  const btn = document.createElement('button');
  btn.id = 'dwh-plugin-guide-btn';
  btn.innerHTML =
    '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/>' +
    '<rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>' +
    '<span>插件指南</span>';
  document.body.appendChild(btn);

  const open = () => {
    if (document.getElementById('dwh-plugin-guide')) return;
    const wrap = document.createElement('div');
    wrap.id = 'dwh-plugin-guide';
    wrap.innerHTML = \`
      <div class="box" role="dialog" aria-modal="true" aria-label="插件指南">
        <h2>需要什么，装什么</h2>
        <p class="lead">桌面端默认只带「深鲸记忆」。下面是按用途分类的插件，装完后在左侧栏出现入口；也可以在「设置 → 插件 → 发现」里搜名字安装。</p>
        ${分组}
        <div class="foot">
          <button data-act="site">打开插件官网</button>
          <button class="primary" data-act="close">知道了</button>
        </div>
      </div>\`;
    document.body.appendChild(wrap);
    wrap.addEventListener('click', async (e) => {
      const t = e.target;
      if (t === wrap) return;
      if (t.dataset.act === 'close') {
        wrap.remove();
        btn.remove();
      }
      if (t.dataset.act === 'site') window.open('https://deepwhale.org.cn/plugins.html', '_blank');
    });
    wrap.querySelectorAll('.cmd').forEach((el) => {
      el.title = '点击复制';
      el.addEventListener('click', () => {
        navigator.clipboard && navigator.clipboard.writeText(el.textContent || '');
        const old = el.textContent;
        el.textContent = '✅ 已复制';
        setTimeout(() => { el.textContent = old; }, 1200);
      });
    });
  };
  btn.addEventListener('click', open);
  return true;
})();`;
}

/** 只在首次启动注入（升级/重装不会重复） */
export function installPluginGuide(win: BrowserWindow, homeDir?: string): void {
  try {
    const home = homeDir || path.join(app.getPath('userData'), 'dsh-home');
    const marker = path.join(home, MARKER);
    if (fs.existsSync(marker)) return;
    const 注入 = (): void => {
      void win.webContents
        .executeJavaScript(页面())
        .then((ok) => {
          if (ok === true) {
            try {
              fs.mkdirSync(home, { recursive: true });
              fs.writeFileSync(marker, new Date().toISOString() + '\n', 'utf-8');
            } catch {
              /* 标记写不了就下次再显示，不影响使用 */
            }
          }
        })
        .catch(() => {
          /* 注入失败不打扰用户 */
        });
    };
    win.webContents.on('did-finish-load', 注入);
  } catch {
    /* 纯增量功能，出错不影响启动 */
  }
}
