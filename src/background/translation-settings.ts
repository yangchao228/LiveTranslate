import { VOLCENGINE_ORIGIN, translateVolcengine, validateVolcengineKeys, type VolcengineKeys } from './volcengine-direct'
import type { TranslationRequest, TranslationResponse, TranslationConfig, TranslationProvider } from '../shared/types'

declare const __LOCAL_TRANSLATION__: boolean
const STORAGE_KEY = 'translationSettings'
const CREDENTIALS_KEY = 'translationCredentials'
interface RemoteService { endpoint: string; token: string; requiresToken?: boolean }
interface SessionCredentials {
  volcengineDirect: VolcengineKeys
  volcengine: { token: string; endpoint: string }
  custom: { token: string; endpoint: string }
}
export interface TranslationSettings extends TranslationConfig {
  legacyProxyAvailable: boolean
  legacyCredentialsPending: boolean
  credentialsRequired: boolean
  volcengineDirect: VolcengineKeys
  volcengine: RemoteService
  custom: RemoteService
}
const emptyCredentials = (): SessionCredentials => ({ volcengineDirect: { accessKey: '', secretKey: '' }, volcengine: { token: '', endpoint: '' }, custom: { token: '', endpoint: '' } })

export function defaultSettings(): TranslationSettings {
  return {
    provider: __LOCAL_TRANSLATION__ ? 'volcengine' : 'browser', revision: 'initial',
    legacyProxyAvailable: __LOCAL_TRANSLATION__, legacyCredentialsPending: false, credentialsRequired: false,
    volcengineDirect: { accessKey: '', secretKey: '' },
    volcengine: { endpoint: 'http://127.0.0.1:8000/api/translate', token: '', requiresToken: false },
    custom: { endpoint: '', token: '', requiresToken: false }
  }
}

export function validateEndpoint(value: unknown): string {
  if (typeof value !== 'string') throw new Error('请填写翻译服务地址')
  let url: URL
  try { url = new URL(value.trim()) } catch { throw new Error('服务地址格式无效，请填写完整 URL') }
  if (url.username || url.password || url.search || url.hash) throw new Error('服务地址不能包含用户名、密码、查询参数或片段；访问令牌请单独填写')
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname))) {
    throw new Error('远程服务必须使用 HTTPS；本机允许 http://127.0.0.1 或 http://localhost')
  }
  if (url.pathname === '/') url.pathname = '/api/translate'
  return url.href
}

export function permissionOrigin(endpoint: string): string {
  const url = new URL(validateEndpoint(endpoint))
  // Chrome 主机权限不限定端口；真正请求仍严格使用保存的完整 URL。
  return `${url.protocol}//${url.hostname}/*`
}

let storageProtection: Promise<void> | undefined
export function protectStorage(): Promise<void> {
  if (!storageProtection) {
    storageProtection = Promise.all([
      chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }),
      chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })
    ]).then(() => {}).catch(() => {
      storageProtection = undefined
      throw new Error('无法限制密钥存储访问，请更新并重载 Chrome 扩展后重试')
    })
  }
  return storageProtection
}

