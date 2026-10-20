# 深鲸桌面端 · 仓库级约束（AGENTS.md）

> 本文件跟着代码进 git，是**仓库级**约束，优先级高于跨产品级的 `ui-standards` skill。
> 两者冲突时以本文件的**更具体要求**为准，但**不得放宽 skill 的硬性条款**。

---

## 一、为什么有这份文件（2026-10-11）

涉外法规模块的筛选区被反馈：**「按钮一大堆，排列不规则而且没有对应间距」**。

复查后发现的不是一处疏漏，而是**同一套坏模式在多个模块各自复现**：

| 坏模式 | 出现位置 | 后果 |
|---|---|---|
| `margin-left:auto` 把按钮/日期推到右侧 | intl-kb、intl-compliance、workbench 表格 | 容器一 `flex-wrap`，该项换行时跳到奇怪位置 |
| 标签与 chip 同级塞进一个 `flex-wrap` 容器 | intl-kb 筛选区 | chip 换行后从容器左边缘续行，跑到标签下面 |
| `gap:6px` / `gap:7px`（低于规范的 8px） | 全项目 14 处 | 按钮挤在一起 |
| `.intl-chip` 样式在 5 个 js 文件里各写一遍 | intl-kb/docs/arb/compliance/gba | 定义不一致；且实际高度约 27px，低于 32px |
| `justify-content:space-between` + `flex-wrap` | `.card .card-head`（83 处调用） | 换行后第二行子项被拉开；单项独占一行时对不齐 |

**根因是流程问题**：只给了语法约束，没给布局约束；模块由不同会话分别实现，各自发明了同一种坏模式。

---

## 二、硬性布局条款（违反即缺陷）

### 2.1 禁止用 `margin-left:auto` 推右侧

```html
<!-- ❌ 禁止：容器一 wrap，这项就跳位 -->
<div style="display:flex;flex-wrap:wrap;gap:8px">
  标题 <span style="margin-left:auto">日期</span>
</div>

<!-- ✅ 正确：标题 flex:1 撑开把右侧顶过去，右侧项用 flex:0 0 auto -->
<div class="card-title-row">
  <span class="ctr-title">标题（flex:1 + 省略）</span>
  <span class="ctr-date">日期（flex:0 0 auto）</span>
</div>
```

已备好的类：`.card-title-row` / `.ctr-title` / `.ctr-date` / `.card-meta` / `.card-tags` / `.card-actions`。

### 2.2 徽标往上走，按钮往下走，两者永不同排

**标准卡片结构**（`ui-standards` 同款）：

```
┌─ 卡片 ─────────────────────────────┐
│ 标题（flex:1 + 省略）        徽标 日期 │  ← .card-title-row
│ 来源徽标 + 元信息（单行省略）          │  ← .card-meta
│ 摘要/正文（可展开）                   │
│ [标签] [标签]                        │  ← .card-tags（8px wrap）
│ [主动作] [次动作] [删除]              │  ← .card-actions（左对齐、8px wrap）
└────────────────────────────────────┘
```

### 2.3 过滤器分组用 `.filter-row`

```html
<div class="filter-row">
  <span class="filter-label">法域</span>      <!-- 固定宽度成列 -->
  <div class="filter-chips">…chips…</div>     <!-- 独立区域换行，续行与首个 chip 对齐 -->
</div>
```

**不要**把标签和 chip 当同级子元素塞进同一个 wrap 容器。

### 2.4 尺寸（与 `ui-standards` 一致，Web 值）

| 项 | 值 |
|---|---|
| 可点元素最小高度 | **≥ 32px**（`.intl-chip` / `.doc-chip` 已用 `min-height` 兜底）|
| 相邻可点元素水平间距 | **≥ 8px** |
| 卡片圆角 / 胶囊标签圆角 | 12px / 999px |
| 页面左右边距 | 16px |

`gap:6px` 只允许出现在**非可点元素**之间（复选框与文字、图例图标与文字、装饰点）。

### 2.5 颜色

一律用 CSS 变量（`var(--text)` / `var(--accent)` …），不写死色值。

---

## 三、样式单一来源

- **`.intl-chip` 定义在 `css/components.css`**，不要在 js 文件里内联重复（历史上 5 份）。
- 组件级样式进 `css/components.css`；页面级进 `css/workbench.css`。
- 改完 CSS / JS 记得 bump `index.html` 里的 `?v=` 缓存版本号。

---

## 四、完工前必跑

```bash
bash ~/.dsh/skills/ui-standards/scan.sh --dir /Users/mac/dsh-desktop/lawyer
```

退出码 `0` = 无命中。**必须改 0 处**才算完工。

另外自查两项（扫描脚本不覆盖）：

```bash
# 危险写法应为 0 处（注释除外）
grep -rn "margin-left:auto" lawyer/workbench/js/*.js | grep -v "^\S*:[0-9]*: *//"

# flex-wrap 容器的 gap 不应 < 8px（非可点元素除外）
grep -rnE 'flex-wrap[^"]*"' lawyer/workbench/js/*.js
```

---

## 五、真机/真窗口验收

