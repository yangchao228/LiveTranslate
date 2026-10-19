import { EnhancedFloatingPopup } from './enhanced-floating-popup'
import { InputDetector } from './input-detector'
import { TranslationService } from './translation-service'
import { editedSentence, manualRange, matchesSnapshot, snapshot, SourceSnapshot, TextRange } from './sentence-range'
import { PageSelectionTranslator } from './page-selection-translator'

const CONTENT_DISPOSE_EVENT = 'live-translate:dispose'

interface ContentLifecycle { dispose: () => void }

interface TranslationJob {
  source: SourceSnapshot
  phase: 'scheduled' | 'loading' | 'ready' | 'error' | 'dismissed'
  translated?: string
}
interface ReplacementCheck {
  job: TranslationJob
  original: string
  markup?: string
  expected: string
  inputVersion: number
  stateVersion: number
  configVersion: number
}
interface EditorState {
  text: string
  composing: boolean
  replacing: boolean
  inputVersion: number
  replacement?: ReplacementCheck
  backup?: TranslationJob
  timer?: number
  job?: TranslationJob
}

/** 每个编辑器只保留一个候选/请求，任务对象身份使过期响应失效。 */
class LiveTranslateContent {
  private inputElements = new Set<HTMLElement>()
  private eventListeners = new Map<HTMLElement, Map<string, EventListener>>()
  private editors = new WeakMap<HTMLElement, EditorState>()
  private activeInput: HTMLElement | null = null
  private popup = EnhancedFloatingPopup.getInstance()
  private reading = new PageSelectionTranslator(this.popup, () => this.activate(null))
  private isEnabled = false
  private readingEnabled = false
  private readingStateVersion = 0
  private stateVersion = 0
  private configVersion = 0
  private mutationObserver: MutationObserver | null = null
  private copyOnlyEditors = new WeakSet<HTMLElement>()
  private readonly DEBOUNCE_DELAY = 300
  private disposed = false
  private readonly timers = new Set<number>()
  private readonly documentListeners: Array<{ type: string; listener: EventListener; capture: boolean }> = []
  private readonly ready: Promise<boolean>
  private readonly runtimeMessageListener: Parameters<typeof chrome.runtime.onMessage.addListener>[0] = (message, _sender, sendResponse) => {
    if (this.disposed) return
    if (message.type === 'CONTENT_READY') {
      void this.ready.then(ready => sendResponse({ success: ready && !this.disposed }))
      return true
    }
    if (message.type === 'EXTENSION_STATE_CHANGED') {
      this.applyExtensionState(message.enabled)
      this.updateVisualIndicator()
    } else if (message.type === 'READING_STATE_CHANGED' && typeof message.enabled === 'boolean') {
      this.applyReadingState(message.enabled)
    } else if (message.type === 'TRANSLATE_SELECTION') {
      sendResponse(this.translateManually())
    } else if (message.type === 'TRANSLATE_PAGE_SELECTION') {
      sendResponse(!this.readingEnabled ? { success: false, error: '划词英译中已关闭，请在工具栏开启后重试。' } : this.reading.translate())
    } else if (message.type === 'TRANSLATION_CONFIG_CHANGED') {
      this.configVersion++
      this.reading.dismiss()
      TranslationService.configure(message.config)
      this.inputElements.forEach(element => this.invalidate(element))
    }
  }

