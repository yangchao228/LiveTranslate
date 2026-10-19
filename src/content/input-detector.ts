import { InputElement } from '../shared/types'

type DOMPoint = { node: Node; offset: number }

/** 输入、选区和光标共用同一份富文本偏移映射，块间换行和 br 均计入。 */
function textLayout(element: HTMLElement) {
  let text = ''
  const points: DOMPoint[] = [{ node: element, offset: 0 }]
  const offsets = new Map<Node, number[]>()
  const append = (value: string, before: DOMPoint, after: DOMPoint) => {
    // 块间的虚拟换行不能覆盖前一文本末尾；否则选区终点会变成
    // 下一段前的父节点边界，原生编辑会连同段落结构一起删除。
    points[text.length] ??= before
    text += value
    points[text.length] = after
  }
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const value = node.textContent || ''
      offsets.set(node, Array.from({ length: value.length + 1 }, (_, i) => text.length + i))
      for (let i = 0; i < value.length; i++) append(value[i], { node, offset: i }, { node, offset: i + 1 })
      return
    }
    if (node instanceof HTMLBRElement) {
      const parent = node.parentNode!
      const index = Array.prototype.indexOf.call(parent.childNodes, node)
      offsets.set(node, [text.length])
      append('\n', { node: parent, offset: index }, { node: parent, offset: index + 1 })
      return
    }
    const boundaries = [text.length]
    offsets.set(node, boundaries)
    Array.from(node.childNodes).forEach((child, index) => {
      if (child instanceof HTMLElement && /^(P|DIV|LI|BLOCKQUOTE|H[1-6])$/.test(child.tagName) && index > 0 && !text.endsWith('\n')) {
        append('\n', { node, offset: index }, { node: child, offset: 0 })
      }
      walk(child)
      boundaries.push(text.length)
    })
  }
  walk(element)
  return { text, points, offsets }
}

export class InputDetector {
  public static readonly SELECTOR = 'input[type="text"], input:not([type]), input[type="search"], textarea, [contenteditable="true"], [contenteditable=""]'

  static getInputElements(): InputElement[] {
    return Array.from(document.querySelectorAll(this.SELECTOR)).filter(this.isValidInput) as InputElement[]
  }

  static isValidInput(element: Element): element is InputElement {
    if (element instanceof HTMLInputElement) return ['text', 'search'].includes(element.type) && !element.disabled && !element.readOnly
    if (element instanceof HTMLTextAreaElement) return !element.disabled && !element.readOnly
    return element instanceof HTMLElement && element.isContentEditable && !element.parentElement?.isContentEditable
  }

  static getElementValue(element: InputElement): string {
    return element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? element.value : textLayout(element).text
  }

  static isFocused(element: InputElement): boolean {
    const active = element.ownerDocument.activeElement
    if (active === element || (active instanceof Node && element.contains(active))) return true
    const root = element.getRootNode()
    return 'activeElement' in root && (root as Document | ShadowRoot).activeElement === element
  }

