/**
 * 翻译请求数据结构
 */
export interface TranslationRequest {
  text: string
  sourceLang?: string
  targetLang?: string
}

/**
 * 翻译响应数据结构
 */
export interface TranslationResponse {
  translatedText: string
  detectedSourceLanguage?: string
  confidence?: number
}

export type TranslationProvider = 'browser' | 'volcengine-direct' | 'volcengine' | 'custom'
/** 内容脚本只接收选择与版本，不接收地址或访问令牌。 */
export interface TranslationConfig {
  provider: TranslationProvider
  revision: string
}

/**
 * 消息类型定义
 */
export interface Message {
  type: 'TRANSLATE_REQUEST' | 'TRANSLATE_RESPONSE' | 'TOGGLE_TRANSLATION'
  data?: any
}

/**
 * 输入区域类型
 */
export type InputElement = HTMLInputElement | HTMLTextAreaElement | HTMLElement

/**
 * 悬浮窗位置信息
 */
export interface PopupPosition {
  top: number
  left: number
  placement: 'top' | 'bottom'
}
