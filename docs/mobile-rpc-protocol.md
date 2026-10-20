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

---

# 补充：附件 / 模型切换（手机端 1.2.0，2026-10-19 实测）

> 这一节是 1.2.0 做「附件 + chips」时补的。**附件走官方 RPC，不自己造存储接口** ——
> 与桌面端同一条路：图片由宿主做准入/规范化/落盘，文件由宿主 verbatim 存 + 发 receiptId。

## 8. `session/prompt` 的 content part（附件）

```json
content: [
  { "type": "image", "mediaType": "image/jpeg", "data": "<base64>", "name": "photo.jpg" },
  { "type": "file",  "receiptId": "<uploadFileBinary 返回的 receiptId>" },
  { "type": "text",  "text": "看看这两张/这个日志" }
]
```

- `image.mediaType` 只接受 `image/png` / `image/jpeg` / `image/webp` / `image/gif`；
  宿主会**重新解码校验**（谎报类型会被拒）。手机端发送前统一转成 JPEG（长边 1600, q0.82）。
- `file` 必须先上传拿 receiptId，否则报 `session/attachment-invalid` / `FILE_NOT_STAGED`。
- **模型不支持图片**时整个 prompt 被拒：`session/attachment-invalid`,
  `details.reason = MODEL_DOES_NOT_SUPPORT_IMAGES`（实测：切到纯文本模型后发图就是这个）。
- 只有附件、没有文本也算有效 prompt（`content` 里 image/file 至少一个即可）。

## 9. 文件上传：`POST /api/session/uploadFileBinary`

```
POST /api/session/uploadFileBinary?sessionId=<id>&name=<urlencoded>
content-type: application/octet-stream
<原始字节>
```

返回：

```json
{ "ok": true, "value": { "receiptId": "<uuid>", "file": { "attachmentId": "sha256:…", "name": "fault.log", "bytes": 66042 } } }
```

- 走的是 Connection 的 fetch 路由（**不是** `/api/<ns>/<method>` 的 typed RPC），body 是原始字节，
  所以用 XHR/fetch 直传，不要包 JSON。
- 不收 `content-type: application/json`；传错会 415。
- receiptId 属于**那个会话**，只能在该会话的 prompt 里引用。

## 10. 模型目录与切换

| 方法 | payload.args | 返回 |
|---|---|---|
| `session/modelCatalog` | `{}`（**没有 request 字段**） | `{default:{provider,model,reasoningEffort?}, routableProviders:[], groups:[{id,name,models:[{id,name,description?,reasoning?:{efforts:[{id,name}],defaultEffort?}}]}], failures:[]}` |
| `session/selectModel` | `{request:{sessionId, provider, model, reasoningEffort?}}` | `{selected:{provider,model,reasoningEffort?}}` |

⚠️ 两个坑（都实测踩过）：
1. `modelCatalog` 没有参数 → `payload.args` 是 `{}`，**不要**套 `{request:{}}`；
2. `groups[].id` 是 **provider id**，具体的模型在 `groups[].models[].id`；
   chips 上显示的是短名，**切模型时不能用它当 id**（必须记投影里的 `modelSelection.model`）。
3. `selectModel` 同时会把选择存成**全局默认**（`agentDefaultModel.saveSelection`），
   所以测试用例里切模型要放在"发附件"之后，否则新会话会继承纯文本模型、发图被拒。

## 11. 我们自己的接口（手机端读侧）

| 路径 | 用途 |
|---|---|
| `GET /mobile/api/chat?id=` | 聊天全文 + 附件元数据（增量解析事件日志；SSE 的 `chat` 事件同源） |
| `GET /mobile/api/attachment?sid=&id=` | 附件字节（**只允许该会话日志引用过的 attachmentId**；图片给 `<img>` 直接开） |
| `GET /mobile/api/approvals?sid=` | 待审批列表 |
| `POST /mobile/api/approval/answer` | `{id, outcome:"allowed-once"\|"rejected"}` |
| `GET /mobile/api/stream?id=` | SSE：`chat`（首帧全量、之后增量）+ `turns` + `approval` |
