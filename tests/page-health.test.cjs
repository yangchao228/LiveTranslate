const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const plain = value => JSON.parse(JSON.stringify(value));
const settle = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const popup = { id: 'test', url: 'chrome-extension://test/popup/popup.html' };

// 加载真实自检与恢复模块，只替换 Chrome 边界；没有 DOM、翻译器或存储替身。
function health(options = {}) {
  const calls = [], hooks = {}, modules = new Map(), timers = new Map();
  let nextTimer = 0, connected = options.connected ?? true;
  let checkId, now = Date.now();
  let tab = { id: 71, windowId: 3, url: 'https://example.test/article', status: 'complete', ...options.tab };
  const chrome = {
    runtime: { id: 'test', getURL: value => `chrome-extension://test/${value}` },
    tabs: {
      onUpdated: { addListener(listener) { hooks.updated = listener; } },
      onRemoved: { addListener(listener) { hooks.removed = listener; } },
      onActivated: { addListener(listener) { hooks.activated = listener; } },
      async query(value) { calls.push({ type: 'query', value: plain(value) }); return options.query ? options.query(value) : [{ ...tab }]; },
      async sendMessage(tabId, message, target) {
        calls.push({ type: 'ready', tabId, message: plain(message), target: plain(target) });
        return options.ready ? options.ready() : { success: connected };
      }
    },
    scripting: {
      async executeScript(value) { calls.push({ type: 'script', value: plain(value) }); if (options.script) return options.script(); connected = true; },
      async insertCSS(value) { calls.push({ type: 'css', value: plain(value) }); return options.css?.(); }
    }
  };
  function load(filename) {
    if (modules.has(filename)) return modules.get(filename);
    const exports = {};
    modules.set(filename, exports);
    const source = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS }
    }).outputText;
    vm.runInNewContext(source, {
      exports, chrome, URL, crypto: require('node:crypto').webcrypto,
      Date: class extends Date { static now() { return now; } },
      require: name => load(path.resolve(path.dirname(filename), name + '.ts')),
      setTimeout: options.fakeTimers ? (callback, milliseconds) => { timers.set(++nextTimer, { callback, milliseconds }); return nextTimer; } : setTimeout,
      clearTimeout: options.fakeTimers ? id => timers.delete(id) : clearTimeout
    });
    return exports;
  }
  const api = load(path.join(__dirname, '../src/background/page-health.ts'));
  return {
    calls, timers,
    change(next) { tab = { ...tab, ...next }; },
    navigation(change = { status: 'loading' }) { hooks.updated(71, change); },
    activate() { hooks.activated(); },
    advance(milliseconds) { now += milliseconds; },
    get: async (sender = popup) => {
      const result = await api.handleActivePageHealth({ type: 'GET_ACTIVE_PAGE_STATUS' }, sender);
      checkId = result.checkId;
      return result;
    },
    // 恢复用例先经过真实 GET 发令牌；后续断言只统计恢复阶段。
    async check() {
      const originalReady = options.ready;
      options.ready = () => ({ success: false });
      const result = await api.handleActivePageHealth({ type: 'GET_ACTIVE_PAGE_STATUS' }, popup);
      options.ready = originalReady;
      checkId = result.checkId;
      calls.length = 0;
      return result;
    },
    recover: (expectedTabId = 71, sender = popup, token = checkId) => api.handleActivePageHealth({ type: 'RECOVER_ACTIVE_PAGE', expectedTabId, checkId: token }, sender),
    ensure: () => load(path.join(__dirname, '../src/background/content-recovery.ts')).ensureContentReady(71),
    fire(milliseconds) { const entry = [...timers.values()].find(timer => timer.milliseconds === milliseconds); assert.ok(entry, `存在 ${milliseconds}ms 时限`); entry.callback(); }
  };
}

test('仅精确可信工具栏可以自检和恢复，其他来源不查询或注入', async () => {
  const api = health();
  for (const sender of [{}, { ...popup, id: 'other' }, { ...popup, url: 'https://example.test/' }, { ...popup, url: popup.url + '?spoof=1' }, { ...popup, url: 'chrome-extension://test/options/options.html' }]) {
    assert.equal((await api.get(sender)).success, false);
    assert.equal((await api.recover(71, sender)).success, false);
  }
  assert.deepEqual(api.calls, []);
});

