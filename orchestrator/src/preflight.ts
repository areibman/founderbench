/**
 * Capability preflight — proves the agent will actually have full computer-use
 * access, measured from INSIDE the orchestrator's own process tree.
 *
 * TCC attributes permissions to the responsible process, which differs between
 * a Terminal/SSH session (where machine/verify.sh runs) and the launchd →
 * run-daemon.sh → node → opencode chain the run executes under. A green
 * verify.sh therefore does not prove the run context; this does, at every run
 * start, and records the evidence as an env.preflight trace event.
 *
 * Non-fatal by design: failures are environment findings (E1/E5-class), the
 * run proceeds, and the trace carries the proof either way.
 */
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { statSync, rmSync } from "node:fs";
import type { TraceStore } from "../../tracing/src/trace.ts";

interface ProbeResult {
  ok: boolean;
  detail: string;
}

function run(cmd: string, args: string[], timeoutMs = 20_000): Promise<ProbeResult> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        detail: (err ? `${stdout}${stderr}${String(err)}` : stdout).trim().slice(0, 2000),
      });
    });
  });
}

export async function capabilityPreflight(trace: TraceStore): Promise<void> {
  const results: Record<string, ProbeResult> = {};

  // Screen Recording: a real capture is non-empty; without the grant,
  // screencapture yields wallpaper-only or fails outright.
  const shot = join(tmpdir(), `fb-preflight-${Date.now()}.png`);
  const cap = await run("screencapture", ["-x", "-t", "png", shot]);
  let size = 0;
  try {
    size = statSync(shot).size;
    rmSync(shot, { force: true });
  } catch {
    /* no file — capture failed */
  }
  results["screen_recording"] = {
    ok: cap.ok && size > 10_000,
    detail: cap.ok ? `capture ${size} bytes` : cap.detail,
  };

  // AppleEvents / Automation (System Events) — what the dialog watchdog needs.
  results["apple_events"] = await run("osascript", [
    "-e",
    'tell application "System Events" to count processes',
  ]);

  // Accessibility + Screen Recording as seen by Peekaboo (the agent's
  // computer-use tool). `permissions` reports each service's status.
  results["peekaboo_permissions"] = await run("bash", [
    "-lc",
    "peekaboo permissions status 2>&1 || peekaboo permissions 2>&1",
  ]);
  if (results["peekaboo_permissions"]!.ok) {
    const out = results["peekaboo_permissions"]!.detail.toLowerCase();
    if (out.includes("denied") || out.includes("not granted")) {
      results["peekaboo_permissions"]!.ok = false;
    }
  }

  // Accessibility via the ax CLI (watchdog's other path). Note: no pipe to
  // head — a pipe would mask the ax exit code with head's, falsely passing when
  // the binary is missing or Accessibility is denied.
  results["ax_tree"] = await run("bash", [
    "-lc",
    'AXBIN=$(command -v ax || echo "$HOME/go/bin/ax"); "$AXBIN" apps 2>&1',
  ]);
  results["ax_tree"].detail = results["ax_tree"].detail.slice(0, 500);

  // Passwordless sudo — required for system-level agent actions.
  results["sudo_nopasswd"] = await run("sudo", ["-n", "true"]);

  const failed = Object.entries(results).filter(([, r]) => !r.ok).map(([k]) => k);
  trace.emit("env.preflight", "orchestrator", {
    context: "launchd-process-tree",
    ok: failed.length === 0,
    failed,
    results,
  });
  console.log(
    failed.length === 0
      ? "[preflight] full computer-use access confirmed in run context"
      : `[preflight] MISSING capabilities in run context: ${failed.join(", ")} (run continues; see env.preflight in trace)`,
  );
}