- 浏览器**缩到 375px 宽**看一遍（窄屏优先）
- **深浅色各看一眼**
- 长文案 / 空数据 / 超长列表三种情况各看一眼
- 长文本一律 `maxLines` + `text-overflow: ellipsis`，**不要指望它自己会省略**

---

## 六、辉光 / 模糊效果（2026-10-11 补，踩过两次）

### 6.1 不要用 background-image 的径向渐变「近似」模糊

**要的是「三团化开的光」，写成多层渐变会变成「三个彩色圆盘」。**

```css
/* ❌ 错：多层 background-image 径向渐变 —— 出来是三个边界分明的圆盘 */
#glow { background-image: radial-gradient(...), radial-gradient(...); }

/* ✅ 对：真 DOM 元素 + 各自 filter: blur() + mix-blend-mode: screen */
.blob { position: absolute; mix-blend-mode: screen; }
.blob.b1 { filter: blur(80px);  }
.blob.b2 { filter: blur(100px); }
.blob.b3 { filter: blur(60px);  }
```

**为什么**：`filter` 是**整体**作用于元素的。一个伪元素里塞三层就只能共用一个模糊值，
而正确的三层是 **80 / 100 / 60** —— 不同模糊半径叠起来才是「光」，同一个值出来是「盘」。

**桌面端壳**之所以用渐变图层，是被逼的：它的壳里「插 DOM + z-index:-1」在 1.0.28 后静默失效，
只能把光挂到 `html` 的 background 上（那里没法给单个图层加 blur）。
**律师端没有这个限制**（`#wallpaper-glow` 是自有元素，z-index 可控）—— 所以用原版实现。

### 6.2 验收标准：采样相邻像素，不能有突变

改完**必须采样**验证，不能只看截图「感觉还行」：

```python
# 沿一条横穿光斑的线每 100px 取一个点，看相邻跳变
# 跳变(RGB 之和) < 30 = 平滑；> 60 = 还能看出色块边界
```

2026-10-11 实测：渐变写法跳到 **>120**（三个色块）；blur 写法 **≤7**（无缝）。

### 6.3 深色背景不要用中性近黑

背景底色要**带蓝**（`#0b1018`），不能是中性黑。原因见 `dsh-desktop/src/main/skin-presets.ts` 的注释：

> 深色用中性黑时，颜色**全靠辉光提供**，而辉光又被面板压掉大半 —— 结果就是一片死黑。
> 带蓝的底色让深色也自带「深蓝」基调，辉光只负责亮度层次。

同时**背景必须比卡片暗**（明暗层级：页面 < 卡片）。灰调壁纸在深色下要压得够暗，
否则会「只有模块是黑的、背景一片灰」。

### 6.4 浅色主题**不能用 `mix-blend-mode: screen`**

screen 的语义是「越叠越亮」。浅底 `#eaf1fb` 已接近白，再 screen 一层浅蓝 → **直接洗成白**，
实测等于「没有辉光」。浅色用 `normal`（普通叠加），深色才用 `screen`。

### 6.5 坐标要按**本产品的页面密度**定，不要照搬

桌面端壳的辉光锚在固定 `top:430px`，那是给**大片空白的聊天界面**调的。
照搬到律师端 → 光心算出来在 `y≈760`，在 700~800px 高的窗口里**直接落到屏幕外**。
密集卡片页要用视口相对定位（`top:6vh` 这种），把光心放进可视区。

### 6.6 卡片**必须保持实心** —— 玻璃卡片已被用户否决（2026-10-11）

页面 100% 是卡片时，**不透明卡在数学上会把背景光完全挡住**。曾经试过玻璃卡片：

```css
/* ❌ 已否决，不要重试 */
[data-bg="glow"] .card {
  background: color-mix(in srgb, var(--surface) 58%, transparent);
  backdrop-filter: blur(16px) saturate(125%);
}
```

实测光确实可见了（卡内 `#23262d` → `#19202d`），但**用户明确否决**，理由成立、优先级更高：

> 「卡片不能改，改了就会出大问题了，**版面不清晰，律师实际使用体验感就会极差**」

**律师端的首要目标是把案子看清楚，不是视觉花哨。** 任何以牺牲卡片清晰度为代价的"好看"都不要做。

**接受的代价**：背景辉光只在**卡片之外的区域**可见（页头、页边、卡片间隙）。
2026-10-11 实测该状态下的可见度：
```
页头        #0e1623   蓝偏 +21   ← 可见
卡片行间隙  #182d4b   蓝偏 +51   ← 明显
卡内        #23262d   蓝偏 +10   ← 实心（不受影响）
```
**这是可接受的**，不要为了"让光更明显"再去动卡片。

## 七、版本更新说明（whatsnew）写法（2026-10-20 定，用户第二次纠正）

「本版更新内容」/ `assets/whatsnew.json` 的每一条**只写「增加了什么」**：

- ✅ 写：用户能感知的新功能（新能力、新面板、新内容）
- ❌ 不写：bug 修复项、运行时升级这类技术说明、计费规则/内部备忘、给维护者自己看的话
- 发布前检查：把 `items` 逐条问一遍「这是新增能力吗」，不是就删

> 用户原话：「那些有的没的怎么都往里面写呢，我们只需要写增加的东西就 ok 了，自己给自己说的不需要写的。」
