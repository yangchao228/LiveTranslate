/** 工具栏只读检查开关、服务和语言包；下载与验证留在准备页。 */
class PopupManager {
  constructor() {
    this.toggleSwitch = document.getElementById('toggle-switch')
    this.readingToggle = document.getElementById('reading-toggle')
    this.statusText = document.getElementById('status-text')
    this.enabled = undefined
    this.readingEnabled = undefined
    this.provider = undefined
    this.packStates = { 'zh-en': 'checking', 'en-zh': 'checking' }
    this.pageStatus = 'checking'
    this.pageTabId = undefined
    this.pageCheckId = undefined
    this.pageMessage = ''
    this.pageRecovering = false
    this.pageEpoch = 0
    this.translateShortcut = ''
    this.shortcutState = 'checking'
    this.manualBusy = false
    this.stateSaving = false
    this.readingStateSaving = false
    this.readEpoch = 0
    this.readBusy = false
    this.readFailures = new Set()
    // 先绑定设置、帮助与重试，读取失败也保留安全入口。
    this.setupEventListeners()
    void this.refresh()
  }

  /** 独立读取有界等待，不让一个失联入口阻塞其余操作。 */
  async read(task, timeout = 4000) {
    let timer
    try {
      return await Promise.race([
        task,
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('读取超时')), timeout) })
      ])
    } finally {
      clearTimeout(timer)
    }
  }

  async refresh() {
    const epoch = ++this.readEpoch
    this.readBusy = true
    this.enabled = undefined
    this.readingEnabled = undefined
    this.provider = undefined
    this.packStates = { 'zh-en': 'checking', 'en-zh': 'checking' }
    this.pageStatus = 'checking'
    this.pageTabId = undefined
    this.pageCheckId = undefined
    this.pageMessage = ''
    this.pageRecovering = false
    this.translateShortcut = ''
    this.shortcutState = 'checking'
    this.readFailures.clear()
    this.showFeedback('')
    document.getElementById('retry-read').disabled = true
    document.getElementById('translation-mode').textContent = '正在读取服务…'
    document.getElementById('model-status').hidden = true
    this.updateUI()
    await Promise.allSettled([
      this.loadExtensionState(epoch), this.loadConfiguration(epoch), this.loadShortcuts(epoch), this.loadPageStatus(epoch)
    ])
    if (epoch !== this.readEpoch) return
    this.readBusy = false
    this.updateUI()
    document.getElementById('retry-read').hidden = this.readFailures.size === 0
  }

  async loadExtensionState(epoch) {
    try {
      const response = await this.read(chrome.runtime.sendMessage({ type: 'GET_EXTENSION_STATE' }))
      if (epoch !== this.readEpoch) return
      if (!response || typeof response !== 'object') throw new Error('开关状态无效')
      if (typeof response.enabled === 'boolean') this.enabled = response.enabled
      else this.readFailures.add('state')
      // 兼容尚未保存独立偏好的版本，保持既有划词入口默认开启。
      if (response.readingEnabled === undefined && typeof response.enabled === 'boolean') this.readingEnabled = true
      else if (typeof response.readingEnabled === 'boolean') this.readingEnabled = response.readingEnabled
      else this.readFailures.add('reading-state')
      if (typeof response.manualError === 'string' && response.manualError.trim()) {
        this.showFeedback(response.manualError, true)
      }
    } catch {
      if (epoch !== this.readEpoch) return
      this.enabled = undefined
      this.readingEnabled = undefined
      this.readFailures.add('state')
      this.readFailures.add('reading-state')
    }
    this.updateUI()
  }

  async loadConfiguration(epoch) {
    try {
      const response = await this.read(chrome.runtime.sendMessage({ type: 'GET_TRANSLATION_CONFIG' }))
      if (epoch !== this.readEpoch) return
      const provider = response?.config?.provider
      const names = {
        browser: 'Chrome 本机翻译 · 草稿不上传',
        'volcengine-direct': '火山引擎 · 使用你的账号翻译',
        volcengine: '旧版火山代理 · 草稿发送至已配置代理',
        custom: '自定义服务 · 草稿发送至已配置服务'
      }
      if (!Object.prototype.hasOwnProperty.call(names, provider)) throw new Error('服务配置无效')
      this.provider = provider
      document.getElementById('translation-mode').textContent = names[provider]
      this.updateUI()
      if (provider === 'browser') await this.loadLocalStatus(epoch)
    } catch {
      if (epoch !== this.readEpoch) return
      this.provider = undefined
      this.readFailures.add('config')
      document.getElementById('translation-mode').textContent = '暂时无法读取服务，请重试或打开翻译设置。'
      this.updateUI()
    }
  }

  /** 自检只握手；只有用户点恢复才请求补接，不读取草稿。 */
  async loadPageStatus(epoch) {
    const pageEpoch = ++this.pageEpoch
    try {
      const response = await this.read(chrome.runtime.sendMessage({ type: 'GET_ACTIVE_PAGE_STATUS' }))
      if (epoch !== this.readEpoch || pageEpoch !== this.pageEpoch) return
      this.acceptPageStatus(response)
    } catch {
      if (epoch !== this.readEpoch || pageEpoch !== this.pageEpoch) return
      this.pageStatus = 'unknown'
      this.pageTabId = undefined
      this.pageCheckId = undefined
      this.pageMessage = '检查未完成，可重试；也可直接手动翻译。'
    }
    this.updateUI()
  }

  acceptPageStatus(response, expectedTabId) {
    const statuses = ['ready', 'needs-recovery', 'restricted', 'unknown']
    if (!response?.success || !statuses.includes(response.status)) throw new Error('网页状态无效')
    const tabId = Number.isSafeInteger(response.tabId) && response.tabId >= 0 ? response.tabId : undefined
    const checkId = typeof response.checkId === 'string' && response.checkId.trim() ? response.checkId : undefined
    if (['ready', 'needs-recovery'].includes(response.status) && (tabId === undefined || !checkId)) throw new Error('网页未确认')
    if (expectedTabId !== undefined && tabId !== expectedTabId) throw new Error('原网页已变化')
    this.pageStatus = response.status
    this.pageTabId = tabId
    this.pageCheckId = ['ready', 'needs-recovery'].includes(response.status) ? checkId : undefined
    // 网页/远程正文不用于反馈；仅显示固定的操作建议。
    this.pageMessage = response.status === 'unknown' ? '请重新检查；必要时允许插件访问此网站。' : ''
  }

  async recoverPage() {
    if (this.pageRecovering) return
    if (this.pageStatus !== 'needs-recovery' || !Number.isSafeInteger(this.pageTabId) || !this.pageCheckId) {
      this.pageStatus = 'checking'
      this.updateUI()
      await this.loadPageStatus(this.readEpoch)
      return
    }
    const epoch = this.readEpoch
    const pageEpoch = ++this.pageEpoch
    const expectedTabId = this.pageTabId
    const checkId = this.pageCheckId
    this.pageRecovering = true
    this.pageMessage = ''
    this.updateUI()
    try {
      const response = await this.read(chrome.runtime.sendMessage({ type: 'RECOVER_ACTIVE_PAGE', expectedTabId, checkId }), 12000)
      if (epoch !== this.readEpoch || pageEpoch !== this.pageEpoch) return
      this.acceptPageStatus(response, expectedTabId)
      if (this.pageStatus !== 'ready') this.pageMessage = '未能接入，请重试或允许插件访问此网站。'
    } catch {
      if (epoch !== this.readEpoch || pageEpoch !== this.pageEpoch) return
      this.pageStatus = 'unknown'
      this.pageTabId = undefined
      this.pageCheckId = undefined
      this.pageMessage = '接入未确认，请重新检查或允许插件访问此网站。'
    } finally {
      if (epoch === this.readEpoch && pageEpoch === this.pageEpoch) {
        this.pageRecovering = false
        this.updateUI()
      }
    }
  }

  /** availability 仅说明语言包状态，不创建模型，也不等同真实译文验证。 */
  async loadLocalStatus(epoch) {
    if (!globalThis.Translator || typeof globalThis.Translator.availability !== 'function') {
      this.packStates = { 'zh-en': 'unsupported', 'en-zh': 'unsupported' }
      this.updateUI()
      return
    }
    await Promise.allSettled(['zh-en', 'en-zh'].map(async direction => {
      const [sourceLanguage, targetLanguage] = direction.split('-')
      try {
        const state = await this.read(globalThis.Translator.availability({ sourceLanguage, targetLanguage }))
        if (epoch !== this.readEpoch || this.provider !== 'browser') return
        if (!['available', 'downloadable', 'downloading', 'unavailable'].includes(state)) throw new Error('语言包状态无效')
        this.packStates[direction] = state
      } catch {
        if (epoch !== this.readEpoch || this.provider !== 'browser') return
        this.packStates[direction] = 'error'
        this.readFailures.add(`model-${direction}`)
      }
      this.updateUI()
    }))
  }

  /** 单一场景缺包时直达对应准备页，双开时不猜测用户的翻译目标。 */
  manualAction() {
    const directions = [this.enabled === true && 'zh-en', this.readingEnabled === true && 'en-zh'].filter(Boolean)
    if (!directions.length || !this.provider) return { disabled: true }
    if (this.provider !== 'browser') return { disabled: false }
    const ready = directions.some(direction => this.packStates[direction] === 'available')
    if (ready) return { disabled: false }
    if (directions.length === 1 && ['downloadable', 'downloading', 'error'].includes(this.packStates[directions[0]])) {
      return { disabled: false, prepare: directions[0] }
    }
    return { disabled: true, packages: true }
  }

  updatePageUI() {
    const labels = { checking: '正在检查当前网页…', ready: '当前网页已接入', 'needs-recovery': '当前网页需要重新接入', restricted: '此页面不支持翻译', unknown: '当前网页尚未确认' }
    const section = document.getElementById('page-health')
    section.dataset.state = this.pageStatus
    document.getElementById('page-status').textContent = this.pageRecovering ? '正在重新接入…' : labels[this.pageStatus]
    const action = document.getElementById('recover-page')
    action.hidden = ['checking', 'ready', 'restricted'].includes(this.pageStatus)
    action.disabled = this.pageRecovering
    action.textContent = this.pageRecovering ? '接入中…' : this.pageStatus === 'needs-recovery' ? '重新接入' : '重新检查'
    action.setAttribute('aria-busy', String(this.pageRecovering))
    const hint = document.getElementById('page-hint')
    hint.textContent = this.pageStatus === 'restricted' ? '请切换到普通网页后使用。' : this.pageMessage
    hint.hidden = !hint.textContent
  }

  updatePackUI() {
    const local = this.provider === 'browser'
    document.getElementById('model-status').hidden = !local
    document.getElementById('model-status').dataset.compact = String(Object.values(this.packStates).every(state => state === 'available'))
    const labels = { checking: '检查中', available: '已下载', downloadable: '需要准备', downloading: '下载中', unavailable: '不可用', unsupported: '不支持', error: '检查失败' }
    for (const [direction, id, title] of [['zh-en', 'writing-pack-status', '中译英'], ['en-zh', 'reading-pack-status', '英译中']]) {
      const state = this.packStates[direction]
      const element = document.getElementById(id)
      element.textContent = labels[state]
      element.dataset.error = String(['unavailable', 'unsupported', 'error'].includes(state))
      const action = document.getElementById(direction === 'zh-en' ? 'prepare-translation' : 'prepare-reading')
      action.hidden = !local || ['checking', 'unavailable', 'unsupported'].includes(state)
      action.textContent = state === 'available' ? '验证' : state === 'downloading' ? '查看进度' : '准备'
      action.setAttribute('aria-label', `${action.textContent}${title}语言包`)
    }
    const unavailable = Object.values(this.packStates).every(state => ['unavailable', 'unsupported'].includes(state))
    const note = document.getElementById('model-note')
    note.textContent = unavailable ? '当前浏览器或设备不支持这两个语言包，可选择其他服务。' : ''
    note.hidden = !local || !note.textContent
  }

  async loadShortcuts(epoch) {
    try {
      const commands = await this.read(chrome.commands.getAll())
      if (epoch !== this.readEpoch) return
      if (!Array.isArray(commands)) throw new Error('快捷键列表无效')
      const shortcut = name => {
        const value = commands.find(command => command.name === name)?.shortcut
        return typeof value === 'string' ? value.trim() : ''
      }
      this.translateShortcut = shortcut('translate_selection')
      this.shortcutState = this.translateShortcut ? 'bound' : 'unbound'
      document.getElementById('toggle-shortcut').textContent = `输入中译英：${shortcut('toggle_extension') || '未设置'}`
      document.getElementById('reading-shortcut').textContent = `划词英译中：${shortcut('toggle_reading') || '未设置'}`
      document.getElementById('translate-shortcut').textContent = `手动翻译：${this.translateShortcut || '未设置'}`
    } catch {
      if (epoch !== this.readEpoch) return
      this.translateShortcut = ''
      this.shortcutState = 'error'
      this.readFailures.add('shortcuts')
      document.getElementById('toggle-shortcut').textContent = '输入中译英快捷键读取失败，可打开快捷键设置查看。'
      document.getElementById('reading-shortcut').textContent = '划词英译中快捷键读取失败，可打开快捷键设置查看。'
      document.getElementById('translate-shortcut').textContent = '翻译快捷键读取失败，可打开快捷键设置查看。'
    }
    this.updateUI()
  }

  setupEventListeners() {
    document.getElementById('translation-settings').addEventListener('click', () => {
      void this.openPage(() => chrome.runtime.openOptionsPage())
    })
    document.getElementById('user-guide').addEventListener('click', () => {
      void this.openPage(() => chrome.tabs.create({ url: chrome.runtime.getURL('help/user-guide.html') }))
    })
    document.getElementById('prepare-translation').addEventListener('click', () => { void this.openPreparation('zh-en') })
    document.getElementById('prepare-reading').addEventListener('click', () => { void this.openPreparation('en-zh') })
    document.getElementById('recover-page').addEventListener('click', () => { void this.recoverPage() })
    document.getElementById('retry-read').addEventListener('click', () => { void this.refresh() })
    document.getElementById('configure-shortcuts').addEventListener('click', () => {
      void this.openPage(() => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }))
    })
    document.getElementById('bind-translate-shortcut').addEventListener('click', () => {
      void this.openPage(() => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }))
    })
    document.getElementById('translate-now').addEventListener('click', () => { void this.translate() })
    this.toggleSwitch.addEventListener('change', event => { void this.setEnabled(event.target.checked) })
    this.readingToggle.addEventListener('change', event => { void this.setReadingEnabled(event.target.checked) })
  }

  async openPage(open) {
    try { await open() }
    catch { this.showFeedback('页面未能打开，请重试。', true) }
  }

  /** 仅传来源标签页 ID，不向准备页暴露 URL 或草稿。 */
  async openPreparation(direction) {
    const url = new URL(chrome.runtime.getURL('setup/setup.html'))
    url.searchParams.set('direction', direction === 'en-zh' ? 'en-zh' : 'zh-en')
    try {
      const tabs = await this.read(chrome.tabs.query({ active: true, currentWindow: true }))
      if (Number.isSafeInteger(tabs[0]?.id) && tabs[0].id >= 0) url.searchParams.set('returnTab', String(tabs[0].id))
    } catch {
      // 来源读取失败仍可准备语言包，只是不提供返回原网页入口。
    }
    await this.openPage(() => chrome.tabs.create({ url: url.href }))
  }

  async translate() {
    const action = this.manualAction()
    if (action.disabled || this.manualBusy || this.stateSaving || this.readingStateSaving || this.pageStatus === 'restricted') return
    if (action.prepare) {
      await this.openPreparation(action.prepare)
      return
    }
    this.manualBusy = true
    this.updateUI()
    this.showFeedback('正在定位网页中的选区或草稿…')
    try {
      const result = await this.read(chrome.runtime.sendMessage({ type: 'TRANSLATE_ACTIVE_EDITOR' }), 12000)
      if (result?.success) window.close()
      else this.showFeedback(result?.error || '请先选择网页正文英文，或点击已开启翻译的输入框。', true)
    } catch {
      this.showFeedback('无法连接网页，请在上方重新检查并接入。', true)
    } finally {
      this.manualBusy = false
      this.updateUI()
    }
  }

  async setEnabled(enabled) {
    if (typeof this.enabled !== 'boolean' || this.stateSaving) return
    const previous = this.enabled
    const hadFocus = document.activeElement === this.toggleSwitch
    this.stateSaving = true
    this.updateUI()
    try {
      const result = await this.read(chrome.runtime.sendMessage({ type: 'SET_EXTENSION_STATE', enabled }))
      if (!result?.success) throw new Error('开关状态未保存')
      this.enabled = enabled
      this.showFeedback(enabled ? '输入中译英已开启，可自动或手动翻译草稿。' :
        this.readingEnabled === true ? '输入中译英已关闭，划词英译中可继续使用。' : '输入中译英已关闭。')
    } catch {
      this.enabled = previous
      this.showFeedback('开关未能更新，已保留原状态。请重试。', true)
    } finally {
      this.stateSaving = false
      this.updateUI()
      // 保存时禁用开关会失焦；未转向其他控件时恢复键盘位置。
      if (hadFocus && document.activeElement === document.body) this.toggleSwitch.focus()
    }
  }

  async setReadingEnabled(enabled) {
    if (typeof this.readingEnabled !== 'boolean' || this.readingStateSaving) return
    const previous = this.readingEnabled
    const hadFocus = document.activeElement === this.readingToggle
    this.readingStateSaving = true
    this.updateUI()
    try {
      const result = await this.read(chrome.runtime.sendMessage({ type: 'SET_READING_STATE', enabled }))
      if (!result?.success || typeof result.enabled !== 'boolean') throw new Error('划词状态未保存')
      this.readingEnabled = result.enabled
      this.showFeedback(this.readingEnabled ? '划词英译中已开启，选中网页正文英文后可翻译。' :
        this.enabled === true ? '划词英译中已关闭，输入中译英仍可使用。' : '划词英译中已关闭。')
    } catch {
      this.readingEnabled = previous
      this.showFeedback('划词开关未能更新，已保留原状态。请重试。', true)
    } finally {
      this.readingStateSaving = false
      this.updateUI()
      if (hadFocus && document.activeElement === document.body) this.readingToggle.focus()
    }
  }

  updateUI() {
    const known = typeof this.enabled === 'boolean'
    this.toggleSwitch.checked = this.enabled === true
    this.toggleSwitch.disabled = !known || this.stateSaving
    this.toggleSwitch.setAttribute('aria-busy', String(this.stateSaving))
    this.statusText.textContent = known ? (this.enabled ? '已开启' : '已关闭') : (this.readFailures.has('state') ? '读取失败' : '正在读取')
    this.statusText.className = this.enabled === true ? 'enabled' : 'disabled'
    document.getElementById('status-detail').textContent = !known ? '未确认状态前，暂不翻译输入草稿。' :
      this.enabled ? '中文整句自动翻译，也可手动翻译草稿' : '已停止自动和手动翻译输入草稿。'
    const readingKnown = typeof this.readingEnabled === 'boolean'
    this.readingToggle.checked = this.readingEnabled === true
    this.readingToggle.disabled = !readingKnown || this.readingStateSaving
    this.readingToggle.setAttribute('aria-busy', String(this.readingStateSaving))
    document.getElementById('reading-state').textContent = readingKnown ? (this.readingEnabled ? '已开启' : '已关闭') :
      this.readFailures.has('reading-state') ? '读取失败' : '正在读取'
    document.getElementById('reading-detail').textContent = !readingKnown ?
      (this.readFailures.has('reading-state') ? '请重试读取划词状态。' : '正在确认划词翻译状态…') :
      this.readingEnabled ? '选中正文英文后，点“翻译成中文”。' : '关闭后不再显示划词入口。'
    const hasEnabledFeature = this.enabled === true || this.readingEnabled === true
    const action = this.manualAction()
    const preparing = Boolean(action.prepare)
    const button = document.getElementById('translate-now')
    document.getElementById('translate-label').textContent = preparing ? `准备${action.prepare === 'en-zh' ? '英译中' : '中译英'}` : '手动翻译'
    const primaryShortcut = document.getElementById('primary-shortcut')
    primaryShortcut.hidden = preparing || this.shortcutState !== 'bound'
    primaryShortcut.textContent = this.translateShortcut
    primaryShortcut.title = this.translateShortcut
    button.disabled = action.disabled || this.manualBusy || this.stateSaving || this.readingStateSaving || this.pageStatus === 'restricted'
    button.setAttribute('aria-busy', String(this.manualBusy))
    document.getElementById('shortcut-status').hidden = preparing || !['unbound', 'error'].includes(this.shortcutState)
    document.getElementById('shortcut-status-text').textContent = this.shortcutState === 'error' ?
      '暂时无法读取快捷键，可打开设置查看。' :
      !hasEnabledFeature ? '快捷键未设置，可在设置中添加。' :
      this.provider && !button.disabled && !preparing ?
        '快捷键未设置，仍可点击按钮翻译。' : '快捷键未设置。'
    document.getElementById('translate-hint').textContent = !hasEnabledFeature ?
      (!known || !readingKnown ? '请先确认翻译开关状态，可重试读取。' : '先开启输入中译英或划词英译中，再使用手动翻译。') :
      !this.provider ? '请重试读取服务，或打开翻译设置。' :
      this.pageStatus === 'restricted' ? '请切换到普通网页后使用。' :
      preparing ? '先在准备页下载并验证这个方向的语言包。' :
      action.packages ? '请查看下方语言包状态，准备所需方向或选择其他服务。' :
      this.enabled !== true ? (known ? '选中网页正文英文后手动翻译；输入中译英未开启。' : '选中网页正文英文后手动翻译；输入中译英状态未确认。') :
      this.readingEnabled !== true ? (readingKnown ? '翻译输入框中的中文草稿；划词英译中未开启。' : '翻译输入框中的中文草稿；划词英译中状态未确认。') :
      '正文选区英译中，输入草稿中译英。'
    this.updatePageUI()
    this.updatePackUI()
    document.getElementById('retry-read').disabled = this.stateSaving || this.readingStateSaving || this.readBusy
  }

  showFeedback(message, isError = false) {
    const feedback = document.getElementById('feedback')
    feedback.className = isError ? 'feedback error' : 'feedback'
    feedback.textContent = message
  }
}

document.addEventListener('DOMContentLoaded', () => { new PopupManager() })
