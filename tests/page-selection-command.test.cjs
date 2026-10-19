const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

// 后台只取得候选布尔值；在隔离 DOM 中执行真实 executeScript 函数，避免绕过正文粗筛。
function page({ text = '', focused = true, active = 'body', selected = 'p', crossing = false, collapsed = false } = {}) {
  class Element {
    constructor(tag, parentElement = null) { this.tag = tag; this.parentElement = parentElement; this.children = []; }
    get isContentEditable() { return this.tag === 'editor'; }
    get type() { return 'text'; }
    get blocked() { return ['input', 'textarea', 'editor', 'extension', 'notice'].includes(this.tag); }
    closest(selector) {
      assert.match(selector, /data-live-translate-ui/);
      return this.blocked ? this : this.parentElement?.closest(selector) || null;
    }
    querySelectorAll() { return this.children.filter(child => child.blocked); }
  }
  class HTMLElement extends Element {}
  class HTMLInputElement extends HTMLElement {}
  class HTMLTextAreaElement extends HTMLElement {}
  const body = new HTMLElement('body');
  const create = tag => tag === 'input' ? new HTMLInputElement(tag, body) :
    tag === 'textarea' ? new HTMLTextAreaElement(tag, body) : new HTMLElement(tag, body);
  const selectedElement = create(selected);
  if (crossing) selectedElement.children.push(create('editor'));
  const range = {
    commonAncestorContainer: { parentElement: selectedElement },
    intersectsNode() { return crossing; }
  };
  const selection = {
    isCollapsed: collapsed, rangeCount: text ? 1 : 0,
    toString() { return text; }, getRangeAt() { return range; }
  };
  return {
    document: { activeElement: create(active), hasFocus: () => focused },
    window: { getSelection: () => selection }, Element, HTMLElement, HTMLInputElement, HTMLTextAreaElement
  };
}

function background({ enabled = true, readingEnabled, frames = [{ frameId: 0, page: page() }], missingResponse = false, createFailure = false, onReady } = {}) {
  const hooks = {}, messages = [], inspections = [], sequence = [], opened = [];
  const event = name => ({ addListener(listener) { hooks[name] = listener; } });
  const chrome = {
    runtime: { id: 'test', getURL: value => `chrome-extension://test/${value}`, onInstalled: event('installed'), onStartup: event('startup'), onMessage: event('message') },
    commands: { onCommand: event('command') },
    permissions: { onRemoved: event('permissionRemoved') },
    storage: { sync: { async get() { return { enabled, readingEnabled }; } }, onChanged: event('changed') },
    action: { onClicked: event('clicked'), async setBadgeText() {}, async setBadgeBackgroundColor() {}, async setTitle() {} },
    scripting: {
      async executeScript(value) {
        inspections.push(value);
        assert.equal(value.target.allFrames, true);
        return frames.map(frame => ({
          frameId: frame.frameId,
          result: vm.runInNewContext(`(${value.func.toString()})()`, frame.page)
        }));
      }
    },
    tabs: {
      async create(value) {
        if (createFailure) throw new Error('底层标签页诊断不应透传');
        opened.push(value);
        return { id: 74 };
      },
      async query() { return [{ id: 73 }]; },
      async sendMessage(tabId, message, options) {
        sequence.push(message.type);
        messages.push({ tabId, message, options });
        return missingResponse ? undefined : { success: true };
      }
    }
  };
  const settings = { async protectStorage() {} };
  const recovery = {
    async ensureContentReady(tabId, frameId) { sequence.push(`ready:${tabId}:${frameId}`); if (onReady) await onReady(state => { enabled = state.enabled; readingEnabled = state.readingEnabled; }); },
    async reconnectChatGptTabs() {}
  };
  const code = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/background/background.ts'), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS }
  }).outputText;
  vm.runInNewContext(code, {
    exports: {}, chrome, URL, console: { log() {}, error() {}, warn() {} },
    require: name => name === './translation-settings' ? settings : name === './content-recovery' ? recovery : {},
    setTimeout, clearTimeout
  });
  return {
    messages, inspections, sequence, opened,
    request: (message, sender) => new Promise(resolve => hooks.message(message, sender, resolve)),
    manual: () => new Promise(resolve => hooks.message({ type: 'TRANSLATE_ACTIVE_EDITOR' }, {}, resolve)),
    command: () => hooks.command('translate_selection')
  };
}

test('工具栏手动入口优先翻译网页英文选区，目标 frame 就绪后只发正文指令', async () => {
  const bg = background({ frames: [
    { frameId: 0, page: page({ active: 'textarea', focused: false }) },
    { frameId: 9, page: page({ text: 'Keep the original draft safe.' }) }
  ] });
  assert.equal((await bg.manual()).success, true);
  assert.deepEqual(JSON.parse(JSON.stringify(bg.messages)), [{ tabId: 73, message: { type: 'TRANSLATE_PAGE_SELECTION' }, options: { frameId: 9 } }]);
  assert.deepEqual(bg.sequence, ['ready:73:9', 'TRANSLATE_PAGE_SELECTION']);
  const result = vm.runInNewContext(`(${bg.inspections[0].func.toString()})()`, page({ text: 'Private source text.' }));
  assert.deepEqual(Object.keys(result).sort(), ['editable', 'focused', 'pageSelection']);
});

