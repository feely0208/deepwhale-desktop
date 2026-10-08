#!/usr/bin/env node
/**
 * 渲染子进程（Node 入口，Chromium 后端）。
 *
 * 为什么必须是**子进程**（交接文档 §4.3 第一条）：
 *   本地神经 TTS 走的 `sherpa-onnx-node` 是原生库，**崩了会 abort 整个进程**，
 *   JS 的 try/catch 拦不住。跑在子进程里，最坏情况只死这一个任务，
 *   主窗口与 DSH 宿主毫发无损。
 *
 * 协议（stdout，一行一个 JSON）：
 *   {"t":"gate", ...}                     校验闸门结果
 *   {"t":"step"|"log"|"progress", ...}    进度
 *   {"t":"result","value":{...}}          成功
 *   {"t":"error","message":...,"cancelled":bool,"validation":{...}}  失败
 *
 * 取消：收到 SIGTERM/SIGINT → AbortController.abort() → 引擎在下一帧前收手，
 *       并把**已渲好的帧的 manifest 落盘**（`partial: true`），这就是"断点续渲"的锚点。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const spec = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const emit = (e) => { process.stdout.write(JSON.stringify(e) + '\n'); };

/**
 * 冲干净 stdout 再退。
 *
 * ⚠️ stdout 是**管道**，`write` 是异步的，而 `process.exit()` 立即终止 ——
 *    最后一两行（往往正是 `{"t":"result"}`）可能还没冲出去就被丢掉，
 *    宿主就会把"已经跑完的任务"判成失败。
 *    写法：再写一个哨兵块并等它的回调；Node 保证 FIFO，最后一块冲出去即前面都冲完了。
 */
function flushAndExit(code) {
  let done = false;
  const finish = () => { if (!done) { done = true; process.exit(code); } };
  process.stdout.write('\n', finish);
  setTimeout(finish, 2000).unref?.();
}

const controller = new AbortController();
const abort = () => { if (!controller.signal.aborted) controller.abort(); };
process.on('SIGTERM', abort);
process.on('SIGINT', abort);
process.on('uncaughtException', (e) => {
  emit({ t: 'error', message: `未捕获异常：${e && e.message ? e.message : String(e)}`, stack: String((e && e.stack) || '').slice(0, 1200) });
  process.exit(9);
});

try {
  const { runJob } = await import(pathToFileURL(join(import.meta.dirname, 'pipeline-run.mjs')).href);
  const { ChromiumAdapter } = await import(
    pathToFileURL(join(spec.engineRoot, 'src/render/adapter-chromium.mjs')).href
  );
  const value = await runJob(spec, {
    emit,
    makeAdapter: ({ width, height }) => new ChromiumAdapter({ width, height }),
    signal: controller.signal,
  });
  emit({ t: 'result', value });
  flushAndExit(0);
} catch (error) {
  emit({
    t: 'error',
    message: error && error.message ? error.message : String(error),
    cancelled: !!(error && error.cancelled) || controller.signal.aborted,
    validation: (error && error.validation) || null,
  });
  flushAndExit(error && error.cancelled ? 3 : 1);
}
