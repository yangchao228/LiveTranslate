import { EnhancedFloatingPopup } from './enhanced-floating-popup'
import { TranslationService } from './translation-service'

const UI_SELECTOR = '[data-live-translate-ui],.live-translate-enhanced-popup,.live-translate-popup,#live-translate-command-notice'
const EXCLUDED_SELECTOR = `input,textarea,[contenteditable],[role="textbox"],script,style,noscript,${UI_SELECTOR}`
interface PageSelection {
  range: Range
  text: string
  contents: string
  start: Node
  startOffset: number
  end: Node
  endOffset: number
}
interface ReadingJob { source: PageSelection; phase: 'loading' | 'ready' | 'error' }

/** 正文选区只展示入口；用户明确触发后才读取当前快照并请求英译中。 */
export class PageSelectionTranslator {
  private enabled = false
  private disposed = false
  private trigger: HTMLElement | null = null
  private timer?: number
  private job?: ReadingJob
  private sourceObserver?: MutationObserver
  private listeners: Array<{ target: EventTarget; type: string; listener: EventListener; capture: boolean }> = []

  constructor(private popup: EnhancedFloatingPopup, private onStart: () => void) {
    this.listen(document, 'selectionchange', () => this.scheduleRefresh())
    this.listen(document, 'pointerup', () => this.scheduleRefresh())
    this.listen(document, 'keyup', event => {
      if ((event as KeyboardEvent).key !== 'Escape') this.scheduleRefresh()
    })
    this.listen(document, 'keydown', event => {
      if (this.enabled && (event as KeyboardEvent).key === 'Escape') this.dismiss()
    }, true)
    this.listen(document, 'pointerdown', event => {
      if (this.enabled && !this.insideUi(event.target)) this.dismiss()
    }, true)
    this.listen(document, 'mousedown', event => {
      // 点击复制等动作不折叠正文选区，键盘仍可正常聚焦操作。
      if (this.job && event.target instanceof Element &&
          event.target.closest('.live-translate-enhanced-popup button,.live-translate-enhanced-popup a')) event.preventDefault()
    }, true)
    this.listen(document, 'focusin', event => {
      if (this.enabled && event.target instanceof Element && !this.insideUi(event.target) &&
          event.target.closest('input,textarea,[contenteditable],[role="textbox"]')) this.dismiss()
    })
    this.listen(document, 'visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.dismiss()
    })
    this.listen(window, 'scroll', event => {
      // 浮窗内部滚动用于阅读长译文；网页滚动后选区定位失效。
      if (!this.insideUi(event.target)) this.dismiss()
    }, true)
    this.listen(window, 'resize', () => this.dismiss())
  }

  private listen(target: EventTarget, type: string, listener: EventListener, capture = false): void {
    target.addEventListener(type, listener, capture)
    this.listeners.push({ target, type, listener, capture })
  }

  private insideUi(target: EventTarget | null): boolean {
    const element = target instanceof Element ? target : target instanceof Node ? target.parentElement : null
    return !!element?.closest(UI_SELECTOR)
  }

  private selectionInsideUi(): boolean {
    const selection = document.getSelection?.()
    return !!selection?.anchorNode && this.insideUi(selection.anchorNode) && this.insideUi(selection.focusNode)
  }

  private readSelection(): PageSelection | null {
    const selection = document.getSelection?.()
    if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return null
    if (document.activeElement?.closest('input,textarea,[contenteditable],[role="textbox"]')) return null
    const range = selection.getRangeAt(0).cloneRange()
    const raw = range.toString()
    // Selection保留跨段落的可见换行；Range原始文本另存作DOM快照校验。
    const text = selection.toString().trim()
    if (!text || Math.max(raw.length, text.length) > 5000 || !/[a-z]/iu.test(text) || /\p{Script=Han}/u.test(text)) return null
    const element = (node: Node) => node instanceof Element ? node : node.parentElement
    const start = element(range.startContainer), end = element(range.endContainer)
    if (!start?.isConnected || !end?.isConnected || start.closest(EXCLUDED_SELECTOR) || end.closest(EXCLUDED_SELECTOR)) return null
    const root = element(range.commonAncestorContainer)
    if (!root || Array.from(root.querySelectorAll(EXCLUDED_SELECTOR)).some(node => range.intersectsNode(node))) return null
    const rect = range.getBoundingClientRect()
    if (!rect.width || !rect.height) return null
    return { range, text, contents: raw, start: range.startContainer, startOffset: range.startOffset,
      end: range.endContainer, endOffset: range.endOffset }
  }

  private matches(source: PageSelection, current: PageSelection): boolean {
    return source.start === current.start && source.startOffset === current.startOffset &&
      source.end === current.end && source.endOffset === current.endOffset && source.text === current.text
  }

  private isCurrent(job: ReadingJob): boolean {
    if (!this.enabled || this.disposed || this.job !== job || !job.source.start.isConnected ||
        !job.source.end.isConnected || job.source.range.toString() !== job.source.contents) return false
    const current = this.readSelection()
    return current ? this.matches(job.source, current) : this.selectionInsideUi()
  }

  private discardStale(job: ReadingJob): boolean {
    if (this.isCurrent(job)) return false
    if (this.job === job) this.dismiss()
    return true
  }

  private scheduleRefresh(): void {
    if (!this.enabled || this.disposed) return
    clearTimeout(this.timer)
    this.timer = window.setTimeout(() => {
      this.timer = undefined
      if (!this.enabled || this.disposed || this.selectionInsideUi()) return
      const selection = this.readSelection()
      if (this.job && selection && this.matches(this.job.source, selection)) {
        return
      }
      this.dismiss()
      if (selection) this.showTrigger(selection)
    }, 80)
  }

  private showTrigger(source: PageSelection): void {
    this.trigger?.remove()
    const host = document.createElement('div')
    host.id = 'live-translate-selection-trigger'
    host.dataset.liveTranslateUi = 'reading'
    let rect: DOMRect
    try {
      // 多行选区贴近末行，避免跨段落的大包围框把入口推离刚读到的位置。
      const lines = Array.from(source.range.getClientRects()).filter(line => line.width > 0 && line.height > 0)
      rect = lines[lines.length - 1] ?? source.range.getBoundingClientRect()
    } catch {
      return
    }
    host.style.cssText = 'all:initial;position:fixed;left:0;top:0;z-index:2147483647;display:block;visibility:hidden;color-scheme:light;max-width:calc(100vw - 16px)'
    const shadow = host.attachShadow({ mode: 'open' })
    shadow.innerHTML = `<style>
      :host{color-scheme:light;line-height:0}
      button{all:initial;box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:6px;max-width:100%;min-height:32px;padding:5px 10px;cursor:pointer;user-select:none;touch-action:manipulation;background:#fff;color:#33445f;border:1px solid #dce2ec;border-radius:999px;box-shadow:0 2px 8px #18253d14,0 1px 2px #18253d0a;font:500 13px/20px "PingFang SC","Microsoft YaHei",system-ui,sans-serif;white-space:nowrap;transition:background-color 140ms,border-color 140ms,box-shadow 140ms}
      .reading-mark{display:block;flex:none;width:16px;height:16px;color:#3158bd}
      button:hover{background:#f5f7fc;border-color:#c9d5ed;box-shadow:0 3px 10px #18253d1a,0 1px 2px #18253d0a}
      button:active{background:#edf2ff;border-color:#b9c8ea;box-shadow:0 1px 3px #18253d14}
      button:focus-visible{outline:2px solid #3158bd;outline-offset:2px}
      @media(prefers-reduced-motion:reduce){button{transition:none}}
    </style><button type="button" aria-label="将选中的英文翻译成中文"><svg class="reading-mark" viewBox="0 0 64 64" fill="currentColor" aria-hidden="true" focusable="false"><path d="M12 9h31c7.73 0 14 6.27 14 14v1H40c-6.63 0-12 3.63-12 9H17v-8a5 5 0 0 0-5-5H7v-6a5 5 0 0 1 5-5Z"/><path d="M36 32h11v7a5 5 0 0 0 5 5h5v6a5 5 0 0 1-5 5H21c-7.73 0-14-6.27-14-14v-1h17c6.63 0 12-2.63 12-8Z"/></svg><span>翻译成中文</span></button>`
    const button = shadow.querySelector('button')!
    button.addEventListener('mousedown', event => event.preventDefault())
    button.addEventListener('click', () => { this.translate() })
    this.trigger = host
    document.body.appendChild(host)
    // 挂载后按真实尺寸定位，字号或系统字体变化时仍保留视口安全边。
    const size = button.getBoundingClientRect()
    const margin = 8, gap = 6
    const left = Math.max(margin, Math.min(rect.right - size.width, window.innerWidth - margin - size.width))
    const below = rect.bottom + gap
    const top = below + size.height <= window.innerHeight - margin ? below : rect.top - gap - size.height
    host.style.left = `${left}px`
    host.style.top = `${Math.max(margin, Math.min(top, window.innerHeight - margin - size.height))}px`
    host.style.visibility = 'visible'
  }

  translate(): { success: boolean; error?: string } {
    if (!this.enabled || this.disposed) return { success: false, error: '请先启用 LiveTranslate' }
    const source = this.readSelection()
    if (!source) return { success: false, error: '请在网页正文中选中英文（最多 5,000 字符），再翻译成中文' }
    if (this.job && this.matches(this.job.source, source) && this.job.phase !== 'error') return { success: true }
    this.dismiss()
    this.onStart()
    const job: ReadingJob = { source, phase: 'loading' }
    this.job = job
    this.sourceObserver = new MutationObserver(() => {
      if (!this.isCurrent(job)) this.dismiss()
    })
    this.sourceObserver.observe(source.range.commonAncestorContainer, { childList: true, characterData: true, subtree: true })
    void this.perform(job)
    return { success: true }
  }

  private async perform(job: ReadingJob): Promise<void> {
    const close = () => this.dismiss()
    void this.popup.createStatus('正在翻译成中文…', job.source.range, close, { reading: true })
    try {
      const result = await TranslationService.translate({ text: job.source.text, sourceLang: 'en', targetLang: 'zh' }, status => {
        if (this.isCurrent(job)) void this.popup.createStatus(status, job.source.range, close, { reading: true })
      })
      if (this.discardStale(job)) return
      job.phase = 'ready'
      await this.popup.createReadingTranslation(result.translatedText, job.source.range, { onClose: close })
    } catch (error) {
      if (this.discardStale(job)) return
      job.phase = 'error'
      const reason = error instanceof Error ? error.message : '翻译服务暂不可用'
      const onPrepare = TranslationService.getCurrentProvider() === 'browser'
        ? async () => {
          const response = await chrome.runtime.sendMessage({ type: 'OPEN_READING_PREPARATION' })
          if (!response?.success) throw new Error('无法打开准备页')
        } : undefined
      const onRetry = () => { if (this.isCurrent(job)) this.translate() }
      await this.popup.createStatus(`翻译失败：${reason}`, job.source.range, close, { reading: true, onPrepare, onRetry })
    }
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled
    if (!enabled) this.dismiss()
  }

  dismiss(): void {
    clearTimeout(this.timer)
    this.timer = undefined
    this.sourceObserver?.disconnect()
    this.sourceObserver = undefined
    this.trigger?.remove()
    this.trigger = null
    if (this.job) this.popup.remove()
    this.job = undefined
  }

  dispose(): void {
    this.disposed = true
    this.enabled = false
    this.dismiss()
    this.listeners.forEach(({ target, type, listener, capture }) => target.removeEventListener(type, listener, capture))
    this.listeners.length = 0
  }
}
