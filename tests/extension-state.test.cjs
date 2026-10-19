const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const path = require('node:path');

// 执行真实后台代码，仅替换 Chrome API；验证页面实际能收到状态，而不只检查存储值。
function background(enabled, localMode = true, options = {}) {
  const hooks = {};
  const data = enabled === undefined ? {} : { enabled };
  const messages = [];
  const opened = [];
  const executions = [], styles = [], readiness = [], queries = [], sequence = [], badges = [], badgeColors = [], titles = [];
  const connectedFrames = new Set();
  const frameResults = [{ frameId: 0, result: { editable: true, focused: true } }];
  const event = name => ({ addListener(fn) { hooks[name] = fn; } });
  const chrome = {
    runtime: {
      id: 'test', getURL: path => `chrome-extension://test/${path}`, onInstalled: event('installed'), onStartup: event('startup'), onMessage: event('message')
    },
    permissions: { onRemoved: event('permissionRemoved'), async contains() { return true; } },
    commands: { onCommand: event('command') },
    action: {
      onClicked: event('clicked'), async setIcon() {},
      async setTitle(value) { titles.push(value); },
      async setBadgeText(value) { badges.push(value); },
      async setBadgeBackgroundColor(value) { badgeColors.push(value); }
    },
    scripting: { async executeScript(value) {
      executions.push(value);
      if (value.files) {
        sequence.push('inject');
        if (options.rejectContent) throw new Error('网站未授予注入权限');
        connectedFrames.add(`${value.target.tabId}:${value.target.frameIds[0]}`);
        return [];
      }
      if (value.args) {
        if (options.rejectNotice) throw new Error('页面禁止注入');
        return [{ frameId: 0 }];
      }
      if (options.rejectInspection) throw new Error('不应透传的页面诊断详情');
      return frameResults;
    }, async insertCSS(value) { styles.push(value); sequence.push('css'); } },
    storage: {
      local: { async setAccessLevel() {}, async get(){ return {}; }, async set() {}, async remove() {} },
      session: { async setAccessLevel() {}, async get(){ return {}; }, async set() {}, async remove() {} },
      onChanged: event('changed'),
      sync: {
        async get() {
          if (options.rejectSyncGet) throw new Error('存储读取失败');
          return { ...data };
        },
        async set(value) {
          if (options.rejectSyncSet) throw new Error('存储写入失败');
          const changes = {};
          for (const key of ['enabled', 'readingEnabled']) {
            if (Object.hasOwn(value, key) && data[key] !== value[key]) changes[key] = { oldValue: data[key], newValue: value[key] };
          }
          Object.assign(data, value);
          if (Object.keys(changes).length) await hooks.changed?.(changes, 'sync');
        }
      }
    },
    tabs: {
      async create(options) { opened.push(options.url); return { id: 4 }; },
      async query(query) {
        queries.push(query);
        return query.url ? options.chatgptTabs || [] : [{ id: 1 }, { id: 2 }, { id: 3 }];
      },
      async sendMessage(tabId, message, sendOptions) {
        if (message.type === 'CONTENT_READY') {
          readiness.push({ tabId, frameId: sendOptions?.frameId });
          sequence.push('ready');
          return { success: !options.contentMissing || connectedFrames.has(`${tabId}:${sendOptions?.frameId}`) };
        }
        if (tabId === 2) throw new Error('页面不允许注入');
        sequence.push(message.type);
        messages.push({ tabId, enabled: message.enabled, type: message.type, frameId: sendOptions?.frameId });
        return { success: true };
      }
    }
  };
  function load(filename) {
    const exports = {};
    const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS }
    }).outputText;
    vm.runInNewContext(code, { exports, require: name => load(path.resolve(path.dirname(filename), name + '.ts')),
      chrome, TextEncoder, navigator: { userAgent: 'Chrome/155.0' },
      __LOCAL_TRANSLATION__: localMode, setTimeout, clearTimeout, console: { log() {}, warn() {}, error() {} } });
    return exports;
  }
  load(path.join(__dirname, '../src/background/background.ts'));
  return { hooks, data, messages, opened, chrome, frameResults, executions, styles, readiness, queries, sequence, badges, badgeColors, titles,
    request: (message, sender = {}) => new Promise(resolve => hooks.message(message, sender, resolve)),
    manual: () => new Promise(resolve => hooks.message({ type: 'TRANSLATE_ACTIVE_EDITOR' }, {}, resolve)),
    set: enabled => new Promise(resolve => hooks.message({ type: 'SET_EXTENSION_STATE', enabled }, {}, resolve)) };
}

