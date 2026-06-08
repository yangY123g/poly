param(
  [ValidateSet("50u", "current", "both")]
  [string]$Target = "50u",

  [ValidateSet("paper", "live")]
  [string]$Mode = "paper",

  [switch]$Confirm50uLive
)

$ErrorActionPreference = "Stop"
$repo = Resolve-Path (Join-Path $PSScriptRoot "..")
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) {
  $bundledNode = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
  if (Test-Path $bundledNode) {
    $node = $bundledNode
  } else {
    throw "node.exe was not found in PATH or Codex bundled runtime."
  }
}

if ($Mode -eq "live") {
  if (-not $Confirm50uLive) {
    throw "Live mode requires -Confirm50uLive. This still only arms the guarded switch; the paper mirror has no real CLOB adapter wired."
  }
  $env:BONEREAPER_REAL_ORDERS = "1"
  $env:BONEREAPER_REAL_ORDERS_CONFIRM = "I_ACCEPT_50U_REAL_ORDERS"
} else {
  Remove-Item Env:\BONEREAPER_REAL_ORDERS -ErrorAction SilentlyContinue
  Remove-Item Env:\BONEREAPER_REAL_ORDERS_CONFIRM -ErrorAction SilentlyContinue
}

function Invoke-BonereaperLive {
  param(
    [string]$OutDir,
    [int]$BankrollUsdc,
    [switch]$Detached
  )

  $args = @(
    "scripts/bonereaper-live-paper.mjs",
    "--auto-btc5m",
    "--out", $OutDir
  )
  if ($BankrollUsdc -gt 0) {
    $args += @("--clone-bankroll-usdc", [string]$BankrollUsdc)
  }
  if ($Mode -eq "live") {
    $args += @(
      "--clone-real-orders",
      "--clone-real-order-max-budget-usdc", "50",
      "--clone-real-order-daily-loss-limit-usdc", "5"
    )
  }

  Write-Host "Starting $OutDir mode=$Mode"
  if ($Detached) {
    Start-Process -FilePath $node -ArgumentList $args -WorkingDirectory $repo -WindowStyle Hidden | Out-Null
  } else {
    Push-Location $repo
    try {
      & $node @args
    } finally {
      Pop-Location
    }
  }
}

if ($Target -eq "50u") {
  Invoke-BonereaperLive -OutDir "bonereaper-live-50u" -BankrollUsdc 50
} elseif ($Target -eq "current") {
  Invoke-BonereaperLive -OutDir "bonereaper-live-current" -BankrollUsdc 0
} else {
  Invoke-BonereaperLive -OutDir "bonereaper-live-current" -BankrollUsdc 0 -Detached
  Invoke-BonereaperLive -OutDir "bonereaper-live-50u" -BankrollUsdc 50 -Detached
}
