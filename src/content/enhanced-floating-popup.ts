import { PopupPosition } from '../shared/types'

interface BilingualActions {
  onClose: () => void
  onReplace?: () => void
  notice?: string
  copyOriginal?: boolean
  targetLanguage?: 'en' | 'zh'
}

type PopupAnchor = HTMLElement | Range
interface StatusOptions { reading?: boolean; onPrepare?: () => Promise<void>; onRetry?: () => Promise<void> | void }

/**
 * 页内译文浮窗：原文核对、译文阅读和确认操作，固定瓷白浅色。
 */
export class EnhancedFloatingPopup {
  private static instance: EnhancedFloatingPopup
  private popup: HTMLElement | null = null
  private currentTarget: PopupAnchor | null = null
  private actions: { onClose: () => void; onReplace?: () => void } | null = null
  private cleanupPopupEvents?: () => void
  private prepareAction?: () => Promise<void>
  private retryAction?: () => Promise<void> | void

  /**
   * 获取单例实例
   */
  static getInstance(): EnhancedFloatingPopup {
    if (!this.instance) {
      this.instance = new EnhancedFloatingPopup()
    }
    return this.instance
  }

  /**
   * 创建请求状态悬浮窗
   * @param text 当前输入文本
   * @param targetElement 目标输入元素
   */
  async createStatus(text: string, targetElement: PopupAnchor, onClose: () => void, options: StatusOptions = {}): Promise<void> {
    if (options.reading) {
      this.createReadingPopup(this.createReadingStatusHTML(text, options), targetElement, onClose)
      this.prepareAction = options.onPrepare
      this.retryAction = options.onRetry
      this.addEventListeners()
      return
    }
    // 检查是否是同一个目标元素，避免不必要的remove
    const isSameTarget = this.currentTarget === targetElement
    
    if (!isSameTarget) {
      this.remove()
    }
    
    this.currentTarget = targetElement
    this.actions = { onClose }
    this.prepareAction = options.onPrepare
    this.retryAction = undefined
    
    // 如果已有弹框且是同一目标，则更新内容
    if (isSameTarget && this.popup) {
      this.popup.setAttribute('aria-label', 'LiveTranslate 翻译状态')
      this.popup.innerHTML = this.createStatusHTML(text, options)
      this.addEventListeners()
    } else {
      // 创建新弹框
      this.popup = document.createElement('div')
      this.popup.className = 'live-translate-enhanced-popup theme-light'
      this.popup.setAttribute('role', 'region')
      this.popup.setAttribute('aria-label', 'LiveTranslate 翻译状态')
      this.popup.innerHTML = this.createStatusHTML(text, options)

      // 添加增强样式
      this.addEnhancedStyles()
      
      // 定位悬浮窗
      const position = this.calculateSmartPosition(targetElement)
      const popup = this.popup
      const styles = await this.getPopupStyles(position)
      // 关闭或切换目标后，旧的异步创建任务不可再挂载到页面。
      if (this.popup !== popup) return
      popup.style.cssText = styles

      // 添加事件监听
      this.addEventListeners()
      
      document.body.appendChild(this.popup)
    }
    
    // 添加动画效果
    if (this.popup) this.popup.dataset.liveTranslateUi = options.reading ? 'reading' : 'writing'
    this.fitViewport()
    this.animateIn()
  }

  /**
   * 创建双语翻译结果悬浮窗（Story 2.0功能）
   * @param originalText 原文本
   * @param translatedText 翻译文本
   * @param targetElement 目标输入元素
   * @param actions 关闭和替换回调，由内容脚本统一校验
   */
  async createBilingual(originalText: string, translatedText: string, targetElement: PopupAnchor, actions: BilingualActions): Promise<void> {
    // 检查是否是同一个目标元素，避免不必要的remove
    const isSameTarget = this.currentTarget === targetElement
    
    if (!isSameTarget) {
      this.remove()
    }
    
    this.currentTarget = targetElement
    this.actions = actions
    this.prepareAction = undefined
    this.retryAction = undefined
    
    // 如果已有弹框且是同一目标，则更新内容
    if (isSameTarget && this.popup) {
      this.popup.setAttribute('aria-label', 'LiveTranslate 翻译结果')
      this.popup.innerHTML = this.createBilingualHTML(originalText, translatedText, actions)
      this.addEventListeners()
    } else {
      // 创建新弹框
      this.popup = document.createElement('div')
      this.popup.className = 'live-translate-enhanced-popup theme-light'
      this.popup.setAttribute('role', 'region')
      this.popup.setAttribute('aria-label', 'LiveTranslate 翻译结果')
      this.popup.innerHTML = this.createBilingualHTML(originalText, translatedText, actions)

      // 添加增强样式
      this.addEnhancedStyles()
      
      // 定位悬浮窗
      const position = this.calculateSmartPosition(targetElement)
      const popup = this.popup
      const styles = await this.getPopupStyles(position)
      if (this.popup !== popup) return
      popup.style.cssText = styles

      // 添加事件监听
      this.addEventListeners()
      
      document.body.appendChild(this.popup)
    }
    
    // 添加动画效果
    if (this.popup) this.popup.dataset.liveTranslateUi = actions.targetLanguage === 'zh' ? 'reading' : 'writing'
    this.fitViewport()
    this.animateIn()
  }

