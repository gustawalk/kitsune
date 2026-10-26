# Product direction review — 2026-10-26

Kitsune still follows its original purpose: a local database investigation environment with conventional SQL tools. It is useful today for browsing, editing with reviewed writes, inspecting relationships, observing bounded watches and reviewing observed changes. The earlier native four-engine smoke and integration results are recorded in validation.md. This assessment does not certify every original version 0.1 acceptance criterion.

## Lightweight

The release uses the system WebKit runtime rather than shipping Chromium. Workspace bundles are lazy-loaded, data grids render visible rows, table browsing defaults to 100 rows and the request cache has a 24 MiB budget. The measured Linux release executable is about 12 MB and its Debian archive about 5.3 MB, excluding installed system dependencies. AppImage and Windows distributions include additional runtime dependencies and will be larger.

A fresh-profile native release measurement on the current Linux desktop took 0.887 seconds from WebDriver session creation to a rendered sidebar. After five seconds idle, the application plus its two WebKit child processes used 573.47 MiB summed RSS and 320.90 MiB summed proportional set size (PSS). RSS double-counts shared pages. Over the following five seconds these processes consumed 0.0% of one CPU core at the sampling resolution. The driver processes were excluded from memory/CPU totals. This is one automation-assisted run, not a benchmark distribution, and includes no connections or open data tabs. Hardware, WebKit version, graphics and warm caches affect the result.

Verdict: compact download and responsive startup; moderate idle memory. Do not advertise extremely low memory based on the Tauri choice alone.

## Friendly and useful

Native screenshots confirmed a restrained desktop layout, visible connection entry point, consistent coral branding and an unclipped four-engine chooser. A fresh temporary SQLite fixture was connected through genuine release IPC; the visible orders grid opened and double-clicking a status value opened its edit dialog. The core path is coherent: connection → table → record → investigation/watch → observations. Radix-based controls, Lucide icons, keyboard shortcuts, file selection, native SQL grammars and explanatory disconnected states support everyday use. No remote fonts, cloud account, telemetry or AI dependency is required.

Corrected stale onboarding engine copy and replaced implementation jargon in the engine cards. Native fixture browsing also exposed a write-mode mismatch after webview reload: bootstrap omitted the live session mode. It now returns the actual mode to keep the header and editing controls consistent; a regression covers toggles and disconnects. SQL safety and polling limitations must remain visible where they affect a decision. The welcome screen is more spacious than a working data view; future polish should preserve the compact working grids rather than add dashboard panels.

## Next improvements, in order

1. Reduce background work from inactive tabs. App.tsx keeps open workspaces mounted; useRemote and several workspace subscriptions can continue work while hidden. Preserve editor state and deliberate watches while suspending incidental refreshes.
2. Add selector-based workspace subscriptions. The current shared store notifies all consumers on every change, including periodic watch status. Avoid unchanged status updates and measure render counts before replacing state infrastructure.
3. Run repeatable profiles with 1, 10 and 30 tabs plus bounded watches. Measure PSS, CPU, interaction latency and graph expansion, not just bundle sizes. Compare cold and warm launches.
4. Broaden native user-flow acceptance: connection form typing, keyboard-only editing, reviewed bulk writes, long schemas and smaller windows. Previous network tests establish backend behavior, not every click path.
5. Resolve MySQL strict certificate authentication before recommending remote production use. verify-full currently fails closed; encryption-only require does not authenticate a server certificate. Keep unsupported operations explicit.

Packaging now uses the product name Kitsune and its coral icon for executables, desktop launchers and NSIS installer/uninstaller. See desktop-builds.md for workflow behavior and verification results.
