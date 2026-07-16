---
name: vncdotool
description: "Drive this machine's own GUI over a loopback VNC connection when the normal computer-use path (Peekaboo / synthetic CGEvents) is blocked by missing TCC/Accessibility grants — e.g. bootstrapping permission grants in System Settings, operating an auth dialog, or any click/type the app-level automation can't reach. Injected events come from the privileged Screen Sharing agent, so they bypass the per-app Accessibility gate."
homepage: https://github.com/sibson/vncdotool
metadata:
  {
    "openclaw":
      {
        "emoji": "🖥️",
        "os": ["darwin"],
        "requires": { "bins": ["vncdo"] },
        "install":
          [
            {
              "id": "pip",
              "kind": "pip",
              "package": "vncdotool",
              "bins": ["vncdo"],
              "label": "Install vncdotool (pip)",
            },
          ],
      },
  }
---

<!-- Source: sibson/vncdotool README + Read the Docs usage guide
     (github.com/sibson/vncdotool, vncdotool.readthedocs.io). vncdotool
     publishes no SKILL.md; this card is assembled from that documentation. -->

# vncdotool

`vncdo` is a command-line VNC client: it sends keyboard/mouse events to a VNC
server and captures its framebuffer. On this appliance we point it at the
machine's **own** built-in Screen Sharing server (loopback, `127.0.0.1`) so the
box can control its own console GUI.

## When to use this (vs. `computer-use`/Peekaboo)

Peekaboo is the primary GUI tool and is better in every way **once permissions
exist** (element targeting, app/window scoping, annotated `see`). Reach for
`vncdo` only when Peekaboo/`ax` can't act because the local synthetic-event path
is gated:

- **Bootstrapping TCC grants.** Peekaboo needs Accessibility + Screen Recording
  to click, but those are the permissions you're trying to grant — chicken and
  egg. `vncdo`'s clicks are injected by the privileged Screen Sharing/ARD agent
  (root/`_ard`), *below* the per-app Accessibility gate, so they can operate the
  System Settings → Privacy & Security toggles and type an admin password when
  the CGEvent path can't. Its `capture` reads the server's framebuffer, so it
  also sidesteps the Screen Recording gate.
- **Any dialog/UI the app-level tools can't reach** when grants are missing or
  `automationmodetool` hasn't been run yet.

Not a substitute for the direct `TCC.db` write in `machine/40-tcc.sh` (the
SIP-off happy path). This is the tool for the **SIP-on / no-MDM fallback**,
where GUI toggles are the only way in. It does **nothing for SIP** —
`csrutil disable` is recoveryOS-only.

## Prerequisites (one-time, root)

The built-in Screen Sharing server must be running (checklist 1.11) and exposing
**legacy VNC with a password** so a standard VNC client can authenticate — the
default Apple/ARD auth is not what `vncdo` speaks. Enable it via ARDAgent's
`kickstart`:

```bash
sudo /System/Library/CoreServices/RemoteManagement/ARDAgent.app/Contents/Resources/kickstart \
  -activate -configure -access -on \
  -clientopts -setvnclegacy -vnclegacy yes -setvncpw -vncpw "$VNC_PW" \
  -restart -agent -privs -all
```

Store the password in a file (mode 600) and pass it with `--password-file` so it
never lands in the process list. Confirm exact auth flags for the installed
version with `vncdo --help`.

Loopback VNC controls the **active console session**, so the agent user must be
auto-logged-in at the console (checklist 1.4) with sleep/lock disabled
(1.5–1.7). A truly headless mini may render no framebuffer — attach a display or
a dummy HDMI plug, or clicks land on nothing.

## Core commands

```bash
SRV="127.0.0.1::5900"          # host::port  (note the DOUBLE colon for a raw port)
PW=(--password-file "$HOME/.config/founderbench/vnc.pw")

vncdo -s "$SRV" "${PW[@]}" capture /tmp/screen.png        # screenshot the session
vncdo -s "$SRV" "${PW[@]}" move 400 300 click 1           # ALWAYS move before click
vncdo -s "$SRV" "${PW[@]}" type "hello world"             # type a string (no special chars)
vncdo -s "$SRV" "${PW[@]}" key enter                      # named keys: enter, tab, esc, space
vncdo -s "$SRV" "${PW[@]}" key cmd-space                  # modifier combos: cmd-, ctrl-, alt-, shift-
vncdo -s "$SRV" "${PW[@]}" rcapture /tmp/region.png 100 200 400 250   # capture a sub-region
```

**Critical:** always issue a `move X Y` before a `click` in the same invocation —
VNC encodes clicks relative to the last known pointer position, so a bare
`click` fires at (0,0). Chain actions on one line to keep the connection warm:

```bash
vncdo -s "$SRV" "${PW[@]}" move 200 100 click 1 type "name" key tab key enter capture /tmp/after.png
```

`expect img.png <fuzz>` / `rexpect` block until the screen matches a reference
image (needs Pillow) — useful to wait for a pane to load instead of `pause`.
Scripts: pipe actions on stdin (`echo "type hi" | vncdo -s "$SRV" -`) or run a
`.vdo` file (`vncdo -s "$SRV" file.vdo`).

## Typical bootstrap flow (grant TCC via the GUI)

```bash
# 1. See where things are.
vncdo -s "$SRV" "${PW[@]}" capture /tmp/s.png
# 2. Open the Privacy & Security pane.
open "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
vncdo -s "$SRV" "${PW[@]}" pause 1 capture /tmp/s.png
# 3. Click the toggle / add the binary by coordinates read off the screenshot,
#    typing the admin password into any auth sheet that appears.
vncdo -s "$SRV" "${PW[@]}" move <x> <y> click 1 pause 1 type "$ADMIN_PW" key enter
# 4. Verify out-of-band, then hand back to Peekaboo.
peekaboo permissions status --json
```

Coordinates are resolution-dependent and brittle — read them fresh from a
`capture` each time, verify the result with a follow-up capture or `peekaboo
permissions status`, and switch back to Peekaboo the moment grants exist.

## Caveats

- Bypasses Accessibility/Screen Recording gates for **input and capture**, but
  still can't relax SIP and doesn't replace `automationmodetool` (the
  Authorization Services / UI-automation gate).
- Coordinate-only, no element targeting — one-shot bootstrap use, not steady
  state.
- Standard VNC (DES) auth only; modern macOS steers toward ARD auth, so the
  legacy-VNC `kickstart` above is required and Apple keeps tightening it.
  Validate on the pinned macOS version.
