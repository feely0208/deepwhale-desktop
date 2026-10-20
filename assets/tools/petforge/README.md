# 一句话生成桌宠（petforge）

用你**自己的**图像生成模型 API，把你想要的样子变成桌面宠物。

> ⚠️ 本项目不提供 AI 算力，你需要自备一个支持**图像生成**的 API Key。
> ⚠️ DeepSeek 系列模型（含 V4.1-Flash 等）是文本/视觉理解模型，**不具备图像生成能力**，
>    需要单独申请下面任一家的生图服务。

## 文件在哪

| 环境 | 路径 |
|---|---|
| 已安装的 App | `/Applications/DeepWhale Desktop.app/Contents/Resources/tools/petforge/` |
| 源码仓库 | `assets/tools/petforge/` |

## 三步上手

### 1. 准备 Python

macOS 包内自带 Python + Pillow，直接用：

```bash
PY="/Applications/DeepWhale Desktop.app/Contents/Resources/office-runtime/dependencies/python/bin/python3"
```

用系统 Python 的话先装依赖：`python3 -m pip install pillow`

### 2. 配一次 API Key（以后不用再配）

```bash
echo '{"provider":"dashscope","api_key":"sk-你的key"}' > ~/.petforge.json
```

可选 provider（均为 OpenAI 兼容的 `/images/generations`）：

| provider | 服务 | 默认模型 |
|---|---|---|
| `agnes` | Agnes | agnes-image-2.5-flash |
| `dashscope` | 阿里云通义万相 | wanx2.1-t2i-turbo |
| `doubao` | 火山引擎豆包 | doubao-seedream-3-0 |
| `zhipu` | 智谱 | cogview-3-flash |
| `siliconflow` | 硅基流动 | Kolors |
| `openai` | OpenAI | gpt-image-1 |

也可以用 `--base-url` / `--model` 指定任意 OpenAI 兼容接口。

### 3. 一句话生成

```bash
cd "/Applications/DeepWhale Desktop.app/Contents/Resources/tools/petforge"
"$PY" petforge.py "一只穿法袍戴眼镜的熊猫，抱着一摞卷宗" --name 熊猫律助 --style lawyer
```

生成完直接出现在「设置 → 宠物」列表里。

## 参数

| 参数 | 说明 |
|---|---|
| `--name` | 宠物名（默认取描述前 8 个字） |
| `--style` | 动作风格：`generic` `lawyer` `judge` `prosecutor` `bailiff` `forensic` `clerk` `chef` |
| `--provider` | 图像接口预设（见上表） |
| `--api-key` | 临时指定 Key（也可用环境变量 `PETFORGE_API_KEY`） |
| `--model` / `--base-url` | 自定义接口 |
| `--out` | 只输出到目录，不自动安装 |

## 每个宠物能做什么

生成出来的宠物自动带 **18 种动作 / 105 帧**：

`idle` 待机 · `waving` 打招呼 · `jumping` 跳跃 · `dash` 冲刺 · `flip` 转身 ·
`ball` · `swimming` · `diving` · `standing` 站定 · `look` 环顾 · `review` 审阅 ·
`sleeping` 睡觉 · `walking` / `jogging` / `fast-running` 左右三档移动

不同 `--style` 会让同一套动作表达不同气质（法官慢而稳、法警干脆利落、厨师颠勺弹跳）。

## 出图效果建议

描述里包含这些能显著提高可用率（程序会自动补一部分）：

- **纯绿色背景**（靠色键抠图，其它背景抠不干净）
- 正面站立、全身、居中
- 卡通 Q 版风格、线条干净
- 不要复杂场景、不要文字

## 常见问题

**Q：报错「缺少图像生成 API Key」**
按第 2 步配一次，或命令里加 `--api-key sk-xxx`。

**Q：生成的图抠不干净 / 有绿色残留**
换一句话强调「纯绿色纯色背景」，或换一个生图模型试试。

**Q：宠物列表变长了，设置页挤**
把不用的宠物目录从宠物文件夹里移走即可（「设置 → 宠物 → 打开文件夹」）。