// 所有写操作串行，避免撤权事件、清除和保存交错时复活旧凭据或覆盖新选择。
let writes: Promise<unknown> = Promise.resolve()
function serialized<T>(operation: () => Promise<T>): Promise<T> {
  const task = writes.then(operation)
  writes = task.catch(() => {})
  return task
}
async function rawSettings(): Promise<any> {
  await protectStorage()
  return (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY] || {}
}
async function sessionCredentials(): Promise<SessionCredentials> {
  await protectStorage()
  const value = (await chrome.storage.session.get(CREDENTIALS_KEY))[CREDENTIALS_KEY]
  const empty = emptyCredentials()
  return { volcengineDirect: { ...empty.volcengineDirect, ...value?.volcengineDirect },
    volcengine: { ...empty.volcengine, ...value?.volcengine }, custom: { ...empty.custom, ...value?.custom } }
}
const nonempty = (value: unknown): boolean => typeof value === 'string' && value.length > 0
function hasLegacyCredentials(saved: any): boolean {
  return nonempty(saved.volcengineDirect?.accessKey) || nonempty(saved.volcengineDirect?.secretKey) ||
    nonempty(saved.volcengine?.token) || nonempty(saved.custom?.token)
}
// 持久化结构只写服务选择、地址和是否需要令牌，不写本会话秘密。
// 旧明文在用户明确迁移/清除之前原样保留，并阻止远程请求。
async function persistSettings(settings: TranslationSettings, legacy?: any): Promise<void> {
  const saved: Record<string, unknown> = {
    provider: settings.provider, revision: settings.revision, legacyProxyAvailable: settings.legacyProxyAvailable,
    volcengine: { endpoint: settings.volcengine.endpoint, requiresToken: Boolean(settings.volcengine.requiresToken),
      ...(nonempty(legacy?.volcengine?.token) ? { token: legacy.volcengine.token } : {}) },
    custom: { endpoint: settings.custom.endpoint, requiresToken: Boolean(settings.custom.requiresToken),
      ...(nonempty(legacy?.custom?.token) ? { token: legacy.custom.token } : {}) }
  }
  if (nonempty(legacy?.volcengineDirect?.accessKey) || nonempty(legacy?.volcengineDirect?.secretKey)) saved.volcengineDirect = legacy.volcengineDirect
  await chrome.storage.local.set({ [STORAGE_KEY]: saved })
}

async function commitCredentials(settings: TranslationSettings, credentials: SessionCredentials | undefined, legacy?: any): Promise<void> {
  const previous = await sessionCredentials()
  if (credentials) await chrome.storage.session.set({ [CREDENTIALS_KEY]: credentials })
  else await chrome.storage.session.remove(CREDENTIALS_KEY)
  try {
    await persistSettings(settings, legacy)
  } catch (error) {
    // local 写入失败时不把新凭据留给旧服务配置；恢复失败则尝试清空会话。
    await chrome.storage.session.set({ [CREDENTIALS_KEY]: previous }).catch(() => chrome.storage.session.remove(CREDENTIALS_KEY))
    throw error
  }
}

export async function loadSettings(): Promise<TranslationSettings> {
  const [saved, credentials] = await Promise.all([rawSettings(), sessionCredentials()])
  const defaults = defaultSettings()
  const provider = saved.provider ?? defaults.provider
  const volcengine = { ...defaults.volcengine, ...saved.volcengine,
    token: credentials.volcengine.endpoint === (saved.volcengine?.endpoint ?? defaults.volcengine.endpoint) ? credentials.volcengine.token : '',
    requiresToken: Boolean(saved.volcengine?.requiresToken || nonempty(saved.volcengine?.token)) }
  const custom = { ...defaults.custom, ...saved.custom,
    token: credentials.custom.endpoint === (saved.custom?.endpoint ?? defaults.custom.endpoint) ? credentials.custom.token : '',
    requiresToken: Boolean(saved.custom?.requiresToken || nonempty(saved.custom?.token)) }
  return { provider, revision: saved.revision ?? defaults.revision,
    legacyProxyAvailable: saved.legacyProxyAvailable ?? Boolean(saved.volcengine || __LOCAL_TRANSLATION__),
    legacyCredentialsPending: hasLegacyCredentials(saved),
    credentialsRequired: provider === 'volcengine-direct' ? !credentials.volcengineDirect.accessKey || !credentials.volcengineDirect.secretKey :
      provider === 'browser' ? false : Boolean((provider === 'volcengine' ? volcengine : custom).requiresToken && !(provider === 'volcengine' ? volcengine : custom).token),
    volcengineDirect: credentials.volcengineDirect, volcengine, custom }
}

export function publicConfig(settings: TranslationSettings): TranslationConfig {
  return { provider: settings.provider, revision: settings.revision }
}

