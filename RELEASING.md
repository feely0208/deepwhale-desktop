# 发布指南（RELEASING）

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

### 2.1 律师端（独立版本线）

律师端有自己的版本号（`lawyer/package.json` 的 `version`），与壳**不同步**。

```sh
# 改 lawyer/package.json 的 version → 提交推送（lawyer/** 变更会自动触发 lawyer-build.yml）
# 或手动触发：Actions → Build Lawyer (Win/Linux/macOS) → Run workflow
```

产物：`DeepWhale-Lawyer-<版本>-arm64.zip`（macOS）、`-x64.zip`（macOS Intel）、
`-x64-Setup.exe`（Windows）、`-x86_64.AppImage` / `.deb`（Linux）。

> ⚠️ electron-builder 的输出目录名不统一：**arm64 是 `dist/mac-arm64`，x64 是 `dist/mac`**。
> CI 里已按架构映射并加了断言（zip 里必须真的有 app 内容），否则会打出一个**内容为空的 zip**
> 而构建照样成功。

### 2.2 套装（桌面 + 律师端 合体包）

**不要手工打套装** —— 历史上正是因为它纯手工，才总是落后于壳（壳已 1.0.16 时套装还停在 1.0.15）。

```sh
# 方式 A（推荐）：CI 一键
#   Actions → Build Suite → Run workflow
#   输入 shell_tag（如 v1.0.17）、lawyer_version（如 0.1.1）、source_release（放产物的 release）
#   产出 Draft Release：suite-<shell_tag>，含四平台 zip + sha256 清单 + 安装说明

# 方式 B：本地
node scripts/build-suite.js \
  --shell-version 1.0.17 --lawyer-version 0.1.1 \
  --artifacts <含各平台产物的目录> --out suite-out
```

> 🔴 **铁律：发布 `suite-*` 套装时必须勾 Pre-release。**
> GitHub 的 "latest" 由发布时间决定，套装是后发的就会抢走它；抢走之后
> `releases/latest/download/latest-mac.yml` → 302 → 404，**桌面端的自动更新静默失效**
> （用户永远收不到新版本，且没有任何报错）。

### 2.3 官网更新

两个站的版本号散落在 4 个文件里，手工改必漏（线上就出过 **首页(site.js) 给 v1.0.15、
下载页给 1.0.16** 的不一致）。用脚本一次改完：

```sh
node scripts/bump-site-version.js \
  --shell 1.0.17 --lawyer 0.1.1 --lawyer-tag v1.0.17 \
  --suite 1.0.17 --suite-platforms 4 --lawyer-platforms 5 \
  --dry-run          # 先看会改什么；确认后去掉 --dry-run
```

覆盖：`docs/index.html`（Pages 站）、主站 `download.html`、主站 `assets/site.js`，
含产物路径、release tag、版本徽标、以及"· N 个平台"标签。

**⚠️ 脚本不处理的（需人工确认）**：
- **新增平台的入口卡片**（macOS Intel 的律师端 / 套装）—— 脚本只改版本号，不新增卡片
- 主站改完要部署：`bash "/Users/mac/DeepSeek Harness/site-migration/deploy.sh"`
- 部署后按**红线五**做线上复查（`scan.sh --online` 零命中，而不是只 grep 本地）

### 2.4 上线前必做

1. **合规扫描**：`bash ~/.dsh/skills/compliance-audit/scan.sh --all` → 本地与线上都零命中
2. **安装包验证**（不能只静态读码）：装一次、跑一次、确认法律模式能弹出律师端
3. **核对 order**：产物上传 → 官网改链接。**顺序反了就是 404**
4. **CDN**（若已接入）：上传新包后**必须刷新缓存**，否则用户下到旧包

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
- 更新主页下载链接：`docs/index.html` 里硬编码了下载地址，新版本发布后把版本号替换为新版本号并提交
- **跑链接检查（必做）**：`node scripts/check-homepage-links.js` —— 所有主页下载链接必须全绿，发现 404 立刻修正再发
- 首次启用 GitHub Pages：仓库 Settings → Pages → Source 选 **GitHub Actions** → Save；此后推送 main 会自动部署主页到 `https://<你的用户名>.github.io/deepwhale-desktop`

## 五、常见问题

| 问题 | 处理 |
| --- | --- |
| 公证失败：`The specified profile ... was not found` | 检查 `APPLE_KEYCHAIN_PROFILE`，或改用 Apple ID / App Store Connect API Key 方式 |
| 签名失败：`No identity found for signing` | 证书未导入 CI 所用钥匙串；检查 `CSC_LINK` / `CSC_NAME` 与证书有效期 |
| 预检报 `CSC_IDENTITY_AUTO_DISCOVERY=false` | 该变量会禁用签名，正式发布时删除它 |
| mac 打不出 x64 包 | CI 的 `macos-latest` 是 arm64，electron-builder 可交叉产出 x64；本地 Intel 机器只能出 x64 |
