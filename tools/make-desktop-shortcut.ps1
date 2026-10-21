# ============================================================
#  在桌面给「星虹巢编辑器」建一个带图标的快捷方式（Windows）
#  ------------------------------------------------------------
#  .cmd / .bat 本身不能单独设图标，必须包一层 .lnk。
#  这个脚本：
#    1. 用 tools/editor-icon/editor-icon.ico 建快捷方式；
#    2. 把原来的 .cmd 设成隐藏（桌面只留带图标的那个）；
#    3. 刷新一次资源管理器图标缓存。
#
#  用法（PowerShell）：
#    pwsh -File tools/make-desktop-shortcut.ps1
#    pwsh -File tools/make-desktop-shortcut.ps1 -Launcher "D:\某个\启动.cmd" -Name "我的编辑器"
#
#  撤销：attrib -h "$HOME\Desktop\星虹巢编辑器.cmd" 然后删掉 .lnk
# ============================================================
param(
  [string]$Launcher = "$HOME\Desktop\星虹巢编辑器.cmd",
  [string]$Name = '星虹巢编辑器',
  [string]$Icon = "$PSScriptRoot\editor-icon\editor-icon.ico",
  [switch]$ShowConsole   # 默认最小化启动，少闪黑窗
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $Launcher)) { throw "找不到启动脚本: $Launcher" }
if (-not (Test-Path -LiteralPath $Icon)) { throw "找不到图标: $Icon（先跑 tools/make-app-icons.py）" }

$desk = Split-Path -Parent $Launcher
$lnk = Join-Path $desk ($Name + '.lnk')

$W = New-Object -ComObject WScript.Shell
$s = $W.CreateShortcut($lnk)
$s.TargetPath       = (Resolve-Path -LiteralPath $Launcher).Path
$s.WorkingDirectory = $desk
$s.IconLocation     = "$((Resolve-Path -LiteralPath $Icon).Path),0"
$s.WindowStyle      = if ($ShowConsole) { 1 } else { 7 }
$s.Description      = '星虹巢 · 本地编辑器'
$s.Save()

# 隐藏原始 .cmd（Get-Item 对隐藏文件要加 -Force）
$item = Get-Item -LiteralPath $Launcher -Force
$item.Attributes = $item.Attributes -bor [IO.FileAttributes]::Hidden

& ie4uinit.exe -show 2>$null | Out-Null

$r = $W.CreateShortcut($lnk)
[pscustomobject]@{
  Shortcut    = $lnk
  Target      = $r.TargetPath
  Icon        = $r.IconLocation
  WindowStyle = $r.WindowStyle
  LauncherHidden = [bool]((Get-Item -LiteralPath $Launcher -Force).Attributes -band [IO.FileAttributes]::Hidden)
} | Format-List
