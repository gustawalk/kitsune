# Tauri embeds Common Controls v6 in application binaries, but not lib test harnesses.
# Without it, TaskDialogIndirect fails to resolve before Rust can start the tests.
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root
$testArgs = @($args)
$tool = Get-ChildItem "${env:ProgramFiles(x86)}/Windows Kits/10/bin/*/x64/mt.exe" |
  Sort-Object FullName -Descending | Select-Object -First 1
if (!$tool) { throw 'Install the Windows SDK Manifest Tool (mt.exe) to run desktop tests.' }
$manifest = Join-Path $root 'src-tauri/tests/windows-test.manifest'
$lines = & cargo test --manifest-path src-tauri/Cargo.toml --locked --no-run --message-format=json @testArgs
if ($LASTEXITCODE -ne 0) { throw 'Rust test compilation failed' }
$executables = @($lines | ForEach-Object {
  $artifact = $_ | ConvertFrom-Json
  if ($artifact.reason -eq 'compiler-artifact' -and $artifact.profile.test -and $artifact.executable) {
    $artifact.executable
  }
})
if (!$executables.Count) { throw 'Cargo produced no test executables' }
foreach ($executable in $executables) {
  $directory = Split-Path $executable -Parent
  if (Test-Path src-tauri/runtime) {
    Copy-Item src-tauri/runtime/*.dll $directory
  }
  & $tool.FullName -nologo -manifest $manifest "-outputresource:$executable;#1"
  if ($LASTEXITCODE -ne 0) { throw "Cannot embed test manifest: $executable" }
}
& cargo test --manifest-path src-tauri/Cargo.toml --locked @testArgs
exit $LASTEXITCODE