test('已就绪自检只握手主 frame，不读取正文、注入、翻译或检查开关', async () => {
  const api = health();
  const result = plain(await api.get());
  assert.equal(result.status, 'ready');
  assert.equal(result.tabId, 71);
  assert.deepEqual(Object.keys(result).sort(), ['checkId', 'message', 'status', 'success', 'tabId']);
  assert.match(result.checkId, /^[a-z0-9-]+$/u);
  assert.equal(JSON.stringify(result).includes('example.test'), false);
  assert.deepEqual(api.calls.filter(call => call.type === 'ready'), [{ type: 'ready', tabId: 71, message: { type: 'CONTENT_READY' }, target: { frameId: 0 } }]);
  assert.equal(api.calls.some(call => ['script', 'css'].includes(call.type)), false);
  for (const call of api.calls.filter(call => call.type === 'query')) assert.deepEqual(call.value, { active: true, currentWindow: true });
});

test('HTTP(S) 失联只显示需要接入，自检不自动恢复', async () => {
  for (const url of ['https://example.test/article', 'http://127.0.0.1/test']) {
    const api = health({ connected: false, tab: { url } });
    assert.equal((await api.get()).status, 'needs-recovery');
    assert.equal(api.calls.filter(call => call.type === 'ready').length, 1);
    assert.equal(api.calls.some(call => ['script', 'css'].includes(call.type)), false);
  }
});

test('内部页、商店及非 HTTP(S) 地址明确受限，不尝试握手或注入', async () => {
  for (const url of ['chrome://extensions/', 'chrome-extension://pdf/viewer.html', 'file:///tmp/test.html', 'about:blank', 'https://chromewebstore.google.com/detail/test', 'https://chrome.google.com/webstore/detail/test']) {
    const api = health({ tab: { url } });
    assert.equal((await api.get()).status, 'restricted');
    assert.equal((await api.recover()).success, false, '受限页不发恢复令牌');
    assert.equal(api.calls.every(call => call.type === 'query'), true);
  }
  assert.equal((await health({ tab: { url: 'https://chrome.google.com/other' } }).get()).status, 'ready');
});

test('无活动页、缺 URL、无效 URL、加载或丢弃状态保持未知，不猜测可用', async () => {
  for (const options of [
    { query: () => [] }, { tab: { id: undefined } }, { tab: { url: undefined } }, { tab: { url: 'invalid' } },
    { tab: { status: 'loading' } }, { tab: { pendingUrl: 'https://other.test/' } }, { tab: { discarded: true } }
  ]) {
    const api = health(options);
    assert.equal((await api.get()).status, 'unknown');
    assert.equal(api.calls.every(call => call.type === 'query'), true);
  }
});

test('恢复精确补接原主 frame，重复请求合并且保持既有脚本/CSS路径', async () => {
  const gate = deferred();
  let connected = false;
  const api = health({ ready: () => ({ success: connected }), script: async () => { await gate.promise; connected = true; } });
  await api.check();
  const first = api.recover();
  const second = api.recover();
  assert.equal(first, second);
  await settle();
  assert.equal(api.calls.filter(call => call.type === 'script').length, 1);
  gate.resolve();
  assert.equal((await first).status, 'ready');
  assert.equal((await second).status, 'ready');
  assert.deepEqual(api.calls.filter(call => ['script', 'css'].includes(call.type)), [
    { type: 'script', value: { target: { tabId: 71, frameIds: [0] }, files: ['content/content.js'] } },
    { type: 'css', value: { target: { tabId: 71, frameIds: [0] }, files: ['content/content.css'] } }
  ]);
});

test('已就绪恢复只握手，不重注入或修改选区草稿', async () => {
  const api = health();
  await api.check();
  assert.equal((await api.recover()).status, 'ready');
  assert.equal(api.calls.some(call => ['script', 'css'].includes(call.type)), false);
});

test('恢复需要有效预期 tab ID，拒绝任意旧目标并且只查询真实活动页', async () => {
  const api = health();
  await api.check();
  for (const id of [undefined, null, '71', -1, 1.5, Infinity, NaN]) {
    const result = await api.recover(id === undefined ? null : id);
    assert.equal(result.success, false);
  }
  assert.equal(api.calls.length, 0);
  assert.equal((await api.recover(888)).status, 'unknown');
  assert.equal(api.calls.length, 0, '令牌不对应目标时连活动页也不查询');
  const zero = health({ tab: { id: 0 } });
  await zero.check();
  assert.equal((await zero.recover(0)).status, 'ready');
});

test('恢复失败不透传底层地址/正文，释放任务后可重试', async () => {
  let attempt = 0, connected = false;
  const api = health({ ready: () => ({ success: connected }), script: () => {
    if (++attempt === 1) throw new Error('https://private.test/secret 私人草稿');
    connected = true;
  } });
  await api.check();
  const failed = await api.recover();
  assert.equal(failed.status, 'needs-recovery');
  assert.match(failed.message, /网站访问权限.*PDF/u);
  assert.equal(JSON.stringify(failed).includes('private'), false);
  assert.equal((await api.recover()).status, 'ready');
  assert.equal(attempt, 2);
});

