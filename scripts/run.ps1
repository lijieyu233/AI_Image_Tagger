# 一键启动：先构建前端（如未构建），再起后端并打开浏览器
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot\..

if (-not (Test-Path "web\dist\index.html")) {
    Write-Host "首次运行，构建前端…"
    npm run build:web
}

Write-Host "启动后端 http://127.0.0.1:47910"
Start-Process -FilePath "node" -ArgumentList "backend\src\index.js" -WorkingDirectory (Get-Location)

Start-Sleep -Seconds 1
Start-Process "http://127.0.0.1:47910"
Write-Host "已启动。关闭后请手动结束 node 进程，或用 Ctrl+C。"
