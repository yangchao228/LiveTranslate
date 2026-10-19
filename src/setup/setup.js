// 此页面保持打开直到原生语言包下载和验证结束；不保存草稿，不请求云端翻译。
const statusText = document.getElementById('status')
const prepare = document.getElementById('prepare')
const cancel = document.getElementById('cancel')
const progress = document.getElementById('progress')
const sample = document.getElementById('sample')
const startWriting = document.getElementById('start-writing')
const preparationTitle = document.getElementById('preparation-title')
const taskTitle = document.getElementById('task-title')
const query = new URLSearchParams(location.search)
const returnTabValue = query.get('returnTab')
const returnTabId = /^\d+$/.test(returnTabValue || '') && Number.isSafeInteger(Number(returnTabValue)) ? Number(returnTabValue) : undefined
const isReading = query.get('direction') === 'en-zh'
const languages = isReading ? { sourceLanguage: 'en', targetLanguage: 'zh' } : { sourceLanguage: 'zh', targetLanguage: 'en' }
const languagePair = isReading ? '英译中' : '中英'
const verificationSource = isReading ? 'The meeting starts at nine tomorrow morning.' : 'Hello. 太棒了。'
const helpPath = isReading ? 'help/user-guide.html#reading' : 'help/user-guide.html#usage'
let activeController
let completionReady = false
let completionEpoch = 0
let returnTarget
document.getElementById('welcome').hidden = isReading || query.get('welcome') !== '1'

if (isReading) {
  document.title = '准备本机英译中 · LiveTranslate'
  preparationTitle.textContent = '准备英译中，回到阅读'
  taskTitle.textContent = '下载并验证本机英译中'
  document.getElementById('preparation-description').textContent = '首次使用本机英译中时，需要联网准备语言包。本页只准备英译中；选择本机服务时，选中的英文只在这台电脑翻译。'
  document.getElementById('language-preparation').setAttribute('aria-label', '英译中语言包准备')
  document.getElementById('source-language').textContent = '英文'
  document.getElementById('target-language').textContent = '中文'
  document.getElementById('usage-first').textContent = '回到网页，选中正文中的英文单词、句子或短段落。'
  document.getElementById('usage-second').textContent = '点击选区附近的“翻译成中文”，在浮窗中阅读或复制译文。'
  document.getElementById('usage-third').textContent = '按 Esc 关闭浮窗。仅选中文字不会发起翻译，网页原文保持不变。'
}

// 来源只保存标签 ID；每次返回前重新核对，避免跳转到内部页面或已关闭的标签。
async function validatedReturnTab() {
  if (returnTabId === undefined) return undefined
  try {
    const tab = await chrome.tabs.get(returnTabId)
    if (tab.id !== returnTabId || !Number.isInteger(tab.windowId) || !/^https?:$/.test(new URL(tab.url).protocol)) return undefined
    return tab
  } catch {
    return undefined
  }
}

function setCompletionState(ready) {
  completionReady = ready
  const epoch = ++completionEpoch
  startWriting.hidden = !ready
  startWriting.disabled = false
  prepare.classList.toggle('primary-action', !ready)
  preparationTitle.textContent = ready ? (isReading ? '本机英译中已准备好' : '本机翻译已准备好') : (isReading ? '准备英译中，回到阅读' : '准备好语言包，回到写作')
  taskTitle.textContent = ready ? '验证通过，可以开始使用' : (isReading ? '下载并验证本机英译中' : '下载并验证本机翻译')
  returnTarget = undefined
  startWriting.textContent = '查看使用方法'
  if (!ready) return
  prepare.textContent = isReading ? '重新验证本机英译中' : '重新验证本机翻译'
  void validatedReturnTab().then(tab => {
    if (!completionReady || epoch !== completionEpoch) return
    returnTarget = tab
    startWriting.textContent = tab ? (isReading ? '返回网页继续阅读' : '返回网页开始使用') : '查看使用方法'
  })
}

startWriting.addEventListener('click', async () => {
  if (!completionReady || startWriting.disabled) return
  const epoch = completionEpoch
  startWriting.disabled = true
  try {
    if (!returnTarget) {
      await chrome.tabs.create({ url: chrome.runtime.getURL(helpPath) })
      return
    }
    const tab = await validatedReturnTab()
    if (!completionReady || epoch !== completionEpoch) return
    if (!tab) {
      returnTarget = undefined
      startWriting.textContent = '查看使用方法'
      statusText.textContent = '来源网页已关闭或无法返回，已为你打开使用方法。准备结果保留，可重新打开网页开始使用。'
      await chrome.tabs.create({ url: chrome.runtime.getURL(helpPath) })
      return
    }
    await chrome.tabs.update(tab.id, { active: true })
    if (!completionReady || epoch !== completionEpoch) return
    try {
      await chrome.windows.update(tab.windowId, { focused: true })
    } catch {
      statusText.textContent = '网页已切换，但未能置前 Chrome 窗口。请手动切换到原窗口，或再点击一次。'
    }
  } catch {
    if (completionReady && epoch === completionEpoch) {
      statusText.textContent = returnTarget
        ? '暂时无法切换到来源网页。请手动返回网页，或点击按钮重试。'
        : '暂时无法打开使用方法。请点击本页上方的“使用说明”，或点击按钮重试。'
    }
  } finally {
    if (completionReady && epoch === completionEpoch) startWriting.disabled = false
  }
})

