# Isolated, checksum-pinned portable servers. Never installs a Windows service.
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root
$fixture = Join-Path $root '.kitsune-engine-tests'
New-Item -ItemType Directory -Force $fixture | Out-Null
$openssl = 'C:/Program Files/Git/usr/bin'
if (Test-Path "$openssl/openssl.exe") { $env:PATH = "$openssl;$env:PATH" }
& bun scripts/engine-fixtures.ts certificates
if ($LASTEXITCODE -ne 0) { throw 'TLS fixture generation failed' }
$servers = @(
  @{ Name='mysql'; Version='8.4.7'; Port=53306; Url='https://cdn.mysql.com/archives/mysql-8.4/mysql-8.4.7-winx64.zip'; Hash='b03c506fba179591d47f2e42c4a7b17c1dab06faed9fe3cff5acbd4e4f053f16'; Test='ipc_tests::mysql_network_workflow_fixture' },
  @{ Name='mariadb'; Version='11.4.9'; Port=53307; Url='https://archive.mariadb.org/mariadb-11.4.9/winx64-packages/mariadb-11.4.9-winx64.zip'; Hash='802f9f40a9dca774a3ba62f39c21093942954f178d6d7d458dc51453929bcdda'; Test='ipc_tests::mariadb_network_workflow_fixture' }
)
foreach ($server in $servers) {
  $work = Join-Path $env:RUNNER_TEMP "kitsune-$($server.Name)-$([guid]::NewGuid())"
  New-Item -ItemType Directory $work | Out-Null
  $process = $null
  try {
    $archive = Join-Path $work 'server.zip'
    Invoke-WebRequest $server.Url -OutFile $archive -MaximumRetryCount 3 -RetryIntervalSec 5
    if ((Get-FileHash $archive -Algorithm SHA256).Hash.ToLower() -ne $server.Hash) { throw 'Server archive checksum mismatch' }
    & tar -xf $archive -C $work
    if ($LASTEXITCODE -ne 0) { throw 'Server archive extraction failed' }
    $base = Join-Path $work "$($server.Name)-$($server.Version)-winx64"
    $data = Join-Path $work 'data'
    $bin = Join-Path $base 'bin'
    if ($server.Name -eq 'mysql') {
      & "$bin/mysqld.exe" --no-defaults --initialize-insecure "--basedir=$base" "--datadir=$data" --console
    } else {
      & "$bin/mariadb-install-db.exe" "--datadir=$data" "--port=$($server.Port)"
    }
    if ($LASTEXITCODE -ne 0) { throw 'Disposable data directory initialization failed' }
    $init = Join-Path $work 'initialize.sql'
    $fixtureSql = [IO.File]::ReadAllLines((Join-Path $root 'tests/fixtures/mysql.sql')) | Where-Object { $_.Trim() -and !$_.TrimStart().StartsWith('--') }
    $sql = "CREATE DATABASE kitsune_test;`nCREATE USER 'kitsune_test'@'127.0.0.1' IDENTIFIED BY 'kitsune_test';`nCREATE USER 'kitsune_test'@'localhost' IDENTIFIED BY 'kitsune_test';`nGRANT ALL ON kitsune_test.* TO 'kitsune_test'@'127.0.0.1';`nGRANT ALL ON kitsune_test.* TO 'kitsune_test'@'localhost';`nUSE kitsune_test;`n" + ($fixtureSql -join "`n")
    [IO.File]::WriteAllText($init, $sql, [Text.UTF8Encoding]::new($false))
    $ini = Join-Path $work 'server.ini'
    $tls = (Join-Path $fixture 'tls').Replace('\','/')
    @"
[mysqld]
basedir=$($base.Replace('\','/'))
datadir=$($data.Replace('\','/'))
bind-address=127.0.0.1
port=$($server.Port)
require-secure-transport=ON
ssl-ca=$tls/ca.pem
ssl-cert=$tls/server.pem
ssl-key=$tls/server-key.pem
init-file=$($init.Replace('\','/'))
log-error=$($work.Replace('\','/'))/server.log
"@ | Set-Content $ini
    $exe = if ($server.Name -eq 'mysql') { "$bin/mysqld.exe" } else { "$bin/mariadbd.exe" }
    $process = Start-Process $exe -ArgumentList "`"--defaults-file=$ini`"" -PassThru
    $ready = $false
    $client = if ($server.Name -eq 'mysql') { "$bin/mysql.exe" } else { "$bin/mariadb.exe" }
    for ($attempt=0; $attempt -lt 60; $attempt++) {
      $process.Refresh()
      if ($process.HasExited) { throw "Disposable server exited: $($process.ExitCode)" }
      $env:MYSQL_PWD = 'kitsune_test'
      $tlsArgs = if ($server.Name -eq 'mysql') { @('--ssl-mode=REQUIRED') } else { @('--ssl','--disable-ssl-verify-server-cert') }
      & $client --no-defaults --protocol=tcp -h 127.0.0.1 "--port=$($server.Port)" -u kitsune_test @tlsArgs -N -e 'SELECT marker FROM kitsune_test.kitsune_fixture_identity' 2>$null
      if ($LASTEXITCODE -eq 0) { $ready=$true; break }
      Start-Sleep -Seconds 1
    }
    Remove-Item Env:MYSQL_PWD -ErrorAction SilentlyContinue
    if (!$ready) { throw 'Disposable server did not initialize its fixture' }
    & bun scripts/test-rust.ts $server.Test -- --exact --ignored --nocapture
    if ($LASTEXITCODE -ne 0) { throw "Live Windows fixture failed: $($server.Name)" }
  } finally {
    Remove-Item Env:MYSQL_PWD -ErrorAction SilentlyContinue
    if ($process) {
      $process.Refresh()
      if (!$process.HasExited) { Stop-Process -Id $process.Id -Force }
      $process.Dispose()
    }
    if (Test-Path "$work/server.log") { Get-Content "$work/server.log" -Tail 35 }
    Remove-Item $work -Recurse -Force
  }
}
