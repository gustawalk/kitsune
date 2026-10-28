
# Isolated, checksum-pinned portable servers.
# Never installs a Windows service.

$ErrorActionPreference = 'Stop'

$root = Split-Path $PSScriptRoot -Parent
Set-Location $root

$fixture = Join-Path $root '.kitsune-engine-tests'
New-Item -ItemType Directory -Force -Path $fixture | Out-Null

# Make OpenSSL available for TLS fixture generation.
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

foreach ($server in $servers) {
    Write-Host "Testing $($server.Name) $($server.Version)..." -ForegroundColor Cyan

    $work = Join-Path $env:RUNNER_TEMP "kitsune-$($server.Name)-$([guid]::NewGuid())"

    New-Item -ItemType Directory -Force -Path $work | Out-Null

    $process = $null

    try {
        # Download server archive.
        $archive = Join-Path $work 'server.zip'

        Write-Host "Downloading $($server.Name)..."

        Invoke-WebRequest `
            -Uri $server.Url `
            -OutFile $archive `
            -MaximumRetryCount 3 `
            -RetryIntervalSec 5

        # Verify SHA-256 checksum.
        Write-Host 'Verifying SHA-256 checksum...'

        $actualHash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()

        if ($actualHash -ne $server.Hash) {
            throw @"
Server archive checksum mismatch:
Server:   $($server.Name)
Version:  $($server.Version)
Expected: $($server.Hash)
Actual:   $actualHash
URL:      $($server.Url)
"@
        }

        # Extract ZIP using Windows native tar.exe.
        # Explicit path avoids GNU tar from Git for Windows,
        # which interprets D:\ paths as remote host references.
        Write-Host 'Extracting server archive...'

        $windowsTar = Join-Path $env:SystemRoot 'System32\tar.exe'

        if (-not (Test-Path -LiteralPath $windowsTar)) {
            throw "Windows native tar.exe not found: $windowsTar"
        }

        & $windowsTar -xf $archive -C $work

        if ($LASTEXITCODE -ne 0) {
            throw "Server archive extraction failed for $($server.Name)"
        }

        # Resolve extracted directories.
        $base = Join-Path $work "$($server.Name)-$($server.Version)-winx64"
        $data = Join-Path $work 'data'
        $bin = Join-Path $base 'bin'

        if (-not (Test-Path -LiteralPath $bin -PathType Container)) {
            $directories = Get-ChildItem -LiteralPath $work -Directory |
                Select-Object -ExpandProperty Name

            throw "Server binaries directory not found: $bin. Extracted directories: $($directories -join ', ')"
        }

        $exe = if ($server.Name -eq 'mysql') {
            Join-Path $bin 'mysqld.exe'
        } else {
            Join-Path $bin 'mariadbd.exe'
        }

        $client = if ($server.Name -eq 'mysql') {
            Join-Path $bin 'mysql.exe'
        } else {
            Join-Path $bin 'mariadb.exe'
        }

        foreach ($binary in @($exe, $client)) {
            if (-not (Test-Path -LiteralPath $binary -PathType Leaf)) {
                throw "Required server executable not found: $binary"
            }
        }

        # Initialize disposable database.
        Write-Host 'Initializing disposable database...'

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

        # Prepare SQL fixture.
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

        # Configure disposable database server.
        $ini = Join-Path $work 'server.ini'

        $tls = (Join-Path $fixture 'tls').Replace('\', '/')
        $baseConfig = $base.Replace('\', '/')
        $dataConfig = $data.Replace('\', '/')
        $initConfig = $init.Replace('\', '/')
        $workConfig = $work.Replace('\', '/')

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

        # Start disposable server.
        Write-Host "Starting $($server.Name) on port $($server.Port)..."

        $process = Start-Process `
            -FilePath $exe `
            -ArgumentList "`"--defaults-file=$ini`"" `
            -PassThru `
            -ErrorAction Stop

        # Wait for SQL fixture to become available.
        $ready = $false

        $tlsArgs = if ($server.Name -eq 'mysql') {
            @('--ssl-mode=REQUIRED')
        } else {
            @('--ssl', '--disable-ssl-verify-server-cert')
        }

        $env:MYSQL_PWD = 'kitsune_test'

        try {
            for ($attempt = 0; $attempt -lt 60; $attempt++) {
                $process.Refresh()

                if ($process.HasExited) {
                    throw "Disposable server exited with code $($process.ExitCode)"
                }

                # Capture expected connection errors while the server starts.
                $probeOutput = & $client `
                    --no-defaults `
                    --protocol=tcp `
                    -h 127.0.0.1 `
                    "--port=$($server.Port)" `
                    -u kitsune_test `
                    @tlsArgs `
                    -N `
                    -e 'SELECT marker FROM kitsune_test.kitsune_fixture_identity' 2>&1

                if ($LASTEXITCODE -eq 0) {
                    $ready = $true
                    break
                }

                Start-Sleep -Seconds 1
            }
        }
        finally {
            Remove-Item Env:MYSQL_PWD -ErrorAction SilentlyContinue
        }

        if (-not $ready) {
            throw "Disposable $($server.Name) server did not initialize its fixture within 60 attempts"
        }

        Write-Host "$($server.Name) is ready." -ForegroundColor Green

        # Run Rust integration tests.
        Write-Host "Running $($server.Test)..."

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
        # Always remove temporary credentials.
        Remove-Item Env:MYSQL_PWD -ErrorAction SilentlyContinue

        # Stop disposable server.
        if ($null -ne $process) {
            try {
                $process.Refresh()

                if (-not $process.HasExited) {
                    Write-Host "Stopping $($server.Name)..."

                    Stop-Process `
                        -Id $process.Id `
                        -Force `
                        -ErrorAction SilentlyContinue

                    $process.WaitForExit(10000) | Out-Null
                }
            }
            finally {
                $process.Dispose()
            }
        }

        # Print last server log lines for diagnostics.
        $serverLog = Join-Path $work 'server.log'

        if (Test-Path -LiteralPath $serverLog) {
            Write-Host "Last $($server.Name) server log lines:"

            Get-Content -LiteralPath $serverLog -Tail 35
        }

        # Clean up isolated temporary directory.
        if (Test-Path -LiteralPath $work) {
            Write-Host "Cleaning up $work..."

            Remove-Item `
                -LiteralPath $work `
                -Recurse `
                -Force `
                -ErrorAction Continue
        }
    }
}

Write-Host 'All Windows database engine integration tests passed.' -ForegroundColor Green

