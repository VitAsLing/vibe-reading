# Vibe Reading

Vibe Reading 是一个用于网页阅读、翻译和语言学习的浏览器扩展。配置保存在本地，AI 或翻译能力由用户自行配置的服务商和 API Key 提供。

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
pnpm test
pnpm type-check
pnpm build
```

pre-push hook 直接通过 pnpm 运行 lint、类型检查和测试，不使用任务缓存。

扩展生命周期 E2E 将生产构建加载到独立 Chromium 配置中，每种模式运行 18 个场景，验证后台唤醒、混合行内/块内容逐个重试、错误组件装载后的重载、动态内容和页面切换、挂起及静默重载、刷新恢复、停止或复用原元素后的迟到成功/失败、新旧请求状态归属、包装节点插入前取消，以及页面语言检测乱序。模型响应使用本地 HTTP 模拟；两个取消场景在浏览器边界延迟真实 `getDetectedCode` 消息或动画帧回调，不 mock 扩展内部函数。不读取常用浏览器配置或生产 API Key。

```bash
pnpm build
pnpm exec playwright install chromium
pnpm e2e:extension
pnpm e2e:extension .output/chrome-mv3 .output/acceptance/translation-only --translation-only
```

两种模式串行运行。可将 `E2E_BROWSER_EXECUTABLE` 设置为已有 Chrome for Testing 可执行文件路径，验证指定浏览器版本；未设置时使用 Playwright Chromium。Build 工作流在打包后使用生产 Chrome 构建运行两种模式，验收工件与发布 ZIP 分开上传，场景失败时也保留工件。

Playwright 默认模拟页面聚焦，本套件不证明原生标签页的 hidden/visible 切换，也不证明已登录 X 页面或真实付费模型服务的行为。

默认工件位于 `.output/acceptance/extension-lifecycle`，包括实际浏览器版本、启动前捕获的提交与工作区状态、源码/验收脚本/构建摘要、步骤与断言、HTTP 和公开消息记录、worker 停止/重启顺序、Chrome 扩展错误列表、截图和 `trace.zip`。可通过 `pnpm exec playwright show-trace <trace.zip 路径>` 检查执行过程。

## 授权与致谢

Vibe Reading 修改自 [Read Frog](https://github.com/mengxi-ream/read-frog)。感谢 Read Frog 的作者和贡献者提供原始 GPL 授权作品。

本项目按 GNU General Public License version 3 分发，完整许可证见 [LICENSE](./LICENSE)。作为修改版本，Vibe Reading 遵守 GPLv3 条款，继续以同一许可证提供源码，并明确标记本 fork 已发生修改，避免将本 fork 的问题归因于上游项目。
