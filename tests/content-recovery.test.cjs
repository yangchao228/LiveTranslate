const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const source = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/background/content-recovery.ts'), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS }
}).outputText;
const plain = value => JSON.parse(JSON.stringify(value));
const settle = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

// 执行真实补接模块；只替换浏览器边界，不访问页面正文或编辑器。
function recovery(options = {}) {
  const calls = [];
  const chrome = {
    tabs: {
      async query(value) {
        calls.push({ type: 'query', value: plain(value) });
        return options.tabs || [];
      },
      async sendMessage(tabId, message, target) {
        const call = { type: 'ready', tabId, message: plain(message), target: plain(target) };
        calls.push(call);
        return options.ready ? options.ready(call) : { success: true };
      }
    },
    scripting: {
      async executeScript(value) {
        const call = { type: 'script', value: plain(value) };
        calls.push(call);
        return options.script?.(call);
      },
      async insertCSS(value) {
        const call = { type: 'css', value: plain(value) };
        calls.push(call);
        return options.css?.(call);
      }
    }
  };
  const exports = {};
  vm.runInNewContext(source, {
    exports, chrome, setTimeout: options.setTimeout || setTimeout,
    clearTimeout: options.clearTimeout || clearTimeout
  });
  return { ...exports, calls };
}

test('已就绪页面只握手，不重复注入脚本或样式', async () => {
  const api = recovery();
  await api.ensureContentReady(11, 4);
  assert.deepEqual(api.calls, [{ type: 'ready', tabId: 11, message: { type: 'CONTENT_READY' }, target: { frameId: 4 } }]);
});

test('失联页面补接同一 frame 的 JS 和 CSS，等初始化完成才成功', async () => {
  const initialized = deferred();
  let injected = false, finished = false;
  const api = recovery({
    ready: () => injected ? initialized.promise : undefined,
    script: () => { injected = true; }
  });
  const pending = api.ensureContentReady(12, 8).then(() => { finished = true; });
  await settle();
  assert.equal(finished, false, '注入完成不等于初始化完成');
  assert.deepEqual(api.calls.map(call => call.type), ['ready', 'script', 'css', 'ready']);
  assert.deepEqual(api.calls[1].value, { target: { tabId: 12, frameIds: [8] }, files: ['content/content.js'] });
  assert.deepEqual(api.calls[2].value, { target: { tabId: 12, frameIds: [8] }, files: ['content/content.css'] });
  initialized.resolve({ success: true });
  await pending;
  assert.equal(finished, true);
});

test('同 tab/frame 并行补接合并，其他 frame 独立完成', async () => {
  const gate = deferred();
  const injected = new Set();
  const api = recovery({
    ready: call => ({ success: injected.has(call.target.frameId) }),
    script: async call => {
      const frameId = call.value.target.frameIds[0];
      if (frameId === 0) await gate.promise;
      injected.add(frameId);
    }
  });
  let mainFinished = false;
  const main = api.ensureContentReady(13);
  const duplicate = api.ensureContentReady(13, 0);
  assert.equal(main, duplicate, '同一 document 的并行入口共用一个任务');
  void main.then(() => { mainFinished = true; });
  await api.ensureContentReady(13, 2);
  assert.equal(mainFinished, false);
  assert.deepEqual(api.calls.filter(call => call.type === 'script').map(call => call.value.target.frameIds[0]), [0, 2]);
  gate.resolve();
  await Promise.all([main, duplicate]);
  assert.equal(api.calls.filter(call => call.type === 'script').length, 2);
});

test('不同 tab 的相同 frame 不共用接入任务', async () => {
  const injected = new Set();
  const api = recovery({
    ready: call => ({ success: injected.has(call.tabId) }),
    script: call => { injected.add(call.value.target.tabId); }
  });
  await Promise.all([api.ensureContentReady(14), api.ensureContentReady(15)]);
  assert.deepEqual(api.calls.filter(call => call.type === 'script').map(call => call.value.target.tabId), [14, 15]);
});

test('缺少接收方后补接；权限拒绝失败并释放锁，下一次可重试', async () => {
  let attempts = 0, connected = false;
  const api = recovery({
    ready: () => {
      if (!connected) throw new Error('Receiving end does not exist');
      return { success: true };
    },
    script: () => {
      if (++attempts === 1) throw new Error('Cannot access contents of url');
      connected = true;
    }
  });
  await assert.rejects(api.ensureContentReady(16), /Cannot access contents/);
  assert.equal(api.calls.some(call => call.type === 'css'), false);
  await api.ensureContentReady(16);
  assert.equal(attempts, 2);
  assert.equal(api.calls.filter(call => call.type === 'css').length, 1);
});

test('补接后初始化仍失败不会误报成功，也不缓存失败任务', async () => {
  let available = false;
  const api = recovery({ ready: () => ({ success: available }) });
  await assert.rejects(api.ensureContentReady(17), /内容脚本未能接入/);
  available = true;
  await api.ensureContentReady(17);
  assert.equal(api.calls.filter(call => call.type === 'script').length, 1);
  assert.equal(api.calls.filter(call => call.type === 'ready').length, 3);
});

test('CSS 注入拒绝不报告接入成功', async () => {
  const api = recovery({
    ready: () => undefined,
    css: () => { throw new Error('样式注入被拒绝'); }
  });
  await assert.rejects(api.ensureContentReady(18), /样式注入被拒绝/);
  assert.deepEqual(api.calls.map(call => call.type), ['ready', 'script', 'css']);
});

test('握手不响应时有时限，二次握手超时拒绝并清理计时器', async () => {
  let nextId = 0;
  const timers = new Map();
  const api = recovery({
    ready: () => new Promise(() => {}),
    setTimeout(callback, milliseconds) { assert.equal(milliseconds, 3000); timers.set(++nextId, callback); return nextId; },
    clearTimeout(id) { timers.delete(id); }
  });
  const pending = api.ensureContentReady(19);
  assert.equal(timers.size, 1);
  timers.values().next().value();
  await settle();
  assert.equal(timers.size, 1);
  const rejected = assert.rejects(pending, /内容脚本未能接入/);
  timers.values().next().value();
  await rejected;
  assert.equal(timers.size, 0);
  assert.deepEqual(api.calls.map(call => call.type), ['ready', 'script', 'css', 'ready']);
});

test('自动接入仅查询 ChatGPT 并跳过 discarded/无 ID 页；单页失败不阻断其余页', async () => {
  const api = recovery({
    tabs: [{ id: 21 }, { id: 22, discarded: true }, {}, { id: 23 }],
    ready: call => ({ success: call.tabId === 21 }),
    script: () => { throw new Error('单页禁止注入'); }
  });
  await api.reconnectChatGptTabs();
  assert.deepEqual(api.calls[0], { type: 'query', value: { url: ['https://chatgpt.com/*'] } });
  assert.deepEqual(api.calls.filter(call => call.type === 'ready').map(call => call.tabId), [21, 23]);
  assert.deepEqual(api.calls.filter(call => call.type === 'script').map(call => call.value.target.tabId), [23]);
});
