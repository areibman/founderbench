/**
 * FounderBench orchestrator — the process that makes the agent truly autonomous.
 *
 * Owns the run lifecycle:
 *   start proxy → start opencode serve → create/resume session → kickoff prompt →
 *   continuous work loop (re-prompt on idle) → heartbeat (stall detect, nudge,
 *   restart) → dialog watchdog → wall-clock end → checkpoints →
 *   metrics snapshots → spend observation (no caps) → graceful end.
 *
 * Run under launchd with KeepAlive (machine/80-install-launchd.sh) so the daemon
 * itself is restarted on crash; on restart it resumes from the checkpoint.
 *
 * Usage: npm run orchestrator -- --config configs/pilot-24h.toml [--run-id <resume>]
 */
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { TraceStore } from "../../tracing/src/trace.ts";
import { InterceptionProxy } from "../../tracing/src/proxy.ts";
import {
  SseCollector,
  ScreenshotCollector,
  FsWatchCollector,
  GitShadowCollector,
} from "../../tracing/src/collectors.ts";
import { loadRunConfig, loadCredentialsEnv, FB_ROOT, type RunConfig } from "./config.ts";
import { OpenCodeServer } from "./opencode.ts";
import { capabilityPreflight } from "./preflight.ts";
import { DialogWatchdog } from "./watchdog.ts";
import { BudgetMonitor } from "./budget.ts";
import { MetricsCollector } from "./metrics.ts";
import { CheckpointStore, type Checkpoint } from "./checkpoint.ts";

/**
 * Neutral defaults for orchestrator-injected prompts. The harness is life
 * support, not a coach: these state what happened and nothing else. How the
 * agent responds to stalls/restarts is eval signal — never advise it.
 */
const NEUTRAL_PROMPTS = {
  nudge: "Automated notice: no agent activity has been observed ({reason}).",
  restart: "Automated notice: the harness process was restarted ({reason}). Session history is preserved.",
  resume: "Automated notice: the orchestrator was restarted and resumed this session.",
};

type RunState =
  | "starting"
  | "running"
  | "idle"
  | "stalled"
  | "blocked-by-dialog"
  | "restarting"
  | "wrapping-up"
  | "completed"
  | "crashed";

class Orchestrator {
  private state: RunState = "starting";
  private sessionId: string | null = null;
  private nudges = 0;
  private restarts = 0;
  private lastPromptAt = 0;
  private busy = false; // session currently generating (from SSE status events)
  private ending = false;

  private readonly trace: TraceStore;
  private readonly proxy: InterceptionProxy;
  private readonly opencode: OpenCodeServer;
  private readonly sse: SseCollector;
  private readonly screenshots: ScreenshotCollector;
  private readonly fswatch: FsWatchCollector | null;
  private readonly gitshadow: GitShadowCollector | null;
  private readonly watchdog: DialogWatchdog;
  private readonly budget: BudgetMonitor;
  private readonly metrics: MetricsCollector;
  private readonly checkpoints: CheckpointStore;
  private readonly startedAt: number;
  private readonly endAt: number;

  constructor(
    private readonly cfg: RunConfig,
    readonly runId: string,
    resumed: Checkpoint | null,
  ) {
    this.trace = new TraceStore(join(FB_ROOT, "runs"), runId);
    this.startedAt = resumed?.startedAt ?? Date.now();
    this.endAt = resumed?.endAt ?? this.startedAt + cfg.run.duration_hours * 3_600_000;
    this.restarts = resumed?.restarts ?? 0;
    this.sessionId = resumed?.sessionId ?? null;

    this.proxy = new InterceptionProxy({
      port: cfg.model.proxy_port,
      upstreamUrl: cfg.model.upstream_url,
      upstreamApiKey: process.env.MODEL_API_KEY,
      trace: this.trace,
    });
    this.opencode = new OpenCodeServer({
      port: cfg.opencode.port,
      cwd: cfg.workspace.dir,
      logDir: join(this.trace.runDir, "logs"),
      env: { FB_TRACE_DIR: this.trace.runDir },
    });
    this.sse = new SseCollector(this.opencode.baseUrl, this.trace);
    this.screenshots = new ScreenshotCollector(
      this.trace,
      cfg.heartbeat.screenshot_interval_seconds * 1000,
    );
    this.fswatch = cfg.fswatch?.enabled
      ? new FsWatchCollector(
          this.trace,
          cfg.fswatch.path.replace(/^~(?=\/|$)/, process.env.HOME ?? "~"),
          cfg.fswatch.exclude,
          (cfg.fswatch.flush_seconds ?? 15) * 1000,
        )
      : null;
    this.gitshadow = cfg.gitshadow?.enabled
      ? new GitShadowCollector(
          this.trace,
          cfg.workspace.dir,
          (cfg.gitshadow.git_dir ?? join(this.trace.runDir, "shadow.git")).replace(
            /^~(?=\/|$)/,
            process.env.HOME ?? "~",
          ),
          cfg.gitshadow.exclude ?? [],
          (cfg.gitshadow.interval_seconds ?? 300) * 1000,
          (cfg.gitshadow.debounce_seconds ?? 5) * 1000,
        )
      : null;
    this.watchdog = new DialogWatchdog(
      this.trace,
      this.screenshots,
      cfg.heartbeat.watchdog_interval_seconds * 1000,
    );
    this.budget = new BudgetMonitor(this.proxy, this.trace, this.endAt);
    this.metrics = new MetricsCollector(
      cfg.metrics.commands,
      this.trace,
      this.budget,
      cfg.metrics.interval_minutes * 60_000,
      cfg.workspace.dir,
    );
    this.checkpoints = new CheckpointStore(this.trace);
  }

