# 发布指南（RELEASING）

发布模式参考 [anywhere-labs/deepseek-harness-desktop](https://github.com/anywhere-labs/deepseek-harness-desktop)：
GitHub Releases 承载安装包（macOS DMG / Windows EXE / Linux AppImage·deb），推送 `v*` 标签自动构建并发布
**Draft Release**，人工确认后公开；macOS 正式版本走 **Developer ID 签名 + 公证**（fail-loud 预检，凭据不全不出包）。

## 一、一次性准备

### 1. 仓库地址

`package.json` 的 `repository` / `homepage` / `bugs` 目前是 `YOUR-NAME` 占位，改为你的实际 GitHub 地址：

```json
"repository": { "type": "git", "url": "https://github.com/<你的用户名>/deepwhale-desktop.git" },
"homepage": "https://github.com/<你的用户名>/deepwhale-desktop#readme",
"bugs": { "url": "https://github.com/<你的用户名>/deepwhale-desktop/issues" }
```

然后：

```sh
git remote add origin https://github.com/<你的用户名>/deepwhale-desktop.git
git push -u origin main
```

### 2. （可选，推荐）代码签名与公证

- **macOS**：需要 Apple Developer Program 的 **Developer ID Application** 证书。
- **Windows**：需要代码签名证书（微软/Comodo/赛门铁克等，EV 证书更佳）。
- 未配置时 CI 产出**未签名**安装包：功能完整可用，但首次打开会被系统提示"无法验证开发者"。

### 3. GitHub Secrets

在仓库 **Settings → Secrets and variables → Actions** 配置（用到哪个配哪个）：

| Secret | 用途 |
| --- | --- |
| `CSC_LINK` + `CSC_KEY_PASSWORD` + `CSC_NAME` | macOS 签名（P12 文件路径或 data URI + 密码 + 证书名） |
| `MAC_CERT_P12_BASE64` + `MACOS_SIGN_IDENTITY` + `CSC_KEY_PASSWORD` | macOS 签名（P12 的 Base64 + `Developer ID Application: xxx`） |
| `APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID` | macOS 公证（Apple ID 方式） |
| `APPLE_API_KEY` + `APPLE_API_KEY_ID` + `APPLE_API_ISSUER` | macOS 公证（App Store Connect API Key 方式） |
| `APPLE_KEYCHAIN_PROFILE` | macOS 公证（钥匙串 profile 方式） |
| `WIN_CSC_LINK` + `WIN_CSC_KEY_PASSWORD` | Windows 签名 |

> 配置好签名凭据后：把 `.github/workflows/release.yml` 中 mac 任务的 `CSC_IDENTITY_AUTO_DISCOVERY: 'false'`
> 删除（或改 `'true'`），并取消注释对应 Secret 行。本地可用 `npm run preflight:mac` / `npm run release:mac` 先行验证。

## 二、每次发布

1. 更新版本号与变更记录：
   - `package.json` → `version`（SemVer，如 `1.0.0`）
   - `CHANGELOG.md`：把 `[Unreleased]` 改为 `[1.0.0] - <日期>`，并新建空的 `[Unreleased]`
2. 提交并推送：
   ```sh
   git add -A
   git commit -m "chore: release v1.0.0"
   git push
   ```
3. 打标签推送（触发 `release.yml`）：
   ```sh
   git tag v1.0.0
   git push origin v1.0.0
   ```
4. 等待三个平台构建完成（Actions → Release），产物自动上传到 **Draft Release**。
5. 编辑 Draft Release 正文（模板见下），核对产物后点击 **Publish release**。

> 不想走 tag：可在本地 `npm run dist` 后用 `release/` 下的产物手动创建 GitHub Release 并上传。

## 三、Release 正文模板

```markdown
# DeepWhale Desktop v1.0.0

## 下载
- macOS（Apple Silicon / Intel）：`DeepWhale-Desktop-1.0.0-arm64.dmg` / `DeepWhale-Desktop-1.0.0-x64.dmg`
- Windows x64：`DeepWhale-Desktop-1.0.0-x64-Setup.exe`
- Linux：`DeepWhale-Desktop-1.0.0-x86_64.AppImage` / `DeepWhale-Desktop-1.0.0-x86_64.deb`

## 更新内容
- ...

> 本项目是基于 DeepSeek Harness 构建的社区桌面版本，并非 DeepSeek 官方产品，也不代表 DeepSeek 官方立场。
> 本项目完全开源免费。如果有人向您以任何形式出售此软件，请拒绝交易。
```

## 四、发布后

- 确认仓库 Topics（Settings → 左下 Topics → 添加）：建议 `deepseek`、`deepseek-harness`、`electron`、`desktop`、`dsh`、`dsh-plugin-desktop`
- 在 README 底部"联系方式"放入你的微信 / QQ 二维码图片（`assets/contact-wechat.png`、`assets/contact-qq.jpg`）并提交

## 五、常见问题

| 问题 | 处理 |
| --- | --- |
| 公证失败：`The specified profile ... was not found` | 检查 `APPLE_KEYCHAIN_PROFILE`，或改用 Apple ID / App Store Connect API Key 方式 |
| 签名失败：`No identity found for signing` | 证书未导入 CI 所用钥匙串；检查 `CSC_LINK` / `CSC_NAME` 与证书有效期 |
| 预检报 `CSC_IDENTITY_AUTO_DISCOVERY=false` | 该变量会禁用签名，正式发布时删除它 |
| mac 打不出 x64 包 | CI 的 `macos-latest` 是 arm64，electron-builder 可交叉产出 x64；本地 Intel 机器只能出 x64 |
