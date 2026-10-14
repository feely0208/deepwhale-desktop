#!/usr/bin/env node
/**
 * 离线守卫：客户端插件 bundle 必须真的**返回插件对象**（2026-10-15 事故）
 *
 * 事故：1.0.56 发出去后，用户打开界面是整页
 *      `Failed to load plugins` / `invalid plugin, expect function or object with an
 *       "apply" method, received undefined` —— 深鲸桌面等于打不开。
 * 根因：`dsh-shell-web-preview/lib/client.js` 的 `factory` **会在缺少 Electron 桥时提前
 *      `return;`**（裸 return = 返回 undefined）。cordis 拿到 undefined 就判定"不是插件"，
 *      而这是**整页致命**的：一个坏 bundle 让所有插件加载失败。
 *      （浏览器里打开 3095 时没有 `window.dsh` 桥 → 必中；Electron 窗口里有桥 → 平时看不出来。
 *        所以本机的打包态冒烟是绿的，问题只在真实浏览器/无桥宿主上暴露。）
 *
 * 判据（静态，零依赖，可离线跑）：
 *   ① 文件能解析（node --check 级别），且是 `window.__ModuleLoader__.load({...})` 形态
 *   ② 有 `factory:`，且**在 factory 之后、文件结尾附近**出现 `return module.exports`
 *      （或 `return apply` 这种直接返回插件函数的写法）
 *   ③ 导出里有 `apply`（cordis 要的就是它）
 *
 * 用法：node scripts/check-client-bundles.js [根目录…]
 *   默认扫 `shell-plugins` 与构建产物 `bundled-plugins`（存在才扫）。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const roots = process.argv.slice(2).filter((a) => !a.startsWith('-'));
if (roots.length === 0) {
  roots.push('shell-plugins');
  roots.push('bundled-plugins');
}

/** 收集 <root>/<pkg>/lib/client.js */
function collect(root) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules') continue;
        if (e.name === 'lib' && fs.existsSync(path.join(full, 'client.js'))) {
          out.push(path.join(full, 'client.js'));
        }
        walk(full);
      }
    }
  };
  if (fs.existsSync(root)) walk(root);
  return out;
}

const problems = [];
let checked = 0;

for (const root of roots) {
  for (const file of collect(root)) {
    checked += 1;
    const rel = path.relative(process.cwd(), file);
    let src = '';
    try {
      src = fs.readFileSync(file, 'utf-8');
    } catch (e) {
      problems.push(`${rel}：读不了（${e.message}）`);
      continue;
    }

    // ① 能解析 + 是客户端模块 bundle
    try {
      new vm.Script(src, { filename: file });
    } catch (e) {
      problems.push(`${rel}：语法错误 —— ${e.message}`);
      continue;
    }
    if (!src.includes('__ModuleLoader__.load')) {
      problems.push(`${rel}：不是客户层 bundle（找不到 window.__ModuleLoader__.load）`);
      continue;
    }

    // ② factory 必须返回插件对象
    const factoryAt = src.indexOf('factory:');
    if (factoryAt < 0) {
      problems.push(`${rel}：没有 factory —— 客户层 bundle 必须提供 factory`);
      continue;
    }
    const tail = src.slice(factoryAt);
    const returnsPlugin = /return\s+module\.exports\s*;/.test(tail) || /return\s+apply\s*;/.test(tail);
    if (!returnsPlugin) {
      problems.push(
        `${rel}：factory **没有返回插件对象**（缺 \`return module.exports;\`）\n` +
          '      → cordis 会拿到 undefined，报 `invalid plugin, expect function or object with an "apply" method`，\n' +
          '        而这是整页致命：一个坏 bundle 让**所有**插件加载失败（2026-10-15 事故）。',
      );
      continue;
    }

    // ③ 必须导出 apply
    if (!/exports\.apply\s*=/.test(src) && !/^function apply/m.test(src)) {
      problems.push(`${rel}：没有导出 apply（cordis 需要它）`);
    }
  }
}

if (checked === 0) {
  console.error(`❌ 在 ${roots.join(' / ')} 下一个 client.js 都没找到 —— 路径写错了吗？`);
  process.exit(1);
}

if (problems.length) {
  console.error('❌ 客户端插件 bundle 守卫失败：\n');
  problems.forEach((p, i) => console.error(`  ${i + 1}. ${p}\n`));
  process.exitCode = 1;
} else {
  console.log(`✅ 客户端插件 bundle 守卫通过（${checked} 个 bundle 都能返回插件对象并导出 apply）`);
}
