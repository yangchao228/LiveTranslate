const assert = require('node:assert/strict');
const {test} = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const exports_ = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(require('node:path').join(__dirname, '../src/content/sentence-range.ts'), 'utf8'), {
  compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020}
}).outputText, {exports: exports_});
const {completedSentence, editedSentence, manualRange, snapshot, matchesSnapshot} = exports_;

const cases = [
  ['逗号分号冒号保持句内上下文', '我明天去上海，如果你有空；计划如下：我们一起吃饭。', '我明天去上海，如果你有空；计划如下：我们一起吃饭。'],
  ['逗号不结束一句', '你好，', null],
  ['半角停顿不结束一句', '你好,继续;如下:', null],
  ['无标点保持安静', '明天见', null],
  ['中文省略号不默认触发', '明天再说……', null],
  ['小数内部的点', '价格3.14元。', '价格3.14元。'],
  ['小数未完成', '价格3.14', null],
  ['版本未完成', '更新v1.2.3', null],
  ['数字尾点保守等待', '版本1.', null],
  ['版本完整句', '升级v1.2.3，再试一次。', '升级v1.2.3，再试一次。'],
  ['域名内部点', '打开https://example.com/path', null],
  ['域名尚未输入完的尾点', '打开https://example.', null],
  ['邮箱尚未输入完的尾点', '发到a.', null],
  ['网址完整句', '打开https://example.com，然后重试。', '打开https://example.com，然后重试。'],
  ['URL 路径点和查询问号不切开上下文', '打开https://example.com/.well-known?x=1，然后重试。', '打开https://example.com/.well-known?x=1，然后重试。'],
  ['裸域名路径内点不触发', '打开example.com/.well-known', null],
  ['邮箱内部点', '发到a.b@example.com', null],
  ['邮箱本地部分下划线后的点', '发到a_.b@example.com', null],
  ['半角句号', '明天一起吃饭.', '明天一起吃饭.'],
  ['组合句末', '你确定吗？！', '你确定吗？！'],
  ['半角组合', '你确定吗?!', '你确定吗?!'],
  ['混合句点组合', '你确定吗?!...', '你确定吗?!...'],
  ['闭引号', '他说“明天再来。”', '他说“明天再来。”'],
  ['嵌套闭括号', '他说（“明天见！”）', '他说（“明天见！”）'],
  ['多句只取最近完成一句', '昨天结束。今天继续！', '今天继续！'],
  ['尾部未完成时保留最近完整句', '明天见。后续草稿', '明天见。']
];
for (const [name, text, expected] of cases) test(name, () => {
  const result = completedSentence(text, text.length);
  assert.equal(result?.text ?? null, expected);
  if (result) assert.equal(text.slice(result.start, result.end), expected);
});
test('UTF-16 偏移保留前导空格、换行和 emoji', () => {
  const text = '前文。 \n  🙂你好。后文';
  const result = completedSentence(text, text.indexOf('后文'));
  assert.equal(result.text, '🙂你好。');
  assert.equal(result.start, text.indexOf('🙂'));
  assert.equal(result.end, text.indexOf('后文'));
});
test('文本中间编辑定位所在完整句', () => {
  const previous = '前文。今天去上海。后文';
  const text = '前文。明天去上海。后文';
  assert.equal(editedSentence(text, previous, 5).text, '明天去上海。');
});
test('删除句首字符后仍定位剩余整句', () => {
  assert.equal(editedSentence('好。', '你好。', 0).text, '好。');
  assert.equal(editedSentence('前句。好。', '前句。你好。', 3).text, '好。');
});
test('未完成句不因历史标点产生新请求', () => {
  assert.equal(editedSentence('历史中文。新草稿', '历史中文。新草', 9), null);
});
test('仅标点、纯英文和重复事件不自动翻译', () => {
  for (const text of ['？！', '。', 'Hello.', '你好，']) assert.equal(editedSentence(text, '', text.length), null);
  assert.equal(editedSentence('你好。', '你好。', 3), null);
});
test('手动选区和全文保持原始区间与多行', () => {
  const text = '  前文🙂\n无标点\n后文';
  assert.equal(manualRange(text, 0, 0).text, text);
  const start = text.indexOf('无标点');
  const result = manualRange(text, start, start + 3);
  assert.equal(result.text, '无标点');
  assert.equal(result.start, start);
  assert.equal(manualRange('  。？！\n', 0, 0), null);
});
test('快照只容许原句后的改动', () => {
  const text = '前文。原句。';
  const source = snapshot(text, completedSentence(text, text.length));
  assert.equal(matchesSnapshot(text + '后方继续', source), true);
  for (const changed of ['前文。修改。', '前文。', '新前文。原句。', '不同。原句。']) assert.equal(matchesSnapshot(changed, source), false);
});
