# 安装包分发改造：OBS + CDN 落地指引

> 本文记录「把安装包从自建 ECS 迁到华为云 OBS + CDN」的完整步骤。
> 需要你在华为云控制台操作的部分标了 **[你做]**，我这边能做的标了 **[我做]**。

---

## 一、为什么要做（实测数据，不是猜的）

2026-09-26 发布 v1.0.17 时实测：

| 环节 | 实测结果 | 瓶颈 |
|---|---|---|
| GitHub Actions(美国) → ECS 上传 | 0.19–1.0 MB/s，**1.96 GB 用了约 93 分钟** | 国际链路 |
| 本机(国内) → ECS 上传 | ~0.9 MB/s | 上行带宽 |
| ECS → 用户下载 | ~13 MB/s | ECS 公网带宽（**要花钱买**） |

结论：
1. **上传慢**不是 VPN 的问题。CI 跑在 GitHub 美国机房，到国内服务器这条国际链路本身就慢且丢包，换上传来源救不了（本机直传实测一样慢）。
2. **下载带宽**全部由这一台 ECS 承担，用户越多越贵，且突发型实例 `t7.large.1` 有带宽上限。
3. 现在每次发版要传约 1.4 GB（已排除桌面端 .zip），**每次都要等一小时以上**。

---

## 二、改造后的架构

```
现在：  GitHub Release ──(慢, 90min)──> ECS /var/www/.../downloads ──> 用户(带宽自购)

改造后：GitHub Release ──> OBS 桶 ──> CDN 边缘节点 ──> 用户(就近, 快)
                          ↑ 分片并发上传，不再受单连接限制
```

关键收益：
- **上传**：OBS 支持分片并发上传（`obsutil` 默认多线程），能绕开单连接的国际链路瓶颈
- **下载**：CDN 就近分发，不用再为 ECS 买大带宽
- **成本**：OBS 存储 + CDN 流量，通常比一直占着一台高带宽 ECS 便宜

---

## 三、你在华为云控制台要做的（5 步）

### 步骤 1 **[你做]** 开通 OBS 并建桶

1. 控制台搜索「对象存储 OBS」→ 开通（按量付费）
2. 创建桶：
   - **区域**：`华北-北京四 (cn-north-4)`（或离你用户近的；**选定后不能改**）
   - **桶名**：`deepwhale-downloads`
   - **存储类别**：标准存储
   - **访问权限**：**私有**（推荐 —— 对外统一走 CDN，桶本身不直接暴露）
   - 其他保持默认

> 为什么用私有桶：CDN 回源时用 OBS 的私有回源鉴权，桶不直接暴露公网，
> 也避免有人绕过 CDN 直连桶产生额外流量费。

### 步骤 2 **[你做]** 建一个只能写这个桶的子账号（拿 AK/SK）

**不要用主账号的 AK/SK**（主账号密钥泄露=整个云账号失守）。

1. 控制台 →「统一身份认证 IAM」→ 用户 → 创建用户
   - 用户名：`ci-uploader`
   - 访问方式：**编程访问**（勾选，会生成 AK/SK）
2. 给这个用户授权：**只给 OBS 相关权限**，最小可用即可
   - 推荐：创建自定义策略，只允许 `obs:object:PutObject` / `obs:object:GetObject` /
     `obs:bucket:ListBucket`，资源限定到 `deepwhale-downloads`
   - 省事但权限偏大：直接给系统策略 `OBS OperateAccess`
3. **记下 AK / SK**（只显示一次），先别贴到聊天里 —— 第 5 步直接存进 GitHub Secrets

### 步骤 3 **[你做]** 开通 CDN 并添加加速域名

1. 控制台搜索「内容分发网络 CDN」→ 开通
2. 添加域名：
   - **加速域名**：`dl.deepwhale.org.cn`
   - **业务类型**：**文件下载加速**
   - **源站类型**：**OBS 桶** → 选 `deepwhale-downloads`（区域选你在步骤 1 选的）
   - **加速区域**：中国大陆
   - **回源鉴权**：开启（对应私有桶）
3. 记下 CDN 分配的 **CNAME 地址**（形如 `xxx.cdnhwc1.com`）

### 步骤 4 **[你做]** 配 HTTPS 证书 + DNS

1. CDN 域名 → HTTPS 配置 → 申请**免费证书**（或上传你已有的 `deepwhale.org.cn` 证书）
2. 到域名 DNS 处添加记录：

   | 类型 | 主机记录 | 记录值 |
   |---|---|---|
   | CNAME | `dl` | 步骤 3 拿到的 CNAME |

3. 等生效后验证：

   ```bash
   curl -I https://dl.deepwhale.org.cn/
   ```

### 步骤 5 **[你做]** 把 AK/SK 存进 GitHub Secrets

仓库 → Settings → Secrets and variables → Actions → New repository secret，加两个：

| 名称 | 值 |
|---|---|
| `OBS_AK` | 步骤 2 的 Access Key |
| `OBS_SK` | 步骤 2 的 Secret Key |

再推荐加两个（方便我改脚本时不用改代码）：