function abortable(promise, signal) {
  return new Promise((resolve, reject) => {
    const aborted = () => reject(new Error('timeout'))
    signal.addEventListener('abort', aborted, { once: true })
    if (signal.aborted) aborted()
    Promise.resolve(promise).then(value => {
      signal.removeEventListener('abort', aborted)
      resolve(value)
    }, error => {
      signal.removeEventListener('abort', aborted)
      reject(error)
    })
  })
}

async function check() {
  if (typeof Translator === 'undefined') {
    statusText.textContent = '当前浏览器没有本机翻译能力。请使用桌面 Chrome 138 或更新版本。'
    return
  }
  try {
    const state = await Translator.availability(languages)
    if (state === 'unavailable') {
      statusText.textContent = `当前设备或浏览器策略不支持${languagePair}语言包。请检查 Chrome 更新及管理策略。`
      return
    }
    statusText.textContent = state === 'available' ? '语言包可用，点击下方按钮验证。' : '支持本机翻译，点击下方按钮准备语言包。'
    prepare.disabled = false
  } catch {
    statusText.textContent = '暂时无法检查语言包。请刷新本页重试。'
  }
}

prepare.addEventListener('click', async () => {
  setCompletionState(false)
  const controller = new AbortController()
  activeController = controller
  prepare.disabled = true
  cancel.hidden = false
  progress.hidden = false
  progress.value = 0
  sample.textContent = ''
  statusText.textContent = `正在准备${languagePair}语言包，请保持本页打开…`
  let translator
  let lastLoaded = 0
  let downloading = true
  let idleTimer
  let verificationTimer
  const renewIdle = () => {
    clearTimeout(idleTimer)
    idleTimer = setTimeout(() => controller.abort(), 120000)
  }
  // 持续下载可超过两分钟；停滞与总时长仍有上限。
  renewIdle()
  const totalTimer = setTimeout(() => controller.abort(), 600000)
  const clearDownloadTimers = () => { downloading = false; clearTimeout(idleTimer); clearTimeout(totalTimer) }
  try {
    const creation = Translator.create({
      ...languages,
      signal: controller.signal,
      monitor(monitor) {
        monitor.addEventListener('downloadprogress', event => {
          if (!downloading || activeController !== controller || controller.signal.aborted || !Number.isFinite(event.loaded) || event.loaded <= lastLoaded) return
          lastLoaded = event.loaded
          renewIdle()
          progress.value = lastLoaded
          statusText.textContent = `正在准备语言包 ${Math.round(lastLoaded * 100)}%…`
        })
      }
    }).then(instance => {
      if (activeController !== controller || controller.signal.aborted) {
        instance.destroy()
        throw new Error('timeout')
      }
      return instance
    })
    translator = await abortable(creation, controller.signal)
    clearDownloadTimers()
    if (activeController !== controller || controller.signal.aborted) return
    verificationTimer = setTimeout(() => controller.abort(), 30000)
    const translated = await abortable(translator.translate(verificationSource, { signal: controller.signal }), controller.signal)
    if (activeController !== controller) return
    if (controller.signal.aborted) throw new Error('timeout')
    if (!translated.trim() || (isReading ? !/\p{Script=Han}/u.test(translated) : /\p{Script=Han}/u.test(translated))) throw new Error('verification')
    progress.value = 1
    statusText.textContent = isReading ? '本机英译中已准备完成，可以返回网页选中英文并翻译。' : '本机翻译已准备完成，可以返回网页使用。'
    sample.textContent = `本机验证：${verificationSource} → ${translated}`
    setCompletionState(true)
  } catch (error) {
    if (activeController === controller) {
      setCompletionState(false)
      const reason = controller.signal.aborted ? '准备超时。请检查下载网络，保持本页打开后重试。' :
        error?.message === 'verification' ? (isReading ? '英文验证句没有中文译文，英译中语言包尚不能正确翻译。请重试。' : '验证句仍有中文或没有译文，语言包尚不能正确翻译。请重试。') :
        error?.name === 'NotAllowedError' ? '浏览器未允许本机翻译。请点击按钮重试，并检查设备管理策略。' :
        '请检查语言包下载网络、Chrome 更新和设备管理策略后重试。'
      statusText.textContent = `准备或验证未完成。${reason}草稿没有上传，也未切换到云端。`
    }
  } finally {
    clearDownloadTimers()
    clearTimeout(verificationTimer)
    translator?.destroy()
    if (activeController === controller) {
      activeController = undefined
      prepare.disabled = false
      if (!completionReady) prepare.textContent = '重新检查并验证'
      cancel.hidden = true
    }
  }
})

cancel.addEventListener('click', () => {
  setCompletionState(false)
  activeController?.abort()
  activeController = undefined
  prepare.disabled = false
  cancel.hidden = true
  progress.hidden = true
  statusText.textContent = '已取消。需要时可重新准备语言包。'
})

void check()
