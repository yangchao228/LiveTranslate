// 真实临时 Chrome 扩展、Web Crypto、会话凭据和权限；火山 HTTP 明确为替身。
// 全程只用虚构密钥，不访问真实账号。EXTENSION_DIR 可指向最终 ZIP 的解压根目录。
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict');const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
(async()=>{
 const profile=fs.mkdtempSync(path.join(os.tmpdir(),'live-translate-direct-'));
 const extensionDir=path.resolve(process.env.EXTENSION_DIR||path.join(__dirname,'../dist'));
 const checks=[],requests=[];let mode='ok',context;
 async function launch(){
  const current=await chromium.launchPersistentContext(profile,{channel:'chrome',headless:false,ignoreDefaultArgs:true,args:['--no-first-run','--remote-debugging-pipe','--user-data-dir='+profile,'--enable-unsafe-extension-debugging','--no-proxy-server','--host-resolver-rules=MAP translate.volcengineapi.com ~NOTFOUND']});
  await current.route('https://translate.volcengineapi.com/**',async route=>{
   const request=route.request();requests.push({url:request.url(),headers:await request.allHeaders(),body:request.postDataJSON()});
   await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(mode==='ok'?{TranslationList:[{Translation:'Direct translation works.'}],ResponseMetadata:{Error:null}}:{ResponseMetadata:{Error:{Code:'SignatureDoesNotMatch',Message:'example-sk-only private draft'}}})});
  });return current;
 }
 async function openOptions(id){
  const page=await context.newPage();await page.goto(`chrome-extension://${id}/options/options.html`);await page.waitForFunction(()=>!document.querySelector('#provider').disabled);return page;
 }
 async function saveDirect(options){
  await options.locator('#provider').selectOption('volcengine-direct');await options.locator('#access-key').fill('example-ak-only');await options.locator('#secret-key').fill('example-sk-only');await options.locator('#save').click();await options.waitForFunction(()=>!document.querySelector('#test').disabled);
 }
 async function remoteRequest(options){
  return options.evaluate(async()=>{const config=await chrome.runtime.sendMessage({type:'GET_TRANSLATION_CONFIG'});return chrome.runtime.sendMessage({type:'TRANSLATE_REMOTE',revision:config.config.revision,request:{text:'你好。',sourceLang:'zh',targetLang:'en'}});});
 }
 async function testDirect(options,phase){
  const before=requests.length;
  await options.locator('#test').click();
  await options.waitForFunction(()=>document.querySelector('#status').textContent.includes('Direct translation works.')).catch(async error=>{
   const status=await options.locator('#status').textContent();
   const markers=[['权限已撤销','permission_revoked'],['翻译服务已切换','config_changed'],['本次会话凭据未准备','missing_credentials'],['迁移或清除','migration_pending'],['无法连接火山','network_or_route'],['鉴权失败','auth_error'],['正在向','pending'],['连接和翻译成功','unexpected_success']];
   const granted=await options.evaluate(()=>chrome.permissions.contains({origins:['https://translate.volcengineapi.com/*']}));
   // 只输出有限状态和计数，不输出原文、译文、密钥、请求头或原始服务响应。
   console.error(JSON.stringify({phase,statusKind:markers.find(([value])=>status.includes(value))?.[1]||'unknown',routedRequests:requests.length-before,permissionGranted:granted}));throw error;
  });
 }

 try{
  context=await launch();const cdp=await context.browser().newBrowserCDPSession();
  const extensions=await context.newPage();await extensions.goto('chrome://extensions/');
  const devMode=extensions.locator('#devMode');if(await devMode.getAttribute('aria-pressed')!=='true')await devMode.click();
  const {id}=await cdp.send('Extensions.loadUnpacked',{path:extensionDir});
  let worker=context.serviceWorkers().find(w=>w.url().includes(id))||await context.waitForEvent('serviceworker',w=>w.url().includes(id));
  await worker.evaluate(()=>chrome.runtime.getManifest().version);
  let options=await openOptions(id);
  assert.equal(await options.locator('#provider').inputValue(),'browser');assert.equal(await options.locator('#legacy-proxy').isHidden(),true);
  assert.deepEqual(await worker.evaluate(()=>chrome.runtime.getManifest().permissions),['activeTab','storage','scripting']);
  checks.push('真实安装默认本机，无 tabs/commands 权限且保留快捷键');
  await options.waitForTimeout(100);
  assert.equal(context.pages().filter(page=>page.url()===`chrome-extension://${id}/setup/setup.html?welcome=1`).length,1);
  checks.push('首次安装仅打开一次欢迎准备页，不自动下载');
  // 通过正常设置动作授予 loopback 权限，下文读取内容脚本隔离世界。
  await options.locator('#provider').selectOption('custom');await options.locator('#endpoint').fill('http://127.0.0.1:8000/api/translate');await options.locator('#save').click();await options.waitForFunction(()=>!document.querySelector('#test').disabled);
  await saveDirect(options);await testDirect(options,'initial-fixed-test');
  assert.equal(requests[0].url,'https://translate.volcengineapi.com/?Action=TranslateText&Version=2020-06-01');assert.match(requests[0].headers.authorization,/HMAC-SHA256 Credential=example-ak-only\//);assert.equal(JSON.stringify(requests).includes('example-sk-only'),false);assert.equal(requests[0].body.SourceLanguage,'zh');
  checks.push('实际后台签名请求官方固定 URL，SK 不发送（HTTP 替身）');
  const storage=await options.evaluate(async()=>{
   const local=await chrome.storage.local.get('translationSettings');const session=await chrome.storage.session.get('translationCredentials');
   return {localHasSecrets:JSON.stringify(local).includes('example-ak-only')||JSON.stringify(local).includes('example-sk-only'),sessionHasKeys:session.translationCredentials?.volcengineDirect.secretKey==='example-sk-only'};
  });assert.deepEqual(storage,{localHasSecrets:false,sessionHasKeys:true});
  await options.reload();await options.waitForFunction(()=>!document.querySelector('#provider').disabled);assert.equal(await options.locator('#secret-key').inputValue(),'example-sk-only');checks.push('密钥只存 session，设置页刷新保留本次会话');
  const page=await context.newPage();await page.route('http://127.0.0.1:8000/direct-test',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><meta charset=utf-8><title>LiveTranslate 直连验收</title><textarea id=draft></textarea><button>Next</button>'}));await page.goto('http://127.0.0.1:8000/direct-test');
  await page.locator('#draft').fill('你好，今天测试直连翻译。');await page.waitForFunction(()=>document.querySelector('.translated-text'));await page.keyboard.press('Tab');await page.keyboard.type('x');assert.equal(await page.locator('#draft').inputValue(),'Direct translation works.x');checks.push('网页直连预览、Tab 替换和继续输入');
  const isolation=await worker.evaluate(async()=>{
   const [tab]=await chrome.tabs.query({url:'http://127.0.0.1:8000/direct-test'});
   const [result]=await chrome.scripting.executeScript({target:{tabId:tab.id},func:async()=>{
    let localDenied=false,sessionDenied=false;try{await chrome.storage.local.get('translationSettings');}catch{localDenied=true;}try{await chrome.storage.session.get('translationCredentials');}catch{sessionDenied=true;}
    const settings=await chrome.runtime.sendMessage({type:'GET_TRANSLATION_SETTINGS'});await chrome.runtime.sendMessage({type:'SET_POPUP_OFFSET',offset:{x:23,y:45,extra:'discard'}});const offset=await chrome.runtime.sendMessage({type:'GET_POPUP_OFFSET'});
    globalThis.__testPrivateChanges=0;chrome.storage.onChanged.addListener((_,area)=>{if(area==='local'||area==='session')globalThis.__testPrivateChanges++;});
    return {localDenied,sessionDenied,settingsDenied:settings.success===false,offset:offset.offset};
   }});return result.result;
  });assert.deepEqual(isolation,{localDenied:true,sessionDenied:true,settingsDenied:true,offset:{x:23,y:45}});checks.push('内容脚本无法读取 local/session 凭据或设置，浮窗偏移仍可用');
  await options.bringToFront();mode='error';await options.locator('#test').click();await options.waitForFunction(()=>document.querySelector('#status').textContent.includes('鉴权失败'));assert.equal((await options.locator('#status').textContent()).includes('example-sk-only'),false);checks.push('供应商错误脱敏，不自动切换');mode='ok';
  await page.bringToFront();await page.locator('#draft').fill('你好，检查撤权。');await page.waitForFunction(()=>document.querySelector('.translated-text'));
  // 全站内容脚本属于必需站点权限，不能用 permissions.remove；按真实 Chrome UI 撤回站点访问。
  await extensions.goto('chrome://extensions/?id='+id);await extensions.locator('#hostAccess').selectOption('ON_CLICK');await page.waitForFunction(()=>!document.querySelector('.translated-text'));
  const requestCount=requests.length;const revoked=await remoteRequest(options);assert.equal(revoked.success,false);assert.match(revoked.error,/权限已撤销/);assert.equal(requests.length,requestCount);checks.push('撤销主机权限立即关闭旧译文，后续不发送');
  await extensions.locator('#hostAccess').selectOption('ON_ALL_SITES');await options.bringToFront();await saveDirect(options);await options.locator('#clear-keys').click();await options.waitForFunction(()=>document.querySelector('#status').textContent.includes('已从本次会话'));assert.equal(await options.locator('#provider').inputValue(),'browser');
  const privacy=await worker.evaluate(async()=>{
   const data=(await chrome.storage.session.get('translationCredentials')).translationCredentials;const local=(await chrome.storage.local.get('translationSettings')).translationSettings;
   const [tab]=await chrome.tabs.query({url:'http://127.0.0.1:8000/direct-test'});const [result]=await chrome.scripting.executeScript({target:{tabId:tab.id},func:()=>globalThis.__testPrivateChanges});
   return {keysEmpty:data.volcengineDirect.accessKey===''&&data.volcengineDirect.secretKey==='',localHasKeys:Object.hasOwn(local,'volcengineDirect'),privateEvents:result.result};
  });assert.deepEqual(privacy,{keysEmpty:true,localHasKeys:false,privateEvents:0});checks.push('清除密钥切回本机，local无密钥字段、内容脚本不接收私有变更');
  await saveDirect(options);
  const restarted=context.waitForEvent('serviceworker',w=>w.url().includes(id));void restarted.catch(()=>{});await options.evaluate(()=>chrome.runtime.reload()).catch(()=>{});options=await openOptions(id);worker=await restarted;
  assert.equal(await options.locator('#provider').inputValue(),'volcengine-direct');assert.equal(await options.locator('#secret-key').inputValue(),'');assert.equal(await options.locator('#test').isDisabled(),true);assert.match(await options.locator('#session-status').textContent(),/本次会话凭据未准备/);
  const expired=await remoteRequest(options);assert.equal(expired.success,false);assert.match(expired.error,/本次会话凭据未准备/);checks.push('真实扩展重载清除会话密钥，保留选择并阻止远程');
  await saveDirect(options);await context.close();context=await launch();options=await openOptions(id);
  assert.equal(await options.locator('#provider').inputValue(),'volcengine-direct');assert.equal(await options.locator('#secret-key').inputValue(),'');assert.equal(await options.locator('#test').isDisabled(),true);checks.push('真实 Chrome 关闭并重启后会话密钥清空，配置保留');
  // Chrome 恢复的扩展 SW 可能早于 Playwright 路由建立。先完成重启断言，
  // 再重载扩展创建路由可观察的新 SW，避免把漏拦请求当成产品鉴权失败。
  const routingWorker=context.waitForEvent('serviceworker',w=>w.url().includes(id));void routingWorker.catch(()=>{});
  await options.evaluate(()=>chrome.runtime.reload()).catch(()=>{});options=await openOptions(id);worker=await routingWorker;
  await options.evaluate(()=>chrome.storage.local.set({translationSettings:{provider:'volcengine-direct',revision:'legacy-test',volcengineDirect:{accessKey:'example-ak-only',secretKey:'example-sk-only'},volcengine:{endpoint:'http://127.0.0.1:8000/api/translate',token:'legacy-example-token'},custom:{endpoint:'',token:''}}}));
  await options.reload();await options.waitForFunction(()=>!document.querySelector('#provider').disabled);assert.equal(await options.locator('#legacy-credentials').isVisible(),true);assert.equal(await options.locator('#secret-key').inputValue(),'');
  const legacyBlocked=await remoteRequest(options);assert.equal(legacyBlocked.success,false);assert.match(legacyBlocked.error,/迁移或清除/);
  await options.locator('#migrate-credentials').click();await options.waitForFunction(()=>document.querySelector('#legacy-credentials').hidden);assert.equal(await options.locator('#secret-key').inputValue(),'example-sk-only');
  const migrated=await options.evaluate(async()=>{const local=(await chrome.storage.local.get('translationSettings')).translationSettings;const session=(await chrome.storage.session.get('translationCredentials')).translationCredentials;return {localHasSecret:JSON.stringify(local).includes('example-sk-only')||JSON.stringify(local).includes('legacy-example-token'),sessionHasSecret:session.volcengineDirect.secretKey==='example-sk-only'&&session.volcengine.token==='legacy-example-token'};});assert.deepEqual(migrated,{localHasSecret:false,sessionHasSecret:true});checks.push('旧版待处理时不发送，显式迁移后秘密进入 session 并移除 local 字段');
  await testDirect(options,'post-migration-fixed-test');
  await options.evaluate(()=>chrome.storage.local.set({translationSettings:{provider:'custom',revision:'legacy-clear-test',custom:{endpoint:'https://example.invalid/translate',token:'legacy-example-token'}}}));await options.reload();await options.waitForFunction(()=>!document.querySelector('#provider').disabled);
  await options.locator('#clear-legacy-credentials').click();await options.waitForFunction(()=>document.querySelector('#legacy-credentials').hidden);assert.equal(await options.locator('#provider').inputValue(),'custom');assert.equal(await options.locator('#endpoint').inputValue(),'https://example.invalid/translate');assert.equal(await options.locator('#token').inputValue(),'');assert.equal(await options.locator('#test').isDisabled(),true);checks.push('显式清除旧凭据保留服务地址，需要鉴权时暂停翻译');
  await options.screenshot({path:path.join(profile,'direct-settings.png'),fullPage:true});console.log(JSON.stringify({passed:checks.length,checks,officialResponse:'mock',extensionDir,screenshot:path.join(profile,'direct-settings.png')}));
 }finally{await context?.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
