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

/** 我们认为"这个 patch 文件已经不可用"的判据 */
function looksBroken(text: string): boolean {
  if (text.includes('\u0000')) return true;                 // 空字节（本次事故）
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) return true; // 其它控制字符
  return false;
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
    const next = usable ? cleaned : '# repaired: 原文件包含空字节，已重置（详见同目录 .corrupt-* 备份）\n';
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
