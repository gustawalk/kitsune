
# Isolated, checksum-pinned portable servers.
# Never installs a Windows service.

$ErrorActionPreference = 'Stop'

$root = Split-Path $PSScriptRoot -Parent
Set-Location $root

$fixture = Join-Path $root '.kitsune-engine-tests'
New-Item -ItemType Directory -Force -Path $fixture | Out-Null

# Make OpenSSL available for certificate generation.
$openssl = 'C:\Program Files\Git\usr\bin'

if (Test-Path (Join-Path $openssl 'openssl.exe')) {
    $env:PATH = "$openssl;$env:PATH"
}

# Generate TLS certificates.
& bun scripts/engine-fixtures.ts certificates

if ($LASTEXITCODE -ne 0) {
    throw 'TLS fixture generation failed'
}

# Portable database servers with pinned checksums.
$servers = @(
    @{
        Name    = 'mysql'
        Version = '8.4.7'
        Port    = 53306
        Url     = 'https://cdn.mysql.com/archives/mysql-8.4/mysql-8.4.7-winx64.zip'
        Hash    = 'fd9bdbd4b5a878d31c8e4067078bd60665b1b3c4677fa1f099416d194b458aff'
        Test    = 'ipc_tests::mysql_network_workflow_fixture'
    },
    @{
        Name    = 'mariadb'
        Version = '11.4.9'
        Port    = 53307
        Url     = 'https://archive.mariadb.org/mariadb-11.4.9/winx64-packages/mariadb-11.4.9-winx64.zip'
        Hash    = '802f9f40a9dca774a3ba62f39c21093942954f178d6d7d458dc51453929bcdda'
        Test    = 'ipc_tests::mariadb_network_workflow_fixture'
    }
)

# Convert Windows paths to forward-slash paths for configuration files.
function Convert-ToConfigPath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    return $Path.Replace('\', '/')
}

# Print server logs without masking the original failure.
function Show-ServerLog {
    param(
        [string]$WorkDirectory,
        [int]$Tail = 100
    )

    $logPath = Join-Path $WorkDirectory 'server.log'

    if (Test-Path -LiteralPath $logPath) {
        Write-Host '--- Database server log ---' -ForegroundColor Yellow

        Get-Content -LiteralPath $logPath -Tail $Tail -ErrorAction Continue

        Write-Host '--- End database server log ---' -ForegroundColor Yellow
    }
    else {
        Write-Warning "Server log not found: $logPath"
    }
}

