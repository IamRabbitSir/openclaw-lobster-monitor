$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$MonitorUrl = if ($env:MONITOR_URL) { $env:MONITOR_URL } else { "" }
$IngestToken = if ($env:INGEST_TOKEN) { $env:INGEST_TOKEN } else { "" }
$SourceId = if ($env:SOURCE_ID) { $env:SOURCE_ID } else { "" }
$SourceLabel = if ($env:SOURCE_LABEL) { $env:SOURCE_LABEL } else { "" }
$OpenClawConfigPath = if ($env:OPENCLAW_CONFIG_PATH) { $env:OPENCLAW_CONFIG_PATH } else { "" }
$PluginInstallDir = if ($env:PLUGIN_INSTALL_DIR) { $env:PLUGIN_INSTALL_DIR } else { "" }
$PollIntervalMs = if ($env:POLL_INTERVAL_MS) { [int]$env:POLL_INTERVAL_MS } else { 15000 }
$EventDebounceMs = if ($env:EVENT_DEBOUNCE_MS) { [int]$env:EVENT_DEBOUNCE_MS } else { 150 }
$RequestTimeoutMs = if ($env:REQUEST_TIMEOUT_MS) { [int]$env:REQUEST_TIMEOUT_MS } else { 4000 }
$CliTimeoutMs = if ($env:CLI_TIMEOUT_MS) { [int]$env:CLI_TIMEOUT_MS } else { 2500 }
$EnableCli = if ($env:ENABLE_CLI -and $env:ENABLE_CLI.ToLower() -eq "false") { $false } else { $true }
$RestartOpenClawCommand = if ($env:RESTART_OPENCLAW_COMMAND) { $env:RESTART_OPENCLAW_COMMAND } else { "" }

function Get-ResolvedOpenClawConfigPath {
  param([string]$RequestedPath)

  if ($RequestedPath) {
    return $RequestedPath
  }

  $openclaw = Get-Command openclaw -ErrorAction SilentlyContinue
  if ($openclaw) {
    try {
      $cliPath = & openclaw config file 2>$null
      if ($cliPath) {
        return $cliPath.Trim()
      }
    } catch {
    }
  }

  $candidates = @(
    (Join-Path $env:USERPROFILE ".openclaw\openclaw.json"),
    (Join-Path $env:USERPROFILE ".config\openclaw\openclaw.json"),
    (Join-Path (Get-Location) "openclaw.json")
  )

  foreach ($candidate in $candidates) {
    if (Test-Path $candidate) {
      return $candidate
    }
  }

  return (Join-Path $env:USERPROFILE ".openclaw\openclaw.json")
}

function Ensure-NotePropertyObject {
  param(
    [Parameter(Mandatory = $true)] [object]$Parent,
    [Parameter(Mandatory = $true)] [string]$Name
  )

  $existing = $Parent.PSObject.Properties[$Name]
  if (-not $existing -or $null -eq $existing.Value) {
    $child = [pscustomobject]@{}
    if ($existing) {
      $existing.Value = $child
      return $child
    }
    $Parent | Add-Member -MemberType NoteProperty -Name $Name -Value $child
    return $child
  }

  return $existing.Value
}

function Set-NotePropertyValue {
  param(
    [Parameter(Mandatory = $true)] [object]$Parent,
    [Parameter(Mandatory = $true)] [string]$Name,
    [Parameter(Mandatory = $true)] $Value
  )

  $existing = $Parent.PSObject.Properties[$Name]
  if ($existing) {
    $existing.Value = $Value
  } else {
    $Parent | Add-Member -MemberType NoteProperty -Name $Name -Value $Value
  }
}

if (-not $MonitorUrl -or -not $IngestToken -or -not $SourceId) {
  throw "MONITOR_URL, INGEST_TOKEN, and SOURCE_ID are required."
}

$MonitorUrl = $MonitorUrl.TrimEnd("/")
$OpenClawConfigPath = Get-ResolvedOpenClawConfigPath -RequestedPath $OpenClawConfigPath

