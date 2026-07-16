---
name: asc-cli
description: The asc CLI — App Store Connect and Apple Ads API access from the shell (apps, builds, TestFlight, submissions, metadata, reviews, sales reports, ad campaigns).
---

# asc CLI

Authenticated via env: `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_PRIVATE_KEY_PATH`
(already set on this machine). The app is `$APP_BUNDLE_ID` on team `$APPLE_TEAM_ID`.

Command discovery:

```sh
asc --help
asc search "<anything>"        # full-text search over all commands/endpoints
```

Surface area (each has subcommands): `asc apps`, `asc builds` (upload, list),
`asc publish` (one-shot App Store/TestFlight flows), `asc submissions`,
`asc metadata`, `asc screenshots`, `asc reviews` (list, reply),
`asc sales report`, `asc analytics`, `asc ads` (Apple Search Ads).

The installed vendor `asc` skills document individual flows in depth.

Facts:

- Uploaded builds spend 5–30 minutes in ASC processing before they are usable.
- Sales reports lag ~1 day behind reality.
- App Store review replies happen here (`asc reviews reply`), not over email.
