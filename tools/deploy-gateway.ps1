# ============================================================================
# Deploy the AgriSuri inference gateway.
#
# Run after `supabase.cmd login` once:
#   powershell -ExecutionPolicy Bypass -File tools\deploy-gateway.ps1
#
# Secrets are read from gitignored files, never from this script:
#   tools/roboflow.key         Roboflow API key
#   tools/service-role.key     Supabase service_role JWT
# or from ROBOFLOW_API_KEY / SUPABASE_SERVICE_ROLE_KEY in the environment.
#
# This file is safe to commit. The model slugs below are public identifiers.
#
# ASCII only on purpose. PowerShell 5.1 reads a BOM-less .ps1 as ANSI, so a
# UTF-8 em dash or arrow corrupts the parser.
# ============================================================================

$ErrorActionPreference = 'Stop'

$Ref      = 'romlxfchyvjbwuzsgoqq'
$CliDir   = 'C:\Users\Admin\.workbuddy-ai\binaries\node\versions\22.22.2-6'
$Root     = Split-Path -Parent $PSScriptRoot
$Function = 'infer'

# Roboflow model targets. Format is `project/version`; the gateway also accepts
# `workspace/project/version`, and a comma-separated list of candidates tried in
# order. The shape project was renamed after training, so its artifact still
# answers on the old slug - both are listed until it is redeployed.
$ShapeGate     = 'shape-u5iks/1,disease_-_texture_tomato_-_palay/1'
$TextureGate   = 'texture-8frhk/1'
$DiseaseTomato = 'tomato_diseases-ksz6z/1'
$DiseasePalay  = 'rice_diseases-qcvnv/1'

function Step($n, $text) { Write-Host "`n[$n] $text" -ForegroundColor Cyan }
function Ok($text)       { Write-Host "    ok  $text" -ForegroundColor Green }
function Warn($text)     { Write-Host "    !!  $text" -ForegroundColor Yellow }
function Fail($text)     { Write-Host "`n    FAILED  $text`n" -ForegroundColor Red; exit 1 }

<#
  Native commands write warnings to stderr. With $ErrorActionPreference='Stop',
  PowerShell 5.1 turns a redirected stderr line into a terminating error, which
  kills the script before it can report anything useful. This wrapper captures
  both streams without letting stderr abort the run, and returns the exit code.
#>
function Invoke-Cli {
  param([string[]]$CliArgs)
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $out  = & supabase.cmd @CliArgs 2>&1 | Out-String
    $code = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $prev
  }
  [pscustomobject]@{ Output = $out; Code = $code }
}

# Reads a secret from the environment, then from a file. Never prints it.
function Get-Secret($envName, $fileName) {
  $value = [Environment]::GetEnvironmentVariable($envName)
  if ($value) { return $value.Trim() }

  $path = Join-Path $Root $fileName
  if (Test-Path $path) { return (Get-Content -Raw $path).Trim() }

  Fail "Missing $envName. Put it in $fileName or set the environment variable."
}

# --- 0. Secrets -------------------------------------------------------------
Step 0 'Reading secrets'
$RoboflowKey    = Get-Secret 'ROBOFLOW_API_KEY'          'tools\roboflow.key'
$ServiceRoleKey = Get-Secret 'SUPABASE_SERVICE_ROLE_KEY' 'tools\service-role.key'
Ok 'roboflow key and service role key loaded'

# --- 0b. CLI on PATH --------------------------------------------------------
if (-not (Get-Command supabase.cmd -ErrorAction SilentlyContinue)) {
  if (Test-Path (Join-Path $CliDir 'supabase.cmd')) {
    $env:Path += ";$CliDir"
    Ok 'added Supabase CLI to PATH for this session'
  } else {
    Fail "supabase.cmd not found. Expected it in $CliDir"
  }
}

# --- 1. Login check ---------------------------------------------------------
Step 1 'Checking Supabase login'
$check = Invoke-Cli @('projects', 'list')

if ($check.Output -match 'Access token not provided|not logged in') {
  Fail "Not logged in. Run this first, then re-run this script:`n           supabase.cmd login"
}
if ($check.Output -notmatch [regex]::Escape($Ref)) {
  Warn "project $Ref is not in your project list - continuing anyway"
} else {
  Ok "logged in, project $Ref visible"
}

# --- 2. Secrets -------------------------------------------------------------
Step 2 'Setting secrets'
$set = Invoke-Cli @(
  'secrets', 'set',
  "ROBOFLOW_API_KEY=$RoboflowKey",
  "ROBOFLOW_SHAPE_GATE=$ShapeGate",
  "ROBOFLOW_TEXTURE_GATE=$TextureGate",
  "ROBOFLOW_DISEASE_TOMATO=$DiseaseTomato",
  "ROBOFLOW_DISEASE_PALAY=$DiseasePalay",
  "SUPABASE_SERVICE_ROLE_KEY=$ServiceRoleKey",
  '--project-ref', $Ref
)
if ($set.Code -ne 0) {
  Write-Host $set.Output
  Fail "Setting secrets failed (exit $($set.Code))"
}
Ok 'six secrets set'

# --- 3. Deploy --------------------------------------------------------------
Step 3 "Deploying function '$Function'"
$dep = Invoke-Cli @('functions', 'deploy', $Function, '--project-ref', $Ref)
if ($dep.Code -ne 0) {
  Write-Host $dep.Output
  Fail "Deploy failed (exit $($dep.Code))"
}
Ok 'function deployed'

# --- 4. Verify --------------------------------------------------------------
Step 4 'Verifying the endpoint'
Start-Sleep -Seconds 3

$url  = "https://$Ref.supabase.co/functions/v1/$Function"
$code = $null
try {
  $r = Invoke-WebRequest -Uri $url -Method Post -UseBasicParsing -TimeoutSec 25 `
       -ContentType 'application/json' -Body '{"stage":"health"}'
  $code = [int]$r.StatusCode
} catch {
  if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode.value__ }
  else { Fail "Could not reach ${url}: $($_.Exception.Message)" }
}

if ($code -eq 404) {
  Fail 'Endpoint still returns 404 - the deploy did not take. Check the CLI output above.'
}

Ok "gateway is live (HTTP $code on an unauthenticated request - 401 is correct)"

Write-Host "`nDone. Reload the app and check Scan -> Model status.`n" -ForegroundColor Green
Write-Host "  shape    $ShapeGate"
Write-Host "  texture  $TextureGate"
Write-Host "  tomato   $DiseaseTomato"
Write-Host "  palay    $DiseasePalay`n"
