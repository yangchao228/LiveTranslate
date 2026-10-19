const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const ts = require('typescript');
const {randomUUID,webcrypto} = require('node:crypto');
function gateway(local = false) {
  const state = {}; const session = {}; const calls = [];
  const control = { granted: true, respond: async () => ({ok:true,json:async()=>({translatedText:'Hello.'})}) };
  const chrome = {
    storage:{local:{async setAccessLevel(value){control.accessLevel=value.accessLevel;},async get(){return structuredClone(state);},async set(value){Object.assign(state,structuredClone(value));}},session:{async setAccessLevel(value){control.sessionAccessLevel=value.accessLevel;},async get(){return structuredClone(session);},async set(value){Object.assign(session,structuredClone(value));},async remove(key){delete session[key];}}},
    permissions:{async contains(){return control.granted;}}
  };
  function load(filename) {
    const exports = {};
    const code = ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText;
    vm.runInNewContext(code,{exports,require:name=>load(path.resolve(path.dirname(filename),name+'.ts')),chrome,crypto:{randomUUID,subtle:webcrypto.subtle},TextEncoder,URL,AbortSignal,__LOCAL_TRANSLATION__:local,fetch:async(url,options)=>{calls.push({url,options});return control.respond();}});
    return exports;
  }
  const exports=load(path.join(__dirname,'../src/background/translation-settings.ts'));
  return {api:exports,state,session,calls,control,chrome};
}
const remote = (provider='volcengine',endpoint='http://127.0.0.1:8000/api/translate') => ({provider,endpoint,token:'test-proxy-token'});

