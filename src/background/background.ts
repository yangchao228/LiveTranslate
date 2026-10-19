/**
 * Background Script - Service Worker
 * 处理后台任务和API请求管理
 */

// 背景脚本 - 处理扩展开关状态和快捷键管理
import { loadSettings, publicConfig, saveSettings, translateRemote, protectStorage, clearVolcengineKeys, clearServiceToken, invalidateRevokedService, resolveLegacyCredentials } from './translation-settings'
import { ensureContentReady, reconnectChatGptTabs } from './content-recovery'
import { handleActivePageHealth } from './page-health'
// 后台启动时即限制本机存储；每次设置读写也等待同一保护完成。
void protectStorage().catch(() => console.error('LiveTranslate: 密钥存储访问保护未完成'))
interface ExtensionState {
  enabled: boolean
  readingEnabled: boolean
  lastUpdated: number
}

// 默认状态
const DEFAULT_STATE: ExtensionState = {
  enabled: true,
  readingEnabled: true,
  lastUpdated: Date.now()
}

// 仅保留最近一次快捷键错误的通用提示，不保存草稿或供应商响应。
let lastManualError: string | undefined
let manualCommandEpoch = 0

async function showManualTranslationError(message: string, tabId: number | undefined, epoch: number): Promise<void> {
  if (epoch !== manualCommandEpoch) return
  lastManualError = message
  try {
    if (tabId === undefined) throw new Error('no-tab')
    await chrome.scripting.executeScript({
      target: { tabId },
      args: [message],
      func: (text: string) => {
        const id = 'live-translate-command-notice'
        document.getElementById(id)?.remove()
        const host = document.createElement('div')
        host.id = id
        host.style.cssText = 'all:initial;position:fixed;right:20px;bottom:20px;z-index:2147483647;display:block;max-width:calc(100vw - 40px)'
        const shadow = host.attachShadow({ mode: 'closed' })
        const notice = document.createElement('div')
        notice.setAttribute('role', 'status')
        notice.setAttribute('aria-live', 'polite')
        notice.style.cssText = 'box-sizing:border-box;display:flex;align-items:start;gap:12px;width:300px;max-width:calc(100vw - 40px);padding:14px 16px;background:#fff;color:#18253d;border:1px solid #dce2ec;border-left:3px solid #3158bd;border-radius:10px;box-shadow:0 6px 24px #18253d20;font:14px/1.65 system-ui,sans-serif;color-scheme:light'
        const copy = document.createElement('span')
        copy.textContent = `LiveTranslate：${text}`
        const close = document.createElement('button')
        close.type = 'button'
        close.textContent = '×'
        close.setAttribute('aria-label', '关闭翻译提示')
        close.style.cssText = 'flex:none;width:28px;height:28px;border:0;border-radius:4px;background:#f5f7fa;color:#59677d;cursor:pointer;font:20px/1 system-ui'
        close.addEventListener('click', () => host.remove())
        notice.append(copy, close)
        shadow.append(notice)
        ;(document.body || document.documentElement).append(host)
        setTimeout(() => host.remove(), 8000)
      }
    })
  } catch {
    if (epoch !== manualCommandEpoch) return
    // Chrome 内部等受限页不能注入；工具栏标记提示用户打开弹窗查看原因。
    await Promise.allSettled([
      chrome.action.setBadgeText({ text: '!' }),
      chrome.action.setBadgeBackgroundColor({ color: '#3158bd' }),
      chrome.action.setTitle({ title: `LiveTranslate：${message}。点击图标查看提示。` })
    ])
  }
}

// 初始化扩展状态
chrome.runtime.onInstalled.addListener(async details => {
  console.log('LiveTranslate: Extension installed')
  const result = await chrome.storage.sync.get(['enabled', 'readingEnabled'])
  // 重载和更新保留用户开关，仅首次安装写入默认值。
  if (typeof result.enabled !== 'boolean') {
    await chrome.storage.sync.set({ ...DEFAULT_STATE, readingEnabled: result.readingEnabled ?? true })
  } else {
    await updateIcon(result.enabled || result.readingEnabled === undefined || result.readingEnabled === true)
  }
  // 更新或重载不打开页面；语言包下载仍需用户主动点击。
  if (details.reason === 'install') {
    await chrome.tabs.create({ url: chrome.runtime.getURL('setup/setup.html?welcome=1') })
  }
  await reconnectChatGptTabs().catch(() => {})
})