  /** 阅读只展示译文，位置跟随当前选区，不读取或保存写作浮窗的位置。 */
  async createReadingTranslation(translatedText: string, target: Range, options: { onClose?: () => void } = {}): Promise<void> {
    this.createReadingPopup(`
      <div class="reading-content">
        <div class="translated-text reading-translation" lang="zh" role="status" aria-live="polite" tabindex="0" aria-label="中文译文">${this.escapeHtml(translatedText)}</div>
        <div class="reading-tools">
          <button type="button" class="reading-icon action-copy" title="复制译文" aria-label="复制译文">${this.createCopyIcon()}</button>
          ${this.createReadingCloseHTML()}
        </div>
      </div>
      <div class="reading-feedback" role="status" aria-live="polite" hidden></div>
    `, target, options.onClose || (() => {}))
    this.addEventListeners()
  }

  private createReadingCloseHTML(): string {
    return '<button type="button" class="reading-icon header-close" title="关闭（Esc）" aria-label="关闭翻译浮窗"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15"/></svg></button>'
  }

  private createCopyIcon(): string {
    return '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="7" y="7" width="9" height="10" rx="1.5"/><path d="M12 7V4.5A1.5 1.5 0 0 0 10.5 3h-6A1.5 1.5 0 0 0 3 4.5v7A1.5 1.5 0 0 0 4.5 13H7"/></svg>'
  }

  private createReadingStatusHTML(text: string, options: StatusOptions): string {
    return `
      <div class="reading-content">
        <div class="preview-text reading-status" role="status" aria-live="polite">${this.escapeHtml(text)}</div>
        <div class="reading-tools">${this.createReadingCloseHTML()}</div>
      </div>
      ${options.onPrepare || options.onRetry ? `<div class="reading-followup">
        ${options.onPrepare ? '<button type="button" class="action-btn action-prepare">准备英译中</button>' : ''}
        ${options.onRetry ? '<button type="button" class="action-btn action-retry">重试</button>' : ''}
      </div>` : ''}
    `
  }

  private createReadingPopup(html: string, target: PopupAnchor, onClose: () => void): void {
    this.remove()
    this.currentTarget = target
    this.actions = { onClose }
    const popup = document.createElement('div')
    popup.className = 'live-translate-enhanced-popup theme-light reading-popup'
    popup.dataset.liveTranslateUi = 'reading'
    popup.setAttribute('role', 'region')
    popup.setAttribute('aria-label', 'LiveTranslate 英译中')
    popup.innerHTML = html
    popup.style.cssText = `position: fixed; z-index: 10000; width: 320px;
      font-family: "PingFang SC", "Microsoft YaHei", -apple-system, BlinkMacSystemFont, sans-serif;
      font-size: 14px; line-height: 1.6; border-radius: 10px; overflow: hidden;
      box-shadow: 0 8px 24px rgba(60, 78, 112, 0.16), 0 1px 3px rgba(60, 78, 112, 0.08);
      transition: opacity 160ms ease, transform 160ms ease;`
    this.popup = popup
    this.addEnhancedStyles()
    document.body.appendChild(popup)
    const rect = target.getBoundingClientRect()
    const below = rect.bottom + 8
    const above = rect.top - popup.offsetHeight - 8
    popup.style.top = `${below + popup.offsetHeight <= window.innerHeight - 8 || above < 8 ? below : above}px`
    popup.style.left = `${rect.left}px`
    this.fitViewport()
    this.animateIn()
  }

