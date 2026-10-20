#!/usr/bin/env node
/**
 * 手机端界面能力断言（Electron 透明窗口，**真 DSH**）——附件展示/发送、轨迹 tab、chips 切换、手机审批卡
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么用 Electron 而不是在真机上点：这些交互（看图/切模型/审批按钮）需要
 * 精确点击与 DOM 断言；真机上 hdc 坐标点按不稳（交接文档踩过）。Electron 的
 * Chromium 与鸿蒙 WebView 是同一套前端代码，先在桌面端把"页面行为"钉住，
 * 真机只做一眼验收。
 *
 * 复用 `check-mobile-attachments.mjs` 建的临时 home（里面有带图片/文件附件的真会话），
 * 所以两个脚本串起来跑最省时间：先附件链路，再界面链路。
 *
 * 用法：node scripts/check-mobile-features-e2e.mjs
 *   · DSH 一律 --no-open；Electron 窗口不可见（show:false / opacity:0）——不打扰用户；
 *   · 真实模型调用只发 1~2 条很小 prompt（审批卡用例）。
 */
import { spawn } from 'node:child_process';
import { mkdirSync, cpSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.DSH_MOBILE_FEATURES_PORT || 46940);
const PROFILE = 'deepwhale';
const HOME = join(tmpdir(), 'dsh-mobile-attach');   // 与附件断言共用（跑过附件断言后这里已有真会话）
const OUT = '/tmp/dsh-mobile-features';
const SHOTS = join(OUT, 'shots');
let dshGlobal = null;
// 用**我们自己的网关**（src/main/mobile-gateway.ts 的编译产物）来加载页面：
// 这样测的是真机同一条链路（手机 → 网关（令牌）→ DSH 插件 → 页面），而不是绕过网关直连 DSH。
const { startMobileGateway } = require(join(REPO, 'dist', 'main', 'mobile-gateway.js'));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function request(pathname, { method = 'GET', body, contentType, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: PORT, path: pathname, method, headers: { ...(contentType ? { 'content-type': contentType } : {}), ...headers, ...(body ? { 'content-length': Buffer.byteLength(body) } : {}) } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      },
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function jsonOf(res) {
  try {
    return JSON.parse(res.body.toString('utf8'));
  } catch {
    return null;
  }
}

async function main() {
  mkdirSync(SHOTS, { recursive: true });
  // 看门狗：任何一步卡住都不要把会话拖死（测试基础设施，宁可红也不要挂）
  const watchdog = setTimeout(() => {
    console.error('❌ 看门狗触发：10 分钟没有跑完，强制退出');
    try { dshGlobal?.kill('SIGKILL'); } catch {}
    process.exit(1);
  }, 10 * 60 * 1000);
  watchdog.unref();
  // 1) 需要临时 home 已初始化（跑过 check-mobile-attachments.mjs 就有）
  if (!existsSync(join(HOME, 'profiles', PROFILE, 'package.json'))) {
    console.error('❌ 临时 DSH home 不存在，请先跑 node scripts/check-mobile-attachments.mjs');
    process.exit(1);
  }
  // 2) 装最新插件 + 手机端界面
  const pluginSrc = join(REPO, 'shell-plugins', 'dsh-shell-mobile');
  const pluginDst = join(HOME, 'plugins', 'dsh-shell-mobile');
  rmSync(pluginDst, { recursive: true, force: true });
  cpSync(pluginSrc, pluginDst, { recursive: true });
  cpSync(join(REPO, 'mobile-ui'), join(pluginDst, 'ui'), { recursive: true });
  try {
    rmSync(join(HOME, 'profiles', PROFILE, 'node_modules', '@deepwhale-cn', 'dsh-shell-mobile'), { force: true });
  } catch {}
  spawn('ln', ['-sfn', pluginDst, join(HOME, 'profiles', PROFILE, 'node_modules', '@deepwhale-cn', 'dsh-shell-mobile')]);
  const pkgPath = join(HOME, 'profiles', PROFILE, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const dshCfg = (pkg.dsh ??= {});
  const prof = (dshCfg.profile ??= {});
  const bundles = (prof.bundles ??= []);
  if (!bundles.includes('@deepwhale-cn/dsh-shell-mobile')) bundles.push('@deepwhale-cn/dsh-shell-mobile');
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));

  // 3) 起 DSH（--no-open）
  const dsh = spawn(
    process.execPath,
    [join(REPO, 'dsh-runtime/node_modules/.bin/dsh'), '--profile', PROFILE, '--no-open', '--port', String(PORT)],
    {
      cwd: join(REPO, 'dsh-runtime'),
      // assets/whatsnew.json 的读取路径（插件在临时 home 里，找不到仓库 assets）
      env: { ...process.env, DSH_HOME: HOME, DSH_MOBILE_ASSETS_DIR: join(REPO, 'assets'), PATH: `/usr/local/bin:${process.env.PATH}` },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let log = '';
  dsh.stdout.on('data', (d) => (log += d));
  dsh.stderr.on('data', (d) => (log += d));
  let token = '';
  for (let i = 0; i < 60 && !token; i += 1) {
    const m = /token=([^\s]+)/.exec(log);
    if (m) token = m[1];
    else await wait(500);
  }
  dshGlobal = dsh;
  if (!token) {
    console.error('DSH 未就绪，日志：\n' + log.slice(0, 1200));
    dsh.kill('SIGKILL');
    process.exit(1);
  }
  // 4) 起我们自己的网关（真机同一条链路），页面从网关打开
  const gw = await startMobileGateway({ dshBase: `http://127.0.0.1:${PORT}`, dshToken: token, port: 0 });
  const gwBase = `http://127.0.0.1:${gw.port}`;
  const gwToken = gw.session.token;
  console.log(`网关就绪：${gwBase}（页面从这里打开，与真机一致）`);

  // 5) Electron 透明窗口跑界面断言
  const driver = join(REPO, 'scripts', '_e2e-mobile-features.js');
  const el = spawn(join(REPO, 'node_modules/.bin/electron'), [driver], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '',
      DSH_E2E_BASE: gwBase,
      DSH_E2E_TOKEN: gwToken,
      DSH_E2E_SESSION: (() => {
        // 精确打开附件断言那个会话（带图片/文件）；没有就退回"逐行找有消息的会话"
        try {
          return JSON.parse(readFileSync(join(tmpdir(), 'dsh-mobile-attach', 'latest-session.json'), 'utf8')).sessionId || '';
        } catch {
          return '';
        }
      })(),
      DSH_E2E_SHOTS: SHOTS,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  el.stdout.on('data', (d) => {
    out += d;
    process.stdout.write(String(d));   // 实时打印，卡住时能看出卡在哪一步
  });
  el.stderr.on('data', (d) => {
    out += d;
    process.stdout.write(String(d));
  });
  // ⚠️ spawn 失败时只有 'error' 事件（'exit' 不触发）—— 不处理会**永久挂住**（踩过一次：跑了 8 分钟没结果）
  await new Promise((resolve) => {
    el.on('error', (e) => {
      out += '\n[electron spawn error] ' + String(e && e.message);
      resolve();
    });
    el.on('exit', () => resolve());
  });
  console.log('[e2e] electron 已退出，收网关…');
  // ⚠️ 不能 await：网关上游 keep-alive socket 会让 server.close 的回调迟迟不来（实测挂住 5 分钟）
  void Promise.resolve(gw.stop()).catch(() => {});
  dsh.kill('SIGKILL');
  console.log('[e2e] 网关/DSH 已收');

  const m = /FEATURES_RESULT (\{.*\})/.exec(out);
  writeFileSync(join(OUT, 'raw.log'), out);
  if (!m) {
    console.error('❌ 界面断言没有产出结果：\n' + out.slice(-2500));
    process.exit(1);
  }
  let data = {};
  try {
    data = JSON.parse(m[1]);
  } catch (e) {
    console.error('❌ 结果不是 JSON：', m[1].slice(0, 800));
    process.exit(1);
  }
  const problems = [];
  const skips = [];
  if (!(data.rows >= 1)) problems.push(`列表页没有渲染会话行（${data.rows}）`);
  // 列表页不该挂聊天输入区（真机反馈过"底部白占 1/3 屏"）—— 冷启动直接进列表时最容易漏
  if (data.composerOnList && data.composerOnList !== 'none') {
    problems.push(`列表页仍然显示聊天输入区（composer display=${data.composerOnList}）`);
  }
  if (!(data.chatMsgs >= 2)) problems.push(`会话页消息不足（${data.chatMsgs}）`);
  if (!(data.attachCards >= 1)) problems.push('会话页没有渲染出附件卡（图片/文件）');
  if (data.imageLoaded !== true) problems.push(`点击附件卡后图片没有真正加载出来（naturalWidth=${data.imageNaturalWidth}）`);
  if (!(data.traceRows >= 1)) problems.push(`轨迹 tab 没有渲染出内容（${data.traceRows}）`);
  if (!(data.modelOptions >= 1)) problems.push(`模型选择面板没有选项（${data.modelOptions}）`);
  if (data.chipModelAfter === '' || data.chipModelAfter === '模型') skips.push('模型 chip 没有显示真值（可能没有可用模型）');
  if (data.attachmentSent !== true) problems.push('界面里带附件发送没有成功（会话没有新增轮次）');
  if (!(data.capWarns >= 1)) problems.push(`模型面板没有标出「不支持图片」的模型（capWarns=${data.capWarns}）`);
  if (data.capsGuard) {
    const g = data.capsGuard;
    if (!(g.send && g.send.ok === false && g.send.reason === 'model-no-image')) {
      problems.push(`选了不支持图片的模型后，带图发送没有被提前拦住（${JSON.stringify(g.send)}）`);
    }
    if (g.after !== g.before) problems.push(`不支持图片时消息仍然发出去了（turns ${g.before}→${g.after}）`);
    if (data.capsGuardSheetShown !== true) problems.push('被拦住后没有自动打开模型面板');
  }
  if (data.imageModelHintShown !== true) problems.push('「模型不支持图片」时没有自动弹出模型面板');
  if (!/不支持图片/.test(String(data.imageModelHintToast || ''))) problems.push(`「模型不支持图片」的提示文案不对（${String(data.imageModelHintToast)}）`);
  if (data.stopIdleAria !== '发送') problems.push(`空闲时发送按钮 aria-label 应为「发送」，实际 ${data.stopIdleAria}`);
  if (data.runningDetected !== true) problems.push('运行中的会话没有检测到 running 状态（停止按钮出不来）');
  if (data.runningDetected === true) {
    if (data.stopClass !== true) problems.push('运行中发送按钮没有切到 stop 样式');
    if (data.stopAria !== '停止') problems.push(`运行中按钮 aria-label 应为「停止」，实际 ${data.stopAria}`);
    if (data.stopHasRect !== true) problems.push('运行中按钮里没有方块图标（rect）');
    if (data.stopCleared !== true) problems.push('点停止后这一轮没有在 20s 内结束');
    if (data.queueDetected !== true) problems.push('运行中发第二条消息没有进入「排队中」（queueCount 一直为 0）');
  }
  if (data.queueDetected === true) {
    if (data.queueDockVisible !== true) problems.push('排队 dock 没有显示');
    if (data.queueActionButtons < 3) problems.push(`排队消息的操作按钮不足 3 个（${data.queueActionButtons}）`);
    if (data.queueEditOpened !== true) problems.push('点「编辑」没有出现编辑框');
    if (!/已编辑/.test(String(data.queueEditedTexts))) problems.push(`编辑排队消息没有生效（${data.queueEditedTexts}）`);
    if (data.queueRemoved !== true) problems.push('点「删除」没有移除排队消息');
  }
  if (data.mineVisible !== true) problems.push('「我的」页没有显示');
  if (data.mineHasBackButton !== false) problems.push('「我的」页不该再有孤零零的返回按钮（底部 tab 已能回会话）');
  try {
    const rows = JSON.parse(String(data.mineRowChevrons || '[]'));
    const byName = {};
    rows.forEach((r) => { if (r && r.t) byName[String(r.t)] = r.chev; });
    ['服务器', '意见反馈', '外观', '清空界面缓存'].forEach((k) => {
      if (byName[k] === true) problems.push(`「${k}」不该有 › 箭头（它不是跳转下一步）`);
    });
    ['模型', '强度', '官网', '版本'].forEach((k) => {
      if (byName[k] !== true) problems.push(`「${k}」应该有 › 箭头（它会打开面板/跳转）`);
    });
  } catch (e) {
    problems.push('我的页箭头信息解析失败');
  }
  if (data.mineModelSheet !== true) problems.push('「我的 → 模型」点了没有打开模型面板');
  if (data.mineEffortSheet !== true) problems.push('「我的 → 强度」点了没有打开强度面板');
  if (!(data.mineRows >= 6)) problems.push(`「我的」页行数太少（${data.mineRows}）`);
  if (!/已连接/.test(String(data.serverText))) problems.push(`「我的」页服务器状态不对（${data.serverText}）`);
  if (data.whatsnewSheet !== true) problems.push('点「版本」没有打开本版更新面板');
  if (!(data.whatsnewItems >= 1)) problems.push(`本版更新内容为空（${data.whatsnewItems} 条）`);
  if (!String(data.whatsnewTitle)) problems.push('本版更新面板没有标题');

  if (data.plusSheetVisible !== true) problems.push('点「+」没有打开指令菜单');
  if (!(data.commandRows >= 5)) problems.push(`加号菜单里指令太少（${data.commandRows} 条）`);
  if (data.hasFileRow !== true) problems.push('加号菜单里没有「文件」入口');
  if (data.permissionSheetVisible !== true) problems.push('权限预设有没打开');
  if (!(data.permissionOptions >= 3)) problems.push(`权限预设太少（${data.permissionOptions}；至少 仅可查看/工作区内修改/完全权限）`);
  if (!/完全权限/.test(String(data.permissionLabels))) problems.push('权限预设缺少「完全权限」');
  if (!/model/.test(String(data.commandNames))) problems.push(`加号菜单缺少「模型」入口（${String(data.commandNames)}）`);
  if (!/仅可查看/.test(String(data.permissionLabels))) problems.push(`权限预设缺少中文「仅可查看」（${String(data.permissionLabels).slice(0, 120)}）`);
  if (data.permissionAfterReadOnly !== 'read-only') problems.push(`切到「仅可查看」没生效（permission=${data.permissionAfterReadOnly}）`);
  if (data.permissionRestored !== 'danger-full-access') problems.push(`权限没有恢复成完全权限（permission=${data.permissionRestored}）`);
  if (data.compactToast === '') problems.push('执行 /compact 没有任何反馈');
  if (data.afterCommandJsError) problems.push(`执行指令后出现 JS 错误：${String(data.afterCommandJsError).slice(0, 200)}`);
  if (data.chipCount !== 4) problems.push(`composer 的 chip 数量应为 4（附件/模型/强度/权限），实际 ${data.chipCount}`);
  if (data.hasWsChip) problems.push('composer 里还有"工作区"chip（真机反馈与模型 chip 混淆，已要求删掉）');
  if (!/rgb\(11, 16, 24\)|rgba\(11, 16, 24/.test(String(data.darkBodyBg))) problems.push(`深色主题下 body 不是深色：${data.darkBodyBg}`);
  if (!/rgb\(244, 249, 255\)|rgb\(255, 255, 255\)/.test(String(data.darkSendStroke))) problems.push(`发送箭头描边不是白色（stroke=${data.darkSendStroke}）`);
  if (!/M12 19\.5V5/.test(String(data.darkSendPath))) problems.push(`发送图标不是桌面端同款向上箭头（d=${String(data.darkSendPath).slice(0, 40)}）`);
  if (String(data.lightViewerBg).indexOf('234, 241, 251') < 0) problems.push(`浅色主题下大图查看器遮罩不是浅色：${data.lightViewerBg}`);
  if (data.jsError) problems.push(`页面出现 JS 错误：${String(data.jsError).slice(0, 300)}`);
  if (data.approvalShown) {
    if (!(data.approvalAnswered === true)) problems.push('审批卡出现了但点「允许一次」没有生效');
  } else {
    skips.push(`审批卡没出现：${data.approvalNote || '模型没有发起需要审批的调用（非插件失败）'}`);
  }
  writeFileSync(join(OUT, 'result.json'), JSON.stringify({ data, problems, skips }, null, 2));
  console.log('\nFEATURES_RESULT ' + JSON.stringify({ data, problems, skips }));
  if (problems.length) {
    console.error(`\n❌ 手机端界面断言失败 ${problems.length} 项`);
    process.exit(1);
  }
  console.log(`\n✅ 手机端界面断言全部通过${skips.length ? `（${skips.length} 项跳过，见上）` : ''}·截图 ${SHOTS}/`);
  process.exit(0);
}

main().catch((e) => {
  console.error('断言脚本出错:', e);
  process.exit(1);
});