| 名称 | 值 |
|---|---|
| `OBS_BUCKET` | `deepwhale-downloads` |
| `OBS_ENDPOINT` | `obs.cn-north-4.myhuaweicloud.com`（按你选的区域改） |

---

## 四、我这边要做的（等你上面 5 步做完）

1. **[已就绪]** `scripts/sync-to-obs.js` —— OBS 分片并发上传，替代现在的 `scp` 循环。
   它自带的过滤规则与官网约定一致（排除桌面端 `.zip` / `.blockmap` / `latest*.yml`，
   保留律师端与套装的 `.zip`），AK/SK 只从环境变量读。
   桶建好后可以直接验证：

   ```bash
   OBS_AK=... OBS_SK=... OBS_BUCKET=deepwhale-downloads \
   OBS_ENDPOINT=obs.cn-north-4.myhuaweicloud.com \
   node scripts/sync-to-obs.js --dir dist-assets --dry-run   # 先看清单
   ```
2. **[待做]** 改 `release.yml` 与 `sync-downloads.yml`：上传目标从 ECS 换成 OBS
3. **[待做]** 两个官网的下载链接从 `/downloads/xxx` 换成 `https://dl.deepwhale.org.cn/xxx`
   - Pages 站（`docs/index.html`）：走的是 GitHub Release，**不动**
   - 主站（`deepwhale.org.cn`）：`download.html` + `assets/site.js`
4. **[待做]** 首次全量迁移：把现有 `/downloads/` 里的包一次性灌进 OBS
5. **[待做]** 保留 ECS 上的 downloads 目录作为回退，确认 CDN 稳定后再考虑清掉

---

## 五、验收标准

改造完成的判定（缺一不可）：

- [ ] `https://dl.deepwhale.org.cn/DeepWhale-Desktop-1.0.17-arm64.dmg` 返回 200
- [ ] 该域名证书有效、无混合内容告警
- [ ] 主站首页与下载页上的**每一个**下载链接都指向 CDN 且返回 200
- [ ] 从国内直接下载实测速度 **≥ 5 MB/s**（现在 ECS 直连约 13 MB/s，CDN 应不低于此）
- [ ] 一次 CI 上传（约 1.4 GB）**耗时 < 15 分钟**
- [ ] 回退路径可用：ECS 上的旧链接仍然能下（至少保留一个版本周期）

---

## 六、风险与注意事项

- **区域选定不可改**：OBS 桶的区域一旦创建不能迁移，只能重建。选之前确认好。
- **AK/SK 只存 GitHub Secrets**：不要写进仓库、不要贴聊天、不要放进脚本。
  子账号权限要限死在 `deepwhale-downloads` 这一个桶上。
- **CDN 缓存刷新**：发新版后旧文件一般不需要刷（文件名带版本号）。
  但如果同名文件被替换（例如 `latest.yml`），需要在 CDN 控制台刷新。
- **费用**：OBS 存储 + CDN 流量按量计费。当前下载包合计约 5 GB，
  建议先在控制台开「费用预警」，避免意外。
- **备案**：CDN 加速域名若在中国大陆，**域名必须已完成 ICP 备案**。
  `deepwhale.org.cn` 已备案，其子域 `dl.deepwhale.org.cn` 可以直接用。

---

## 七、当前进度（2026-09-26 完成）

- [x] OBS 桶 `deepwhale-downloads`（华东-上海一 / 私有 / 单AZ）
- [x] 子账号 `ci-uploader` + AK/SK，经用户组 `obs-uploaders` 授权
- [x] OBS 上传策略（仅限该桶）与 CDN 证书策略 `deepwhale-cdn-cert`（仅查+改证书，无删除权）
- [x] GitHub Secrets：`OBS_AK` / `OBS_SK` / `OBS_BUCKET` / `OBS_ENDPOINT`
- [x] 上传链路实测：**13.43 MB/s**（旧 scp 链路 0.19–1.0 MB/s，1.96 GB 需 93 分钟）
- [x] CDN 加速域名 `dl.deepwhale.org.cn`（文件下载加速 / 私有桶回源鉴权 / CNAME 已生效）
- [x] **HTTPS 全自动**：Let's Encrypt 签发并推送到 CDN，有效至 2026-12-25，系统信任链验证通过

### 唯一待办：给桶加一条生命周期规则

自动续期时会把验证文件放到 `.well-known/acme-challenge/` 前缀下。CI 凭据**故意没有删除权限**（给 CI 删除权 = 凭据泄露就能清空整个下载桶），所以这些 43 字节的小文件不会被脚本清掉。

请在 OBS 控制台给桶加一条生命周期规则，自动清理：

**OBS → 桶 `deepwhale-downloads` → 生命周期 → 创建规则**
- 适用范围：**按前缀** → `.well-known/acme-challenge/`
- 过期删除：**1 天**
- 其余默认

这样每年约 6 个验证文件会自动消失，且不需要给 CI 任何删除权限。

> 不做也不影响功能 —— 一年也就几十个 43 字节的文件。但加上更干净。
