import type { TranslationRequest, TranslationResponse } from '../shared/types'

// 文本翻译官方固定目标。密钥不能被配置到任意 URL；Host 由浏览器按 URL 设置。
export const VOLCENGINE_ORIGIN = 'https://translate.volcengineapi.com/*'
export const VOLCENGINE_URL = 'https://translate.volcengineapi.com/?Action=TranslateText&Version=2020-06-01'
export interface VolcengineKeys { accessKey: string; secretKey: string }
const encoder = new TextEncoder()
const hex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('')
const hash = async (value: string) => hex(await crypto.subtle.digest('SHA-256', encoder.encode(value)))
async function hmac(key: Uint8Array<ArrayBuffer>, value: string): Promise<Uint8Array<ArrayBuffer>> {
  const imported = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return new Uint8Array(await crypto.subtle.sign('HMAC', imported, encoder.encode(value)))
}

/** 只返回 HTTP 所需签名头，SK 不参与发送；时间参数用于和官方 SDK 的固定向量对照。 */
export async function signVolcengine(body: string, keys: VolcengineKeys, now = new Date()): Promise<Record<string, string>> {
  const date = now.toISOString().replace(/[:-]|\.\d{3}/g, '')
  const shortDate = date.slice(0, 8)
  const digest = await hash(body)
  const signedHeaders = 'content-type;host;x-content-sha256;x-date'
  const canonicalHeaders = `content-type:application/json\nhost:translate.volcengineapi.com\nx-content-sha256:${digest}\nx-date:${date}\n`
  const canonical = ['POST', '/', 'Action=TranslateText&Version=2020-06-01', canonicalHeaders, signedHeaders, digest].join('\n')
  const scope = `${shortDate}/cn-north-1/translate/request`
  const toSign = ['HMAC-SHA256', date, scope, await hash(canonical)].join('\n')
  let key = encoder.encode(keys.secretKey)
  for (const value of [shortDate, 'cn-north-1', 'translate', 'request']) key = await hmac(key, value)
  const signature = hex((await hmac(key, toSign)).buffer)
  return {
    'Content-Type': 'application/json', 'X-Date': date, 'X-Content-Sha256': digest,
    Authorization: `HMAC-SHA256 Credential=${keys.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
  }
}

export function validateVolcengineKeys(keys: VolcengineKeys): VolcengineKeys {
  const accessKey = typeof keys?.accessKey === 'string' ? keys.accessKey.trim() : ''
  const secretKey = typeof keys?.secretKey === 'string' ? keys.secretKey.trim() : ''
  if (!accessKey || !secretKey) throw new Error('请填写自己的火山 Access Key ID 和 Secret Access Key')
  if (![accessKey, secretKey].every(value => /^[\x21-\x7e]{1,256}$/.test(value)) || /[,/]/.test(accessKey)) {
    throw new Error('火山密钥格式无效，请检查空格、换行或复制内容')
  }
  return { accessKey, secretKey }
}

export async function translateVolcengine(request: TranslationRequest, keys: VolcengineKeys, stillCurrent: () => Promise<void>): Promise<TranslationResponse> {
  // 官方单次 TextList 总长度不超过 5000 字符；不自动拆请求以免额外费用和上下文变化。
  if (request.text.length > 5000) throw new Error('火山单次翻译最多 5,000 字符，请缩小选区后重试')
  const credentials = validateVolcengineKeys(keys)
  const body = JSON.stringify({
    ...(request.sourceLang && request.sourceLang !== 'auto' ? { SourceLanguage: request.sourceLang } : {}),
    TargetLanguage: request.targetLang || 'en', TextList: [request.text]
  })
  const headers = await signVolcengine(body, credentials)
  await stillCurrent()
  let response: Response
  let data: any
  try {
    response = await fetch(VOLCENGINE_URL, { method: 'POST', headers, body, credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(15000) })
    data = await response.json()
  } catch {
    throw new Error('无法连接火山翻译或请求超过 15 秒，请检查网络后重试')
  }
  await stillCurrent()
  const error = data?.ResponseMetadata?.Error
  if (!response.ok || error) {
    // 不回显原始供应商消息、请求头或可能包含密钥/正文的调试字段。
    const code = String(error?.Code || '')
    if (response.status === 401 || response.status === 403 || /Signature|AccessKey|Auth|Token|Denied|Expired/i.test(code)) {
      throw new Error('火山鉴权失败：请检查 AK/SK、机器翻译权限与电脑时间')
    }
    if (response.status === 429 || code === '-429' || /Limit|Quota|Balance/i.test(code)) {
      throw new Error('火山请求过多或额度不足，请检查账号额度并稍后重试')
    }
    throw new Error('火山翻译失败，请检查服务是否开通、语言和文本长度；不会自动切换服务')
  }
  const item = data?.TranslationList?.[0]
  if (typeof item?.Translation !== 'string' || !item.Translation.trim()) throw new Error('火山响应缺少有效译文，请稍后重试')
  return { translatedText: item.Translation, detectedSourceLanguage: typeof item.DetectedSourceLanguage === 'string' ? item.DetectedSourceLanguage : undefined }
}
