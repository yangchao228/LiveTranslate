const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const popupSource = fs.readFileSync(path.join(__dirname, '../src/popup/popup.js'), 'utf8');
const popupHtml = fs.readFileSync(path.join(__dirname, '../src/popup/popup.html'), 'utf8');
const settle = async () => { await new Promise(resolve => setImmediate(resolve)); };

// 执行真实工具栏脚本；DOM 从实际 HTML 建立，缺失 ID 不会由替身自动补齐。
async function popup(options = {}) {
  const elements = new Map();
  let document, onLoad, closed = false;
  const makeElement = (id, attributes) => {
    let disabled = /\bdisabled(?:\s|$)/.test(attributes);
    return {
      id, textContent: '', hidden: /\bhidden(?:\s|$)/.test(attributes), checked: false,
      dataset: {}, style: {}, listeners: {},
      get disabled() { return disabled; },
      set disabled(value) {
        disabled = value;
        if (value && document?.activeElement === this) document.activeElement = document.body;
      },
      setAttribute(name, value) { this[name] = value; },
      addEventListener(name, listener) { this.listeners[name] = listener; },
      focus() { document.activeElement = this; }
    };
  };
  for (const match of popupHtml.matchAll(/<[a-z][^<>]*\bid="([^"]+)"[^<>]*>/gi)) {
    assert.equal(elements.has(match[1]), false, `重复 DOM ID：${match[1]}`);
    elements.set(match[1], makeElement(match[1], match[0]));
  }
  const get = id => {
    assert.ok(elements.has(id), `真实 HTML 缺少控件：${id}`);
    return elements.get(id);
  };
  document = {
    getElementById: get,
    addEventListener(name, listener) { assert.equal(name, 'DOMContentLoaded'); onLoad = listener; },
    body: {}, activeElement: null
  };
  document.activeElement = document.body;
  const messages = [], urls = [], availabilityCalls = [];
  const chrome = {
    commands: {
      async getAll() {
        if (options.commandsFailure) throw new Error('快捷键读取失败');
        return options.commands ?? [{ name: 'toggle_extension', shortcut: 'Alt+T' }, { name: 'translate_selection', shortcut: 'Ctrl+Shift+Y' }];
      }
    },
    runtime: {
      getURL: pathname => `chrome-extension://test/${pathname}`,
      async openOptionsPage() { urls.push('options'); },
      async sendMessage(message) {
        messages.push(message);
        if (message.type === 'GET_TRANSLATION_CONFIG') {
          if (options.configFailure) throw new Error('配置不可用');
          return { success: true, config: { provider: options.provider || 'browser' } };
        }
        if (message.type === 'GET_EXTENSION_STATE') {
          if (options.stateFailure) return { success: false, error: '开关不可用' };
          return { enabled: options.enabled ?? true, readingEnabled: options.readingEnabled ?? true, manualError: options.manualError };
        }
        if (message.type === 'SET_EXTENSION_STATE') return options.saveState ? options.saveState(message.enabled) : { success: true };
        if (message.type === 'GET_ACTIVE_PAGE_STATUS') return options.pageResponse || { success: true, status: 'ready', tabId: 73, checkId: 'fixture-check' };
        if (message.type === 'RECOVER_ACTIVE_PAGE') return { success: true, status: 'ready', tabId: message.expectedTabId, checkId: 'fixture-check' };
        if (message.type === 'EDGE_LOCAL_STATUS') return { success: true, status: { phase: options.edgePhase || 'cached' } };
        if (message.type === 'TRANSLATE_ACTIVE_EDITOR') return { success: true };
        throw new Error(`工具栏发出了未授权消息：${message.type}`);
      }
    },
    tabs: {
      async query(query) {
        assert.equal(JSON.stringify(query), JSON.stringify({ active: true, currentWindow: true }));
        if (options.tabsFailure) throw new Error('无法获取来源');
        return [{ id: 73, url: 'https://example.invalid/private-draft' }];
      },
      async create(value) { urls.push(value.url); }
    }
  };
  const Translator = options.noTranslator ? undefined : {
    async availability(languages) {
      availabilityCalls.push(languages);
      if (options.availabilityFailure) throw new Error('无法检查');
      return languages.sourceLanguage === 'en' ? (options.readingAvailability || 'available') : (options.availability || 'available');
    },
    create() { throw new Error('工具栏禁止创建模型或触发下载'); }
  };
  vm.runInNewContext(popupSource, {
    document, chrome, Translator, navigator: { userAgent: options.edge ? 'Edg/155.0' : 'Chrome/155.0' },
    window: { close() { closed = true; } }, URL, setTimeout, clearTimeout, console
  });
  onLoad();
  await settle();
  return {
    get, messages, urls, availabilityCalls, document, get closed() { return closed; },
    async click(id) { if (!get(id).disabled) get(id).listeners.click(); await settle(); },
    async toggle(enabled) { const target = get('toggle-switch'); target.checked = enabled; target.focus(); target.listeners.change({ target }); await settle(); }
  };
}

