// 最终 ZIP 解压目录的真实 Chrome / 本机模型验收；不替换 Translator，不访问供应商账号。
// 真实网站仅编辑临时草稿，逐项恢复；脚本没有发送、评论或发布动作。
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const extensionDir = path.resolve(process.env.EXTENSION_DIR || 'dist');
const output = path.resolve(process.env.ACCEPTANCE_DIR || 'releases/acceptance');
const profile = process.env.ACCEPTANCE_PROFILE || fs.mkdtempSync(path.join(os.tmpdir(), 'live-translate-release-'));
const report = { scope: process.env.ACCEPTANCE_LOCAL_ONLY === '1' ? 'local-fixed-drafts-only' : 'local-and-official-demo-websites', extensionDir, profile, translator: 'real', providerAccounts: 'not-tested-no-user-credentials', checks: [], websites: [] };
const previous = process.env.ACCEPTANCE_PREVIOUS_REPORT ? JSON.parse(fs.readFileSync(process.env.ACCEPTANCE_PREVIOUS_REPORT)) : null;
if (previous) report.previousRun = { checks: previous.checks, initialAvailability: previous.initialAvailability, progress: previous.progress };
fs.mkdirSync(output, { recursive: true });
let writingPage;
async function check(name, task) {
  try {
    if(writingPage){await writingPage.bringToFront();const close=writingPage.locator('.live-translate-enhanced-popup .header-close');if(await close.isVisible())await close.click();}
    const evidence = await task(); report.checks.push({ name, passed: true, evidence });
  }
  catch (error) {
    const failure={name,passed:false,error:error.message};
    if(writingPage){failure.editor=await writingPage.evaluate(()=>({draft:document.querySelector('#draft').value,activeId:document.activeElement?.id,popup:document.querySelector('.live-translate-enhanced-popup')?.textContent||null,events:window.acceptanceInputEvents||[]}));await writingPage.screenshot({path:path.join(output,`failure-${report.checks.length}.png`)}).catch(()=>{});}
    report.checks.push(failure);
  }
  console.log(JSON.stringify(report.checks.at(-1)));
}
(async () => {
  const server = http.createServer((_req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(fs.readFileSync(path.join(__dirname, 'store-demo.html')));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chrome', headless: false, ignoreDefaultArgs: true,
    viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1,
    args: ['--disable-sync', '--no-first-run', '--remote-debugging-pipe', '--user-data-dir=' + profile, '--enable-unsafe-extension-debugging']
  });
  try {
    report.chrome = context.browser().version();
    const cdp = await context.browser().newBrowserCDPSession();
    const manager = await context.newPage(); await manager.goto('chrome://extensions/');
    const devMode = manager.locator('#devMode');
    if (await devMode.getAttribute('aria-pressed') !== 'true') await devMode.click();
    const { id } = await cdp.send('Extensions.loadUnpacked', { path: extensionDir });
    report.extensionId = id;
    const worker = context.serviceWorkers().find(w => w.url().includes(id)) || await context.waitForEvent('serviceworker', w => w.url().includes(id));
    // 官方 Extensions.triggerAction 使用 tab target，提供正常工具栏 activeTab 授权。
    // popup 属于扩展视图，不在 Playwright context.pages() 中，使用独立 CDP 会话点实际控件。
    async function toolbar(page, selector) {
      await page.bringToFront();
      const targets = (await cdp.send('Target.getTargets', { filter: [{}] })).targetInfos;
      const tab = targets.find(target => target.type === 'tab' && target.url === page.url());
      assert.ok(tab, '没有找到测试标签页');
      await cdp.send('Extensions.triggerAction', { id, targetId: tab.targetId });
      let popup;
      for (let attempt = 0; attempt < 50 && !popup; attempt++) {
        popup = (await cdp.send('Target.getTargets')).targetInfos.find(target => target.url === `chrome-extension://${id}/popup/popup.html`);
        if (!popup) await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.ok(popup, '没有打开实际工具栏');
      const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: popup.targetId, flatten: false });
      let requestId = 0;
      const send = (method, params) => new Promise((resolve, reject) => {
        const next = ++requestId;
        const timer = setTimeout(() => { cdp.off('Target.receivedMessageFromTarget', listener); reject(new Error('工具栏调试响应超时')); }, 5000);
        const listener = event => {
          if (event.sessionId !== sessionId) return;
          const message = JSON.parse(event.message);
          if (message.id !== next) return;
          clearTimeout(timer); cdp.off('Target.receivedMessageFromTarget', listener);
          if (message.error) reject(new Error(message.error.message)); else resolve(message.result);
        };
        cdp.on('Target.receivedMessageFromTarget', listener);
        cdp.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id: next, method, params }) }).catch(reject);
      });
      await send('Runtime.evaluate', { expression: `new Promise(resolve=>{const timer=setInterval(()=>{if(document.querySelector('#toggle-shortcut')?.textContent.includes('启停')){clearInterval(timer);resolve(true)}},20)})`, awaitPromise: true });
      const result = await send('Runtime.evaluate', { expression: `(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`, returnByValue: true });
      const point = result.result.value;
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 }).catch(() => {});
      if (selector !== '#translate-now') await cdp.send('Target.closeTarget', { targetId: popup.targetId });
    }
    await check('最终候选安装与默认本机', async () => {
      const data = await worker.evaluate(async () => ({ manifest: chrome.runtime.getManifest(), local: await chrome.storage.local.get(), state: await chrome.storage.sync.get('enabled') }));
      assert.equal(data.manifest.name, 'LiveTranslate');
      assert.deepEqual(data.manifest.permissions, ['activeTab', 'storage', 'scripting']);
      assert.equal(data.state.enabled, true);
      return { version: data.manifest.version, permissions: data.manifest.permissions, freshLocalKeys: Object.keys(data.local) };
    });
    let setup = context.pages().find(p => p.url().includes(`/setup/setup.html?welcome=1`));
    if (!setup) { await new Promise(resolve => setTimeout(resolve, 500)); setup = context.pages().find(p => p.url().includes('/setup/setup.html?welcome=1')); }
    await check('首次安装欢迎页', async () => {
      if (previous?.extensionDir === extensionDir && previous.checks.some(check => check.name === '首次安装欢迎页' && check.passed)) return '同包同配置首次安装已观察到欢迎页；本次仅重试模型准备和后续验收';
      assert.ok(setup, '未观察到首次欢迎页'); assert.equal(await setup.locator('#welcome').isVisible(), true); return '安装自动打开准备引导';
    });
    if (!setup) { setup = await context.newPage(); await setup.goto(`chrome-extension://${id}/setup/setup.html`); }
    await check('真实本机语言包准备与混合句验证', async () => {
      await setup.bringToFront();
      report.initialAvailability = await setup.evaluate(() => typeof Translator === 'undefined' ? 'missing' : Translator.availability({ sourceLanguage: 'zh', targetLanguage: 'en' }));
      report.progress = [];
      await setup.exposeFunction('recordDownload', value => {
        if (report.progress.at(-1) !== value) { report.progress.push(value); console.log(JSON.stringify({ preparation: value })); }
      });
      await setup.evaluate(() => {
        new MutationObserver(() => window.recordDownload(document.querySelector('#status').textContent)).observe(document.querySelector('#status'), { childList: true });
      });
      assert.equal(await setup.locator('#prepare').isEnabled(), true, await setup.locator('#status').textContent());
      report.preparationAttempts = [];
      let status;
      for (let attempt = 0; attempt < 2; attempt++) {
        const started = Date.now();
        await setup.locator('#prepare').click();
        await setup.waitForFunction(() => /已准备完成|未完成/.test(document.querySelector('#status').textContent), null, { timeout: 645000 });
        status = await setup.locator('#status').textContent();
        report.preparationAttempts.push({ attempt: attempt + 1, elapsedMs: Date.now() - started, status });
        if (status.includes('已准备完成')) break;
      }
      assert.match(status, /已准备完成/);
      const sample = await setup.locator('#sample').textContent(); assert.match(sample, /Hello\. 太棒了。 → /);
      assert.equal(/\p{Script=Han}/u.test(sample.split(' → ')[1]), false);
      await setup.screenshot({ path: path.join(output, '04-real-model-setup-1280x800.png'), animations: 'disabled' });
      return { initialAvailability: report.initialAvailability, status, sample };
    });
    const modelReady = report.checks.at(-1).passed;
    const page = await context.newPage(); await page.goto(origin + '/writing'); writingPage=page;
    const draft = page.locator('#draft');
    await page.evaluate(() => { window.acceptanceInputEvents=[]; for(const type of ['keydown','beforeinput','input','compositionstart','compositionend']) document.querySelector('#draft').addEventListener(type,event=>window.acceptanceInputEvents.push({type,at:performance.now(),trusted:event.isTrusted,key:event.key==='Enter'?'Enter':event.key==='Tab'?'Tab':event.key?'other':undefined,inputType:event.inputType,lineBreak:typeof event.data==='string'?/[\r\n]/.test(event.data):undefined})); });
    const source = '我明天去上海，如果你有空，我们一起吃饭。';
    const translation = async (p, expectedSource) => {
      await p.waitForFunction(source => {
        const error = document.querySelector('.preview-text')?.textContent;
        if (error?.startsWith('翻译失败')) throw new Error(error);
        return document.querySelector('.translated-text')?.textContent?.trim() && (!source || document.querySelector('.original-text')?.textContent === source);
      }, expectedSource, { timeout: 40000 });
      return p.locator('.translated-text').textContent();
    };
    if (modelReady) {
      await check('真实模型自动整句、Tab 替换、光标与继续输入', async () => {
        await page.bringToFront(); await draft.click(); await draft.fill(source);
        const english = await translation(page); assert.equal(/\p{Script=Han}/u.test(english), false); assert.equal(await draft.inputValue(), source);
        await page.screenshot({ path: path.join(output, '01-auto-preview-1280x800.png'), animations: 'disabled' });
        await page.keyboard.press('Tab'); await page.keyboard.type('x');
        assert.equal(await draft.inputValue(), english + 'x');
        assert.equal(await draft.evaluate(e => e.selectionStart), english.length + 1);
        await page.screenshot({ path: path.join(output, '02-accepted-1280x800.png') });
        return { source, english, result: await draft.inputValue() };
      });
      await check('复制按钮与系统快捷键粘贴', async () => {
        await draft.fill('你好，今天测试复制。'); const english = await translation(page);
        await page.locator('.action-copy').click();
        await page.waitForFunction(() => /已复制|复制失败/.test(document.querySelector('.action-copy')?.textContent), null, { timeout: 5000 });
        assert.match(await page.locator('.action-copy').textContent(), /已复制/);
        await draft.click(); await page.keyboard.press('Meta+a'); await page.keyboard.press('Meta+v');
        assert.equal(await draft.inputValue(), english); return { pasted: await draft.inputValue() };
      });
      await check('实际工具栏手动选区与按钮替换', async () => {
        await draft.fill('前文🙂 请帮我整理计划 后续草稿');
        await draft.evaluate(e => { e.focus(); const start = e.value.indexOf('请帮我整理计划'); e.setSelectionRange(start, start + '请帮我整理计划'.length); });
        await toolbar(page, '#translate-now');
        const english = await translation(page, '请帮我整理计划');
        const original = await page.locator('.original-text').textContent(); assert.equal(original.trim(), '请帮我整理计划');
        await page.screenshot({ path: path.join(output, '03-manual-selection-1280x800.png'), animations: 'disabled' });
        await page.locator('.action-replace').click(); await page.keyboard.type('x');
        assert.equal(await draft.inputValue(), '前文🙂 ' + english + 'x 后续草稿');
        return { english, result: await draft.inputValue() };
      });
      await check('手动混合全文与多行保留', async () => {
        const source = 'Hello. 太棒了。\n上午学习，下午运动';
        await draft.fill(source); await draft.click(); await draft.evaluate(e => e.setSelectionRange(e.value.length, e.value.length));
        await toolbar(page, '#translate-now'); const english = await translation(page, source);
        assert.ok(english.startsWith('Hello. ')); assert.equal(/\p{Script=Han}/u.test(english), false); assert.equal(english.split('\n').length, 2);
        await page.keyboard.press('Tab'); await page.keyboard.type('x'); assert.equal(await draft.inputValue(), english + 'x'); return { source, english };
      });
      await check('普通 input 与富文本自动替换', async () => {
        const evidence = [];
        for (const selector of ['#single', '#rich']) {
          const editor = page.locator(selector); await editor.evaluate(e => e.hidden = false); await editor.click(); await editor.fill('你好。');
          const english = await translation(page); await page.keyboard.press('Tab'); await page.keyboard.type('x');
          const actual = await editor.evaluate(e => e.value ?? e.innerText); assert.equal(actual, english + 'x'); evidence.push({ selector, actual });
        }
        return evidence;
      });
      await check('工具栏开关、旧结果失效和无译文 Tab', async () => {
        await toolbar(page, '.switch');
        await page.bringToFront(); await draft.click(); await draft.fill('关闭时保持安静。'); await page.waitForTimeout(400);
        assert.equal(await page.locator('.live-translate-enhanced-popup').count(), 0);
        await page.keyboard.press('Tab'); assert.equal(await draft.evaluate(e => e === document.activeElement), false);
        await toolbar(page, '.switch');
        return '工具栏禁用清理与恢复通过；普通 Tab 保持焦点移动';
      });
      for (const site of process.env.ACCEPTANCE_LOCAL_ONLY === '1' ? [] : [
        { name: 'ProseMirror 官方基础示例', url: 'https://prosemirror.net/examples/basic/', selector: '.ProseMirror' },
        { name: 'Lexical 官方 Playground', url: 'https://playground.lexical.dev/', selector: '[contenteditable=true]' },
        { name: 'Reddit', url: 'https://www.reddit.com/r/AskReddit/', selector: '[contenteditable=true]' }
      ]) {
        const website = await context.newPage(); const evidence = { name: site.name, url: site.url, verified: false };
        try {
          await website.goto(site.url, { waitUntil: 'domcontentloaded', timeout: 35000 });
          const editor = website.locator(site.selector).first(); await editor.waitFor({ state: 'visible', timeout: 8000 });
          const original = await editor.evaluate(e => ({ html: e.innerHTML, text: e.innerText, lexical: e.hasAttribute('data-lexical-editor'), classes: e.className }));
          evidence.editor = { lexical: original.lexical, classes: original.classes };
          try {
            await editor.click(); await website.keyboard.press('Meta+a');
            // Lexical 的首轮全选可能只选当前段；先删除所选文本再真实插入，
            // 保留其余示例作为前后文，不把站点自己的选区语义当插件故障。
            await website.keyboard.press('Backspace'); await website.keyboard.insertText('本轮只测试原文保护。');
            const testDraft = await editor.innerText(); assert.ok(testDraft.includes('本轮只测试原文保护。'));
            await toolbar(website, '#translate-now');
            const english = await translation(website);
            assert.ok((await website.locator('.original-text').textContent()).includes('本轮只测试原文保护。'));
            if (original.lexical) {
              assert.equal(await website.locator('.action-replace').count(), 0);
              assert.match(await website.locator('.replacement-notice').textContent(), /暂不直接替换/);
              await website.locator('.action-copy').click();
              await website.waitForFunction(() => document.querySelector('.action-copy')?.textContent.includes('已复制'));
            } else { await website.keyboard.press('Tab'); await website.keyboard.type('x'); }
            const actual = await editor.innerText();
            evidence.result = actual;
            if (original.lexical) { assert.equal(actual, testDraft); assert.equal(/\p{Script=Han}/u.test(english), false); evidence.behavior = '受控编辑器保留原文并提供复制退路'; }
            else { assert.equal(actual, english + 'x'); evidence.behavior = '替换与继续输入成功'; }
            evidence.verified = true;
          } finally {
            // 官方演示无个人草稿，刷新恢复原始示例，避免把段落的显示空行当成输入换行再插入。
            await website.reload({ waitUntil: 'domcontentloaded' });
            await website.locator(site.selector).first().waitFor({ state: 'visible' });
            assert.equal(await website.locator(site.selector).first().innerText(), original.text, '测试示例未能恢复');
            evidence.draftRestored = true;
          }
        } catch (error) { evidence.verified = false; evidence.error = error.message; }
        finally { report.websites.push(evidence); console.log(JSON.stringify({ website: evidence })); await website.close(); }
      }
    }
    await check('服务切换使页面旧预览失效', async () => {
      if (!modelReady) throw new Error('真实本机模型未准备，无法产生真实旧预览');
      await page.bringToFront(); await draft.click(); await draft.fill('测试服务切换。'); await translation(page);
      const options = await context.newPage(); await options.goto(`chrome-extension://${id}/options/options.html`);
      await options.waitForFunction(() => !document.querySelector('#provider').disabled);
      await options.locator('#save').click(); await options.waitForFunction(() => document.querySelector('#status').textContent.includes('已保存'));
      await page.bringToFront(); await page.waitForFunction(() => !document.querySelector('.live-translate-enhanced-popup'));
      assert.equal(await draft.inputValue(), '测试服务切换。');
      await options.screenshot({ path: path.join(output, '05-service-settings-1280x800.png') });
      await options.close(); return '保存新配置版本后旧预览清除，原文保留';
    });
    for (const selector of ['#draft', '#rich', '#single']) await page.locator(selector).evaluate(element => {
      if ('value' in element) element.value = ''; else element.textContent = '';
    });
    report.localDraftsRestored = true;
  } finally {
    report.inputEvents = await context.pages().find(p => p.url() === origin + '/writing')?.evaluate(() => window.acceptanceInputEvents || []).catch(() => []);
    fs.writeFileSync(path.join(output, 'acceptance.json'), JSON.stringify(report, null, 2) + '\n');
    await context.close(); await new Promise(resolve => server.close(resolve));
  }
  console.log(JSON.stringify({ passed: report.checks.filter(c => c.passed).length, failed: report.checks.filter(c => !c.passed).length, output }));
  process.exitCode = report.checks.some(c => !c.passed) || report.websites.some(site => !site.verified || !site.draftRestored || site.error) ? 1 : 0;
})().catch(error => { console.error(error); process.exitCode = 1; });
