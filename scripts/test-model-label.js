#!/usr/bin/env node
/**
 * 模型显示名注入回归测试（2026-10-20）
 *
 * 背景：DSH 0.2.1-rc.2 适配了 `DeepSeek-V4.1-Flash-1017`，但官方 catalog 的 name
 * 仍是 `DeepSeek-V4.1-Flash`；壳要在 home patch 里覆盖 `llm-deepseek.config.models`。
 *
 * 这个补丁是**整数组替换**，写错会让 DSH 起不来（与 1.0.58 的 host 0.0.0.0 同类）。
 * 所以这里只测三件能离线确认的事：
 *   ① 块写进 home 级 cordis.patch.yml 且 YAML 合法；
 *   ② 幂等（重复调用不重复写）；
 *   ③ 不破坏文件里已有的其它注入块（office / webserver 那些）。
 *
 * 真启动 + 显示名生效的验证见 docs/1.0.60-更新计划 里的隔离实例冒烟步骤。
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const yaml = require(path.join(REPO, 'node_modules/js-yaml'));
const { ensureModelLabelPatch, MODEL_LABEL_MARKER, MODEL_LABEL_BLOCK } = require(
  path.join(REPO, 'dist/main/patch-extras.js'),
);

let failed = 0;
const ok = (m) => console.log(`  ✅ ${m}`);
const bad = (m) => {
  failed += 1;
  console.log(`  ❌ ${m}`);
};

function tmpHome(tag) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-model-label-${tag}-`));
  return home;
}

function parsePatch(file) {
  return yaml.load(fs.readFileSync(file, 'utf8'));
}

function main() {
  console.log('\n  模型显示名注入');

  // ── 1) 空 home：写入成功、YAML 合法、字段正确 ──
  {
    const home = tmpHome('empty');
    const changed = ensureModelLabelPatch(home);
    const file = path.join(home, 'cordis.patch.yml');
    if (!changed) bad('空 home 首次调用应当返回 true');
    else ok('空 home 首次写入返回 true');
    if (!fs.existsSync(file)) {
      bad('cordis.patch.yml 没生成');
    } else {
      ok('cordis.patch.yml 已生成');
      let parsed;
      try {
        parsed = parsePatch(file);
        ok('YAML 解析通过');
      } catch (e) {
        bad(`YAML 解析失败：${String(e).slice(0, 120)}`);
      }
      if (parsed) {
        const entry = Array.isArray(parsed) ? parsed.find((e) => e && e.id === 'llm-deepseek') : null;
        if (entry) ok('补丁目标是 llm-deepseek');
        else bad('补丁里没有 llm-deepseek 条目');
        const models = entry && entry.config && entry.config.models;
        if (Array.isArray(models) && models.length === 2) ok('models 数组 2 条（flash + pro）');
        else bad(`models 数组异常：${JSON.stringify(models && models.length)}`);
        const flash = models && models.find((m) => m.id === 'deepseek-flash');
        if (flash && flash.name === 'DeepSeek-V4.1-Flash-1017') ok('显示名 = DeepSeek-V4.1-Flash-1017');
        else bad(`显示名不对：${flash && flash.name}`);
        if (flash && flash.contextWindow === 1000000) ok('contextWindow = 1000000');
        else bad(`contextWindow 不对：${flash && flash.contextWindow}`);
        const pro = models && models.find((m) => m.id === 'deepseek-v4-pro');
        if (pro && pro.name === 'DeepSeek-V4-Pro') ok('pro 条目保留（没有被数组替换吞掉）');
        else bad('pro 条目丢失或被改坏');
      }
    }
  }

  // ── 2) 幂等 ──
  {
    const home = tmpHome('idempotent');
    ensureModelLabelPatch(home);
    const file = path.join(home, 'cordis.patch.yml');
    const first = fs.readFileSync(file, 'utf8');
    const again = ensureModelLabelPatch(home);
    const second = fs.readFileSync(file, 'utf8');
    if (again === false) ok('第二次调用返回 false（不重复写）');
    else bad('第二次调用又写了盘');
    if (first === second) ok('文件内容未变');
    else bad('文件内容被重复追加');
    const count = second.split(MODEL_LABEL_MARKER).length - 1;
    if (count === 1) ok('标记只出现 1 次');
    else bad(`标记出现 ${count} 次（重复追加）`);
  }

  // ── 3) 不破坏已有的其它注入块 ──
  {
    const home = tmpHome('merge');
    const file = path.join(home, 'cordis.patch.yml');
    const existing = [
      '# ── 手机连接：让局域网里的手机能连上桌面端 ──',
      '- insert:',
      '    - id: webserver',
      "      name: '@deepseek-ai/dsh-host-webserver'",
      '      config:',
      '        port: 3095',
      '        host: 127.0.0.1',
      '        trustedHosts:',
      '          - 192.168.1.5:3095',
      '',
    ].join('\n');
    fs.writeFileSync(file, existing);
    const changed = ensureModelLabelPatch(home);
    if (changed) ok('已有块时仍能追加');
    else bad('已有块时没追加');
    let parsed;
    try {
      parsed = parsePatch(file);
      ok('追加后 YAML 仍然合法');
    } catch (e) {
      bad(`追加后 YAML 非法：${String(e).slice(0, 120)}`);
    }
    if (parsed) {
      const hasWs = parsed.some((e) => e && e.insert && JSON.stringify(e).includes('webserver'));
      const hasModel = parsed.some((e) => e && e.id === 'llm-deepseek');
      if (hasWs && hasModel) ok('webserver 块与模型块并存');
      else bad(`块丢失：webserver=${String(hasWs)} model=${String(hasModel)}`);
    }
    const text = fs.readFileSync(file, 'utf8');
    if (text.includes('trustedHosts:')) ok('原有 trustedHosts 配置保留');
    else bad('原有配置被覆盖');
  }

  // ── 4) 块内容与导出常量一致（防手改文件后忘记同步）──
  {
    const home = tmpHome('const');
    ensureModelLabelPatch(home);
    const text = fs.readFileSync(path.join(home, 'cordis.patch.yml'), 'utf8');
    if (text.startsWith(MODEL_LABEL_BLOCK.replace(/\s*$/, ''))) ok('写入内容 = 导出的 MODEL_LABEL_BLOCK');
    else bad('写入内容与 MODEL_LABEL_BLOCK 不一致');
  }

  console.log(failed === 0 ? '\n  ✅ 模型显示名注入测试全过\n' : `\n  ❌ 失败 ${failed} 项\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
