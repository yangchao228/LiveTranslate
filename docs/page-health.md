# 网页连接与双向语言包状态

Chrome 1.0.8 的工具栏打开时，只读检查当前主页面连接。失联时可显式点击“重新接入”，不刷新网页、不修改草稿、焦点或选区，也不主动翻译已有草稿。无法确认或页面切换后，请重新检查。

连接状态仅确认主 frame 的内容脚本响应，不能证明所有编辑器、嵌入页面或语言包都可用。浏览器内部页和未授权的页面仍受 Chrome 限制。

后台的恢复请求绑定活动标签、窗口、地址、导航和检查令牌；过期、切换标签或导航后拒绝继续处理旧请求。检查令牌只保存在后台内存，最多32条、有效120秒。复用 `activeTab` 与 `scripting`，没有新增权限，不收集网页正文。

中译英与英译中独立检查 `Translator.availability`。工具栏不创建模型、不主动下载；“已下载”代表浏览器报告资源可用，仍可按方向进入准备页验证固定句。输入和阅读开关互不影响。

实现见 `src/background/page-health.ts`、`src/background/content-recovery.ts` 和 `src/popup/popup.js`。相关 Node 用例位于 `tests/page-health.test.cjs`、`tests/content-recovery.test.cjs`；浏览器工具栏 runner 使用 API 替身，真实安装恢复 runner 使用隔离 Chrome。执行方式见[开发说明](development.md)。
