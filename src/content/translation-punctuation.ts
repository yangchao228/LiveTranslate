const ENGLISH_PUNCTUATION: Record<string, string> = {
  '，': ',', '。': '.', '？': '?', '！': '!', '；': ';', '：': ':'
}

/**
 * 英文译文保留原文句末标点的类型，避免提供者把陈述句改为问句。
 * 只处理句尾，保留译文内部标点和末尾的引号、括号。
 */
export function preserveEndingPunctuation(
  sourceText: string,
  translatedText: string,
  targetLang = 'en'
): string {
  if (!/^en(?:[-_]|$)/i.test(targetLang) || !translatedText.trim()) {
    return translatedText
  }

  const sourceEnding = sourceText.trimEnd().match(/([，。？！,.?!；：;:…]+)[”’"'）)\]】}」』》〉]*$/u)
  if (!sourceEnding) return translatedText

  const punctuation = sourceEnding[1]
    .replace(/…+/gu, '...')
    .replace(/[，。？！；：]/gu, mark => ENGLISH_PUNCTUATION[mark])
  const translation = translatedText.trimEnd()
  const translatedEnding = translation.match(/([，。？！,.?!；：;:…]*)([”’"'）)\]】}」』》〉]*)$/u)!
  const body = translation.slice(0, translatedEnding.index).trimEnd()

  return body + punctuation + translatedEnding[2]
}
