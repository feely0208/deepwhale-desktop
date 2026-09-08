import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'

const WORKBENCH_URL = 'http://127.0.0.1:3089/'
export const inject = ['sessions', 'connection']

export function apply(ctx: ClientContext): void {
  const conn = ctx.get('connection') as unknown as { api?: unknown }
  const api = conn?.api
  const sessions = (ctx.get('sessions') as unknown) as {
    list?: {
      getSnapshot?: () => { ids?: string[]; byId?: Record<string, { agentPreset?: string }> }
      subscribe?: (fn: () => void) => () => void
    }
  }
  let shown = false
  let prevSessionHit = false
  let prevDefaultHit = false

  const closeOverlay = (): void => { const o = document.getElementById('dsh-legal-mode-overlay'); if (o) o.remove() }
  const ensureOverlay = (): void => {
    if (document.getElementById('dsh-legal-mode-overlay')) return
    const ov = document.createElement('div')
    ov.id = 'dsh-legal-mode-overlay'
    ov.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:#fff;'
    const iframe = document.createElement('iframe')
    iframe.src = WORKBENCH_URL + '?v=' + Date.now()
    iframe.style.cssText = 'width:100%;height:100%;border:none;'
    ov.appendChild(iframe)
    // 可拖动的「返回 DSH」按钮
    const close = document.createElement('button')
    close.id = 'dsh-legal-close'
    close.textContent = '✕ 返回 DSH'
    close.style.cssText = 'position:fixed;top:14px;right:18px;z-index:2147483648;padding:8px 16px;border:none;border-radius:999px;background:rgba(255,255,255,.94);color:#333;font:600 13px -apple-system,Segoe UI,sans-serif;cursor:grab;box-shadow:0 4px 16px rgba(0,0,0,.22);touch-action:none;user-select:none;'
    let dragMoved = false
    close.addEventListener('click', () => { if (dragMoved) { dragMoved = false; return } closeOverlay() })
    close.addEventListener('pointerdown', (e) => {
      e.preventDefault()
      dragMoved = false
      const rect = close.getBoundingClientRect()
      const offX = e.clientX - rect.left
      const offY = e.clientY - rect.top
      const startX = e.clientX
      const startY = e.clientY
      close.style.cursor = 'grabbing'
      const mv = (ev: PointerEvent) => {
        if (!dragMoved && (Math.abs(ev.clientX - startX) > 4 || Math.abs(ev.clientY - startY) > 4)) dragMoved = true
        if (dragMoved) { close.style.left = (ev.clientX - offX) + 'px'; close.style.top = (ev.clientY - offY) + 'px'; close.style.right = 'auto' }
      }
      const up = () => { close.style.cursor = 'grab'; close.removeEventListener('pointermove', mv); close.removeEventListener('pointerup', up); close.removeEventListener('pointercancel', up) }
      close.addEventListener('pointermove', mv)
      close.addEventListener('pointerup', up)
      close.addEventListener('pointercancel', up)
    })
    ov.appendChild(close)
    document.body.appendChild(ov)
  }
  const ensureButton = (): void => {
    if (document.getElementById('dsh-legal-mode-float')) return
    const btn = document.createElement('button')
    btn.id = 'dsh-legal-mode-float'
    btn.textContent = '⚖️ 打开律师工作台'
    btn.style.cssText = 'position:fixed;right:20px;bottom:20px;z-index:2147483646;padding:10px 16px;border:none;border-radius:999px;background:linear-gradient(135deg,#4f8cff,#7aa8ff);color:#fff;font-size:13px;font-weight:700;cursor:pointer;box-shadow:0 8px 30px rgba(79,140,255,.4);font-family:inherit;'
    btn.addEventListener('click', ensureOverlay)
    document.body.appendChild(btn)
  }
  const removeButton = (): void => { const b = document.getElementById('dsh-legal-mode-float'); if (b) b.remove() }

  const check = async (): Promise<void> => {
    try {
      const s = sessions?.list?.getSnapshot?.()
      const ids = s?.ids || []
      const sessionHit = !!(s && ids.some((id) => s?.byId?.[id]?.agentPreset === 'legal-mode'))
      let defaultHit = false
      try {
        const res = await (api as { agentPresets?: { list?: (p: object) => Promise<unknown> } })?.agentPresets?.list?.({}) as any
        const presets = res?.result?.value?.presets || res?.value?.presets || []
        defaultHit = presets.some((p: { id?: string; isDefault?: boolean }) => p.id === 'legal-mode' && p.isDefault)
      } catch { /* ignore */ }
      const hit = sessionHit || defaultHit
      if (hit) {
        // 首次命中，或从非法律模式重新进入（切走再切回）时重新弹出。
        const reentered = (sessionHit && !prevSessionHit) || (defaultHit && !prevDefaultHit)
        if (!shown || reentered) { shown = true; ensureOverlay() }
        ensureButton()
      } else {
        shown = false
        removeButton()
      }
      prevSessionHit = sessionHit
      prevDefaultHit = defaultHit
    } catch { /* ignore */ }
  }

  try { sessions?.list?.subscribe?.(() => void check()) } catch { /* ignore */ }
  window.setInterval(() => void check(), 1200)
}
