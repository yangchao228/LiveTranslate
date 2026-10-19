// 构建时注入，只有显式使用 development-local 模式才连接本机代理。
declare const __LOCAL_TRANSLATION__: boolean

export const LOCAL_TRANSLATION = __LOCAL_TRANSLATION__
export const PROXY_ORIGIN = LOCAL_TRANSLATION
  ? 'http://127.0.0.1:8000'
  : 'https://reai.group'
