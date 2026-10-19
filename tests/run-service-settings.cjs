// 配置 UI 使用可控 Chrome API；实际远程请求由独立后台测试和真实扩展验收覆盖。
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});
 const checks=[];const errors=[];
 try{
  const page=await browser.newPage();page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(()=>{
   window.saved={legacyCredentialsPending:false,credentialsRequired:false,legacyProxyAvailable:true,volcengineDirect:{accessKey:'',secretKey:''},provider:'browser',revision:'initial',volcengine:{endpoint:'http://127.0.0.1:8000/api/translate',token:''},custom:{endpoint:'',token:''}};
   if(new URLSearchParams(location.search).get('fixture')==='legacy'){saved.provider='volcengine-direct';saved.legacyCredentialsPending=true;saved.credentialsRequired=true;}
   window.granted=false;window.origins=[];window.tests=0;window.failTest=false;
   window.chrome=window.chrome||{};
   chrome.permissions={async request(value){origins.push(value.origins);return granted;}};
   chrome.runtime={async sendMessage(message){
    if(message.type==='GET_TRANSLATION_SETTINGS')return {success:true,settings:structuredClone(saved)};
    if(message.type==='SAVE_TRANSLATION_SETTINGS'){
     const {provider,endpoint,token,accessKey,secretKey}=message.settings;
     if(provider==='volcengine-direct')saved.volcengineDirect={accessKey,secretKey};
     else if(provider!=='browser')saved[provider]={endpoint,token};saved.credentialsRequired=false;saved.provider=provider;saved.revision='saved';
     return {success:true,settings:structuredClone(saved)};
    }
    if(message.type==='RESOLVE_LEGACY_CREDENTIALS'){saved.legacyCredentialsPending=false;saved.credentialsRequired=message.action==='clear';if(message.action==='migrate')saved.volcengineDirect={accessKey:'legacy-example-ak',secretKey:'legacy-example-sk'};else saved.volcengineDirect={accessKey:'',secretKey:''};return {success:true,settings:structuredClone(saved)};}
    if(message.type==='CLEAR_VOLCENGINE_KEYS'){saved.volcengineDirect={accessKey:'',secretKey:''};if(saved.provider==='volcengine-direct')saved.provider='browser';return {success:true,settings:structuredClone(saved)};}
    if(message.type==='CLEAR_SERVICE_TOKEN'){saved[message.provider].token='';saved.credentialsRequired=true;return {success:true,settings:structuredClone(saved)};}
    if(message.type==='TEST_TRANSLATION_SERVICE'){tests++;return failTest?{success:false,error:'HTTP 401：请检查访问令牌'}:{success:true,data:{translatedText:'Hello, test.'}};}
   }};
  });
  await page.goto(pathToFileURL(path.resolve(process.env.EXTENSION_DIR||path.join(__dirname,'../dist'),'options/options.html')).href);
  await page.waitForFunction(()=>!document.querySelector('#provider').disabled);
  assert.equal(await page.locator('#provider').inputValue(),'browser');assert.equal(await page.locator('#remote-info').isVisible(),false);
  checks.push('初始本机且高级字段隐藏');
  await page.locator('#provider').selectOption('volcengine');
  assert.equal(await page.locator('#endpoint').inputValue(),'http://127.0.0.1:8000/api/translate');
  await page.locator('#token').fill('test-token');await page.locator('#save').click();
  await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('原设置保持不变'));
  assert.equal(await page.evaluate(()=>saved.provider),'browser');assert.equal(await page.locator('#test').isDisabled(),true);
  checks.push('权限拒绝保持原服务且不能测试未保存配置');
  await page.evaluate(()=>{granted=true;});await page.locator('#save').click();
  await page.waitForFunction(()=>!document.querySelector('#test').disabled);
  assert.equal(await page.evaluate(()=>saved.provider),'volcengine');
  assert.deepEqual(await page.evaluate(()=>origins.at(-1)),['http://127.0.0.1/*']);
  await page.locator('#test').click();await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('Hello, test.'));
  checks.push('按所选主机授权、保存并显示测试译文');
  await page.locator('#endpoint').fill('https://example.com/api/translate');assert.equal(await page.locator('#test').isDisabled(),true);
  await page.locator('#provider').selectOption('custom');await page.locator('#endpoint').fill('http://example.com/api/translate');
  const count=await page.evaluate(()=>origins.length);await page.locator('#save').click();
  await page.waitForFunction(()=>document.querySelector('#status').dataset.error==='true');
  assert.equal(await page.evaluate(()=>origins.length),count);assert.equal(await page.evaluate(()=>saved.provider),'volcengine');
  checks.push('未保存修改禁止测试且不安全远程 HTTP 不申请权限');
  await page.locator('#endpoint').fill('https://custom.example/translate');await page.locator('#save').click();
  await page.waitForFunction(()=>!document.querySelector('#test').disabled);
  await page.evaluate(()=>{failTest=true;});await page.locator('#test').click();
  await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('HTTP 401'));
  assert.equal(await page.evaluate(()=>saved.provider),'custom');checks.push('自定义服务错误可见，不自动切换');
  await page.locator('#endpoint').fill('invalid');await page.locator('#provider').selectOption('browser');
  await page.locator('#save').click();await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('已保存：Chrome'));
  assert.equal(await page.evaluate(()=>saved.provider),'browser');assert.equal(await page.locator('#test').isVisible(),false);
  checks.push('可从无效远程草稿切回本机，隐藏字段不阻止保存');
  await page.locator('#provider').selectOption('volcengine-direct');
  assert.equal(await page.locator('#direct-info').isVisible(),true);assert.equal(await page.locator('#remote-info').isVisible(),false);
  await page.locator('#access-key').fill('example-ak-only');await page.locator('#secret-key').fill('example-sk-only');
  await page.locator('#save').click();await page.waitForFunction(()=>!document.querySelector('#test').disabled);
  assert.deepEqual(await page.evaluate(()=>origins.at(-1)),['https://translate.volcengineapi.com/*']);
  assert.equal(await page.evaluate(()=>saved.volcengineDirect.secretKey),'example-sk-only');
  assert.equal(await page.locator('#secret-key').getAttribute('type'),'password');
  checks.push('直连仅要求 AK/SK，授权官方域名并以密码字段显示');
  await page.locator('#clear-keys').click();await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('已从本次会话'));
  assert.equal(await page.evaluate(()=>saved.provider),'browser');assert.equal(await page.evaluate(()=>saved.volcengineDirect.secretKey),'');
  await page.locator('#provider').selectOption('volcengine-direct');assert.equal(await page.locator('#secret-key').inputValue(),'');
  checks.push('清除密钥后切回本机且密钥字段不残留');
  await page.locator('#provider').selectOption('custom');await page.locator('#token').fill('test-service-token');
  await page.locator('#save').click();await page.waitForFunction(()=>!document.querySelector('#test').disabled);
  const requestsBeforeClear=await page.evaluate(()=>origins.length);await page.evaluate(()=>{granted=false;});
  await page.locator('#clear-token').click();await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('会话令牌已清除'));
  assert.equal(await page.evaluate(()=>saved.custom.token),'');assert.equal(await page.locator('#token').inputValue(),'');
  assert.equal(await page.evaluate(()=>origins.length),requestsBeforeClear);assert.equal(await page.evaluate(()=>saved.provider),'custom');
  checks.push('撤权后仍可清除令牌，不申请权限或切换服务');
  assert.equal(await page.locator('#test').isDisabled(),true);
  await page.goto(page.url()+'?fixture=legacy');
  await page.waitForFunction(()=>!document.querySelector('#provider').disabled);
  assert.equal(await page.locator('#legacy-credentials').isVisible(),true);assert.equal(await page.locator('#save').isDisabled(),true);assert.equal(await page.locator('#test').isDisabled(),true);
  await page.locator('#migrate-credentials').click();await page.waitForFunction(()=>document.querySelector('#legacy-credentials').hidden);
  assert.equal(await page.locator('#secret-key').inputValue(),'legacy-example-sk');checks.push('旧凭据未处理时暂停远程，显式迁移后只恢复本会话');
  await page.reload();await page.waitForFunction(()=>!document.querySelector('#provider').disabled);
  await page.locator('#clear-legacy-credentials').click();await page.waitForFunction(()=>document.querySelector('#legacy-credentials').hidden);
  assert.equal(await page.locator('#secret-key').inputValue(),'');assert.equal(await page.locator('#test').isDisabled(),true);checks.push('旧凭据清除保留服务，缺会话凭据不能测试');
  await page.screenshot({path:'/tmp/live-translate-service-settings.png',fullPage:true});
  assert.deepEqual(errors,[]);console.log(JSON.stringify({passed:checks.length,checks,errors}));
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