chrome.runtime.onStartup.addListener(() => { void reconnectChatGptTabs().catch(() => {}) })

// 处理快捷键命令
chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'toggle_extension') {
    await toggleExtension()
  } else if (command === 'translate_selection') {
    const epoch = ++manualCommandEpoch
    lastManualError = undefined
    await Promise.allSettled([
      chrome.action.setBadgeText({ text: '' }),
      chrome.action.setTitle({ title: 'LiveTranslate' })
    ])
    if (epoch !== manualCommandEpoch) return
    let targetTabId: number | undefined
    const result = await translateActiveEditor(id => { targetTabId = id })
    if (epoch !== manualCommandEpoch) return
    if (!result.success) await showManualTranslationError(result.error || '未能翻译，请打开插件查看使用方法。', targetTabId, epoch)
    else {
      const state = await getExtensionPreferences()
      if (epoch === manualCommandEpoch) await chrome.action.setTitle({ title: `LiveTranslate - ${state.enabled || state.readingEnabled ? 'enabled' : 'disabled'}` }).catch(() => {})
    }
  }
})

// 工具栏打开时页面暂时失焦；正文选区优先，唯一定位 frame，避免广播后翻译多个目标。
async function translateActiveEditor(onTarget?: (tabId: number) => void): Promise<{ success: boolean; error?: string }> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (tab?.id === undefined) return { success: false, error: '没有可翻译的网页' }
    onTarget?.(tab.id)
    const preferences = await getExtensionPreferences()
    if (!preferences.enabled && !preferences.readingEnabled) return { success: false, error: '两项翻译均已关闭，请在工具栏开启输入中译英或划词英译中。' }
    const frames = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: () => {
        const element = document.activeElement
        const editable = element instanceof HTMLTextAreaElement ||
          (element instanceof HTMLInputElement && ['text', 'search'].includes(element.type)) ||
          (element instanceof HTMLElement && element.isContentEditable)
        const selection = window.getSelection()
        let pageSelection = false
        if (!editable && selection && !selection.isCollapsed && selection.rangeCount === 1) {
          const text = selection.toString().trim()
          const range = selection.getRangeAt(0)
          const container = range.commonAncestorContainer
          const root = container instanceof Element ? container : container.parentElement
          // 只读取正文候选是否存在；原文不带回后台，具体 Range 和请求身份由内容脚本复核。
          const excluded = 'input, textarea, [contenteditable]:not([contenteditable="false"]), [data-live-translate-ui], .live-translate-enhanced-popup, .live-translate-popup, #live-translate-command-notice'
          const blocked = !root || !!root.closest(excluded) ||
            Array.from(root.querySelectorAll(excluded)).some(node => range.intersectsNode(node))
          pageSelection = !blocked && /[A-Za-z]/.test(text) && !/\p{Script=Han}/u.test(text)
        }
        return { editable, pageSelection, focused: document.hasFocus() }
      }
    })
    const selections = frames.filter(frame => frame.result?.pageSelection)
    const editors = frames.filter(frame => frame.result?.editable)
    // 当前聚焦的编辑器不能被另一 frame 残留的失焦正文选区抢走。
    const focused = frames.filter(frame => frame.result?.focused && (frame.result.pageSelection || frame.result.editable))
    const targets = focused.length ? focused : selections.length ? selections : editors
    if (targets.length > 1 && targets.some(frame => frame.result?.pageSelection)) {
      return { success: false, error: '请在目标网页重新选择一处英文，再用手动翻译重试。' }
    }
    if (targets.length !== 1) return { success: false, error: '请先点击目标输入框，或在网页正文选择英文，再用手动翻译重试。' }
    const target = targets[0]
    const pageSelection = target.result?.pageSelection
    // 先定位原目标，再检查对应开关；不能回退到另一 frame 的残留目标。
    const disabledError = (state: { enabled: boolean; readingEnabled: boolean }) => pageSelection
      ? (!state.readingEnabled ? '划词英译中已关闭，请在工具栏开启后重试。' : undefined)
      : (!state.enabled ? '输入中译英已关闭，请在工具栏开启后重试。' : undefined)
    let error = disabledError(await getExtensionPreferences())
    if (error) return { success: false, error }
    await ensureContentReady(tab.id, target.frameId)
    // 补接可能等待初始化；期间关闭对应场景后，不再发送翻译命令。
    error = disabledError(await getExtensionPreferences())
    if (error) return { success: false, error }
    const result = await chrome.tabs.sendMessage(tab.id, { type: pageSelection ? 'TRANSLATE_PAGE_SELECTION' : 'TRANSLATE_SELECTION' }, { frameId: target.frameId })
    return result || { success: false, error: pageSelection ? '未能连接网页选区，请重新选择英文后重试。' : '未能连接输入框，请再次使用手动翻译。' }
  } catch {
    return { success: false, error: '当前页面无法翻译。请确认网站访问权限，并在普通网页选择英文或聚焦输入框后重试。' }
  }
}

