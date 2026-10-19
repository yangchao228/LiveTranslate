import { TranslationRequest, TranslationResponse } from '../shared/types'
import { completedSentence } from './sentence-range'
import { preserveEndingPunctuation } from './translation-punctuation'

/** 本机模型会省略英文长草稿中的短中文；按现有句界拆分，保留换行和纯英文原样。 */
export function browserTranslationSegments(text: string): string[] {
  const segments: string[] = []
  for (let line of text.split(/(\r\n|\r|\n)/u)) {
    while (line) {
      const start = line.search(/\S/u)
      const end = start < 0 ? line.length : completedSentence(line, start + 1)?.end ?? line.length
      segments.push(line.slice(0, end))
      line = line.slice(end)
    }
  }
  return segments
}

interface NativeTranslator {
  translate(text: string, options?: { signal: AbortSignal }): Promise<string>
  destroy(): void
}
interface NativeTranslatorAPI {
  availability(options: { sourceLanguage: string; targetLanguage: string }): Promise<string>
  create(options: {
    sourceLanguage: string
    targetLanguage: string
    signal: AbortSignal
    monitor: (monitor: { addEventListener(type: string, listener: (event: { loaded: number }) => void): void }) => void
  }): Promise<NativeTranslator>
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const aborted = () => reject(new Error('timeout'))
    signal.addEventListener('abort', aborted, { once: true })
    if (signal.aborted) aborted()
    promise.then(value => {
      signal.removeEventListener('abort', aborted)
      resolve(value)
    }, error => {
      signal.removeEventListener('abort', aborted)
      reject(error)
    })
  })
}

/** 分发版仅在浏览器本机翻译，不回退到云端或模拟结果。 */
export class BrowserTranslator {
  private static sessions = new Map<string, Promise<NativeTranslator>>()

  static isAvailable(): boolean {
    return typeof (globalThis as { Translator?: NativeTranslatorAPI }).Translator !== 'undefined'
  }

  static async translate(request: TranslationRequest, onProgress?: (text: string) => void): Promise<TranslationResponse> {
    const normalize = (language: string) => ({ 'zh-CN': 'zh', 'en-US': 'en', 'en-GB': 'en' }[language] || language)
    const source = normalize(!request.sourceLang || request.sourceLang === 'auto'
      ? (/\p{Script=Han}/u.test(request.text) ? 'zh' : 'en') : request.sourceLang)
    const target = normalize(request.targetLang || 'en')
    const preparation = source === 'en' && target === 'zh' ? '准备本机英译中' : '准备本机翻译'
    const api = (globalThis as { Translator?: NativeTranslatorAPI }).Translator
    if (!api) throw new Error(`此页面无法使用本机翻译，请使用桌面 Chrome 138 或更新版本，并在扩展中打开“${preparation}”`)
    if (source === target) return { translatedText: request.text, detectedSourceLanguage: source }
    const key = `${source}:${target}`
    let session = this.sessions.get(key)
    if (!session) {
      session = this.create(api, source, target, onProgress)
      this.sessions.set(key, session)
    }
    try {
      const translator = await session
      onProgress?.('正在本机翻译…')
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 30000)
      try {
        const units = source === 'zh' && target === 'en' ? browserTranslationSegments(request.text) : [request.text]
        const results: string[] = []
        for (const unit of units) {
          if (source === 'zh' && target === 'en' && !/\p{Script=Han}/u.test(unit)) {
            results.push(unit)
            continue
          }
          const leading = unit.match(/^\s*/u)![0]
          const trailing = unit.match(/\s*$/u)![0]
          const translated = source === 'en' && target === 'zh'
            ? await abortable(translator.translate(unit.trim(), { signal: controller.signal }), controller.signal)
            : await translator.translate(unit.trim(), { signal: controller.signal })
          if (!translated.trim()) throw new Error('empty translation')
          results.push(leading + preserveEndingPunctuation(unit.trim(), translated.trim(), target) + trailing)
        }
        const translatedText = results.join('')
        if (controller.signal.aborted) throw new Error('timeout')
        return { translatedText, detectedSourceLanguage: source }
      } catch {
        throw new Error(source === 'en' && target === 'zh'
          ? '本机翻译失败或超时，请重试；若持续失败，请在扩展中打开“准备本机英译中”重新验证语言包'
          : '本机翻译失败或超时，请重试；若持续失败，请在扩展中重新准备语言包')
      } finally {
        clearTimeout(timer)
      }
    } catch (error) {
      if (this.sessions.get(key) === session) this.sessions.delete(key)
      // 失败实例不复用；初始化失败或销毁失败不会产生未处理拒绝。
      void session.then(translator => translator.destroy()).catch(() => {})
      throw error
    }
  }

  private static async create(api: NativeTranslatorAPI, sourceLanguage: string, targetLanguage: string, onProgress?: (text: string) => void): Promise<NativeTranslator> {
    const options = { sourceLanguage, targetLanguage }
    const reading = sourceLanguage === 'en' && targetLanguage === 'zh'
    const preparation = reading ? '准备本机英译中' : '准备本机翻译'
    const availability = await api.availability(options)
    if (availability === 'unavailable') throw new Error(`本机当前不支持此语言对，请在扩展中打开“${preparation}”查看状态`)
    if (availability !== 'available' && !navigator.userActivation?.isActive) {
      throw new Error(reading
        ? '请先在扩展中完成“准备本机英译中”，再回到网页选中英文并点击翻译按钮'
        : '请先在扩展中完成“准备本机翻译”，再回到网页点击输入框并立即按手动翻译快捷键')
    }
    const controller = new AbortController()
    let lastLoaded = 0
    let downloading = true
    let idleTimer: ReturnType<typeof setTimeout> | undefined
    const renewIdle = () => {
      clearTimeout(idleTimer)
      idleTimer = setTimeout(() => controller.abort(), 120000)
    }
    renewIdle()
    const totalTimer = setTimeout(() => controller.abort(), 600000)
    try {
      const creation = api.create({
        ...options,
        signal: controller.signal,
        monitor: monitor => monitor.addEventListener('downloadprogress', event => {
          if (!downloading || controller.signal.aborted || !Number.isFinite(event.loaded) || event.loaded <= lastLoaded) return
          lastLoaded = event.loaded
          renewIdle()
          onProgress?.(`正在准备本机语言包 ${Math.round(lastLoaded * 100)}%，草稿不会上传…`)
        })
      }).then(translator => {
        if (controller.signal.aborted) {
          translator.destroy()
          throw new Error('timeout')
        }
        return translator
      })
      return await abortable(creation, controller.signal)
    } catch {
      throw new Error(`本机语言包准备失败或超时，请在扩展中打开“${preparation}”，检查下载网络后重试`)
    } finally {
      downloading = false
      clearTimeout(idleTimer)
      clearTimeout(totalTimer)
    }
  }
}