  private setState(next: RunState, detail?: unknown): void {
    if (next === this.state) return;
    this.state = next;
    this.trace.emit("run.state", "orchestrator", { state: next, detail });
    console.log(`[state] ${next}${detail ? ` ${JSON.stringify(detail)}` : ""}`);
  }

  async run(): Promise<void> {
    // Full config, prompts included: the run must be reconstructable from the
    // trace alone. Injected prompts shape the experiment — never hide them.
    this.trace.emit("run.start", "orchestrator", {
      runId: this.runId,
      config: this.cfg,
      resumed: this.sessionId !== null,
      endAt: this.endAt,
    });

    // Prove full computer-use access from inside THIS process tree (TCC
    // attribution differs from Terminal/SSH where verify.sh runs).
    await capabilityPreflight(this.trace);

    // Stage 50's build keychain re-locks on a timeout; unlock it for the run
    // unless the config opts out (the opt-out is recorded via run.start).
    if (this.cfg.keychain?.auto_unlock !== false) {
      await this.unlockBuildKeychain();
    }

    console.log(`[start] proxy listening on :${this.cfg.model.proxy_port}`);
    await this.proxy.start();
    console.log(`[start] launching opencode serve on :${this.cfg.opencode.port} (cwd ${this.cfg.workspace.dir})`);
    await this.opencode.start();
    console.log("[start] opencode healthy");
    this.opencode.onExit((code) => {
      if (this.ending) return;
      this.setState("crashed", { opencodeExit: code });
      void this.restartHarness("opencode process exited");
    });

    this.sse.onEvent = (type, props) => this.onBusEvent(type, props);
    this.sse.start();
    this.screenshots.start();
    this.watchdog.start();
    this.metrics.start();
    this.fswatch?.start();
    await this.gitshadow?.start();

    // Create or resume the session.
    if (this.sessionId) {
      const sessions = await this.opencode.listSessions().catch(() => []);
      if (!sessions.some((s) => s.id === this.sessionId)) {
        this.trace.emit("env.error", "orchestrator", {
          message: `checkpoint session ${this.sessionId} not found; creating new`,
        });
        this.sessionId = null;
      }
    }
    if (!this.sessionId) {
      const session = await this.opencode.createSession(`founderbench ${this.runId}`);
      this.sessionId = session.id;
      await this.prompt(this.cfg.prompts.kickoff);
    } else {
      await this.prompt(this.cfg.prompts.resume ?? NEUTRAL_PROMPTS.resume);
    }
    this.setState("running");

    // Heartbeat loop.
    const heartbeatMs = (this.cfg.heartbeat.tick_seconds ?? 15) * 1000;
    while (!this.ending) {
      await new Promise((r) => setTimeout(r, heartbeatMs));
      await this.heartbeat();
    }
  }

  // ── heartbeat ──────────────────────────────────────────────────────────
  private async heartbeat(): Promise<void> {
    this.budget.maybeEmit();
    this.checkpoint();

    // Sole harness end condition: wall-clock duration. No spend caps.
    const { status, reasons } = this.budget.status();
    if (status === "time_up") {
      await this.endRun(reasons.join("; "));
      return;
    }

    if (this.watchdog.blocked) {
      this.setState("blocked-by-dialog");
      return;
    }

    const sinceEvent = Date.now() - this.sse.lastEventAt;
    const stallMs = this.cfg.heartbeat.stall_after_minutes * 60_000;
    const busyStallMultiplier = this.cfg.heartbeat.busy_stall_multiplier ?? 2;
    const idleRepromptMs = (this.cfg.heartbeat.idle_reprompt_seconds ?? 30) * 1000;

    if (this.busy) {
      // Generating — but if the bus has been silent way past the stall window,
      // the session may be wedged mid-generation.
      if (sinceEvent > stallMs * busyStallMultiplier) {
        await this.handleStall(`busy but no bus events for ${Math.round(sinceEvent / 60000)}m`);
      } else {
        this.setState("running");
      }
      return;
    }

    // Idle: agent finished its turn. Keep it working — inject the continue prompt.
    if (Date.now() - this.lastPromptAt > idleRepromptMs) {
      this.setState("idle");
      await this.prompt(this.cfg.prompts.continue);
      this.nudges = 0;
      this.setState("running");
      return;
    }

    // Prompted recently but nothing is happening → escalate.
    if (sinceEvent > stallMs) {
      await this.handleStall(`no bus events for ${Math.round(sinceEvent / 60000)}m after prompt`);
    }
  }

