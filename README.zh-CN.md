# Vibe Reading

Vibe Reading 是一个用于网页阅读和翻译的浏览器扩展。配置保存在本地，AI 或翻译能力由用户自行配置的服务商和 API Key 提供。

本扩展不依赖项目自建后端。需要网络服务的功能，例如 AI 翻译，会直接使用用户配置的服务商端点。

## 功能

- 📖 只专注网页阅读翻译。
- 网页全文翻译，支持双语对照和仅译文模式。
- 面向长文页面的段落翻译和页面标题翻译。
- 始终使用 LLM 路径进行语言检测。
- 基于页面内容和摘要的上下文感知 AI 翻译。
- 可配置 AI 与翻译服务商，包括本地或自托管端点。
- 可配置翻译 Prompt、页面规则、批处理和速率控制。
- 不包含 Notebase、托管账号、配置备份、统计面板或项目自建后端依赖。

## 骄傲地不支持

Vibe Reading 刻意保持小而专注：**只有阅读功能**。

| 产品或类别            | 它们通常包含                  | Vibe Reading 骄傲地没有                                | Vibe Reading 保留        |
| --------------------- | ----------------------------- | ------------------------------------------------------ | ------------------------ |
| 🐸 上游 Read Frog     | 学习工具、托管集成、更多模式  | Notebase、托管存储、Custom AI Actions、Beta Experience | 专注网页阅读和翻译       |
| 🌊 沉浸式翻译类套件   | 多媒体和多输入场景翻译        | 视频字幕、输入框翻译、悬浮工具、TTS                    | 网页阅读翻译             |
| 🌐 浏览器内置翻译     | 简单自动网页翻译              | 浏览器账号绑定、不透明服务商选择                       | 用户自选服务商和本地设置 |
| 🤖 通用 AI 侧边栏工具 | 聊天、写作、总结、动作面板    | 通用 AI 工作台、Prompt 启动器、助手悬浮层              | 阅读上下文翻译 Prompt    |
| 📊 生产力或遥测类工具 | Dashboard、使用统计、同步账号 | Statistics、配置备份、遥测面板                         | 本地设置                 |

## 开发

```bash
pnpm install
pnpm lint
pnpm type-check
pnpm build
```

pre-push hook 运行 lint 和类型检查。既有单元测试仍可通过 `pnpm test` 或指定路径的 `pnpm exec vitest run <路径>` 执行。Build 工作流是统一的 PR 验证入口，在 Node.js 24 上执行静态检查、既有测试、浏览器打包和已加载扩展的 E2E。

扩展生命周期 E2E 将生产构建加载到一次性 Chromium 配置中。Chrome 存储、消息、worker、脚本注入和页面 DOM 都是真实执行；模型响应使用本地 HTTP 模拟，延迟和故障注入放在浏览器或 HTTP 边界。不读取常用浏览器配置或生产 API Key。

```bash
pnpm build
pnpm exec playwright install chromium
pnpm e2e:extension
pnpm e2e:extension .output/chrome-mv3 .output/acceptance/translation-only --translation-only
E2E_NATIVE_VISIBILITY=1 pnpm e2e:extension .output/chrome-mv3 .output/acceptance/native-bilingual
E2E_NATIVE_VISIBILITY=1 pnpm e2e:extension .output/chrome-mv3 .output/acceptance/native-translation-only --translation-only
```

四组串行运行，覆盖双语和仅译文模式，以及原生前台、后台和冻结页面的重载、失败恢复、并发保存与迟到确认。可用 `--case=<名称>` 运行单个场景；原生场景需保留 `E2E_NATIVE_VISIBILITY=1`。完整覆盖范围和环境说明见 [英文开发文档](README.md#development)。

可将 `E2E_BROWSER_EXECUTABLE` 设置为已有 Chrome for Testing 可执行文件路径；未设置时使用 Playwright Chromium。Build 工作流在打包后运行四组验收，工件与发布 ZIP 分开上传，场景失败时也保留工件。

默认两组使用 Playwright 的页面聚焦模拟，原生两组则直接验证 hidden/visible、冻结和重载。四组均不证明已登录 X 页面或真实模型服务的行为。

默认工件位于 `.output/acceptance/extension-lifecycle`，包括实际浏览器版本、启动前捕获的提交与工作区状态、源码/验收脚本/构建摘要、步骤与断言、HTTP 和公开消息记录、worker 停止/重启顺序、Chrome 扩展错误列表、截图和 `trace.zip`。可通过 `pnpm exec playwright show-trace <trace.zip 路径>` 检查执行过程。

## 授权与致谢

Vibe Reading 修改自 [Read Frog](https://github.com/mengxi-ream/read-frog)。感谢 Read Frog 的作者和贡献者提供原始 GPL 授权作品。

本项目按 GNU General Public License version 3 分发，完整许可证见 [LICENSE](./LICENSE)。作为修改版本，Vibe Reading 遵守 GPLv3 条款，继续以同一许可证提供源码，并明确标记本 fork 已发生修改，避免将本 fork 的问题归因于上游项目。