# Stop the process, then wait for Windows to release its handles.
function Stop-DisposableServer {
    param(
        [System.Diagnostics.Process]$ServerProcess,
        [string]$ServerName
    )

    if ($null -eq $ServerProcess) {
        return
    }

    try {
        $ServerProcess.Refresh()

        if (-not $ServerProcess.HasExited) {
            Write-Host "Stopping $ServerName (PID $($ServerProcess.Id))..."

            Stop-Process `
                -Id $ServerProcess.Id `
                -Force `
                -ErrorAction Stop

            if (-not $ServerProcess.WaitForExit(15000)) {
                Write-Warning "$ServerName did not exit within 15 seconds"
            }
        }
    }
    catch {
        Write-Warning "Failed to stop $ServerName : $($_.Exception.Message)"
    }
    finally {
        $ServerProcess.Dispose()
    }
}

# Retry cleanup because Windows can retain file handles briefly.
function Remove-DisposableDirectory {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Directory,

        [int]$MaxAttempts = 10
    )

    for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
        if (-not (Test-Path -LiteralPath $Directory)) {
            return
        }

        try {
            Remove-Item `
                -LiteralPath $Directory `
                -Recurse `
                -Force `
                -ErrorAction Stop

            return
        }
        catch {
            if ($attempt -eq $MaxAttempts) {
                Write-Warning "Unable to remove $Directory after $MaxAttempts attempts: $($_.Exception.Message)"
                return
            }

            Write-Host "Cleanup attempt $attempt failed; retrying..."
            Start-Sleep -Seconds 2
        }
    }
}

foreach ($server in $servers) {
    Write-Host ""
    Write-Host "========================================" -ForegroundColor Cyan
    Write-Host "Testing $($server.Name) $($server.Version)" -ForegroundColor Cyan
    Write-Host "========================================" -ForegroundColor Cyan

    $work = Join-Path $env:RUNNER_TEMP "kitsune-$($server.Name)-$([guid]::NewGuid())"

    New-Item -ItemType Directory -Force -Path $work | Out-Null

    $process = $null

    try {
        # ------------------------------------------------------------
        # 1. Download server archive.
        # ------------------------------------------------------------

        $archive = Join-Path $work 'server.zip'

        Write-Host "Downloading $($server.Name)..."

        Invoke-WebRequest `
            -Uri $server.Url `
            -OutFile $archive `
            -MaximumRetryCount 3 `
            -RetryIntervalSec 5

        # ------------------------------------------------------------
        # 2. Verify SHA-256 checksum.
        # ------------------------------------------------------------

        Write-Host 'Verifying SHA-256 checksum...'

        $actualHash = (
            Get-FileHash -LiteralPath $archive -Algorithm SHA256
        ).Hash.ToLowerInvariant()

        if ($actualHash -ne $server.Hash) {
            throw @"
Server archive checksum mismatch.
Server:   $($server.Name)
Version:  $($server.Version)
Expected: $($server.Hash)
Actual:   $actualHash
URL:      $($server.Url)
"@
        }

        Write-Host 'Checksum verified.' -ForegroundColor Green

        # ------------------------------------------------------------
        # 3. Extract ZIP using Windows native tar.exe.
        # ------------------------------------------------------------

        Write-Host 'Extracting server archive...'

        $windowsTar = Join-Path $env:SystemRoot 'System32\tar.exe'

        if (-not (Test-Path -LiteralPath $windowsTar)) {
            throw "Windows tar.exe not found: $windowsTar"
        }

        & $windowsTar -xf $archive -C $work

        if ($LASTEXITCODE -ne 0) {
            throw "Server archive extraction failed for $($server.Name)"
        }

        # ------------------------------------------------------------
        # 4. Resolve executable paths.
        # ------------------------------------------------------------

        $base = Join-Path $work "$($server.Name)-$($server.Version)-winx64"
        $data = Join-Path $work 'data'
        $bin = Join-Path $base 'bin'

        if (-not (Test-Path -LiteralPath $bin -PathType Container)) {
            $directories = Get-ChildItem -LiteralPath $work -Directory |
                Select-Object -ExpandProperty Name

            throw "Server bin directory not found: $bin. Extracted directories: $($directories -join ', ')"
        }

        if ($server.Name -eq 'mysql') {
            $exe = Join-Path $bin 'mysqld.exe'
            $client = Join-Path $bin 'mysql.exe'
        }
        else {
            $exe = Join-Path $bin 'mariadbd.exe'
            $client = Join-Path $bin 'mariadb.exe'
        }

        foreach ($binary in @($exe, $client)) {
            if (-not (Test-Path -LiteralPath $binary -PathType Leaf)) {
                throw "Required executable not found: $binary"
            }
        }

        # ------------------------------------------------------------
        # 5. Initialize disposable database directory.
        # ------------------------------------------------------------

        Write-Host "Initializing $($server.Name) data directory..."

        if ($server.Name -eq 'mysql') {
            & $exe `
                --no-defaults `
                --initialize-insecure `
                "--basedir=$base" `
                "--datadir=$data" `
                --console
        }
        else {
            $installDb = Join-Path $bin 'mariadb-install-db.exe'

            if (-not (Test-Path -LiteralPath $installDb)) {
                throw "MariaDB initialization executable not found: $installDb"
            }

            & $installDb `
                "--datadir=$data" `
                "--port=$($server.Port)"
        }

        if ($LASTEXITCODE -ne 0) {
            throw "Disposable data directory initialization failed for $($server.Name)"
        }

        # ------------------------------------------------------------
        # 6. Prepare SQL fixture.
        # ------------------------------------------------------------

        Write-Host 'Preparing SQL fixture...'

        $init = Join-Path $work 'initialize.sql'
        $fixturePath = Join-Path $root 'tests/fixtures/mysql.sql'

        if (-not (Test-Path -LiteralPath $fixturePath)) {
            throw "SQL fixture not found: $fixturePath"
        }

        $fixtureSql = [IO.File]::ReadAllLines($fixturePath) |
            Where-Object {
                $_.Trim() -and
                -not $_.TrimStart().StartsWith('--')
            }

        $sql = @"
CREATE DATABASE kitsune_test;
CREATE USER 'kitsune_test'@'127.0.0.1' IDENTIFIED BY 'kitsune_test';
CREATE USER 'kitsune_test'@'localhost' IDENTIFIED BY 'kitsune_test';
GRANT ALL ON kitsune_test.* TO 'kitsune_test'@'127.0.0.1';
GRANT ALL ON kitsune_test.* TO 'kitsune_test'@'localhost';
USE kitsune_test;
"@ + "`n" + ($fixtureSql -join "`n")

        [IO.File]::WriteAllText(
            $init,
            $sql,
            [Text.UTF8Encoding]::new($false)
        )

        # ------------------------------------------------------------
        # 7. Configure server.
        # ------------------------------------------------------------

        Write-Host 'Creating server configuration...'

        $ini = Join-Path $work 'server.ini'

        $tls = Convert-ToConfigPath (Join-Path $fixture 'tls')
        $baseConfig = Convert-ToConfigPath $base
        $dataConfig = Convert-ToConfigPath $data
        $initConfig = Convert-ToConfigPath $init
        $workConfig = Convert-ToConfigPath $work

        @"
[mysqld]
basedir=$baseConfig
datadir=$dataConfig
bind-address=127.0.0.1
port=$($server.Port)
require-secure-transport=ON
ssl-ca=$tls/ca.pem
ssl-cert=$tls/server.pem
ssl-key=$tls/server-key.pem
init-file=$initConfig
log-error=$workConfig/server.log
"@ | Set-Content -LiteralPath $ini -Encoding utf8

        # ------------------------------------------------------------
        # 8. Start disposable database server.
        # ------------------------------------------------------------

        Write-Host "Starting $($server.Name) on port $($server.Port)..."

        $process = Start-Process `
            -FilePath $exe `
            -ArgumentList "`"--defaults-file=$ini`"" `
            -PassThru `
            -ErrorAction Stop

        Write-Host "Started process PID: $($process.Id)"

        # ------------------------------------------------------------
        # 9. Wait for server readiness.
        # ------------------------------------------------------------

        Write-Host 'Waiting for SQL fixture readiness...'

        $ready = $false
        $lastProbeError = ''

        $tlsArgs = if ($server.Name -eq 'mysql') {
            @('--ssl-mode=REQUIRED')
        }
        else {
            @('--ssl', '--disable-ssl-verify-server-cert')
        }

        $env:MYSQL_PWD = 'kitsune_test'

        try {
            for ($attempt = 0; $attempt -lt 60; $attempt++) {
                $process.Refresh()

                if ($process.HasExited) {
                    Show-ServerLog -WorkDirectory $work

                    throw "Disposable $($server.Name) server exited with code $($process.ExitCode)"
                }

                # Temporarily permit native command errors so we can
                # capture connection failures without terminating the script.
                $previousErrorAction = $ErrorActionPreference

                try {
                    $ErrorActionPreference = 'Continue'
                    # Isolate the client from runner-level my.ini/my.cnf files.
                    # MySQL's --no-defaults must be its first argument, and
                    # MYSQL_HOME otherwise points at global client options.
                    $previousMysqlHome = $env:MYSQL_HOME
                    $env:MYSQL_HOME = $work

                    $probeOutput = & $client `
                        --no-defaults `
                        --protocol=tcp `
                        -h 127.0.0.1 `
                        "--port=$($server.Port)" `
                        -u kitsune_test `
                        @tlsArgs `
                        -N `
                        -e 'SELECT marker FROM kitsune_test.kitsune_fixture_identity' 2>&1

                    $probeExitCode = $LASTEXITCODE
                }
                finally {
                    if ($null -eq $previousMysqlHome) {
                        Remove-Item Env:MYSQL_HOME -ErrorAction SilentlyContinue
                    }
                    else {
                        $env:MYSQL_HOME = $previousMysqlHome
                    }

                    $ErrorActionPreference = $previousErrorAction
                }

                if ($probeExitCode -eq 0) {
                    $ready = $true
                    Write-Host "SQL fixture ready after $($attempt + 1) attempts." -ForegroundColor Green
                    break
                }

                $lastProbeError = ($probeOutput | Out-String).Trim()

                # Print the first failure, then every 10 attempts.
                if ($attempt -eq 0 -or (($attempt + 1) % 10 -eq 0)) {
                    Write-Warning "Readiness attempt $($attempt + 1)/60 failed: $lastProbeError"
                }

                Start-Sleep -Seconds 1
            }
        }
        finally {
            Remove-Item Env:MYSQL_PWD -ErrorAction SilentlyContinue
        }

        if (-not $ready) {
            Show-ServerLog -WorkDirectory $work

            throw "Disposable $($server.Name) server did not initialize its fixture within 60 attempts. Last probe error: $lastProbeError"
        }

        # ------------------------------------------------------------
        # 10. Run Rust integration tests.
        # ------------------------------------------------------------

        Write-Host "Running integration test: $($server.Test)"

        & bun scripts/test-rust.ts `
            $server.Test `
            -- `
            --exact `
            --ignored `
            --nocapture

        if ($LASTEXITCODE -ne 0) {
            throw "Live Windows fixture failed: $($server.Name)"
        }

        Write-Host "$($server.Name) integration tests passed." -ForegroundColor Green
    }
    finally {
        # ------------------------------------------------------------
        # 11. Stop and clean up.
        # ------------------------------------------------------------

        Remove-Item Env:MYSQL_PWD -ErrorAction SilentlyContinue

        Stop-DisposableServer `
            -ServerProcess $process `
            -ServerName $server.Name

        Show-ServerLog -WorkDirectory $work -Tail 50

        Write-Host "Cleaning up $work..."

        Remove-DisposableDirectory `
            -Directory $work `
            -MaxAttempts 10
    }
}

Write-Host ''
Write-Host 'All Windows database engine integration tests passed.' -ForegroundColor Green

