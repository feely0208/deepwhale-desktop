#!/usr/bin/env node
/**
 * 离线守卫：写好并验过的壳插件，**必须真的进包**（2026-10-14）
 *
 * 为什么要有这一道 —— 真实发生过两次同形状的事故：
 *   · 视频预览插件（`shell-plugins/dsh-shell-video-preview`）：2026-10-10 修完 7 处硬伤、
 *     在隔离实例里验过、证据也存了，**但没写进随包清单、也没写进构建脚本的拷贝段**
 *     → 用户装到的包里根本没有它，等于没发（用户点 mp4 依旧是「该格式文件暂时无法预览」）。
 *   · 品牌标记插件曾"消失两个多月没人发现"，同样是"源码在、没人声明"。
 * 这两次的共同点：**本机能用、用户没有**。靠人记靠不住，所以把它变成 CI 里会红的断言。
 *
 * 判据（两条，都很朴素）：
 *   ① `shell-plugins/` 下每个带 cordis.patch.yml 的插件目录，都必须在
 *      `src/main/bundled-plugins.ts` 里**被提到**（正式声明，或至少有一句说明为什么不随包）。
 *      —— 完全没人提 = 被遗忘，红。
 *   ② 凡是在清单里**正式声明**了的（`{ name: '…', dir: '…' }`），
 *      `scripts/build-bundled-plugins.js` 里必须有对应的拷贝步骤（本地源码或 npm 包）。
 *      —— 声明了却没人拷进载荷，`ensureBundledPlugins()` 会**静默跳过**，用户那边功能凭空消失。
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const shellDir = path.join(root, 'shell-plugins');
const listFile = path.join(root, 'src', 'main', 'bundled-plugins.ts');
const buildFile = path.join(root, 'scripts', 'build-bundled-plugins.js');

/**
 * 精确匹配（不能用 `includes` 做子串判断 —— `dsh-shell-video-preview` 是
 * `dsh-shell-video-preview-XX` 的子串，子串判断会把"被改名/被遗忘"判成通过）。
 * 一个插件"有归宿"的两种合法写法：
 *   · 正式声明：`dir: 'dsh-shell-video-preview'`
 *   · 明确说明不随包：正文里引用它的源码路径 `shell-plugins/dsh-shell-video-preview`
 */
function hasHome(src, dir) {
  const declared = new RegExp(`dir:\\s*['"]${dir}['"]`).test(src);
  const discussed = src.includes(`shell-plugins/${dir}`);
  return { declared, discussed, ok: declared || discussed };
}

const problems = [];

const listSrc = fs.readFileSync(listFile, 'utf-8');
const buildSrc = fs.readFileSync(buildFile, 'utf-8');

let dirs = [];
try {
  dirs = fs
    .readdirSync(shellDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((name) => fs.existsSync(path.join(shellDir, name, 'cordis.patch.yml')));
} catch (e) {
  console.error(`❌ 读不到 ${shellDir}: ${e.message}`);
  process.exit(1);
}

for (const dir of dirs) {
  // ① 必须有归宿（正式声明，或一句"为什么不随包"的说明）
  const home = hasHome(listSrc, dir);
  if (!home.ok) {
    problems.push(
      `shell-plugins/${dir} 在 src/main/bundled-plugins.ts 里**没有任何归宿**\n` +
        '  → 这就是 2026-10-10 视频预览插件的形状：插件写好了、也验过了，但没人声明 → 用户装到的包里没有它。\n' +
        '  → 要随包就加一条 `{ name: …, dir: … }`；不随包就写一句说明（引用 `shell-plugins/<dir>`）。',
    );
    continue;
  }
  // ② 正式声明了 → 构建脚本里必须有拷贝步骤（两处同进同出）
  if (home.declared && !new RegExp(`['"]${dir}['"]`).test(buildSrc)) {
    problems.push(
      `src/main/bundled-plugins.ts 声明了 ${dir}，但 scripts/build-bundled-plugins.js 里没有它的拷贝步骤\n` +
        '  → 声明了而载荷里没有，ensureBundledPlugins() 会**静默跳过**（不报错），用户那边功能凭空消失。\n' +
        '  → 规则是"两处必须同进同出"。',
    );
  }
}

if (problems.length) {
  console.error('❌ 壳插件随包清单守卫失败：\n');
  problems.forEach((p, i) => console.error(`  ${i + 1}. ${p}\n`));
  process.exitCode = 1;
} else {
  console.log(
    `✅ 壳插件随包清单守卫通过（${dirs.length} 个插件目录全部有归宿：声明与构建脚本一致）`,
  );
}
