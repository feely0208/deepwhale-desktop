#!/usr/bin/env node
/**
 * 真机验收（HarmonyOS + hdc）：自动启动深鲸 Mobile、逐页截图，供人一眼复核
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么要有它：手机端的"最后一公里"只能真机验（ArkWeb 的文件选择器、相机、
 * 软键盘行为都跟桌面 Chromium 不完全一样）。但真机点按坐标容易漂，所以把流程
 * 固化成脚本 + **每步都截图**：坐标不对时从截图上能立刻看出来，而不是"点不动=功能坏了"。
 *
 * 前提：
 *   · 手机用 hdc 连着（先 `hdc list targets` 能看到设备）；
 *   · 桌面端已经开着「手机访问」（手机里存了令牌，或本脚本带 --pair 自己配对）。
 *
 * 用法：
 *   node scripts/check-device-mobile.mjs                 # 直接启动 App（自动进入）+ 截图
 *   node scripts/check-device-mobile.mjs --pair          # 先按状态文件里的配对码重新配对（免扫码）
 *   node scripts/check-device-mobile.mjs --out <dir>     # 截图目录（默认 手机端-交付/真机-验收-<时间>）
 *   node scripts/check-device-mobile.mjs --steps list,chat,trace,model,attach
 *
 * 说明：
 *   · hdc / snapshot_display 的截图像素 = 设备物理像素，uiInput 坐标与截图 **1:1**（本机 1260×2720 实测）；
 *   · 不会清 App 数据、不会改用户设置；--pair 会更新 App 里的令牌（这正是"扫码配对"做的事）。
 */
'use strict';

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HDC = process.env.HDC_BIN || '/Applications/DevEco-Studio.app/Contents/sdk/default/openharmony/toolchains/hdc';
const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const GATEWAY_STATE = path.join(os.homedir(), 'Library', 'Application Support', 'DeepWhale Desktop', 'mobile-gateway.json');
const RESULT_LINES = [];

function hdc(args, { timeout = 30000 } = {}) {
  return execFileSync(HDC, args, { encoding: 'utf8', timeout }).trim();
}
function shell(cmd) {
  return hdc(['shell', cmd]);
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function log(m) {
  console.log(m);
  RESULT_LINES.push(m);
}

function parseArgs(argv) {
  const out = { pair: false, out: '', steps: ['list', 'chat', 'trace', 'model', 'attach'] };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--pair') out.pair = true;
    else if (argv[i] === '--out') out.out = argv[++i] || '';
    else if (argv[i] === '--steps') out.steps = String(argv[++i] || '').split(',').filter(Boolean);
  }
  return out;
}

function devices() {
  try {
    return hdc(['list', 'targets'])
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s && !/unauthorized|offline/i.test(s));
  } catch {
    return [];
  }
}

function lanIp() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) return ni.address;
    }
  }
  return '127.0.0.1';
}

function readGatewayState() {
  try {
    return JSON.parse(fs.readFileSync(GATEWAY_STATE, 'utf8'));
  } catch {
    return null;
  }
}

function snapshot(name, outDir) {
  const remote = `/data/local/tmp/dsh-verify-${String(Date.now())}.jpeg`;
  shell(`snapshot_display -f ${remote}`);
  const local = path.join(outDir, `${name}.jpeg`);
  hdc(['file', 'recv', remote, local]);
  try {
    shell(`rm -f ${remote}`);
  } catch {}
  return local;
}

