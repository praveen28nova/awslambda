# MailBlast — Full Deployment Script
# Run from the project root:  .\scripts\deploy.ps1  [prod|staging|dev]
# Prerequisites: AWS CLI configured, SAM CLI installed, Node 18+

param(
    [string]$Env = "prod",
    [string]$AppBaseUrl = "",
    [string]$SESConfigSet = "",
    [switch]$SkipBuild = $false
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# ── Colours ────────────────────────────────────────────────────────────────────
function Write-Step  { param($msg) Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-Ok    { param($msg) Write-Host "    [OK] $msg" -ForegroundColor Green }
function Write-Warn  { param($msg) Write-Host "    [!!] $msg" -ForegroundColor Yellow }
function Write-Fail  { param($msg) Write-Host "    [XX] $msg" -ForegroundColor Red; exit 1 }

Write-Host @"
  __  __       _ _ ____  _           _
 |  \/  | __ _(_) | __ )| | __ _ ___| |_
 | |\/| |/ _`` | | |  _ \| |/ _`` / __| __|
 | |  | | (_| | | | |_) | | (_| \__ \ |_
 |_|  |_|\__,_|_|_|____/|_|\__,_|___/\__|
 
 Deployment Script — Environment: $Env
"@ -ForegroundColor Magenta

# ── Validate prerequisites ─────────────────────────────────────────────────────
Write-Step "Checking prerequisites"

if (-not (Get-Command aws -ErrorAction SilentlyContinue))   { Write-Fail "AWS CLI not found. Install from https://aws.amazon.com/cli/" }
if (-not (Get-Command sam -ErrorAction SilentlyContinue))   { Write-Fail "SAM CLI not found. Install from https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html" }
if (-not (Get-Command node -ErrorAction SilentlyContinue))  { Write-Fail "Node.js not found. Install from https://nodejs.org/" }
Write-Ok "Prerequisites OK"

# ── Check AWS identity ─────────────────────────────────────────────────────────
Write-Step "Verifying AWS credentials"
try {
    $identity = aws sts get-caller-identity --output json 2>&1 | ConvertFrom-Json
    Write-Ok "Account: $($identity.Account) | User: $($identity.Arn)"
} catch {
    Write-Fail "AWS credentials not configured or invalid. Run: aws configure"
}

# ── Check SES sender verification ─────────────────────────────────────────────
Write-Step "Checking SES sender verification"
try {
    $identities = aws sesv2 list-email-identities --output json 2>&1 | ConvertFrom-Json
    $verified = $identities.EmailIdentities | Where-Object { $_.VerifiedForSendingStatus -eq $true }
    if ($verified.Count -eq 0) {
        Write-Warn "No verified SES identities found!"
        Write-Warn "Go to: https://console.aws.amazon.com/ses/home#/verified-identities"
        Write-Warn "Verify at least one sender email/domain before emails will work."
    } else {
        Write-Ok "Verified SES identities:"
        $verified | ForEach-Object { Write-Ok "  - $($_.IdentityName)" }
    }
} catch {
    Write-Warn "Could not check SES identities (may be a permissions issue). Continuing..."
}

# ── Install npm dependencies ───────────────────────────────────────────────────
Write-Step "Installing npm dependencies"
Push-Location "$PSScriptRoot\..\lambda"
npm.cmd install --prefer-offline 2>&1 | Select-Object -Last 3
Write-Ok "Dependencies installed"

# ── Run tests ─────────────────────────────────────────────────────────────────
Write-Step "Running tests"
node --experimental-vm-modules node_modules/jest/bin/jest.js --runInBand --forceExit --passWithNoTests 2>&1
if ($LASTEXITCODE -ne 0) { Write-Fail "Tests failed — aborting deployment" }
Write-Ok "All tests passed"

# ── SAM build ─────────────────────────────────────────────────────────────────
if (-not $SkipBuild) {
    Write-Step "Building with SAM"
    sam build --cached --parallel
    if ($LASTEXITCODE -ne 0) { Write-Fail "SAM build failed" }
    Write-Ok "Build complete"
}

# ── SAM deploy ────────────────────────────────────────────────────────────────
Write-Step "Deploying to AWS ($Env)"

$overrides = @()
if ($AppBaseUrl)  { $overrides += "AppBaseUrl=$AppBaseUrl" }
if ($SESConfigSet) { $overrides += "SESConfigurationSet=$SESConfigSet" }

$deployArgs = @("deploy", "--config-env", $Env)
if ($overrides.Count -gt 0) {
    $deployArgs += "--parameter-overrides"
    $deployArgs += ($overrides -join " ")
}

sam @deployArgs
if ($LASTEXITCODE -ne 0) { Write-Fail "SAM deploy failed" }

# ── Capture outputs ────────────────────────────────────────────────────────────
Write-Step "Retrieving stack outputs"
$stackName = if ($Env -eq "prod") { "mailblast-prod" } elseif ($Env -eq "staging") { "mailblast-staging" } else { "mailblast-dev" }

$outputs = aws cloudformation describe-stacks --stack-name $stackName --query "Stacks[0].Outputs" --output json 2>&1 | ConvertFrom-Json
$outMap = @{}
$outputs | ForEach-Object { $outMap[$_.OutputKey] = $_.OutputValue }

$apiEndpoint     = $outMap["ApiEndpoint"]
$eventTopicArn   = $outMap["EventsTopicArn"]
$cognitoPoolId   = $outMap["CognitoUserPoolId"]
$cognitoClientId = $outMap["CognitoClientId"]
$tableNam        = $outMap["DynamoTableName"]

# ── Write frontend config ──────────────────────────────────────────────────────
Write-Step "Writing frontend config"
$configJs = @"
// Auto-generated by deploy.ps1 — do not edit manually
window.MAILBLAST_CONFIG = {
  apiEndpoint:     "$apiEndpoint",
  cognitoPoolId:   "$cognitoPoolId",
  cognitoClientId: "$cognitoClientId",
  region:          "us-east-1",
  environment:     "$Env"
};
"@
$configJs | Out-File -FilePath "$PSScriptRoot\..\frontend\config.js" -Encoding UTF8
Write-Ok "Config written to frontend/config.js"

Pop-Location

# ── Summary ────────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "╔══════════════════════════════════════════════════════════════════╗" -ForegroundColor Green
Write-Host "║                    DEPLOYMENT COMPLETE ✅                       ║" -ForegroundColor Green
Write-Host "╠══════════════════════════════════════════════════════════════════╣" -ForegroundColor Green
Write-Host "║  API Endpoint:    $apiEndpoint" -ForegroundColor Green
Write-Host "║  Cognito Pool:    $cognitoPoolId" -ForegroundColor Green  
Write-Host "║  Cognito Client:  $cognitoClientId" -ForegroundColor Green
Write-Host "║  DynamoDB Table:  $tableNam" -ForegroundColor Green
Write-Host "╠══════════════════════════════════════════════════════════════════╣" -ForegroundColor Yellow
Write-Host "║  ⚡ NEXT STEPS:                                                 ║" -ForegroundColor Yellow
Write-Host "║  1. Wire SNS topic to SES Configuration Set:                   ║" -ForegroundColor Yellow
Write-Host "║     Topic ARN: $eventTopicArn" -ForegroundColor Yellow
Write-Host "║     Go to: SES Console → Configuration Sets → Event Dest       ║" -ForegroundColor Yellow
Write-Host "║  2. Paste API Endpoint in frontend Settings page               ║" -ForegroundColor Yellow
Write-Host "║  3. Create a Cognito user for login                            ║" -ForegroundColor Yellow
Write-Host "╚══════════════════════════════════════════════════════════════════╝" -ForegroundColor Green
Write-Host ""
