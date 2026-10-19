const provider = document.getElementById('provider')
const endpoint = document.getElementById('endpoint')
const token = document.getElementById('token')
const accessKey = document.getElementById('access-key')
const secretKey = document.getElementById('secret-key')
const clearKeys = document.getElementById('clear-keys')
const clearToken = document.getElementById('clear-token')
const migrateCredentials = document.getElementById('migrate-credentials')
const clearLegacyCredentials = document.getElementById('clear-legacy-credentials')
const save = document.getElementById('save')
const test = document.getElementById('test')
const statusText = document.getElementById('status')
let settings
let selected = 'browser'
let busy = false
let dirty = false
function status(text, error = false) {
  statusText.textContent = text
  statusText.dataset.error = String(error)
}
function update() {
  const remote = provider.value !== 'browser'
  const direct = provider.value === 'volcengine-direct'
  document.getElementById('direct-info').hidden = !direct
  document.getElementById('legacy-proxy').hidden = !settings?.legacyProxyAvailable
  for (const input of [accessKey, secretKey]) { input.disabled = busy || !direct; input.required = direct }
  clearKeys.disabled = busy || !settings?.volcengineDirect?.accessKey
  clearToken.disabled = busy || !settings?.[provider.value]?.token
  document.getElementById('legacy-credentials').hidden = !settings?.legacyCredentialsPending
  migrateCredentials.disabled = busy
  clearLegacyCredentials.disabled = busy
  document.getElementById('session-status').textContent = settings?.legacyCredentialsPending ? '旧版凭据待处理，远程翻译已暂停。' :
    settings?.credentialsRequired ? '所选远程服务的本次会话凭据未准备。请重新填写并保存；服务不会自动切换。' :
    provider.value === 'browser' ? '草稿在这台电脑翻译，无需填写密钥。' : '凭据仅本次浏览器会话有效，重启或重载后需重新填写。'
  document.getElementById('local-info').hidden = remote
  document.getElementById('remote-info').hidden = !remote || direct
  document.getElementById('remote-description').textContent = provider.value === 'volcengine'
    ? '使用火山机器翻译 API。你需要自行运行代理或填写管理员提供的代理地址；API 费用由该火山账号承担。'
    : '服务需要接受 LiveTranslate 的翻译协议；其他厂商或模型接口可通过适配器接入，详见使用说明。'
  save.textContent = remote ? '保存并授权此服务' : '保存选择'
  test.hidden = !remote
  test.disabled = busy || dirty || provider.value !== settings?.provider || settings?.legacyCredentialsPending || settings?.credentialsRequired
  save.disabled = busy || !settings || (remote && settings.legacyCredentialsPending)
  provider.disabled = busy || !settings
  endpoint.disabled = busy || !remote || direct
  token.disabled = busy || !remote || direct
  endpoint.required = remote && !direct
}
function loadFields() {
  if (provider.value === 'volcengine-direct') {
    accessKey.value = settings.volcengineDirect.accessKey
    secretKey.value = settings.volcengineDirect.secretKey
  } else if (provider.value !== 'browser') {
    endpoint.value = settings[provider.value].endpoint
    token.value = settings[provider.value].token
  }
  selected = provider.value
  update()
}
provider.addEventListener('change', () => {
  if (selected === 'volcengine-direct') settings.volcengineDirect = { accessKey: accessKey.value, secretKey: secretKey.value }
  else if (selected !== 'browser') settings[selected] = { endpoint: endpoint.value, token: token.value }
  dirty = true
  loadFields()
  status('选择尚未保存。保存后会关闭旧译文，下次翻译使用新服务。')
})
for (const input of [endpoint, token, accessKey, secretKey]) input.addEventListener('input', () => {
  dirty = true
  update()
  status('设置已修改，请先保存再测试。')
})
document.getElementById('settings').addEventListener('submit', async event => {
  event.preventDefault()
  if (busy) return
  const choice = provider.value
  const candidate = choice === 'volcengine-direct'
    ? { provider: choice, accessKey: accessKey.value.trim(), secretKey: secretKey.value.trim() }
    : { provider: choice, endpoint: endpoint.value.trim(), token: token.value.trim() }
  busy = true
  update()
  try {
    if (choice === 'volcengine-direct') {
      if (!candidate.accessKey || !candidate.secretKey) throw new Error('请填写自己的 AK 和 SK')
      const granted = await chrome.permissions.request({ origins: ['https://translate.volcengineapi.com/*'] })
      if (!granted) throw new Error('未获得火山访问权限，原设置保持不变；可重新授权或选择本机翻译')
    } else if (choice !== 'browser') {
      const url = new URL(candidate.endpoint)
      if (url.username || url.password || url.search || url.hash ||
          (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname)))) {
        throw new Error('请使用无用户名/查询参数的 HTTPS 地址，或本机 HTTP 地址')
      }
      // 保持在真实点击/提交的用户操作中请求，并且只请求本次选择的主机。
      const granted = await chrome.permissions.request({ origins: [`${url.protocol}//${url.hostname}/*`] })
      if (!granted) throw new Error('未获得服务访问权限，原设置保持不变；可重新授权或选择本机翻译')
    }
    const response = await chrome.runtime.sendMessage({ type: 'SAVE_TRANSLATION_SETTINGS', settings: candidate })
    if (!response?.success) throw new Error(response?.error || '保存失败，请重试')
    settings = response.settings
    dirty = false
    loadFields()
    status(choice === 'browser' ? '已保存：Chrome 本机翻译。下次翻译在本机完成。' : '服务已保存，凭据仅用于本次会话。后续完整中文句将自动发送至所选服务；可点击“测试已保存服务”发送固定句验证。')
  } catch (error) {
    status(error.message || '保存失败，请检查设置', true)
  } finally {
    busy = false
    update()
  }
})
clearKeys.addEventListener('click', async () => {
  if (busy) return
  busy = true; update()
  try {
    const response = await chrome.runtime.sendMessage({ type: 'CLEAR_VOLCENGINE_KEYS' })
    if (!response?.success) throw new Error(response?.error || '清除失败')
    settings = response.settings; provider.value = settings.provider
    accessKey.value = ''; secretKey.value = ''; dirty = false; loadFields()
    status('火山 AK/SK 已从本次会话清除。若原来使用直连，已切回本机翻译。')
  } catch (error) { status(error.message || '清除失败，请重试', true) }
  finally { busy = false; update() }
})
clearToken.addEventListener('click', async () => {
  if (busy) return
  busy = true; update()
  try {
    const response = await chrome.runtime.sendMessage({ type: 'CLEAR_SERVICE_TOKEN', provider: provider.value })
    if (!response?.success) throw new Error(response?.error || '清除失败')
    settings = response.settings; token.value = ''; dirty = false; loadFields()
    status('这个服务的会话令牌已清除。服务选择保持不变；需要鉴权的接口会暂停翻译，请重新填写令牌或切回本机翻译。')
  } catch (error) { status(error.message || '清除失败，请重试', true) }
  finally { busy = false; update() }
})
for (const [button, action] of [[migrateCredentials, 'migrate'], [clearLegacyCredentials, 'clear']]) button.addEventListener('click', async () => {
  if (busy) return
  busy = true; update()
  try {
    const response = await chrome.runtime.sendMessage({ type: 'RESOLVE_LEGACY_CREDENTIALS', action })
    if (!response?.success) throw new Error(response?.error || '旧版凭据处理失败')
    settings = response.settings; provider.value = settings.provider; dirty = false; loadFields()
    status(action === 'migrate' ? '旧版凭据已移入本次会话，并从扩展本机存储删除。可测试所选服务；下次重启或重载需重新填写。' : '旧版凭据已清除，服务地址和选择保留。需要凭据的服务请重新填写，或切回本机翻译。')
  } catch (error) { status(error.message || '旧版凭据处理失败，请重试', true) }
  finally { busy = false; update() }
})
test.addEventListener('click', async () => {
  if (busy || dirty) return
  busy = true
  update()
  status('正在向已保存的服务发送固定测试句…')
  try {
    const response = await chrome.runtime.sendMessage({ type: 'TEST_TRANSLATION_SERVICE' })
    if (!response?.success) throw new Error(response?.error || '测试失败')
    status(`连接和翻译成功。\n测试原文：你好，今天测试翻译服务。\n译文：${response.data.translatedText}`)
  } catch (error) {
    status(error.message || '测试失败，请检查服务', true)
  } finally { busy = false; update() }
})
chrome.runtime.sendMessage({ type: 'GET_TRANSLATION_SETTINGS' }).then(response => {
  if (!response?.success) throw new Error(response?.error || '读取设置失败')
  settings = response.settings
  provider.value = settings.provider
  loadFields()
  status('当前选择已载入。未保存的修改不会生效。')
}).catch(error => status(error.message, true))
