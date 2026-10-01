import * as fs from 'fs';
import * as path from 'path';

/**
 * 自有 profile —— 壳让 DSH 启动的 profile 名。
 *
 * ── 为什么要把 `web` 换掉（2026-10-01）──────────────────────────────────
 * `web` 是 DSH **自带**的 profile（`dsh-app-boot` 的 `PROFILE_TEMPLATES` 只有
 * `acp / web / headless / sdk / sdk-minimal`）。往自带 profile 里写东西 = 改人家的目录：
 * DSH 会在设置导入、版本升级时 reconcile 重写 profile 层 —— 2026-09-27 实测到的
 * 「部署后设置导入把我们注入的三行整段覆盖掉」就是它。现在靠「首启之后再补一次注入」
 * 绕过去，能跑，但根上是被动的。
 *
 * ── 出路：DSH 官方的"从自带模板派生自定义 profile"────────────────────
 *     dsh --profile deepwhale --from-default-profile web
 * 派生出的 `$DSH_HOME/profiles/deepwhale/` 归我们所有，DSH 不再当成自带 profile 去重写。
 *
 * ⚠️ 两个硬约束（都来自 DSH 源码，不是推测）────────────────────────────
 *  1. **不能叫 `desktop`**：这个名字被官方 Electron 宿主保留，CLI 启动会被
 *     `rejectElectronProfile()` 挡掉
 *     （`error: profile "desktop" is managed exclusively by the Electron application`，
 *      见 `dsh/lib/bin.js:35`）。
 *  2. **`--from-default-profile` 只能首启传一次**：profile 目录已存在时它会**直接抛错**
 *     （`profile "x" already exists at …; omit --from-default-profile to use it`，
 *      见 `dsh/lib/profile-boot-*.js` 的 `initializeProfileFromDefault`）。
 *     所以用下面的 `profileNeedsInit()` 判断，只有缺 `package.json` 时才带上它。
 */

/** 壳使用的自有 profile 名。改这里一处即可，注入与启动都引它。 */
export const PROFILE_NAME = 'deepwhale';

/** 派生自定义 profile 时使用的自带模板。 */
export const PROFILE_TEMPLATE = 'web';

/**
 * DSH 自带 profile 名。
 * 用途：兜底命令字符串里若出现这些名字，说明那个位置是"选 profile"的位置，
 * 需要被替换成我们的自有 profile（否则会静默启动到 `web`，插件注入全部落空）。
 */
export const SHIPPED_PROFILE_NAMES = ['acp', 'web', 'headless', 'sdk', 'sdk-minimal'];

/** 自有 profile 的目录：`$DSH_HOME/profiles/<PROFILE_NAME>`。 */
export function profileDirOf(home: string): string {
  return path.join(home, 'profiles', PROFILE_NAME);
}

/**
 * 这个 profile 是否还需要先初始化（= DSH 还没建过它）。
 *
 * 判据用 `package.json`：`initProfile()` 会写它，而我们的注入只在它存在之后才补写
 * （见各注入模块里的 `profilePending`）—— 所以它的存在与否正好就是"DSH 建过没有"。
 *
 * 读不了时返回 false（= 当作已存在）：宁可少加一个参数，也不要因为判断本身出错
 * 而给 DSH 加一个会抛错的 `--from-default-profile`。
 */
export function profileNeedsInit(home: string | undefined): boolean {
  if (!home) return false;
  try {
    return !fs.existsSync(path.join(profileDirOf(home), 'package.json'));
  } catch {
    return false;
  }
}

/**
 * 启动 DSH 时要带的 profile 参数。首启时多一个 `--from-default-profile`。
 * @param home - DSH home（即 DSH_HOME）。拿不到时不带初始化参数。
 */
export function profileLaunchArgs(home: string | undefined): string[] {
  const args = ['--profile', PROFILE_NAME];
  if (profileNeedsInit(home)) args.push('--from-default-profile', PROFILE_TEMPLATE);
  return args;
}

/**
 * 把一段「兜底命令」的参数改成选择自有 profile。
 *
 * 为什么需要：`settings.command` 是用户可覆盖的兜底启动命令，默认串里带着一个裸的
 * `web`。若原样执行，DSH 会启动到自带 `web` profile，而我们的注入全写在
 * `profiles/deepwhale/` —— **插件会静默失效**。所以这里把那个裸 profile 名换成
 * `--profile <我们的>`（首启再补 `--from-default-profile`）。
 *
 * 找不到裸 profile 名时原样返回，由调用方决定是否告警。
 *
 * @returns `{ args, ok }`。`ok=false` 表示**没能保证**它选的是我们的 profile
 *          （例如用户显式指定了别的 profile，或命令里根本没有 profile 位置）——
 *          调用方应当告警，因为那种情况下插件注入会静默失效。
 */
export function applyProfileToCommandArgs(
  args: string[],
  home: string | undefined,
): { args: string[]; ok: boolean } {
  const copy = [...args];
  const init = profileNeedsInit(home) ? ['--from-default-profile', PROFILE_TEMPLATE] : [];

  // 情况一：命令里已经写了 `--profile <名字>`
  const flagAt = copy.findIndex((a) => a === '--profile');
  if (flagAt !== -1) {
    // 用户显式选了别的 profile —— 尊重他，但要如实告诉调用方"我们没能保证"
    if (copy[flagAt + 1] !== PROFILE_NAME) return { args: copy, ok: false };
    if (init.length > 0 && !copy.includes('--from-default-profile')) {
      copy.splice(flagAt + 2, 0, ...init);
    }
    return { args: copy, ok: true };
  }

  // 情况二：命令里写的是自带 profile 的裸名字（默认串就是 `… dsh@x web --port …`）
  const positionalAt = copy.findIndex(
    (a) => !a.startsWith('-') && SHIPPED_PROFILE_NAMES.includes(a),
  );
  if (positionalAt === -1) return { args: copy, ok: false };

  copy.splice(positionalAt, 1);
  copy.unshift('--profile', PROFILE_NAME, ...init);
  return { args: copy, ok: true };
}
