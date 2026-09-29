import * as fs from 'fs';
import * as path from 'path';

/**
 * 把 DSH 自带的「意见反馈」入口，指到**我们自己的**反馈页。
 *
 * ── 为什么必须做（2026-09-29 查出来的真问题）──────────────────────
 * 桌面端左上角账户菜单里那个「意见反馈」，是 DSH 运行时自带的
 * （`@deepseek-ai/dsh-client-ui-settings-account` 里硬编码着「意见反馈」四个字）。
 * 它的目标是 `config.contactFormUrl`，而**默认值指向 DeepSeek 官方的飞书表单**：
 *
 *   https://trtgsjkv6r.feishu.cn/share/base/form/shrcnlCoGElW7MQznGy9r3YYXcg
 *
 * 也就是说：我们的用户点「意见反馈」，写的内容**进了 DeepSeek 的表单，我们一条都收不到**。
 * 这不是"少个功能"，是**反馈渠道在漏**，而且从外面完全看不出来（点了也弹得出表单）。
 *
 * ── 怎么改 ────────────────────────────────────────────────────
 * 运行时的 contactUrl() 会自己往这个 URL 上拼这些参数（并加 hide_ 隐藏它们）：
 *   uid / source / harness_version / device_info / app_locale / screen_resolution
 * 所以页面那边只要把 query 里的值读出来、跟着表单一起 POST 回来就行 ——
 * 我们**不需要**自己采集系统信息，也没必要。
 *
 * 这里做的事：在**首页级** patch（`<home>/cordis.patch.yml`，层级高于 profile）里
 * 插一行同 id 的 `ui-settings-account`，只改 config。
 * 「同 id 覆盖」是官方自己的用法（官方 web profile 就是这么把
 * `tool-subagent-claude-code` 关掉的），实测有效：
 * `--dump-config` 后两层都还在，但服务端烘进页面的 `__DSH_CONTACT_CONFIG__`
 * 用的是**后一层**（也就是我们的）——已实测确认。
 *
 * 反馈页在官网：https://deepwhale.org.cn/feedback.html
 * 后端落盘 + 发信通知，全是我们自己的机器，不经第三方表单。
 */

/** 行 id —— 必须与运行时里那一行完全一致，靠它做覆盖。 */
const ROW_ID = 'ui-settings-account';
/** 插件包名（覆盖时必须重写 name，否则 loader 解析不到）。 */
const PLUGIN_NAME = '@deepseek-ai/dsh-client-ui-settings-account';
/** 我们的反馈页。 */
const FEEDBACK_BASE = 'https://deepwhale.org.cn/feedback.html';
/** 来源标记：后台据此区分"桌面端来的"和"官网直接打开的"。 */
const CONTACT_SOURCE = 'deepwhale-desktop';

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/**
 * 生成反馈页地址。
 *
 * 除了运行时那六项，我们再补一个 `shell_version` —— 运行时不知道壳的版本，
 * 而"用户装的是哪个壳"恰恰是我们最常要问的第一个问题。
 * （`prefill_machine`（机器码）留待后续：机器码当前由律师端渲染进程算，
 *   壳这边还没有同一套实现，先不塞一个可能对不上的值。）
 */
export function feedbackUrl(shellVersion: string): string {
  const params = new URLSearchParams();
  params.set('prefill_shell_version', shellVersion);
  return `${FEEDBACK_BASE}?${params.toString()}`;
}

/** 幂等写入：已经是我们这份 URL 就原样返回，不做无谓写盘。 */
export function ensureFeedbackEntry(home: string, shellVersion: string): boolean {
  const file = path.join(home, 'cordis.patch.yml');
  const url = feedbackUrl(shellVersion);
  const current = readText(file) ?? '';

  // 已经写过我们的地址：什么都不动。
  // 判据用 FEEDBACK_BASE 而不是整串 —— 壳版本升级时地址里的 shell_version 会变，
  // 那时需要重写；但只要地址还是我们的，就不会误判成"没写过"而重复插一块。
  if (current.includes(`${ROW_ID}`) && current.includes(FEEDBACK_BASE)) {
    if (current.includes(`prefill_shell_version=${shellVersion}`)) return false;
  }

  const block = [
    '# ── 意见反馈：把 DSH 自带的「意见反馈」入口指到我们自己的表单 ──',
    '# 不写这一行的话，用户点「意见反馈」进的是 DeepSeek 官方的飞书表单，',
    '# 我们一条反馈都收不到（详见 src/main/feedback.ts 的说明）。',
    '- insert:',
    `    - id: ${ROW_ID}`,
    `      name: '${PLUGIN_NAME}'`,
    '      config:',
    `        contactFormUrl: '${url}'`,
    `        contactSource: '${CONTACT_SOURCE}'`,
    '',
  ].join('\n');

  // 已经有旧的、指向别处的同 id 行：先把它**整块**（连同我们写的说明注释）摘掉再写新的。
  //
  // 这里踩过一次：第一版只摘了 `- insert:` 那一行，没摘它上面的注释，
  // 于是第二次写（壳版本变了、URL 里的 shell_version 跟着变）之后，
  // 文件里会留下两份说明注释，而且每换一次版本就多留一份 —— 越积越脏。
  // 所以现在按"块"处理：找到 `- insert:`，把到下一个顶层条目之前的行都算作这一块，
  // 块里只要出现我们的行 id 就整块丢弃，并把紧邻其上的注释/空行一起清掉。
  const lines = current.split('\n');
  const kept: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() !== '- insert:') {
      kept.push(line);
      i += 1;
      continue;
    }
    let j = i + 1;
    const inner: string[] = [];
    while (j < lines.length && !lines[j].startsWith('- ') && !lines[j].startsWith('#')) {
      inner.push(lines[j]);
      j += 1;
    }
    const isOurs = inner.some((l) => l.trim().startsWith('- id: ') && l.includes(ROW_ID));
    if (isOurs) {
      while (
        kept.length > 0 &&
        (kept[kept.length - 1].trim() === '' || kept[kept.length - 1].trim().startsWith('#'))
      ) {
        kept.pop();
      }
      i = j;
      continue;
    }
    kept.push(line);
    i += 1;
  }
  const base = kept.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s*$/, '');

  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(file, `${base === '' ? '' : `${base}\n\n`}${block}`);
  return true;
}
