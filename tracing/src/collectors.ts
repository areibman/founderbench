/**
 * Event collectors:
 *  - SSE collector: relays the OpenCode /event bus into the trace (messages, tool
 *    calls, file edits, permission requests, session state).
 *  - Screenshot collector: periodic desktop captures via `screencapture`.
 *
 * Git commits are collected by the post-commit hook installed by
 * machine/70-agent-workspace.sh (writes directly to trace.jsonl via $FB_TRACE_DIR).
 */
import { execFile } from "node:child_process";
import { join } from "node:path";
import { TraceStore, clip } from "./trace.ts";

/** Subscribe to OpenCode's SSE /event stream and relay every event into the trace. */
export class SseCollector {
  private abort: AbortController | null = null;
  private stopped = false;
  /** Updated on every event — the heartbeat reads this. */
  lastEventAt = Date.now();
  /** Optional live listener for the orchestrator state machine. */
  onEvent: ((type: string, properties: unknown) => void) | null = null;

  constructor(
    private readonly baseUrl: string,
    private readonly trace: TraceStore,
  ) {}

  start(): void {
    this.stopped = false;
    void this.loop();
  }

  stop(): void {
    this.stopped = true;
    this.abort?.abort();
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      this.abort = new AbortController();
      try {
        const res = await fetch(`${this.baseUrl}/event`, {
          signal: this.abort.signal,
          headers: { accept: "text/event-stream" },
        });
        if (!res.ok || !res.body) throw new Error(`SSE connect failed: ${res.status}`);
        this.trace.emit("harness.event", "sse", { type: "collector.connected" });

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let idx: number;
          while ((idx = buffer.indexOf("\n\n")) >= 0) {
            const frame = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            this.handleFrame(frame);
          }
        }
      } catch (err) {
        if (this.stopped) return;
        this.trace.emit("env.error", "sse", { message: `SSE dropped: ${String(err)}` });
      }
      if (!this.stopped) await new Promise((r) => setTimeout(r, 2000));
    }
  }

  private handleFrame(frame: string): void {
    const dataLines = frame
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim());
    if (dataLines.length === 0) return;
    for (const data of dataLines) {
      let parsed: { type?: string; properties?: unknown } | null = null;
      try {
        parsed = JSON.parse(data) as { type?: string; properties?: unknown };
      } catch {
        /* raw frame */
      }
      const type = parsed?.type ?? "unknown";
      // Server liveness pings are not agent activity — counting them would keep
      // the stall detector from ever firing.
      if (type !== "server.heartbeat") this.lastEventAt = Date.now();
      const sessionId = extractSessionId(parsed?.properties);
      this.trace.emit(
        classify(type),
        "sse",
        { type, properties: clip(parsed?.properties ?? data) },
        sessionId ? { sessionId } : {},
      );
      this.onEvent?.(type, parsed?.properties);
    }
  }
}

function classify(busType: string): string {
  if (busType.startsWith("message")) return "harness.message";
  if (busType.includes("tool")) return "harness.tool";
  if (busType.includes("permission")) return "harness.permission";
  return "harness.event";
}

function extractSessionId(properties: unknown): string | undefined {
  const p = properties as
    | { sessionID?: string; info?: { sessionID?: string }; part?: { sessionID?: string } }
    | undefined;
  return p?.sessionID ?? p?.info?.sessionID ?? p?.part?.sessionID;
}

/** Periodic desktop screenshots — visual record + dialog-watchdog evidence. */
export class ScreenshotCollector {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly trace: TraceStore,
    private readonly intervalMs: number,
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.capture("periodic"), this.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Capture now; returns the file path (also usable by the watchdog for evidence). */
  async capture(reason: string): Promise<string | null> {
    const file = join(this.trace.runDir, "screenshots", `${Date.now()}.png`);
    return new Promise((resolve) => {
      execFile("screencapture", ["-x", "-t", "png", file], (err) => {
        if (err) {
          this.trace.emit("env.error", "screenshot", { message: String(err) });
          resolve(null);
        } else {
          this.trace.emit("env.screenshot", "screenshot", { file, reason });
          resolve(file);
        }
      });
    });
  }
}