test('样式注入失败或初始化拒绝不会宣称已就绪', async () => {
  const css = health({ connected: false, css: () => { throw new Error('私密诊断'); } });
  await css.check();
  assert.equal((await css.recover()).status, 'needs-recovery');
  const initializing = health({ ready: () => ({ success: false }) });
  await initializing.check();
  assert.equal((await initializing.recover()).status, 'needs-recovery');
});

test('握手不响应有 3 秒时限，自检失联不会继续注入', async () => {
  const api = health({ fakeTimers: true, ready: () => new Promise(() => {}) });
  const pending = api.get();
  await settle();
  api.fire(3000);
  assert.equal((await pending).status, 'needs-recovery');
  assert.equal(api.timers.size, 0);
  assert.equal(api.calls.some(call => call.type === 'script'), false);
});

test('总时限覆盖 Chrome 查询停滞，迟到查询不能继续握手', async () => {
  const gate = deferred();
  const api = health({ fakeTimers: true, query: () => gate.promise });
  const pending = api.get();
  api.fire(10000);
  assert.equal((await pending).status, 'unknown');
  gate.resolve([{ id: 71, url: 'https://example.test/', status: 'complete' }]);
  await settle();
  assert.equal(api.calls.every(call => call.type === 'query'), true);
});

test('总时限过后即使脚本迟到完成也不再注入样式或报告成功', async () => {
  const gate = deferred();
  const api = health({ fakeTimers: true, connected: false, script: () => gate.promise });
  await api.check();
  const pending = api.recover();
  await settle();
  assert.equal(api.calls.filter(call => call.type === 'script').length, 1);
  api.fire(10000);
  assert.equal((await pending).status, 'unknown');
  gate.resolve();
  await settle();
  assert.equal(api.calls.some(call => call.type === 'css'), false);
  assert.equal(api.timers.size, 0);
});

test('自检过程中换活动 tab 或导航，旧就绪响应失效', async () => {
  for (const next of [{ id: 72 }, { windowId: 4 }, { url: 'https://example.test/new' }, { pendingUrl: 'https://next.test/' }, { status: 'loading' }]) {
    const gate = deferred();
    const api = health({ ready: () => gate.promise });
    const pending = api.get();
    await settle();
    api.change(next);
    gate.resolve({ success: true });
    assert.equal((await pending).status, 'unknown');
    assert.equal(api.calls.some(call => call.type === 'script'), false);
  }
});

test('同 URL 重载也使在途自检失效，加载完成后不能接受旧握手', async () => {
  const gate = deferred();
  const api = health({ ready: () => gate.promise });
  const pending = api.get();
  await settle();
  api.navigation({ status: 'loading' });
  api.navigation({ status: 'complete' });
  gate.resolve({ success: true });
  assert.equal((await pending).status, 'unknown');
});

test('恢复第一次握手期间导航则取消，不能向新页面注入', async () => {
  const gate = deferred();
  const api = health({ ready: () => gate.promise });
  await api.check();
  const pending = api.recover();
  await settle();
  api.navigation();
  gate.resolve({ success: false });
  assert.equal((await pending).status, 'unknown');
  assert.equal(api.calls.some(call => call.type === 'script'), false);
});

test('恢复 JS 完成后换页或换活动 tab，后续 CSS 被取消', async () => {
  for (const navigate of [false, true]) {
    const gate = deferred();
    const api = health({ connected: false, script: () => gate.promise });
    await api.check();
    const pending = api.recover();
    await settle();
    if (navigate) api.navigation();
    else api.change({ id: 72 });
    gate.resolve();
    assert.equal((await pending).status, 'unknown');
    assert.equal(api.calls.some(call => call.type === 'css'), false);
  }
});

test('恢复完成前的最后复核拒绝导航迟到结果', async () => {
  const gate = deferred();
  const api = health({ connected: false, css: () => gate.promise });
  await api.check();
  const pending = api.recover();
  await settle();
  assert.equal(api.calls.filter(call => call.type === 'css').length, 1);
  api.navigation({ url: 'https://example.test/new' });
  gate.resolve();
  assert.equal((await pending).status, 'unknown');
});

test('自检查询失败返回通用未知，不影响其他手动入口或泄露错误', async () => {
  const api = health({ query: () => { throw new Error('private draft and https://private.test/path'); } });
  const result = await api.get();
  assert.equal(result.status, 'unknown');
  assert.equal(JSON.stringify(result).includes('private'), false);
});

