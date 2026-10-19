# 从源码构建 Chrome 扩展

此仓库公开与 Chrome 正式版 1.0.8 对应的完整扩展源码、图标、构建脚本和回归测试。需要 Node.js 22.12+、npm；打包检查使用 Python 3 标准库。普通本机翻译不需要 Python 服务或 API 密钥。

首个稳定源码标签为 `source-v1.0.8`。早期 `v1.0.x` 标签是源码公开之前的发行记录，未移动这些标签或改写历史附件。

## 安装与构建

```bash
git clone https://github.com/yangchao228/LiveTranslate.git
cd LiveTranslate
npm ci --ignore-scripts
npm test
npm run typecheck
npm run build
```

在 `chrome://extensions/` 开启开发者模式，选择“加载已解压的扩展程序”，加载生成的 `dist/`。首次在工具栏按方向准备并验证语言包，需支持原生 Translator 的桌面 Chrome 138+ 和兼容设备。正式安装包及用户说明见主 README。

`npm run dev` 持续构建默认本机翻译版本。`npm run build:local` / `npm run dev:local` 是可选的外部代理开发模式：新安装初始选择 loopback 服务，需开发者自行运行兼容服务，已保存的用户选择优先。本公开源码不包含历史 Python 代理、生产 nginx 配置或未发行的 Edge 引擎。默认本机模式无需这些组件。

## 目录

- `src/content/`：整句候选、输入法、原文快照、译文浮窗、划词阅读与提供者。
- `src/background/`：设置权限、会话凭据、手动命令、接入恢复与网页连接检查。
- `src/popup/`、`src/options/`、`src/setup/`、`src/help/`：原生界面和离线帮助。
- `assets/`：图标、品牌源文件与发行截图。
- `tests/`：Node 测试、浏览器回归页面和可选 runner。
- `scripts/`：打包与图标渲染；`docs/web-store/` 为随包政策源文件。

## 验证与打包

```bash
npm test
npm run typecheck
npm run build:local
npm run build
npm run release:check
npm run release:package
```

Node 测试使用 Chrome／翻译接口替身，不证明真实模型、所有网站或语言包首次下载成功。普通构建输出20个扩展文件；打包命令额外放入 `LICENSE` 和 `THIRD_PARTY_NOTICES.md`，不会覆盖下载渠道既有的官方附件。重分发时请保留许可及版权声明。

浏览器回归为可选验证，需单独提供 Playwright 和已安装的 Chrome。例如在临时目录安装 Playwright 后，通过 `PLAYWRIGHT_MODULE` 指向其模块目录：

```bash
PLAYWRIGHT_MODULE=/absolute/path/to/playwright node tests/run-browser.cjs
PLAYWRIGHT_MODULE=/absolute/path/to/playwright node tests/run-page-selection.cjs
PLAYWRIGHT_MODULE=/absolute/path/to/playwright node tests/run-page-health-popup.cjs
```

运行前完成对应的普通或本地构建。runner 默认使用独立 Chrome，不要让测试覆盖日常浏览器资料。真实网站验收仅使用固定非敏感草稿，结束后清空，不发送消息。签名用例中的密钥为公开测试固定值，禁止替换成个人凭据。

## 数据与发布边界

默认本机模式不额外上传待译内容；用户明确选择的远程服务按设置与授权请求，凭据仅保存在当前扩展会话。不要把密钥、浏览器配置、草稿、截图或原始日志提交进仓库。问题反馈与安全报告分别见主 README 与 SECURITY.md。

代码使用 MIT；构建依赖和浏览器模型的许可边界见 THIRD_PARTY_NOTICES.md。开发源码和官方发行包相互区分：源码构建或测试通过不等于新的正式发行。
