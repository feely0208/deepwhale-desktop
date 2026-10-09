# 深鲸画布 · 模板规范 v1（spec v1）

> 状态：**S0 冻结草案**（2026-10-07）
> 本目录是规范的**唯一事实来源**。引擎、领域包、模板市场、审核 skill 全部以这里的 Schema 为准。
> 对外许可：**Apache-2.0**（规范与校验器开源；引擎与领域包闭源）

---

## 0. 一句话

**模板是数据，不是代码。** 模板只能引用「领域包」声明的**白名单**（节点类型、动效、字体 ID、音频台账 ID），
平台与引擎负责校验与渲染；模板**永远不能**内联脚本、引用外链、或携带字体文件。

---

## 1. 三份文件

| 文件 | 作用 |
|---|---|
| `document.schema.json` | **模板（CanvasDocument）** 的结构约束 |
| `domain-pack.schema.json` | **领域包（DomainPack）** 的结构约束 |
| `README.md`（本文） | 语义说明：字段含义、硬规则、错误码 |

一个模板 = 一个 JSON 文件（`template.json`）。打包上架时另含 `assets/`、`author.json`、`LICENSE`。

---

## 2. CanvasDocument 字段

```jsonc
{
  "spec": 1,                       // 规范版本，必须是 1（未来升级由 migrate 工具处理）
  "domain": "video",               // 领域 ID；引擎按领域包注册表查，找不到即拒
  "domainVersion": "1.0.0",        // 依赖的领域包版本
  "canvas": {
    "units": "px",                 // px | mm | pt（打印类领域用 mm/pt）
    "w": 1080, "h": 1920,
    "fps": 30, "frames": 900,      // 时序领域才有；静态领域不写
    "preset": "竖版 1080x1920",     // 声明使用领域包里的哪个预设
    "safeArea": { "bottom": 320 }  // 平台 UI 遮挡区，必须给元素让位
    ,"background": "#000000"      // 画布底色（可选）
  },
  "vars":    [ /* 变量定义：用户或模型填写 */ ],
  "nodes":   [ /* 节点树：类型必须在领域包白名单内 */ ],
  "timeline":[ /* 时间轴：帧号 + 动效白名单；静态领域可省略 */ ],
  "resources":[ /* 素材引用：只允许包内相对路径 或 用户注入槽位 */ ],
  "meta":    { "id": "...", "name": "...", "author": "...", "license": "..." }
}
```

**`timeline` 的可见性语义**（2026-10-07 修正）：
- `f < from` → 隐藏（还没入场）
- `from ≤ f ≤ to` → 播放动画
- `f > to` → **默认保持终态（留在场上）**；要"来了又走"就写 `"hold": false`

**时间：人写秒、内核认帧。** 模板里 `timeline[].from/to` 一律是**帧号**；
作者在文档/UI 上写的是秒（`"0-3s"`），由**领域包**在解析时换算。这样静态领域（没有 fps）不必背时间模型。

---

## 3. 八条硬规则（校验器强制，违反即 error）

| # | 规则 | 错误码 |
|---|---|---|
| 1 | 不得出现 `script` / `eval` / `Function` / `on*` 等可执行键；字符串不得含 `<script` / `javascript:` | `E_FORBIDDEN_KEY` |
| 2 | 不得出现外链（`http(s)://`、`//`、`ftp://`、`data:`）；素材只能是包内路径或用户槽位 | `E_EXTERNAL_URL` |
| 3 | 画布尺寸 / 帧率 / 帧数不得超过领域包预设上限 | `E_CANVAS_LIMIT` |
| 4 | 节点 `type` 必须在领域包 `nodes` 白名单内 | `E_NODE_TYPE_UNKNOWN` |
| 5 | 动效 `name` 必须在领域包 `animations` 白名单内 | `E_ANIM_UNKNOWN` |
| 6 | 素材声明体积合计不得超过领域包上限 | `E_RESOURCE_TOO_LARGE` |
| 7 | 引用未在 `vars` 中定义的变量 | `E_VAR_UNDEFINED` |
| 8 | 节点总数 / 嵌套深度超限 | `E_NODE_COUNT_LIMIT` / `E_DEPTH_LIMIT` |

**另外两条（产品决策，S0 一并实现）**：