test('加入旧无 guard 补接时共同约束后续注入，导航后两个入口均拒绝旧结果', async () => {
  const gate = deferred();
  const api = health({ ready: () => gate.promise });
  await api.check();
  const original = api.ensure();
  const rejected = assert.rejects(original);
  const recovery = api.recover();
  await settle();
  api.navigation();
  gate.resolve({ success: false });
  assert.equal((await recovery).status, 'unknown');
  await rejected;
  assert.equal(api.calls.some(call => ['script', 'css'].includes(call.type)), false);
  assert.equal(api.calls.filter(call => call.type === 'ready').length, 1);
});

test('已有 JS 请求无法撤销，但后来加入的 guard 在导航后阻止 CSS 与成功结果', async () => {
  const gate = deferred();
  const api = health({ connected: false, script: () => gate.promise });
  await api.check();
  const original = api.ensure();
  const rejected = assert.rejects(original);
  await settle();
  assert.equal(api.calls.filter(call => call.type === 'script').length, 1);
  const recovery = api.recover();
  await settle();
  api.navigation();
  gate.resolve();
  assert.equal((await recovery).status, 'unknown');
  await rejected;
  assert.equal(api.calls.some(call => call.type === 'css'), false);
});

test('加入旧无 guard 补接且页面未变时共享原注入，不重复写入', async () => {
  const gate = deferred();
  let connected = false;
  const api = health({ ready: () => ({ success: connected }), script: async () => { await gate.promise; connected = true; } });
  await api.check();
  const original = api.ensure();
  await settle();
  const recovery = api.recover();
  await settle();
  gate.resolve();
  await original;
  assert.equal((await recovery).status, 'ready');
  assert.equal(api.calls.filter(call => call.type === 'script').length, 1);
  assert.equal(api.calls.filter(call => call.type === 'css').length, 1);
});

test('GET 已完成后原 tab 导航，旧令牌不能授权向新页面恢复', async () => {
  const api = health({ connected: false });
  const check = await api.get();
  assert.equal(check.status, 'needs-recovery');
  api.calls.length = 0;
  api.change({ url: 'https://example.test/new' });
  api.navigation({ url: 'https://example.test/new' });
  const result = await api.recover();
  assert.equal(result.status, 'unknown');
  assert.equal(result.checkId, undefined);
  assert.match(result.message, /重新检查/u);
  assert.equal(api.calls.every(call => call.type === 'query'), true);
});

test('GET 已完成后同 URL 重载，旧令牌失效且没有注入', async () => {
  const api = health({ connected: false });
  await api.get();
  api.calls.length = 0;
  api.navigation({ status: 'loading' });
  api.navigation({ status: 'complete' });
  assert.equal((await api.recover()).status, 'unknown');
  assert.equal(api.calls.every(call => call.type === 'query'), true);
});

test('GET 后切活动 tab 或换窗口，即使再切回同页也要求重新检查', async () => {
  for (const change of ['tab', 'window', 'away-and-back']) {
    const api = health({ connected: false });
    await api.get();
    api.calls.length = 0;
    if (change === 'tab') api.change({ id: 72 });
    else if (change === 'window') api.change({ windowId: 4 });
    else { api.activate(); api.activate(); }
    assert.equal((await api.recover()).status, 'unknown');
    assert.equal(api.calls.every(call => call.type === 'query'), true);
  }
});

test('恢复拒绝缺失、伪造、过期或不对应原 tab 的令牌', async () => {
  const api = health();
  assert.equal((await api.recover()).success, false);
  await api.check();
  for (const value of [null, '', 71, 'x'.repeat(129)]) assert.equal((await api.recover(71, popup, value)).success, false);
  assert.equal((await api.recover(71, popup, 'unknown-check')).status, 'unknown');
  assert.equal(api.calls.length, 0);
  api.advance(120000);
  assert.equal((await api.recover()).status, 'unknown');
  assert.equal(api.calls.length, 0);
});

test('令牌内存至多保存 32 条，淘汰旧检查不影响最新检查', async () => {
  const api = health();
  const oldest = await api.get();
  for (let i = 0; i < 32; i++) await api.get();
  api.calls.length = 0;
  assert.equal((await api.recover(71, popup, oldest.checkId)).status, 'unknown');
  assert.equal(api.calls.length, 0);
  const latest = await api.recover();
  assert.equal(latest.status, 'ready');
  assert.equal(typeof latest.checkId, 'string');
  assert.equal(api.calls.some(call => call.type === 'script'), false);
});
