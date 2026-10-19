import type { TranslationRequest, TranslationResponse, TranslationConfig } from '../shared/types'
import { VolcEngineTranslator } from './volcengine-translator'
import { LOCAL_TRANSLATION } from '../shared/config'
import { preserveEndingPunctuation } from './translation-punctuation'
import { BrowserTranslator } from './browser-translator'

/** 提供者只由用户设置决定；缓存和进行中请求按配置版本隔离，不自动降级。 */
export class TranslationService {
  private static readonly CACHE = new Map<string, TranslationResponse>()
  private static readonly PENDING = new Map<string, Promise<TranslationResponse>>()
  private static config: TranslationConfig = { provider: LOCAL_TRANSLATION ? 'volcengine' : 'browser', revision: 'initial' }

  static configure(config: TranslationConfig): void {
    if (config.revision === this.config.revision && config.provider === this.config.provider) return
    this.config = { ...config }
    this.CACHE.clear()
    this.PENDING.clear()
  }

  static isChinese(text: string): boolean { return /\p{Script=Han}/u.test(text) }
  static clearCache(): void { this.CACHE.clear() }
  static getCurrentProvider(): TranslationConfig['provider'] { return this.config.provider }

  static async translate(request: TranslationRequest, onProgress?: (text: string) => void): Promise<TranslationResponse> {
    if ((!request.sourceLang || request.sourceLang === 'auto') &&
        /^en(?:-|$)/i.test(request.targetLang || 'en') && this.isChinese(request.text)) {
      request = { ...request, sourceLang: 'zh' }
    }
    const config = this.config
    const key = JSON.stringify([config.provider, config.revision, request.text, request.sourceLang || 'auto', request.targetLang || 'en'])
    const cached = this.CACHE.get(key)
    if (cached) return cached
    const pending = this.PENDING.get(key)
    if (pending) return pending
    const task = this.translateUncached(request, config, onProgress)
    this.PENDING.set(key, task)
    try {
      const result = await task
      if (this.config !== config) throw new Error('翻译服务已切换，请重新翻译')
      this.CACHE.set(key, result)
      return result
    } finally {
      if (this.PENDING.get(key) === task) this.PENDING.delete(key)
    }
  }

  private static async translateUncached(request: TranslationRequest, config: TranslationConfig, onProgress?: (text: string) => void): Promise<TranslationResponse> {
    const result = config.provider === 'browser'
      ? await BrowserTranslator.translate(request, onProgress)
      : await VolcEngineTranslator.translate(request, config.revision)
    const translatedText = config.provider === 'browser' ? result.translatedText
      : preserveEndingPunctuation(request.text, result.translatedText, request.targetLang)
    if (!translatedText.trim()) throw new Error('服务返回空译文，请手动重试')
    return { ...result, translatedText }
  }
}
