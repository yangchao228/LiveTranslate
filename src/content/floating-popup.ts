import { PopupPosition } from '../shared/types'
import { InputDetector } from './input-detector'

/**
 * 悬浮窗管理器 - 创建和管理翻译结果悬浮窗
 */
export class FloatingPopup {
  private static instance: FloatingPopup
  private popup: HTMLElement | null = null
  private currentTarget: HTMLElement | null = null

  /**
   * 获取单例实例
   */
  static getInstance(): FloatingPopup {
    if (!this.instance) {
      this.instance = new FloatingPopup()
    }
    return this.instance
  }

  /**
   * 创建悬浮窗
   * @param text 翻译文本
   * @param targetElement 目标输入元素
   */
  create(text: string, targetElement: HTMLElement): void {
    this.remove()
    
    this.currentTarget = targetElement
    this.popup = document.createElement('div')
    this.popup.className = 'live-translate-popup'
    this.popup.innerHTML = `
      <div class="translate-content">
        <div class="translate-text">${this.escapeHtml(text)}</div>
        <div class="translate-actions">
          <button class="replace-btn" title="替换原文">替换</button>
          <button class="close-btn" title="关闭">×</button>
        </div>
      </div>
    `

    // 添加样式
    this.addStyles()
    
    // 定位悬浮窗
    const position = this.calculatePosition(targetElement)
    this.popup.style.cssText = `
      position: fixed;
      top: ${position.top}px;
      left: ${position.left}px;
      z-index: 10000;
      background: white;
      border: 1px solid #ddd;
      border-radius: 8px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.15);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 14px;
      line-height: 1.4;
      max-width: 300px;
      min-width: 200px;
    `

    // 添加事件监听
    this.addEventListeners()
    
    document.body.appendChild(this.popup)
  }

  /**
   * 移除悬浮窗
   */
  remove(): void {
    if (this.popup) {
      this.popup.remove()
      this.popup = null
      this.currentTarget = null
    }
  }

  /**
   * 计算悬浮窗位置
   * @param targetElement 目标元素
   * @returns 位置信息
   */
  private calculatePosition(targetElement: HTMLElement): PopupPosition {
    const rect = targetElement.getBoundingClientRect()
    const popupHeight = 80 // 预估高度
    const popupWidth = 250 // 预估宽度
    
    let top: number
    let left: number
    let placement: 'top' | 'bottom' = 'bottom'
    
    // 计算水平位置（居中或左对齐）
    const centerX = rect.left + rect.width / 2
    left = Math.max(10, centerX - popupWidth / 2)
    left = Math.min(left, window.innerWidth - popupWidth - 10)
    
    // 计算垂直位置（优先下方，空间不足则上方）
    const spaceBelow = window.innerHeight - rect.bottom
    if (spaceBelow >= popupHeight + 10) {
      top = rect.bottom + 5
      placement = 'bottom'
    } else {
      top = rect.top - popupHeight - 5
      placement = 'top'
    }
    
    // 确保在视口内
    top = Math.max(10, top)
    top = Math.min(top, window.innerHeight - popupHeight - 10)
    
    return { top, left, placement }
  }

  /**
   * 添加事件监听器
   */
  private addEventListeners(): void {
    if (!this.popup) return

    // 关闭按钮
    const closeBtn = this.popup.querySelector('.close-btn')
    closeBtn?.addEventListener('click', () => this.remove())

    // 替换按钮
    const replaceBtn = this.popup.querySelector('.replace-btn')
    replaceBtn?.addEventListener('click', () => {
      this.handleReplace()
    })

    // ESC键关闭
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        this.remove()
        document.removeEventListener('keydown', handleEscape)
      }
    }
    document.addEventListener('keydown', handleEscape)

    // 点击外部关闭
    const handleClickOutside = (e: MouseEvent) => {
      if (this.popup && !this.popup.contains(e.target as Node)) {
        // 检查是否点击了目标输入框
        if (this.currentTarget && this.currentTarget.contains(e.target as Node)) {
          return // 点击输入框不关闭
        }
        this.remove()
        document.removeEventListener('click', handleClickOutside)
      }
    }
    
    // 延迟添加事件监听，避免立即触发
    setTimeout(() => {
      document.addEventListener('click', handleClickOutside)
    }, 100)
  }

  /**
   * 处理替换操作
   */
  private handleReplace(): void {
    if (this.currentTarget) {
      const translatedText = this.popup?.querySelector('.translate-text')?.textContent
      if (translatedText) {
        // 直接替换文本
        InputDetector.setElementValue(this.currentTarget, translatedText)
        this.remove()
      }
    }
  }

  /**
   * 添加悬浮窗样式
   */
  private addStyles(): void {
    if (document.getElementById('live-translate-styles')) return

    const style = document.createElement('style')
    style.id = 'live-translate-styles'
    style.textContent = `
      .live-translate-popup {
        animation: slideIn 0.2s ease-out;
      }
      
      .live-translate-popup .translate-content {
        padding: 12px;
      }
      
      .live-translate-popup .translate-text {
        margin-bottom: 8px;
        color: #333;
        word-wrap: break-word;
      }
      
      .live-translate-popup .translate-actions {
        display: flex;
        gap: 8px;
        justify-content: flex-end;
      }
      
      .live-translate-popup button {
        padding: 4px 8px;
        border: 1px solid #ddd;
        border-radius: 4px;
        background: white;
        cursor: pointer;
        font-size: 12px;
      }
      
      .live-translate-popup button:hover {
        background: #f5f5f5;
      }
      
      .live-translate-popup .replace-btn {
        background: #007bff;
        color: white;
        border-color: #007bff;
      }
      
      .live-translate-popup .replace-btn:hover {
        background: #0056b3;
      }
      
      @keyframes slideIn {
        from {
          opacity: 0;
          transform: translateY(-10px);
        }
        to {
          opacity: 1;
          transform: translateY(0);
        }
      }
    `
    document.head.appendChild(style)
  }

  /**
   * HTML转义
   * @param text 原始文本
   * @returns 转义后的文本
   */
  private escapeHtml(text: string): string {
    const div = document.createElement('div')
    div.textContent = text
    return div.innerHTML
  }
  
  /**
   * 获取当前目标元素
   * @returns 当前目标元素或null
   */
  getCurrentTarget(): HTMLElement | null {
    return this.currentTarget
  }
}