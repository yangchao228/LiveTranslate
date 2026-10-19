// 执行真实工具栏；Chrome API / Translator 全部为显式替身，不访问个人 Chrome。
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const extension = path.resolve(process.env.EXTENSION_DIR || 'dist');
const output = path.resolve(process.env.UI_OUTPUT_DIR || 'releases/page-health-popup');
const extensionURL = pathToFileURL(extension + path.sep).href;
(async () => {
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const checks = [], errors = [];
  const record = name => checks.push(name);
  async function open(options = {}) {
    const page = await browser.newPage({ viewport: { width: 352, height: 600 }, reducedMotion: 'reduce' });
    page.setDefaultTimeout(5000);
    page.on('pageerror', error => errors.push(error.message));
    await page.route(/^https?:\/\//, route => route.abort());
    if (options.clock) { const now = new Date('2026-10-18T00:00:00Z'); await page.clock.install({ time: now }); await page.clock.pauseAt(now); }
    await page.addInitScript(({ options, extensionURL }) => {
      const s = window.__health = { ...options, enabled: options.enabled ?? true, readingEnabled: options.readingEnabled ?? true, messages: [], calls: [], tabs: [], releases: {}, page: options.page || 'ready', provider: options.provider || 'browser', tabId: 73 };
      window.chrome = window.chrome || {};
      chrome.runtime = {
        getURL: resource => new URL(resource, extensionURL).href,
        async openOptionsPage() { s.tabs.push({ options: true }); },
        async sendMessage(message) {
          s.messages.push(message);
          if (message.type === 'GET_EXTENSION_STATE') return { enabled: s.enabled, readingEnabled: s.readingEnabled };
          if (message.type === 'GET_TRANSLATION_CONFIG') return { success: true, config: { provider: s.provider } };
          if (message.type === 'GET_ACTIVE_PAGE_STATUS') {
            const response = { success: true, status: s.page, tabId: s.tabId, checkId: s.missingCheckId ? undefined : 'fixture-check' };
            if (s.holdPage) await new Promise(resolve => { s.releases.page = resolve; });
            if (s.pageError) throw new Error('fixture page failure');
            return response;
          }
          if (message.type === 'RECOVER_ACTIVE_PAGE') {
            const response = { success: !s.recoverError, status: s.recovered || 'ready', tabId: s.recoveryTabId ?? s.tabId, checkId: 'fixture-check' };
            if (s.holdRecovery) await new Promise(resolve => { s.releases.recovery = resolve; });
            return response;
          }
          if (message.type === 'TRANSLATE_ACTIVE_EDITOR') return { success: false, error: 'fixture routed' };
          if (message.type === 'SET_EXTENSION_STATE') { s.enabled = message.enabled; return { success: true }; }
          if (message.type === 'SET_READING_STATE') { s.readingEnabled = message.enabled; return { success: true, enabled: message.enabled }; }
          throw new Error(`unexpected fixture message ${message.type}`);
        }
      };
      chrome.tabs = { async query() { if (s.sourceError) throw new Error('fixture query failure'); return [{ id: 73, url: 'https://example.invalid/private-draft' }]; }, async create(value) { s.tabs.push(value); } };
      chrome.commands = { async getAll() { if (s.shortcutError) throw new Error('fixture commands failure'); return [{ name: 'translate_selection', shortcut: 'Alt+R' }]; } };
      Object.defineProperty(window, 'Translator', { configurable: true, value: s.noTranslator ? undefined : {
        async availability(pair) {
          const direction = `${pair.sourceLanguage}-${pair.targetLanguage}`;
          s.calls.push(pair);
          const value = s[direction] || 'available';
          if (s[`hold-${direction}`]) await new Promise(resolve => { s.releases[direction] = resolve; });
          if (value === 'error') throw new Error('fixture availability failure');
          return value;
        },
        async create() { throw new Error('工具栏禁止创建或下载模型'); }
      } });
    }, { options, extensionURL });
    await page.goto(pathToFileURL(path.join(extension, 'popup/popup.html')).href);
    return page;
  }
  const settled = page => page.waitForFunction(() => !document.getElementById('retry-read').disabled);
  const pageDone = page => page.waitForFunction(() => document.getElementById('recover-page').getAttribute('aria-busy') !== 'true');
  async function capture(page, name) {
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.locator('body').screenshot({ path: path.join(output, name + '.png') });
  }
  try {
    const labels = { available: '已下载', downloadable: '需要准备', downloading: '下载中', unavailable: '不可用', error: '检查失败' };
    for (const writing of Object.keys(labels)) for (const reading of Object.keys(labels)) {
      const page = await open({ 'zh-en': writing, 'en-zh': reading }); await settled(page);
      assert.equal(await page.locator('#writing-pack-status').textContent(), labels[writing]);
      assert.equal(await page.locator('#reading-pack-status').textContent(), labels[reading]);
      assert.deepEqual(await page.evaluate(() => __health.calls), [{ sourceLanguage: 'zh', targetLanguage: 'en' }, { sourceLanguage: 'en', targetLanguage: 'zh' }]);
      assert.equal(await page.locator('#translate-now').isEnabled(), writing === 'available' || reading === 'available');
      for (const [state, id] of [[writing, 'prepare-translation'], [reading, 'prepare-reading']]) {
        assert.equal(await page.locator('#' + id).isVisible(), state !== 'unavailable');
      }
      if (writing === 'available' && reading === 'available') {
        await capture(page, 'normal-both-ready');
        const dimensions = await page.evaluate(() => ({ height: document.body.scrollHeight, viewport: innerHeight, settingsBottom: document.getElementById('translation-settings').getBoundingClientRect().bottom }));
        assert.ok(dimensions.height <= 600 && dimensions.settingsBottom <= 600, JSON.stringify(dimensions));
        fs.writeFileSync(path.join(output, 'normal-dimensions.json'), JSON.stringify(dimensions, null, 2) + '\n');
      }
      if (writing === 'available' && reading === 'downloadable') await capture(page, 'reading-needs-prepare');
      record(`双向独立 ${writing}/${reading}`); await page.close();
    }
    for (const direction of ['zh-en', 'en-zh']) {
      const page = await open({ enabled: direction === 'zh-en', readingEnabled: direction === 'en-zh', [direction]: 'downloadable' }); await settled(page);
      assert.equal(await page.locator('#translate-label').textContent(), direction === 'zh-en' ? '准备中译英' : '准备英译中');
      await page.locator('#translate-now').click();
      const url = new URL(await page.evaluate(() => __health.tabs.at(-1).url));
      assert.deepEqual([...url.searchParams], [['direction', direction], ['returnTab', '73']]);
      assert.equal(await page.evaluate(() => __health.messages.some(message => message.type === 'TRANSLATE_ACTIVE_EDITOR')), false);
      record(`单开 ${direction} 准备按钮不误导方向且只传tabId`); await page.close();
    }
    for (const provider of ['volcengine-direct', 'volcengine', 'custom']) {
      const page = await open({ provider, noTranslator: true }); await settled(page);
      assert.equal(await page.locator('#model-status').isHidden(), true);
      assert.equal(await page.locator('#prepare-reading').isHidden(), true);
      assert.equal(await page.locator('#translate-now').isEnabled(), true);
      assert.deepEqual(await page.evaluate(() => __health.calls), []);
      record(`远程 ${provider} 不查本机语言包`); await page.close();
    }
    {
      const page = await open({ noTranslator: true }); await settled(page);
      assert.equal(await page.locator('#translate-now').isDisabled(), true);
      assert.equal(await page.locator('#writing-pack-status').textContent(), '不支持');
      assert.equal(await page.locator('#reading-pack-status').textContent(), '不支持');
      assert.match(await page.locator('#model-note').textContent(), /其他服务/);
      record('无Translator API不创建/下载模型且保留服务退路'); await page.close();
    }
    {
      const page = await open({ 'hold-zh-en': true, clock: true });
      await page.waitForFunction(() => typeof __health.releases['zh-en'] === 'function');
      assert.equal(await page.locator('#writing-pack-status').textContent(), '检查中');
      assert.equal(await page.locator('#reading-pack-status').textContent(), '已下载');
      assert.equal(await page.locator('#translate-now').isEnabled(), true);
      await page.clock.runFor(4100); await settled(page);
      assert.equal(await page.locator('#writing-pack-status').textContent(), '检查失败');
      assert.equal(await page.locator('#translate-now').isEnabled(), true);
      record('单向超时独立降级，不阻塞另一方向'); await page.close();
    }
    for (const status of ['ready', 'needs-recovery', 'restricted', 'unknown']) {
      const page = await open({ page: status }); await settled(page);
      assert.equal(await page.evaluate(() => __health.messages.some(message => message.type === 'RECOVER_ACTIVE_PAGE')), false, '打开工具栏只自检');
      assert.equal(await page.locator('#recover-page').isVisible(), ['needs-recovery', 'unknown'].includes(status));
      assert.equal(await page.locator('#translate-now').isEnabled(), status !== 'restricted');
      if (status === 'needs-recovery') {
        await page.locator('#recover-page').focus(); await page.keyboard.press('Enter'); await pageDone(page);
        assert.equal(await page.locator('#page-status').textContent(), '当前网页已接入');
        assert.deepEqual(await page.evaluate(() => __health.messages.filter(message => message.type === 'RECOVER_ACTIVE_PAGE')), [{ type: 'RECOVER_ACTIVE_PAGE', expectedTabId: 73, checkId: 'fixture-check' }]);
      }
      if (status === 'restricted') await capture(page, 'restricted-page');
      record(`页面 ${status} 准确呈现且只显式恢复`); await page.close();
    }
    for (const options of [{ pageError: true }, { holdPage: true, clock: true }]) {
      const page = await open(options);
      if (options.holdPage) { await page.waitForFunction(() => typeof __health.releases.page === 'function'); await page.clock.runFor(4100); }
      await settled(page);
      assert.equal(await page.locator('#page-status').textContent(), '当前网页尚未确认');
      assert.equal(await page.locator('#translate-now').isEnabled(), true);
      assert.equal(await page.locator('#recover-page').textContent(), '重新检查');
      record(options.holdPage ? '自检超时可重试且不封堵手动' : '自检异常独立失败不封堵手动'); await page.close();
    }
    for (const options of [{ recoverError: true }, { recoveryTabId: 74 }, { recovered: 'unknown' }, { holdRecovery: true, clock: true }]) {
      const page = await open({ page: 'needs-recovery', ...options }); await settled(page);
      await page.locator('#recover-page').click();
      if (options.holdRecovery) { await page.waitForFunction(() => typeof __health.releases.recovery === 'function'); await page.clock.runFor(12100); }
      await pageDone(page);
      assert.notEqual(await page.locator('#page-status').textContent(), '当前网页已接入');
      assert.equal(await page.locator('#recover-page').isEnabled(), true);
      assert.match(await page.locator('#page-hint').textContent(), /网站|重新检查/);
      await capture(page, options.holdRecovery ? 'recovery-timeout' : 'recovery-not-confirmed');
      record(`恢复未确认 ${JSON.stringify(options)} 不冒充成功且有下一步`); await page.close();
    }
    {
      const page = await open({ page: 'needs-recovery', holdRecovery: true, shortcutError: true }); await settled(page);
      await page.locator('#recover-page').click();
      await page.waitForFunction(() => typeof __health.releases.recovery === 'function');
      await page.evaluate(() => { __health.page = 'restricted'; __health.shortcutError = false; });
      await page.locator('#retry-read').click(); await settled(page);
      assert.equal(await page.locator('#page-status').textContent(), '此页面不支持翻译');
      await page.evaluate(() => __health.releases.recovery());
      assert.equal(await page.locator('#page-status').textContent(), '此页面不支持翻译');
      record('重试读取隔离旧恢复成功，不覆盖新网页状态'); await page.close();
    }
    {
      const page = await open({ 'hold-en-zh': true, shortcutError: true, clock: true });
      await page.waitForFunction(() => typeof __health.releases['en-zh'] === 'function'); await page.clock.runFor(4100); await settled(page);
      await page.evaluate(() => { __health['hold-en-zh'] = false; __health.provider = 'custom'; __health.shortcutError = false; });
      await page.locator('#retry-read').click(); await settled(page);
      await page.evaluate(() => __health.releases['en-zh']());
      assert.equal(await page.locator('#model-status').isHidden(), true);
      assert.match(await page.locator('#translation-mode').textContent(), /自定义服务/);
      assert.equal(await page.locator('#translate-now').isEnabled(), true);
      record('服务重读隔离旧语言包结果，远程不受旧本机结果影响'); await page.close();
    }
    {
      const page = await open({ page: 'needs-recovery' }); await settled(page);
      await page.locator('#recover-page').focus();
      assert.equal(await page.locator('#recover-page').evaluate(el => getComputedStyle(el).outlineStyle), 'solid');
      assert.equal(await page.locator('#recover-page').evaluate(el => getComputedStyle(el).transitionDuration), '0s');
      await page.setViewportSize({ width: 390, height: 600 });
      await page.locator('.shortcut-section > summary').click();
      await page.locator('#user-guide').scrollIntoViewIfNeeded();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      record('352/390窄屏、键盘焦点、减少动效和长状态滚动可达'); await page.close();
    }
    {
      const page = await open({ page: 'needs-recovery', missingCheckId: true }); await settled(page);
      assert.equal(await page.locator('#page-status').textContent(), '当前网页尚未确认');
      assert.equal(await page.locator('#recover-page').textContent(), '重新检查');
      await page.evaluate(() => { __health.missingCheckId = false; });
      await page.locator('#recover-page').click();
      await page.waitForFunction(() => document.getElementById('recover-page').textContent === '重新接入');
      assert.equal(await page.evaluate(() => __health.messages.some(message => message.type === 'RECOVER_ACTIVE_PAGE')), false);
      await page.locator('#recover-page').click(); await pageDone(page);
      assert.equal(await page.locator('#page-status').textContent(), '当前网页已接入');
      record('缺检查令牌不发送恢复；显式重查新令牌后才可接入'); await page.close();
    }
    {
      const page = await open({ page: 'needs-recovery', holdRecovery: true, clock: true }); await settled(page);
      await page.locator('#recover-page').click();
      await page.waitForFunction(() => typeof __health.releases.recovery === 'function');
      await page.clock.runFor(9000);
      assert.equal(await page.locator('#recover-page').isDisabled(), true);
      assert.equal(await page.locator('#page-status').textContent(), '正在重新接入…');
      assert.equal(await page.evaluate(() => __health.messages.filter(message => message.type === 'RECOVER_ACTIVE_PAGE').length), 1);
      await page.evaluate(() => __health.releases.recovery()); await pageDone(page);
      assert.equal(await page.locator('#page-status').textContent(), '当前网页已接入');
      record('恢复等待覆盖后台10秒预算，进行中不重复请求'); await page.close();
    }
    for (const direction of ['zh-en', 'en-zh']) {
      const page = await open({ sourceError: true }); await settled(page);
      await page.locator(direction === 'zh-en' ? '#prepare-translation' : '#prepare-reading').click();
      const url = new URL(await page.evaluate(() => __health.tabs.at(-1).url));
      assert.deepEqual([...url.searchParams], [['direction', direction]]);
      record(`已下载 ${direction} 仍可主动验证，来源读取失败只省略返回ID`); await page.close();
    }
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ provider: 'explicit mocks', checks, errors }, null, 2) + '\n');
    console.log(JSON.stringify({ total: checks.length, errors, output }));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
