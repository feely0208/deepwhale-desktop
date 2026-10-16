# DSH typed RPC 协议（手机端 1.1.0 实测记录，2026-10-16）

> 这份是**实测出来**的（不是读代码猜的），手机端接口层与网关都按它来。
> 记录它的原因：协议细节是靠报错一步步反推出来的，不写下来下次还得重推一遍。

## 1. 端点形式（**斜杠，不是点号**）

```
POST /api/<命名空间>/<方法>
例：/api/session/create   /api/session/prompt   /api/session/list
```

⚠️ 坑：`/api/session.list`（点号）会 **404**；斜杠形式才对。

## 2. 请求体

```json
{
  "type": "client-request",
  "rpcId": "<uuid>",
  "method": "<命名空间>/<方法>",      // 必须与 URL 路径一致，否则报
                                      // "method \"x\" does not match endpoint \"session/prompt\""
  "payload": { "args": { "request": { ...方法参数... } } }
}
```

⚠️ 两个包装层级都是**报错逼出来的**，缺一个都不行：
- 少 `args` → `Remote payload must contain exactly one plain-object args field`
- `args` 里直接放字段 → `args fields do not match the descriptor: missing "request"`

## 3. 响应体

```json
{ "type": "server-response", "rpcId": "<同请求>",
  "result": { "ok": true, "value": {...} } }
{ "type": "server-response", "rpcId": "<同请求>",
  "result": { "ok": false, "error": { "code": "session/not-found", "message": "...", "details": {...} } } }
```

## 4. 已实测可用的方法

| 方法 | payload.args.request | 返回 |
|---|---|---|
`session/create` | `{}` | `{sessionId:"session-<uuid>", agentPreset:"standard"}` |
`session/prompt` | `{requestId, sessionId, mode:"queue"\|"steer", content:[{type:"text",text}]}` | `{accepted:true}` |

## 5. 端到端实测（真 DSH，2026-10-16）

```
建会话 → session-f05fb34b-350d-44b5-b774-f65347731100
发消息 → {"ok":true,"value":{"accepted":true}}
读回   → 我们的 /mobile/api/session?id=… 返回 messageCount=5
         messageKeys=["role","content","source","id"]
```

## 6. 与"我们自己的接口"的分工（方案 B）

| 用途 | 走哪条 |
|---|---|
读（列表/详情/消息） | **我们自己的** `/mobile/api/sessions`、`/mobile/api/session?id=`（形状简单，专为手机裁剪） |
写（建会话/发消息） | DSH 基础 RPC `/api/session/create`、`/api/session/prompt`（按本文件第 1~3 节） |

两者都**过我们的网关**（局域网 + 一次性配对码 + 令牌；cookie 由网关透传）。

## 7. 教训（比协议本身更值钱）

1. **报错就是文档**：`args`/`request` 两层包装、斜杠端点，全是把错误信息读懂了才试出来的；
2. **"不知道就如实返回"比"看起来成功"值钱**：接口先返回 `reason:"unknown-shape"`，
   才逼出 `sessions.list()`、`searchSessions 被禁用`、占位 id 与真实 UUID id 的区别；
3. **占位 id 陷阱**：插件里 `sessions.create()` 产出 `session-1` 这种占位 id，
   用它去 prompt 会 `session/not-found`；真会话必须走 `session/create` 拿 UUID。
