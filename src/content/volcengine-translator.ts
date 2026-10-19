import type { TranslationRequest, TranslationResponse } from '../shared/types'

/** 火山代理和兼容服务共用协议；地址/访问令牌仅由后台从保存设置读取。 */
export class VolcEngineTranslator {
  static async translate(request: TranslationRequest, revision = 'initial'): Promise<TranslationResponse> {
    const response = await chrome.runtime.sendMessage({ type: 'TRANSLATE_REMOTE', request, revision })
    if (!response?.success) throw new Error(response?.error || '无法连接翻译后台，请重载扩展并刷新网页')
    return response.data
  }
}