  /** 整段译文可能比加载状态高，更新后仍让确认按钮留在视口内。 */
  private fitViewport(): void {
    if (!this.popup?.isConnected) return
    // offsetHeight/Width 不受入场缩放影响，避免把动画中的小尺寸当作最终尺寸。
    const top = Number.parseFloat(this.popup.style.top) || 0
    const left = Number.parseFloat(this.popup.style.left) || 0
    this.popup.style.top = `${Math.max(8, Math.min(top, window.innerHeight - this.popup.offsetHeight - 8))}px`
    this.popup.style.left = `${Math.max(8, Math.min(left, window.innerWidth - this.popup.offsetWidth - 8))}px`
  }

  /** 仅请求开始后显示加载或错误状态，不提供替换按钮。 */
  private createStatusHTML(text: string, options: StatusOptions): string {
    return `
      <div class="popup-header draggable-handle">
        <div class="brand">
          ${this.createBrandIcon()}
          <span class="brand-name">LiveTranslate</span>
        </div>
        <button type="button" class="header-close" title="关闭（Esc）" aria-label="关闭翻译浮窗">×</button>
      </div>
      
      <div class="popup-content">
        <div class="preview-section">
          <div class="preview-header">
            <span class="preview-label">翻译状态</span>
          </div>
          <div class="preview-text" role="status" aria-live="polite">${this.escapeHtml(text)}</div>
        </div>
        
        <div class="popup-actions">
          <span class="action-hint">${options.reading ? '网页原文保持不变' : '原稿保持不变'}</span>
          ${options.onPrepare ? '<button type="button" class="action-btn action-prepare">准备英译中</button>' : ''}
          <button type="button" class="action-btn action-close" title="关闭">关闭</button>
        </div>
      </div>
    `
  }

  /** 句隙标志内联展示，不依赖宿主网页字体或外部图片。 */
  private createBrandIcon(): string {
    return `<svg class="brand-icon" data-brand-mark width="22" height="22" viewBox="0 0 64 64" fill="currentColor" aria-hidden="true"><path d="M12 9h31c7.73 0 14 6.27 14 14v1H40c-6.63 0-12 3.63-12 9H17v-8a5 5 0 0 0-5-5H7v-6a5 5 0 0 1 5-5Z"/><path d="M36 32h11v7a5 5 0 0 0 5 5h5v6a5 5 0 0 1-5 5H21c-7.73 0-14-6.27-14-14v-1h17c6.63 0 12-2.63 12-8Z"/></svg>`
  }

  /**
   * 创建双语翻译结果HTML结构（Story 2.0功能）
   * @param originalText 原文本
   * @param translatedText 翻译文本
   */
  private createBilingualHTML(originalText: string, translatedText: string, actions: BilingualActions): string {
    return `
      <div class="popup-header draggable-handle">
        <div class="brand">
          ${this.createBrandIcon()}
          <span class="brand-name">LiveTranslate</span>
        </div>
        <button type="button" class="header-close" title="关闭（Esc）" aria-label="关闭翻译浮窗">×</button>
      </div>
      
      <div class="popup-content">
        ${actions.notice ? `<div class="replacement-notice" role="status">${this.escapeHtml(actions.notice)}</div>` : ''}
        <div class="bilingual-section">
          <div class="original-text-section">
            <div class="text-header">
              <span class="text-label">原文</span>
            </div>
            <div class="original-text">${this.escapeHtml(originalText)}</div>
          </div>
          
          <div class="translated-text-section">
            <div class="text-header">
              <span class="text-label">${actions.targetLanguage === 'zh' ? '中文译文' : '英文译文'}</span>
            </div>
            <div class="translated-text" lang="${actions.targetLanguage || 'en'}" role="status" aria-live="polite">${this.escapeHtml(translatedText)}</div>
          </div>
        </div>
        
        <div class="popup-actions">
          ${actions.onReplace ? `<button type="button" class="action-btn action-replace" title="替换原文（Tab键）">
            替换原文 <kbd>Tab</kbd>
          </button>` : ''}
          <button type="button" class="action-btn action-copy" title="复制译文" aria-live="polite">复制译文</button>
          ${actions.copyOriginal ? '<button type="button" class="action-btn action-copy-original" title="复制替换前的原始草稿" aria-live="polite">复制原草稿</button>' : ''}
        </div>
      </div>
    `
  }

