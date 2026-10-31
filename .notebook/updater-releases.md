# Signed updater and release flow

Entry: `src/components/Updates.tsx` mounts once from `App.tsx`; `lib/use-updater.ts:startUpdater()` checks once in packaged desktop builds, skips dev/browser startup checks.
- `lib/updater.ts:createUpdater()` owns shared state; Settings and status bar subscribe to the same instance. Checks/installs deduplicate synchronously. Confirmation precedes download. Failed download retains the update for retry; failed relaunch retains installed state and offers restart without another download.
- `lib/use-updater.ts` blocks installation/restart for unsaved SQL or active editor transactions. `components/Updates.tsx` displays server notes as plain text and loads local versioned patch notes using Vite glob imports.
- `src-tauri/tauri.conf.json` embeds Kitsune’s own public key and public GitHub updater endpoint. Private signing identity lives in ignored `.kitsune-signing/`, with an explicit backup archive. GitHub Actions uses `KITSUNE_TAURI_SIGNING_PRIVATE_KEY` and `KITSUNE_TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, configured with user approval on 2026-10-30. Never regenerate the shipping identity.
- `.github/workflows/build-desktop.yml`: common checks → signed Windows NSIS/Linux Debian + AppImage → tag-only publication with `updater.json`. Temporary platform artifacts removed only after publication; manual runs retain them for seven days.
- `scripts/check-release.ts` matches package/Cargo/Tauri versions, tag and notes. `scripts/generate-updater-manifest.ts` requires each signed platform. Linux uses bundle-specific keys so Debian receives .deb, AppImage receives .AppImage (verified against updater plugin 2.10.1 source).
- `tests/updater.test.ts` / `tests/updater-manifest.test.ts` cover transitions, progress, failures, manifest routing and malformed release inputs. Browser fixture: `/tmp/playwright-test-kitsune-updater.js`. Maintainer instructions: `docs/desktop-builds.md`.

Updated: 2026-10-30


- Update presentation follows Kodama: native Radix dialog with icon/kicker, version-change badge, inset notes panel, download progress and separated action footer. `components/ReleaseNotes.tsx` renders text-only headings/lists/paragraphs plus inline bold/code; no HTML injection. Patch-note history uses expandable version panels.
- `features/Settings.tsx` organizes existing preferences into General/Appearance/Database/Monitoring/SQL editor/Privacy. Panels stay mounted to retain drafts; invalid form fields select their containing panel before focus. Header submit button targets the settings form; store comparison drives unsaved/saved feedback. About/version controls remain shared with the updater singleton. Visual and interaction fixture: `/tmp/playwright-test-kitsune-settings-polish.js`.
