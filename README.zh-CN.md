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

## 授权与致谢

Vibe Reading 修改自 [Read Frog](https://github.com/mengxi-ream/read-frog)。感谢 Read Frog 的作者和贡献者提供原始 GPL 授权作品。

本项目按 GNU General Public License version 3 分发，完整许可证见 [LICENSE](./LICENSE)。作为修改版本，Vibe Reading 遵守 GPLv3 条款，继续以同一许可证提供源码，并明确标记本 fork 已发生修改，避免将本 fork 的问题归因于上游项目。
