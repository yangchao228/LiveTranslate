// 独立临时 Chrome 与真实扩展消息/activeTab；网页为自有固定 HTML，不读取个人配置。
// Translator 创建接口使用计数替身，避免回归验证下载模型或调用真实翻译。
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const extensionDir = path.resolve(process.env.EXTENSION_DIR || 'releases/page-health-chrome-update-2026-10-18/source/dist');
const output = path.resolve(process.env.PAGE_HEALTH_ACCEPTANCE_DIR || 'releases/page-health-chrome-update-2026-10-18/installed-acceptance');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'live-translate-page-health-'));
const profile = path.join(temporary, 'profile');
const installedDir = path.join(temporary, 'extension');
const fixtureUrl = 'https://example.org/live-translate-page-health-fixture';
const report = {
  scope: 'owned-static-example.org-fixture-not-personal-profile', chromeApis: 'real',
  translation: 'creation-counter-substitute-no-real-model', extensionDir, profile, checks: []
};
fs.mkdirSync(output, { recursive: true });
fs.cpSync(extensionDir, installedDir, { recursive: true });
const fixture = `<!doctype html><html lang="zh"><meta charset="utf-8"><title>LiveTranslate 网页接入回归 · 自有页面</title>
<style>body{font:18px system-ui;max-width:860px;margin:70px auto;color:#17243b;background:#f7f9fd}h1{font-size:26px}#draft{border:1px solid #cad3e4;border-radius:16px;padding:28px;background:white;min-height:160px}textarea{width:100%;height:90px;margin-top:24px}</style>
<h1>LiveTranslate 网页自检与恢复</h1><p>自有静态回归页面，不发送草稿，不调用真实翻译模型。</p>
<div id="draft" contenteditable="true" role="textbox" aria-label="固定测试草稿"><p>第一行🙂 <strong>保留加粗文本</strong>和后续草稿</p><p>第二行：unfinished draft 🧩</p></div>
<textarea id="plain">普通输入框已有草稿🙂\n第二行仍需保留</textarea>
<script>window.fixtureDocumentToken=crypto.randomUUID();window.fixtureEvents=[];for(const type of ['input','beforeinput'])document.addEventListener(type,event=>window.fixtureEvents.push({type,id:event.target.id}));</script></html>`;

