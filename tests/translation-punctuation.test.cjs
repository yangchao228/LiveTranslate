const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

// 直接加载项目 TypeScript，隔离每个测试的静态缓存，不额外引入测试框架。
function createLoader() {
  const modules = new Map();
  return function load(filename) {
    const absolute = path.resolve(__dirname, '..', filename);
    if (modules.has(absolute)) return modules.get(absolute);
    const exports = {};
    modules.set(absolute, exports);
    const code = ts.transpileModule(fs.readFileSync(absolute, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
    }).outputText;
    vm.runInNewContext(code, {
      exports,
      require: name => load(path.resolve(path.dirname(absolute), name + '.ts')),
      __LOCAL_TRANSLATION__: true,
      console: { log() {}, warn() {}, error() {} },
      setTimeout, clearTimeout
    }, { filename: absolute });
    return exports;
  };
}

test('服务层在显示和缓存之前纠正 API 返回的问号', async () => {
  const load = createLoader();
  const { VolcEngineTranslator } = load('src/content/volcengine-translator.ts');
  const { TranslationService } = load('src/content/translation-service.ts');
  let calls = 0;
  VolcEngineTranslator.translate = async () => {
    calls++;
    return { translatedText: 'Hello?', detectedSourceLanguage: 'zh' };
  };
  const request = { text: '你好。', targetLang: 'en' };
  const result = await TranslationService.translate(request);
  assert.equal(result.translatedText, 'Hello.');
  assert.equal(result.detectedSourceLanguage, 'zh');
  assert.equal((await TranslationService.translate(request)).translatedText, 'Hello.');
  assert.equal(calls, 1);
});

const { preserveEndingPunctuation } = createLoader()('src/content/translation-punctuation.ts');
const cases = [
  ['中文句号覆盖问号', '你好。', 'Hello?', 'Hello.'],
  ['中文问号覆盖句号', '你好吗？', 'How are you.', 'How are you?'],
  ['感叹号覆盖句号', '你好！', 'Hello.', 'Hello!'],
  ['逗号保留停顿', '你好，', 'Hello.', 'Hello,'],
  ['分号', '继续；', 'Continue?', 'Continue;'],
  ['冒号', '如下：', 'As follows.', 'As follows:'],
  ['补上缺失的标点', '你好。', 'Hello', 'Hello.'],
  ['半角句号', '你好.', 'Hello!', 'Hello.'],
  ['末尾引号', '他说“你好。”', 'He said “Hello?”', 'He said “Hello.”'],
  ['末尾括号', '（你好。）', '(Hello?)', '(Hello.)'],
  ['不更改句内标点', '第一句？第二句。', 'First? Second!', 'First? Second.'],
  ['省略号', '等等……', 'Wait?', 'Wait...'],
  ['保留组合标点', '真的吗？！', 'Really.', 'Really?!'],
  ['无原文标点时不干预', '你好吗', 'How are you?', 'How are you?'],
  ['忽略句尾空白', '你好。  ', 'Hello?  ', 'Hello.'],
  ['空译文不生成假结果', '你好。', '', '']
];
for (const [name, source, translated, expected] of cases) {
  test(name, () => assert.equal(preserveEndingPunctuation(source, translated), expected));
}
test('不更改其他目标语言的标点', () => {
  assert.equal(preserveEndingPunctuation('你好。', 'こんにちは？', 'ja'), 'こんにちは？');
});
test('支持英文地区代码', () => {
  assert.equal(preserveEndingPunctuation('你好。', 'Hello?', 'en-US'), 'Hello.');
});

test('相同请求在返回之前共用一个进行中的调用', async () => {
  const load = createLoader();
  const { VolcEngineTranslator } = load('src/content/volcengine-translator.ts');
  const { TranslationService } = load('src/content/translation-service.ts');
  let calls = 0, resolve;
  VolcEngineTranslator.translate = () => { calls++; return new Promise(r => resolve = r); };
  const request = { text: '正在请求。', targetLang: 'en' };
  const first = TranslationService.translate(request);
  const second = TranslationService.translate(request);
  assert.equal(calls, 1);
  resolve({ translatedText: 'Pending?' });
  assert.equal((await first).translatedText, 'Pending.');
  assert.equal((await second).translatedText, 'Pending.');
});
test('失败和空译文不缓存，手动重试可再次请求', async () => {
  const load = createLoader();
  const { VolcEngineTranslator } = load('src/content/volcengine-translator.ts');
  const { TranslationService } = load('src/content/translation-service.ts');
  let calls = 0;
  VolcEngineTranslator.translate = async () => {
    calls++;
    if (calls === 1) throw new Error('受控失败');
    return { translatedText: calls === 2 ? '' : 'Retried?' };
  };
  const request = { text: '请重试。', targetLang: 'en' };
  await assert.rejects(TranslationService.translate(request), /受控失败/);
  await assert.rejects(TranslationService.translate(request), /空译文/);
  assert.equal((await TranslationService.translate(request)).translatedText, 'Retried.');
  assert.equal(calls, 3);
});

test('中英混合草稿指定中文源语言，避免英文占多数时原样返回', async () => {
  const load = createLoader();
  const { VolcEngineTranslator } = load('src/content/volcengine-translator.ts');
  const { TranslationService } = load('src/content/translation-service.ts');
  const text = "Let's test this question. I am very much like you. Can you tell me if you miss me? 太棒了。 Who are you!";
  const requests = [];
  VolcEngineTranslator.translate = async request => {
    requests.push(request);
    return { translatedText: request.sourceLang === 'zh' ? text.replace('太棒了。', 'Great.') : text };
  };
  const request = { text, sourceLang: 'auto', targetLang: 'en' };
  const result = await TranslationService.translate(request);
  assert.equal(result.translatedText, text.replace('太棒了。', 'Great.'));
  assert.equal(requests[0].sourceLang, 'zh');
  assert.equal(request.sourceLang, 'auto', '不能修改调用者的请求对象');
  assert.equal((await TranslationService.translate(request)).translatedText, result.translatedText);
  assert.equal(requests.length, 1, '新源语言规则仍复用缓存');
});

test('源语言提示只作用于自动检测的含中文英文目标请求', async () => {
  const load = createLoader();
  const { VolcEngineTranslator } = load('src/content/volcengine-translator.ts');
  const { TranslationService } = load('src/content/translation-service.ts');
  const requests = [];
  VolcEngineTranslator.translate = async request => {
    requests.push(request);
    return { translatedText: 'Result' };
  };
  for (const [request, expected] of [
    [{ text: 'hello 太棒了' }, 'zh'],
    [{ text: 'hello 太棒了', sourceLang: 'auto', targetLang: 'en-US' }, 'zh'],
    [{ text: 'Hello world', sourceLang: 'auto', targetLang: 'en' }, 'auto'],
    [{ text: 'こんにちは世界', sourceLang: 'ja', targetLang: 'en' }, 'ja'],
    [{ text: '你好', sourceLang: 'auto', targetLang: 'ja' }, 'auto'],
  ]) {
    await TranslationService.translate(request);
    assert.equal(requests.at(-1).sourceLang, expected);
  }
});