test('后台拒绝旧任意 fetch 消息', () => {
  const bg = background(true, false);
  let result;
  const keepAlive = bg.hooks.message({action:'fetch',url:'http://127.0.0.1:8000/api/translate'}, {}, response=>{result=response;});
  assert.equal(keepAlive, false);
  assert.equal(result.success, false);
  assert.match(result.error, /旧代理请求已停用/);
});

test('内容脚本不能读取或保存包含令牌的完整设置', () => {
  const bg = background(true);
  for (const type of ['GET_TRANSLATION_SETTINGS','SAVE_TRANSLATION_SETTINGS','TEST_TRANSLATION_SERVICE','CLEAR_VOLCENGINE_KEYS','CLEAR_SERVICE_TOKEN','RESOLVE_LEGACY_CREDENTIALS']) {
    let result;
    const retained=bg.hooks.message({type}, {id:'test',url:'https://example.com/'}, response=>{result=response;});
    assert.equal(retained,false);assert.equal(result.success,false);assert.match(result.error,/设置页/);
  }
});

test('手动命令发送到当前活动 frame，保留启停状态', async () => {
  const bg = background(true);
  bg.frameResults.push({ frameId: 3, result: { editable: true, focused: false } });
  await bg.hooks.command('translate_selection');
  assert.equal(bg.messages.length, 1);
  assert.equal(bg.messages[0].type, 'TRANSLATE_SELECTION');
  assert.equal(bg.messages[0].frameId, 0);
  assert.equal(bg.data.enabled, true);
});
test('工具栏失焦后仍可定位唯一编辑器', async () => {
  const bg = background(true);
  bg.frameResults[0].result.focused = false;
  assert.equal((await bg.manual()).success, true);
  assert.equal(bg.messages[0].type, 'TRANSLATE_SELECTION');
});
test('多个失焦编辑器时不猜测目标，不广播翻译草稿', async () => {
  const bg = background(true);
  bg.frameResults[0].result.focused = false;
  bg.frameResults.push({ frameId: 2, result: { editable: true, focused: false } });
  assert.equal((await bg.manual()).success, false);
  assert.equal(bg.messages.length, 0);
});
test('禁用时手动翻译不发消息', async () => {
  const bg = background(false);
  assert.equal((await bg.manual()).success, false);
  assert.equal(bg.messages.length, 0);
  assert.equal(bg.readiness.length, 0, '暂停时不为手动翻译重新接入网页');
});

test('手动入口补接原目标 frame，确认就绪后才发送翻译指令', async () => {
  const bg = background(true, true, { contentMissing: true });
  bg.frameResults[0].frameId = 7;
  assert.equal((await bg.manual()).success, true);
  assert.deepEqual(bg.readiness, [{ tabId: 1, frameId: 7 }, { tabId: 1, frameId: 7 }]);
  assert.deepEqual(bg.sequence, ['ready', 'inject', 'css', 'ready', 'TRANSLATE_SELECTION']);
  assert.equal(JSON.stringify(bg.executions.find(value => value.files).target), JSON.stringify({ tabId: 1, frameIds: [7] }));
  assert.equal(JSON.stringify(bg.styles[0].target), JSON.stringify({ tabId: 1, frameIds: [7] }));
  assert.deepEqual(bg.messages, [{ tabId: 1, enabled: undefined, type: 'TRANSLATE_SELECTION', frameId: 7 }]);
});

