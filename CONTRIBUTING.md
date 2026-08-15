# 贡献指南（Contributing）

欢迎参与 **DeepSeek Harness Desktop** 的开发！无论是修 Bug、加功能、写文档还是提 Issue，都感谢你的贡献。

## 开发环境

- Node.js ≥ 18（建议 ≥ 20）
- `npm install` 后 `npm run dev` 即可本地开发
- 本机需要有 DeepSeek Harness（`npx @deepseek-ai/dsh web`）或其替代命令，应用会自动拉起/复用

## 提交 PR 前

1. **保持模块职责单一**：主进程各模块（service-manager / skin-manager / pet / tray / usage-manager / store）互不耦合，新增功能请放对地方。
2. **错误处理兜底**：IPC、文件读写、网络请求都要 try/catch，失败时静默降级或明确报错，不阻塞主流程。
3. **尽量不新增第三方依赖**：能用 Electron/Node 内置能力解决就不加包；确需新增请在 PR 说明理由。
4. **不提交密钥**：绝不要把 API Key、token、证书放入代码或提交历史（见 SECURITY.md）。
5. **通过构建与冒烟**：
   ```bash
   npm run build    # tsc 编译通过
   npm run smoke    # 端到端冒烟通过（会自动打开设置页校验注入）
   ```
6. 若有 UI/行为变更，请同步更新 README 相关章节。

## 提交信息风格

建议使用 conventional commits：

```
feat: 描述新功能
fix: 描述修复
docs: 描述文档变更
refactor: 描述重构
chore: 描述杂项
```

## 测试

- `npm run smoke`：自动启动应用、打开 DSH 设置页、校验"宠物/用量/皮肤"三栏注入与内容渲染，8 秒后退出（CI 可用）
- 手动验证清单：皮肤切换/背景图、宠物动作（拖拽速度档位/悬停/点击）、用量刷新与余额显示、托盘与 macOS 菜单

## 打包

- `npm run dist:mac`（macOS）、`dist:win`（Windows，需 Windows 或 CI）、`dist:linux`（Linux）
- 跨平台产物请在各自系统或 GitHub Actions 上构建

## 提问

- 先搜索 [Issues](https://github.com/) 是否已有相同问题
- 提供：复现步骤、系统/Node 版本、相关日志（应用主进程输出）、截图
