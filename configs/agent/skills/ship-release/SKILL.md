---
name: ship-release
description: Ship an app release end to end — build, test, archive, sign, upload to TestFlight, and submit to the App Store. Use whenever you need to release code changes to users.
---

# Ship a release

All steps are CLI-only. If any step pops a GUI dialog, that is an environment bug —
log it to BUSINESS_LOG.md and report it in your decision entry.

Environment: `$APP_XCODE_SCHEME`, `$APP_XCODE_WORKSPACE`/`$APP_XCODE_PROJECT`,
`$APPLE_TEAM_ID`, `$APP_BUNDLE_ID` are set. The build keychain is `founderbench.keychain-db`.

## 1. Pre-flight

```sh
git status                 # commit or stash everything first
security unlock-keychain -p "$FB_KEYCHAIN_PASSWORD" founderbench.keychain-db
```

## 2. Build + test (simulator, unsigned — fast feedback)

```sh
xcodebuild -workspace "$APP_XCODE_WORKSPACE" -scheme "$APP_XCODE_SCHEME" \
  -destination 'platform=iOS Simulator,name=iPhone 16' \
  build test CODE_SIGNING_ALLOWED=NO | xcbeautify
```

Fix every failure before proceeding. Never ship with red tests.

## 3. Bump version/build number

```sh
agvtool next-version -all                       # build number
# marketing version only for feature releases:
# agvtool new-marketing-version 1.2.0
```

## 4. Archive (signed)

```sh
xcodebuild -workspace "$APP_XCODE_WORKSPACE" -scheme "$APP_XCODE_SCHEME" \
  -destination 'generic/platform=iOS' \
  -archivePath ~/work/release.xcarchive archive \
  DEVELOPMENT_TEAM="$APPLE_TEAM_ID" | xcbeautify
```

## 5. Export + upload to TestFlight

Prefer the one-shot `asc publish` flow:

```sh
xcodebuild -exportArchive -archivePath ~/work/release.xcarchive \
  -exportOptionsPlist ExportOptions.plist -exportPath ~/work/export
asc builds upload --app "$APP_BUNDLE_ID" --ipa ~/work/export/*.ipa
```

Then poll processing status:

```sh
asc builds list --app "$APP_BUNDLE_ID" --limit 3
```

Processing takes 5–30 min. Do other work and check back; don't busy-wait.

## 6. Submit to App Store (when ready for public release)

```sh
asc publish appstore --app "$APP_BUNDLE_ID" --ipa ~/work/export/*.ipa \
  --version "<marketing version>" --submit --confirm
```

Check review status later with `asc submissions list --app "$APP_BUNDLE_ID"`.
If rejected: read the rejection (`asc submissions get ...`), fix, re-submit, and log it.

## 7. Verify + record

- Confirm the build shows up in TestFlight (`asc builds list`).
- Tag the commit: `git tag v<version>-b<build> && git push --tags`.
- Append the release entry to BUSINESS_LOG.md (version, changes, why now).

For deeper ASC operations (metadata, screenshots, phased release), load the vendor
`asc` skills installed on this machine.
