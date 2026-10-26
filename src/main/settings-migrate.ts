import { DSH_RUNTIME_VERSION } from './dsh-version.generated';

/**
 * 版本比较：a 是否比 b 更老（支持 `0.2.1-rc.2` 这种预发布后缀，按数字段比）。
 * 只用于「兜底命令里的 DSH 版本」，不追求完整 semver。
 */
function 版本更老(a: string, b: string): boolean {
  const 取 = (v: string) => v.split('-')[0].split('.').map((x) => Number.parseInt(x, 10) || 0);
  const [x, y] = [取(a), 取(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const [m, n] = [x[i] ?? 0, y[i] ?? 0];
    if (m !== n) return m < n;
  }
  return false;
}

/**
 * 把「我们的默认形态」兜底命令里的旧 DSH 版本换成随包版本。
 *
 * 只处理 `npx @deepseek-ai/dsh@x.y.z` 或 `…@x.y.z …` 这种写法，而且只在**更老**时替换：
 *   · 用户自定义的可执行文件（绝对路径、别的包）一律不动；
 *   · 比随包版本新的（用户故意提前试）也不动。
 */
export function migrateStaleDshCommand(command: string): string {
  const m = command.match(/(@deepseek-ai\/dsh@)([^\s"']+)/);
  if (!m) return command;
  const 现有 = m[2];
  if (现有 === DSH_RUNTIME_VERSION || !版本更老(现有, DSH_RUNTIME_VERSION)) return command;
  console.warn(
    `[settings] 兜底命令里的 DSH 版本过旧（${现有} → ${DSH_RUNTIME_VERSION}）：` +
      '这条命令只在随包运行时不可用时才会用到，但仍会让人跑到没有新功能的旧内核，已自动升级。',
  );
  return command.replace(m[0], `${m[1]}${DSH_RUNTIME_VERSION}`);
}
