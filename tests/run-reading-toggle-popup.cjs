// 工具栏划词开关回归：执行真实 popup 文件；Chrome API / Translator 明确使用替身。
// 独立临时 Chrome，不修改用户扩展、翻译模型、草稿或系统剪贴板。
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const extension = path.resolve(process.env.EXTENSION_DIR || 'dist');
const output = path.resolve(process.env.UI_OUTPUT_DIR || 'releases/reading-toggle-popup');
const extensionURL = pathToFileURL(extension + path.sep).href;

(async () => {
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const checks = [], errors = [];
  async function open(options = {}) {
    const page = await browser.newPage({ viewport: { width: 390, height: 900 }, reducedMotion: 'reduce' });
    page.setDefaultTimeout(5000);
    page.on('pageerror', error => errors.push(error.message));
    await page.route(/^https?:\/\//, route => route.abort());
    if (options.clock) {
      const now = new Date('2026-10-18T00:00:00Z');
      await page.clock.install({ time: now });
      await page.clock.pauseAt(now);
    }
    await page.addInitScript(({ options, extensionURL }) => {
      const state = window.__readingToggle = {
        enabled: true, readingEnabled: true, ...options, messages: [], releases: {}, tabs: [], translated: 0
      };
      window.chrome = window.chrome || {};
      chrome.runtime = {
        onMessage: { addListener() {} },
        getURL: resource => new URL(resource, extensionURL).href,
        async openOptionsPage() {},
        async sendMessage(message) {
          state.messages.push(message);
          if (message.type === 'GET_EXTENSION_STATE') {
            if (state.stateError) throw new Error('fixture state failure');
            if (state.holdState) await new Promise(resolve => { state.releases.state = resolve; });
            return { enabled: state.enabled, ...(state.legacyState ? {} : { readingEnabled: state.readingEnabled }) };
          }
          if (message.type === 'GET_ACTIVE_PAGE_STATUS') return { success: true, status: 'ready', tabId: 73, checkId: 'fixture-check' };
          if (message.type === 'GET_TRANSLATION_CONFIG') return { success: true, config: { provider: 'browser' } };
          if (message.type === 'SET_EXTENSION_STATE') {
            if (state.holdWritingSave) await new Promise(resolve => { state.releases.writingSave = resolve; });
            if (state.writingSaveThrow) throw new Error('fixture writing save failure');
            if (state.writingSaveFailure) return { success: false };
            state.enabled = message.enabled;
            return { success: true };
          }
          if (message.type === 'SET_READING_STATE') {
            if (state.holdSave) await new Promise(resolve => { state.releases.save = resolve; });
            if (state.saveThrow) throw new Error('fixture save failure');
            if (state.saveFailure) return { success: false };
            if (state.invalidSave) return { success: true };
            state.readingEnabled = message.enabled;
            return { success: true, enabled: state.readingEnabled };
          }
          if (message.type === 'TRANSLATE_ACTIVE_EDITOR') {
            state.translated++;
            return { success: false, error: state.manualError || '请先选择网页正文英文，或点击已开启翻译的输入框。' };
          }
          throw new Error(`unexpected fixture message: ${message.type}`);
        }
      };
      chrome.commands = { async getAll() { return [
        { name: 'translate_selection', shortcut: 'Alt+R' }, { name: 'toggle_extension', shortcut: 'Alt+T' }
      ]; } };
      chrome.tabs = { async query() { return [{ id: 73 }]; }, async create(value) { state.tabs.push(value); } };
      Object.defineProperty(window, 'Translator', { configurable: true, value: state.noTranslator ? undefined : {
        async availability(languages) {
          if (languages.sourceLanguage === 'en') return state.readingAvailability || 'available';
          if (state.holdLocal) await new Promise(resolve => { state.releases.local = resolve; });
          if (state.localError) throw new Error('fixture availability failure');
          return state.availability || 'available';
        },
        async create() { throw new Error('工具栏不能创建翻译模型'); }
      } });
    }, { options, extensionURL });
    await page.goto(pathToFileURL(path.join(extension, 'popup/popup.html')).href);
    return page;
  }
  const settled = page => page.waitForFunction(() => !document.getElementById('retry-read').disabled);
  const saved = page => page.waitForFunction(() => !document.getElementById('reading-toggle').disabled);
  const writingSaved = page => page.waitForFunction(() => !document.getElementById('toggle-switch').disabled);
  const record = name => checks.push(name);
  async function capture(page, name) {
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.locator('body').screenshot({ path: path.join(output, `${name}.png`) });
  }
  try {
    for (const options of [{}, { legacyState: true }]) {
      const page = await open(options); await settled(page);
      assert.equal(await page.getByRole('switch', { name: '划词英译中', exact: true }).isChecked(), true);
      assert.equal(await page.getByRole('switch', { name: '输入中译英', exact: true }).isChecked(), true);
      assert.equal(await page.locator('#reading-state').textContent(), '已开启');
      assert.match(await page.locator('#reading-detail').textContent(), /选中正文英文/);
      assert.equal(await page.locator('#translate-now').isEnabled(), true);
      assert.equal(await page.locator('#prepare-reading').getAttribute('aria-label'), '验证英译中语言包');
      assert.deepEqual(await page.evaluate(() => __readingToggle.messages.filter(value => value.type.startsWith('SET_'))), []);
      assert.equal(await page.evaluate(() => __readingToggle.translated), 0);
      assert.equal(await page.locator('#primary-shortcut').textContent(), 'Alt+R');
      assert.equal(await page.locator('#toggle-shortcut').textContent(), '输入中译英：Alt+T');
      if (!options.legacyState) await capture(page, 'toolbar-reading-on');
      record(options.legacyState ? '旧响应缺失独立偏好时默认开启' : '开启状态、可访问名称与独立准备入口');
      await page.close();
    }
    {
      const page = await open({ readingEnabled: false }); await settled(page);
      assert.equal(await page.locator('#reading-toggle').isChecked(), false);
      assert.equal(await page.locator('#reading-state').textContent(), '已关闭');
      assert.match(await page.locator('#reading-detail').textContent(), /不再显示划词入口/);
      assert.equal(await page.locator('#toggle-switch').isChecked(), true);
      await page.locator('#translate-now').click();
      assert.equal(await page.evaluate(() => __readingToggle.translated), 1, '独立关闭不得阻止写作入口');
      await capture(page, 'toolbar-reading-off');
      record('读取关闭偏好，写作手动翻译继续可用'); await page.close();
    }
    {
      const page = await open({ holdState: true });
      await page.waitForFunction(() => typeof __readingToggle.releases.state === 'function');
      assert.equal(await page.locator('#reading-toggle').isDisabled(), true);
      assert.equal(await page.locator('#reading-toggle').isChecked(), false);
      assert.equal(await page.locator('#reading-state').textContent(), '正在读取');
      await page.evaluate(() => __readingToggle.releases.state()); await settled(page);
      assert.equal(await page.locator('#reading-toggle').isChecked(), true);
      record('未知状态不假定开启，读取完成再启用开关'); await page.close();
    }
    for (const options of [{ stateError: true }, { readingEnabled: 'invalid' }]) {
      const page = await open(options); await settled(page);
      assert.equal(await page.locator('#reading-toggle').isDisabled(), true);
      assert.equal(await page.locator('#reading-state').textContent(), '读取失败');
      assert.equal(await page.locator('#retry-read').isVisible(), true);
      if (!options.stateError) assert.equal(await page.locator('#translate-now').isEnabled(), true, '独立状态无效不阻止已确认的写作功能');
      await page.evaluate(() => { __readingToggle.stateError = false; __readingToggle.readingEnabled = false; });
      await page.locator('#retry-read').click(); await settled(page);
      assert.equal(await page.locator('#reading-toggle').isEnabled(), true);
      assert.equal(await page.locator('#reading-toggle').isChecked(), false);
      assert.equal(await page.locator('#retry-read').isVisible(), false);
      record(options.stateError ? '状态读取失败后显式重试恢复' : '非法划词偏好独立失败，重试恢复'); await page.close();
    }
    {
      const page = await open({ holdSave: true }); await settled(page);
      await page.locator('#reading-toggle').focus(); await page.keyboard.press('Space');
      await page.waitForFunction(() => typeof __readingToggle.releases.save === 'function');
      assert.equal(await page.locator('#reading-toggle').isDisabled(), true);
      assert.equal(await page.locator('#reading-toggle').isChecked(), true, '确认前显示原状态');
      assert.equal(await page.locator('#reading-state').textContent(), '已开启');
      await page.evaluate(() => __readingToggle.releases.save()); await saved(page);
      assert.equal(await page.locator('#reading-toggle').isChecked(), false);
      assert.equal(await page.locator('#reading-toggle').evaluate(el => el === document.activeElement), true);
      assert.equal(await page.locator('#toggle-switch').isChecked(), true);
      assert.equal(await page.locator('#translate-now').isEnabled(), true);
      assert.deepEqual(await page.evaluate(() => __readingToggle.messages.filter(value => value.type.startsWith('SET_'))), [{ type: 'SET_READING_STATE', enabled: false }]);
      assert.match(await page.locator('#feedback').textContent(), /输入中译英仍可使用/);
      record('异步保存仅确认后更新，保留焦点且不改输入开关'); await page.close();
    }
    for (const failure of ['saveFailure', 'saveThrow', 'invalidSave']) {
      const page = await open({ [failure]: true }); await settled(page);
      await page.locator('#reading-toggle').focus(); await page.keyboard.press('Space'); await saved(page);
      assert.equal(await page.locator('#reading-toggle').isChecked(), true);
      assert.equal(await page.locator('#reading-state').textContent(), '已开启');
      assert.match(await page.locator('#feedback').textContent(), /已保留原状态/);
      assert.equal(await page.locator('#feedback').evaluate(el => el.classList.contains('error')), true);
      assert.equal(await page.locator('#reading-toggle').evaluate(el => el === document.activeElement), true);
      record(`保存 ${failure} 保留已确认偏好和键盘焦点`); await page.close();
    }
    {
      const page = await open({ holdSave: true, clock: true }); await settled(page);
      await page.locator('#reading-toggle').focus(); await page.keyboard.press('Space');
      await page.waitForFunction(() => typeof __readingToggle.releases.save === 'function');
      await page.clock.runFor(4100); await saved(page);
      assert.equal(await page.locator('#reading-toggle').isChecked(), true);
      assert.match(await page.locator('#feedback').textContent(), /已保留原状态/);
      record('保存无回应时有界恢复，不长期锁住开关'); await page.close();
    }
    {
      const page = await open({ enabled: false }); await settled(page);
      assert.equal(await page.locator('#reading-toggle').isEnabled(), true);
      assert.match(await page.locator('#reading-detail').textContent(), /选中正文英文/);
      assert.equal(await page.locator('#translate-now').isEnabled(), true);
      assert.equal(await page.locator('#status-text').textContent(), '已关闭');
      assert.match(await page.locator('#translate-hint').textContent(), /输入中译英未开启/);
      assert.equal(await page.locator('#reading-pack-status').textContent(), '已下载');
      await capture(page, 'toolbar-reading-only');
      await page.locator('#translate-now').click();
      assert.equal(await page.evaluate(() => __readingToggle.translated), 1);
      assert.equal(await page.evaluate(() => __readingToggle.tabs.length), 0, '阅读独开不能跳转中译英准备页');
      await page.locator('#reading-toggle').uncheck(); await saved(page);
      assert.equal(await page.locator('#reading-toggle').isChecked(), false);
      assert.equal(await page.locator('#translate-now').isDisabled(), true);
      assert.equal(await page.locator('#feedback').textContent(), '划词英译中已关闭。');
      await page.locator('#toggle-switch').check();
      await writingSaved(page);
      assert.equal(await page.locator('#reading-toggle').isChecked(), false);
      assert.equal(await page.locator('#translate-now').isEnabled(), true);
      record('阅读独开可手动翻译，两者关闭禁用，独开输入后仍保留划词关闭'); await page.close();
    }
    {
      const page = await open({ enabled: false, readingEnabled: false }); await settled(page);
      await page.locator('#reading-toggle').check(); await saved(page);
      assert.equal(await page.locator('#reading-toggle').isChecked(), true);
      assert.match(await page.locator('#reading-detail').textContent(), /选中正文英文/);
      assert.equal(await page.locator('#toggle-switch').isChecked(), false);
      assert.equal(await page.locator('#translate-now').isEnabled(), true);
      assert.match(await page.locator('#feedback').textContent(), /划词英译中已开启/);
      await capture(page, 'toolbar-writing-off-reading-on');
      record('两者关闭时独开划词立即可用，不开启输入翻译'); await page.close();
    }
    {
      const page = await open({ enabled: false, readingEnabled: false }); await settled(page);
      assert.equal(await page.locator('#translate-now').isDisabled(), true);
      assert.match(await page.locator('#translate-hint').textContent(), /先开启输入中译英或划词英译中/);
      assert.equal(await page.locator('#primary-shortcut').textContent(), 'Alt+R');
      await capture(page, 'toolbar-both-off');
      record('双关状态与实际快捷键保持可读，手动按钮禁用'); await page.close();
    }
    for (const availability of ['downloadable', 'downloading', 'unavailable']) {
      const page = await open({ enabled: false, availability }); await settled(page);
      assert.equal(await page.locator('#translate-label').textContent(), '手动翻译');
      assert.equal(await page.locator('#translate-now').isEnabled(), true);
      assert.equal(await page.locator('#reading-pack-status').textContent(), '已下载');
      await page.locator('#translate-now').click();
      assert.equal(await page.evaluate(() => __readingToggle.translated), 1);
      assert.deepEqual(await page.evaluate(() => __readingToggle.tabs), []);
      record(`阅读独开不受中译英包 ${availability} 状态阻断或误导`); await page.close();
    }
    for (const enabled of [false, true]) {
      const page = await open({ enabled, noTranslator: true }); await settled(page);
      assert.equal(await page.locator('#translate-now').isDisabled(), true);
      assert.match(await page.locator('#model-note').textContent(), /当前浏览器或设备不支持/);
      assert.match(await page.locator('#translate-hint').textContent(), /其他服务/);
      assert.equal(await page.locator('#prepare-translation').isHidden(), true);
      assert.equal(await page.evaluate(() => __readingToggle.translated), 0);
      record(`${enabled ? '双开' : '阅读独开'}在整个Translator API不支持时禁用本机手动并保留明确服务退路`); await page.close();
    }
    {
      const page = await open({ availability: 'downloadable' }); await settled(page);
      assert.equal(await page.locator('#translate-label').textContent(), '手动翻译');
      await page.locator('#translate-now').click();
      assert.equal(await page.evaluate(() => __readingToggle.translated), 1);
      assert.deepEqual(await page.evaluate(() => __readingToggle.tabs), []);
      record('双开时不预判目标，不把正文手动翻译重定向至中译英准备页'); await page.close();
    }
    {
      const page = await open({ readingEnabled: false, availability: 'downloadable' }); await settled(page);
      assert.equal(await page.locator('#translate-label').textContent(), '准备中译英');
      await page.locator('#translate-now').click();
      assert.equal(await page.evaluate(() => __readingToggle.translated), 0);
      assert.equal(await page.evaluate(() => __readingToggle.tabs.length), 1);
      assert.match(await page.evaluate(() => __readingToggle.tabs[0].url), /setup\/setup\.html/);
      record('输入独开且缺包时保留原有准备引导'); await page.close();
    }
    {
      const page = await open({ enabled: 'invalid', readingEnabled: true }); await settled(page);
      assert.equal(await page.locator('#toggle-switch').isDisabled(), true);
      assert.equal(await page.locator('#status-text').textContent(), '读取失败');
      assert.equal(await page.locator('#reading-toggle').isEnabled(), true);
      assert.equal(await page.locator('#translate-now').isEnabled(), true);
      await page.locator('#translate-now').click();
      assert.equal(await page.evaluate(() => __readingToggle.translated), 1);
      record('输入状态未知不假定开启，也不阻止已确认开启的阅读'); await page.close();
    }
    {
      const page = await open({ enabled: false, holdLocal: true });
      await page.waitForFunction(() => typeof __readingToggle.releases.local === 'function');
      assert.equal(await page.locator('#translate-now').isEnabled(), true);
      await page.locator('#translate-now').click();
      assert.equal(await page.evaluate(() => __readingToggle.translated), 1);
      await page.evaluate(() => __readingToggle.releases.local()); await settled(page);
      record('阅读独开不等待中译英语言包读取'); await page.close();
    }
    {
      const page = await open({ holdWritingSave: true }); await settled(page);
      await page.locator('#toggle-switch').focus(); await page.keyboard.press('Space');
      await page.waitForFunction(() => typeof __readingToggle.releases.writingSave === 'function');
      assert.equal(await page.locator('#toggle-switch').isDisabled(), true);
      assert.equal(await page.locator('#toggle-switch').isChecked(), true);
      await page.evaluate(() => __readingToggle.releases.writingSave()); await writingSaved(page);
      assert.equal(await page.locator('#toggle-switch').isChecked(), false);
      assert.equal(await page.locator('#toggle-switch').evaluate(el => el === document.activeElement), true);
      assert.equal(await page.locator('#reading-toggle').isChecked(), true);
      assert.equal(await page.locator('#translate-now').isEnabled(), true);
      assert.match(await page.locator('#feedback').textContent(), /划词英译中可继续使用/);
      assert.deepEqual(await page.evaluate(() => __readingToggle.messages.filter(value => value.type.startsWith('SET_'))), [{ type: 'SET_EXTENSION_STATE', enabled: false }]);
      record('独立关闭输入不改阅读，保存确认后恢复键盘焦点'); await page.close();
    }
    for (const failure of ['writingSaveFailure', 'writingSaveThrow']) {
      const page = await open({ [failure]: true }); await settled(page);
      await page.locator('#toggle-switch').focus(); await page.keyboard.press('Space'); await writingSaved(page);
      assert.equal(await page.locator('#toggle-switch').isChecked(), true);
      assert.equal(await page.locator('#reading-toggle').isChecked(), true);
      assert.match(await page.locator('#feedback').textContent(), /已保留原状态/);
      assert.equal(await page.locator('#feedback').evaluate(el => el.classList.contains('error')), true);
      assert.equal(await page.locator('#toggle-switch').evaluate(el => el === document.activeElement), true);
      record(`输入保存 ${failure} 保留原状态、阅读开关和焦点`); await page.close();
    }
    {
      const page = await open({ holdWritingSave: true, clock: true }); await settled(page);
      await page.locator('#toggle-switch').focus(); await page.keyboard.press('Space');
      await page.waitForFunction(() => typeof __readingToggle.releases.writingSave === 'function');
      await page.clock.runFor(4100); await writingSaved(page);
      assert.equal(await page.locator('#toggle-switch').isChecked(), true);
      assert.equal(await page.locator('#reading-toggle').isChecked(), true);
      assert.match(await page.locator('#feedback').textContent(), /已保留原状态/);
      record('输入保存无回应时有界恢复，独立阅读偏好不变'); await page.close();
    }
    {
      const page = await open(); await settled(page);
      await page.setViewportSize({ width: 390, height: 600 });
      await page.locator('.shortcut-section > summary').click();
      await page.locator('#user-guide').scrollIntoViewIfNeeded();
      const box = await page.locator('#user-guide').boundingBox();
      assert.ok(box && box.y >= 0 && box.y + box.height <= 600);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      record('增加独立开关后600px工具栏仍可滚动至帮助入口'); await page.close();
    }
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ provider: 'explicit mocks', checks, errors }, null, 2) + '\n');
    console.log(JSON.stringify({ total: checks.length, errors, output }));
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