test('新安装默认本机，开发构建保留火山初始值，公开配置无令牌和地址',async()=>{
 const g=gateway();const s=await g.api.loadSettings();
 assert.equal(s.provider,'browser');assert.equal(gateway(true).api.defaultSettings().provider,'volcengine');
 assert.equal(JSON.stringify(g.api.publicConfig(s)),JSON.stringify({provider:'browser',revision:'initial'}));
 await assert.rejects(g.api.translateRemote({text:'你好'},'initial'),/不发送远程请求/);assert.equal(g.calls.length,0);
});
test('服务地址只接受 HTTPS 或明确的本机 HTTP，拒绝 URI 凭据/参数',()=>{
 const {api}=gateway();
 for(const url of ['javascript:alert(1)','file:///tmp/a','http://example.com/a','https://user:password@example.com/a','https://example.com/a?token=secret','https://example.com/a#x'])assert.throws(()=>api.validateEndpoint(url));
 assert.equal(api.validateEndpoint('https://example.com'),'https://example.com/api/translate');
 assert.equal(api.permissionOrigin('https://example.com:8443/translate'),'https://example.com/*');
 assert.equal(api.validateEndpoint('http://localhost:9000/v1/translate'),'http://localhost:9000/v1/translate');
});
test('拒绝授权不改变设置；设置持久化并保留另一个服务配置',async()=>{
 const g=gateway();g.control.granted=false;
 await assert.rejects(g.api.saveSettings(remote()),/尚未授权/);assert.equal((await g.api.loadSettings()).provider,'browser');
 g.control.granted=true;const first=await g.api.saveSettings(remote());
 const custom=await g.api.saveSettings(remote('custom','https://example.com/translate'));
 assert.notEqual(first.revision,custom.revision);assert.equal(custom.volcengine.endpoint,first.volcengine.endpoint);
 await g.api.saveSettings({provider:'browser'});assert.equal((await g.api.loadSettings()).custom.endpoint,custom.custom.endpoint);
});
test('只向保存的完整地址发送协议 JSON 和代理令牌，不带 Cookie，不接受重定向',async()=>{
 const g=gateway();const s=await g.api.saveSettings(remote('custom','https://example.com:8443/translate'));
 const r=await g.api.translateRemote({text:'你好。',sourceLang:'zh',targetLang:'en',url:'https://evil.example/'},s.revision);
 assert.equal(r.translatedText,'Hello.');assert.equal(g.calls.length,1);
 const {url,options}=g.calls[0];assert.equal(url,'https://example.com:8443/translate');
 assert.equal(options.headers.Authorization,'Bearer test-proxy-token');assert.equal(options.credentials,'omit');assert.equal(options.redirect,'error');assert.ok(options.signal);
 assert.deepEqual(JSON.parse(options.body),{text:'你好。',sourceLang:'zh',targetLang:'en'});
});
test('权限撤销或配置版本过期时不请求远程',async()=>{
 const g=gateway();const s=await g.api.saveSettings(remote());g.control.granted=false;
 await assert.rejects(g.api.translateRemote({text:'你好'},s.revision),/权限已撤销/);
 g.control.granted=true;await g.api.saveSettings({provider:'browser'});
 await assert.rejects(g.api.translateRemote({text:'你好'},s.revision),/已切换/);assert.equal(g.calls.length,0);
});
test('权限检查期间切换服务，尚未发出的旧请求不会继续发送',async()=>{
 const g=gateway();const s=await g.api.saveSettings(remote());let release;
 g.chrome.permissions.contains=()=>new Promise(resolve=>{release=resolve;});
 const task=g.api.translateRemote({text:'你好'},s.revision);await new Promise(setImmediate);
 await g.api.saveSettings({provider:'browser'});release(true);
 await assert.rejects(task,/已切换/);assert.equal(g.calls.length,0);
});
test('在途旧请求返回时已切换服务，响应不可用',async()=>{
 const g=gateway();const s=await g.api.saveSettings(remote());let release;
 g.control.respond=()=>new Promise(resolve=>{release=resolve;});
 const task=g.api.translateRemote({text:'你好'},s.revision);await new Promise(setImmediate);
 await g.api.saveSettings({provider:'browser'});release({ok:true,json:async()=>({translatedText:'Old'})});
 await assert.rejects(task,/已切换/);
});
test('代理和直连在途请求遭撤权后不返回可用译文',async()=>{
 for(const provider of ['custom','volcengine-direct']) {
  const g=gateway();const s=await g.api.saveSettings(provider==='custom'?remote('custom','https://example.com/translate'):direct());
  let release,started;const ready=new Promise(resolve=>{started=resolve;});
  g.control.respond=()=>new Promise(resolve=>{release=resolve;started();});
  const task=g.api.translateRemote({text:'你好'},s.revision);await ready;g.control.granted=false;
  release({ok:true,json:async()=>provider==='custom'?{translatedText:'Old'}:{TranslationList:[{Translation:'Old'}]}});
  await assert.rejects(task,/权限已撤销/);assert.equal(g.calls.length,1);
 }
});
test('撤权使旧配置版本失效，保留服务和凭据；无关撤权不改版本',async()=>{
 const g=gateway();const s=await g.api.saveSettings(remote('custom','https://example.com/translate'));
 await g.api.invalidateRevokedService();assert.equal((await g.api.loadSettings()).revision,s.revision);
 g.control.granted=false;await g.api.invalidateRevokedService();const current=await g.api.loadSettings();
 assert.notEqual(current.revision,s.revision);assert.equal(current.provider,'custom');assert.equal(current.custom.token,s.custom.token);
 await assert.rejects(g.api.translateRemote({text:'你好'},s.revision),/已切换/);assert.equal(g.calls.length,0);
});
test('已撤权限仍可明确清除某个代理令牌，不改地址或另一服务凭据',async()=>{
 const g=gateway();await g.api.saveSettings(remote());const s=await g.api.saveSettings(remote('custom','https://example.com/translate'));
 g.control.granted=false;const clean=await g.api.clearServiceToken('custom');
 assert.equal(clean.provider,'custom');assert.equal(clean.custom.token,'');assert.equal(clean.custom.endpoint,s.custom.endpoint);
 assert.equal(clean.volcengine.token,s.volcengine.token);assert.notEqual(clean.revision,s.revision);
 await assert.rejects(g.api.clearServiceToken('browser'),/请选择/);assert.equal(g.calls.length,0);
});
test('清除正在使用的代理令牌后，在途结果和后续匿名请求均不可用',async()=>{
 const g=gateway();const s=await g.api.saveSettings(remote('custom','https://example.com/translate'));
 let release,started;const ready=new Promise(resolve=>{started=resolve;});
 g.control.respond=()=>new Promise(resolve=>{release=resolve;started();});
 const task=g.api.translateRemote({text:'你好'},s.revision);await ready;
 const clean=await g.api.clearServiceToken('custom');release({ok:true,json:async()=>({translatedText:'Old'})});
 await assert.rejects(task,/已切换/);await assert.rejects(g.api.translateRemote({text:'你好'},clean.revision),/本次会话凭据未准备/);
 assert.equal(g.calls.length,1);assert.equal(clean.provider,'custom');
});
test('错误和非兼容响应显示明确原因，不回退也不把原始服务错误反射到网页',async()=>{
 const g=gateway();const s=await g.api.saveSettings(remote());
 g.control.respond=async()=>({ok:false,status:401,json:async()=>({error:'secret'})});
 await assert.rejects(g.api.translateRemote({text:'你好'},s.revision),/HTTP 401.*访问令牌/);
 g.control.respond=async()=>({ok:true,json:async()=>({choices:[{message:{content:'Hello'}}]})});
 await assert.rejects(g.api.translateRemote({text:'你好'},s.revision),/不符合协议/);
 g.control.respond=async()=>{throw new Error('timeout with secret');};
 await assert.rejects(g.api.translateRemote({text:'你好'},s.revision),/超过 15 秒/);
 assert.equal(g.calls.length,3);
});
test('空文本和过大文本在请求前拒绝',async()=>{
 const g=gateway();const s=await g.api.saveSettings(remote());
 for(const text of ['', ' '.repeat(2),'a'.repeat(100001)])await assert.rejects(g.api.translateRemote({text},s.revision),/原文为空或超过/);
 assert.equal(g.calls.length,0);
});

