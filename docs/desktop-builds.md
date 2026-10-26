# Desktop builds

The project is connected to `git@github.com:gustawalk/kitsune.git` with branch `main`. Existing history was absent; the working application was imported without local databases, generated build outputs or test TLS keys. The GitHub repository remains private.

## Workflow

`.github/workflows/build-desktop.yml` follows Kodama's shared verification → platform builds → tag release pattern. Run **Build and release desktop application** from GitHub Actions, or:

```sh
gh workflow run build-desktop.yml --repo gustawalk/kitsune --ref main
```

Manual runs produce downloadable Windows and Linux artifacts and do not publish a release. Artifacts are retained for seven days. Pushing a `v*` tag requires matching package, Cargo and Tauri versions and a nonempty `docs/releases/<tag>.md`; only after successful Windows and Linux builds does the workflow publish release downloads. No tag was pushed during setup.

Current targets are Windows x64 NSIS setup and Linux amd64 Debian/AppImage. macOS, updater manifests and updater signing were not copied: Kitsune has no updater configured, and Kodama's identity, public key and secrets must not be reused. These builds are not Authenticode-signed. Windows trust warnings remain possible until dedicated application-signing credentials are configured.

The workflow pins Bun 1.4.0, uses Cargo's locked dependency graph, caches Rust compilation and pins the vcpkg source revision. Windows client libraries are built from that revision. Linux uses Ubuntu 22.04 to avoid the compatibility floor of builds made on a newer distribution. Hosted system packages and Rust stable can still change; the entire toolchain is not fully reproducible.

## Runtime libraries

SQLite is bundled in Rust; SQL Server uses the Rust TDS driver. PostgreSQL loads libpq; MySQL/MariaDB uses the Rust mysql_async/Rustls driver.

`scripts/prepare-runtime.ts` stages the client libraries that ordinary link-time dependency scanning cannot discover. On Windows it copies vcpkg release DLLs, their dependencies, the release MSVC runtime DLLs and license notices into the installed application directory. `scripts/check-windows-package.ps1` silently installs the setup into an isolated runner directory, checks the installed `Kitsune.exe` product name and coral icons in both application and setup, and loads installed libpq with dependencies resolved from the installed directory and system paths.

The Debian package declares the `libpq5` dependency. AppImage staging explicitly includes libpq, its discovered dependencies and available license notices. AppImage still depends on a supported host graphics/webview environment; creating an archive is not proof that it launches on every Linux distribution. The hosted Linux artifact was downloaded and launched successfully here with `APPIMAGE_EXTRACT_AND_RUN=1`. Its GTK launcher explicitly selects X11/XWayland; prefer the Debian/native build for the host Wayland backend. The first hosted Debian and AppImage downloads measured 5,289,272 and 86,153,720 bytes respectively.

Local development builds require native client libraries installed separately. Windows packaging requires `KITSUNE_VCPKG_INSTALLED` pointing at vcpkg's installed `x64-windows` directory and `KITSUNE_MSVC_REDIST` pointing at Visual Studio's x64 `Microsoft.VC*.CRT` redistributable directory, then:

```sh
bun scripts/prepare-runtime.ts
bun run tauri build --bundles nsis --ci --config src-tauri/tauri.runtime.conf.json
```

On Ubuntu with the workflow's dependencies installed, the same staging command prepares AppImage:

```sh
bun scripts/prepare-runtime.ts
bun run tauri build --bundles deb,appimage --ci --config src-tauri/tauri.runtime.conf.json
```

Generated `src-tauri/runtime/` and its merge configuration are ignored by Git. A source checkout is sufficient; local build outputs are never committed.

## Windows test harness

`bun run test:rust` runs Cargo normally on Linux/macOS. On Windows it uses `scripts/test-windows.ps1`: compile the test executables, embed `src-tauri/tests/windows-test.manifest` with the Windows SDK Manifest Tool, then execute the harnesses directly. Test filters and harness flags are supported, with an optional `--` separator; Windows Cargo build/profile selection flags are not forwarded by this helper. Windows SDK `mt.exe` is required. The helper runs unit/integration harnesses; there are currently no Rust doctests.

The Windows library harness imported `TaskDialogIndirect` but had no PE resource directory. Windows consequently selected legacy Common Controls, so the process exited with `STATUS_ENTRYPOINT_NOT_FOUND` before any test ran. The production executable already receives its manifest through Tauri. This is the [Tauri test manifest issue](https://github.com/tauri-apps/tauri/issues/13419); [Microsoft documents manifest embedding with mt.exe](https://learn.microsoft.com/en-us/windows/win32/sbscs/mt-exe). Calling Cargo a second time after patching rebuilt and replaced the test image, so the helper now executes the returned Cargo artifacts directly. Production resources and icons are unaffected by the test helper.

Native Windows libraries use a release-only vcpkg triplet and are cached immediately after preparation. Rust dependency caches are retained on failures too. Failed runs retain test binaries/DLLs for one day for loader diagnostics; they contain no user database fixture files.

## Identity

Tauri product/window name: **Kitsune**. `mainBinaryName` gives `Kitsune.exe` on Windows and `Kitsune` on Linux. The Rust crate and Debian package retain lowercase `kitsune`. Desktop launchers use `Name=Kitsune`, `Exec=Kitsune`, `Icon=Kitsune`. The existing fox mark is derived from Kodama's icon with Kitsune coral `#E85D3F`; PNG, ICO and ICNS assets are configured, including NSIS installer and uninstaller icons.

Verification outcomes and run links are recorded in validation.md. The current product/footprint assessment is in product-review.md.

MySQL/MariaDB now uses a Rust wire-protocol driver with Rustls, so packaging no longer requires libmariadb. Runtime staging clears stale files first. CI runs live MySQL/MariaDB workflows on Windows using checksum-pinned portable archives, and all four server families on Linux via isolated Docker fixtures. These tests precede packaging; setup verification still checks the installed executable, coral icon, libpq loading and startup.