| # | 规则 | 错误码 |
|---|---|---|
| 9 | 字体只能引用领域包 `fonts` 白名单里的**字体 ID**（不允许写字体名，不允许包内带字体文件） | `E_FONT_NOT_WHITELISTED` |
| 10 | 音频只能引用 `bgmRegistry` 台账里已入库的 ID | `E_BGM_NOT_IN_REGISTRY` |

---

## 4. 素材引用（`resources`）

```jsonc
{ "kind": "pack", "path": "assets/intro.webp", "sha256": "...", "bytes": 123456 }   // 包内资产（审核时连素材一起审）
{ "kind": "user", "slot": "shot-1", "bytes": 0 }                                    // 用户注入（本地素材库，不上传）
```

- `kind: "pack"` 的 `path` 必须是**包内相对路径**，不允许 `..` 逃逸；
- `kind: "user"` 的 `slot` 由模板声明，渲染时由用户从**本地素材库**挑选（模板只记素材 ID，不记路径）。

---

## 5. 领域包（DomainPack）

```jsonc
{
  "domain": "video",
  "version": "1.0.0",
  "engineRange": ">=1.0.0 <2",       // 语义化版本约束：领域包不能跑到引擎前面
  "canvas": { "units": "px", "presets": [ /* 预设 + 上限 */ ] },
  "nodes": [ { "type": "text", "propsSchema": "./schema/node-text.json" } ],
  "animations": [ { "name": "slide-up" } ],
  "fonts": [ { "id": "source-han-sans", "name": "思源黑体", "license": "OFL-1.1" } ],
  "constraints": { "maxNodes": 2000, "maxDepth": 12, "maxResourceMB": 500, "allowExternalUrl": false, "requireAiLabel": true },
  "adapters": ["html"],
  "bgmRegistry": "./bgm-registry.json",
  "tools": [ { "name": "canvas_video_render" } ]
}
```

**加一个领域 = 加一个包，内核不动。** 领域包是唯一能"加能力"的地方。

---

## 6. 错误码表

| 错误码 | 级别 | 含义 |
|---|---|---|
| `E_SPEC_MISSING` / `E_SPEC_UNSUPPORTED` | error | 没有 `spec` 或版本不是 1 |
| `E_DOMAIN_UNKNOWN` | error | 领域包注册表里没有该 `domain` |
| `E_DOMAIN_VERSION_MISMATCH` | error | `domainVersion` 与已加载领域包版本不一致 |
| `E_SCHEMA_INVALID` | error | 结构不符合 JSON Schema（带字段路径） |
| `E_FORBIDDEN_KEY` | error | 出现可执行键/危险字符串 |
| `E_EXTERNAL_URL` | error | 出现外链 |
| `E_RESOURCE_PATH_ESCAPE` | error | 包内素材路径逃逸（`..`） |
| `E_CANVAS_LIMIT` | error | 超出预设上限 |
| `E_NODE_TYPE_UNKNOWN` | error | 节点类型不在白名单 |
| `E_ANIM_UNKNOWN` | error | 动效不在白名单 |
| `E_RESOURCE_TOO_LARGE` | error | 素材体积合计超限 |
| `E_VAR_UNDEFINED` | error | 引用了未定义的变量 |
| `E_TIMELINE_NODE_UNKNOWN` | error | 时间轴引用了不存在的节点 |
| `E_TIMELINE_RANGE` | error | 时间轴 `to` 不大于 `from` |
| `E_NODE_COUNT_LIMIT` | error | 节点数超限 |
| `E_DEPTH_LIMIT` | error | 嵌套深度超限 |
| `E_FONT_NOT_WHITELISTED` | error | 字体不在白名单 |
| `E_BGM_NOT_IN_REGISTRY` | error | 音频不在入库台账 |
| `W_AI_LABEL_REQUIRED` | warn | 领域包要求 AI 标识，模板未声明 |

---

## 7. 版本与兼容

- **`spec` 一旦为 1，就长期不变**；未来变更走 `spec: 2` + `canvas migrate`；
- 领域包通过 `engineRange` 约束引擎版本；引擎不满足即**拒绝加载**并给出人话提示；
- **兼容承诺**：`spec v1` 至少跨 N 个大版本兼容（N 在引擎发版策略中定义），老模板**不会因为引擎升级而失效**。
