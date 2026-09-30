<#
.SYNOPSIS
  Cyber Defense, Step 10 - restore one encrypted backup from Backblaze B2 into
  a fresh, isolated PostgreSQL 18 container, and prove it.

.DESCRIPTION
  Run it as ONE command from the repository root, after `npm run build`:

    powershell -ExecutionPolicy Bypass -File .\scripts\restore-drill.ps1 -Latest
    powershell -ExecutionPolicy Bypass -File .\scripts\restore-drill.ps1 -Object <backup key>

  Why a script and not pasted commands: a pasted block that contains hidden
  prompts can feed its own next lines into those prompts, so a credential
  variable ends up holding a line of the script and the next one is never set.
  This script is run as a single command, so every prompt reads the keyboard;
  it rejects input that is not a single token; it checks every required
  setting by name before anything runs; and it never moves a secret through a
  command line or a shared environment variable.

  What it does:
    1. checks Docker, the offline key file (names only) and the built CLI
       (dist/scripts/backup.js)
    2. asks for the Backblaze B2 Read Only key id and key, hidden
       (with -Latest: lists the prefix with that key and picks the newest
       complete backup - a .fbk whose signed .fbk.manifest.json is beside it)
    3. starts a throwaway PostgreSQL 18 container as the target: new, empty,
       no published port, a random password nobody sees. PostgreSQL 18
       because production backups are written by pg_dump 18, whose restore
       needs a PostgreSQL 17+ server (a 16 server rejects its
       `SET transaction_timeout`) and pg_restore 18
    4. writes the B2 key and the target URL to a temporary env file readable
       only by you, and passes it and the offline key file to the container
       with --env-file; the temporary file is deleted whatever happens
    5. runs the repository's own drill - `node dist/scripts/backup.js drill` -
       in a throwaway container (Node 20 + pg_restore 18) that shares the
       target's network and has no production URL
    6. queries the restored database directly, compares it with the drill's
       report, then removes the target (unless -KeepDatabase)

  The drill downloads the backup and its signed manifest itself, verifies the
  signature, the SHA-256, the size and the key, decrypts with the offline key
  straight into pg_restore in one transaction (no plaintext file), then
  checks the schema head, the tables and the core row counts.

.PARAMETER Object
  The backup's object key, e.g. 2026/09/30/familista-20260930T031700Z-0a1b2c3d.fbk.
  A leading "familista/postgres/" is accepted and removed.

.PARAMETER Latest
  Restore the newest complete backup under the prefix instead of a named one.
  Give either -Latest or -Object, not both. The choice is only a choice: the
  drill still verifies the manifest signature, hash, size and key.