test('手动快捷键复用正文路径，无需改变输入中译英默认命令', async () => {
  const bg = background({ frames: [{ frameId: 4, page: page({ text: 'English selection' }) }] });
  await bg.command();
  assert.equal(bg.messages.length, 1);
  assert.equal(bg.messages[0].message.type, 'TRANSLATE_PAGE_SELECTION');
  assert.equal(bg.messages[0].options.frameId, 4);
});

test('正文选区在多个 frame 中残留时聚焦优先，全部失焦则安全拒绝', async () => {
  for (const focused of [true, false]) {
    const bg = background({ frames: [
      { frameId: 0, page: page({ text: 'Old selection', focused: false }) },
      { frameId: 6, page: page({ text: 'Current selection', focused }) }
    ] });
    const result = await bg.manual();
    assert.equal(result.success, focused);
    if (focused) assert.equal(bg.messages[0].options.frameId, 6);
    else {
      assert.match(result.error, /重新选择一处英文/);
      assert.equal(bg.messages.length, 0);
      assert.equal(bg.sequence.length, 0);
    }
  }
});

test('输入框和富文本内的英文选区保留原中译英路由，忽略陈旧正文选区', async () => {
  for (const active of ['input', 'textarea', 'editor']) {
    const bg = background({ frames: [{ frameId: 3, page: page({ active, text: 'English selection' }) }] });
    assert.equal((await bg.manual()).success, true);
    assert.equal(bg.messages[0].message.type, 'TRANSLATE_SELECTION');
    assert.equal(bg.messages[0].options.frameId, 3);
  }
});

test('当前聚焦编辑器优先于另一个 frame 残留的失焦正文英文选区', async () => {
  const bg = background({ frames: [
    { frameId: 0, page: page({ active: 'textarea', focused: true }) },
    { frameId: 12, page: page({ text: 'Old selection in another frame', focused: false }) }
  ] });
  assert.equal((await bg.manual()).success, true);
  assert.equal(bg.messages.length, 1);
  assert.equal(bg.messages[0].message.type, 'TRANSLATE_SELECTION');
  assert.equal(bg.messages[0].options.frameId, 0);
});

test('正文与编辑器均声称聚焦时安全失败，不猜测当前目标', async () => {
  const bg = background({ frames: [
    { frameId: 0, page: page({ active: 'textarea', focused: true }) },
    { frameId: 12, page: page({ text: 'English selection', focused: true }) }
  ] });
  assert.equal((await bg.manual()).success, false);
  assert.equal(bg.messages.length, 0);
  assert.equal(bg.sequence.length, 0);
});

test('空白、中文、数字和折叠选区均不作为正文翻译候选', async () => {
  for (const options of [{}, { text: '   ' }, { text: 'Hello 中文' }, { text: '𠮷 English' }, { text: '12345' }, { text: 'English', collapsed: true }]) {
    const bg = background({ frames: [{ frameId: 0, page: page(options) }] });
    assert.equal((await bg.manual()).success, false);
    assert.equal(bg.messages.length, 0);
  }
});

test('编辑器子节点、扩展浮窗和跨过编辑器的选区不误判网页正文', async () => {
  for (const options of [{ selected: 'editor' }, { selected: 'extension' }, { selected: 'notice' }, { crossing: true }]) {
    const bg = background({ frames: [{ frameId: 0, page: page({ text: 'English selection', ...options }) }] });
    assert.equal((await bg.manual()).success, false);
    assert.equal(bg.messages.length, 0);
  }
});

test('两项均关闭时不读取选区、不补接 frame、不请求正文翻译', async () => {
  const bg = background({ enabled: false, readingEnabled: false, frames: [{ frameId: 0, page: page({ text: 'English selection' }) }] });
  const result = await bg.manual();
  assert.equal(result.success, false);
  assert.match(result.error, /均已关闭/);
  assert.equal(bg.inspections.length, 0);
  assert.equal(bg.sequence.length, 0);
});

test('独立关闭划词阻止正文命令与补接，不回退到残留编辑器', async () => {
  const bg = background({ readingEnabled: false, frames: [
    { frameId: 0, page: page({ text: 'Selected English', focused: true }) },
    { frameId: 9, page: page({ active: 'textarea', focused: false }) }
  ] });
  const result = await bg.manual();
  assert.equal(result.success, false);
  assert.match(result.error, /划词英译中已关闭/);
  assert.equal(bg.messages.length, 0);
  assert.equal(bg.sequence.length, 0);
});

