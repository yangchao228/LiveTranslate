/** 原文区间统一使用 UTF-16 偏移，end 为不包含的右边界。 */
export interface TextRange {
  start: number
  end: number
  text: string
}

export interface SourceSnapshot extends TextRange {
  prefix: string
}

const TERMINAL = /[。？！?!]/u
const CLOSER = /[”’"'）)\]】}」』》〉]/u

/** URL 路径/查询和邮箱属于同一 ASCII token，不把其中的点误作句界。 */
function isAddressPunctuation(text: string, index: number): boolean {
  const before = text.slice(0, index).match(/[a-z\d@:/?#%&=+_$~.!-]+$/i)?.[0] || ''
  const after = text.slice(index + 1).match(/^[a-z\d@:/?#%&=+_$~.!-]+/i)?.[0] || ''
  const token = before + text[index] + after
  return /^(?:https?:\/\/|www\.)/i.test(token) || token.includes('@') ||
    /^(?:[a-z\d-]+\.)+[a-z]{2,}(?:[/:?#].*)?\.?$/i.test(token)
}

/** 数字及尚未写完的拉丁词尾点保守等待，避免输入域名/邮箱到一半就触发。 */
function isTerminal(text: string, index: number): boolean {
  const char = text[index]
  if (/[.?!]/.test(char) && isAddressPunctuation(text, index)) return false
  if (TERMINAL.test(char)) return true
  if (char !== '.') return false
  const previous = text[index - 1] || ''
  const next = text[index + 1] || ''
  if (/[a-z\d]/i.test(previous) && /[a-z\d]/i.test(next)) return false
  if (/\d/.test(previous)) return false
  if (/[a-z]/i.test(previous) && !next) return false
  // 正在输入省略号时，统一由最后一个点收尾。
  return next !== '.'
}

/** 从编辑位置取所在的已完成句；若正输入下一句，则取最近完成句。 */
export function completedSentence(text: string, caret: number): TextRange | null {
  const position = Math.max(0, Math.min(caret, text.length))
  let start = 0
  let latest: TextRange | null = null
  for (let i = 0; i < text.length; i++) {
    if (!isTerminal(text, i)) continue
    let end = i + 1
    while (end < text.length && (/[。？！?!.]/u.test(text[end]) || CLOSER.test(text[end]))) end++
    // 只跳过前导空白，始终以原文本偏移切片，保留前后文。
    while (start < end && /\s/u.test(text[start])) start++
    const range = { start, end, text: text.slice(start, end) }
    if (position > start) latest = range
    if (end >= position) break
    start = end
    i = end - 1
  }
  return latest
}

/** 仅当前编辑触及的句子才创建新候选，避免追译历史句。 */
export function editedSentence(text: string, previous: string, caret: number): TextRange | null {
  if (text === previous) return null
  let start = 0
  while (start < text.length && start < previous.length && text[start] === previous[start]) start++
  let newEnd = text.length
  let oldEnd = previous.length
  while (newEnd > start && oldEnd > start && text[newEnd - 1] === previous[oldEnd - 1]) {
    newEnd--
    oldEnd--
  }
  // 删除句首字符时，光标恰好落在该句起点，仍按剩余句子判断。
  const range = completedSentence(text, Math.max(caret, Math.min(start + 1, text.length)))
  if (!range || !/\p{Script=Han}/u.test(range.text)) return null
  // 纯删除也会触及所在句；句后追加半句不重新触发历史句。
  return start < range.end && newEnd >= range.start ? range : null
}

export function manualRange(text: string, start: number, end: number): TextRange | null {
  const from = Math.max(0, Math.min(start, end, text.length))
  const to = Math.max(from, Math.min(Math.max(start, end), text.length))
  const range = from === to ? { start: 0, end: text.length, text } : { start: from, end: to, text: text.slice(from, to) }
  return /[\p{L}\p{N}]/u.test(range.text) ? range : null
}

export function snapshot(text: string, range: TextRange): SourceSnapshot {
  return { ...range, prefix: text.slice(0, range.start) }
}

/** 允许句后追加；前方编辑、原句修改/删除均使旧偏移失效。 */
export function matchesSnapshot(text: string, source: SourceSnapshot): boolean {
  return text.slice(0, source.start) === source.prefix && text.slice(source.start, source.end) === source.text
}
