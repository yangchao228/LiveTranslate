const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function service(api, active = true, timers = {setTimeout, clearTimeout}) {
  const modules = new Map();
  const context = vm.createContext({
    __LOCAL_TRANSLATION__: false, Translator: api,
    navigator: {userActivation:{isActive:active}}, AbortController,
    ...timers, console: {log(){}, warn(){}, error(){}},
    fetch(){throw new Error('禁止云端请求');},
    chrome:{runtime:{sendMessage(){throw new Error('禁止后台代理请求');}}}
  });
  function load(file) {
    const absolute = path.resolve(__dirname, '..', file);
    if(modules.has(absolute)) return modules.get(absolute);
    const exports = {};
    modules.set(absolute,exports);
    const code = ts.transpileModule(fs.readFileSync(absolute,'utf8'), {
      compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}
    }).outputText;
    const factory=vm.runInContext(`(function(exports,require){${code}\n})`,context);
    factory(exports,name=>load(path.resolve(path.dirname(absolute),name+'.ts')));
    return exports;
  }
  return load('src/content/translation-service.ts').TranslationService;
}

function fakeClock() {
  let now=0, next=0;
  const pending=new Map();
  const flush=async()=>{for(let turn=0;turn<12;turn++)await Promise.resolve();};
  return {
    setTimeout(fn,delay){const id=++next;pending.set(id,{at:now+delay,fn});return id;},
    clearTimeout(id){pending.delete(id);},
    flush,
    async advance(ms){
      const target=now+ms;
      while(true){
        const due=[...pending.entries()].sort((a,b)=>a[1].at-b[1].at).find(([,task])=>task.at<=target);
        if(!due)break;
        now=due[1].at;pending.delete(due[0]);due[1].fn();await flush();
      }
      now=target;await flush();
    }
  };
}

test('分发版在本机翻译混合全文，共用初始化并缓存，不调用云端', async()=>{
  let created=0, calls=0;
  const texts=[];
  const s=service({async availability(){return 'available';},async create(options){
    created++;
    assert.equal(options.sourceLanguage,'zh');assert.equal(options.targetLanguage,'en');
    return {async translate(text){calls++;texts.push(text);return text.replace('太棒了。','Great.');},destroy(){}};
  }});
  const request={text:'Hello. 太棒了。\nWho are you!',sourceLang:'auto',targetLang:'en'};
  const [first,second]=await Promise.all([s.translate(request),s.translate(request)]);
  assert.equal(first.translatedText,'Hello. Great.\nWho are you!');
  assert.equal(second.translatedText,first.translatedText);
  await s.translate(request);
  assert.equal(created,1);assert.equal(calls,1);assert.equal(texts[0],'太棒了。');
  assert.equal(s.getCurrentProvider(),'browser');
});

test('语言包下载进度可反馈，初始化失败后可以重试',async()=>{
  let attempts=0;
  const progress=[];
  const s=service({async availability(){return 'downloadable';},async create(options){
    attempts++;if(attempts===1)throw new Error('下载失败');
    options.monitor({addEventListener(_type,listener){listener({loaded:.5});}});
    return {async translate(){return 'Hello.';},destroy(){}};
  }});
  const request={text:'你好。'};
  await assert.rejects(s.translate(request),/语言包准备失败/);
  assert.equal((await s.translate(request,text=>progress.push(text))).translatedText,'Hello.');
  assert.equal(attempts,2);assert.ok(progress.some(text=>text.includes('50%')));
});

test('本机初始化持续取得进展可超过两分钟，成功后不再被下载计时器中止',async()=>{
  const clock=fakeClock();let progress,finish,signal;
  const s=service({async availability(){return 'downloadable';},create(options){
    signal=options.signal;options.monitor({addEventListener(_type,listener){progress=listener;}});
    return new Promise(resolve=>{finish=resolve;});
  }},true,clock);
  const pending=s.translate({text:'你好。'});await clock.flush();
  for(const loaded of [.2,.4,.6]){await clock.advance(90000);progress({loaded});}
  assert.equal(signal.aborted,false);
  finish({async translate(){return 'Hello.';},destroy(){}});
  assert.equal((await pending).translatedText,'Hello.');
  await clock.advance(600000);assert.equal(signal.aborted,false);
});