  constructor() {
    chrome.runtime.onMessage.addListener(this.runtimeMessageListener)
    this.listen('focusin', event => {
      if (!this.isEnabled) return
      const target = event.target
      if (!(target instanceof Element) || target.closest('.live-translate-enhanced-popup')) return
      const element = this.inputFromEvent(event)
      if (element !== this.activeInput) this.activate(element)
    })
    // 富文本编辑器可能在内部子节点或 shadow DOM 中拦截 Tab 的冒泡事件。
    // 捕获阶段先尝试当前编辑器，成功后阻止网页把焦点移走；编辑器自身监听仍保留，
    // 用于普通 input/textarea 和不拦截事件的页面。
    this.listen('keydown', event => {
      if (!this.isEnabled) return
      const key = event as KeyboardEvent
      const element = this.inputFromKeydown(key)
      // 键入、清空和撤销意图都会取消尚未完成的校验，不能延迟写回旧草稿。
      if (element) this.cancelReplacement(element, !(key.target instanceof Element && key.target.closest('.live-translate-enhanced-popup')))
      if (key.key !== 'Tab' || key.shiftKey || key.ctrlKey || key.altKey || key.metaKey || key.isComposing) return
      if (element && this.replace(element)) key.preventDefault()
    }, true)
    this.listen('pointerdown', event => {
      if (!this.isEnabled) return
      // 网页的清空按钮可能保留编辑器焦点；任何后续指针操作同样取消恢复。
      if (this.activeInput) this.cancelReplacement(this.activeInput,
        !(event.target instanceof Element && event.target.closest('.live-translate-enhanced-popup')))
    }, true)
    this.listen('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.activate(null)
    })
    const version = this.stateVersion
    const readingVersion = this.readingStateVersion
    this.ready = Promise.all([
      chrome.runtime.sendMessage({ type: 'GET_EXTENSION_STATE' }),
      chrome.runtime.sendMessage({ type: 'GET_TRANSLATION_CONFIG' })
    ]).then(([response, translation]) => {
      if (this.disposed || !translation?.success || typeof response?.enabled !== 'boolean') return false
      if (this.configVersion === 0) TranslationService.configure(translation.config)
      if (readingVersion === this.readingStateVersion) this.applyReadingState(response.readingEnabled === undefined || response.readingEnabled === true)
      if (version === this.stateVersion) this.applyExtensionState(response.enabled)
      return true
    }).catch(() => false)
  }

  private listen(type: string, listener: EventListener, capture = false): void {
    document.addEventListener(type, listener, capture)
    this.documentListeners.push({ type, listener, capture })
  }

  private cancelTimer(timer: number | undefined): void {
    if (timer === undefined) return
    clearTimeout(timer)
    this.timers.delete(timer)
  }

  private later(callback: () => void, delay: number): number {
    const timer = window.setTimeout(() => {
      this.timers.delete(timer)
      if (!this.disposed) callback()
    }, delay)
    this.timers.add(timer)
    return timer
  }

  /** 只撤销本实例持有的资源；退休过程中不写编辑器、焦点或选区。 */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.reading.dispose()
    this.isEnabled = false
    this.stateVersion++
    this.configVersion++
    this.mutationObserver?.disconnect()
    this.mutationObserver = null
    this.inputElements.forEach(element => this.detachInputListener(element))
    this.inputElements.clear()
    this.eventListeners.clear()
    this.editors = new WeakMap()
    this.activeInput = null
    this.timers.forEach(timer => clearTimeout(timer))
    this.timers.clear()
    this.documentListeners.forEach(({ type, listener, capture }) => document.removeEventListener(type, listener, capture))
    this.documentListeners.length = 0
    // 扩展重载后旧 world 的 runtime 可能已失效，DOM 清理仍必须完成。
    try { chrome.runtime.onMessage.removeListener?.(this.runtimeMessageListener) } catch { /* 旧上下文已释放。 */ }
    this.popup.remove()
    document.getElementById('live-translate-indicator')?.remove()
  }

  private scanForInputs(): void {
    const inputs = InputDetector.getInputElements()
    console.log('LiveTranslate: 扫描到输入元素', inputs.length, '个')
    inputs.forEach((input, index) => {
      const inputType = input instanceof HTMLInputElement ? input.type : 'undefined'
      console.log(`LiveTranslate: 为输入元素 ${index + 1} 添加监听器:`, input.tagName, inputType)
      this.attachInputListener(input)
    })
  }

  /**
   * 设置MutationObserver监听DOM变化
   */
  private setupMutationObserver(): void {
    if (this.mutationObserver || !this.isEnabled) return
    this.mutationObserver = new MutationObserver((mutations) => {
      if (!this.isEnabled) return
      mutations.forEach(mutation => {
        // 富文本编辑器可能先挂载普通节点，再开启可编辑状态。
        if (mutation.type === 'attributes') {
          const element = mutation.target
          if (element instanceof HTMLElement) {
            if (InputDetector.isValidInput(element)) this.attachInputListener(element)
            else this.detachInputListener(element)
          }
          return
        }

        mutation.addedNodes.forEach(node => {
          if (node.nodeType === Node.ELEMENT_NODE) {
            const element = node as Element
            // querySelectorAll 只检查后代，需单独识别新增的输入框本身。
            if (InputDetector.isValidInput(element)) {
              this.attachInputListener(element)
            }
            const inputs = element.querySelectorAll(InputDetector.SELECTOR)
            inputs.forEach(input => {
              if (InputDetector.isValidInput(input)) {
                this.attachInputListener(input as HTMLElement)
              }
            })
          }
        })
        mutation.removedNodes.forEach(node => {
          if (node.nodeType !== Node.ELEMENT_NODE) return
          const element = node as Element
          if (element instanceof HTMLElement) this.detachInputListener(element)
          element.querySelectorAll(InputDetector.SELECTOR).forEach(input => this.detachInputListener(input as HTMLElement))
        })
      })
    })

    this.mutationObserver.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['contenteditable', 'disabled', 'readonly', 'type']
    })
  }


  private editor(element: HTMLElement): EditorState {
    let state = this.editors.get(element)
    if (!state) {
      state = { text: InputDetector.getElementValue(element), composing: false, replacing: false, inputVersion: 0 }
      this.editors.set(element, state)
    }
    return state
  }

  private activate(element: HTMLElement | null): void {
    if (element) this.reading.dismiss()
    if (this.activeInput === element) return
    if (this.activeInput) this.invalidate(this.activeInput)
    this.activeInput = element
  }

  private cancelReplacement(element: HTMLElement, closeBackup = true): void {
    const state = this.editor(element)
    state.replacement = undefined
    // 备份浮窗也可能仍在等待位置读取；后续编辑意图要使它的异步挂载失效。
    // 浮窗内部的复制操作保留备份，避免按钮在 click 前被移除。
    if (closeBackup && state.backup) this.invalidate(element)
  }

  private invalidate(element: HTMLElement, dismiss = false, preserveReplacement = false): void {
    const state = this.editor(element)
    if (!preserveReplacement) state.replacement = undefined
    state.backup = undefined
    this.cancelTimer(state.timer)
    state.timer = undefined
    if (dismiss && state.job) state.job.phase = 'dismissed'
    else state.job = undefined
    if (element === this.activeInput) this.popup.remove()
  }

  private attachInputListener(element: HTMLElement): void {
    if (!this.isEnabled || this.inputElements.has(element)) return
    this.inputElements.add(element)
    this.editor(element)
    const listeners = new Map<string, EventListener>([
      ['input', event => {
        const state = this.editor(element)
        if (state.replacing) return
        state.inputVersion++
        // 本次事务外的浏览器原生编辑同样视为用户操作；网页脚本派发的
        // input 只取消自动恢复，保留一次可复制的原稿快照。
        if (event.isTrusted) this.cancelReplacement(element)
        if ((event as InputEvent).isComposing || state.composing) {
          if (state.job && !matchesSnapshot(InputDetector.getElementValue(element), state.job.source)) this.invalidate(element)
          return
        }
        this.handleInput(element, true)
      }],
      ['beforeinput', () => {
        const state = this.editor(element)
        if (!state.replacing) this.cancelReplacement(element)
      }],
      ['compositionstart', () => {
        const state = this.editor(element)
        this.cancelReplacement(element)
        state.composing = true
        this.cancelTimer(state.timer)
        state.timer = undefined
      }],
      ['compositionend', () => {
        const state = this.editor(element)
        state.composing = false
        this.handleInput(element)
        // 下一句的输入法组合不应丢掉前一句仍匹配的待发候选。
        if (state.job?.phase === 'scheduled' && state.timer === undefined) this.armCandidate(element, state.job)
      }],
      ['keydown', event => {
        const key = event as KeyboardEvent
        if (key.isComposing || this.editor(element).composing) return
        if (key.key === 'Escape') this.invalidate(element, true)
        // Tab 已由 document 捕获阶段处理；失败时不能再尝试第二次写入。
      }]
    ])
    this.eventListeners.set(element, listeners)
    listeners.forEach((listener, type) => element.addEventListener(type, listener))
  }

  private detachInputListener(element: HTMLElement): void {
    if (!this.inputElements.has(element)) return
    this.invalidate(element, true)
    this.eventListeners.get(element)?.forEach((listener, type) => element.removeEventListener(type, listener))
    this.eventListeners.delete(element)
    this.inputElements.delete(element)
    if (this.activeInput === element) {
      this.activeInput = null
      this.popup.remove()
    }
  }

  private handleInput(element: HTMLElement, preserveReplacement = false): void {
    if (!this.isEnabled || !InputDetector.isValidInput(element)) return
    // 程序修改非当前编辑器时，不能把另一输入框的焦点或结果抢回来。
    if (!InputDetector.isFocused(element)) return
    this.activate(element)
    const state = this.editor(element)
    const text = InputDetector.getElementValue(element)
    const previous = state.text
    state.text = text
    if (state.job && !matchesSnapshot(text, state.job.source)) this.invalidate(element, false, preserveReplacement)
    const selection = InputDetector.getSelection(element)
    if (!selection || selection.start !== selection.end) return
    const range = editedSentence(text, previous, selection.end)
    if (!range) return
    const source = snapshot(text, range)
    if (state.job && this.sameSource(state.job.source, source)) return
    this.schedule(element, source)
  }

  private sameSource(a: SourceSnapshot, b: SourceSnapshot): boolean {
    return a.start === b.start && a.end === b.end && a.text === b.text && a.prefix === b.prefix
  }

  private inputFromEvent(event: Event): HTMLElement | null {
    const path = typeof event.composedPath === 'function' ? event.composedPath() : []
    for (const node of path) {
      if (node instanceof HTMLElement && InputDetector.isValidInput(node)) return node
    }
    let target: Element | null = event.target instanceof Element ? event.target : null
    while (target) {
      if (target instanceof HTMLElement && InputDetector.isValidInput(target)) return target
      target = target.parentElement
    }
    return null
  }

  private inputFromKeydown(event: KeyboardEvent): HTMLElement | null {
    return this.inputFromEvent(event) || (this.activeInput && InputDetector.isValidInput(this.activeInput) ? this.activeInput : null)
  }

  private schedule(element: HTMLElement, source: SourceSnapshot): void {
    this.invalidate(element)
    const state = this.editor(element)
    const job: TranslationJob = { source, phase: 'scheduled' }
    state.job = job
    this.armCandidate(element, job)
  }

  private armCandidate(element: HTMLElement, job: TranslationJob): void {
    const state = this.editor(element)
    state.timer = this.later(() => {
      state.timer = undefined
      if (this.isCurrent(element, job) && !state.composing) void this.performTranslation(element, job)
    }, this.DEBOUNCE_DELAY)
  }

  private translateManually(): { success: boolean; error?: string } {
    if (this.disposed || !this.isEnabled) return { success: false, error: '输入中译英已关闭，请在工具栏开启后重试。' }
    const element = document.activeElement
    if (!(element instanceof HTMLElement) || !InputDetector.isValidInput(element)) return { success: false, error: '请先把光标放入需要翻译的输入框' }
    this.activate(element)
    const state = this.editor(element)
    if (state.composing) return { success: false, error: '请先确认输入法文字，再手动翻译' }
    const text = InputDetector.getElementValue(element)
    const selection = InputDetector.getSelection(element)
    if (!selection) return { success: false, error: '无法读取选区，请重新定位光标' }
    const range: TextRange | null = manualRange(text, selection.start, selection.end)
    if (!range) return { success: false, error: '输入框或选区中没有可翻译的文字' }
    state.text = text
    const source = snapshot(text, range)
    // 手动入口允许重试错误或已关闭的结果，重复触发进行中的请求仍去重。
    if (state.job && this.sameSource(state.job.source, source) && ['loading', 'ready'].includes(state.job.phase)) return { success: true }
    this.invalidate(element)
    const job: TranslationJob = { source, phase: 'scheduled' }
    state.job = job
    void this.performTranslation(element, job)
    return { success: true }
  }

  private isCurrent(element: HTMLElement, job: TranslationJob): boolean {
    return !this.disposed && this.isEnabled && element.isConnected && this.activeInput === element &&
      InputDetector.isValidInput(element) && this.editor(element).job === job && job.phase !== 'dismissed' &&
      matchesSnapshot(InputDetector.getElementValue(element), job.source)
  }

  private async performTranslation(element: HTMLElement, job: TranslationJob): Promise<void> {
    if (!this.isCurrent(element, job)) return
    job.phase = 'loading'
    const actions = { onClose: () => this.invalidate(element, true), onReplace: () => this.replace(element) }
    // 加载状态不提供替换动作；关闭会同时使请求身份失效。
    void this.popup.createStatus('正在翻译…', element, actions.onClose)
    try {
      const response = await TranslationService.translate({ text: job.source.text, sourceLang: 'auto', targetLang: 'en' }, status => {
        if (this.isCurrent(element, job)) void this.popup.createStatus(status, element, actions.onClose)
      })
      if (!this.isCurrent(element, job)) return
      if (!response.translatedText.trim()) throw new Error('服务返回空译文，请手动重试')
      job.translated = response.translatedText
      job.phase = 'ready'
      const restriction = this.replacementRestriction(element)
      await this.popup.createBilingual(job.source.text, response.translatedText, element,
        restriction ? { onClose: actions.onClose, notice: restriction } : actions)
    } catch (error) {
      if (!this.isCurrent(element, job)) return
      job.phase = 'error'
      const reason = error instanceof Error ? error.message : '未知错误'
      await this.popup.createStatus(`翻译失败：${reason}。可通过手动翻译重试。`, element, actions.onClose)
    }
  }

  /** 按钮和 Tab 共用校验；只有确认仍匹配时才写入和恢复光标。 */
  private replace(element: HTMLElement): boolean {
    const state = this.editor(element)
    const job = state.job
    if (state.composing || !job || job.phase !== 'ready' || !job.translated || !this.isCurrent(element, job)) return false
    if (this.replacementRestriction(element)) return false
    const text = InputDetector.getElementValue(element)
    const markup = element.isContentEditable ? element.innerHTML : undefined
    const result = text.slice(0, job.source.start) + job.translated + text.slice(job.source.end)
    state.replacing = true
    let accepted = false
    try { accepted = InputDetector.replaceText(element, job.source.start, job.source.end, job.translated) }
    finally {
      state.replacing = false
      state.text = InputDetector.getElementValue(element)
    }
    if (!accepted || state.text !== result) {
      this.replacementFailed(element, text, job, state.text === text)
      return false
    }
    this.popup.remove()
    const check: ReplacementCheck = {
      job, original: text, markup, expected: result, inputVersion: state.inputVersion,
      stateVersion: this.stateVersion, configVersion: this.configVersion
    }
    state.replacement = check
    this.verifyReplacement(element, check)
    return true
  }

  private replacementRestriction(element: HTMLElement): string | null {
    return InputDetector.replacementRestriction(element) || (this.copyOnlyEditors.has(element)
      ? '此编辑器未接受安全替换，已保留原文和译文。请复制译文后自行粘贴。'
      : null)
  }

  private replacementFailed(element: HTMLElement, original: string, job: TranslationJob, restored: boolean): void {
    this.copyOnlyEditors.add(element)
    job.phase = 'error'
    // 备份只有错误态和复制动作，后续编辑仍按同一快照生命周期关闭它。
    const state = this.editor(element)
    state.job = job
    state.backup = job
    void this.popup.createBilingual(original, job.translated!, element, {
      onClose: () => this.invalidate(element, true),
      notice: restored
        ? '编辑器拒绝替换，原草稿已保留。请复制译文后自行粘贴。'
        : '编辑器未保留替换结果，已停止写入。下方保留原草稿和译文，可分别复制。',
      copyOriginal: true
    })
  }

  private verifyReplacement(
    element: HTMLElement,
    check: ReplacementCheck,
    finalCheck = false
  ): void {
    this.later(() => {
      if (!this.isEnabled || !element.isConnected || !InputDetector.isValidInput(element)) return
      const state = this.editor(element)
      if (this.activeInput !== element || state.replacement !== check || check.job.phase !== 'ready' ||
        this.stateVersion !== check.stateVersion || this.configVersion !== check.configVersion ||
        (state.job && state.job !== check.job)) return
      const current = InputDetector.getElementValue(element)
      if (current === check.expected) {
        if (finalCheck) this.invalidate(element)
        else this.verifyReplacement(element, check, true)
        return
      }
      state.replacement = undefined
      if (current === '' && state.inputVersion === check.inputVersion) {
        // 仅当本次事务之后没有任何键盘、输入法、beforeinput、input 或指针
        // 操作时恢复一次空回滚。用户主动清空、撤销或续写绝不触发恢复。
        InputDetector.restoreSnapshot(element, check.original, check.markup, check.job.source.start)
      }
      state.text = InputDetector.getElementValue(element)
      // 带 input 的回滚可能已经使翻译任务失效，但不能因此丢掉原稿。
      // 此处只显示独立快照的复制退路，不重新写入草稿或重试译文。
      this.replacementFailed(element, check.original, check.job, state.text === check.original)
    }, finalCheck ? 150 : 0)
  }

  private applyExtensionState(enabled: boolean): void {
    if (this.disposed) return
    this.stateVersion++
    if (this.isEnabled === enabled) return
    this.isEnabled = enabled
    if (enabled) {
      this.scanForInputs()
      this.setupMutationObserver()
    } else {
      this.mutationObserver?.disconnect()
      this.mutationObserver = null
      this.inputElements.forEach(element => {
        this.invalidate(element)
        this.eventListeners.get(element)?.forEach((listener, type) => element.removeEventListener(type, listener))
      })
      this.inputElements.clear()
      this.eventListeners.clear()
      this.editors = new WeakMap()
      this.activeInput = null
      // 阅读在开始时已释放 activeInput；这里只清理上面失效的写作任务，
      // 不移除仍由独立阅读任务持有的浮窗。
    }
  }

  private applyReadingState(enabled: boolean): void {
    if (this.disposed) return
    this.readingStateVersion++
    this.readingEnabled = enabled
    this.reading.setEnabled(enabled)
  }

  private updateVisualIndicator(): void {
    // 移除现有指示器
    const existingIndicator = document.getElementById('live-translate-indicator')
    if (existingIndicator) {
      existingIndicator.remove()
    }

    // 添加新指示器
    if (!this.isEnabled) {
      const indicator = document.createElement('div')
      indicator.id = 'live-translate-indicator'
      indicator.textContent = '输入中译英已暂停'
      indicator.style.cssText = `
        position: fixed;
        top: 10px;
        right: 10px;
        background: rgba(220, 53, 69, 0.9);
        color: white;
        padding: 8px 12px;
        border-radius: 20px;
        font-size: 12px;
        font-weight: bold;
        z-index: 10000;
        box-shadow: 0 2px 8px rgba(0,0,0,0.2);
        animation: fadeIn 0.3s ease;
      `
      document.body.appendChild(indicator)
      
      // 3秒后自动隐藏
      this.later(() => {
        indicator.style.opacity = '0'
        this.later(() => indicator.remove(), 300)
      }, 3000)
    }
  }

}

