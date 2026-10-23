# Installed runtime snapshot

`skills/sync-tripit/scripts/runtime-state.mjs` owns and is the only reader/writer of
`INSTALL_DIRECTORY/.sync-runtime.json`. The installer calls `seal` only after a
successful staged dependency installation, and `check` before reusing it.
Both commands emit a JSON result with `operation`, `ready`, `path` and
`requestedVersion`; the installer consumes it and emits its own single result.

Schema version 1 is one JSON object: `schema_version` (1), `requestedVersion`
(release semver), and `files` (relative managed file paths to SHA-256 hex strings).
The owner inventories the entrypoint, package metadata, library files and npm's
hidden lock. It checks their live bytes, installed package directories and local
resolution of required dependencies. It never imports the application or reads
`.env`. The snapshot proves installation completion, not authorization.

A missing, malformed, older, newer, or mismatched-version snapshot means no usable
prior state. A mismatch with the live filesystem also requires repair. The
installer stages a fresh pinned installation and the owner writes a new version-1
snapshot; unknown schemas are never interpreted or migrated in place. Configuration
is preserved. There are no readers in another release pipeline.