#>
[CmdletBinding()]
param(
  [string] $Object,
  [switch] $Latest,
  [string] $KeysFile = (Join-Path ([Environment]::GetFolderPath('UserProfile')) 'familista-backup-keys\offline-restore.env'),
  [string] $Bucket = 'familista-backups-2026-739261',
  [string] $Region = 'eu-central-003',
  [string] $Endpoint = 'https://s3.eu-central-003.backblazeb2.com',
  [string] $Prefix = 'familista/postgres/',
  [switch] $ForcePathStyle,
  [string] $Image = 'familista-restore-drill-runner:pg18',
  [switch] $KeepDatabase
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Fail([string] $Message) { throw "restore drill: $Message" }

# Runs a native command; returns its trimmed stdout, or $null on a non-zero exit.
function Invoke-Quiet([string] $Exe, [string[]] $Arguments) {
  $ErrorActionPreference = 'Continue'   # native stderr must not become a terminating error (Windows PowerShell 5.1)
  $out = & $Exe @Arguments 2>$null
  if ($LASTEXITCODE -ne 0) { return $null }
  return ("$out").Trim()
}

# A hidden prompt that accepts one token and nothing else. A value already set
# in this session is used only if it has the expected shape.
function Read-Secret([string] $Name, [string] $Pattern) {
  $existing = [Environment]::GetEnvironmentVariable($Name)
  if ($existing -and $existing.Trim() -cmatch $Pattern) {
    Write-Host "${Name}: using the value already set in this session."
    return $existing.Trim()
  }
  for ($i = 1; $i -le 3; $i++) {
    $secure = Read-Host -AsSecureString "$Name (input is hidden)"
    $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { $value = ([Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) + '').Trim() }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
    if ($value -cmatch $Pattern) { return $value }
    Write-Host "$Name was not accepted: it must be a single token without spaces or quotes. Nothing was stored."
  }
  Fail "$Name was not provided"
}

# A key the drill accepts as a backup object: a .fbk, never its .manifest.json.
function Test-BackupKey([string] $Key) {
  return ($Key -cmatch '^[A-Za-z0-9._\-/]+\.fbk$') -and -not $Key.Contains('..') -and -not $Key.StartsWith('/') -and
         -not $Key.EndsWith('.manifest.json')
}

# Output from a container, with the credentials entered here masked, should any
# error message ever repeat one.
function Hide-Secrets([string] $Text) {
  foreach ($s in @($accessKeyId, $secretKey)) { if ($s) { $Text = $Text.Replace($s, '***') } }
  return $Text
}

function Prop($o, [string] $n) { $p = $o.PSObject.Properties[$n]; if ($p) { return $p.Value } return $null }

$repo = Split-Path -Parent $PSScriptRoot
$tmp = $null
$target = $null
$accessKeyId = $null
$secretKey = $null

try {
  # -- 1 - preconditions ----------------------------------------------------
  if (-not (Test-Path (Join-Path $repo 'dist/scripts/backup.js'))) { Fail 'dist/scripts/backup.js is missing: run npm run build first' }
  if (-not (Invoke-Quiet 'docker' @('version', '--format', '{{.Server.Version}}'))) { Fail 'Docker is not running' }

  if (-not (Test-Path -LiteralPath $KeysFile)) { Fail "offline key file not found: $KeysFile" }
  $keyNames = @(Get-Content -LiteralPath $KeysFile | Where-Object { $_ -match '^[A-Z0-9_]+=' } | ForEach-Object { ($_ -split '=', 2)[0] })
  foreach ($n in 'BACKUP_ENCRYPTION_PRIVATE_KEY', 'BACKUP_SIGNING_PUBLIC_KEY') {
    if ($keyNames -notcontains $n) { Fail "$n is missing from $KeysFile" }
  }

  if ([bool]$Object -eq [bool]$Latest) { Fail 'give exactly one of -Latest or -Object <backup key>' }
  if ($Prefix -and -not $Prefix.EndsWith('/')) { $Prefix = "$Prefix/" }
  if (-not $Latest) {
    if ($Object.StartsWith($Prefix)) { $Object = $Object.Substring($Prefix.Length) }
    if (-not (Test-BackupKey $Object)) { Fail 'the object must be a .fbk backup key, e.g. 2026/09/30/familista-...fbk' }
  }

  # -- 2 - B2 Read Only credentials, hidden ---------------------------------
  $accessKeyId = Read-Secret 'BACKUP_S3_ACCESS_KEY_ID' '^[A-Za-z0-9]{12,64}$'
  $secretKey = Read-Secret 'BACKUP_S3_SECRET_ACCESS_KEY' '^[A-Za-z0-9+/=._-]{20,128}$'

  # -- 3 - the runner image: Node 20 + pg_restore 18 ---------------------
  if (-not (Invoke-Quiet 'docker' @('image', 'inspect', '--format', '{{.Id}}', $Image))) {
    Write-Host "Building $Image (once)..."
    $ErrorActionPreference = 'Continue'
    & docker build -q -t $Image (Join-Path $PSScriptRoot 'restore-drill') 2>&1 | Out-Null
    $buildExit = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
    if ($buildExit -ne 0) { Fail "could not build $Image" }
  }

  # -- 4 - the B2 settings to a temporary env file only you can read ------
  $tmp = Join-Path ([IO.Path]::GetTempPath()) ('fam-drill-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $tmp | Out-Null
  if ($env:OS -eq 'Windows_NT') {
    & icacls $tmp /inheritance:r /grant:r "$($env:USERNAME):(OI)(CI)F" | Out-Null
    if ($LASTEXITCODE -ne 0) { Fail 'could not restrict the temporary folder' }
  } else {
    & chmod 700 $tmp
  }
  $storeLines = @(
    "BACKUP_S3_ACCESS_KEY_ID=$accessKeyId",
    "BACKUP_S3_SECRET_ACCESS_KEY=$secretKey",
    "BACKUP_S3_BUCKET=$Bucket",
    "BACKUP_S3_REGION=$Region",
    "BACKUP_S3_ENDPOINT=$Endpoint",
    "BACKUP_S3_PREFIX=$Prefix"
  )
  if ($ForcePathStyle) { $storeLines += 'BACKUP_S3_FORCE_PATH_STYLE=true' }

  # -- 5 - with -Latest: the newest complete backup under the prefix --------
  if ($Latest) {
    $storeFile = Join-Path $tmp 'store.env'
    [IO.File]::WriteAllText($storeFile, (($storeLines -join "`n") + "`n"), (New-Object Text.UTF8Encoding($false)))
    Write-Host "Listing $Prefix in $Bucket (Read Only) ..."
    # Only the B2 settings go in: no offline key, no database URL.
    $listArgs = @('run', '--rm', '-v', "${repo}:/app:ro", '--env-file', $storeFile,
      $Image, 'node', '/app/dist/scripts/backup.js', 'latest')
    $ErrorActionPreference = 'Continue'
    $listOutput = @(& docker @listArgs 2>&1 | ForEach-Object { Hide-Secrets "$_" })
    $listExit = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
    Remove-Item -LiteralPath $storeFile -Force
    $listLine = $listOutput | Where-Object { $_.TrimStart().StartsWith('{') } | Select-Object -Last 1
    if (-not $listLine) { $listOutput | ForEach-Object { Write-Host $_ }; Fail "the listing produced no report (exit $listExit)" }
    $found = $listLine | ConvertFrom-Json
    if ($listExit -ne 0 -or -not (Prop $found 'ok')) { Fail "could not find a backup to restore: $(Prop $found 'error')" }
    $Object = "$(Prop $found 'objectKey')"
    if (-not (Test-BackupKey $Object)) { Fail 'the listing returned something that is not a .fbk backup key' }
    $modified = Prop $found 'lastModified'   # PowerShell 7 reads the ISO time as a date; 5.1 keeps the string
    if ($modified -is [datetime]) { $modified = $modified.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ') }
    Write-Host "Latest backup: $Prefix$Object (modified $modified, $(Prop $found 'complete') complete backup(s) found)"
  }

  # -- 6 - the target: a fresh PostgreSQL 18, isolated and empty ---------
  $pgUser = 'postgres'
  $pgDb = 'familista_drill'
  $pgPass = [guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N')
  $target = 'familista-drill-' + [guid]::NewGuid().ToString('N').Substring(0, 8)
  $started = Invoke-Quiet 'docker' @('run', '-d', '--name', $target, '-e', "POSTGRES_PASSWORD=$pgPass", '-e', "POSTGRES_DB=$pgDb", 'postgres:18-bookworm')
  if (-not $started) { Fail 'could not start the PostgreSQL 18 target container' }
  $ready = $false
  for ($i = 0; $i -lt 60 -and -not $ready; $i++) {
    Start-Sleep -Seconds 1
    # Over TCP: during first-start initialisation the server listens only on its socket.
    $ready = ($null -ne (Invoke-Quiet 'docker' @('exec', $target, 'pg_isready', '-q', '-h', '127.0.0.1', '-U', $pgUser, '-d', $pgDb))) -and
             ((Invoke-Quiet 'docker' @('exec', $target, 'psql', '-U', $pgUser, '-d', $pgDb, '-Atc', 'select 1')) -eq '1')
  }
  if (-not $ready) { Fail 'the PostgreSQL 18 target did not become ready' }
  $tables = Invoke-Quiet 'docker' @('exec', $target, 'psql', '-U', $pgUser, '-d', $pgDb, '-Atc', "select count(*) from pg_tables where schemaname='public'")
  if ($tables -ne '0') { Fail 'the new target database is not empty' }

  # -- 7 - the drill's settings, in the same private folder ---------------
  $drillUrl = 'postgresql://{0}:{1}@127.0.0.1:5432/{2}' -f [uri]::EscapeDataString($pgUser), [uri]::EscapeDataString("$pgPass"), [uri]::EscapeDataString($pgDb)
  $pgPass = $null
  $lines = $storeLines + @(
    "DRILL_DATABASE_URL=$drillUrl",
    'DRILL_CONFIRM_ISOLATED=yes'
  )
  $envFile = Join-Path $tmp 'drill.env'
  [IO.File]::WriteAllText($envFile, (($lines -join "`n") + "`n"), (New-Object Text.UTF8Encoding($false)))
  $drillUrl = $null; $lines = $null; $storeLines = $null

  # Every name the drill requires, checked before it runs (values never read back).
  $present = @(Get-Content -LiteralPath $envFile, $KeysFile | Where-Object { $_ -match '^[A-Z0-9_]+=.+' } | ForEach-Object { ($_ -split '=', 2)[0] })
  foreach ($n in 'DRILL_CONFIRM_ISOLATED', 'DRILL_DATABASE_URL', 'BACKUP_ENCRYPTION_PRIVATE_KEY', 'BACKUP_SIGNING_PUBLIC_KEY',
                 'BACKUP_S3_BUCKET', 'BACKUP_S3_ACCESS_KEY_ID', 'BACKUP_S3_SECRET_ACCESS_KEY', 'BACKUP_S3_REGION', 'BACKUP_S3_ENDPOINT') {
    if ($present -notcontains $n) { Fail "$n is not set" }
  }

  # -- 8 - the drill --------------------------------------------------------
  Write-Host "Restoring $Prefix$Object into $pgDb in $target (PostgreSQL 18, isolated) ..."
  $dockerArgs = @('run', '--rm', '--network', "container:$target",
    '-v', "${repo}:/app:ro", '--env-file', $KeysFile, '--env-file', $envFile,
    $Image, 'node', '/app/dist/scripts/backup.js', 'drill', $Object)
  $ErrorActionPreference = 'Continue'
  $output = @(& docker @dockerArgs 2>&1 | ForEach-Object { Hide-Secrets "$_" })
  $drillExit = $LASTEXITCODE
  $ErrorActionPreference = 'Stop'
  Remove-Item -LiteralPath $tmp -Recurse -Force; $tmp = $null

  $jsonLine = $output | Where-Object { $_.TrimStart().StartsWith('{') } | Select-Object -Last 1
  if (-not $jsonLine) { $output | ForEach-Object { Write-Host $_ }; Fail "the drill produced no report (exit $drillExit)" }
  Write-Host $jsonLine
  $report = $jsonLine | ConvertFrom-Json
  if ($drillExit -ne 0 -or -not (Prop $report 'ok')) { Fail "the drill failed: $(Prop $report 'error')" }

  # -- 9 - independent check, in the restored database itself --------------
  $sql = @'
SELECT 'public_tables', count(*)::text FROM pg_tables WHERE schemaname = 'public'
UNION ALL SELECT 'migration_head', coalesce(max(migration_name), '') FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
UNION ALL SELECT 'User', count(*)::text FROM "User"
UNION ALL SELECT 'Club', count(*)::text FROM "Club"
UNION ALL SELECT 'Team', count(*)::text FROM "Team"
UNION ALL SELECT 'Player', count(*)::text FROM "Player"
UNION ALL SELECT 'Membership', count(*)::text FROM "Membership";
'@
  $ErrorActionPreference = 'Continue'
  $rows = @($sql | & docker exec -i $target psql -U $pgUser -d $pgDb -At -F '|' -v ON_ERROR_STOP=1 2>&1 | ForEach-Object { "$_" })
  $queryExit = $LASTEXITCODE
  $ErrorActionPreference = 'Stop'
  if ($queryExit -ne 0) { Fail 'the restored database could not be queried' }
  $db = @{}
  foreach ($r in $rows) { $k, $v = "$r" -split '\|', 2; $db[$k] = $v }

  $checks = [ordered]@{
    'drill ok'                          = [bool](Prop $report 'ok')
    'schema head matches the backup'    = ((Prop $report 'migrationHead') -eq (Prop $report 'restoredMigrationHead')) -and ($db['migration_head'] -eq "$(Prop $report 'restoredMigrationHead')")
    'tables restored'                   = ([int](Prop $report 'tables') -gt 0) -and ($db['public_tables'] -eq "$(Prop $report 'tables')")
  }
  $rowCounts = Prop $report 'rowCounts'
  foreach ($t in 'User', 'Club', 'Team', 'Player', 'Membership') {
    $checks["$t rows match"] = ($db[$t] -eq "$(Prop $rowCounts $t)")
  }
  $failed = @($checks.GetEnumerator() | Where-Object { -not $_.Value } | ForEach-Object { $_.Key })
  $counts = ('User', 'Club', 'Team', 'Player', 'Membership' | ForEach-Object { "$_=$($db[$_])" }) -join ', '

  # The restored copy is removed before the summary, so an interrupted window
  # after PASS leaves nothing behind.
  if ($target -and -not $KeepDatabase) { Invoke-Quiet 'docker' @('rm', '-f', '-v', $target) | Out-Null; $target = $null }

  Write-Host ''
  Write-Host ("STEP 10 RESTORE DRILL: " + $(if ($failed.Count -eq 0) { 'PASS' } else { 'FAIL' }))
  Write-Host "Backup object: $Prefix$Object"
  Write-Host "Public tables restored: $($db['public_tables'])"
  Write-Host "Core row counts: $counts"
  Write-Host "Migration head: $($db['migration_head'])"
  Write-Host 'Production modified: NO (the drill had no production URL; it restored only into a throwaway container)'
  Write-Host 'Temporary plaintext removed: YES (none is written: decryption streams into pg_restore; the ciphertext and the env file are deleted)'
  if ($failed.Count -gt 0) { Fail ("checks failed: " + ($failed -join '; ')) }
}
finally {
  if ($tmp -and (Test-Path -LiteralPath $tmp)) { Remove-Item -LiteralPath $tmp -Recurse -Force }
  if ($target -and -not $KeepDatabase) { Invoke-Quiet 'docker' @('rm', '-f', '-v', $target) | Out-Null }
  elseif ($target) { Write-Host "Kept the restored database in container $target (remove it with: docker rm -f -v $target)" }
  $accessKeyId = $null; $secretKey = $null; $storeLines = $null
  Remove-Item Env:BACKUP_S3_ACCESS_KEY_ID, Env:BACKUP_S3_SECRET_ACCESS_KEY -ErrorAction SilentlyContinue
}