  /**
   * 计算智能定位，确保不遮挡输入框
   * 使用固定偏移量，避免飘来飘去
   */
  private calculateSmartPosition(targetElement: PopupAnchor): PopupPosition {
    const rect = targetElement.getBoundingClientRect()
    const popupHeight = 180 // 增强版高度
    const popupWidth = 360 // 与实际浮窗宽度一致
    
    let top: number
    let left: number | undefined
    let placement: 'top' | 'bottom' = 'bottom'
    
    // 获取视口尺寸
    const viewport = {
      width: window.innerWidth,
      height: window.innerHeight
    }
    
    // 计算输入框中心点
    const centerX = rect.left + rect.width / 2
    
    // 计算可用空间
    const spaceBelow = viewport.height - rect.bottom
    const spaceAbove = rect.top
    const spaceRight = viewport.width - rect.right
    const spaceLeft = rect.left
    
    // 默认策略：优先在下方，保持固定距离
    const offsetY = 12 // 固定垂直间距
    
    if (spaceBelow >= popupHeight + offsetY) {
      // 放在输入框下方
      top = rect.bottom + offsetY
      placement = 'bottom'
    } else if (spaceAbove >= popupHeight + offsetY) {
      // 放在输入框上方
      top = rect.top - popupHeight - offsetY
      placement = 'top'
    } else {
      // 空间不足，放在输入框右侧
      if (spaceRight >= popupWidth + 12) {
        top = rect.top
        left = rect.right + 12
        placement = 'bottom'
      } else if (spaceLeft >= popupWidth + 12) {
        top = rect.top
        left = rect.left - popupWidth - 12
        placement = 'bottom'
      } else {
        // 最后选择：放在输入框下方，但确保可见
        top = Math.min(rect.bottom + 8, viewport.height - popupHeight - 8)
        placement = 'bottom'
      }
    }
    
    // 计算水平位置：尽量与输入框左侧对齐
    if (typeof left === 'undefined') {
      left = Math.max(8, centerX - popupWidth / 2)
      left = Math.min(left, viewport.width - popupWidth - 8)
    }
    
    // 确保不会遮挡输入框
    const minDistance = 8 // 最小安全距离
    if (placement === 'bottom' && top < rect.bottom + minDistance) {
      top = rect.bottom + minDistance
    } else if (placement === 'top' && top + popupHeight > rect.top - minDistance) {
      top = rect.top - popupHeight - minDistance
    }
    
    return { top, left, placement }
  }

  /**
   * 获取悬浮窗样式
   */
  private async getPopupStyles(position: PopupPosition): Promise<string> {
    // 检查是否有保存的位置偏移
    const offset = await this.loadPositionOffset()
    
    return `
      position: fixed;
      top: ${position.top + (offset?.y || 0)}px;
      left: ${position.left + (offset?.x || 0)}px;
      z-index: 10000;
      width: 360px;
      font-family: "PingFang SC", "Microsoft YaHei", -apple-system, BlinkMacSystemFont, sans-serif;
      font-size: 14px;
      line-height: 1.6;
      border-radius: 12px;
      box-shadow: 0 14px 34px -10px rgba(60, 78, 112, 0.24), 0 1px 3px rgba(60, 78, 112, 0.08);
      overflow: hidden;
      transition: opacity 160ms ease, transform 160ms ease;
    `
  }