test('默认 Alt+R 手动翻译、Alt+T 启停，不绑定激活扩展且不新增权限', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../src/manifest.json')));
  assert.equal(manifest.commands.translate_selection.suggested_key.default, 'Alt+R');
  assert.equal(manifest.commands.toggle_extension.suggested_key.default, 'Alt+T');
  assert.equal(manifest.commands._execute_action, undefined);
  assert.notEqual(manifest.commands.translate_selection.global, true);
  assert.notEqual(manifest.commands.toggle_extension.global, true);
  assert.deepEqual(manifest.permissions, ['activeTab', 'storage', 'scripting']);
});

test('工具栏显示真实绑定，按钮经后台路由，安全入口先行可用', async () => {
  const ui = await popup();
  assert.equal(ui.get('toggle-shortcut').textContent, '输入中译英：Alt+T');
  assert.equal(ui.get('primary-shortcut').textContent, 'Ctrl+Shift+Y');
  assert.equal(ui.get('primary-shortcut').hidden, false);
  assert.equal(ui.get('shortcut-status').hidden, true);
  assert.equal(ui.get('translate-shortcut').textContent, '手动翻译：Ctrl+Shift+Y');
  await ui.click('translate-now');
  assert.equal(ui.messages.at(-1).type, 'TRANSLATE_ACTIVE_EDITOR');
  assert.equal(ui.closed, true);
  await ui.click('configure-shortcuts');
  await ui.click('translation-settings');
  await ui.click('user-guide');
  assert.deepEqual(ui.urls, ['chrome://extensions/shortcuts', 'options', 'chrome-extension://test/help/user-guide.html']);
  assert.equal(ui.messages.some(message => message.type === 'GET_TRANSLATION_SETTINGS'), false);
});

test('语言包状态只读且不冒充真实验证，准备来源仅传标签页 ID', async () => {
  const ui = await popup();
  assert.equal(ui.availabilityCalls.length, 2);
  assert.equal(JSON.stringify(ui.availabilityCalls[0]), JSON.stringify({ sourceLanguage: 'zh', targetLanguage: 'en' }));
  assert.equal(ui.get('writing-pack-status').textContent, '已下载');
  assert.equal(ui.get('reading-pack-status').textContent, '已下载');
  assert.doesNotMatch(ui.get('writing-pack-status').textContent, /验证成功|验证通过/);
  assert.equal(JSON.stringify(ui.availabilityCalls[1]), JSON.stringify({ sourceLanguage: 'en', targetLanguage: 'zh' }));
  await ui.click('prepare-translation');
  assert.equal(ui.urls.at(-1), 'chrome-extension://test/setup/setup.html?direction=zh-en&returnTab=73');
  assert.equal(ui.urls.some(url => /private-draft/.test(url)), false);
  const noSource = await popup({ tabsFailure: true });
  await noSource.click('prepare-translation');
  assert.equal(noSource.urls.at(-1), 'chrome-extension://test/setup/setup.html?direction=zh-en');
});