export function saveSettings(input: { provider: TranslationProvider; endpoint?: string; token?: string; accessKey?: string; secretKey?: string }): Promise<TranslationSettings> {
  return serialized(async () => {
    if (!['browser', 'volcengine-direct', 'volcengine', 'custom'].includes(input.provider)) throw new Error('未知翻译服务')
    const previous = await loadSettings()
    if (previous.legacyCredentialsPending && input.provider !== 'browser') throw new Error('请先迁移或清除旧版已保存凭据，再启用远程服务')
    const next = { ...previous, provider: input.provider, revision: crypto.randomUUID() }
    const credentials = await sessionCredentials()
    if (input.provider === 'volcengine-direct') {
      if (!await chrome.permissions.contains({ origins: [VOLCENGINE_ORIGIN] })) throw new Error('尚未授权火山官方接口，请重新点击保存并授权')
      credentials.volcengineDirect = validateVolcengineKeys({ accessKey: input.accessKey || '', secretKey: input.secretKey || '' })
    } else if (input.provider !== 'browser') {
      const endpoint = validateEndpoint(input.endpoint)
      if (!await chrome.permissions.contains({ origins: [permissionOrigin(endpoint)] })) throw new Error('尚未授权访问此服务，请重新点击保存并授权')
      const token = input.token?.trim() || ''
      if (token.length > 4096 || /[\r\n]/u.test(token)) throw new Error('访问令牌格式无效')
      next[input.provider] = { endpoint, token, requiresToken: Boolean(token) }
      // Bearer 与完整 URL 绑定，禁止保存失败或配置不一致时发给另一个地址。
      credentials[input.provider] = { token, endpoint }
    }
    await commitCredentials(next, credentials, previous.legacyCredentialsPending ? await rawSettings() : undefined)
    return loadSettings()
  })
}

export function resolveLegacyCredentials(action: unknown): Promise<TranslationSettings> {
  return serialized(async () => {
    if (action !== 'migrate' && action !== 'clear') throw new Error('请选择迁移或清除旧版凭据')
    const previous = await loadSettings()
    const saved = await rawSettings()
    if (action === 'migrate') {
      const credentials = await sessionCredentials()
      if (nonempty(saved.volcengineDirect?.accessKey) || nonempty(saved.volcengineDirect?.secretKey)) credentials.volcengineDirect = {
        accessKey: typeof saved.volcengineDirect.accessKey === 'string' ? saved.volcengineDirect.accessKey : '',
        secretKey: typeof saved.volcengineDirect.secretKey === 'string' ? saved.volcengineDirect.secretKey : '' }
      for (const provider of ['volcengine', 'custom'] as const) {
        if (nonempty(saved[provider]?.token)) credentials[provider] = { token: saved[provider].token, endpoint: previous[provider].endpoint }
      }
      // 内存保存失败时保留原有磁盘配置，用户可重试；此时远程仍被待迁移标志阻止。
      await commitCredentials({ ...previous, revision: crypto.randomUUID() }, credentials)
    } else await commitCredentials({ ...previous, revision: crypto.randomUUID() }, undefined)
    return loadSettings()
  })
}

export function clearVolcengineKeys(): Promise<TranslationSettings> {
  return serialized(async () => {
    const previous = await loadSettings()
    const credentials = await sessionCredentials()
    credentials.volcengineDirect = { accessKey: '', secretKey: '' }
    const legacy = await rawSettings()
    delete legacy.volcengineDirect
    await commitCredentials({ ...previous, provider: previous.provider === 'volcengine-direct' ? 'browser' : previous.provider, revision: crypto.randomUUID() }, credentials, legacy)
    return loadSettings()
  })
}

export function clearServiceToken(provider: unknown): Promise<TranslationSettings> {
  return serialized(async () => {
    if (provider !== 'volcengine' && provider !== 'custom') throw new Error('请选择要清除令牌的远程服务')
    const previous = await loadSettings()
    const credentials = await sessionCredentials()
    credentials[provider] = { token: '', endpoint: previous[provider].endpoint }
    const legacy = await rawSettings()
    if (legacy[provider]) delete legacy[provider].token
    await commitCredentials({ ...previous, revision: crypto.randomUUID() }, credentials, legacy)
    return loadSettings()
  })
}