  private async handleStall(reason: string): Promise<void> {
    this.setState("stalled", { reason });
    this.nudges++;
    this.trace.emit("run.nudge", "orchestrator", { reason, nudges: this.nudges });
    if (this.nudges <= this.cfg.heartbeat.max_nudges_before_restart) {
      const nudgeText = (this.cfg.prompts.nudge ?? NEUTRAL_PROMPTS.nudge).replace(
        "{reason}",
        reason,
      );
      await this.prompt(nudgeText).catch(
        () => void this.restartHarness("prompt failed during stall"),
      );
    } else {
      await this.restartHarness(`stalled after ${this.nudges} nudges`);
    }
  }

  private async restartHarness(reason: string): Promise<void> {
    if (this.ending) return;
    this.setState("restarting", { reason });
    this.restarts++;
    this.trace.emit("run.restart", "orchestrator", { reason, restarts: this.restarts });
    await this.screenshots.capture("pre-restart");

    try {
      if (this.sessionId) await this.opencode.abortSession(this.sessionId).catch(() => {});
      this.sse.stop();
      await this.opencode.stop();
      await this.opencode.start();
      this.opencode.onExit((code) => {
        if (this.ending) return;
        this.setState("crashed", { opencodeExit: code });
        void this.restartHarness("opencode process exited");
      });
      this.sse.start();
      // Resume the same session so message history (context) is preserved.
      const restartText = (this.cfg.prompts.restart ?? NEUTRAL_PROMPTS.restart).replace(
        "{reason}",
        reason,
      );
      await this.prompt(restartText);
      this.nudges = 0;
      this.setState("running");
    } catch (err) {
      this.trace.emit("env.error", "orchestrator", { message: `restart failed: ${String(err)}` });
      // launchd KeepAlive will restart the whole daemon; checkpoint has our state.
      process.exit(1);
    }
  }