  static getSelection(element: InputElement): { start: number; end: number } | null {
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      return { start: element.selectionStart ?? 0, end: element.selectionEnd ?? 0 }
    }
    const selection = element.ownerDocument.getSelection()
    if (!selection?.rangeCount || !element.contains(selection.anchorNode) || !element.contains(selection.focusNode)) return null
    const layout = textLayout(element)
    const anchor = layout.offsets.get(selection.anchorNode!)?.[selection.anchorOffset]
    const focus = layout.offsets.get(selection.focusNode!)?.[selection.focusOffset]
    return anchor === undefined || focus === undefined ? null : { start: Math.min(anchor, focus), end: Math.max(anchor, focus) }
  }

  static setElementValue(
    element: InputElement,
    value: string,
    caretPosition = value.length,
    inputData = value
  ): void {
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) this.setNativeValue(element, value)
    else {
      // 富文本用 br 表示真实换行，避免普通 white-space 下后续输入把换行折叠为空格。
      const nodes: Node[] = []
      value.split('\n').forEach((line, index) => {
        if (index) nodes.push(element.ownerDocument.createElement('br'))
        nodes.push(element.ownerDocument.createTextNode(line))
      })
      element.replaceChildren(...nodes)
    }
    const offset = Math.max(0, Math.min(caretPosition, value.length))
    // 编辑器同步重建节点后再次恢复焦点与选区。
    this.setCaretPosition(element, offset)
    // 受控 contenteditable 可能把 InputEvent.data 当作一次新的插入，
    // 在 DOM 已写入完整结果后再次追加译文。普通 input 事件让编辑器从
    // 当前 DOM 读取完整值，原生输入框仍保留 replace 语义供受控组件使用。
    const inputEvent = element instanceof HTMLElement &&
      !(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)
      ? new Event('input', { bubbles: true })
      : typeof InputEvent === 'function'
        ? new InputEvent('input', { bubbles: true, inputType: 'insertReplacementText', data: inputData })
        : new Event('input', { bubbles: true })
    element.dispatchEvent(inputEvent)
    this.setCaretPosition(element, offset)
  }

  /**
   * Lexical 的内部草稿与 DOM 可能异步同步，当前采取保守复制退路。
   * 不尝试直接替换，避免在页面重绘时丢失草稿。
   */
  static replacementRestriction(element: InputElement): string | null {
    return element.closest('[data-lexical-editor="true"]')
      ? '此编辑器使用独立草稿状态，暂不直接替换。原文未改动，请复制译文后自行粘贴。'
      : null
  }

  /** 只恢复本次失败前的快照，不派发另一次编辑事务。 */
  static restoreSnapshot(element: InputElement, text: string, markup: string | undefined, caret: number): void {
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) this.setNativeValue(element, text)
    else if (markup !== undefined) element.innerHTML = markup
    this.setCaretPosition(element, Math.min(caret, text.length))
  }

  /** 富文本只走一次浏览器原生事务，不叠加 Range 写入或延迟重试。 */
  static replaceText(element: InputElement, start: number, end: number, replacement: string): boolean {
    const current = this.getElementValue(element)
    if (this.replacementRestriction(element) || start < 0 || end < start || end > current.length) return false
    const result = current.slice(0, start) + replacement + current.slice(end)
    const caret = start + replacement.length

    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      this.setElementValue(element, result, caret, replacement)
      if (this.getElementValue(element) === result) return true
      this.restoreSnapshot(element, current, undefined, start)
      return false
    }

    const originalMarkup = element.innerHTML
    element.focus({ preventScroll: true })
    const selected = this.selectTextRange(element, start, end)
    if (selected) {
      try {
        // execCommand 让 Chrome 生成原生 input 事务，保留浏览器的撤销历史。
        // insertText 会把多行分别包成 p，在段落编辑器中产生额外空行。
        // 仅转义后的文本和 br 可进入原生 HTML 事务，不接受供应商 HTML。
        const command = replacement.includes('\n') ? 'insertHTML' : 'insertText'
        const data = command === 'insertHTML'
          ? replacement.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>')
          : replacement
        element.ownerDocument.execCommand(command, false, data)
        if (this.getElementValue(element) === result) {
          // input 监听器可能同步重建节点，使浏览器原生选区回到开头。
          this.setCaretPosition(element, caret)
          return true
        }
      } catch {
        // 页面拒绝编辑或浏览器不支持时，保持原文并让调用方提供复制退路。
      }
    }
    if (this.getElementValue(element) !== current) this.restoreSnapshot(element, current, originalMarkup, start)
    return false
  }

  private static setNativeValue(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
    const prototype = Object.getPrototypeOf(element) as HTMLInputElement | HTMLTextAreaElement
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
    if (setter) setter.call(element, value)
    else element.value = value
  }

  private static selectTextRange(element: HTMLElement, start: number, end: number): boolean {
    const layout = textLayout(element)
    const startPoint = layout.points[Math.min(start, layout.text.length)]
    const endPoint = layout.points[Math.min(end, layout.text.length)]
    if (!startPoint || !endPoint) return false
    const selection = element.ownerDocument.getSelection()
    if (!selection) return false
    const range = element.ownerDocument.createRange()
    try {
      range.setStart(startPoint.node, startPoint.offset)
      range.setEnd(endPoint.node, endPoint.offset)
    } catch {
      return false
    }
    selection.removeAllRanges()
    selection.addRange(range)
    return true
  }

  private static setCaretPosition(element: InputElement, offset: number): void {
    element.focus({ preventScroll: true })
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      element.setSelectionRange(offset, offset)
      return
    }
    const selection = element.ownerDocument.getSelection()
    if (!selection) return
    const layout = textLayout(element)
    const point = layout.points[Math.min(offset, layout.text.length)]
    const range = element.ownerDocument.createRange()
    range.setStart(point.node, point.offset)
    range.collapse(true)
    selection.removeAllRanges()
    selection.addRange(range)
  }

  static getElementRect(element: InputElement): DOMRect {
    return element.getBoundingClientRect()
  }
}
