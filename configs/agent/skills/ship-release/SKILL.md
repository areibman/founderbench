---
name: ship-release
description: Reference for the release pipeline — build, test, archive, sign, upload to TestFlight, and submit to the App Store, all from the CLI.
---

# Release pipeline reference

All steps are CLI-only. If any step pops a GUI dialog, that is an environment bug —
log it to BUSINESS_LOG.md with the exact command that triggered it.

Environment: `$APP_XCODE_SCHEME`, `$APP_XCODE_WORKSPACE`/`$APP_XCODE_PROJECT`,
`$APPLE_TEAM_ID`, `$APP_BUNDLE_ID` are set. The build keychain is `founderbench.keychain-db`:

```sh
security unlock-keychain -p "$FB_KEYCHAIN_PASSWORD" founderbench.keychain-db
```

## Build + test (simulator, unsigned — fast feedback)

```sh
xcodebuild -workspace "$APP_XCODE_WORKSPACE" -scheme "$APP_XCODE_SCHEME" \
  -destination 'platform=iOS Simulator,name=iPhone 16' \
  build test CODE_SIGNING_ALLOWED=NO | xcbeautify
```

## Version/build number

```sh
agvtool next-version -all                       # build number
agvtool new-marketing-version 1.2.0             # marketing version
```

## Archive (signed)

```sh
xcodebuild -workspace "$APP_XCODE_WORKSPACE" -scheme "$APP_XCODE_SCHEME" \
  -destination 'generic/platform=iOS' \
  -archivePath ~/work/release.xcarchive archive \
  DEVELOPMENT_TEAM="$APPLE_TEAM_ID" | xcbeautify
```

## Export + upload to TestFlight

```sh
xcodebuild -exportArchive -archivePath ~/work/release.xcarchive \
  -exportOptionsPlist ExportOptions.plist -exportPath ~/work/export
asc builds upload --app "$APP_BUNDLE_ID" --ipa ~/work/export/*.ipa
asc builds list --app "$APP_BUNDLE_ID" --limit 3     # poll processing status
```

Gotcha: ASC processing takes 5–30 min after upload before the build is usable.

## Submit to the App Store

```sh
asc publish appstore --app "$APP_BUNDLE_ID" --ipa ~/work/export/*.ipa \
  --version "<marketing version>" --submit --confirm
asc submissions list --app "$APP_BUNDLE_ID"          # review status
asc submissions get <id>                             # rejection details
```

## Verifying a release happened

- `asc builds list` shows the build in TestFlight.
- Tag the commit: `git tag v<version>-b<build> && git push --tags`.

For deeper ASC operations (metadata, screenshots, phased release), load the vendor
`asc` skills installed on this machine.
