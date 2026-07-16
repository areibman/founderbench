---
name: xcode-cli
description: Xcode from the shell — xcodebuild, agvtool, simulators (simctl/xc/xcmcp), and how code signing is wired on this machine.
---

# Xcode CLI surface

Project env (already set): `$APP_XCODE_SCHEME`, `$APP_XCODE_WORKSPACE` /
`$APP_XCODE_PROJECT`, `$APPLE_TEAM_ID`.

Tools:

- `xcodebuild` — build, test, archive, `-exportArchive`. `-destination` selects
  simulator vs `generic/platform=iOS`. `CODE_SIGNING_ALLOWED=NO` builds unsigned
  (simulator). Pipe through `xcbeautify` for readable output.
- `agvtool` — build number (`next-version -all`) and marketing version
  (`new-marketing-version <v>`).
- Simulators: `xcrun simctl` (list/boot/screenshot/install), or the `xc` CLI and
  `xcmcp` MCP for structured equivalents.

Signing facts:

- Signing certs live in the dedicated keychain `founderbench.keychain-db`,
  unlockable non-interactively:
  `security unlock-keychain -p "$FB_KEYCHAIN_PASSWORD" founderbench.keychain-db`
- Signed operations take `DEVELOPMENT_TEAM="$APPLE_TEAM_ID"`.
- Everything here is CLI-only and dialog-free by machine design; any GUI dialog
  that appears is an environment bug worth recording.
