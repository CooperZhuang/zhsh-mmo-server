$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$script:root = Split-Path -Parent $MyInvocation.MyCommand.Path
$script:server = Join-Path $script:root 'server'
$script:serverJs = Join-Path $script:server 'server.js'
$script:lock = Join-Path $script:server 'data' '.zhsh-game-server.lock'
$script:port = 4173
$script:localUrl = "http://127.0.0.1:$script:port/"

$script:mutex = New-Object System.Threading.Mutex($false, 'ZHSH_GAME_TRAY')
if (-not $script:mutex.WaitOne(0)) {
  Start-Process $script:localUrl
  exit
}

function Read-LockPid {
  if (Test-Path $script:lock) {
    try { return [int]((Get-Content $script:lock -Raw | ConvertFrom-Json).pid) } catch { return $null }
  }
  return $null
}

function Get-ServerPid {
  $candidate = Read-LockPid
  if ($candidate) {
    if (Get-Process -Id $candidate -ErrorAction SilentlyContinue) { return $candidate }
  }
  return $null
}

function Ensure-FirewallRule {
  netsh advfirewall firewall show rule name="Zhsh Game Server" | Out-Null
  if ($LASTEXITCODE -ne 0) {
    try {
      Start-Process -FilePath 'netsh' -ArgumentList 'advfirewall','firewall','add','rule','name=Zhsh Game Server','dir=in','action=allow','protocol=TCP','localport=4173' -Verb RunAs -Wait -WindowStyle Hidden
    } catch { }
  }
}

function Start-Server {
  if (Get-ServerPid) { return }
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) { $script:notify.ShowBalloonTip(5000, '纵横四海', '未找到 Node.js，请安装 Node.js 22 或更高版本。', [System.Windows.Forms.ToolTipIcon]::Error); return }
  Start-Process -FilePath $node.Source -ArgumentList "`"$script:serverJs`"" -WorkingDirectory $script:root -WindowStyle Hidden
  for ($i = 0; $i -lt 30; $i++) { if (Get-ServerPid) { break }; Start-Sleep -Milliseconds 200 }
  if (-not (Get-ServerPid)) {
    $script:notify.ShowBalloonTip(5000, '纵横四海', '服务器启动失败（端口可能被占用）。', [System.Windows.Forms.ToolTipIcon]::Warning)
  }
}

function Stop-Server {
  $serverPid = Get-ServerPid
  if ($serverPid) {
    Stop-Process -Id $serverPid -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 400
    if (Test-Path $script:lock) { Remove-Item $script:lock -Force -ErrorAction SilentlyContinue }
  }
}

$script:notify = New-Object System.Windows.Forms.NotifyIcon
$script:notify.Text = '纵横四海服务器'
$script:notify.Icon = [System.Drawing.SystemIcons]::Application
$script:notify.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$openItem = New-Object System.Windows.Forms.ToolStripMenuItem('打开游戏')
$restartItem = New-Object System.Windows.Forms.ToolStripMenuItem('重启服务器')
$stopItem = New-Object System.Windows.Forms.ToolStripMenuItem('停止服务器')
$exitItem = New-Object System.Windows.Forms.ToolStripMenuItem('退出')
[void]$menu.Items.Add($openItem)
[void]$menu.Items.Add($restartItem)
[void]$menu.Items.Add($stopItem)
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
[void]$menu.Items.Add($exitItem)
$script:notify.ContextMenuStrip = $menu

$openItem.Add_Click({ Start-Process $script:localUrl })
$restartItem.Add_Click({ Stop-Server; Start-Server })
$stopItem.Add_Click({ Stop-Server })
$exitItem.Add_Click({ Stop-Server; $script:notify.Visible = $false; $script:notify.Dispose(); [System.Windows.Forms.Application]::Exit() })
$script:notify.Add_DoubleClick({ Start-Process $script:localUrl })

Ensure-FirewallRule
Start-Server
[System.Windows.Forms.Application]::Run()
$script:mutex.ReleaseMutex()
