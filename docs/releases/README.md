# Release notes

Add `vX.Y.Z.md` for each stable release, headed `# Kitsune vX.Y.Z`, with a concise
list of changes. Keep the version aligned with package.json, Cargo.toml and
Tauri configuration. `bun scripts/check-release.ts` validates the release inputs.

These files appear automatically in Settings → View patch notes. The matching
file is embedded in the GitHub release and updater manifest. See
[desktop builds](../desktop-builds.md#updater-signing-and-version-releases) for
signing setup and publication.