test('尚未下载时主入口准备语言包，暂停时手动翻译不发请求', async () => {
  const missing = await popup({ availability: 'downloadable', readingEnabled: false, commands: [] });
  assert.equal(missing.get('translate-label').textContent, '准备中译英');
  assert.equal(missing.get('primary-shortcut').hidden, true);
  assert.equal(missing.get('shortcut-status').hidden, true, '准备语言包时不显示翻译快捷键提示');
  await missing.click('translate-now');
  assert.match(missing.urls.at(-1), /setup\.html\?direction=zh-en&returnTab=73$/);
  assert.equal(missing.messages.some(message => message.type === 'TRANSLATE_ACTIVE_EDITOR'), false);
  const paused = await popup({ enabled: false, readingEnabled: false, commands: [] });
  assert.equal(paused.get('translate-now').disabled, true);
  assert.match(paused.get('status-detail').textContent, /已停止自动和手动翻译输入草稿/);
  assert.equal(paused.get('shortcut-status').hidden, false);
  assert.equal(paused.get('shortcut-status-text').textContent, '快捷键未设置，可在设置中添加。');
  await paused.click('bind-translate-shortcut');
  assert.equal(paused.urls.at(-1), 'chrome://extensions/shortcuts', '暂停时仍能直接设置快捷键');
  await paused.click('translate-now');
  assert.equal(paused.messages.some(message => message.type === 'TRANSLATE_ACTIVE_EDITOR'), false);
});

test('读取状态失败不伪装启用，配置和快捷键失败仍保留设置帮助与重试', async () => {
  const ui = await popup({ stateFailure: true, configFailure: true, commandsFailure: true });
  assert.equal(ui.get('toggle-switch').checked, false);
  assert.equal(ui.get('toggle-switch').disabled, true);
  assert.equal(ui.get('status-text').textContent, '读取失败');
  assert.equal(ui.get('translate-now').disabled, true);
  assert.equal(ui.get('retry-read').hidden, false);
  assert.equal(ui.get('primary-shortcut').hidden, true);
  assert.equal(ui.get('primary-shortcut').textContent, '');
  assert.match(ui.get('shortcut-status-text').textContent, /无法读取快捷键/);
  assert.doesNotMatch(ui.get('shortcut-status-text').textContent, /未设置/);
  await ui.click('translation-settings');
  await ui.click('user-guide');
  assert.deepEqual(ui.urls, ['options', 'chrome-extension://test/help/user-guide.html']);
});

test('未设置或空白快捷键独立提示，仍可直接点击翻译和设置快捷键', async () => {
  for (const commands of [[], [{ name: 'translate_selection', shortcut: '' }], [{ name: 'translate_selection', shortcut: '   ' }]]) {
    const ui = await popup({ commands });
    assert.equal(ui.get('primary-shortcut').hidden, true);
    assert.equal(ui.get('primary-shortcut').textContent, '', '主按钮不显示状态或假默认快捷键');
    assert.equal(ui.get('shortcut-status').hidden, false);
    assert.equal(ui.get('shortcut-status-text').textContent, '快捷键未设置，仍可点击按钮翻译。');
    assert.equal(ui.get('translate-shortcut').textContent, '手动翻译：未设置');
    assert.equal(ui.get('translate-now').disabled, false);
    await ui.click('bind-translate-shortcut');
    assert.equal(ui.urls.at(-1), 'chrome://extensions/shortcuts');
    await ui.click('translate-now');
    assert.equal(ui.messages.at(-1).type, 'TRANSLATE_ACTIVE_EDITOR');
    assert.equal(ui.closed, true);
  }
});

test('快捷键读取失败不冒称未设置，重试后显示真实绑定并移除恢复提示', async () => {
  const options = { commandsFailure: true };
  const ui = await popup(options);
  assert.equal(ui.get('primary-shortcut').hidden, true);
  assert.equal(ui.get('shortcut-status').hidden, false);
  assert.match(ui.get('shortcut-status-text').textContent, /无法读取快捷键/);
  assert.doesNotMatch(ui.get('shortcut-status-text').textContent, /未设置/);
  assert.equal(ui.get('translate-now').disabled, false);
  await ui.click('bind-translate-shortcut');
  assert.equal(ui.urls.at(-1), 'chrome://extensions/shortcuts');
  options.commandsFailure = false;
  options.commands = [{ name: 'translate_selection', shortcut: '  Ctrl+Shift+U  ' }];
  await ui.click('retry-read');
  assert.equal(ui.get('primary-shortcut').hidden, false);
  assert.equal(ui.get('primary-shortcut').textContent, 'Ctrl+Shift+U');
  assert.equal(ui.get('shortcut-status').hidden, true);
  assert.equal(ui.get('retry-read').hidden, true);
});

