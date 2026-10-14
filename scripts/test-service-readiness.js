#!/usr/bin/env node
/**
 * 离线守卫：DSH 服务"起没起来"的判据（2026-10-14 Windows 用户日志回归）
 *
 * 事故形状（用户日志）：
 *   `等待 DSH Web UI 就绪超时`，可**同一条失败详情的尾巴里**明明有
 *   `dsh web: http://127.0.0.1:3095/?token=…` —— 也就是 DSH 已经宣布自己可服务了，
 *   壳却还在报"没等到"。另外那台机器上还反复出现"重试后又在同一端口拉第二个 DSH"。
 *
 * 本脚本用**假 DSH**（一个 node 脚本）覆盖四种现场，断言壳的行为：
 *   ① 只打印地址行、不监听  → 必须**仍然判失败**（不能因为看到地址就假装成功），
 *      但失败文案要带诊断（端口 / 探测次数 / 是否见到地址行），且不再说"Node/npx"
 *   ② 打印地址行 + 真监听   → 必须**判成功**并很快返回
 *   ③ 启动即退出（exit 3）  → 必须报"提前退出（exit code 3）"，不等满超时
 *   ④ 可执行文件不存在      → 必须**立刻**报 spawn 错误（不能拖到超时），并记进输出尾巴
 *   ⑥ 失败后再调一次        → 前一个子进程必须被收掉（不允许多个 DSH 抢同一端口）
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const dist = path.join(__dirname, '..', 'dist', 'main', 'service-manager.js');
if (!fs.existsSync(dist)) {
  console.error('❌ 找不到编译产物 dist/main/service-manager.js —— 请先 npm run build');
  process.exit(1);
}
const { ServiceManager } = require(dist);

const problems = [];
const check = (name, ok, detail) => {
  if (!ok) problems.push(`${name}${detail ? `（${detail}）` : ''}`);
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-readiness-'));
const home = path.join(tmp, 'home');
fs.mkdirSync(home, { recursive: true });

/** 假 DSH：banner=是否打印地址行；mode=listen | hang | exit */
function fakeDsh(name, mode, exitCode) {
  const port = 'Number((process.argv[args.indexOf("--port") + 1]) || 0)';
  const file = path.join(tmp, name);
  const src = `
const args = process.argv;
const port = ${port};
if (${mode === 'exit'} || false) process.exit(${exitCode ?? 0});
if (${mode !== 'exit'}) console.log('dsh web: http://127.0.0.1:' + port + '/?token=fake-token-abcdef');
if (${mode === 'listen'}) {
  require('http').createServer((req, res) => { res.writeHead(401); res.end('auth required'); }).listen(port, '127.0.0.1');
} else {
  setInterval(() => {}, 1000);   // hang：只打印、不监听
}
`;
  fs.writeFileSync(file, src, 'utf-8');
  return file;
}

const bannerOnly = fakeDsh('fake-banner-only.js', 'hang');
const listening = fakeDsh('fake-listening.js', 'listen');
const exits = fakeDsh('fake-exit.js', 'exit', 3);
const missing = path.join(tmp, 'does-not-exist.js');

const mk = (bin, port, timeoutMs) =>
  new ServiceManager('npx @deepseek-ai/dsh web', {
    port,
    bundledBin: bin,
    env: { DSH_HOME: home },
    timeoutMs,
  });

