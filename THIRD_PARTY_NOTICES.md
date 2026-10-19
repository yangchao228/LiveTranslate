# 第三方依赖与许可

LiveTranslate 自有源码与文档使用根目录的 [MIT 许可证](LICENSE)。第三方软件、浏览器和模型保留各自的许可与使用条款。

## Chrome 翻译能力

本版本调用 Chrome 提供的 Translator API。本仓库和安装包不包含浏览器本体或翻译模型权重；语言包由 Chrome 在用户操作后准备。MIT 许可不重新许可这些浏览器组件、模型或用户配置的外部翻译服务。

## 构建依赖

构建依赖的精确版本、下载来源和 SPDX 许可标识保存在 [依赖许可清单](docs/dependency-licenses.json)，由 `package-lock.json` 生成，包含平台可选依赖。`node_modules` 不随本仓库分发。构建依赖的版权与许可文本保留在相应 npm 包中；复制这些包或其代码时，应继续保留对应声明。

| 许可 | 依赖示例 |
| --- | --- |
| MIT | Vite、Vue、Tailwind CSS、esbuild、Rollup、PostCSS |
| Apache-2.0 | TypeScript |
| ISC | picocolors、electron-to-chromium |
| BSD-2-Clause | entities |
| BSD-3-Clause | source-map-js |
| CC-BY-4.0 | caniuse-lite 的浏览器兼容性数据 |

这些依赖在本版本中用于构建或开发；插件界面使用原生 HTML、JavaScript 与 TypeScript，不意味着所有声明的框架都实际用于运行时。

## 品牌与媒体

`assets/brand/mark.svg` 和 `assets/icons/` 为项目自有图标。演示截图与录屏中出现的平台界面、名称、商标及其他用户内容属于各自权利人，MIT 许可不授予其商标权或第三方内容的再利用权。

使用 `npm run release:package` 生成的后续源码构建包会附带 `LICENSE` 与本文件。既有 GitHub Release 附件及其校验值保持不变。
