// 执行实际本地构建；页面内部显式替换 Chrome 和翻译接口，不调用火山 API。
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
(async () => {
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  let failed = false;
  try {
    for (const file of process.argv.slice(2).length ? process.argv.slice(2) : [
      'dynamic-inputs.html', 'punctuation-ui.html', 'extension-state-ui.html', 'replacement-caret-ui.html', 'sentence-flow-ui.html', 'editor-safety-ui.html'
    ]) {
      const page = await browser.newPage();
      let candidateLoads = 0;
      // 最终候选验收直接执行 ZIP 解压产物，不借用另一个构建目录。
      if (process.env.EXTENSION_DIR) {
        await page.route('**/dist-local/content/content.js', route => {
          candidateLoads++;
          return route.fulfill({ path: path.resolve(process.env.EXTENSION_DIR, 'content/content.js'), contentType: 'text/javascript' });
        });
      }
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(pathToFileURL(path.join(__dirname, file)).href);
      await page.waitForFunction(() => window.testsFinished, null, { timeout: 45000 });
      const result = await page.evaluate(() => ({ results: window.testResults, errors: window.testErrors || [], longLayout: window.longLayout }));
      const failures = result.results.filter(item => !item.passed);
      errors.push(...result.errors);
      if (process.env.EXTENSION_DIR && candidateLoads !== 1) errors.push('未确认执行最终候选内容脚本');
      console.log(JSON.stringify({ file, total: result.results.length, failures, errors, diagnostics: failures.length ? result.longLayout : undefined }));
      failed ||= failures.length > 0 || errors.length > 0;
      await page.close();
    }
  } finally { await browser.close(); }
  process.exitCode = failed ? 1 : 0;
})().catch(error => { console.error(error); process.exitCode = 1; });
