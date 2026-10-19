import { ensureContentReady, isContentReady } from './content-recovery'

type PageStatus = 'ready' | 'needs-recovery' | 'restricted' | 'unknown'
interface PageHealthResult {
  success: boolean
  status: PageStatus
  tabId?: number
  checkId?: string
  message?: string
}
interface PageSnapshot { tabId: number; windowId?: number; url: string; navigation: number; activation: number }

// 同 URL 重载也使旧检查失效；不持久化网页地址或读取正文。
const navigationVersions = new Map<number, number>()
let activationVersion = 0
chrome.tabs.onUpdated?.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading' || changeInfo.url !== undefined) {
    navigationVersions.set(tabId, (navigationVersions.get(tabId) || 0) + 1)
  }
})
chrome.tabs.onRemoved?.addListener(tabId => { navigationVersions.delete(tabId) })
chrome.tabs.onActivated?.addListener(() => { activationVersion++ })

// 工具栏只得到不含网址的短期令牌；恢复始终绑定刚才检查的原文档。
const checks = new Map<string, { snapshot: PageSnapshot; expiresAt: number }>()
function rememberCheck(snapshot: PageSnapshot): string {
  const now = Date.now()
  for (const [id, check] of checks) if (check.expiresAt <= now) checks.delete(id)
  while (checks.size >= 32) checks.delete(checks.keys().next().value!)
  const id = crypto.randomUUID()
  checks.set(id, { snapshot, expiresAt: now + 120000 })
  return id
}

class PageChangedError extends Error {}
const recoveries = new Map<string, Promise<PageHealthResult>>()
const unknown = (message: string): PageHealthResult => ({ success: true, status: 'unknown', message })
const changed = () => unknown('活动网页已变化，请重新检查。')

function restrictedPage(url: URL): boolean {
  return !['http:', 'https:'].includes(url.protocol) ||
    url.hostname === 'chromewebstore.google.com' ||
    (url.hostname === 'chrome.google.com' && /^\/webstore(?:\/|$)/u.test(url.pathname))
}

async function inspectPage(expected?: PageSnapshot, checkId?: string): Promise<PageHealthResult> {
  const recover = expected !== undefined
  let open = true
  let timer: ReturnType<typeof setTimeout> | undefined
  let target = expected
  const assertOpen = () => { if (!open) throw new PageChangedError() }
  const assertCurrent = async () => {
    assertOpen()
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    assertOpen()
    if (!target || tab?.id !== target.tabId || tab.windowId !== target.windowId || tab.url !== target.url || tab.pendingUrl ||
      tab.status === 'loading' || tab.discarded || activationVersion !== target.activation ||
      (navigationVersions.get(target.tabId) || 0) !== target.navigation) {
      throw new PageChangedError()
    }
  }
  const operation = (async (): Promise<PageHealthResult> => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    assertOpen()
    if (expected && (tab?.id !== expected.tabId || tab.windowId !== expected.windowId || tab.url !== expected.url ||
      tab.pendingUrl || tab.status === 'loading' || tab.discarded || activationVersion !== expected.activation ||
      (navigationVersions.get(expected.tabId) || 0) !== expected.navigation)) return changed()
    if (!tab || !Number.isSafeInteger(tab.id) || tab.id! < 0) return unknown('未找到活动网页，请切到要翻译的页面。')
    if (!tab.url) return unknown('暂时无法检查此页，请切到普通网页后重试。')
    let url: URL
    try { url = new URL(tab.url) } catch { return unknown('暂时无法检查此页，请重试。') }
    if (restrictedPage(url)) return { success: true, status: 'restricted', tabId: tab.id, message: '此页面不支持翻译，请切到普通网页。' }
    if (tab.pendingUrl || tab.status === 'loading' || tab.discarded) return unknown('网页正在加载，请稍后重试。')
    target = expected || { tabId: tab.id!, windowId: tab.windowId, url: tab.url, navigation: navigationVersions.get(tab.id!) || 0, activation: activationVersion }
    if (recover) await ensureContentReady(target.tabId, 0, assertCurrent)
    else {
      const ready = await isContentReady(target.tabId, 0)
      await assertCurrent()
      if (!ready) return { success: true, status: 'needs-recovery', tabId: target.tabId, checkId: rememberCheck(target), message: '当前网页尚未接入。' }
    }
    await assertCurrent()
    return { success: true, status: 'ready', tabId: target.tabId, checkId: checkId || rememberCheck(target), message: '当前网页已接入。' }
  })()
  try {
    return await Promise.race([
      operation,
      new Promise<PageHealthResult>(resolve => {
        timer = setTimeout(() => {
          open = false
          resolve(unknown(recover ? '接入超时，请重新检查或刷新网页。' : '网页检查超时，请重试。'))
        }, 10000)
      })
    ])
  } catch (error) {
    if (error instanceof PageChangedError) return changed()
    // 不透传 Chrome 的底层异常，可能包含网页地址或供应商诊断正文。
    return recover && target ? {
      success: true, status: 'needs-recovery', tabId: target.tabId, checkId,
      message: '未能接入，请检查网站访问权限；PDF 等页面可能不支持。'
    } : unknown('暂时无法检查此页，请重试。')
  } finally {
    open = false
    clearTimeout(timer)
  }
}

/** 自检只握手；恢复仅操作用户在当前工具栏中刚检查的活动主页面。 */
export function handleActivePageHealth(message: { type: string; expectedTabId?: unknown; checkId?: unknown }, sender: chrome.runtime.MessageSender): Promise<PageHealthResult> {
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('popup/popup.html')) {
    return Promise.resolve({ success: false, status: 'unknown', message: '请通过扩展工具栏检查当前网页。' })
  }
  if (message.type === 'GET_ACTIVE_PAGE_STATUS') return inspectPage()
  if (message.type !== 'RECOVER_ACTIVE_PAGE' || !Number.isSafeInteger(message.expectedTabId) || (message.expectedTabId as number) < 0 ||
    typeof message.checkId !== 'string' || !message.checkId || message.checkId.length > 128) {
    return Promise.resolve({ success: false, status: 'unknown', message: '请先检查当前网页后重试。' })
  }
  const tabId = message.expectedTabId as number
  const check = checks.get(message.checkId)
  if (!check || check.expiresAt <= Date.now()) {
    checks.delete(message.checkId)
    return Promise.resolve(unknown('网页检查已过期，请重新检查。'))
  }
  if (check.snapshot.tabId !== tabId) return Promise.resolve(changed())
  const key = message.checkId
  const existing = recoveries.get(key)
  if (existing) return existing
  const task = inspectPage(check.snapshot, message.checkId)
  recoveries.set(key, task)
  void task.finally(() => { if (recoveries.get(key) === task) recoveries.delete(key) }).catch(() => {})
  return task
}