// 处理工具栏点击
chrome.action.onClicked.addListener(async () => {
  await toggleExtension()
})

// 切换扩展开关状态
async function toggleExtension(): Promise<void> {
  try {
    const result = await chrome.storage.sync.get(['enabled'])
    const newState = !(result.enabled ?? true)
    
    await chrome.storage.sync.set({
      enabled: newState,
      lastUpdated: Date.now()
    })

    console.log(`LiveTranslate ${newState ? 'enabled' : 'disabled'}`)
  } catch (error) {
    console.error('Failed to toggle extension state:', error)
  }
}

// 使用随包图标，加载失败时绘制简单后备图标。
async function updateIcon(enabled: boolean): Promise<void> {

  try {
    // 方案1：尝试使用 path 方式（如果图标文件存在）
    await chrome.action.setIcon({
      path: {
        '16': `icons/${enabled ? 'icon-' : 'icon-disabled-'}16.png`,
        '48': `icons/${enabled ? 'icon-' : 'icon-disabled-'}48.png`,
        '128': `icons/${enabled ? 'icon-' : 'icon-disabled-'}128.png`
      }
    })
  } catch (pathError) {
    console.warn('Failed to set icon using path, trying imageData method:', pathError)
    
    try {
      // 方案2：使用 imageData 方式创建图标
      const canvas = new OffscreenCanvas(16, 16)
      const ctx = canvas.getContext('2d')
      if (ctx) {
        // 与随包图标保持相同的句隙轮廓和启停配色。
        ctx.fillStyle = enabled ? '#3158bd' : '#7d8799'
        ctx.beginPath()
        ctx.roundRect(0, 0, 16, 16, 3.5)
        ctx.fill()
        ctx.scale(0.25, 0.25)
        ctx.fillStyle = '#ffffff'
        ctx.fill(new Path2D('M12 9h31c7.73 0 14 6.27 14 14v1H40c-6.63 0-12 3.63-12 9H17v-8a5 5 0 0 0-5-5H7v-6a5 5 0 0 1 5-5Z M36 32h11v7a5 5 0 0 0 5 5h5v6a5 5 0 0 1-5 5H21c-7.73 0-14-6.27-14-14v-1h17c6.63 0 12-2.63 12-8Z'))
        
        const imageData = ctx.getImageData(0, 0, 16, 16)
        
        await chrome.action.setIcon({ imageData })
      }
    } catch (imageDataError) {
      console.warn('Failed to set icon using imageData:', imageDataError)
      
      // 方案3：最简单的后备方案 - 不设置图标
      console.log('Using default icon')
    }
  }

  await chrome.action.setTitle({
    title: `LiveTranslate - ${enabled ? 'enabled' : 'disabled'}`
  })
}

