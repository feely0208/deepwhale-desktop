# 自建中继（5 分钟）

> 一句话：**手机在外面用**时，桌面端主动外连中继、中继把手机的请求转回来。
> 中继只做传输，看不懂内容；配对码与令牌仍由桌面端网关自己校验。
>
> 默认走官方中继 `deepwhale.org.cn`。想「数据不经过我们」就按本文自建一个，
> 然后在桌面端「手机连接 → 中继」里填自己的地址即可。

## 0. 前提

- 一台有公网 IP 的 Linux 服务器（1 核 1G 足够，中继只转发字节）
- 一个指向它的域名（下面用 `relay.example.com`）
- Node.js ≥ 20

## 1. 放代码

```bash
sudo mkdir -p /opt/deepwhale-relay && sudo chown "$USER" /opt/deepwhale-relay
# 从本仓库把 relay/ 目录拷过去（只需要 server.js 和 node_modules 里的 ws）
scp -r relay/server.js package.json relay/README-自建中继.md relay/deploy user@server:/opt/deepwhale-relay/
# 在服务器上装 ws（唯一依赖）
cd /opt/deepwhale-relay && npm init -y >/dev/null 2>&1 && npm i ws --omit=dev
```

## 2. systemd 常驻

```bash
sudo cp /opt/deepwhale-relay/deploy/deepwhale-relay.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now deepwhale-relay
systemctl status deepwhale-relay --no-pager | head -5
```

中继默认只监听 `127.0.0.1:8790`（不直接暴露到公网，必须由 nginx 挡在前面）。
要换端口：改 unit 里的 `Environment=RELAY_PORT=8790`。

## 3. nginx + TLS

把 `deploy/nginx-relay.conf.example` 里的 `server { ... }` 放进你的站点配置，
把 `relay.example.com` 换成你的域名，然后：

```bash
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d relay.example.com     # 或你惯用的证书方式
```

**路径约定（别改）**：外部路径 `/_relay/` → 反代到 `127.0.0.1:8790/`（会剥掉前缀）。
桌面端的 WS 走 `wss://relay.example.com/_relay/ws`，手机的 HTTP 走 `https://relay.example.com/_relay/t/<隧道ID>/…`。

## 4. 桌面端填地址

打开「手机连接」面板 → **中继**卡片 → 填 `https://relay.example.com/_relay` → 保存。

- 只填域名也行（`https://relay.example.com` 会自动补 `/_relay`）
- 保存后**只重连隧道，不动网关**：已配对的手机不会被踢下线
- 想回官方：点「恢复官方中继」

## 5. 验证

```bash
# 中继活着
curl -s -o /dev/null -w '%{http_code}\n' https://relay.example.com/_relay/t/0000000000000000/
# 期望：502（tunnel offline）—— 说明反代与路径都对，只是这个隧道不存在
```

桌面端面板里：中继显示「自建」，远程卡片变绿（已连接中继 ✓）。
手机在外面用同一张二维码即可（新版本 App 会 LAN 优先、失败自动回落你的中继）。

## 排障

| 现象 | 看哪里 |
|---|---|
| 面板「连接中继中…」一直不绿 | `journalctl -u deepwhale-relay -n 50`；确认 nginx 有 `Upgrade`/`Connection` 头（WS 必需） |
| 手机 502 tunnel offline | 桌面端隧道没连上（同上） |
| 手机 401 | 配对码过期（一次性、5 分钟）或令牌被轮换 → 重新扫码 |
| 只在外面失败、局域网正常 | 中继地址填错（少了 `/_relay`）或证书不信任 |

## 安全边界（重要）

- 中继**不保存**任何 secret：桌面端用 `secret` 算出隧道 ID 认领，中继只校验 `HMAC(secret)` 前 16 位；
- 手机侧仍要过网关的**一次性配对码 → 令牌**，中继不校验也不懂；
- 建议中继只监听回环、由 nginx 终止 TLS；不要把 8790 直接开到公网。
