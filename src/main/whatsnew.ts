/**
 * 每版更新说明（"这版改了什么"）—— 2026-10-04 用户提议：
 *   「这版48能在更新前出个展示版来显示48到底更新了什么（以后升级也一样提示），
 *     这样让用户明确知道我们升级了什么，要不然一头雾水靠猜的…体验感不好」
 *
 * 数据来源（两级，取得到就用新的）：
 *   ① 随包兜底：`<app>/assets/whatsnew.json`（assets 目录，见 copy-assets）
 *   ② CDN：`https://dl.deepwhale.org.cn/whatsnew.json` —— **关键**：跑在旧版本里的壳，
 *      也要能读到"新版本改了什么"，所以必须走网络；CDN 在国内快，且发布时同步。
 * 拿到后落一份到 `<userData>/whatsnew-cache.json`，6 小时内不重复请求。
 *
 * 只读、无副作用；任何失败都静默回退到兜底内容，绝不阻塞更新流程。
 */
import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

export interface WhatsNewItem {
  kind: string; // feat / fix / perf / docs …
  text: string;
}
export interface WhatsNewEntry {
  date?: string;
  title?: string;
  items: WhatsNewItem[];
}
interface WhatsNewFile {
  versions?: Record<string, WhatsNewEntry>;
}

const CDN_URL = 'https://dl.deepwhale.org.cn/whatsnew.json';
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

let memory: WhatsNewFile | null = null;

function bundledPath(): string {
  // 打包后：<App>/Contents/Resources/app/assets/whatsnew.json（assets 由 copy-assets 搬进来）
  const candidates = [
    path.join(__dirname, '../assets/whatsnew.json'),
    path.join(app.getAppPath(), 'assets/whatsnew.json'),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      /* 忽略 */
    }
  }
  return candidates[0];
}

function readJson(file: string): WhatsNewFile | null {
  try {
    const raw = fs.readFileSync(file, 'utf-8');
    const data = JSON.parse(raw) as WhatsNewFile;
    if (data && typeof data === 'object' && data.versions) return data;
  } catch {
    /* 忽略 */
  }
  return null;
}

function cachePath(): string {
  return path.join(app.getPath('userData'), 'whatsnew-cache.json');
}

/** 拉取（带缓存）：优先 CDN，失败回退随包内容 */
export async function loadWhatsNew(force = false): Promise<WhatsNewFile> {
  if (memory && !force) return memory;

  // ① 缓存新鲜就直接用
  try {
    const st = fs.statSync(cachePath());
    if (!force && Date.now() - st.mtimeMs < CACHE_TTL_MS) {
      const cached = readJson(cachePath());
      if (cached) {
        memory = cached;
        return cached;
      }
    }
  } catch {
    /* 没缓存 */
  }

  // ② 走 CDN（5 秒超时，失败不影响任何事）
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(CDN_URL, { signal: ctrl.signal });
    clearTimeout(timer);
    if (res.ok) {
      const data = (await res.json()) as WhatsNewFile;
      if (data && data.versions) {
        try {
          fs.writeFileSync(cachePath(), JSON.stringify(data), 'utf-8');
        } catch {
          /* 写不进缓存也无所谓 */
        }
        memory = data;
        return data;
      }
    }
  } catch {
    /* 离线/被墙都正常：下面回退 */
  }

  // ③ 回退随包内容
  const fallback = readJson(bundledPath());
  memory = fallback ?? { versions: {} };
  return memory;
}

/** 取某一版的说明；取不到返回空 */
export async function notesFor(version: string): Promise<WhatsNewEntry | null> {
  const data = await loadWhatsNew();
  const v = String(version || '').replace(/^v/, '');
  const entry = data.versions?.[v];
  if (!entry || !Array.isArray(entry.items)) return null;
  return entry;
}

/** 摘要成几行纯文本（给系统对话框用；对话框不支持富文本） */
export function summarize(entry: WhatsNewEntry | null, max = 5): string {
  if (!entry || !entry.items.length) return '';
  const lines = entry.items.slice(0, max).map((it) => '· ' + it.text);
  const more = entry.items.length > max ? `\n· …还有 ${entry.items.length - max} 条` : '';
  return lines.join('\n') + more;
}
