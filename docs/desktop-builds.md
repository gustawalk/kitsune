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

SQLite is bundled in Rust; SQL Server uses the Rust TDS driver. PostgreSQL loads libpq and MySQL/MariaDB loads MariaDB Connector/C 3.

`scripts/prepare-runtime.ts` stages the client libraries that ordinary link-time dependency scanning cannot discover. On Windows it copies vcpkg release DLLs, their dependencies, the release MSVC runtime DLLs and license notices into the installed application directory. `scripts/check-windows-package.ps1` silently installs the setup into an isolated runner directory, checks the installed `Kitsune.exe` product name and coral icons in both application and setup, and loads both installed database DLLs with dependencies resolved from the installed directory and system paths.

The Debian package declares `libpq5` and `libmariadb3` dependencies. AppImage staging explicitly includes both shared libraries, their discovered dependencies and available license notices. AppImage still depends on a supported host graphics/webview environment; creating an archive is not proof that it launches on every Linux distribution. The hosted Linux artifact was downloaded and launched successfully here with `APPIMAGE_EXTRACT_AND_RUN=1`. Its GTK launcher explicitly selects X11/XWayland; prefer the Debian/native build for the host Wayland backend. The first hosted Debian and AppImage downloads measured 5,289,272 and 86,153,720 bytes respectively.

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

## Identity

Tauri product/window name: **Kitsune**. `mainBinaryName` gives `Kitsune.exe` on Windows and `Kitsune` on Linux. The Rust crate and Debian package retain lowercase `kitsune`. Desktop launchers use `Name=Kitsune`, `Exec=Kitsune`, `Icon=Kitsune`. The existing fox mark is derived from Kodama's icon with Kitsune coral `#E85D3F`; PNG, ICO and ICNS assets are configured, including NSIS installer and uninstaller icons.

Verification outcomes and run links are recorded in validation.md. The current product/footprint assessment is in product-review.md.
