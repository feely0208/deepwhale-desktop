## 上游发布了新版本

| | 版本 |
|---|---|
| **npm latest** | `{{LATEST}}` |
| 发布时间 | {{PUBLISHED}} |
| **我们随包的** | `{{PINNED}}` |

最近发布的几个版本：{{RECENT}}

### 为什么这件事要紧

深鲸壳是"随包一个 DSH 运行时"的产品形态，**我们的宣传语是「让 DeepSeek 触手可及」——
上游节奏跟不上，这句话就是空话。** 而技术上，上游每个版本都可能改变我们依赖的机制。

本轮真实踩到过：**0.1.7 起 `.agent-presets` 目录被废弃**
（运行时自带文档原话 *Nothing reads that directory any more.*），预设改为由 bundle patch
携带声明 —— 我们的"法律模式"预设因此**从来没进过花名册**，三平台的选择器里都看不到它。
而 0.2.0-rc.2 的 `hostProtocolVersion` 已到 **4**、会话格式到 **v4**。

### 建议动作

1. 看官方发布说明，列出与「注入 / 插件 / 预设 / office / 运行时接口」相关的变更
2. 对照这几个文件判断影响面：
   - `src/main/legal-mode.ts`（法律模式注入 + 预设 bundle）
   - `src/main/office-runtime.ts`（office 包装脚本）
   - `src/main/bundled-plugins.ts`（随包插件）
   - `.github/workflows/release.yml` 里钉住的运行时版本
3. 决定是否升级随包运行时。升级要走完整流程，**不能只看"能装上"**：
   - `verify-artifacts.py`（三平台拆包自检）
   - `smoke-local.sh`（冷启动冒烟 + 重载断言）
   - `check-legal-preset-roster.js`（法律模式必须在花名册里）
4. 处理完关掉这个 Issue

> 自动创建，来自 `.github/workflows/watch-upstream.yml`
