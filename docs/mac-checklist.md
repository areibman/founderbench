# Mac Mini Appliance Checklist

Every item pairs with the CLI command that proves it. `machine/verify.sh` runs most of
these automatically; this document is the human-readable walkthrough for provisioning
and for auditing the machine before a run.

**Isolation decision (recorded):** dedicated physical Mac mini, not a user on a shared
Mac. SIP relaxation, auto-login, never-sleep, disabled updates, and system TCC grants
are machine-wide; the dialog watchdog and simulators need exclusive ownership of the
GUI console session. Real containment lives at the account level (spending caps,
scoped credentials). Fallback if hardware can't be dedicated: a macOS VM (Tart/UTM)
with snapshot/restore — never a shared login.

## 1. Machine state

| # | Item | Verify with |
|---|------|-------------|
| 1.1 | Machine is dedicated (nothing else runs on it) | — (policy) |
| 1.2 | macOS version recorded and pinned | `sw_vers` |
| 1.3 | FileVault OFF (auto-login requires it) | `fdesetup status` → `Off` |
| 1.4 | Automatic login as the agent user | `defaults read /Library/Preferences/com.apple.loginwindow autoLoginUser` |
| 1.5 | Never sleep (system, disk, display) | `pmset -g \| grep -E 'sleep'` → all `0` |
| 1.6 | Screensaver disabled | `defaults -currentHost read com.apple.screensaver idleTime` → `0` |
| 1.7 | Screen lock off | System Settings → Lock Screen (or `sysadminctl -screenLock status`) |
| 1.8 | Auto macOS updates off (all channels) | `defaults read /Library/Preferences/com.apple.SoftwareUpdate AutomaticCheckEnabled` → `0` |
| 1.9 | App Store auto-update off | `defaults read /Library/Preferences/com.apple.commerce AutoUpdate` → `0` |
| 1.10 | SSH enabled (remote rescue) | `systemsetup -getremotelogin` → `On` |
| 1.11 | Screen Sharing enabled (remote rescue) | `launchctl print system/com.apple.screensharing` |
| 1.11a | Legacy-VNC password set (self-KVM auth) | `kickstart … -setvnclegacy -vnclegacy yes -setvncpw`; password stored mode-600 at `$VNC_PASSWORD_FILE` (default `~/.config/founderbench/vnc.pw`) |
| 1.11b | Self-KVM capture works (loopback framebuffer) | `vncdo -s 127.0.0.1::5900 --password-file … capture /tmp/s.png` → non-black image; verify.sh §3 gates this |
| 1.12 | Tailscale (or static IP) reachable | `tailscale status` / ping from another machine |
| 1.13 | Crash reporter dialogs off | `defaults read com.apple.CrashReporter DialogType` → `none` |
| 1.14 | SIP decision recorded | `csrutil status` (disabled on this appliance for TCC writes — deliberate) |
| 1.15 | APFS snapshot taken post-setup (reset baseline) | `tmutil listlocalsnapshots /` |
| 1.16 | Restart after power failure | `pmset -g \| grep autorestart` → `1` |

## 2. Toolchain

| # | Item | Verify with |
|---|------|-------------|
| 2.1 | Xcode installed + pinned version | `xcodebuild -version` (matches `XCODE_VERSION`) |
| 2.2 | Xcode license accepted | `xcodebuild -license check` (no prompt) |
| 2.3 | First-launch packages installed | `xcodebuild -runFirstLaunch` (exits 0, no dialog) |
| 2.4 | Command Line Tools | `xcode-select -p` |
| 2.5 | iOS simulator runtime | `xcrun simctl list runtimes \| grep iOS` |
| 2.6 | At least one iPhone simulator | `xcrun simctl list devices available \| grep iPhone` |
| 2.7 | Homebrew | `brew --version` |
| 2.8 | git, gh, node, python, ruby, go, jq, xcbeautify, xcodes | `command -v <each>` |
| 2.9 | `asc` CLI + skills | `asc --version`; skills in `~/.claude/skills/` |
| 2.10 | `agent-browser` + Chrome for Testing | `agent-browser doctor` |
| 2.11 | axmcp binaries (axmcp, xcmcp, ax, xc, computer-use-mcp) | `command -v axmcp xcmcp ax xc computer-use-mcp` |
| 2.11b | Peekaboo (full GUI automation) + permissions | `peekaboo permissions status`; `peekaboo list apps` |
| 2.12 | OpenCode | `opencode --version` |
| 2.13 | Fastlane (fallback) | `fastlane --version` |
| 2.14 | founderbench npm deps | `cd founderbench && npm install` exits 0 |