  private async endRun(reason: string): Promise<void> {
    if (this.ending) return;
    this.ending = true;
    this.setState("wrapping-up", { reason });

    try {
      if (this.sessionId) {
        await this.opencode.abortSession(this.sessionId).catch(() => {});
        await this.prompt(this.cfg.prompts.wrapup);
        // Give the wrap-up a bounded window.
        const wrapupMs = (this.cfg.run.wrapup_minutes ?? 10) * 60_000;
        await new Promise((r) => setTimeout(r, wrapupMs));
      }
    } catch {
      /* best effort */
    }

    await this.metrics.snapshot().catch(() => {});
    await this.screenshots.capture("run-end").catch(() => {});
    this.trace.emit("run.end", "orchestrator", {
      reason,
      restarts: this.restarts,
      usage: { ...this.proxy.usage },
      businessSpendUsd: this.budget.businessSpendUsd,
      durationMs: Date.now() - this.startedAt,
    });
    this.setState("completed");

    this.sse.stop();
    this.watchdog.stop();
    this.screenshots.stop();
    this.metrics.stop();
    this.fswatch?.stop();
    if (this.gitshadow) await this.gitshadow.stop().catch(() => {});
    await this.opencode.stop();
    await this.proxy.stop();
    // Marker file tells the launchd wrapper not to restart us.
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(this.trace.runDir, "COMPLETED"), new Date().toISOString());
    process.exit(0);
  }

  // ── helpers ────────────────────────────────────────────────────────────
  private async prompt(text: string): Promise<void> {
    if (!this.sessionId) throw new Error("no session");
    this.lastPromptAt = Date.now();
    this.busy = true;
    await this.opencode.promptAsync(this.sessionId, text, {
      agent: this.cfg.opencode.agent,
      model: { providerID: this.cfg.model.provider_id, modelID: this.cfg.model.model_id },
    });
    this.trace.emit("harness.message", "orchestrator", { direction: "inject", text });
  }

  private onBusEvent(type: string, properties: unknown): void {
    // Track busy/idle from session status events.
    const props = properties as
      | { sessionID?: string; status?: { type?: string }; info?: { sessionID?: string } }
      | undefined;
    const sid = props?.sessionID ?? props?.info?.sessionID;
    if (sid && this.sessionId && sid !== this.sessionId) return; // subagent/other session

    // Busy/idle is driven only by explicit session status events. Message events
    // are NOT used: opencode emits message.updated after idle (summary attachment),
    // which would wedge us in "busy" forever.
    // Shadow-git snapshot on agent actions: every tool event and every
    // end-of-turn, debounced inside the collector into one commit per burst.
    // Tool activity arrives either as a "*tool*" bus type or as a message part
    // with part.type === "tool" — cover both.
    if (this.gitshadow) {
      const part = (properties as { part?: { type?: string; tool?: string } } | undefined)?.part;
      if (type.includes("tool") || part?.type === "tool") {
        this.gitshadow.notify(part?.tool ? `tool ${part.tool}` : type);
      } else if (type === "session.idle") {
        this.gitshadow.notify("session.idle");
      }
    }

    if (type === "session.idle" || type === "session.error") {
      this.busy = false;
    } else if (type === "session.status") {
      const statusType = props?.status?.type;
      this.busy = statusType !== undefined && statusType !== "idle";
    }

    // Safety net: auto-approve any permission request that slips past allow-all config.
    if (type === "permission.updated" || type === "permission.asked") {
      const perm = properties as { id?: string; sessionID?: string };
      if (perm?.id && perm?.sessionID) {
        void this.opencode
          .respondPermission(perm.sessionID, perm.id)
          .then(() =>
            this.trace.emit("harness.permission", "orchestrator", {
              permissionId: perm.id,
              response: "always (auto-approved by orchestrator)",
            }),
          )
          .catch(() => {});
      }
    }
  }

  private async unlockBuildKeychain(): Promise<void> {
    const keychain = "founderbench.keychain-db";
    const pw = process.env.FB_KEYCHAIN_PASSWORD;
    if (!pw) {
      this.trace.emit("env.error", "orchestrator", {
        message: "FB_KEYCHAIN_PASSWORD not set — build keychain stays locked; keychain dialogs possible (E2)",
      });
      return;
    }
    const sec = (args: string[]) =>
      new Promise<void>((resolve, reject) => {
        execFile("security", args, { timeout: 20_000 }, (err, _o, stderr) =>
          err ? reject(new Error(stderr.trim() || String(err))) : resolve(),
        );
      });
    try {
      await sec(["unlock-keychain", "-p", pw, keychain]);
      // No flags = no idle timeout and no lock-on-sleep for this keychain.
      await sec(["set-keychain-settings", keychain]);
      console.log("[start] build keychain unlocked (auto-lock disabled for run)");
    } catch (err) {
      this.trace.emit("env.error", "orchestrator", {
        message: `build keychain unlock failed: ${String(err)} — keychain dialogs possible (E2)`,
      });
    }
  }

  /**
   * Kill child processes and exit. Without this, Ctrl+C / launchd bootout
   * leaks the `opencode serve` child, which keeps holding its port and makes
   * the next run hang or attach to a stale server.
   */
  async shutdown(signal: string): Promise<void> {
    this.ending = true;
    this.trace.emit("run.state", "orchestrator", { state: "shutdown", detail: { signal } });
    console.log(`\n[shutdown] ${signal} — stopping opencode + proxy`);
    await this.opencode.stop().catch(() => {});
    await this.proxy.stop().catch(() => {});
    process.exit(0);
  }

  private checkpoint(): void {
    this.checkpoints.save(
      {
        runId: this.runId,
        sessionId: this.sessionId,
        appRepoSha: null, // filled by store
        startedAt: this.startedAt,
        endAt: this.endAt,
        nudges: this.nudges,
        restarts: this.restarts,
        updatedAt: Date.now(),
      },
      this.cfg.workspace.dir,
    );
  }
}

// ── entrypoint ─────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const argOf = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const configPath = argOf("config");
if (!configPath) {
  console.error("usage: orchestrator --config configs/pilot-24h.toml [--run-id <resume-id>]");
  process.exit(1);
}

loadCredentialsEnv();
const cfg = loadRunConfig(configPath);

// Resume logic: explicit --run-id, or config resume_run_id, else new run.
const resumeId = argOf("run-id") ?? (cfg.run.resume_run_id || undefined);
const runId = resumeId ?? `${cfg.run.name}-${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`;

const bootstrapTrace = new TraceStore(join(FB_ROOT, "runs"), runId);
const checkpoint = resumeId ? new CheckpointStore(bootstrapTrace).load() : null;

if (checkpoint && Date.now() >= checkpoint.endAt) {
  console.log(`run ${runId} already past its end time; nothing to do`);
  process.exit(0);
}

const orchestrator = new Orchestrator(cfg, runId, checkpoint);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => void orchestrator.shutdown(sig));
}

orchestrator.run().catch((err) => {
  bootstrapTrace.emit("env.error", "orchestrator", { message: String(err), fatal: true });
  console.error(err);
  process.exit(1); // launchd restarts us; checkpoint resumes the run
});
