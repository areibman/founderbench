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
import { watch } from "node:fs";
import { join } from "node:path";
import { TraceStore } from "./trace.ts";

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
        { type, properties: parsed?.properties ?? data }, // verbatim — no truncation
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

/**
 * Filesystem watcher: recursive FSEvents watch over a root (typically the agent
 * user's home), recording every changed path as env.fs trace events. This is
 * the whole-machine analog of the app repo's git history: it catches writes
 * anywhere, committed or not.
 *
 * Changes are aggregated per flush window (path → event count) so build storms
 * become one event, not fifty thousand. Nothing is dropped: oversized batches
 * spill verbatim to a side file via TraceStore.saveBody(). The exclude list is
 * config-declared and recorded in run.start — a visible filter, not a silent one.
 */
export class FsWatchCollector {
  private watcher: import("node:fs").FSWatcher | null = null;
  private timer: NodeJS.Timeout | null = null;
  private pending = new Map<string, { count: number; first: number; last: number }>();

  constructor(
    private readonly trace: TraceStore,
    private readonly root: string,
    private readonly exclude: string[],
    private readonly flushMs: number,
  ) {}

  start(): void {
    try {
      this.watcher = watch(this.root, { recursive: true }, (eventType, filename) => {
        if (!filename) return;
        const path = filename.toString();
        if (this.exclude.some((pattern) => path.includes(pattern))) return;
        const now = Date.now();
        const entry = this.pending.get(path);
        if (entry) {
          entry.count++;
          entry.last = now;
        } else {
          this.pending.set(path, { count: 1, first: now, last: now });
        }
      });
    } catch (err) {
      this.trace.emit("env.error", "fswatch", {
        message: `fswatch failed to start on ${this.root}: ${String(err)}`,
      });
      return;
    }
    this.timer = setInterval(() => this.flush(), this.flushMs);
    this.trace.emit("harness.event", "fswatch", {
      type: "collector.started",
      root: this.root,
      exclude: this.exclude,
    });
  }

  stop(): void {
    this.flush();
    if (this.timer) clearInterval(this.timer);
    this.watcher?.close();
    this.watcher = null;
  }

  flush(): void {
    if (this.pending.size === 0) return;
    const changes = [...this.pending.entries()].map(([path, e]) => ({ path, ...e }));
    this.pending.clear();
    const payload = { root: this.root, changedPaths: changes.length, changes };
    // Build storms produce huge batches — keep trace.jsonl light, lose nothing.
    if (changes.length > 500) {
      const file = this.trace.saveBody(`fs-${Date.now()}.json`, JSON.stringify(payload, null, 2));
      this.trace.emit("env.fs", "fswatch", {
        root: this.root,
        changedPaths: changes.length,
        bodyFile: file,
        sample: changes.slice(0, 25),
      });
    } else {
      this.trace.emit("env.fs", "fswatch", payload);
    }
  }
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