## 3. Permissions — the zero-dialog gates

| # | Item | Verify with |
|---|------|-------------|
| 3.1 | Accessibility TCC for ax binaries/opencode/node/Terminal | `ax apps` returns app list (no prompt) |
| 3.2 | Screen Recording TCC | `screencapture -x /tmp/t.png` produces a real screenshot (not just wallpaper) |
| 3.3 | Full Disk Access | orchestrator can read `~/Library/...` paths |
| 3.4 | AppleEvents (System Events) | `osascript -e 'tell app "System Events" to count processes'` (no prompt) |
| 3.5 | UI-automation mode enabled | `automationmodetool status` |
| 3.5b | Passwordless sudo (agent autonomy, stage 45) | `sudo -n true` (no prompt) |
| 3.5c | Full computer-use access in the RUN context (not just Terminal) | `env.preflight` event at run start shows `ok:true` |
| 3.6 | Build keychain exists, unlocked, 6h timeout | `security show-keychain-info founderbench.keychain-db` |
| 3.7 | Signing cert imported, partition list set | `security find-identity -v -p codesigning founderbench.keychain-db` |
| 3.8 | codesign runs non-interactively | archive step in `verify.sh` (no dialog) |
| 3.9 | git does NOT use login keychain | `git config --global credential.helper` → empty |
| 3.10 | No pending simulator/runtime download prompts | `xcodebuild -downloadPlatform iOS` exits 0 |
| 3.11 | Package managers have run once (no first-run prompts) | `brew list`, `npx -y cowsay ok` |

## 4. Credentials (each verified live by `machine/60-credentials.sh`)

| # | Credential | Verify with |
|---|-----------|-------------|
| 4.1 | ASC API key (key id, issuer id, .p8) | `asc apps list` |
| 4.2 | Apple team id + bundle id recorded | `credentials.env` |
| 4.3 | Distribution cert (.p12) imported | checklist 3.7 |
| 4.4 | Provisioning profiles installed (or ASC-managed) | `ls ~/Library/Developer/Xcode/UserData/Provisioning\ Profiles/` |
| 4.5 | Model API key (Azure OpenAI) | curl chat-completion round trip |
| 4.6 | Meta Marketing API token + ad account | `machine/60-credentials.sh` reads the configured account via Graph API |
| 4.7 | RevenueCat secret key | `curl api.revenuecat.com/v2/projects/<id>` |
| 4.8 | meow bank API key (CLI-issued via email flow; MFA on account; expires ~7 days — re-issue before long runs) | `npx @joinmeow/cli get-my-entity --api-key $MEOW_API_TOKEN` |
| 4.9 | Fastmail account + JMAP token | `curl api.fastmail.com/jmap/session` |
| 4.10 | Fastmail MCP OAuth at "send" level | `opencode mcp auth list` shows `fastmail` |
| 4.11 | Exa API key | curl search ping |
| 4.12 | Spending caps set AT THE ACCOUNT LEVEL (meow, Meta, Apple) | screenshot each account cap into `docs/` |

## 5. End-to-end proof (all non-interactive; any dialog = failure)

| # | Item | Verify with |
|---|------|-------------|
| 5.1 | App checkout at `APP_REPO_DIR` | `test -d "$APP_REPO_DIR/.git"` |
| 5.2 | Build for simulator | `xcodebuild build` |
| 5.3 | Tests on simulator | `xcodebuild test` |
| 5.4 | Simulator boots + screenshot | `simctl boot` + `simctl io screenshot` |
| 5.5 | Signed archive | `xcodebuild archive` |
| 5.6 | Export + TestFlight upload | `xcodebuild -exportArchive` + `asc builds upload` |
| 5.7 | OpenCode headless serves + health | `curl :4096/global/health` |
| 5.8 | All MCPs list tools | `opencode mcp list` (all connected) |

Run `machine/verify.sh` for the automated pass. **Rule: every blocker found during any
run gets fixed AND gets a new check added to `verify.sh`.**
