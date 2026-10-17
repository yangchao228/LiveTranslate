<img src="assets/icon.png" width="64" height="64" alt="LiveTranslate 图标">

# LiveTranslate

**在当前网页输入框里，快捷把中文翻成英文。**

写邮件、填表单、整理英文消息时，直接写中文，查看译文后决定复制或替换，减少页面之间的切换。

[下载与安装教程](https://yangxingzhi.reai.group/zh/products/live-translate) · [下载 Chrome 1.0.4](https://github.com/yangchao228/LiveTranslate/releases/tag/v1.0.4) · [反馈问题](https://github.com/yangchao228/LiveTranslate/issues)

## 快速演示

42 秒，静音中文字幕。在真实 ChatGPT 输入框中演示整句自动翻译、Tab 替换、⌥R 手动翻译与复制粘贴。录制使用 Chrome 1.0.4，语言包已准备完成。**译文由你确认，插件不会自动发送消息。**

https://github.com/user-attachments/assets/a038a248-3873-4f3b-93b9-bf4dc27710b2

![LiveTranslate 在输入框旁显示真实英文译文，提供替换原文与复制译文按钮](assets/preview.png)

上图为 Chrome 1.0.3 使用本机模型翻译固定示例的实际截图。译文仍需根据上下文检查。

## 可以怎么用

- **整句自动翻译**：在输入框里写中文，以句号、问号或感叹号结束完整句子后显示英文译文。
- **主动翻译草稿**：先选中一段文字，或将光标留在草稿中，再用工具栏“翻译当前草稿”或手动翻译快捷键。
- **确认后再使用**：复制译文；在支持的输入框中，也可点击“替换原文”或按 Tab 接受。插件不会替你发送消息。
- **默认本机翻译**：准备好 Chrome 语言包后，默认在这台电脑翻译；可选自带密钥的火山直连或自定义服务，使用前需自行配置并了解服务的数据处理及费用。
- **ChatGPT 重载后继续写**：1.0.4 可在插件更新或重载后重新接入已打开的 ChatGPT 页面，无需手动刷新，保留输入框里的草稿。恢复不会主动翻译旧草稿；继续输入完整中文句，或手动翻译后再决定是否替换。

手动翻译默认快捷键为 **Alt+R**（Mac 为 **⌥R**），启停默认为 **Alt+T**（Mac 为 **⌥T**）。以工具栏显示的实际绑定为准，冲突或未设置时可在 Chrome 扩展快捷键页面调整。

## 下载、安装与更新

目前通过 ZIP **手动安装和更新**，尚未上架 Chrome Web Store。适用于支持本机 Translator 的**桌面版 Chrome 138+**；版本号达标仍需设备、系统及语言包支持。**暂不支持 Edge 和手机浏览器。** Chrome 内部页面等受限页面无法使用，部分受控编辑器只支持复制译文。

1. 从[个人站](https://yangxingzhi.reai.group/zh/products/live-translate)或 [GitHub Releases](https://github.com/yangchao228/LiveTranslate/releases/tag/v1.0.4) 下载 `LiveTranslate-1.0.4.zip`，解压到准备长期保留的文件夹。
2. 打开 `chrome://extensions/`，开启开发者模式，选择“加载已解压的扩展程序”，选中直接包含 `manifest.json` 的文件夹。
3. 首次使用需联网，打开准备页，点击“准备语言包并验证”，成功后回到网页输入框试用。其他普通网站如未接入，可点击工具栏“翻译当前草稿”或按 Alt+R／⌥R 补接。

**从 1.0.3 或更早版本首次升级：**

1. 在旧版工具栏关闭翻译开关，等待显示已暂停。
2. 备份原安装文件夹，再用 1.0.4 解压后的内容完整替换原安装文件夹的内容，保持路径不变。
3. 在 `chrome://extensions/` 点击该插件的重载按钮，核对版本为 **1.0.4**，再打开翻译开关。
4. 回到 ChatGPT 即可继续写，**无需刷新页面，已有草稿保留**。第一次升级前暂停，可让旧版正确移除输入监听。

从 1.0.4 起，后续覆盖原目录并重载可直接交接，ChatGPT 无需手动刷新。其他普通网站可用工具栏或 Alt+R／⌥R 按需恢复；受限页面及未授权的嵌入输入框仍受 Chrome 权限约束。不要同时加载两个版本，也不要删除正在使用的安装目录。

本版新增 `https://chatgpt.com/*` 网站访问权限，仅用于重新接入 ChatGPT 主页面；自动补接未扩展到所有网站。若 Chrome 提示权限变更，请核对并允许 ChatGPT 的网站访问。开关、服务选择和快捷键保留；**火山 AK/SK 或服务令牌仅保存在当前会话中，扩展重载后仍需重新填写**。插件没有自动更新，后续请从个人站或 Releases 下载新版。

完整操作、常见问题及更新说明统一维护在[个人站安装页](https://yangxingzhi.reai.group/zh/products/live-translate)。历史版本和变更见 [Releases](https://github.com/yangchao228/LiveTranslate/releases) 与 [CHANGELOG](CHANGELOG.md)。

每个版本附 `SHA256SUMS.txt`，可用来核对下载包是否与发布文件一致。

## 反馈与支持

遇到问题请先看个人站安装说明，再[提交 Issue](https://github.com/yangchao228/LiveTranslate/issues/new/choose)。请提供 Chrome 版本、系统、插件版本、已脱敏的复现步骤；请勿提交密钥、访问令牌、私人草稿或未经处理的完整日志。安全问题请按 [SECURITY.md](SECURITY.md) 私下联系。

安装试用后，如果觉得有帮助，欢迎给这个项目点个 **Star**，支持我继续改进。下载和使用无需 Star。

## 关于这个仓库

这个仓库公开维护 LiveTranslate 的产品介绍、正式发行包和反馈入口。**开发源码目前未公开，本仓库未提供开源许可证。** 安装包通过 Releases 附件提供，不包含在仓库源码下载 ZIP 中。

发布者：**AI生命克劳德** · 联系：<yangchao228@gmail.com> · [个人站](https://yangxingzhi.reai.group/zh/products/live-translate) · [隐私政策](https://yangxingzhi.reai.group/live-translate/privacy-policy.html)
