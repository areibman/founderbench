/**
 * Dialog watchdog — detects unexpected system dialogs that would block a
 * zero-human-intervention run, captures evidence, attempts scripted dismissal,
 * and records everything as env.dialog trace events.
 *
 * Detection is AX-first (System Events via osascript enumerates windows with
 * roles), with screenshots as evidence. Known blocker processes are classified
 * as environment bugs — each occurrence should result in a new pre-grant in
 * machine/40-tcc.sh or a new check in machine/verify.sh.
 */
import { execFile } from "node:child_process";
import type { TraceStore } from "../../tracing/src/trace.ts";
import type { ScreenshotCollector } from "../../tracing/src/collectors.ts";

const BLOCKER_PROCESSES = [
  "UserNotificationCenter",
  "SecurityAgent", // auth/password dialogs
  "CoreServicesUIAgent", // "downloaded from the internet" quarantine prompts
  "SoftwareUpdateNotificationManager",
  "UNUserNotificationCenter",
  "loginwindow",
];

const DIALOG_BUTTON_PRIORITY = ["OK", "Allow", "Continue", "Later", "Not Now", "Cancel", "Don't Allow"];

export interface DialogSighting {
  process: string;
  window: string;
  role: string;
  buttons: string[];
}

function osascript(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("osascript", ["-e", script], { timeout: 15_000 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout.trim());
    });
  });
}

/** Enumerate visible windows whose subrole/class looks like a dialog or sheet. */
export async function scanForDialogs(): Promise<DialogSighting[]> {
  // System Events: for known blocker processes, list windows; also catch any
  // frontmost app with a window of subrole AXDialog/AXSystemDialog.
  const script = `
    set output to ""
    tell application "System Events"
      repeat with proc in (every application process whose visible is true or name is in {${BLOCKER_PROCESSES.map((p) => `"${p}"`).join(", ")}})
        try
          repeat with w in (every window of proc)
            set subrole to ""
            try
              set subrole to value of attribute "AXSubrole" of w
            end try
            if subrole is in {"AXDialog", "AXSystemDialog", "AXSheet"} or name of proc is in {${BLOCKER_PROCESSES.map((p) => `"${p}"`).join(", ")}} then
              set btns to ""
              try
                repeat with b in (every button of w)
                  set btns to btns & (name of b) & "|"
                end repeat
              end try
              set output to output & (name of proc) & "\\t" & (name of w as string) & "\\t" & subrole & "\\t" & btns & "\\n"
            end if
          end repeat
        end try
      end repeat
    end tell
    return output
  `;
  try {
    const out = await osascript(script);
    return out
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [proc = "", window = "", role = "", buttons = ""] = line.split("\t");
        return { process: proc, window, role, buttons: buttons.split("|").filter(Boolean) };
      });
  } catch {
    return []; // AX unreachable — verify.sh check 3.x should have caught this
  }
}

/** Try to dismiss a dialog by clicking its most benign button. */
async function dismiss(sighting: DialogSighting): Promise<string | null> {
  const button =
    DIALOG_BUTTON_PRIORITY.find((b) => sighting.buttons.includes(b)) ?? sighting.buttons[0];
  if (!button) return null;
  const script = `
    tell application "System Events"
      tell process "${sighting.process}"
        click button "${button}" of window 1
      end tell
    end tell
  `;
  try {
    await osascript(script);
    return button;
  } catch {
    return null;
  }
}

export class DialogWatchdog {
  private timer: NodeJS.Timeout | null = null;
  /** Set when a dialog is currently blocking (heartbeat surfaces this state). */
  blocked = false;

  constructor(
    private readonly trace: TraceStore,
    private readonly screenshots: ScreenshotCollector,
    private readonly intervalMs: number,
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.scan(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async scan(): Promise<void> {
    const sightings = await scanForDialogs();
    if (sightings.length === 0) {
      this.blocked = false;
      return;
    }
    this.blocked = true;
    const evidence = await this.screenshots.capture("dialog-detected");
    for (const s of sightings) {
      const clicked = await dismiss(s);
      this.trace.emit("env.dialog", "watchdog", {
        classification: "environment-bug",
        process: s.process,
        window: s.window,
        role: s.role,
        buttons: s.buttons,
        dismissedVia: clicked,
        evidence,
        action_required:
          "add a pre-grant to machine/40-tcc.sh or a check to machine/verify.sh for this dialog",
      });
    }
    // Re-scan immediately after dismissal attempts
    const remaining = await scanForDialogs();
    this.blocked = remaining.length > 0;
  }
}
