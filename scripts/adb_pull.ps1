# Android 一键拉取：插上手机（已开 USB 调试），把 DCIM/Camera 和 Pictures 拉到图库收件箱
param(
  [string]$OutDir = ""
)

$ErrorActionPreference = 'Stop'

if (-not $OutDir) {
  $OutDir = Join-Path (Split-Path $PSScriptRoot -Parent) "data\inbox"
}

if (-not (Get-Command adb -ErrorAction SilentlyContinue)) {
  Write-Error "未找到 adb。请安装 Android SDK Platform Tools 并加入 PATH（https://developer.android.com/tools/releases/platform-tools）"
}

Write-Host "已连接设备："
adb devices

Write-Host "拉取 /sdcard/DCIM/Camera -> $OutDir\Camera"
adb pull /sdcard/DCIM/Camera "$OutDir\Camera"

Write-Host "拉取 /sdcard/Pictures -> $OutDir\Pictures"
adb pull /sdcard/Pictures "$OutDir\Pictures"

Write-Host "完成。回图库点「导入」，或调 POST http://127.0.0.1:47910/v1/import"