// 所有入口（工具栏、快捷键、存储同步）都从这里通知页面，避免开关状态脱节。
chrome.storage.onChanged.addListener(async (changes, namespace) => {
  if (namespace === 'local' && changes.translationSettings) {
    const config = publicConfig(await loadSettings())
    const tabs = await chrome.tabs.query({})
    await Promise.all(tabs.map(tab => tab.id === undefined ? undefined :
      chrome.tabs.sendMessage(tab.id, { type: 'TRANSLATION_CONFIG_CHANGED', config }).catch(() => {})))
  }
  if (namespace === 'sync' && changes.enabled) {
    const enabled = changes.enabled.newValue ?? true
    try {
      await Promise.all([
        getExtensionPreferences().then(state => updateIcon(state.enabled || state.readingEnabled)),
        chrome.tabs.query({}).then(tabs => Promise.all(tabs.map(tab => {
          if (tab.id === undefined) return
          return chrome.tabs.sendMessage(tab.id, {
            type: 'EXTENSION_STATE_CHANGED', enabled
          }).catch(() => {
            // Chrome 内部页面等无法接收内容脚本消息，不影响其他标签页。
          })
        })))
      ])
    } catch (error) {
      console.error('Failed to synchronize extension state:', error)
    }
  }
  if (namespace === 'sync' && changes.readingEnabled) {
    const enabled = changes.readingEnabled.newValue === undefined || changes.readingEnabled.newValue === true
    try {
      const tabs = await chrome.tabs.query({})
      await Promise.all([
        getExtensionPreferences().then(state => updateIcon(state.enabled || state.readingEnabled)),
        ...tabs.map(tab => tab.id === undefined ? undefined :
          chrome.tabs.sendMessage(tab.id, { type: 'READING_STATE_CHANGED', enabled }).catch(() => {}))
      ])
    } catch {
      console.error('LiveTranslate: 划词开关同步失败，请重试')
    }
  }
})

// Chrome 中撤销远程主机权限后立即作废页面缓存和正在显示的旧译文。
chrome.permissions.onRemoved.addListener(() => {
  void invalidateRevokedService().catch(() => console.error('LiveTranslate: 服务权限状态更新失败'))
})

// 获取当前扩展状态
async function getExtensionPreferences(): Promise<{ enabled: boolean; readingEnabled: boolean }> {
  const result = await chrome.storage.sync.get(['enabled', 'readingEnabled'])
  return {
    enabled: result.enabled ?? true,
    // 旧版没有此键，沿用现有划词行为；损坏的偏好不解释为开启。
    readingEnabled: result.readingEnabled === undefined || result.readingEnabled === true
  }
}

