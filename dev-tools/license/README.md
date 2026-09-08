# 深鲸律师端 · 授权码签发工具（内部开发用）

> 内部工具，**不进用户端**。用于给律师用户签发"绑定机器码"的授权码。

## 是什么
- `license-tool.js`：本地一键发码工具（在开发者自己电脑跑）。
- 私钥、私钥口令、服务器 AdminToken 均为**开发者本地机密**，**不提交本仓库**（见 `.gitignore`）。

## 使用（在本机）
1. 把本目录 `license-tool.js` 拷到开发者电脑的 `legal-license/` 目录。
2. 在该目录建 `issuer/`，放入**口令加密的私钥** `issuer-private.pem`（勿提交）。
3. 建 `license-tool-config.json`（600 权限），内容：
   ```json
   {
     "adminToken": "<你的 AdminToken>",
     "passphrase": "<私钥口令>",
     "serverBase": "http://<服务器>:8080",
     "defaultExpiry": "2099-12-31",
     "product": "legal-workbench",
     "port": 8899
   }
   ```
4. 运行：`node license-tool.js` → 浏览器打开 `http://127.0.0.1:8899`
5. 点某用户「发码」→ 自动生成绑机器授权码 → 上传到服务器 → 用户 App 自动领取。

## 授权机制
- 授权码 = `base64({p,m,e}).base64(Ed25519签名)`，用开发者本地私钥签发。
- 客户端（律师端 App）用**公钥**验签 + 校验**机器码匹配** + **到期**。
- 私钥只在开发者电脑；公钥在客户端可公开（无法反推伪造）。
