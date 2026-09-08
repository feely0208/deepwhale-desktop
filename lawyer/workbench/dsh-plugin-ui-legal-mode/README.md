# DSH 法律模式插件源码快照（2026-08-26）

运行位置：`~/deepseek-harness/packages/client/ui-legal-mode/`
本目录为**只读快照**（防丢失），改动请到运行位置修改后重新 tsc/tsdown 构建。

## 修复记录（2026-08-26）
「切走再切回不自动弹出」bug：`check()` 原只用 `shown` 一次性标志，
改为边沿检测 `prevSessionHit`/`prevDefaultHit`，从非法律模式重新进入时重新弹出。
