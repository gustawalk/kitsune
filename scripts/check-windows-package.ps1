$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class KitsuneNativeCheck {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern IntPtr LoadLibraryEx(string path, IntPtr reserved, uint flags);
  [DllImport("kernel32.dll", CharSet=CharSet.Ansi)]
  public static extern IntPtr GetProcAddress(IntPtr module, string name);
  [DllImport("kernel32.dll")]
  public static extern bool FreeLibrary(IntPtr module);
}
'@
function Assert-KitsuneIcon([string]$Path) {
  $icon = [System.Drawing.Icon]::ExtractAssociatedIcon((Resolve-Path $Path))
  if (!$icon) { throw "Missing icon: $Path" }
  $bitmap = $icon.ToBitmap()
  try {
    $coral = $false
    for ($x=0; $x -lt $bitmap.Width; $x++) {
      for ($y=0; $y -lt $bitmap.Height; $y++) {
        $pixel=$bitmap.GetPixel($x,$y)
        if ($pixel.A -gt 128 -and $pixel.R -ge 210 -and $pixel.G -ge 70 -and $pixel.G -le 115 -and $pixel.B -ge 40 -and $pixel.B -le 90) { $coral=$true }
      }
    }
    if (!$coral) { throw "Kitsune coral icon missing: $Path" }
  } finally { $bitmap.Dispose(); $icon.Dispose() }
}
$installer = @(Get-ChildItem 'src-tauri/target/release/bundle/nsis' -Filter 'Kitsune*setup.exe')
if ($installer.Count -ne 1) { throw 'Expected one Kitsune installer' }
Assert-KitsuneIcon $installer[0].FullName
$destination = Join-Path $env:RUNNER_TEMP 'kitsune-install-smoke'
$process=Start-Process -FilePath $installer[0].FullName -ArgumentList '/S',"/D=$destination" -Wait -PassThru
if ($process.ExitCode -ne 0) { throw "Installer failed: $($process.ExitCode)" }
foreach ($dll in @('vcruntime140.dll','msvcp140.dll')) {
  if (!(Test-Path (Join-Path $destination $dll))) { throw "Missing packaged MSVC runtime: $dll" }
}
$app=Join-Path $destination 'Kitsune.exe'
if (!(Test-Path $app)) { throw 'Installed Kitsune.exe missing' }
if ((Get-Item $app).VersionInfo.ProductName -ne 'Kitsune') { throw 'Incorrect executable product name' }
Assert-KitsuneIcon $app
foreach ($entry in @(@{ File='libpq.dll'; Symbol='PQlibVersion' })) {
  $path=Join-Path $destination $entry.File
  if (!(Test-Path $path)) { throw "Missing packaged driver: $path" }
  # Resolve dependent DLLs from this installed directory and safe system directories.
  $handle=[KitsuneNativeCheck]::LoadLibraryEx($path,[IntPtr]::Zero,0x1100)
  if ($handle -eq [IntPtr]::Zero) { throw "Cannot load installed driver: $path (Win32 $([Runtime.InteropServices.Marshal]::GetLastWin32Error()))" }
  try {
    if ([KitsuneNativeCheck]::GetProcAddress($handle,$entry.Symbol) -eq [IntPtr]::Zero) { throw "Driver API missing: $($entry.Symbol)" }
  } finally { [void][KitsuneNativeCheck]::FreeLibrary($handle) }
}
$launched=Start-Process -FilePath $app -PassThru
try {
  Start-Sleep -Seconds 5
  $launched.Refresh()
  if ($launched.HasExited) { throw "Installed Kitsune exited during startup: $($launched.ExitCode)" }
} finally {
  if (!$launched.HasExited) {
    [void]$launched.CloseMainWindow()
    if (!$launched.WaitForExit(5000)) { Stop-Process -Id $launched.Id -Force }
  }
  $launched.Dispose()
}
Write-Host 'Installed Kitsune launch, executable name, coral icons and native database driver dependencies verified.' 
