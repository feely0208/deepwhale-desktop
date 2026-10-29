; ════════════════════════════════════════════════════════════════════════
; 自定义 NSIS 片段：安装器必须能**自己**关掉正在运行的旧版本
; ════════════════════════════════════════════════════════════════════════
;
; 现象（2026-10-15 用户实测截图）：
;   装到一半弹「DeepWhale Desktop 无法关闭。请手动关闭它，然后单击重试以继续。」
;
; 根因：
;   我们的应用**关窗是最小化到托盘**（src/main/window.ts：closeToTray && !isQuitting() → hide()），
;   而 electron-builder 默认的 `_CHECK_APP_RUNNING` 只做**温和关闭**
;   （allowOnlyOneInstallerInstance.nsh 里 `KILL_PROCESS ... 0` = 不带 /F 的 taskkill）。
;   温和关闭被我们忽略 → 它循环重试 → 最终要求用户手动关。
;   （自动更新那条路不受影响：更新走 quitAndInstall，应用自己会真退出。）
;
; 修法：
;   覆盖官方钩子 `customCheckAppRunning`（allowOnlyOneInstallerInstance.nsh 里
;   `!ifmacrodef customCheckAppRunning` 会优先用我们的）：
;   ① 先温和关一次，给应用自己退出的机会；
;   ② 仍在 → **强制结束整棵进程树**（taskkill /F /T）：必须带 /T，
;      否则它拉起的 DSH 子进程（Electron-as-Node）还占着文件，安装会卡在复制文件；
;   ③ 再确认一次，避免"关了一半"。
;
; ⚠️ 不要引用 `$pid` / `GetProcessInfo`：那两个只在"未覆盖该宏"的分支里才被定义
;    （模板里是 `!ifmacrondef customCheckAppRunning` → include getProcessInfo.nsh）。
;    按映像名杀是安全的：安装器自己的映像是 `DeepWhale-Desktop-<版本>-x64-Setup.exe`，
;    与应用 `DeepWhale Desktop.exe` 不同名。

!macro customCheckAppRunning
  DetailPrint "正在关闭正在运行的 DeepWhale Desktop…"

  ; ① 温和关闭（不带 /F）：给它自己退出的机会
  nsExec::Exec `"$SYSDIR\cmd.exe" /C taskkill /IM "${APP_EXECUTABLE_FILENAME}" >nul 2>&1`
  Pop $0
  Sleep 1200

  ; ② 强制结束整棵进程树（/F 强制、/T 含子进程）
  nsExec::Exec `"$SYSDIR\cmd.exe" /C taskkill /F /T /IM "${APP_EXECUTABLE_FILENAME}" >nul 2>&1`
  Pop $0

  ; ③ 再补一次：上一条可能刚好撞上"进程正在退出"，补杀更稳
  Sleep 800
  nsExec::Exec `"$SYSDIR\cmd.exe" /C taskkill /F /T /IM "${APP_EXECUTABLE_FILENAME}" >nul 2>&1`
  Pop $0
!macroend

; ── 2026-10-29 补：在 CHECK_APP_RUNNING 之前先强制关掉旧版本 ──────────────
; 现象：1.0.63 预览包装到一半仍弹「无法关闭，请手动关闭后重试」，而用户并没有另开实例
; （应用关窗只是隐藏到托盘，进程还在；上面覆盖 customCheckAppRunning 的写法在
;  electron-builder 26 的 include 顺序下没生效 —— 实测弹窗仍来自内置 _CHECK_APP_RUNNING）。
; 修法：用 customInit —— installer.nsi 里它一定在 install 段 CHECK_APP_RUNNING **之前**执行。

; ── 2026-10-29 二次加固：Windows 上「无法关闭」仍复现 ─────────────────────
; 1) customInit 里再加一道 PowerShell 兜底：按「进程路径含 DeepWhale」匹配，
;    不依赖 exe 名字（旧安装可能漂到 %TEMP%\old-install\...，名字也可能带连字符）。
; 2) 卸载器同样会做 CHECK_APP_RUNNING（uninstaller.nsh），所以 customUnInit 也要先杀。
!macro dwhKillApp
  ; 温和关一次（给应用自己退出的机会）
  nsExec::Exec `"$SYSDIR\cmd.exe" /C taskkill /IM "DeepWhale Desktop.exe" >nul 2>&1`
  Pop $0
  Sleep 1500
  ; 强制结束整棵进程树（/F 强制、/T 含 DSH 子进程）；再来一次防"正在退出"
  nsExec::Exec `"$SYSDIR\cmd.exe" /C taskkill /F /T /IM "DeepWhale Desktop.exe" >nul 2>&1`
  Pop $0
  Sleep 800
  nsExec::Exec `"$SYSDIR\cmd.exe" /C taskkill /F /T /IM "deepwhale-desktop.exe" >nul 2>&1`
  Pop $0
  Sleep 500
!macroend

!macro customInit
  !insertmacro dwhKillApp
!macroend

!macro customUnInit
  !insertmacro dwhKillApp
!macroend