// 监听消息
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // 不记录完整消息：配置可能包含访问令牌，翻译请求可能包含私人草稿。
  const reply = (task: Promise<unknown>) => {
    task.then(sendResponse).catch(error => sendResponse({ success: false, error: error instanceof Error ? error.message : '操作失败，请重试' }))
    return true
  }
  if (message.type === 'GET_ACTIVE_PAGE_STATUS' || message.type === 'RECOVER_ACTIVE_PAGE') {
    return reply(handleActivePageHealth(message, sender))
  }
  if (message.type === 'OPEN_READING_PREPARATION') {
    let ordinaryPage = false
    try { ordinaryPage = /^https?:$/u.test(new URL(sender.url || '').protocol) } catch { /* 无效来源不打开扩展页面。 */ }
    const tabId = sender.tab?.id
    if (sender.id !== chrome.runtime.id || !ordinaryPage || typeof tabId !== 'number' || !Number.isSafeInteger(tabId) || tabId < 0) {
      sendResponse({ success: false, error: '请从普通网页的划词翻译入口准备英译中' })
      return false
    }
    // 只使用 Chrome 提供的来源标签 ID；忽略调用者地址，不能借此打开任意页面。
    const url = chrome.runtime.getURL(`setup/setup.html?direction=en-zh&returnTab=${tabId}`)
    return reply(chrome.tabs.create({ url }).then(() => ({ success: true }))
      .catch(() => ({ success: false, error: '暂时无法打开英译中准备页，请从扩展工具栏重试' })))
  }
  if (['GET_POPUP_OFFSET', 'SET_POPUP_OFFSET', 'CLEAR_POPUP_OFFSET'].includes(message.type)) {
    if (sender.id !== chrome.runtime.id) { sendResponse({ success: false }); return false }
    return reply(protectStorage().then(async () => {
      const key = 'liveTranslatePopupOffset'
      if (message.type === 'SET_POPUP_OFFSET') {
        const { x, y } = message.offset || {}
        if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 100000 || Math.abs(y) > 100000) throw new Error('无效的位置')
        await chrome.storage.local.set({ [key]: { x, y } })
      } else if (message.type === 'CLEAR_POPUP_OFFSET') await chrome.storage.local.remove(key)
      else return { success: true, offset: (await chrome.storage.local.get(key))[key] || null }
      return { success: true }
    }))
  }
  if (message.type === 'GET_TRANSLATION_CONFIG') {
    return reply(loadSettings().then(settings => ({ success: true, config: publicConfig(settings) })))
  }
  if (['GET_TRANSLATION_SETTINGS', 'SAVE_TRANSLATION_SETTINGS', 'TEST_TRANSLATION_SERVICE', 'CLEAR_VOLCENGINE_KEYS', 'CLEAR_SERVICE_TOKEN', 'RESOLVE_LEGACY_CREDENTIALS'].includes(message.type)) {
    if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('options/options.html')) {
      sendResponse({ success: false, error: '请通过翻译服务设置页操作' })
      return false
    }
    if (message.type === 'RESOLVE_LEGACY_CREDENTIALS') return reply(resolveLegacyCredentials(message.action).then(settings => ({ success: true, settings })))
    if (message.type === 'CLEAR_SERVICE_TOKEN') return reply(clearServiceToken(message.provider).then(settings => ({ success: true, settings })))
    if (message.type === 'CLEAR_VOLCENGINE_KEYS') return reply(clearVolcengineKeys().then(settings => ({ success: true, settings })))
    if (message.type === 'GET_TRANSLATION_SETTINGS') return reply(loadSettings().then(settings => ({ success: true, settings })))
    if (message.type === 'SAVE_TRANSLATION_SETTINGS') return reply(saveSettings(message.settings).then(settings => ({ success: true, settings })))
    return reply(loadSettings().then(settings => translateRemote({ text: '你好，今天测试翻译服务。', sourceLang: 'zh', targetLang: 'en' }, settings.revision))
      .then(data => ({ success: true, data })))
  }
  if (message.type === 'TRANSLATE_REMOTE') {
    if (sender.id !== chrome.runtime.id) {
      sendResponse({ success: false, error: '无效的扩展请求' })
      return false
    }
    return reply(translateRemote(message.request, message.revision).then(data => ({ success: true, data })))
  }
  if (message.type === 'TRANSLATE_ACTIVE_EDITOR') {
    translateActiveEditor().then(sendResponse)
    return true
  }
  
  if (message.type === 'GET_EXTENSION_STATE') {
    // 异步获取扩展状态
    getExtensionPreferences().then(preferences => {
      const active = preferences.enabled || preferences.readingEnabled
      const popup = sender.id === chrome.runtime.id && sender.url === chrome.runtime.getURL('popup/popup.html')
      const manualError = popup ? lastManualError : undefined
      if (popup) {
        lastManualError = undefined
        void chrome.action.setBadgeText({ text: '' }).catch(() => {})
        void chrome.action.setTitle({ title: `LiveTranslate - ${active ? 'enabled' : 'disabled'}` }).catch(() => {})
      }
      sendResponse(manualError ? { ...preferences, manualError } : preferences)
    }).catch(error => {
      console.error('Failed to get extension state:', error)
      sendResponse({ success: false, error: '无法读取翻译开关状态，请重试。' })
    })
    return true // 保持消息通道开放以支持异步响应
  }

  if (message.type === 'SET_READING_STATE') {
    if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('popup/popup.html')) {
      sendResponse({ success: false, error: '请通过扩展工具栏设置划词英译中' })
      return false
    }
    if (typeof message.enabled !== 'boolean') {
      sendResponse({ success: false, error: '划词开关状态无效，请重试' })
      return false
    }
    return reply(chrome.storage.sync.set({ readingEnabled: message.enabled }).then(() => ({ success: true, enabled: message.enabled })))
  }
  
  if (message.type === 'SET_EXTENSION_STATE') {
    // 设置扩展状态
    chrome.storage.sync.set({
      enabled: message.enabled,
      lastUpdated: Date.now()
    }).then(() => {
      sendResponse({ success: true })
    }).catch(error => {
      console.error('Failed to set extension state:', error)
      sendResponse({ success: false, error: error.message })
    })
    return true // 保持消息通道开放以支持异步响应
  }
  
  // 旧的任意 fetch 消息不再转发；所有远程翻译统一使用已保存的配置。
  if (message.action === 'fetch') {
    sendResponse({ success: false, error: '请重载扩展并刷新网页，旧代理请求已停用' })
    return false
  }

  return true
})