(async () => {
  // ① 只打印地址行、不监听 → 仍判失败，但文案要带诊断
  {
    const port = 3591;
    const svc = mk(bannerOnly, port, 2000);
    let err = null;
    try {
      await svc.ensureReady();
    } catch (e) {
      err = e;
    }
    check('① 只打印地址行也必须判失败（不能假装成功）', err !== null, err ? '' : '竟然返回成功了');
    const msg = err ? err.message : '';
    check('① 文案带端口', msg.includes(String(port)), msg);
    check('① 文案带探测次数', /探测 \d+ 次/.test(msg), msg);
    check('① 文案说明见到了地址行', msg.includes('见到 dsh web 地址行：是'), msg);
    check('① 随包运行时不再说 Node/npx', !msg.includes('Node/npx'), msg);
    check('① 诊断里有 pid', svc.diagnostics().includes('pid'), svc.diagnostics());
    await svc.stop();
  }

  // ② 打印地址行 + 真监听 → 判成功
  {
    const port = 3592;
    const svc = mk(listening, port, 8000);
    const t0 = Date.now();
    let ok = true;
    try {
      await svc.ensureReady();
    } catch (e) {
      ok = false;
      problems.push(`② 真监听却判失败：${e.message}`);
    }
    check('② 就绪后很快返回（< 5s）', Date.now() - t0 < 5000, `${Date.now() - t0}ms`);
    check('② 见到的地址行被记下', svc.diagnostics().includes('见到 dsh web 地址行：是'));
    await svc.stop();
    check('② 停止后端口释放', !(await isPortOpen(port)));
  }

  // ③ 启动即退出 → 立刻报，且带 exit code
  {
    const port = 3593;
    const svc = mk(exits, port, 6000);
    let err = null;
    const t0 = Date.now();
    try {
      await svc.ensureReady();
    } catch (e) {
      err = e;
    }
    check('③ 提前退出被识别', err !== null && /提前退出（exit code 3）/.test(err.message), err ? err.message : '没报错');
    check('③ 不等满超时', Date.now() - t0 < 4000, `${Date.now() - t0}ms`);
    await svc.stop();
  }

  // ④ 可执行文件不存在（自定义启动命令那条路）→ 立刻报 spawn 错误，并进输出尾巴
  {
    const port = 3594;
    const svc = new ServiceManager('/definitely-missing/not-a-real-npx @deepseek-ai/dsh web', {
      port,
      env: { DSH_HOME: home },
      timeoutMs: 8000,
    });
    let err = null;
    const t0 = Date.now();
    try {
      await svc.ensureReady();
    } catch (e) {
      err = e;
    }
    check('④ spawn 失败被识别', err !== null && err.message.includes('无法启动 DSH'), err ? err.message : '没报错');
    check('④ 不等满超时', Date.now() - t0 < 4000, `${Date.now() - t0}ms`);
    check('④ spawn 错误进了输出尾巴（弹窗能看到）', svc.lastOutput().includes('[spawn error]'), svc.lastOutput());
    await svc.stop();
  }

  // ⑤ 随包运行时入口文件不存在（node 起来了、但脚本加载失败）→ 提前退出 + 尾巴里有真原因
  {
    const port = 3596;
    const svc = mk(missing, port, 8000);
    let err = null;
    const t0 = Date.now();
    try {
      await svc.ensureReady();
    } catch (e) {
      err = e;
    }
    check('⑤ 脚本不存在被识别为提前退出', err !== null && /提前退出（exit code 1）/.test(err.message), err ? err.message : '没报错');
    check('⑤ 不等满超时', Date.now() - t0 < 4000, `${Date.now() - t0}ms`);
    check('⑤ 输出尾巴里带着真原因（Cannot find module）', svc.lastOutput().includes('Cannot find module'), svc.lastOutput().slice(0, 80));
    await svc.stop();
  }

  // ⑥ 失败后再调一次 → 前一个子进程必须被收掉
  {
    const port = 3595;
    const svc = mk(bannerOnly, port, 1500);
    try {
      await svc.ensureReady();
    } catch {
      /* 预期失败 */
    }
    const firstPid = svc.pid;
    try {
      await svc.ensureReady();
    } catch {
      /* 预期失败 */
    }
    const secondPid = svc.pid;
    check('⑥ 重试会另起一个进程', firstPid !== null && secondPid !== null && firstPid !== secondPid,
      `first=${firstPid} second=${secondPid}`);
    check('⑥ 前一个子进程已被收掉（不留孤儿抢端口）', firstPid !== null && !alive(firstPid), `pid ${firstPid} 仍活着`);
    await svc.stop();
  }

  fs.rmSync(tmp, { recursive: true, force: true });

  if (problems.length) {
    console.error('❌ 就绪判据守卫失败：');
    problems.forEach((p) => console.error('  · ' + p));
    process.exitCode = 1;
  } else {
    console.log('✅ 就绪判据守卫通过（地址行是第二信号 · 失败带诊断 · 提前退出/spawn 失败立刻报 · 重试不留孤儿）');
  }
})();

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isPortOpen(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 800 }, () => {
      resolve(true);
      req.destroy();
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
  });
}