test('关闭划词仍允许聚焦编辑器的手动中译英路径', async () => {
  const bg = background({ readingEnabled: false, frames: [
    { frameId: 0, page: page({ active: 'textarea', focused: true }) },
    { frameId: 9, page: page({ text: 'Old reading selection', focused: false }) }
  ] });
  assert.equal((await bg.manual()).success, true);
  assert.equal(bg.messages.length, 1);
  assert.equal(bg.messages[0].message.type, 'TRANSLATE_SELECTION');
  assert.equal(bg.messages[0].options.frameId, 0);
});

test('正文 frame 无响应给出重选提示，不回退到编辑器发送第二次请求', async () => {
  const bg = background({ missingResponse: true, frames: [{ frameId: 0, page: page({ text: 'English selection' }) }] });
  const result = await bg.manual();
  assert.equal(result.success, false);
  assert.match(result.error, /重新选择英文/);
  assert.equal(bg.messages.length, 1);
});

test('普通网页内容脚本可打开固定英译中准备页，只携带来源标签 ID', async () => {
  for (const url of ['https://example.com/private?draft=not-copied', 'http://127.0.0.1:8000/test']) {
    const bg = background();
    const result = await bg.request({ type: 'OPEN_READING_PREPARATION', url: 'https://attacker.invalid/', returnTab: 999, direction: 'zh-en' },
      { id: 'test', url, tab: { id: 73 } });
    assert.equal(result.success, true);
    assert.equal(bg.opened.length, 1);
    assert.equal(bg.opened[0].url, 'chrome-extension://test/setup/setup.html?direction=en-zh&returnTab=73');
    assert.equal(bg.inspections.length, 0);
    assert.equal(bg.messages.length, 0);
  }
});

test('准备入口拒绝其他扩展、扩展页、浏览器内部页和缺失或非法标签 ID', async () => {
  const senders = [
    { id: 'other', url: 'https://example.com/', tab: { id: 73 } },
    { url: 'https://example.com/', tab: { id: 73 } },
    { id: 'test', url: 'chrome-extension://test/popup/popup.html', tab: { id: 73 } },
    { id: 'test', url: 'chrome://extensions/', tab: { id: 73 } },
    { id: 'test', url: 'file:///tmp/test.html', tab: { id: 73 } },
    { id: 'test', url: 'invalid', tab: { id: 73 } },
    { id: 'test', url: 'https://example.com/' },
    ...[-1, 1.5, '73', Number.MAX_SAFE_INTEGER + 1].map(id => ({ id: 'test', url: 'https://example.com/', tab: { id } }))
  ];
  for (const sender of senders) {
    const bg = background();
    const result = await bg.request({ type: 'OPEN_READING_PREPARATION' }, sender);
    assert.equal(result.success, false);
    assert.equal(bg.opened.length, 0);
  }
});

test('打开准备页失败返回可重试提示，不透传浏览器底层详情', async () => {
  const bg = background({ createFailure: true });
  const result = await bg.request({ type: 'OPEN_READING_PREPARATION' }, { id: 'test', url: 'https://example.com/', tab: { id: 0 } });
  assert.equal(result.success, false);
  assert.match(result.error, /扩展工具栏重试/);
  assert.doesNotMatch(result.error, /底层标签页诊断/);
  assert.equal(bg.opened.length, 0);
});

for (const enabled of [true, false]) for (const readingEnabled of [true, false]) {
  test(`独立开关组合写作${enabled}阅读${readingEnabled}按实际目标路由`, async () => {
    for (const reading of [true, false]) {
      const bg = background({ enabled, readingEnabled, frames: [{ frameId: 4, page: page(reading ? {text:'English body selection'} : {active:'textarea'}) }] });
      const result = await bg.manual();
      assert.equal(result.success, reading ? readingEnabled : enabled);
      assert.equal(bg.messages.length, (reading ? readingEnabled : enabled) ? 1 : 0);
      if (result.success) assert.equal(bg.messages[0].message.type, reading ? 'TRANSLATE_PAGE_SELECTION' : 'TRANSLATE_SELECTION');
      else assert.equal(bg.sequence.length, 0, '被关闭场景不能补接或发送命令');
    }
  });
}

test('只开阅读时不把聚焦的已关闭写作目标转到其他frame旧阅读选区', async () => {
  const bg = background({ enabled:false, readingEnabled:true, frames:[
    {frameId:0,page:page({active:'textarea',focused:true})},
    {frameId:9,page:page({text:'Old reading selection',focused:false})}
  ] });
  const result=await bg.manual();
  assert.equal(result.success,false);assert.match(result.error,/输入中译英已关闭/);
  assert.equal(bg.sequence.length,0);
});

for (const reading of [true,false]) {
  test(`等待补接期间关闭${reading?'阅读':'写作'}不发送迟到命令`,async()=>{
    const bg=background({frames:[{frameId:4,page:page(reading?{text:'English body selection'}:{active:'textarea'})}],
      onReady:set=>set({enabled:reading,readingEnabled:!reading})});
    const result=await bg.manual();
    assert.equal(result.success,false);assert.match(result.error,reading?/划词英译中已关闭/:/输入中译英已关闭/);
    assert.deepEqual(bg.sequence,['ready:73:4']);assert.equal(bg.messages.length,0);
  });
}
