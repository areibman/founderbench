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
import { watch, existsSync, mkdirSync, writeFileSync } from "node:fs";
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

/**
 * Git shadow collector: a second, harness-owned git history of the workspace,
 * committed after every agent action — the `git log --follow`-able record of
 * the whole run, independent of whether (and how) the agent chooses to commit.
 *
 * Uses a separate GIT_DIR with the workspace as work-tree (the dotfiles
 * pattern), so the agent's own .git — its index, hooks, and history — is never
 * touched, and the shadow repo is invisible to the agent's `git status`.
 * Snapshots are triggered by tool-completion events (debounced) plus a
 * periodic fallback, and each commit is emitted as an env.gitshadow trace
 * event carrying the sha, trigger, and diffstat.
 */
export class GitShadowCollector {
  private timer: NodeJS.Timeout | null = null;
  private debounce: NodeJS.Timeout | null = null;
  private busy = false;
  private rerun: string | null = null;

  constructor(
    private readonly trace: TraceStore,
    /** Work-tree to track (typically the agent workspace / app repo). */
    private readonly workTree: string,
    /** Shadow GIT_DIR — must NOT be inside the work-tree's own .git. */
    private readonly gitDir: string,
    /** gitignore-syntax patterns written to the shadow repo's info/exclude. */
    private readonly exclude: string[],
    private readonly intervalMs: number,
    private readonly debounceMs: number,
  ) {}

  async start(): Promise<void> {
    try {
      // HEAD, not the directory, is the init marker — a half-created dir from
      // a previous failed init must not short-circuit into a broken repo.
      if (!existsSync(join(this.gitDir, "HEAD"))) {
        mkdirSync(this.gitDir, { recursive: true });
        // Plain `git init --bare <dir>`: init rejects --work-tree, so this one
        // call bypasses the flag-injecting helper below.
        await new Promise<void>((resolve, reject) => {
          execFile("git", ["init", "--bare", this.gitDir], { timeout: 60_000 }, (err, _o, stderr) =>
            err ? reject(new Error(`git init: ${stderr || err}`)) : resolve(),
          );
        });
        await this.git(["config", "core.bare", "false"]);
        await this.git(["config", "core.worktree", this.workTree]);
        await this.git(["config", "user.name", "founderbench-shadow"]);
        await this.git(["config", "user.email", "shadow@founderbench.local"]);
        await this.git(["config", "commit.gpgsign", "false"]);
      }
      // Always ignore the agent's own .git plus the configured exclude list.
      mkdirSync(join(this.gitDir, "info"), { recursive: true });
      writeFileSync(
        join(this.gitDir, "info", "exclude"),
        [".git/", ...this.exclude].join("\n") + "\n",
      );
    } catch (err) {
      this.trace.emit("env.error", "gitshadow", {
        message: `shadow repo init failed: ${String(err)}`,
      });
      return;
    }
    this.timer = setInterval(() => void this.snapshot("interval"), this.intervalMs);
    this.trace.emit("harness.event", "gitshadow", {
      type: "collector.started",
      workTree: this.workTree,
      gitDir: this.gitDir,
      exclude: this.exclude,
    });
    // Fire-and-forget: the first `git add -A` of a big work-tree (~) can take
    // minutes; it must not gate session creation and the kickoff prompt.
    void this.snapshot("run-start");
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    if (this.debounce) clearTimeout(this.debounce);
    await this.snapshot("run-end");
  }

  /** Called on agent activity (tool completions); debounced into one snapshot. */
  notify(trigger: string): void {
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => void this.snapshot(trigger), this.debounceMs);
  }

  /** Stage everything and commit if anything changed. Serialized: one git at a time. */
  async snapshot(trigger: string): Promise<void> {
    if (this.busy) {
      this.rerun = trigger; // coalesce: latest trigger wins
      return;
    }
    this.busy = true;
    try {
      await this.git(["add", "-A"]);
      const status = await this.git(["status", "--porcelain"]);
      if (status.trim().length > 0) {
        await this.git(["commit", "-q", "-m", `shadow: ${trigger}`]);
        const sha = (await this.git(["rev-parse", "HEAD"])).trim();
        const stat = (await this.git(["show", "--stat", "--format=", "HEAD"])).trim();
        this.trace.emit("env.gitshadow", "gitshadow", {
          sha,
          trigger,
          stat: stat.slice(-500),
        });
      }
    } catch (err) {
      this.trace.emit("env.error", "gitshadow", {
        message: `snapshot failed (${trigger}): ${String(err)}`,
      });
    } finally {
      this.busy = false;
      if (this.rerun) {
        const next = this.rerun;
        this.rerun = null;
        void this.snapshot(next);
      }
    }
  }

  private git(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        "git",
        ["--git-dir", this.gitDir, "--work-tree", this.workTree, ...args],
        { cwd: this.workTree, timeout: 60_000, maxBuffer: 16 * 1024 * 1024 },
        (err, stdout, stderr) => (err ? reject(new Error(`git ${args[0]}: ${stderr || err}`)) : resolve(stdout)),
      );
    });
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
