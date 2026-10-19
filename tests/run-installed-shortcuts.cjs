// 在独立临时 Chrome 中核对真实快捷键注册；不访问或修改用户 Chrome 配置。
// 验证的是 Chrome 注册状态及弹窗反馈，原生按键派发另需真实 UI 验收。
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const extensionDir = path.resolve(process.env.EXTENSION_DIR || 'dist');
const outputDir = path.resolve(process.env.SHORTCUT_OUTPUT_DIR || 'output/installed-shortcuts');
const expected = { _execute_action: '', toggle_extension: 'Alt+T', toggle_reading: 'Alt+Y', translate_selection: 'Alt+R' };
const manifest = JSON.parse(fs.readFileSync(path.join(extensionDir, 'manifest.json'), 'utf8'));
const checks = [];
const contexts = new Set();
const normalize = value => value.replace('⌥', 'Alt+').replace('Option+', 'Alt+');

function check(name, actual, wanted) {
  assert.deepEqual(actual, wanted, name);
  checks.push({ name, actual });
  console.log(JSON.stringify({ name, passed: true }));
}

async function launch(profile) {
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chrome', headless: false, ignoreDefaultArgs: true,
    args: ['--disable-sync', '--no-first-run', '--remote-debugging-pipe',
      '--user-data-dir=' + profile, '--enable-unsafe-extension-debugging', '--no-proxy-server'],
  });
  contexts.add(context);
  context.setDefaultTimeout(20000);
  const extensions = await context.newPage();
  await extensions.goto('chrome://extensions/');
  const developerMode = extensions.locator('#devMode');
  // 当前 Chrome 用 aria-checked/checked 表达开关，不能把缺失 aria-pressed 当作关闭。
  if (!await developerMode.evaluate(element => element.checked)) await developerMode.click();
  await extensions.waitForFunction(() => document.querySelector('extensions-manager').shadowRoot
    .querySelector('extensions-toolbar').shadowRoot.querySelector('#devMode').checked);
  return context;
}

async function install(context, directory) {
  const cdp = await context.browser().newBrowserCDPSession();
  const { id } = await cdp.send('Extensions.loadUnpacked', { path: directory });
  await cdp.detach();
  const worker = context.serviceWorkers().find(item => item.url().includes(id)) ||
    await context.waitForEvent('serviceworker', item => item.url().includes(id));
  return { id, worker };
}

async function bindings(worker) {
  const commands = await worker.evaluate(() => chrome.commands.getAll());
  return Object.fromEntries(commands.filter(command => command.name in expected)
    .map(command => [command.name, normalize(command.shortcut)]));
}

async function popup(context, id, label) {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${id}/popup/popup.html`);
  await page.waitForFunction(() => document.querySelector('#toggle-shortcut').textContent.startsWith('输入中译英：'));
  const labels = await page.locator('#toggle-shortcut, #reading-shortcut, #translate-shortcut').allTextContents();
  await page.locator('.shortcut-section > summary').click();
  await page.screenshot({ path: path.join(outputDir, label + '.png'), fullPage: true });
  await page.close();
  return labels;
}

(async () => {
  fs.mkdirSync(outputDir, { recursive: true });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'live-translate-shortcuts-'));
  let context = await launch(profile);
  const version = context.browser().version();
  let { id, worker } = await install(context, extensionDir);
  check('实际加载版本', await worker.evaluate(() => chrome.runtime.getManifest().version), manifest.version);
  check('全新安装自动分配三个默认键位且激活留空', await bindings(worker), expected);
  const initialLabels = await popup(context, id, 'fresh-install');
  check('弹窗显示三个真实绑定', initialLabels.map(normalize), ['输入中译英：Alt+T', '划词英译中：Alt+Y', '手动翻译：Alt+R']);

  const restarted = context.waitForEvent('serviceworker', item => item.url().includes(id));
  void restarted.catch(() => {});
  await worker.evaluate(() => chrome.runtime.reload()).catch(() => {});
  worker = await restarted;
  check('扩展重载保留三个绑定', await bindings(worker), expected);
  await context.close(); contexts.delete(context);
  context = await launch(profile);
  // 恢复的扩展 worker 可能休眠；打开扩展页唤醒后读取。
  const wake = await context.newPage();
  await wake.goto(`chrome-extension://${id}/popup/popup.html`);
  worker = context.serviceWorkers().find(item => item.url().includes(id)) ||
    await context.waitForEvent('serviceworker', item => item.url().includes(id));
  check('Chrome 重启保留三个绑定', await bindings(worker), expected);
  await context.close(); contexts.delete(context);

  const collisionProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'live-translate-shortcut-conflict-'));
  const fixture = path.join(collisionProfile, 'fixture'); fs.mkdirSync(fixture);
  fs.writeFileSync(path.join(fixture, 'manifest.json'), JSON.stringify({
    manifest_version: 3, name: '快捷键冲突测试夹具', version: '1.0.0',
    background: { service_worker: 'worker.js' },
    commands: { reserve_toggle: { suggested_key: { default: 'Alt+T' }, description: '测试占用 Alt+T' } },
  }));
  fs.writeFileSync(path.join(fixture, 'worker.js'), 'chrome.commands.onCommand.addListener(() => {});');
  context = await launch(collisionProfile);
  const reserved = await install(context, fixture);
  check('冲突夹具先获得 Alt+T', normalize(await reserved.worker.evaluate(async () => (await chrome.commands.getAll())[0].shortcut)), 'Alt+T');
  ({ id, worker } = await install(context, extensionDir));
  check('发生冲突时仅冲突键留空', await bindings(worker), { ...expected, toggle_extension: '' });
  const conflictLabels = await popup(context, id, 'conflict');
  check('冲突时弹窗如实显示启停未设置', conflictLabels.map(normalize), ['输入中译英：未设置', '划词英译中：Alt+Y', '手动翻译：Alt+R']);
  const afterReload = context.waitForEvent('serviceworker', item => item.url().includes(id));
  void afterReload.catch(() => {});
  await worker.evaluate(() => chrome.runtime.reload()).catch(() => {});
  worker = await afterReload;
  check('重载不覆盖冲突或已有注册', await bindings(worker), { ...expected, toggle_extension: '' });
  fs.writeFileSync(path.join(outputDir, 'verification.json'), JSON.stringify({
    checkedAt: new Date().toISOString(), chromeVersion: version, extensionDir,
    passed: checks.length, checks, nativeKeyDispatch: '本脚本不模拟系统按键；原生按键派发需另行真实 UI 验收',
    personalProfileTouched: false, translationRequests: false,
  }, null, 2) + '\n');
  console.log(JSON.stringify({ passed: checks.length, chromeVersion: version, outputDir }));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await Promise.allSettled([...contexts].map(context => context.close()));
});