test('补接权限失败不发翻译指令，不要求刷新或透传诊断详情', async () => {
  const bg = background(true, true, { contentMissing: true, rejectContent: true });
  const result = await bg.manual();
  assert.equal(result.success, false);
  assert.match(result.error, /网站访问权限/);
  assert.doesNotMatch(result.error, /刷新|未授予注入权限/);
  assert.equal(bg.messages.length, 0);
  assert.equal(bg.styles.length, 0);
});

test('工具栏关闭通知全部可用页面，单个受限页面不阻断通知', async () => {
  const bg = background(true);
  assert.equal((await bg.set(false)).success, true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(bg.data.enabled, false);
  assert.deepEqual(bg.messages.map(m => [m.tabId, m.enabled, m.type]), [
    [1, false, 'EXTENSION_STATE_CHANGED'], [3, false, 'EXTENSION_STATE_CHANGED']
  ]);
});
test('快捷键关闭和再次启用都同步页面', async () => {
  const bg = background(true);
  await bg.hooks.command('toggle_extension');
  assert.equal(bg.data.enabled, false);
  await bg.hooks.command('toggle_extension');
  assert.equal(bg.data.enabled, true);
  assert.deepEqual(bg.messages.filter(m => m.tabId === 1).map(m => m.enabled), [false, true]);
});
test('划词快捷键独立双向切换，旧设置默认开启并广播阅读状态', async () => {
  const bg = background(false);
  await bg.hooks.command('toggle_reading');
  assert.equal(bg.data.readingEnabled, false);
  assert.equal(bg.data.enabled, false);
  await bg.hooks.command('toggle_reading');
  assert.equal(bg.data.readingEnabled, true);
  assert.equal(bg.data.enabled, false);
  assert.equal(typeof bg.data.lastUpdated, 'number');
  assert.deepEqual(bg.messages.filter(m => m.tabId === 1).map(m => [m.type, m.enabled]), [
    ['READING_STATE_CHANGED', false], ['READING_STATE_CHANGED', true]
  ]);
  assert.equal(bg.executions.length, 0, '切换不触发翻译或补接');
  await bg.hooks.command('toggle_extension');
  assert.equal(bg.data.enabled, true);
  assert.equal(bg.data.readingEnabled, true, '输入快捷键不改阅读偏好');
});
test('划词快捷键读写失败时不广播假成功、不改变偏好', async () => {
  for (const failure of ['rejectSyncGet', 'rejectSyncSet']) {
    const bg = background(true, true, { [failure]: true });
    await bg.hooks.command('toggle_reading');
    assert.equal(bg.data.enabled, true);
    assert.equal(bg.data.readingEnabled, undefined);
    assert.equal(bg.messages.length, 0);
  }
});
test('重新加载或更新扩展保留关闭状态', async () => {
  const bg = background(false);
  await bg.hooks.installed({ reason: 'update' });
  assert.equal(bg.data.enabled, false);
});
test('更新时补接已打开的 ChatGPT，不改变暂停状态或发送翻译', async () => {
  const bg = background(false, true, { contentMissing: true, chatgptTabs: [{ id: 41 }, { id: 42, discarded: true }] });
  await bg.hooks.installed({ reason: 'update' });
  assert.equal(bg.data.enabled, false);
  assert.equal(JSON.stringify(bg.queries), JSON.stringify([{ url: ['https://chatgpt.com/*'] }]));
  assert.deepEqual(bg.readiness, [{ tabId: 41, frameId: 0 }, { tabId: 41, frameId: 0 }]);
  assert.deepEqual(bg.sequence, ['ready', 'inject', 'css', 'ready']);
  assert.equal(bg.messages.length, 0);
  assert.deepEqual(bg.opened, []);
});

test('浏览器启动补接 ChatGPT；单页注入失败不会成为未处理拒绝', async () => {
  const bg = background(true, true, { contentMissing: true, rejectContent: true, chatgptTabs: [{ id: 51 }] });
  bg.hooks.startup();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(JSON.stringify(bg.queries), JSON.stringify([{ url: ['https://chatgpt.com/*'] }]));
  assert.deepEqual(bg.readiness, [{ tabId: 51, frameId: 0 }]);
  assert.equal(bg.executions.filter(value => value.files).length, 1);
  assert.equal(bg.messages.length, 0);
  assert.equal(bg.data.enabled, true);
});
test('首次安装仍默认启用', async () => {
  const bg = background(undefined);
  await bg.hooks.installed({ reason: 'install' });
  assert.equal(bg.data.enabled, true);
  assert.deepEqual(bg.opened, ['chrome-extension://test/setup/setup.html?welcome=1']);
});
test('更新和浏览器更新不重复打开准备页', async () => {
  const bg = background(true);
  await bg.hooks.installed({ reason: 'update' });
  await bg.hooks.installed({ reason: 'chrome_update' });
  assert.deepEqual(bg.opened, []);
});
test('存储同步变化也通知页面', async () => {
  const bg = background(true);
  await bg.chrome.storage.sync.set({ enabled: false });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(bg.messages.map(m => m.enabled), [false, false]);
});

test('旧设置缺少划词偏好时默认开启，读取同时返回总开关与独立偏好', async () => {
  for (const enabled of [true, false]) {
    const bg = background(enabled);
    const response = await bg.request({ type: 'GET_EXTENSION_STATE' });
    assert.equal(response.enabled, enabled);
    assert.equal(response.readingEnabled, true);
    assert.equal(Object.hasOwn(bg.data, 'readingEnabled'), false, '读取不覆盖旧设置');
  }
});

test('工具栏关闭划词只持久化独立键，并通知所有可用页面', async () => {
  const bg = background(true);
  const result = await bg.request({ type: 'SET_READING_STATE', enabled: false, ignored: 'private' },
    { id: 'test', url: 'chrome-extension://test/popup/popup.html' });
  assert.equal(result.success, true);
  assert.equal(result.enabled, false);
  assert.deepEqual(bg.data, { enabled: true, readingEnabled: false });
  assert.deepEqual(bg.messages.map(message => [message.tabId, message.type, message.enabled]), [
    [1, 'READING_STATE_CHANGED', false], [3, 'READING_STATE_CHANGED', false]
  ]);
});

test('更新、暂停和再次启用总开关均保留关闭的划词偏好', async () => {
  const bg = background(true);
  bg.data.readingEnabled = false;
  await bg.hooks.installed({ reason: 'update' });
  await bg.set(false);
  await bg.set(true);
  const state = await bg.request({ type: 'GET_EXTENSION_STATE' });
  assert.equal(state.enabled, true);
  assert.equal(state.readingEnabled, false);
  assert.equal(bg.messages.some(message => message.type === 'READING_STATE_CHANGED'), false);
});

test('总开关缺失时安装初始化不清除已保存的划词关闭偏好', async () => {
  const bg = background(undefined);
  bg.data.readingEnabled = false;
  await bg.hooks.installed({ reason: 'update' });
  assert.equal(bg.data.enabled, true);
  assert.equal(bg.data.readingEnabled, false);
});

test('暂停期间仍可保存划词偏好而不打开总开关', async () => {
  const bg = background(false);
  const result = await bg.request({ type: 'SET_READING_STATE', enabled: false },
    { id: 'test', url: 'chrome-extension://test/popup/popup.html' });
  assert.equal(result.success, true);
  assert.equal(bg.data.enabled, false);
  assert.equal(bg.data.readingEnabled, false);
});

test('划词设置只接受本扩展工具栏的布尔值请求', async () => {
  const popup = { id: 'test', url: 'chrome-extension://test/popup/popup.html' };
  for (const sender of [{}, { id: 'other', url: popup.url }, { id: 'test', url: 'https://example.com/' },
    { id: 'test', url: 'chrome-extension://test/options/options.html' }]) {
    const bg = background(true);
    const result = await bg.request({ type: 'SET_READING_STATE', enabled: false }, sender);
    assert.equal(result.success, false);
    assert.equal(Object.hasOwn(bg.data, 'readingEnabled'), false);
    assert.equal(bg.messages.length, 0);
  }
  for (const enabled of [undefined, 'false', 0, null]) {
    const bg = background(true);
    const result = await bg.request({ type: 'SET_READING_STATE', enabled }, popup);
    assert.equal(result.success, false);
    assert.equal(Object.hasOwn(bg.data, 'readingEnabled'), false);
  }
});

test('划词存储写入失败不广播或改变状态，读取失败不冒充已启用', async () => {
  const bg = background(true, true, { rejectSyncSet: true });
  const result = await bg.request({ type: 'SET_READING_STATE', enabled: false },
    { id: 'test', url: 'chrome-extension://test/popup/popup.html' });
  assert.equal(result.success, false);
  assert.deepEqual(bg.data, { enabled: true });
  assert.equal(bg.messages.length, 0);
  const unreadable = background(true, true, { rejectSyncGet: true });
  const state = await unreadable.request({ type: 'GET_EXTENSION_STATE' });
  assert.equal(state.success, false);
  assert.equal(Object.hasOwn(state, 'readingEnabled'), false);
});

test('损坏划词偏好安全关闭，删除偏好恢复兼容默认并广播', async () => {
  const bg = background(true);
  bg.data.readingEnabled = 'invalid';
  assert.equal((await bg.request({ type: 'GET_EXTENSION_STATE' })).readingEnabled, false);
  await bg.hooks.changed({ readingEnabled: { oldValue: false, newValue: undefined } }, 'sync');
  assert.deepEqual(bg.messages.map(message => [message.type, message.enabled]), [
    ['READING_STATE_CHANGED', true], ['READING_STATE_CHANGED', true]
  ]);
});

test('位置消息只操作固定键，不能读取设置或注入额外字段',async()=>{
 const bg=background(true);let saved;
 bg.chrome.storage.local.set=async value=>{saved=value;};
 const call=(message,sender={id:'test'})=>new Promise(resolve=>bg.hooks.message(message,sender,resolve));
 assert.equal((await call({type:'SET_POPUP_OFFSET',offset:{x:12,y:-5,translationSettings:'bad'}})).success,true);
 assert.equal(JSON.stringify(saved),JSON.stringify({liveTranslatePopupOffset:{x:12,y:-5}}));
 assert.equal((await call({type:'SET_POPUP_OFFSET',offset:{x:Infinity,y:0}})).success,false);
 assert.equal((await call({type:'GET_POPUP_OFFSET'},{})).success,false);
});

test('快捷键无目标时向原网页注入可关闭的通用提示，不带草稿', async () => {
  const bg = background(true);
  bg.frameResults.length = 0;
  let tabQueries = 0;
  bg.chrome.tabs.query = async () => [{ id: ++tabQueries === 1 ? 41 : 99 }];
  await bg.hooks.command('translate_selection');
  assert.equal(bg.messages.length, 0);
  const notice = bg.executions.find(execution => execution.args);
  assert.ok(notice, '快捷键失败应给出网页内反馈');
  assert.equal(notice.target.tabId, 41, '提示固定在命令开始时的网页，不追踪后来活动标签页');
  assert.equal(tabQueries, 1);
  assert.deepEqual(Object.keys(notice.target), ['tabId']);
  assert.equal(notice.args.length, 1);
  assert.match(notice.args[0], /请先点击目标输入框/);
  const timers = [], hosts = [];
  const element = () => ({
    style: {}, children: [], attributes: {}, listeners: {},
    append(...children) { this.children.push(...children); },
    attachShadow(options) { this.shadow = element(); this.shadow.mode = options.mode; return this.shadow; },
    setAttribute(name, value) { this.attributes[name] = value; },
    addEventListener(name, listener) { this.listeners[name] = listener; },
    remove() { this.removed = true; }
  });
  const document = {
    getElementById() { return null; }, createElement: element,
    body: { append(host) { hosts.push(host); } }
  };
  vm.runInNewContext(`(${notice.func.toString()})(message)`, {
    document, message: notice.args[0], setTimeout(callback, delay) { timers.push({ callback, delay }); }
  });
  assert.equal(hosts.length, 1);
  assert.equal(hosts[0].shadow.mode, 'closed');
  const content = hosts[0].shadow.children[0];
  assert.equal(content.attributes.role, 'status');
  assert.equal(content.children[0].textContent, `LiveTranslate：${notice.args[0]}`);
  content.children[1].listeners.click();
  assert.equal(hosts[0].removed, true);
  assert.equal(timers[0].delay, 8000);
});

test('受限页无法注入时使用徽标和通用提示，不透传底层详情', async () => {
  const bg = background(true, true, { rejectInspection: true, rejectNotice: true });
  await bg.hooks.command('translate_selection');
  assert.equal(bg.badges.at(-1).text, '!');
  assert.equal(bg.badgeColors.length, 1);
  assert.match(bg.titles.at(-1).title, /当前页面无法翻译/);
  assert.match(bg.titles.at(-1).title, /点击图标查看提示/);
  assert.doesNotMatch(bg.titles.at(-1).title, /诊断详情/);
});

test('快捷键错误仅由受信工具栏消费一次，内容页和其他扩展页不泄露或清除', async () => {
  const bg = background(true);
  bg.frameResults.length = 0;
  await bg.hooks.command('translate_selection');
  const reads = [
    { id: 'test', url: 'https://example.com/' },
    { id: 'other-extension', url: 'chrome-extension://test/popup/popup.html' },
    { id: 'test', url: 'chrome-extension://test/options/options.html' },
    { id: 'test', url: 'chrome-extension://test/popup/popup.html?untrusted=1' }
  ];
  const badgeCount = bg.badges.length;
  for (const sender of reads) {
    const result = await bg.request({ type: 'GET_EXTENSION_STATE' }, sender);
    assert.equal(result.enabled, true);
    assert.equal(Object.hasOwn(result, 'manualError'), false);
  }
  assert.equal(bg.badges.length, badgeCount);
  const popup = { id: 'test', url: 'chrome-extension://test/popup/popup.html' };
  const first = await bg.request({ type: 'GET_EXTENSION_STATE' }, popup);
  assert.match(first.manualError, /请先点击目标输入框/);
  assert.equal(bg.badges.at(-1).text, '');
  const second = await bg.request({ type: 'GET_EXTENSION_STATE' }, popup);
  assert.equal(second.enabled, true);
  assert.equal(Object.hasOwn(second, 'manualError'), false);
});

test('开关读取失败返回失败，不能冒充已启用或消费快捷键提示', async () => {
  const bg = background(true);
  bg.frameResults.length = 0;
  await bg.hooks.command('translate_selection');
  const originalGet = bg.chrome.storage.sync.get;
  bg.chrome.storage.sync.get = async () => { throw new Error('存储不可用'); };
  const popup = { id: 'test', url: 'chrome-extension://test/popup/popup.html' };
  const result = await bg.request({ type: 'GET_EXTENSION_STATE' }, popup);
  assert.equal(result.success, false);
  assert.equal(Object.hasOwn(result, 'enabled'), false);
  assert.equal(Object.hasOwn(result, 'manualError'), false);
  bg.chrome.storage.sync.get = originalGet;
  assert.match((await bg.request({ type: 'GET_EXTENSION_STATE' }, popup)).manualError, /请先点击目标输入框/);
});


test('新手动命令成功后，旧命令迟到失败不再产生提示或覆盖最近状态', async () => {
  const bg = background(true);
  let rejectOld;
  let markOldStarted;
  const oldStarted = new Promise(resolve => { markOldStarted = resolve; });
  let inspections = 0;
  bg.chrome.scripting.executeScript = async value => {
    bg.executions.push(value);
    if (!value.args && ++inspections === 1) {
      markOldStarted();
      return new Promise((_resolve, reject) => { rejectOld = reject; });
    }
    return bg.frameResults;
  };
  const old = bg.hooks.command('translate_selection');
  await oldStarted;
  await bg.hooks.command('translate_selection');
  assert.equal(bg.titles.at(-1).title, 'LiveTranslate - enabled');
  rejectOld(new Error('旧页面迟到失败'));
  await old;
  assert.equal(bg.executions.some(value => value.args), false, '迟到旧失败不得再注入提示');
  assert.equal(bg.badges.some(value => value.text === '!'), false);
  const popup = { id: 'test', url: 'chrome-extension://test/popup/popup.html' };
  assert.equal(Object.hasOwn(await bg.request({ type: 'GET_EXTENSION_STATE' }, popup), 'manualError'), false);

  // 旧错误提示已开始注入，但直到新命令成功后才拒绝，也不能触发旧徽标回退。
  const pendingNotice = background(true);
  let rejectNotice, markNoticeStarted;
  const noticeStarted = new Promise(resolve => { markNoticeStarted = resolve; });
  let firstInspection = true;
  pendingNotice.chrome.scripting.executeScript = async value => {
    pendingNotice.executions.push(value);
    if (value.args) {
      markNoticeStarted();
      return new Promise((_resolve, reject) => { rejectNotice = reject; });
    }
    if (firstInspection) { firstInspection = false; return []; }
    return pendingNotice.frameResults;
  };
  const oldNotice = pendingNotice.hooks.command('translate_selection');
  await noticeStarted;
  await pendingNotice.hooks.command('translate_selection');
  rejectNotice(new Error('旧注入迟到失败'));
  await oldNotice;
  assert.equal(pendingNotice.badges.some(value => value.text === '!'), false);
  assert.equal(pendingNotice.titles.at(-1).title, 'LiveTranslate - enabled');
  assert.equal(Object.hasOwn(await pendingNotice.request({ type: 'GET_EXTENSION_STATE' }, popup), 'manualError'), false);
});

test('新手动命令开始即清除旧错误标题和徽标，成功后恢复启用标题', async () => {
  const bg = background(true, true, { rejectInspection: true, rejectNotice: true });
  await bg.hooks.command('translate_selection');
  assert.equal(bg.badges.at(-1).text, '!');
  assert.match(bg.titles.at(-1).title, /点击图标查看提示/);
  let completeInspection, markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  bg.chrome.scripting.executeScript = async value => {
    bg.executions.push(value);
    markStarted();
    return new Promise(resolve => { completeInspection = resolve; });
  };
  const next = bg.hooks.command('translate_selection');
  await started;
  assert.equal(bg.titles.at(-1).title, 'LiveTranslate');
  assert.equal(bg.badges.at(-1).text, '');
  completeInspection(bg.frameResults);
  await next;
  assert.equal(bg.titles.at(-1).title, 'LiveTranslate - enabled');
  const state = await bg.request({ type: 'GET_EXTENSION_STATE' }, { id: 'test', url: 'chrome-extension://test/popup/popup.html' });
  assert.equal(state.enabled, true);
  assert.equal(Object.hasOwn(state, 'manualError'), false);
});

for (const enabled of [true,false]) for (const readingEnabled of [true,false]) {
  test(`安装及工具栏标题与独立开关一致:写作${enabled}阅读${readingEnabled}`,async()=>{
    const bg=background(enabled);bg.data.readingEnabled=readingEnabled;
    await bg.hooks.installed({reason:'update'});
    const expected=`LiveTranslate - ${enabled||readingEnabled?'enabled':'disabled'}`;
    assert.equal(bg.titles.at(-1).title,expected);
    await bg.request({type:'GET_EXTENSION_STATE'},{id:'test',url:'chrome-extension://test/popup/popup.html'});
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(bg.titles.at(-1).title,expected);
    await bg.chrome.storage.sync.set({readingEnabled:!readingEnabled});
    assert.equal(bg.titles.at(-1).title,`LiveTranslate - ${enabled||!readingEnabled?'enabled':'disabled'}`);
  });
}
