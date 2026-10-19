const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const setupSource = fs.readFileSync(path.join(__dirname, '../src/setup/setup.js'), 'utf8');
const setupHtml = fs.readFileSync(path.join(__dirname, '../src/setup/setup.html'), 'utf8');
const settle = async () => { await new Promise(resolve => setImmediate(resolve)); };

// 执行实际准备页脚本，使用真实 HTML 中的 ID；禁止真实模型、下载和外部服务。
async function setup(options = {}) {
  const elements = new Map();
  for (const match of setupHtml.matchAll(/<[a-z][^<>]*\bid="([^"]+)"[^<>]*>/gi)) {
    assert.equal(elements.has(match[1]), false, `重复 DOM ID：${match[1]}`);
    const text = setupHtml.slice(match.index + match[0].length).split('<')[0];
    elements.set(match[1], {
      textContent: text, hidden: /\bhidden(?:\s|>)/.test(match[0]), disabled: /\bdisabled(?:\s|>)/.test(match[0]),
      listeners: {}, classList: { toggle() {} },
      setAttribute(name, value) { this[name] = value; },
      removeAttribute(name) { delete this[name]; },
      addEventListener(name, listener) { this.listeners[name] = listener; }
    });
  }
  const get = id => {
    assert.ok(elements.has(id), `真实 HTML 缺少控件：${id}`);
    return elements.get(id);
  };
  const calls = { availability: [], create: [], translate: [], messages: [], permissions: [], urls: [], tabs: [], windows: [], destroyed: 0 };
  const Translator = options.noTranslator ? undefined : {
    async availability(pair) { calls.availability.push(pair); return options.availability || 'available'; },
    async create(value) {
      calls.create.push(value);
      if (options.create) return options.create(value, calls);
      return {
        async translate(text) { calls.translate.push(text); return options.translated ?? '会议明天上午九点开始。'; },
        destroy() { calls.destroyed++; }
      };
    }
  };
  const chrome = {
    runtime: {
      getURL: file => `chrome-extension://test/${file}`,
      async sendMessage(message) { calls.messages.push(message); throw new Error('此准备页不应访问 Edge 引擎'); }
    },
    permissions: { async request(value) { calls.permissions.push(value); throw new Error('不应申请下载权限'); } },
    tabs: {
      async get(id) { return options.returnTab || { id, windowId: 7, url: 'https://example.invalid/article' }; },
      async create(value) { calls.urls.push(value.url); },
      async update(id, value) { calls.tabs.push({ id, ...value }); }
    },
    windows: { async update(id, value) { calls.windows.push({ id, ...value }); } }
  };
  const document = { getElementById: get };
  vm.runInNewContext(setupSource, {
    document, chrome, Translator, location: { search: options.search || '' },
    navigator: { userAgent: options.edge ? 'Chrome/155.0 Edg/155.0' : 'Chrome/155.0' },
    window: { addEventListener() {} }, URL, URLSearchParams, AbortController, setTimeout, clearTimeout
  });
  await settle();
  return {
    get, calls, document,
    async click(id) { if (!get(id).disabled) await get(id).listeners.click(); await settle(); }
  };
}

test('缺省和未知方向仍只准备中译英，不在检查阶段创建实例', async () => {
  for (const search of ['', '?direction=other']) {
    const ui = await setup({ search, translated: 'Hello. Great.' });
    assert.equal(JSON.stringify(ui.calls.availability), JSON.stringify([{ sourceLanguage: 'zh', targetLanguage: 'en' }]));
    assert.equal(ui.calls.create.length, 0);
    await ui.click('prepare');
    assert.equal(JSON.stringify(ui.calls.create.map(({ sourceLanguage, targetLanguage }) => ({ sourceLanguage, targetLanguage }))), JSON.stringify([{ sourceLanguage: 'zh', targetLanguage: 'en' }]));
    assert.deepEqual(ui.calls.translate, ['Hello. 太棒了。']);
    assert.equal(ui.get('preparation-title').textContent, '本机翻译已准备好');
    assert.equal(ui.calls.destroyed, 1);
  }
});

test('反向准备仅检查并创建英译中，真实英文验证后显示阅读入口', async () => {
  const ui = await setup({ search: '?direction=en-zh&returnTab=73' });
  assert.equal(ui.document.title, '准备本机英译中 · LiveTranslate');
  assert.equal(ui.get('source-language').textContent, '英文');
  assert.equal(ui.get('target-language').textContent, '中文');
  assert.equal(ui.get('language-preparation')['aria-label'], '英译中语言包准备');
  assert.equal(JSON.stringify(ui.calls.availability), JSON.stringify([{ sourceLanguage: 'en', targetLanguage: 'zh' }]));
  assert.equal(ui.calls.create.length, 0);
  await ui.click('prepare');
  assert.equal(JSON.stringify(ui.calls.create.map(({ sourceLanguage, targetLanguage }) => ({ sourceLanguage, targetLanguage }))), JSON.stringify([{ sourceLanguage: 'en', targetLanguage: 'zh' }]));
  assert.deepEqual(ui.calls.translate, ['The meeting starts at nine tomorrow morning.']);
  assert.match(ui.get('sample').textContent, /会议明天上午九点开始/);
  assert.equal(ui.get('preparation-title').textContent, '本机英译中已准备好');
  assert.equal(ui.get('start-writing').textContent, '返回网页继续阅读');
  await ui.click('start-writing');
  assert.deepEqual(ui.calls.tabs, [{ id: 73, active: true }]);
  assert.deepEqual(ui.calls.windows, [{ id: 7, focused: true }]);
  assert.equal(ui.calls.messages.length, 0);
});

test('反向准备无来源时返回阅读说明，受限来源不激活', async () => {
  for (const options of [{}, { search: '?direction=en-zh&returnTab=73', returnTab: { id: 73, windowId: 7, url: 'chrome://settings/' } }]) {
    const ui = await setup({ search: '?direction=en-zh', ...options });
    await ui.click('prepare');
    await ui.click('start-writing');
    assert.deepEqual(ui.calls.urls, ['chrome-extension://test/help/user-guide.html#reading']);
    assert.equal(ui.calls.tabs.length, 0);
  }
});

test('反向固定验证句空白或仍为英文时不宣称准备成功', async () => {
  for (const translated of ['', 'The meeting starts at nine tomorrow morning.']) {
    const ui = await setup({ search: '?direction=en-zh', translated });
    await ui.click('prepare');
    assert.match(ui.get('status').textContent, /没有中文译文/);
    assert.equal(ui.get('start-writing').hidden, true);
    assert.equal(ui.get('sample').textContent, '');
    assert.equal(ui.get('prepare').disabled, false);
    assert.equal(ui.calls.destroyed, 1);
  }
});

test('反向不支持或无 API 时保持禁用，错误明确语言方向', async () => {
  const unavailable = await setup({ search: '?direction=en-zh', availability: 'unavailable' });
  assert.match(unavailable.get('status').textContent, /不支持英译中语言包/);
  assert.equal(unavailable.get('prepare').disabled, true);
  assert.equal(unavailable.calls.create.length, 0);
  const missing = await setup({ search: '?direction=en-zh', noTranslator: true });
  assert.match(missing.get('status').textContent, /Chrome 138/);
  assert.equal(missing.get('prepare').disabled, true);
});

