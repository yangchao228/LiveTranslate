// 独立临时 Chrome 执行真实内容脚本；翻译和剪贴板均由页面替身提供。
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { pathToFileURL } = require('node:url');

(async () => {
  const run = new Date().toISOString().replace(/[:.]/g,'-');
  const output = path.resolve(process.env.UI_OUTPUT_DIR || path.join('releases/page-selection',run));
  if(fs.existsSync(path.join(output,'report.json')))throw new Error(`拒绝覆盖已有回归结果：${output}`);
  fs.mkdirSync(output, { recursive: true });
  // 整轮锁定同一脚本字节，避免并行构建让两个视口读到不同版本。
  const contentPath = path.resolve(process.env.EXTENSION_DIR || 'dist-local','content/content.js');
  const content = fs.readFileSync(contentPath);
  const source = {path:contentPath,sha256:createHash('sha256').update(content).digest('hex')};
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  let failed = false;
  const reports = [];
  try {
    for (const width of [1280, 390]) {
      const page = await browser.newPage({viewport:{width,height:800},reducedMotion:'reduce'});
      const errors = [], blockedRequests = [];
      let candidateLoads = 0;
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/*', route => {
        const url = route.request().url();
        if (/^https?:/i.test(url)) {blockedRequests.push(url);return route.abort();}
        if (url.endsWith('/dist-local/content/content.js')) {
          candidateLoads++;
          return route.fulfill({body:content,contentType:'text/javascript'});
        }
        return route.continue();
      });
      await page.goto(pathToFileURL(path.join(__dirname,'page-selection-ui.html')).href);
      await page.waitForFunction(() => window.testsFinished, null, {timeout:45000});
      const result = await page.evaluate(() => ({results:window.testResults,errors:window.testErrors,layout:window.readingLayout}));
      errors.push(...result.errors);
      if(candidateLoads!==2)errors.push('未确认初次注入和退休回归均执行锁定的内容脚本');
      if(blockedRequests.length)errors.push(`检测到 ${blockedRequests.length} 个被阻止的外网请求`);
      // 真实指针会先触发 mousedown / selectionchange，不能只用 DOM click 覆盖入口。
      try {
        await page.evaluate(()=>window.showPageSelectionPreview('trigger'));
        await page.screenshot({path:path.join(output,`reading-trigger-${width}.png`)});
        await page.locator('#live-translate-selection-trigger').locator('button').click();
        await page.waitForFunction(()=>window.requests.length===1);
        await page.evaluate(()=>window.requests[0].resolve('真实鼠标触发的中文译文。'));
        await page.waitForFunction(()=>document.querySelector('.translated-text')?.textContent==='真实鼠标触发的中文译文。');
        result.results.push({name:'真实鼠标点击保留选区快照并显示中文',passed:true});
        await page.screenshot({path:path.join(output,`reading-result-${width}.png`)});
        await page.locator('.action-copy').click();
        await page.waitForFunction(()=>window.testCopiedText==='真实鼠标触发的中文译文。');
        result.results.push({name:'真实鼠标复制仍使用剪贴板替身',passed:true});
        await page.keyboard.press('Escape');
        await page.waitForFunction(()=>!document.querySelector('.live-translate-enhanced-popup'));
        result.results.push({name:'真实 Esc 按键关闭结果',passed:true});
      } catch(error) {errors.push(`真实鼠标/键盘路径失败：${error.message}`);}
      const failures=result.results.filter(item=>!item.passed);
      const report={width,total:result.results.length,failures,errors,layout:result.layout};
      reports.push(report);
      console.log(JSON.stringify(report));
      failed ||= failures.length>0||errors.length>0;
      await page.close();
    }
  } finally {await browser.close();}
  fs.writeFileSync(path.join(output,'report.json'),JSON.stringify({source,reports},null,2)+'\n');
  console.log(JSON.stringify({output,source}));
  process.exitCode=failed?1:0;
})().catch(error=>{console.error(error);process.exitCode=1;});