if (-not $SourceLabel) {
  $SourceLabel = $SourceId
}

if (-not $PluginInstallDir) {
  $PluginInstallDir = Join-Path (Split-Path -Parent $OpenClawConfigPath) "plugins\openclaw-lobster-monitor"
}

$null = New-Item -ItemType Directory -Force -Path $PluginInstallDir
$null = New-Item -ItemType Directory -Force -Path (Join-Path $PluginInstallDir "lib")

Invoke-WebRequest "$MonitorUrl/api/setup/plugin/package.json" -OutFile (Join-Path $PluginInstallDir "package.json") -UseBasicParsing
Invoke-WebRequest "$MonitorUrl/api/setup/plugin/openclaw.plugin.json" -OutFile (Join-Path $PluginInstallDir "openclaw.plugin.json") -UseBasicParsing
Invoke-WebRequest "$MonitorUrl/api/setup/plugin/index.js" -OutFile (Join-Path $PluginInstallDir "index.js") -UseBasicParsing
Invoke-WebRequest "$MonitorUrl/api/setup/plugin/lib/collector.js" -OutFile (Join-Path $PluginInstallDir "lib\collector.js") -UseBasicParsing

$configDir = Split-Path -Parent $OpenClawConfigPath
$null = New-Item -ItemType Directory -Force -Path $configDir

if (Test-Path $OpenClawConfigPath) {
  $timestamp = Get-Date -Format "yyyyMMddHHmmss"
  Copy-Item $OpenClawConfigPath "$OpenClawConfigPath.bak.$timestamp"
  $rawConfig = Get-Content $OpenClawConfigPath -Raw
  $config = if ($rawConfig.Trim()) { $rawConfig | ConvertFrom-Json } else { [pscustomobject]@{} }
} else {
  $config = [pscustomobject]@{}
}

$plugins = Ensure-NotePropertyObject -Parent $config -Name "plugins"
$load = Ensure-NotePropertyObject -Parent $plugins -Name "load"
$entries = Ensure-NotePropertyObject -Parent $plugins -Name "entries"

$pathsProperty = $load.PSObject.Properties["paths"]
if (-not $pathsProperty -or $null -eq $pathsProperty.Value) {
  Set-NotePropertyValue -Parent $load -Name "paths" -Value @()
  $pathsProperty = $load.PSObject.Properties["paths"]
}

$paths = @($pathsProperty.Value)
if ($paths -notcontains $PluginInstallDir) {
  $paths += $PluginInstallDir
}
$pathsProperty.Value = $paths

$entryValue = [pscustomobject]@{
  enabled = $true
  config = [pscustomobject]@{
    serverUrl = $MonitorUrl
    ingestToken = $IngestToken
    sourceId = $SourceId
    sourceLabel = $SourceLabel
    pollIntervalMs = $PollIntervalMs
    eventDebounceMs = $EventDebounceMs
    requestTimeoutMs = $RequestTimeoutMs
    cliTimeoutMs = $CliTimeoutMs
    enableCli = $EnableCli
  }
}

Set-NotePropertyValue -Parent $entries -Name "openclaw-lobster-monitor" -Value $entryValue
$config | ConvertTo-Json -Depth 100 | Set-Content -Path $OpenClawConfigPath -Encoding UTF8

if (Get-Command openclaw -ErrorAction SilentlyContinue) {
  try {
    & openclaw plugins install $PluginInstallDir | Out-Null
  } catch {
  }
}

if ($RestartOpenClawCommand) {
  Invoke-Expression $RestartOpenClawCommand
}

Write-Host ""
Write-Host "OpenClaw lobster monitor plugin installed."
Write-Host "Plugin directory: $PluginInstallDir"
Write-Host "OpenClaw config: $OpenClawConfigPath"
Write-Host "Source ID: $SourceId"
Write-Host "Server URL: $MonitorUrl"
Write-Host "Restart OpenClaw Gateway if it is not already auto-reloading plugins."