function tap(x, y) {
  shell(`uitest uiInput click ${String(Math.round(x))} ${String(Math.round(y))}`);
}
function swipe(x1, y1, x2, y2) {
  shell(`uitest uiInput swipe ${String(Math.round(x1))} ${String(Math.round(y1))} ${String(Math.round(x2))} ${String(Math.round(y2))} 300`);
}
function screenshotSize(file) {
  // 用 sips 读尺寸（macOS 自带）
  try {
    const out = execFileSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', file], { encoding: 'utf8' });
    const w = Number(/pixelWidth:\s*(\d+)/.exec(out)?.[1] || 0);
    const h = Number(/pixelHeight:\s*(\d+)/.exec(out)?.[1] || 0);
    return { w, h };
  } catch {
    return { w: 1260, h: 2720 };
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const devs = devices();
  if (!devs.length) {
    console.log('DEVICE_RESULT ' + JSON.stringify({ skipped: 'no-device' }));
    console.log('（没有 hdc 设备：插线/同 WiFi 或开开发者选项后再跑）');
    return;
  }
  const dev = devs[0];
  console.log(`设备：${dev}`);
  const stamp = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().replace(/[-:T]/g, '').slice(0, 12);
  const outDir = args.out || path.join(os.homedir(), 'Desktop', `真机-验收-${stamp}`);
  fs.mkdirSync(outDir, { recursive: true });
  const shots = [];

  // ① 启动 App（可选：先用状态文件里的配对码重新配对，免扫码）
  let pairInfo = null;
  if (args.pair) {
    const st = readGatewayState();
    if (!st || !st.pairCode || !st.port) {
      console.log('--pair 需要状态文件里有 port/pairCode，但没有；退回直接启动');
    } else {
      const origin = `http://${lanIp()}:${String(st.port)}`;
      const payload = `dshmobile://pair?origin=${encodeURIComponent(origin)}&code=${encodeURIComponent(st.pairCode)}`;
      pairInfo = { origin, pairCode: st.pairCode };
      console.log(`配对：${origin} code=${st.pairCode}`);
      shell('aa force-stop org.deepwhale.mobile');
      await sleep(800);
      shell(`aa start -a EntryAbility -b org.deepwhale.mobile --ps pairUrl "${payload}"`);
    }
  }
  if (!args.pair) {
    shell('aa force-stop org.deepwhale.mobile');
    await sleep(800);
    shell('aa start -a EntryAbility -b org.deepwhale.mobile');
  }
  await sleep(7000); // 配对 + WebView 首次加载
  if (args.steps.includes('list')) {
    shots.push(snapshot('1-list', outDir));
  }
  const size = screenshotSize(shots[0] || path.join(outDir, '1-list.jpeg'));
  const W = size.w || 1260;
  const H = size.h || 2720;
  // ⚠️ 真机实测（2026-10-19，1260×2720）：ArkWeb viewport 是 **388×772 CSS**，dpr=3.25，
  //    截图 1260×2720 里**只有上面 2509px 是网页**，下面 211px 是系统区域。
  //    uiInput 用的是**设备像素**，所以把 CSS 布局坐标 × (W/388) 即可 —— 比"按比例猜"稳得多。
  const CSS_W = Number(process.env.DEVICE_CSS_W || 388);
  const CSS_VH = Number(process.env.DEVICE_CSS_VH || 772);
  // 垂直方向还有**状态栏偏移**（WebView 从状态栏下面开始）：实测 2720 高时约 90px。
  // 不补这个偏移，所有 tap 都会整体偏上 ~90px（第一版就这么错过，点到了按钮而不是会话行）。
  const TOP = Number(process.env.DEVICE_TOP_PX || 90);
  const DPR = W / CSS_W;
  const C = (cx, cy) => [cx * DPR, TOP + cy * DPR];
  console.log(`截图尺寸 ${W}×${H}，CSS ${CSS_W}×${CSS_VH}，dpr≈${DPR.toFixed(2)}`);
  // 列表：page-head 以下 = 搜索 14+44 / 新建按钮 / 行（min-height 64）；第一条会话行中心 ≈ y221
  // 默认打开第一条会话；DEVICE_ROW_CSS_Y 可指定别的行（例如挑一个带图片附件的会话做截图）
  const ROW1 = C(194, Number(process.env.DEVICE_ROW_CSS_Y || 221));
  // 会话页 tabs 行：back(44) + 对话 + 轨迹（各占一半），行中心 y≈100
  const BACK = C(36, 100);
  const TAB_CHAT = C(139, 100);
  const TAB_TRACE = C(297, 100);
  const BTN_NEW = C(194, 165);
  // composer：CSS 高 = 10(pad) + chips(44 单行) + 10 + input(48) + 10 = 122 → top = 772-122 = 650
  // chips 单行时（UI 已给模型/工作区名截断，正常不会折行）：
  // 附件(~57) / ws(~102) / 模型(~97) / 强度(~57) + 3×9 gap，左起 14 → 中心 x≈42/131/240/326
  const CHIP_MODEL = C(240, 682);
  const CHIP_EFFORT = C(326, 682);
  // 输入行：中心 y = 772-10-24 = 738；＋ 按钮 x = 14+24 = 38
  const BTN_PLUS = C(38, 738);

  if (args.steps.includes('chat')) {
    tap(...ROW1);
    await sleep(3500);
    shots.push(snapshot('2-chat', outDir));
    // 往下拖（看更早的消息/附件卡）：聊天默认停在底部
    swipe(W * 0.5, H * 0.3, W * 0.5, H * 0.62);
    await sleep(1000);
    swipe(W * 0.5, H * 0.3, W * 0.5, H * 0.62);
    await sleep(1200);
    shots.push(snapshot('3-chat-scrolled', outDir));
  }
  if (args.steps.includes('trace')) {
    tap(...TAB_TRACE);
    await sleep(2500);
    shots.push(snapshot('4-trace', outDir));
    tap(...TAB_CHAT);
    await sleep(1200);
  }
  if (args.steps.includes('model') || args.steps.includes('attach')) {
    // 回列表 → 新建会话（chips 是短标签，单行，坐标稳定）
    tap(...BACK);
    await sleep(1500);
    tap(...BTN_NEW);
    await sleep(3000);
  }
  if (args.steps.includes('model')) {
    tap(...CHIP_MODEL);
    await sleep(2000);
    shots.push(snapshot('5-model-sheet', outDir));
    // 选第一个模型（面板从底部弹出，选项行 ~52 CSS 高；点第一项）
    tap(...C(194, CSS_VH - 110));
    await sleep(2200);
    shots.push(snapshot('6-after-model-pick', outDir));
    // 关面板：点顶部遮罩
    tap(...C(194, 30));
    await sleep(800);
  }
  if (args.steps.includes('attach')) {
    tap(...BTN_PLUS);
    await sleep(1800);
    shots.push(snapshot('7-attach-sheet', outDir));
    tap(...C(194, 30)); // 点遮罩关闭
    await sleep(600);
  }
  // 最后重启一次 App，让它停在列表页（不把用户留在奇怪页面）
  try {
    shell('aa force-stop org.deepwhale.mobile');
    await sleep(600);
    shell('aa start -a EntryAbility -b org.deepwhale.mobile');
    await sleep(5000);
    shots.push(snapshot('9-final-list', outDir));
  } catch {}

  console.log('DEVICE_RESULT ' + JSON.stringify({ device: dev, pair: pairInfo, outDir, shots, steps: args.steps }));
  console.log(`截图：${outDir}`);
}

main().catch((e) => {
  console.error('真机验收脚本出错:', e && e.message);
  console.log('DEVICE_RESULT ' + JSON.stringify({ error: String(e && e.message) }));
  process.exit(1);
});
