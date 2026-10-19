// 执行分发构建的准备页和内容脚本；Translator 为可控替身，不代表真实模型可用。
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const root = path.resolve(__dirname, '..');
const extensionDir = path.resolve(process.env.EXTENSION_DIR || path.join(root, 'dist'));
(async () => {
  const browser = await chromium.launch({channel:'chrome',headless:true});
  const results = [];
  const errors = [];
  async function setup(mode) {
    const page = await browser.newPage();
    page.on('pageerror', error=>errors.push(error.message));
    if(mode.startsWith('timed-')) {
      const now=new Date('2026-10-16T00:00:00Z');
      await page.clock.install({time:now});
      await page.clock.pauseAt(now);
    }
    await page.addInitScript(mode=>{
      window.calls=0; window.destroyed=0; window.translated=0;
      window.Translator = mode==='missing' ? undefined : {
        async availability(){return mode==='unavailable'?'unavailable':'downloadable';},
        async create(options){
          const count=++window.calls;
          if(mode==='retry'&&count===1)throw new Error('download');
          options.monitor({addEventListener(_type,listener){
            if(mode.startsWith('timed-')) window.downloadProgress=listener;
            else listener({loaded:.5});
          }});
          if(mode==='cancel'&&count===1) await new Promise(resolve=>{window.finishOld=resolve;});
          if(mode.startsWith('timed-')&&count===1) {
            window.creationSignal=options.signal;
            await new Promise(resolve=>{window.finishModel=resolve;});
          }
          return {async translate(){
            window.translated++;
            if(mode==='timed-verification'&&count===1) await new Promise(resolve=>{window.finishVerification=resolve;});
            return mode==='untranslated'?'Hello. 太棒了。':'Hello. Great.';
          },destroy(){window.destroyed++;}};
        }
      };
    },mode);
    await page.goto(pathToFileURL(path.join(extensionDir,'setup/setup.html')).href);
    return page;
  }
  try {
    for(const mode of ['missing','unavailable']) {
      const page=await setup(mode);
      assert.equal(await page.locator('#prepare').isDisabled(),true);
      assert.match(await page.locator('#status').textContent(),mode==='missing'?/没有本机翻译/:/不支持中英/);
      results.push(`准备页明确提示 ${mode}`);await page.close();
    }
    for(const mode of ['ready','retry','untranslated','cancel']) {
      const page=await setup(mode);
      await page.locator('#prepare').click();
      if(mode==='retry') {
        await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('未完成'));
        await page.locator('#prepare').click();
      }
      if(mode==='cancel') {
        await page.waitForFunction(()=>window.finishOld);
        assert.equal(await page.locator('#progress').evaluate(e=>e.value),0.5);
        await page.locator('#cancel').click();
        assert.match(await page.locator('#status').textContent(),/已取消/);
        await page.locator('#prepare').click();
        await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('已准备完成'));
        await page.evaluate(()=>window.finishOld());
      }
      const expected=mode==='untranslated'?'未完成':'已准备完成';
      await page.waitForFunction(expected=>document.querySelector('#status').textContent.includes(expected),expected);
      if(mode==='cancel') {
        await page.waitForFunction(()=>window.destroyed===2);
        assert.equal(await page.evaluate(()=>window.translated),1,'取消后迟到的旧实例不得调用翻译');
      }
      assert.equal(await page.locator('#prepare').isDisabled(),false);
      if(mode!=='untranslated') assert.match(await page.locator('#sample').textContent(),/Hello\. Great\./);
      else assert.equal(await page.locator('#sample').textContent(),'');
      results.push(`准备页验证 ${mode}`);await page.close();
    }
    for(const mode of ['timed-progress','timed-stalled','timed-total','timed-verification']) {
      const page=await setup(mode);
      await page.locator('#prepare').click();
      assert.equal(await page.evaluate(()=>typeof window.finishModel),'function');
      if(mode==='timed-progress') {
        for(const loaded of [.2,.4,.6]) {
          await page.clock.runFor(90000);
          await page.evaluate(loaded=>window.downloadProgress({loaded}),loaded);
        }
        assert.equal(await page.evaluate(()=>window.creationSignal.aborted),false);
        await page.evaluate(()=>window.finishModel());
        assert.match(await page.locator('#status').textContent(),/已准备完成/);
        await page.clock.runFor(600000);
        assert.equal(await page.evaluate(()=>window.creationSignal.aborted),false);
        results.push('准备页持续下载超过两分钟后成功，下载计时器已清理');
      } else if(mode==='timed-verification') {
        await page.clock.runFor(119000);
        await page.evaluate(()=>window.finishModel());
        assert.equal(await page.evaluate(()=>typeof window.finishVerification),'function');
        await page.clock.runFor(29000);
        assert.equal(await page.evaluate(()=>window.creationSignal.aborted),false);
        assert.equal(await page.locator('#prepare').isDisabled(),true);
        await page.clock.runFor(1000);
        assert.match(await page.locator('#status').textContent(),/未完成/);
        await page.locator('#prepare').click();
        assert.match(await page.locator('#status').textContent(),/已准备完成/);
        await page.evaluate(()=>window.finishVerification());
        assert.match(await page.locator('#sample').textContent(),/Hello\. Great\./);
        results.push('准备页验证独立计时三十秒，超时可重试且旧结果不污染');
      } else {
        if(mode==='timed-stalled') {
          await page.clock.runFor(100000);await page.evaluate(()=>window.downloadProgress({loaded:.5}));
          await page.clock.runFor(100000);await page.evaluate(()=>{window.downloadProgress({loaded:.5});window.downloadProgress({loaded:.4});});
          await page.clock.runFor(20000);
        } else {
          for(const loaded of [.1,.2,.3,.4,.5,.6]) {
            await page.clock.runFor(90000);await page.evaluate(loaded=>window.downloadProgress({loaded}),loaded);
          }
          assert.equal(await page.evaluate(()=>window.creationSignal.aborted),false);
          await page.clock.runFor(60000);
        }
        assert.equal(await page.evaluate(()=>window.creationSignal.aborted),true);
        assert.match(await page.locator('#status').textContent(),/未完成/);
        await page.locator('#prepare').click();
        assert.match(await page.locator('#status').textContent(),/已准备完成/);
        await page.evaluate(()=>window.finishModel());
        assert.equal(await page.evaluate(()=>window.translated),1);
        assert.equal(await page.evaluate(()=>window.destroyed),2);
        results.push(mode==='timed-stalled'?'准备页重复或回退进度不续期，迟到实例不调用翻译':'准备页持续下载仍受十分钟总上限约束，可重试');
      }
      await page.close();
    }
    const page=await browser.newPage();
    page.on('pageerror',error=>errors.push(error.message));
    await page.setContent('<textarea id="draft"></textarea><button id="next">Next</button>');
    await page.evaluate(()=>{
      window.listeners=[]; window.calls=[]; window.networkCalls=0;
      window.chrome=window.chrome||{};
      chrome.runtime={onMessage:{addListener(fn){listeners.push(fn);}},sendMessage(message){
        if(['GET_POPUP_OFFSET','SET_POPUP_OFFSET','CLEAR_POPUP_OFFSET'].includes(message.type))return Promise.resolve({success:true,offset:null});
        if(message.type==='GET_EXTENSION_STATE')return Promise.resolve({enabled:true});
        if(message.type==='GET_TRANSLATION_CONFIG')return Promise.resolve({success:true,config:{provider:'browser',revision:'initial'}});
        window.networkCalls++;throw new Error('不允许代理请求');
      }};
      chrome.storage={local:{async get(){return {};},async set(){},async remove(){}}};
      window.Translator={async availability(){return 'available';},async create(options){
        window.source=options.sourceLanguage;
        return {async translate(text){calls.push(text);if(text.includes('失败'))throw new Error('engine');return text.replace('太棒了。','Great.');},destroy(){}};
      }};
      window.manual=()=>listeners.forEach(fn=>fn({type:'TRANSLATE_SELECTION'},{},()=>{}));
      window.tab=()=>{const e=new KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true});document.querySelector('#draft').dispatchEvent(e);return e.defaultPrevented;};
    });
    await page.addScriptTag({path:path.join(extensionDir,'content/content.js')});
    const draft=page.locator('#draft');
    await draft.fill('Hello. 太棒了。\nWho are you!');
    await page.evaluate(()=>manual());
    await page.waitForFunction(()=>document.querySelector('.translated-text')?.textContent==='Hello. Great.\nWho are you!');
    assert.equal(await page.evaluate(()=>source),'zh');
    assert.equal(await page.evaluate(()=>tab()),true);
    assert.equal(await draft.inputValue(),'Hello. Great.\nWho are you!');
    assert.equal(await draft.evaluate(e=>e.selectionStart),26);
    results.push('混合全文本机翻译、Tab 替换与光标');
    await draft.fill('模拟失败');await page.evaluate(()=>manual());
    await page.waitForFunction(()=>document.querySelector('.live-translate-enhanced-popup')?.textContent.includes('本机翻译失败'));
    assert.equal(await page.evaluate(()=>tab()),false);assert.equal(await draft.inputValue(),'模拟失败');
    assert.equal(await page.evaluate(()=>networkCalls),0);
    results.push('引擎错误不替换、不拦截 Tab、不转云端');
    await draft.fill('Only English.');
    const count=await page.evaluate(()=>calls.length);
    await page.waitForTimeout(350);
    assert.equal(await page.evaluate(()=>calls.length),count);
    assert.equal(await page.locator('.live-translate-enhanced-popup').count(),0);
    results.push('纯英文自动输入保持安静');
    await page.close();
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({passed:results.length,results,errors}));
  } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