let context, page, worker, cdp, pageSession, extensionId;
let requestId = 0;
const scripts = new Map();
const worlds = new Map();
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const save = () => fs.writeFileSync(path.join(output, 'verification.json'), JSON.stringify(report, null, 2) + '\n');
async function check(name, task) {
  try { report.checks.push({ name, passed: true, evidence: await task() }); }
  catch (error) {
    report.checks.push({ name, passed: false, error: error.stack || error.message });
    await page?.screenshot({ path: path.join(output, `failure-${report.checks.length}.png`) }).catch(() => {});
  }
  console.log(JSON.stringify(report.checks.at(-1)));
  save();
}
async function snapshot() {
  return page.evaluate(() => {
    const editor = document.querySelector('#draft');
    const selection = document.getSelection();
    const nodePath = node => {
      const result = [];
      while (node && node !== editor) { result.unshift([...node.parentNode.childNodes].indexOf(node)); node = node.parentNode; }
      return node === editor ? result : null;
    };
    return {
      documentToken: window.fixtureDocumentToken, timeOrigin: performance.timeOrigin,
      html: editor.innerHTML, text: editor.innerText, plain: document.querySelector('#plain').value,
      activeId: document.activeElement.id,
      selection: { anchor: nodePath(selection.anchorNode), anchorOffset: selection.anchorOffset, focus: nodePath(selection.focusNode), focusOffset: selection.focusOffset },
      events: window.fixtureEvents,
      popupCount: document.querySelectorAll('.live-translate-enhanced-popup').length
    };
  });
}
async function selectDraftBackwards() {
  await page.bringToFront();
  await page.locator('#draft').evaluate(editor => {
    editor.focus();
    document.getSelection().setBaseAndExtent(editor.lastElementChild.firstChild, 9, editor.querySelector('strong').firstChild, 1);
  });
}
async function currentTabId() {
  return worker.evaluate(async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id);
}
async function ready(tabId) {
  return worker.evaluate(async id => {
    try { return await chrome.tabs.sendMessage(id, { type: 'CONTENT_READY' }, { frameId: 0 }); }
    catch { return { success: false }; }
  }, tabId);
}
async function listeners() {
  const result = {};
  for (const [label, expression] of [['document', 'document'], ['editor', 'document.querySelector("#draft")']]) {
    const all = [];
    for (const world of worlds.values()) {
      const { result: object } = await pageSession.send('Runtime.evaluate', { expression, contextId: world.id });
      if (!object.objectId) continue;
      const response = await pageSession.send('DOMDebugger.getEventListeners', { objectId: object.objectId });
      all.push(...response.listeners);
      await pageSession.send('Runtime.releaseObject', { objectId: object.objectId });
    }
    result[label] = all.filter(listener => (scripts.get(listener.scriptId) || '').startsWith(`chrome-extension://${extensionId}/`))
      .reduce((counts, listener) => { counts[listener.type] = (counts[listener.type] || 0) + 1; return counts; }, {});
  }
  return result;
}
const contentScripts = () => [...scripts.values()].filter(url => url === `chrome-extension://${extensionId}/content/content.js`).length;
async function forbidModelCreation(tabId) {
  await worker.evaluate(id => chrome.scripting.executeScript({ target: { tabId: id, frameIds: [0] }, func: () => {
    globalThis.__pageHealthModelCalls = { create: 0, translate: 0 };
    Object.defineProperty(globalThis, 'Translator', { configurable: true, value: {
      availability: async () => 'available',
      create: async () => { globalThis.__pageHealthModelCalls.create++; throw new Error('网页接入验证禁止创建翻译模型'); }
    } });
  } }), tabId);
}
async function modelCalls(tabId) {
  const [{ result }] = await worker.evaluate(id => chrome.scripting.executeScript({ target: { tabId: id, frameIds: [0] }, func: () => globalThis.__pageHealthModelCalls }), tabId);
  return result;
}
async function popupMessage(targetPage, message) {
  await targetPage.bringToFront();
  const targets = (await cdp.send('Target.getTargets', { filter: [{}] })).targetInfos;
  const target = targets.find(item => item.type === 'tab' && item.url === targetPage.url());
  assert.ok(target, '未找到用于真实 activeTab 授权的标签页');
  await cdp.send('Extensions.triggerAction', { id: extensionId, targetId: target.targetId });
  let popup;
  for (let attempt = 0; attempt < 50 && !popup; attempt++) {
    popup = (await cdp.send('Target.getTargets')).targetInfos.find(item => item.url === `chrome-extension://${extensionId}/popup/popup.html`);
    if (!popup) await wait(20);
  }
  assert.ok(popup, '真实工具栏弹窗未打开');
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: popup.targetId, flatten: false });
  try {
    return await new Promise((resolve, reject) => {
      const id = ++requestId;
      const timer = setTimeout(() => { cdp.off('Target.receivedMessageFromTarget', receive); reject(new Error('网页接入工具栏消息超时')); }, 16000);
      function receive(event) {
        if (event.sessionId !== sessionId) return;
        const data = JSON.parse(event.message);
        if (data.id !== id) return;
        clearTimeout(timer); cdp.off('Target.receivedMessageFromTarget', receive);
        if (data.error || data.result?.exceptionDetails) reject(new Error(JSON.stringify(data.error || data.result.exceptionDetails)));
        else resolve(data.result.result.value);
      }
      cdp.on('Target.receivedMessageFromTarget', receive);
      void cdp.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id, method: 'Runtime.evaluate', params: {
        expression: `chrome.runtime.sendMessage(${JSON.stringify(message)})`, awaitPromise: true, returnByValue: true
      } }) }).catch(error => { clearTimeout(timer); cdp.off('Target.receivedMessageFromTarget', receive); reject(error); });
    });
  } finally { await cdp.send('Target.closeTarget', { targetId: popup.targetId }).catch(() => {}); }
}
const recover = checkResult => popupMessage(page, { type: 'RECOVER_ACTIVE_PAGE', expectedTabId: checkResult.tabId, checkId: checkResult.checkId });
async function retireContent() {
  await page.evaluate(() => document.dispatchEvent(new Event('live-translate:dispose')));
  assert.equal((await ready(await currentTabId())).success, false);
}

