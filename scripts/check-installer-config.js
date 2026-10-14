#!/usr/bin/env node
/**
 * 安装器配置守卫（2026-10-04 建，2026-10-14 改判据）
 *
 * 它拦的是**同一类事故**：Windows 自动更新把用户的安装搞没。
 *   · 2026-10-04 的形状：只开"向导可选目录"、不管更新目标 → 更新装到别的目录 +
 *     旧安装被挪进 %TEMP%\old-install → 清一次临时目录，应用就"消失"。
 *   · 当时的处置是退回 oneClick:true + 固定目录，代价是用户不能选目录（默认落
 *     %LOCALAPPDATA%，没人找得到，还占系统盘）。
 *   · 2026-10-14 用户要求把这个能力要回来 → 判据从"不许开"改成**"必须成对"**：
 *     开了 allowToChangeInstallationDirectory，就必须能在 update-manager 里找到
 *     win32 的 installDirectory 钉死；只开一半 = 直接红。
 * 靠人记，靠不住 —— 所以这套关系必须在发布 CI 里可执行（npm run check:installer）。
 */
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const file = path.join(__dirname, '..', 'electron-builder.yml');
const conf = yaml.load(fs.readFileSync(file, 'utf-8'));

/**
 * ⚠️ electron-builder 的配置优先级陷阱（2026-10-10 事故）：
 *   app-builder-lib 的 `loadConfig()` 只要 package.json 有顶层 `"build"` 字段，就**只读它**、
 *   完全不看 electron-builder.yml —— 本文件上面检查的那些冻结项会被整体架空，
 *   连 files 白名单 / extraResources / asar:false / appId 也一起丢。
 *   实测后果：`9c049c9`（「Windows 安装可自选目录」）加的 `build.nsis` 让打包静默退化成
 *   默认配置 —— 产物里没有随包 DSH 运行时 / office 运行时 / 随包插件，
 *   而**所有本地命令、离线守卫、安装器守卫全绿**，直到 CI 里跑打包态冒烟才暴露。
 *   所以这里必须把它也拦成 CI 里的红。
 */
const pkgPath = path.join(__dirname, '..', 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));

const problems = [];

if (pkg.build != null) {
  problems.push(
    'package.json 里出现了顶层 "build" 字段\n' +
      '  → electron-builder 只要看到它就会**完全忽略 electron-builder.yml**' +
      '（files / extraResources / asar / appId / mac 全部丢失），打包会静默退化成默认配置。\n' +
      '  → 打包配置请只写在 electron-builder.yml；package.json 里不能有 "build"。',
  );
}

/** appId 一旦定下就不能再改：NSIS 用它拼注册表键记安装目录，改了 = 丢掉老用户的安装目录记忆 */
const FROZEN_APP_ID = 'com.deepwhale.desktop';

if (conf.appId !== FROZEN_APP_ID) {
  problems.push(
    `appId 被改动：当前 ${conf.appId}，冻结值 ${FROZEN_APP_ID}\n` +
      '  → NSIS 用 appId 拼注册表键记录安装目录，改动会让老用户丢失安装位置、更新后目录漂移',
  );
}

const nsis = conf.nsis || {};

/**
 * ── 2026-10-14：Windows 恢复「可自选安装目录」后的新不变量 ──
 *
 * 背景：2026-10-04 的事故是 `oneClick:false + allowToChangeInstallationDirectory:true`
 * 单独出现 —— 能用**向导**装到任意目录，但**自动更新**仍走安装器默认目录 → 路径漂移、
 * 旧安装被挪进 %TEMP%\old-install、清一次临时目录应用就"消失"。
 *
 * 现在允许开目录选择，是因为**更新的目标被钉死了**：
 *   src/main/update-manager.ts 的 win32 分支设置 `installDirectory = dirname(exe)`，
 *   NsisUpdater 会把它变成安装器的 `/D=<目录>`（electron-builder 的 NSIS 模板手动解析该参数），
 *   更新于是永远装回"当前正在跑的目录"。
 *
 * 🔒 所以这里检查的是**成对关系**，不是单个值：
 *    「可自选目录」开了 → 就必须能在 update-manager 里找到那个安装目录的钉死；
 *    只开一半，或者只钉一半，都直接红（这正是 10-04 事故的形状）。
 */
if (nsis.oneClick !== false) {
  problems.push(
    `nsis.oneClick = ${nsis.oneClick}（应为 false）\n` +
      '  → 用户必须能看见并选择安装目录（默认落在 %LOCALAPPDATA% 里，没人找得到、还占系统盘）',
  );
}
if (nsis.allowToChangeInstallationDirectory !== true) {
  problems.push(
    `nsis.allowToChangeInstallationDirectory = ${nsis.allowToChangeInstallationDirectory}（应为 true）\n` +
      '  → 关掉它用户就只能装到默认目录（C 盘 AppData），这是用户明确要求修掉的问题',
  );
}
if (nsis.allowElevation !== true) {
  problems.push(
    `nsis.allowElevation = ${nsis.allowElevation}（应为 true）\n` +
      '  → 用户选到 Program Files 这类需要提权的目录时会失败（perMachine:false 下必须允许按需提权）',
  );
}
if (nsis.perMachine === true) {
  problems.push('nsis.perMachine = true → 每机器安装会引入权限/路径分支，Windows 自动更新场景下请保持 false');
}
if (nsis.deleteAppDataOnUninstall === true) {
  problems.push('nsis.deleteAppDataOnUninstall = true → 卸载会删用户数据（会话/密钥），必须为 false');
}

// ── 另一半：自动更新必须把安装目标钉在"当前正在运行的目录" ──
// 静态检查（读源码文本），不是运行时验证：能在 CI 里拦住"只改了 yml 没改代码"。
{
  const updaterPath = path.join(__dirname, '..', 'src', 'main', 'update-manager.ts');
  let updaterSrc = '';
  try {
    updaterSrc = fs.readFileSync(updaterPath, 'utf-8');
  } catch {
    problems.push(`读不到 ${updaterPath} —— 无法校验"更新安装目标已钉死"，守卫不能靠猜`);
  }
  if (updaterSrc !== '') {
    const pinsWinDir = /process\.platform\s*===\s*'win32'/.test(updaterSrc) &&
      /installDirectory\s*=/.test(updaterSrc);
    if (!pinsWinDir) {
      problems.push(
        'src/main/update-manager.ts 里找不到 win32 分支的 `installDirectory = …`\n' +
          '  → 光允许用户自选目录、不钉死更新目标 = 2026-10-04 那次「更新完应用不见了」的原形。\n' +
          '  → 请在 UpdateManager.start() 里设：win32 时 installDirectory = dirname(app.getPath(\'exe\'))',
      );
    }
  }
}

if (problems.length) {
  console.error('❌ 安装器配置不合规：\n');
  problems.forEach((p, i) => console.error(`  ${i + 1}. ${p}\n`));
  process.exitCode = 1;
} else {
  console.log(
    '✅ 安装器配置合规：appId 未变 · 向导可选目录(oneClick=false + allowToChangeInstallationDirectory=true)' +
      ' · 更新目标已钉死(installDirectory) · 不删用户数据',
  );
}
