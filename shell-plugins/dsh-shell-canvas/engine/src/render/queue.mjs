/**
 * 渲染任务队列（本机串行）。
 *
 * 立项文档里的要求：进度面板、长任务后台、可取消。
 * S1 先做最小可用：串行执行、状态查询、单项取消、事件回调。
 */

export class RenderQueue {
  constructor({ concurrency = 1 } = {}) {
    this.concurrency = concurrency;
    this.jobs = new Map();
    this.running = 0;
    this.listeners = { progress: [], done: [] };
  }

  on(event, fn) {
    (this.listeners[event] ||= []).push(fn);
    return this;
  }

  _emit(event, payload) {
    for (const fn of this.listeners[event] || []) fn(payload);
  }

  add(id, task) {
    const job = { id, task, status: 'queued', progress: null, result: null, error: null, controller: new AbortController() };
    this.jobs.set(id, job);
    this._pump();
    return job;
  }

  get(id) {
    return this.jobs.get(id) || null;
  }

  list() {
    return [...this.jobs.values()].map(({ id, status, progress }) => ({ id, status, progress }));
  }

  cancel(id) {
    const job = this.jobs.get(id);
    if (!job) return false;
    job.controller.abort();
    if (job.status === 'queued') job.status = 'cancelled';
    return true;
  }

  async _pump() {
    if (this.running >= this.concurrency) return;
    const next = [...this.jobs.values()].find((j) => j.status === 'queued');
    if (!next) return;
    this.running++;
    next.status = 'running';
    try {
      next.result = await next.task({
        signal: next.controller.signal,
        onProgress: (p) => {
          next.progress = p;
          this._emit('progress', { id: next.id, progress: p });
        },
      });
      next.status = next.controller.signal.aborted ? 'cancelled' : 'done';
    } catch (e) {
      next.error = e.message;
      next.status = e.cancelled ? 'cancelled' : 'failed';
    } finally {
      this.running--;
      this._emit('done', { id: next.id, status: next.status, error: next.error });
      this._pump();
    }
  }

  /** 队列全部结束（含失败）后返回 */
  async drain() {
    while ([...this.jobs.values()].some((j) => j.status === 'queued' || j.status === 'running')) {
      await new Promise((r) => setTimeout(r, 50));
    }
    return this.list();
  }
}
