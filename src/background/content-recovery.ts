/** 只补接失联的内容脚本；不刷新网页、不读取或写回草稿。 */
interface ReconnectingTask {
  promise: Promise<void>
  guards: Set<() => Promise<void>>
}
const reconnecting = new Map<string, ReconnectingTask>()

export async function isContentReady(tabId: number, frameId = 0): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const result = await Promise.race([
      chrome.tabs.sendMessage(tabId, { type: 'CONTENT_READY' }, { frameId }),
      new Promise<undefined>(resolve => { timer = setTimeout(resolve, 3000) })
    ])
    return result?.success === true
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

export function ensureContentReady(tabId: number, frameId = 0, assertCurrent?: () => Promise<void>): Promise<void> {
  const key = `${tabId}:${frameId}`
  const existing = reconnecting.get(key)
  if (existing) {
    // 工具栏加入已有手动补接时，校验也约束共享任务的后续注入步骤。
    if (assertCurrent) existing.guards.add(assertCurrent)
    return assertCurrent ? existing.promise.then(assertCurrent) : existing.promise
  }
  const guards = new Set<() => Promise<void>>(assertCurrent ? [assertCurrent] : [])
  const checkCurrent = async () => { for (const guard of guards) await guard() }
  const task = (async () => {
    if (guards.size) await checkCurrent()
    if (await isContentReady(tabId, frameId)) {
      if (guards.size) await checkCurrent()
      return
    }
    const target = { tabId, frameIds: [frameId] }
    if (guards.size) await checkCurrent()
    await chrome.scripting.executeScript({ target, files: ['content/content.js'] })
    if (guards.size) await checkCurrent()
    await chrome.scripting.insertCSS({ target, files: ['content/content.css'] })
    if (guards.size) await checkCurrent()
    if (!await isContentReady(tabId, frameId)) throw new Error('内容脚本未能接入')
    if (guards.size) await checkCurrent()
  })()
  const entry = { promise: task, guards }
  reconnecting.set(key, entry)
  void task.finally(() => { if (reconnecting.get(key) === entry) reconnecting.delete(key) }).catch(() => {})
  return task
}

/** 自动恢复只覆盖已声明授权的 ChatGPT；其他网页在手动入口使用 activeTab。 */
export async function reconnectChatGptTabs(): Promise<void> {
  const tabs = await chrome.tabs.query({ url: ['https://chatgpt.com/*'] })
  await Promise.allSettled(tabs.filter(tab => tab.id !== undefined && !tab.discarded)
    .map(tab => ensureContentReady(tab.id!)))
}