(async () => {
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chrome', headless: false, ignoreDefaultArgs: true, viewport: { width: 1280, height: 900 },
    args: ['--user-data-dir=' + profile, '--disable-sync', '--no-first-run', '--no-proxy-server', '--remote-debugging-pipe', '--enable-unsafe-extension-debugging']
  });
  try {
    report.chrome = context.browser().version();
    await context.route('https://example.org/**', route => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: fixture }));
    page = await context.newPage();
    await page.goto(fixtureUrl);
    cdp = await context.browser().newBrowserCDPSession();
    pageSession = await context.newCDPSession(page);
    pageSession.on('Debugger.scriptParsed', script => scripts.set(script.scriptId, script.url));
    pageSession.on('Runtime.executionContextCreated', ({ context: world }) => worlds.set(world.id, world));
    pageSession.on('Runtime.executionContextDestroyed', ({ executionContextId }) => worlds.delete(executionContextId));
    pageSession.on('Runtime.executionContextsCleared', () => worlds.clear());
    await pageSession.send('Debugger.enable'); await pageSession.send('Runtime.enable');
    const manager = await context.newPage();
    await manager.goto('chrome://extensions/');
    if (await manager.locator('#devMode').getAttribute('aria-pressed') !== 'true') await manager.locator('#devMode').click();
    extensionId = (await cdp.send('Extensions.loadUnpacked', { path: installedDir })).id;
    report.extensionId = extensionId;
    worker = context.serviceWorkers().find(item => item.url().includes(extensionId)) || await context.waitForEvent('serviceworker', item => item.url().includes(extensionId));
    report.manifest = await worker.evaluate(() => ({ version: chrome.runtime.getManifest().version_name || chrome.runtime.getManifest().version, permissions: chrome.runtime.getManifest().permissions }));
    // 等待本次首次安装欢迎页出现后再关闭，避免异步 tabs.create 抢走首项的活动标签。
    const welcomeURL = `chrome-extension://${extensionId}/setup/setup.html?welcome=1`;
    let welcome;
    for (let attempt = 0; attempt < 250 && !welcome; attempt++) {
      welcome = context.pages().find(candidate => candidate.url() === welcomeURL);
      if (!welcome) await wait(20);
    }
    assert.ok(welcome, '本次安装欢迎页未出现，无法稳定开始活动标签验收');
    await welcome.close();
    report.installationWelcome = { closed: true, ownedTemporaryProfileOnly: true };
    await page.bringToFront();
    await page.waitForFunction(() => document.visibilityState === 'visible');
    let initialCheck;
    await check('真实工具栏 activeTab 自检只握手，不接入已有普通网页、不改草稿', async () => {
      await selectDraftBackwards();
      const before = await snapshot();
      const id = await currentTabId();
      assert.equal((await ready(id)).success, false, '安装时不应自动补接已有 example.org 网页');
      const count = contentScripts();
      initialCheck = await popupMessage(page, { type: 'GET_ACTIVE_PAGE_STATUS' });
      assert.equal(initialCheck.success, true);
      assert.equal(initialCheck.status, 'needs-recovery');
      assert.equal(initialCheck.tabId, id); assert.equal(typeof initialCheck.checkId, 'string');
      assert.equal((await ready(id)).success, false);
      assert.equal(contentScripts(), count);
      assert.deepEqual(await snapshot(), before);
      assert.deepEqual((await listeners()).editor, {});
      return { response: initialCheck, contentInjections: count, draftPreserved: true, listeners: await listeners() };
    });
    await check('非工具栏真实 options 页面无权自检或恢复网页', async () => {
      const options = await context.newPage();
      try {
        await options.goto(`chrome-extension://${extensionId}/options/options.html`);
        const responses = await options.evaluate(async previous => Promise.all([
          chrome.runtime.sendMessage({ type: 'GET_ACTIVE_PAGE_STATUS' }),
          chrome.runtime.sendMessage({ type: 'RECOVER_ACTIVE_PAGE', expectedTabId: previous.tabId, checkId: previous.checkId })
        ]), initialCheck);
        for (const response of responses) { assert.equal(response.success, false); assert.equal(response.status, 'unknown'); }
        return { responses };
      } finally { await options.close(); await page.bringToFront(); }
    });
    await check('显式恢复保留富文本、固定草稿、反向选区和焦点，不派发输入或请求翻译', async () => {
      await selectDraftBackwards();
      const current = await popupMessage(page, { type: 'GET_ACTIVE_PAGE_STATUS' });
      assert.equal(current.status, 'needs-recovery');
      await forbidModelCreation(current.tabId);
      const before = await snapshot();
      const response = await recover(current);
      assert.equal(response.status, 'ready'); assert.equal(response.checkId, current.checkId);
      assert.equal((await ready(current.tabId)).success, true);
      assert.deepEqual(await snapshot(), before);
      assert.deepEqual(await modelCalls(current.tabId), { create: 0, translate: 0 });
      const currentListeners = await listeners();
      assert.equal(currentListeners.editor.input, 1); assert.equal(currentListeners.editor.beforeinput, 1);
      await page.screenshot({ path: path.join(output, 'recovered-draft-preserved.png') });
      return { response, draft: before, listeners: currentListeners, modelCalls: await modelCalls(current.tabId) };
    });
    await check('已接入页重复自检和恢复均不重复注入或叠加监听', async () => {
      const before = await snapshot();
      const initialListeners = await listeners();
      const count = contentScripts();
      const responses = [];
      for (let round = 0; round < 2; round++) {
        const current = await popupMessage(page, { type: 'GET_ACTIVE_PAGE_STATUS' });
        assert.equal(current.status, 'ready');
        const response = await recover(current);
        assert.equal(response.status, 'ready'); responses.push(response);
        assert.equal(contentScripts(), count); assert.deepEqual(await listeners(), initialListeners);
        assert.deepEqual(await snapshot(), before);
      }
      return { responses, contentInjections: count, listeners: initialListeners };
    });
    for (const navigation of ['same-url', 'different-url']) {
      await check(`GET 后${navigation === 'same-url' ? '同 URL 重载' : '异 URL 导航'}使旧 checkId 失效，不接入新文档`, async () => {
        await retireContent();
        const previous = await popupMessage(page, { type: 'GET_ACTIVE_PAGE_STATUS' });
        assert.equal(previous.status, 'needs-recovery');
        if (navigation === 'same-url') await page.reload(); else await page.goto(fixtureUrl + '-next');
        await selectDraftBackwards();
        await retireContent();
        await forbidModelCreation(await currentTabId());
        const before = await snapshot();
        const count = contentScripts();
        const response = await recover(previous);
        assert.equal(response.status, 'unknown'); assert.equal(response.checkId, undefined);
        assert.match(response.message, /重新检查/);
        assert.equal((await ready(await currentTabId())).success, false);
        assert.equal(contentScripts(), count); assert.deepEqual(await snapshot(), before);
        assert.deepEqual(await modelCalls(await currentTabId()), { create: 0, translate: 0 });
        return { response, staleCheckRejected: true, contentInjectionsUnchanged: true, draftPreserved: true };
      });
    }
    await check('Chrome 内部页受限或 URL 不可读时不给恢复入口、不尝试注入', async () => {
      const count = contentScripts();
      const response = await popupMessage(manager, { type: 'GET_ACTIVE_PAGE_STATUS' });
      const visibleTab = await worker.evaluate(async () => {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        return { id: tab?.id, active: tab?.active, status: tab?.status, discarded: tab?.discarded, url: tab?.url ?? null, pendingUrl: tab?.pendingUrl ?? null };
      });
      const urlReadable = typeof visibleTab.url === 'string';
      if (urlReadable) assert.equal(visibleTab.url, 'chrome://extensions/');
      assert.equal(response.success, true);
      // activeTab 在部分 Chrome 内部页不暴露 URL；没有 URL 时只能诚实返回 unknown。
      assert.equal(response.status, urlReadable ? 'restricted' : 'unknown');
      assert.equal(response.checkId, undefined);
      assert.equal(contentScripts(), count);
      return { response, visibleTab, urlReadable, contentInjectionsUnchanged: true };
    });
  } finally {
    save(); await context.close();
    fs.rmSync(temporary, { recursive: true, force: true });
    report.temporaryProfileRemoved = true; save();
  }
  assert.ok(report.checks.length === 7 && report.checks.every(item => item.passed), '存在失败项，详见 verification.json');
})().catch(error => { report.fatalError = error.stack || error.message; save(); console.error(error); process.exitCode = 1; });