  /** 样式全部限定于浮窗，避免影响宿主网页。 */
  private addEnhancedStyles(): void {
    if (document.getElementById('live-translate-enhanced-styles')) return

    const style = document.createElement('style')
    style.id = 'live-translate-enhanced-styles'
    style.textContent = `
      .live-translate-enhanced-popup {
        --lt-paper: #ffffff;
        --lt-wash: #f5f7fa;
        --lt-ink: #18253d;
        --lt-muted: #59677d;
        --lt-accent: #3158bd;
        --lt-on-accent: #3158bd;
        --lt-action: #edf2ff;
        --lt-action-line: #c9d5f5;
        --lt-line: #dce2ec;
        --lt-notice: #faf1d9;
        --lt-notice-ink: #684b0d;
        color-scheme: light;
        background: var(--lt-paper);
        color: var(--lt-ink);
        border: 1px solid var(--lt-line);
        box-sizing: border-box;
        text-align: left;
        letter-spacing: normal;
        user-select: none;
        max-width: calc(100vw - 16px);
        max-height: calc(100vh - 16px);
        display: flex;
        flex-direction: column;
        isolation: isolate;
      }

      .live-translate-enhanced-popup *,
      .live-translate-enhanced-popup *::before,
      .live-translate-enhanced-popup *::after { box-sizing: border-box; }
      .live-translate-enhanced-popup .popup-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 10px 12px 10px 16px;
        flex-shrink: 0;
        background: var(--lt-wash);
        cursor: grab;
      }
      .live-translate-enhanced-popup.dragging,
      .live-translate-enhanced-popup .draggable-handle:active { cursor: grabbing; }
      .live-translate-enhanced-popup.dragging { transition: none; z-index: 10001; }
      .live-translate-enhanced-popup .brand { display: flex; align-items: center; gap: 8px; }
      .live-translate-enhanced-popup .brand-icon { width: 22px; height: 22px; color: var(--lt-accent); flex-shrink: 0; }
      .live-translate-enhanced-popup .brand-icon,
      .live-translate-enhanced-popup .brand-icon path { fill: currentColor; stroke: none; }
      .live-translate-enhanced-popup .brand-name { font-size: 14px; font-weight: 650; color: var(--lt-ink); }
      .live-translate-enhanced-popup button {
        font: inherit;
        text-transform: none;
        letter-spacing: normal;
        cursor: pointer;
        margin: 0;
        transition: background-color 160ms ease, opacity 160ms ease;
      }
      .live-translate-enhanced-popup button:focus-visible {
        outline: 2px solid var(--lt-accent);
        outline-offset: 3px;
      }
      .live-translate-enhanced-popup .header-close {
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
        width: 32px;
        height: 32px;
        padding: 0;
        border: 0;
        border-radius: 8px;
        color: var(--lt-muted);
        background: transparent;
        font-size: 22px;
        line-height: 1;
      }
      .live-translate-enhanced-popup .header-close:hover { color: var(--lt-ink); background: var(--lt-paper); }
      .live-translate-enhanced-popup .popup-content {
        display: flex;
        flex-direction: column;
        gap: 16px;
        padding: 16px;
        min-height: 0;
        overflow: auto;
      }
      .live-translate-enhanced-popup .bilingual-section,
      .live-translate-enhanced-popup .preview-section { min-height: 0; overflow: auto; }
      .live-translate-enhanced-popup .original-text-section { margin-bottom: 18px; }
      .live-translate-enhanced-popup .text-header,
      .live-translate-enhanced-popup .preview-header { margin-bottom: 6px; }
      .live-translate-enhanced-popup .text-label,
      .live-translate-enhanced-popup .preview-label { color: var(--lt-muted); font-size: 12px; font-weight: 600; }
      .live-translate-enhanced-popup .original-text,
      .live-translate-enhanced-popup .translated-text {
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        max-height: 25vh;
        overflow: auto;
        user-select: text;
        line-height: 1.65;
      }
      .live-translate-enhanced-popup .original-text { color: var(--lt-muted); font-size: 13px; }
      .live-translate-enhanced-popup .translated-text { color: var(--lt-ink); font-size: 17px; font-weight: 450; }
      .live-translate-enhanced-popup .preview-text { color: var(--lt-ink); font-size: 14px; overflow-wrap: anywhere; }
      .live-translate-enhanced-popup .replacement-notice {
        padding: 10px 12px;
        border-radius: 8px;
        font-size: 13px;
        line-height: 1.6;
        background: var(--lt-notice);
        color: var(--lt-notice-ink);
        flex-shrink: 0;
      }
      .live-translate-enhanced-popup .popup-actions {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 8px;
        flex-shrink: 0;
        padding: 2px;
      }
      .live-translate-enhanced-popup .action-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
        flex: 1 1 auto;
        min-height: 40px;
        padding: 8px 12px;
        border: 1px solid var(--lt-line);
        border-radius: 8px;
        background: var(--lt-paper);
        color: var(--lt-ink);
        font-size: 13px;
        line-height: 1.5;
        font-weight: 600;
      }
      .live-translate-enhanced-popup .action-btn:hover { background: var(--lt-wash); }
      .live-translate-enhanced-popup .action-btn:active { opacity: .75; }
      .live-translate-enhanced-popup .action-replace {
        color: var(--lt-on-accent);
        background: var(--lt-action);
        border-color: var(--lt-action-line);
      }
      .live-translate-enhanced-popup .action-replace:hover { background: var(--lt-action); opacity: .82; }
      .live-translate-enhanced-popup .action-copy-original { flex-basis: 100%; }
      .live-translate-enhanced-popup kbd {
        font: inherit;
        font-size: 11px;
        padding: 0 4px;
        border: 1px solid currentColor;
        border-radius: 4px;
        opacity: .85;
      }
      .live-translate-enhanced-popup .action-hint { flex: 1; color: var(--lt-muted); font-size: 12px; }
      .live-translate-enhanced-popup .action-close { flex: 0 0 auto; }
      .live-translate-enhanced-popup.reading-popup { padding: 10px 10px 10px 14px; gap: 6px; }
      .live-translate-enhanced-popup .reading-content { display: flex; align-items: flex-start; gap: 8px; min-height: 0; }
      .live-translate-enhanced-popup .reading-translation,
      .live-translate-enhanced-popup .reading-status { flex: 1; min-width: 0; min-height: 0; }
      .live-translate-enhanced-popup .reading-translation {
        max-height: min(50vh, calc(100vh - 68px));
        font-size: 16px;
        font-weight: 400;
        padding: 3px 0;
        overscroll-behavior: contain;
      }
      .live-translate-enhanced-popup .reading-translation:focus-visible { outline: 2px solid var(--lt-accent); outline-offset: -2px; border-radius: 3px; }
      .live-translate-enhanced-popup .reading-status { padding: 3px 0; white-space: pre-wrap; max-height: calc(100vh - 100px); overflow: auto; user-select: text; }
      .live-translate-enhanced-popup .reading-tools { display: flex; gap: 2px; flex: 0 0 auto; }
      .live-translate-enhanced-popup .reading-icon {
        display: inline-flex; align-items: center; justify-content: center; flex: 0 0 auto;
        width: 28px; height: 28px; padding: 5px; border: 0; border-radius: 6px;
        background: transparent; color: var(--lt-muted); line-height: 1;
      }
      .live-translate-enhanced-popup .reading-icon:hover { color: var(--lt-ink); background: var(--lt-wash); }
      .live-translate-enhanced-popup .reading-icon:active { opacity: .7; }
      .live-translate-enhanced-popup .reading-icon:disabled { cursor: wait; opacity: .55; }
      .live-translate-enhanced-popup .reading-icon svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
      .live-translate-enhanced-popup .reading-feedback { color: var(--lt-muted); font-size: 12px; line-height: 1.5; overflow-wrap: anywhere; }
      .live-translate-enhanced-popup .reading-feedback[hidden] { display: none; }
      .live-translate-enhanced-popup .reading-feedback[data-error="true"] { color: #8c361f; }
      .live-translate-enhanced-popup .reading-followup { display: flex; flex-wrap: wrap; gap: 6px; }
      .live-translate-enhanced-popup .reading-followup .action-btn { min-height: 28px; flex: 0 1 auto; padding: 3px 9px; font-size: 12px; font-weight: 500; }
      @media (prefers-reduced-motion: reduce) {
        .live-translate-enhanced-popup,
        .live-translate-enhanced-popup * { transition: none !important; animation: none !important; }
      }
    `
    document.head.appendChild(style)
  }