test('相同或回退进度不会续期，超时的迟到实例销毁且不影响重试',async()=>{
  const clock=fakeClock();let progress,finish,signal;let created=0,destroyed=0,oldTranslated=0;
  const s=service({async availability(){return 'downloadable';},create(options){
    if(++created>1)return Promise.resolve({async translate(){return 'Fresh.';},destroy(){}});
    signal=options.signal;options.monitor({addEventListener(_type,listener){progress=listener;}});
    return new Promise(resolve=>{finish=resolve;});
  }},true,clock);
  const rejected=assert.rejects(s.translate({text:'你好。'}),/语言包准备失败或超时/);await clock.flush();
  await clock.advance(100000);progress({loaded:.5});
  await clock.advance(100000);progress({loaded:.5});progress({loaded:.4});
  await clock.advance(20000);await rejected;assert.equal(signal.aborted,true);
  assert.equal((await s.translate({text:'你好。'})).translatedText,'Fresh.');
  finish({async translate(){oldTranslated++;return 'Old.';},destroy(){destroyed++;}});
  await clock.flush();assert.equal(destroyed,1);assert.equal(oldTranslated,0);
});

test('持续递增的模型下载仍受十分钟总上限约束',async()=>{
  const clock=fakeClock();let progress,signal;
  const s=service({async availability(){return 'downloadable';},create(options){
    signal=options.signal;options.monitor({addEventListener(_type,listener){progress=listener;}});
    return new Promise(()=>{});
  }},true,clock);
  const rejected=assert.rejects(s.translate({text:'你好。'}),/语言包准备失败或超时/);await clock.flush();
  for(const loaded of [.1,.2,.3,.4,.5,.6]){await clock.advance(90000);progress({loaded});}
  assert.equal(signal.aborted,false);
  await clock.advance(60000);await rejected;assert.equal(signal.aborted,true);
});

test('真实模型已复现的中文省略/换行合并：按完整句发送，保留英文、空白和 CRLF',async()=>{
  const sent=[];
  const s=service({async availability(){return 'available';},async create(){
    return {async translate(text){sent.push(text);return text==='太棒了。'?'Awesome.':'Tomorrow, let us meet.';},destroy(){}};
  }});
  const text="  Let's test this question. I like you. 太棒了。 Who are you!\r\n\t明天，如果有空，我们见面。  \n";
  assert.equal((await s.translate({text,targetLang:'en'})).translatedText,"  Let's test this question. I like you. Awesome. Who are you!\r\n\tTomorrow, let us meet.  \n");
  assert.deepEqual(sent,['太棒了。','明天，如果有空，我们见面。']);
});

test('无 API 或不可用语言对明确失败，不生成模拟结果',async()=>{
  await assert.rejects(service(undefined).translate({text:'你好。'}),/Chrome 138/);
  await assert.rejects(service({async availability(){return 'unavailable';}}).translate({text:'你好。'}),/不支持此语言对/);
});

test('需要用户操作时提示准备入口，不静默创建或转云端',async()=>{
  let created=false;
  const s=service({async availability(){return 'downloadable';},async create(){created=true;}},false);
  await assert.rejects(s.translate({text:'你好。'}),/点击输入框/);
  assert.equal(created,false);
});

test('翻译失败实例不再复用，下一次请求可以恢复',async()=>{
  let created=0,destroyed=0;
  const s=service({async availability(){return 'available';},async create(){
    const count=++created;
    return {async translate(){if(count===1)throw new Error('引擎已失效');return 'Hello.';},destroy(){destroyed++;}};
  }});
  await assert.rejects(s.translate({text:'你好。'}),/本机翻译失败或超时/);
  assert.equal((await s.translate({text:'你好。'})).translatedText,'Hello.');
  assert.equal(created,2);assert.equal(destroyed,1);
});

test('已是英文的手动草稿不下载重复语言对',async()=>{
  const s=service({async create(){throw new Error('不能创建同语言对');}});
  assert.equal((await s.translate({text:'Already English',sourceLang:'auto',targetLang:'en'})).translatedText,'Already English');
});