test('本机不支持时提示其他服务，Edge 仅查询状态，后台快捷键提示可见', async () => {
  const unsupported = await popup({ noTranslator: true });
  assert.equal(unsupported.get('translate-now').disabled, true);
  assert.match(unsupported.get('model-note').textContent, /选择其他服务/);
  assert.equal(unsupported.get('writing-pack-status').textContent, '不支持');
  assert.equal(unsupported.get('reading-pack-status').textContent, '不支持');

});

test('异步开关保存前禁止翻译，失败回退并恢复原键盘焦点', async () => {
  let rejectSave;
  const ui = await popup({ saveState: () => new Promise((_resolve, reject) => { rejectSave = reject; }) });
  await ui.toggle(false);
  assert.equal(ui.get('toggle-switch').disabled, true);
  assert.equal(ui.get('translate-now').disabled, true);
  assert.equal(ui.document.activeElement, ui.document.body);
  rejectSave(new Error('同步存储失败'));
  await settle();
  assert.equal(ui.get('toggle-switch').checked, true);
  assert.equal(ui.get('toggle-switch').disabled, false);
  assert.equal(ui.document.activeElement, ui.get('toggle-switch'));
  assert.match(ui.get('feedback').textContent, /已保留原状态/);
});


test('划词独开缺包时只准备英译中，远程服务不检查本机包', async () => {
  const reading = await popup({ enabled: false, readingAvailability: 'downloadable' });
  assert.equal(reading.get('translate-label').textContent, '准备英译中');
  await reading.click('translate-now');
  assert.equal(reading.urls.at(-1), 'chrome-extension://test/setup/setup.html?direction=en-zh&returnTab=73');
  assert.equal(reading.messages.some(message => message.type === 'TRANSLATE_ACTIVE_EDITOR'), false);
  for (const provider of ['volcengine-direct', 'volcengine', 'custom']) {
    const remote = await popup({ provider, noTranslator: true });
    assert.equal(remote.availabilityCalls.length, 0);
    assert.equal(remote.get('model-status').hidden, true);
    assert.equal(remote.get('prepare-reading').hidden, true);
    assert.equal(remote.get('prepare-translation').hidden, true);
    assert.equal(remote.get('translate-now').disabled, false);
  }
});

test('网页自检不会补接，失联显式恢复且受限页提供普通网页提示', async () => {
  const healthy = await popup();
  assert.equal(healthy.get('page-status').textContent, '当前网页已接入');
  assert.equal(healthy.get('recover-page').hidden, true);
  assert.equal(healthy.messages.some(message => message.type === 'RECOVER_ACTIVE_PAGE'), false);
  const missing = await popup({ pageResponse: { success: true, status: 'needs-recovery', tabId: 73, checkId: 'fixture-check' } });
  assert.equal(missing.get('recover-page').textContent, '重新接入');
  await missing.click('recover-page');
  assert.equal(missing.get('page-status').textContent, '当前网页已接入');
  assert.equal(JSON.stringify(missing.messages.at(-1)), JSON.stringify({ type: 'RECOVER_ACTIVE_PAGE', expectedTabId: 73, checkId: 'fixture-check' }));
  const restricted = await popup({ pageResponse: { success: true, status: 'restricted' } });
  assert.equal(restricted.get('translate-now').disabled, true);
  assert.match(restricted.get('page-hint').textContent, /普通网页/);
  const unknown = await popup({ pageResponse: { success: false } });
  assert.equal(unknown.get('page-status').textContent, '当前网页尚未确认');
  assert.equal(unknown.get('translate-now').disabled, false, '自检失败不永久封堵既有手动入口');
});