  /**
   * 添加事件监听器
   */
  private addEventListeners(): void {
    if (!this.popup) return
    this.cleanupPopupEvents?.()

    // 关闭按钮
    const closeBtn = this.popup.querySelector('.header-close')
    closeBtn?.addEventListener('click', () => this.dismiss())

    // 关闭动作按钮
    const closeActionBtn = this.popup.querySelector('.action-close')
    closeActionBtn?.addEventListener('click', () => this.dismiss())

    const prepareBtn = this.popup.querySelector<HTMLButtonElement>('.action-prepare')
    const prepare = this.prepareAction
    prepareBtn?.addEventListener('click', async () => {
      if (!prepare || prepareBtn.disabled) return
      prepareBtn.disabled = true
      try { await prepare() }
      catch {
        if (this.prepareAction === prepare) {
          const status = this.popup?.querySelector('.preview-text')
          if (status) status.textContent = '准备页未能打开，请重试，或从工具栏打开“准备英译中”。'
        }
      } finally {
        if (prepareBtn.isConnected) prepareBtn.disabled = false
      }
    })

    const retryBtn = this.popup.querySelector<HTMLButtonElement>('.action-retry')
    const retry = this.retryAction
    retryBtn?.addEventListener('click', async () => {
      if (!retry || retryBtn.disabled) return
      retryBtn.disabled = true
      try { await retry() }
      catch {
        if (this.retryAction === retry) {
          const status = this.popup?.querySelector('.preview-text')
          if (status) status.textContent = '重试未能完成，请检查翻译服务后再试。'
        }
      } finally {
        if (retryBtn.isConnected) retryBtn.disabled = false
      }
    })

    // 替换按钮
    const replaceBtn = this.popup.querySelector('.action-replace')
    // 点击悬浮窗时不要让按钮先夺走编辑器焦点，否则 contenteditable 的
    // 原生选区可能在 click 触发前被折叠，受控编辑器也会丢失当前编辑位置。
    const preserveEditorSelection = (event: Event) => {
      event.preventDefault()
    }
    replaceBtn?.addEventListener('mousedown', preserveEditorSelection)
    replaceBtn?.addEventListener('click', () => {
      this.handleReplace()
    })

    // 复制按钮
    const copyBtn = this.popup.querySelector('.action-copy')
    copyBtn?.addEventListener('click', () => {
      this.handleCopy()
    })
    this.popup.querySelector('.action-copy-original')?.addEventListener('click', () => {
      void this.handleCopy(true)
    })

    // 添加拖拽功能
    this.addDragFunctionality()

    // ESC键关闭
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        this.dismiss()
        document.removeEventListener('keydown', handleEscape)
      }
    }
    document.addEventListener('keydown', handleEscape)

    // 点击外部关闭
    const handleClickOutside = (e: MouseEvent) => {
      if (this.popup && !this.popup.contains(e.target as Node)) {
        if (this.currentTarget && 'contains' in this.currentTarget && this.currentTarget.contains(e.target as Node)) {
          return
        }
        this.dismiss()
        document.removeEventListener('click', handleClickOutside)
      }
    }
    
    const outsideTimer = setTimeout(() => {
      document.addEventListener('click', handleClickOutside)
    }, 100)
    this.cleanupPopupEvents = () => {
      clearTimeout(outsideTimer)
      document.removeEventListener('keydown', handleEscape)
      document.removeEventListener('click', handleClickOutside)
      replaceBtn?.removeEventListener('mousedown', preserveEditorSelection)
      this.cleanupDragEvents?.()
      this.cleanupDragEvents = undefined
    }
  }

  /**
   * 添加拖拽功能（包含位置记忆）
   */
  private addDragFunctionality(): void {
    if (!this.popup) return

    const handle = this.popup.querySelector('.draggable-handle')
    if (!handle) return

    let isDragging = false
    const dragStart = (e: Event) => {
      if ((e.target as HTMLElement).classList.contains('header-close')) return
      
      isDragging = true
      this.popup?.classList.add('dragging')

    }

    const dragEnd = () => {
      isDragging = false
      this.popup?.classList.remove('dragging')
      
      if (this.popup) {
        // 获取当前绝对位置
        const currentTop = parseInt(this.popup.style.top || '0')
        const currentLeft = parseInt(this.popup.style.left || '0')
        
        // 计算相对于基础位置的偏移
        const basePosition = this.calculateSmartPosition(this.currentTarget!)
        
        // 保存相对于基础位置的偏移
        const offsetX = currentLeft - basePosition.left
        const offsetY = currentTop - basePosition.top
        
        this.savePositionOffset(offsetX, offsetY)
      }
    }

    const drag = (e: Event) => {
      if (!isDragging) return

      e.preventDefault()

      let currentX: number
      let currentY: number

      if (e.type === 'touchmove') {
        const touchEvent = e as TouchEvent
        currentX = touchEvent.touches[0].clientX
        currentY = touchEvent.touches[0].clientY
      } else {
        const mouseEvent = e as MouseEvent
        currentX = mouseEvent.clientX
        currentY = mouseEvent.clientY
      }

      if (this.popup) {
        // 直接使用鼠标/触摸的绝对位置
        this.popup.style.top = `${currentY - (this.popup.offsetHeight / 2)}px`
        this.popup.style.left = `${currentX - (this.popup.offsetWidth / 2)}px`
      }
    }

    // 鼠标事件
    handle.addEventListener('mousedown', dragStart)
    document.addEventListener('mousemove', drag)
    document.addEventListener('mouseup', dragEnd)

    // 触摸事件（支持移动设备）
    handle.addEventListener('touchstart', dragStart, { passive: false })
    document.addEventListener('touchmove', drag)
    document.addEventListener('touchend', dragEnd)

    // 清理事件监听器
    this.cleanupDragEvents = () => {
      handle.removeEventListener('mousedown', dragStart)
      document.removeEventListener('mousemove', drag)
      document.removeEventListener('mouseup', dragEnd)
      handle.removeEventListener('touchstart', dragStart)
      document.removeEventListener('touchmove', drag)
      document.removeEventListener('touchend', dragEnd)
    }
  }

  /**
   * 保存位置偏移到Chrome存储
   */
  private async savePositionOffset(x: number, y: number): Promise<void> {
    try {
      await chrome.runtime.sendMessage({ type: 'SET_POPUP_OFFSET', offset: { x, y } })
    } catch (error) {
      console.log('LiveTranslate: 保存位置偏移失败', error)
    }
  }

  /**
   * 从Chrome存储加载位置偏移
   */
  private async loadPositionOffset(): Promise<{ x: number; y: number } | null> {
    try {
      const result = await chrome.runtime.sendMessage({ type: 'GET_POPUP_OFFSET' })
      return result?.offset || null
    } catch (error) {
      console.log('LiveTranslate: 加载位置偏移失败', error)
      return null
    }
  }

  private cleanupDragEvents?: () => void

  /**
   * 处理替换操作
   */
  private handleReplace(): void {
    this.actions?.onReplace?.()
  }

  private dismiss(): void {
    this.actions?.onClose()
    this.remove()
  }

  /**
   * 处理复制操作
   */
  private async handleCopy(original = false): Promise<void> {
    if (!original && this.popup?.classList.contains('reading-popup')) {
      await this.handleReadingCopy()
      return
    }
    const translatedText = original ? this.popup?.querySelector('.original-text')?.textContent : this.getTranslatedText()
    if (!translatedText) return
    const copyBtn = this.popup?.querySelector(original ? '.action-copy-original' : '.action-copy')
    const originalText = copyBtn?.innerHTML
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable')
      await navigator.clipboard.writeText(translatedText)
      if (copyBtn) copyBtn.innerHTML = '<span class="btn-icon">✓</span> 已复制'
    } catch {
      if (copyBtn) copyBtn.innerHTML = '<span class="btn-icon">!</span> 复制失败'
    }
    if (copyBtn && originalText) {
      window.setTimeout(() => {
        if (copyBtn.isConnected) copyBtn.innerHTML = originalText
      }, 1500)
    }
  }

  /** 阅读图标保持小尺寸，反馈单独显示，失败时保留可手动选择的译文。 */
  private async handleReadingCopy(): Promise<void> {
    const popup = this.popup
    const translatedText = this.getTranslatedText()
    const button = popup?.querySelector<HTMLButtonElement>('.action-copy')
    const feedback = popup?.querySelector<HTMLElement>('.reading-feedback')
    if (!popup || !translatedText || !button || !feedback || button.disabled) return
    button.disabled = true
    let copied = false
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable')
      await navigator.clipboard.writeText(translatedText)
      copied = true
    } catch {
      copied = false
    }
    if (this.popup !== popup) return
    button.disabled = false
    feedback.hidden = false
    feedback.dataset.error = String(!copied)
    feedback.textContent = copied ? '已复制' : '复制失败，请选中译文手动复制。'
    button.innerHTML = copied ? '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m4 10 4 4 8-8"/></svg>' : this.createCopyIcon()
    this.fitViewport()
    if (copied) window.setTimeout(() => {
      if (this.popup !== popup || feedback.dataset.error !== 'false') return
      feedback.hidden = true
      button.innerHTML = this.createCopyIcon()
    }, 1500)
  }

  /**
   * 动画效果
   */
  private animateIn(): void {
    const popup = this.popup
    if (popup) {
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        popup.style.opacity = '1'
        popup.style.transform = 'none'
        return
      }
      popup.style.opacity = '0'
      popup.style.transform = 'translateY(4px)'
      
      requestAnimationFrame(() => {
        if (this.popup === popup) {
          popup.style.opacity = '1'
          popup.style.transform = 'translateY(0) scale(1)'
        }
      })
    }
  }

  /**
   * 移除悬浮窗
   */
  remove(): void {
    this.cleanupPopupEvents?.()
    this.cleanupPopupEvents = undefined
    // 同步释放引用并移除节点，避免旧淡出定时器误删新弹框或异步创建复活。
    this.popup?.remove()
    this.popup = null
    this.currentTarget = null
    this.actions = null
    this.prepareAction = undefined
    this.retryAction = undefined
  }

  /**
   * 获取当前目标元素
   */
  getCurrentTarget(): PopupAnchor | null {
    return this.currentTarget
  }

  /**
   * 获取翻译文本（用于Tab键替换）
   */
  getTranslatedText(): string | null {
    if (!this.popup) return null
    
    const translatedTextElement = this.popup.querySelector('.translated-text')
    return translatedTextElement?.textContent || null
  }

  /**
   * HTML转义
   */
  private escapeHtml(text: string): string {
    const div = document.createElement('div')
    div.textContent = text
    return div.innerHTML
  }
}
