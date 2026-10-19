# Chrome 扩展权限与数据流

更新：2026-10-19，按已发布 Chrome 1.0.8 源码说明。普通分发版默认 Chrome 本机翻译，可选火山直连或自定义服务；失败不自动切换。

## 基础权限

| 声明 | 当前用途 |
| --- | --- |
| `activeTab` | 用户操作工具栏/手动命令后访问活动网页，配合 scripting 定位编辑器 |
| `scripting` | 手动入口执行固定只读定位函数，确定唯一活动编辑 frame，不广播多个草稿 |
| `storage` | sync 保存开关/更新时间，local 保存普通配置/位置，session 保存本次会话凭据 |
| `<all_urls>` 内容脚本、`all_frames` | 在 Chrome 允许的网页/frame 自动发现和监听输入框，显示译文及确认替换；安装会显示网站数据访问提示 |
| 可选服务主机 | `https://*/*` 和 loopback HTTP 支持用户自行填写的服务，后台仅访问保存的完整 URL |

已移除不必要的 `tabs` 和 permissions 中的 `commands`。标签 ID 查询、消息和打开内置页面无需 tabs 的 URL/title 等敏感字段权限；快捷键保留清单顶层 commands 配置。没有为了减少提示关闭自动整句功能。[Tabs API](https://developer.chrome.com/docs/extensions/reference/api/tabs)、[Commands API](https://developer.chrome.com/docs/extensions/reference/api/commands)。

设置页保存远程服务时，按具体主机调用权限请求，拒绝不改设置。静态全站内容脚本的授权可能已经覆盖该主机，不能保证每次出现独立授权框。Chrome 主机权限不限定端口；后台仍按保存的完整接口 URL 请求。可在 Chrome 扩展详情调整网站访问范围；撤销会使当前服务修订号失效，旧译文关闭，后续请求拒绝，重新授权后仍需重新翻译。[可选权限](https://developer.chrome.com/docs/extensions/reference/api/permissions)。

## 读取、处理和发送

启用后读取支持的编辑器已有全文到页面内存，以计算编辑区间、原文快照和光标。自动翻译只处理本次编辑涉及的完整中文候选句；手动翻译处理选区，无选区时处理完整草稿。标准密码/只读/禁用输入框不在范围内，普通文本框中的秘密无法自动识别。

默认本机通过 Chrome Translator 处理，不发远程翻译请求，首次语言包由 Chrome 下载。用户保存选择远程服务后，后续完整中文候选句会持续自动发送，手动入口发送选区/整个草稿，直至停用或切回本机。扩展不会代发聊天、评论或提交表单。

- 火山直连固定 `https://translate.volcengineapi.com/`、TranslateText/2020-06-01、cn-north-1/translate。AK 在认证头标识身份，SK 仅本机签名，不发送；15 秒超时，5,000 UTF-16 单元上限。
- 自定义/旧代理仅 HTTPS 或 localhost/127.0.0.1 HTTP；禁止 URL 用户信息/查询/fragment，不带 Cookie、不重定向。Bearer 仅发给保存且绑定的完整 endpoint；15 秒超时。
- 配置变化、清凭据或撤权使缓存和旧响应失效；发出的请求无法收回。网页不传 URL/令牌/自定义头到后台，错误不反射供应商任意正文。
- 复制仅在用户点击时写入剪贴板，不读取剪贴板。替换失败保留原稿复制退路；Lexical 标记编辑器默认仅复制。网页本身可以看到编辑器及页面中的译文。

## 会话凭据和迁移

AK/SK/Bearer 仅存 `chrome.storage.session` 内存。Chrome 重启、扩展重载/更新/禁用清空；后台休眠及工具栏停用翻译不清空。服务选择、endpoint、是否需令牌的标记和位置保留在 local。需要凭据时显示重新填写提示，不改成匿名请求或自动换服务。

local/session 均先设置 `TRUSTED_CONTEXTS`；失败不读写凭据，内容脚本不能读取完整设置或接收私有存储变更。配置/迁移/清除/固定句测试只接受 options 页面。访问隔离不等于静态加密，也不能抵御电脑所有者或扩展调试访问内存。[Storage 官方边界](https://developer.chrome.com/docs/extensions/reference/api/storage)、[商店安全处理要求](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq)。

旧 local 明文只显示待处理标记，不回显或静默使用；所有远程请求暂停，用户明确选择移入本会话并删除旧保存，或清除旧凭据。迁移先成功写入内存再移除磁盘秘密字段；失败保留配置并允许重试。用户处理前旧秘密仍在 local，删除不保证擦除备份或历史文件。切回本机不删除配置/会话凭据/主机权限；清除直连密钥会切回本机；清除代理令牌保留服务并暂停认证请求。扩展清除不撤销供应商密钥。

## 保留、费用和开发边界

缓存键含原文，快照/译文/进行中任务仅在页面内存；没有固定缓存过期。切服务清缓存，刷新/关闭页面释放；工具栏停用清监听/任务/浮窗，但不立即清全部缓存。开关及更新时间可通过 Chrome sync 同步，草稿/译文/凭据不写入 sync。

没有开发者遥测/广告/分析 SDK。供应商、网页和服务管理员的日志及保留规则需各自确认；不能替它们承诺不留存或不训练。本机无云 API 调用费，使用设备资源/下载流量；火山/自定义由用户服务账号计费。

开发版 `dist-local` 初始使用 loopback 兼容服务并预授权 `http://127.0.0.1/*`，保存选择优先；分发 ZIP 只从普通 dist 构建。默认本机翻译无需 Python 服务；公开版本不包含历史代理与生产配置。源码从正式 Chrome 1.0.8 的独立快照开始公开，不包含私有开发历史或 Edge 实验。

当前政策见[随包政策源文件](docs/web-store/privacy-policy.html)与[公开隐私政策](https://yangxingzhi.reai.group/live-translate/privacy-policy.html)。代码开源与商店上架分开，目前仍通过个人站和 GitHub Releases 手动安装更新。

## 工具栏网页自检与双向状态

Chrome 1.0.8 复用既有权限，没有新增权限。打开工具栏仅向当前活动主页面发送连接握手；用户点击“重新接入”才按既有 `activeTab`／`scripting` 授权补接内容脚本和样式，不刷新、不修改草稿、不触发翻译。导航和切换页面会使旧结果失效。后台为校验目标临时读取当前标签地址，不持久保存或返回给工具栏；不读取网页正文。两向语言包只读检查 `Translator.availability`，不创建或下载模型；准备页仍由用户点击下载和验证。详见[网页自检说明](docs/page-health.md)。