test('网页英译中与默认中译英分别初始化并复用各自语言对', async()=>{
  const pairs=[], texts=[];
  const s=service({async availability(){return 'available';},async create(options){
    pairs.push([options.sourceLanguage,options.targetLanguage]);
    return {async translate(text){texts.push(text);return options.targetLanguage==='zh'?'明天见。':'See you tomorrow.';},destroy(){}};
  }});
  assert.equal((await s.translate({text:'See you tomorrow.',sourceLang:'en-US',targetLang:'zh-CN'})).translatedText,'明天见。');
  assert.equal((await s.translate({text:'明天见。'})).translatedText,'See you tomorrow.');
  assert.equal((await s.translate({text:'See you later.',sourceLang:'en',targetLang:'zh'})).translatedText,'明天见。');
  assert.deepEqual(pairs,[['en','zh'],['zh','en']]);
  assert.deepEqual(texts,['See you tomorrow.','明天见。','See you later.']);
});

test('英译中缺包错误指向反向准备入口，未激活时不创建实例', async()=>{
  let created=0;
  const s=service({async availability(){return 'downloadable';},async create(){created++;}},false);
  await assert.rejects(s.translate({text:'Good morning.',sourceLang:'en',targetLang:'zh'}),/准备本机英译中/);
  assert.equal(created,0);
  await assert.rejects(service(undefined).translate({text:'Good morning.',sourceLang:'en',targetLang:'zh'}),/准备本机英译中/);
});

test('英译中空结果失败后可重试，未变化的专名仍可返回', async()=>{
  let created=0,destroyed=0;
  const s=service({async availability(){return 'available';},async create(){
    const count=++created;
    return {async translate(text){return count===1?'  ':text==='OpenAI'?'OpenAI':'早上好。';},destroy(){destroyed++;}};
  }});
  const request={text:'Good morning.',sourceLang:'en',targetLang:'zh'};
  await assert.rejects(s.translate(request),/准备本机英译中/);
  assert.equal((await s.translate(request)).translatedText,'早上好。');
  assert.equal((await s.translate({...request,text:'OpenAI'})).translatedText,'OpenAI');
  assert.equal(created,2);assert.equal(destroyed,1);
});

test('英译中底层忽略取消信号时仍在三十秒失败并释放实例', async()=>{
  const clock=fakeClock();let signal,finish;let created=0,destroyed=0;
  const s=service({async availability(){return 'available';},async create(){
    const count=++created;
    return {translate(_text,options){
      if(count>1)return Promise.resolve('新的译文。');
      signal=options.signal;return new Promise(resolve=>{finish=resolve;});
    },destroy(){destroyed++;}};
  }},true,clock);
  const request={text:'Try again.',sourceLang:'en',targetLang:'zh'};
  const rejected=assert.rejects(s.translate(request),/本机翻译失败或超时/);
  await clock.flush();assert.equal(signal.aborted,false);
  await clock.advance(30000);await rejected;
  assert.equal(signal.aborted,true);assert.equal(destroyed,1);
  assert.equal((await s.translate(request)).translatedText,'新的译文。');
  finish('旧译文。');await clock.flush();
  assert.equal((await s.translate(request)).translatedText,'新的译文。');
});

test('分发清单仅为 ChatGPT 重接申请固定主机，不预授予云端或本地代理',()=>{
  const manifest=JSON.parse(fs.readFileSync(path.resolve(__dirname,'../src/manifest.json')));
  assert.deepEqual(manifest.host_permissions,['https://chatgpt.com/*']);
  assert.equal(manifest.minimum_chrome_version,'138');
  assert.deepEqual(manifest.optional_host_permissions,['https://*/*','http://127.0.0.1/*','http://localhost/*']);
});

test('切换配置清除缓存，旧本机结果不能覆盖新服务结果',async()=>{
  let release;let calls=0;
  const s=service({async availability(){return 'available';},async create(){return {
    translate(){calls++;return calls===1?new Promise(resolve=>{release=resolve;}):Promise.resolve('New.');},destroy(){}
  };}});
  const old=s.translate({text:'你好。'});await new Promise(setImmediate);
  s.configure({provider:'browser',revision:'changed'});
  const fresh=await s.translate({text:'你好。'});assert.equal(fresh.translatedText,'New.');
  release('Old.');await assert.rejects(old,/已切换/);
  assert.equal((await s.translate({text:'你好。'})).translatedText,'New.');assert.equal(calls,2);
});
