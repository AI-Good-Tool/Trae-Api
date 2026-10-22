$Work = $env:TRAE_UPDATE_WORK
$ErrorActionPreference = 'Stop'
$launchAttempted = $false
try {
  $plan = Get-Content -LiteralPath (Join-Path $Work 'plan.json') -Raw | ConvertFrom-Json
  if ((Get-FileHash -LiteralPath $plan.file -Algorithm SHA256).Hash.ToLowerInvariant() -ne $plan.digest) { throw 'Installer checksum changed' }
  Set-Content -LiteralPath (Join-Path $Work 'ready') -Value 'ok'
  $parent = Get-Process -Id $plan.pid -ErrorAction SilentlyContinue
  if ($parent) { $parent | Wait-Process -Timeout 120 -ErrorAction Stop }
  $backup = Join-Path $Work 'previous'
  Copy-Item -LiteralPath $plan.target -Destination $backup -Recurse
  $process = Start-Process -FilePath $plan.file -ArgumentList "/S /D=$($plan.target)" -Wait -PassThru
  if ($process.ExitCode -ne 0) {
    Copy-Item -Path (Join-Path $backup '*') -Destination $plan.target -Recurse -Force
    $launchAttempted = $true
    Start-Process -FilePath (Join-Path $plan.target 'Trae Switch.exe')
    throw 'Installation failed; previous files restored'
  }
  $launchAttempted = $true
  Start-Process -FilePath (Join-Path $plan.target 'Trae Switch.exe') -ArgumentList @('--trae-update-stage', ('"' + $Work + '"'))
  for ($i=0; $i -lt 150; $i++) {
    if (Test-Path -LiteralPath (Join-Path $Work 'launch-confirmed')) {
      Set-Content -LiteralPath (Join-Path $Work 'complete') -Value 'ok'
      exit 0
    }
    Start-Sleep -Milliseconds 200
  }
  throw "New app did not confirm startup; backup retained at $backup"
} catch {
  if (!$launchAttempted -and $plan -and (Test-Path -LiteralPath (Join-Path $plan.target 'Trae Switch.exe'))) { Start-Process -FilePath (Join-Path $plan.target 'Trae Switch.exe') }
  $_.Exception.Message | Set-Content -LiteralPath (Join-Path $Work 'error.txt')
  exit 1
}