const direct=()=>({provider:'volcengine-direct',accessKey:'example-ak-only',secretKey:'example-sk-only'});
test('直连密钥仅存会话并限制存储读取，不影响已有代理配置',async()=>{
 const g=gateway();const previous=await g.api.saveSettings(remote());
 const s=await g.api.saveSettings(direct());
 assert.equal(g.control.accessLevel,'TRUSTED_CONTEXTS');assert.equal(s.volcengine.endpoint,previous.volcengine.endpoint);
 assert.equal(g.control.sessionAccessLevel,'TRUSTED_CONTEXTS');
 assert.equal(JSON.stringify(g.state).includes('example-ak-only'),false);assert.equal(JSON.stringify(g.state).includes('example-sk-only'),false);
 assert.equal(g.session.translationCredentials.volcengineDirect.secretKey,'example-sk-only');
 assert.equal(s.volcengineDirect.accessKey,'example-ak-only');
 assert.deepEqual(Object.keys(g.api.publicConfig(s)).sort(),['provider','revision']);
 const clean=await g.api.clearVolcengineKeys();assert.equal(clean.provider,'browser');assert.equal(clean.volcengineDirect.secretKey,'');
 assert.notEqual(clean.revision,s.revision);assert.equal(clean.volcengine.endpoint,previous.volcengine.endpoint);
});
test('会话清理后保留直连选择但请求暂停，不改选或发送远程',async()=>{
 const g=gateway();const s=await g.api.saveSettings(direct());delete g.session.translationCredentials;
 const loaded=await g.api.loadSettings();assert.equal(loaded.provider,'volcengine-direct');assert.equal(loaded.credentialsRequired,true);
 await assert.rejects(g.api.translateRemote({text:'你好'},s.revision),/本次会话凭据未准备/);assert.equal(g.calls.length,0);
});
test('带令牌服务会话过期后不能匿名发送，无鉴权服务不受影响',async()=>{
 const g=gateway();const s=await g.api.saveSettings(remote('custom','https://example.com/translate'));
 assert.equal(g.state.translationSettings.custom.requiresToken,true);assert.equal(g.state.translationSettings.custom.token,undefined);
 delete g.session.translationCredentials;
 await assert.rejects(g.api.translateRemote({text:'你好'},s.revision),/本次会话凭据未准备/);assert.equal(g.calls.length,0);
 const anonymous=await g.api.saveSettings({provider:'custom',endpoint:'https://example.com/translate',token:''});
 delete g.session.translationCredentials;await g.api.translateRemote({text:'你好'},anonymous.revision);assert.equal(g.calls.length,1);
});
test('旧版凭据待用户处理，读取不回显旧秘密且远程暂停，切本机不静默删除',async()=>{
 const g=gateway();g.state.translationSettings={provider:'volcengine-direct',revision:'legacy',volcengineDirect:{accessKey:'legacy-example-ak',secretKey:'legacy-example-sk'},custom:{endpoint:'https://example.com/translate',token:'legacy-example-token'}};
 const loaded=await g.api.loadSettings();assert.equal(loaded.legacyCredentialsPending,true);assert.equal(loaded.volcengineDirect.secretKey,'');assert.equal(loaded.custom.token,'');
 await assert.rejects(g.api.translateRemote({text:'你好'},'legacy'),/迁移或清除/);
 await assert.rejects(g.api.saveSettings(direct()),/迁移或清除/);
 await g.api.saveSettings({provider:'browser'});assert.equal(g.state.translationSettings.volcengineDirect.secretKey,'legacy-example-sk');assert.equal(g.calls.length,0);
});
test('明确迁移先进入会话，再删除磁盘秘密并更新版本，保留服务地址',async()=>{
 const g=gateway();g.state.translationSettings={provider:'custom',revision:'legacy',volcengineDirect:{accessKey:'legacy-example-ak',secretKey:'legacy-example-sk'},volcengine:{endpoint:'http://localhost:8000/api/translate',token:'legacy-proxy'},custom:{endpoint:'https://example.com/translate',token:'legacy-custom'}};
 const loaded=await g.api.resolveLegacyCredentials('migrate');
 assert.equal(loaded.legacyCredentialsPending,false);assert.equal(loaded.credentialsRequired,false);assert.equal(loaded.provider,'custom');assert.notEqual(loaded.revision,'legacy');
 assert.equal(loaded.volcengineDirect.secretKey,'legacy-example-sk');assert.equal(loaded.custom.token,'legacy-custom');
 assert.equal(JSON.stringify(g.state).includes('legacy-example-sk'),false);assert.equal(g.state.translationSettings.custom.token,undefined);assert.equal(g.state.translationSettings.volcengineDirect,undefined);
 assert.equal(g.state.translationSettings.volcengine.endpoint,'http://localhost:8000/api/translate');
});
test('迁移的会话写入失败时旧配置保持，明确清除后不复活秘密',async()=>{
 const g=gateway();g.state.translationSettings={provider:'custom',revision:'legacy',custom:{endpoint:'https://example.com/translate',token:'legacy-custom'}};
 const set=g.chrome.storage.session.set;g.chrome.storage.session.set=async()=>{throw new Error('storage unavailable');};
 await assert.rejects(g.api.resolveLegacyCredentials('migrate'),/storage unavailable/);assert.equal(g.state.translationSettings.custom.token,'legacy-custom');
 g.chrome.storage.session.set=set;const cleared=await g.api.resolveLegacyCredentials('clear');
 assert.equal(cleared.provider,'custom');assert.equal(cleared.legacyCredentialsPending,false);assert.equal(cleared.credentialsRequired,true);assert.equal(cleared.custom.token,'');
 assert.equal(g.state.translationSettings.custom.token,undefined);assert.equal(g.session.translationCredentials,undefined);
 await assert.rejects(g.api.translateRemote({text:'你好'},cleared.revision),/本次会话凭据未准备/);assert.equal(g.calls.length,0);
});
test('本机设置写入失败时回滚会话令牌，Bearer 不会与旧地址错配',async()=>{
 const g=gateway();const first=await g.api.saveSettings(remote('custom','https://first.example/translate'));
 const set=g.chrome.storage.local.set;g.chrome.storage.local.set=async()=>{throw new Error('disk unavailable');};
 await assert.rejects(g.api.saveSettings({provider:'custom',endpoint:'https://second.example/translate',token:'second-service-token'}),/disk unavailable/);
 g.chrome.storage.local.set=set;const current=await g.api.loadSettings();assert.equal(current.revision,first.revision);assert.equal(current.custom.token,first.custom.token);
 await g.api.translateRemote({text:'你好'},current.revision);assert.equal(g.calls[0].url,first.custom.endpoint);assert.equal(g.calls[0].options.headers.Authorization,'Bearer test-proxy-token');
 // 模拟两种存储短暂或异常不一致：不向旧地址发送另一个地址的令牌。
 g.session.translationCredentials.custom={endpoint:'https://second.example/translate',token:'second-service-token'};
 await assert.rejects(g.api.translateRemote({text:'你好'},current.revision),/本次会话凭据未准备/);assert.equal(g.calls.length,1);
});
test('旧版配置保留服务与地址，旧令牌待明确处理且不回显',async()=>{
 const g=gateway();g.state.translationSettings={provider:'volcengine',revision:'old',volcengine:{endpoint:'http://localhost:8000/api/translate',token:'old-token'},custom:{endpoint:'https://example.com/translate',token:'custom-token'}};
 const s=await g.api.loadSettings();assert.equal(s.provider,'volcengine');assert.equal(s.volcengine.token,'');assert.equal(s.custom.token,'');assert.equal(s.legacyCredentialsPending,true);assert.equal(s.volcengineDirect.secretKey,'');assert.equal(s.legacyProxyAvailable,true);
});
test('直连固定官方目标与协议，不发送 SK，不接受调用者 URL，保留明确源语言',async()=>{
 const g=gateway();const s=await g.api.saveSettings(direct());
 g.control.respond=async()=>({ok:true,json:async()=>({TranslationList:[{Translation:'Great.'}],ResponseMetadata:{Error:null}})});
 const result=await g.api.translateRemote({text:'Hello. 太棒了。',sourceLang:'zh',url:'https://evil.example/'},s.revision);
 assert.equal(result.translatedText,'Great.');const {url,options}=g.calls[0];
 assert.equal(url,'https://translate.volcengineapi.com/?Action=TranslateText&Version=2020-06-01');
 assert.deepEqual(JSON.parse(options.body),{SourceLanguage:'zh',TargetLanguage:'en',TextList:['Hello. 太棒了。']});
 assert.match(options.headers.Authorization,/HMAC-SHA256 Credential=example-ak-only\//);assert.equal(JSON.stringify(g.calls).includes('example-sk-only'),false);
 assert.equal(options.headers.Host,undefined);assert.equal(options.redirect,'error');assert.equal(options.credentials,'omit');
});
test('直连拒绝缺失密钥/超长请求/未授权，不发请求',async()=>{
 const g=gateway();await assert.rejects(g.api.saveSettings({provider:'volcengine-direct'}),/填写/);
 const s=await g.api.saveSettings(direct());await assert.rejects(g.api.translateRemote({text:'中'.repeat(5001)},s.revision),/5,000/);
 g.control.granted=false;await assert.rejects(g.api.translateRemote({text:'你好'},s.revision),/权限已撤销/);assert.equal(g.calls.length,0);
});
test('直连识别 HTTP 200 错误信封且不反射敏感供应商信息',async()=>{
 const g=gateway();const s=await g.api.saveSettings(direct());
 g.control.respond=async()=>({ok:true,json:async()=>({ResponseMetadata:{Error:{Code:'SignatureDoesNotMatch',Message:'example-sk-only private draft'}}})});
 await assert.rejects(g.api.translateRemote({text:'你好'},s.revision),/鉴权失败/);
 g.control.respond=async()=>({ok:true,json:async()=>({TranslationList:[]})});await assert.rejects(g.api.translateRemote({text:'你好'},s.revision),/缺少有效译文/);
});
test('直连请求途中清除密钥，旧响应不能使用',async()=>{
 const g=gateway();const s=await g.api.saveSettings(direct());let release,started;
 const ready=new Promise(r=>{started=r;});g.control.respond=()=>new Promise(r=>{release=r;started();});
 const task=g.api.translateRemote({text:'你好'},s.revision);await ready;await g.api.clearVolcengineKeys();
 release({ok:true,json:async()=>({TranslationList:[{Translation:'Old'}]})});await assert.rejects(task,/已切换/);
});

test('无法限制存储访问时拒绝保存密钥，不产生远程请求',async()=>{
 const g=gateway();g.chrome.storage.local.setAccessLevel=async()=>{throw new Error('denied');};
 await assert.rejects(g.api.saveSettings(direct()),/无法限制密钥存储访问/);
 assert.equal(g.state.translationSettings,undefined);assert.equal(g.calls.length,0);
});