function serviceOrigin(settings: TranslationSettings): string | undefined {
  if (settings.provider === 'browser') return undefined
  return settings.provider === 'volcengine-direct' ? VOLCENGINE_ORIGIN : permissionOrigin(settings[settings.provider].endpoint)
}

// 撤权只作废旧任务，不删除用户配置，也不自动改选另一项远程服务。
export function invalidateRevokedService(): Promise<void> {
  return serialized(async () => {
    const settings = await loadSettings()
    const origin = serviceOrigin(settings)
    if (!origin || await chrome.permissions.contains({ origins: [origin] })) return
    await persistSettings({ ...settings, revision: crypto.randomUUID() }, await rawSettings())
  })
}

async function assertCurrentService(settings: TranslationSettings, revision: string): Promise<void> {
  const current = await loadSettings()
  if (current.revision !== revision) throw new Error('翻译服务已切换，请重新翻译')
  if (current.legacyCredentialsPending) throw new Error('请先在设置中迁移或清除旧版凭据；远程翻译尚未启用')
  if (current.credentialsRequired) throw new Error('本次会话凭据未准备，请在设置中重新填写；重启、重载或更新会清除会话凭据')
  const origin = serviceOrigin(settings)
  if (origin && !await chrome.permissions.contains({ origins: [origin] })) {
    throw new Error('服务访问权限已撤销，请在翻译服务设置中重新授权')
  }
  // 权限检查也是异步操作，期间可能刚好保存了新服务或清除了凭据。
  if ((await loadSettings()).revision !== revision) throw new Error('翻译服务已切换，请重新翻译')
}

export async function translateRemote(request: TranslationRequest, revision: string): Promise<TranslationResponse> {
  const settings = await loadSettings()
  if (settings.revision !== revision) throw new Error('翻译服务已切换，请重新翻译')
  if (settings.provider === 'browser') throw new Error('当前为本机翻译，不发送远程请求')
  if (typeof request?.text !== 'string' || !request.text.trim() || request.text.length > 100000) throw new Error('原文为空或超过 100,000 字符，请缩小选区')
  await assertCurrentService(settings, revision)
  if (settings.provider === 'volcengine-direct') {
    return translateVolcengine(request, settings.volcengineDirect, () => assertCurrentService(settings, revision))
  }
  const service = settings[settings.provider]
  const endpoint = validateEndpoint(service.endpoint)
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (service.token) headers.Authorization = `Bearer ${service.token}`
  try {
    const response = await fetch(endpoint, {
      method: 'POST', headers, credentials: 'omit', redirect: 'error',
      signal: AbortSignal.timeout(15000),
      body: JSON.stringify({ text: request.text, sourceLang: request.sourceLang || 'auto', targetLang: request.targetLang || 'en' })
    })
    if (!response.ok) {
      const reason = response.status === 401 || response.status === 403 ? '请检查访问令牌和服务授权' :
        response.status === 429 ? '请求过多或额度不足，请稍后重试' : '请检查代理配置及供应商状态'
      throw new Error(`HTTP ${response.status}：${reason}`)
    }
    const data = await response.json()
    if (typeof data?.translatedText !== 'string' || !data.translatedText.trim()) throw new Error('服务响应不符合协议：缺少非空 translatedText')
    await assertCurrentService(settings, revision)
    return { translatedText: data.translatedText, detectedSourceLanguage: typeof data.detectedSourceLanguage === 'string' ? data.detectedSourceLanguage : undefined }
  } catch (error) {
    if (error instanceof Error && /^(HTTP |服务响应|翻译服务已切换|服务访问权限已撤销|本次会话凭据|请先在设置中迁移)/u.test(error.message)) throw error
    throw new Error('无法连接翻译服务或请求超过 15 秒：请检查地址、网络和代理运行状态；服务不能重定向')
  }
}
