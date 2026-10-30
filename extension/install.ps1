<#
.SYNOPSIS
  Instala/actualiza la extensión de la mascota en los homes de pi y gentle-shell.

.DESCRIPTION
  Copia index.ts/package.json/README.md a <home>/extensions/session-mascot y
  crea o actualiza <home>/session-mascot.json apuntando shellDir al
  mascot-desktop de este workspace. Conserva el layout existente.

.EXAMPLE
  .\install.ps1
  .\install.ps1 -AgentHome "$HOME\.gentle-shell\agent"
#>
param(
  [string[]]$AgentHome
)

$ErrorActionPreference = 'Stop'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$workspace = Split-Path -Parent $here
$shellDir = Join-Path $workspace 'desktop'

if (-not (Test-Path (Join-Path $shellDir 'package.json'))) {
  throw "No se encontró desktop junto a extension: $shellDir"
}

if (-not $AgentHome -or $AgentHome.Count -eq 0) {
  $candidates = @(
    (Join-Path $HOME '.pi\agent'),
    (Join-Path $HOME '.gentle-shell\agent')
  )
  $AgentHome = @($candidates | Where-Object { Test-Path $_ })
}

if ($AgentHome.Count -eq 0) {
  throw 'No se encontró ningún home de pi (~/.pi/agent) ni de gentle-shell (~/.gentle-shell/agent).'
}

foreach ($agentDir in $AgentHome) {
  $resolved = [System.IO.Path]::GetFullPath($agentDir)
  $target = Join-Path $resolved 'extensions\session-mascot'
  New-Item -ItemType Directory -Force -Path $target | Out-Null

  Copy-Item (Join-Path $here 'extensions\session-mascot.ts') (Join-Path $target 'index.ts') -Force
  foreach ($file in @('package.json', 'README.md')) {
    Copy-Item (Join-Path $here $file) (Join-Path $target $file) -Force
  }

  $configPath = Join-Path $resolved 'session-mascot.json'
  $existing = $null
  if (Test-Path $configPath) {
    try { $existing = Get-Content $configPath -Raw | ConvertFrom-Json } catch { $existing = $null }
  }

  $config = [ordered]@{}
  $config.enabled = if ($null -ne $existing -and $null -ne $existing.enabled) { [bool]$existing.enabled } else { $true }
  $config.autoLaunch = if ($null -ne $existing -and $null -ne $existing.autoLaunch) { [bool]$existing.autoLaunch } else { $true }
  $config.shellDir = $shellDir
  $config.layout = if ($null -ne $existing) { $existing.layout } else { $null }
  $config.debug = if ($null -ne $existing -and $null -ne $existing.debug) { [bool]$existing.debug } else { $false }

  $config | ConvertTo-Json | Set-Content -Encoding utf8 $configPath

  Write-Host "[mascota] instalada en $target"
  Write-Host "[mascota] config: $configPath"
}