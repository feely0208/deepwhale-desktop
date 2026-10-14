/**
 * profile patch 文件的自愈与原子写入（2026-10-04）
 *
 * 事故（Windows 用户实测，日志铁证）：
 *   `dsh: failed to parse overlay …\profiles\deepwhale\cordis.patch.yml:
 *    YAMLException: null byte is not allowed in input (1:1)`
 *   → DSH 服务起不来 → 界面报「深鲸桌面无法连接到 DSH 服务」。
 *
 * 为什么会坏：这些 patch 文件是**壳在启动时重写**的（法律模式 / office 两组 insert 行）。
 * 而 Windows 的自动更新会**中途结束进程**，写入只完成一半就会留下空字节（NTFS 上尤其明显）。
 *
 * 两层修法（都在本文件）：
 *   ① `writeFileAtomic()` —— 先写临时文件再 rename，从此不会出现"写了一半"；
 *   ② `healPatchFiles()` —— 启动时扫一遍，已经坏掉的（含空字节 / 解析不出）直接修好，
 *      用户不需要手动删文件（让用户去删配置，等于让普通用户放弃这个软件）。
 */
import * as fs from 'fs';
import * as path from 'path';

/** 原子写入：同目录写临时文件 → rename 覆盖（rename 在同一分区上是原子的） */
export function writeFileAtomic(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, content, 'utf-8');
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    // rename 失败（极少数情况：目标被占用）→ 退化成直接写，别把功能卡死
    try {
      fs.writeFileSync(file, content, 'utf-8');
    } finally {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* 清不掉就算了 */
      }
    }
    throw e;
  }
}

/**
 * 这个 patch 文本能不能被 YAML 解析？—— 判"写坏了"的第二种依据（2026-10-14 加）。
 *
 * 为什么需要：原来只认空字节/控制字符。但**写坏不只有空字节这一种**：
 * 自动更新中途杀进程、盘满、杀软拦截，都可能留下**截断的半截 ASCII 文件** ——
 * 那种文件没有空字节，却让 DSH 解析失败、应用同样起不来。判据必须在"对方那边"：
 * 真的拿解析器读一遍。
 *
 * ⚠️ 判据只取"解析**抛错**"这一条，**不看解析结果是不是数组**：
 *    万一某个 DSH 版本的 patch 允许非数组形态，我们也不能把好文件重置掉。
 *    （解析得出来 = 不碰；解析不出来 = 备份并重置。）
 * js-yaml 是可选依赖：读不到就退回"只看控制字符"，绝不让自愈本身成为启动失败的原因。
 */
function yamlParseFails(text: string): boolean {
  // 全是注释/空白的文件不用解析 —— DSH 自己就是这么当"空 patch"处理的
  const withoutComments = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'))
    .join('\n');
  if (withoutComments === '') return false;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const yaml = require('js-yaml') as { load?: (s: string) => unknown };
    if (typeof yaml.load !== 'function') return false;
    yaml.load(text);
    return false;
  } catch (e) {
    // 解析器不在（打包裁剪等）→ 不当成坏
    if (e instanceof Error && /Cannot find module/.test(e.message)) return false;
    return true;
  }
}

/** 我们认为"这个 patch 文件已经不可用"的判据 */
function looksBroken(text: string): boolean {
  if (text.includes('\u0000')) return true;                 // 空字节（2026-10-04 那类事故）
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) return true; // 其它控制字符
  return yamlParseFails(text);                              // 截断/半截的文本（2026-10-14 加）
}

export interface PatchHealResult {
  /** 检查过的文件数 */
  checked: number;
  /** 被修好的文件绝对路径 */
  healed: string[];
}

/**
 * 扫描 `<home>/cordis.patch.yml` 与 `<home>/profiles/<profile>/cordis.patch.yml`。
 * 坏掉的按"能救就救、救不回来就重置成只剩注释的最小合法文件"处理：
 *   · 只有空字节 → 去掉空字节后如果还是合法文本，就用去掉空字节的内容
 *   · 去完为空 / 还有别的控制字符 → 重置为一行注释（DSH 能正常解析）
 * 同时把修好的内容**原子写回**，并留下 `.corrupt-<时间戳>` 备份，方便回溯。
 */
export function healPatchFiles(home: string): PatchHealResult {
  const targets: string[] = [];
  targets.push(path.join(home, 'cordis.patch.yml'));
  const profilesDir = path.join(home, 'profiles');
  try {
    for (const name of fs.readdirSync(profilesDir)) {
      const p = path.join(profilesDir, name, 'cordis.patch.yml');
      if (fs.existsSync(p)) targets.push(p);
    }
  } catch {
    /* profiles 目录还没有：正常，首次启动就是这样 */
  }

  const result: PatchHealResult = { checked: 0, healed: [] };
  for (const file of targets) {
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf-8');
    } catch {
      continue; // 读不到就跳过（不存在是常态）
    }
    result.checked += 1;
    if (!looksBroken(text)) continue;

    const cleaned = text.replace(/\u0000/g, '');
    const usable = cleaned.trim().length > 0 && !looksBroken(cleaned);
    const next = usable ? cleaned : '# repaired: 原文件不可解析（空字节/截断/非法 YAML），已重置（详见同目录 .corrupt-* 备份）\n';
    try {
      fs.writeFileSync(`${file}.corrupt-${Date.now()}`, text, 'utf-8'); // 留证据
      writeFileAtomic(file, next);
      result.healed.push(file);
      console.warn('[patch-heal] 已修复损坏的 patch 文件:', file);
    } catch (e) {
      console.error('[patch-heal] 修复失败:', file, e);
    }
  }
  return result;
}