// 同一 world 重注入和扩展重载产生的新 world 都先退休上一实例。
// 事件不传递草稿或配置，也不触发页面导航；旧版尚未提供该协议时不能撤销其匿名监听。
const contentGlobal = globalThis as typeof globalThis & { __liveTranslateContentLifecycle?: ContentLifecycle }
contentGlobal.__liveTranslateContentLifecycle?.dispose()
document.dispatchEvent(new Event(CONTENT_DISPOSE_EVENT))
let instance: LiveTranslateContent | undefined
let retired = false
const start = () => {
  if (!retired) instance = new LiveTranslateContent()
}
const lifecycle: ContentLifecycle = {
  dispose: () => {
    if (retired) return
    retired = true
    document.removeEventListener('DOMContentLoaded', start)
    document.removeEventListener(CONTENT_DISPOSE_EVENT, lifecycle.dispose)
    instance?.dispose()
    if (contentGlobal.__liveTranslateContentLifecycle === lifecycle) delete contentGlobal.__liveTranslateContentLifecycle
  }
}
contentGlobal.__liveTranslateContentLifecycle = lifecycle
document.addEventListener(CONTENT_DISPOSE_EVENT, lifecycle.dispose)
// 等待页面 DOM 可用后启动；等待期间再次注入也只留下最后一个启动回调。
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true })
else start()
