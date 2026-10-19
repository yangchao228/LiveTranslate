const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');const path=require('node:path');const vm=require('node:vm');const ts=require('typescript');
const {webcrypto}=require('node:crypto');
// 参考由仓库已安装的官方 Python SDK SignerV4 独立生成，使用明确的虚构 AK/SK。
test('Web Crypto 签名和官方 SDK 固定向量完全一致（中文 UTF-8 正文）',async()=>{
 const vector=require('./volcengine-signature-vector.json');const exports={};
 const code=ts.transpileModule(fs.readFileSync(path.join(__dirname,'../src/background/volcengine-direct.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText;
 vm.runInNewContext(code,{exports,crypto:webcrypto,TextEncoder});
 const result=await exports.signVolcengine(vector.body,{accessKey:'example-ak-only',secretKey:'example-sk-only'},new Date(vector.date));
 assert.deepEqual(JSON.parse(JSON.stringify(result)),vector.headers);
});
