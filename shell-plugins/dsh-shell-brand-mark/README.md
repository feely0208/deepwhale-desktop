# dsh-shell-brand-mark · 空白会话的品牌标记

> 把空白会话顶部那个通用圆标换成**青色大肥鱼** —— 与首次启动面板、更新弹窗、桌面宠物统一视觉。

用户原话（2026-10-04）：

> 「新版本刚安装好第一次打开的面板上面的鲸鱼也用我们的青色大肥鱼吧，这样统一一下」

## 怎么做

| 层 | 做什么 |
|---|---|
| 宿主半边 | **空实现**，但必须是 `name` + `apply()` 的最小 cordis 插件形态（见下） |
| 客户端半边 | 占掉插槽 `conversation.hero.brand.mark`（single / root），渲染大肥鱼 |

### ⚠️ 为什么宿主半边不能只导出 `name`

`@deepseek-ai/dsh-client-modules` 只扫描**活动 loader 行**对应的包。
只导出 `name` 的模块挂不成 cordis 插件 → `dsh.client` 声明不会被扫到 →
客户端半边不下发 → **页面上什么都不变，而且没有任何报错**。
这个是排查起来最费时间的一类（安静地不生效）。

### 为什么图片要内联成 data URI

客户端插件跑在 DSH 页面里，**读不到本地文件**。
所以 `assets/brand/whale-mark-small.png`（109×88）在生成 `lib/client.js` 时内联进去。

冒烟断言正是查这个：`[data-dsh-brand-mark]` 下的 `<img>`，src 必须以 `data:image/png` 开头。

### 素材与再生成

- 源图：`assets/brand/whale-mark-small.png`（取自宠物精灵图 idle 首帧）
- 包内副本：`whale.png`（同时用作插件卡片图标 —— 图标路径不允许指向包外，所以必须拷一份）
- 换图之后要**重新生成 `lib/client.js` 里的 data URI**（把 PNG 重新 base64 内联）

## 验证

```bash
npm run smoke
```
冒烟里会断言：boot 列表含 `dsh-shell-brand-mark`、`[data-dsh-brand-mark]` 存在、
其中的 `<img>` 是 `data:image/png` 且已解码出宽度。
