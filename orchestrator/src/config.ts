/** Run configuration: TOML file + credentials.env overlay. */
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";

export const FB_ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), "..", ".."));

export interface RunConfig {
  run: {
    name: string;
    /** Wall-clock limit; run hard-stops when it elapses. */
    duration_hours: number;
    /** Existing run id to resume; empty = new run. */
    resume_run_id?: string;
    /** Bounded window given to the final wrap-up prompt (default 10). */
    wrapup_minutes?: number;
  };
  model: {
    provider_id: string; // opencode provider id, e.g. "founderbench"
    model_id: string; // Azure OpenAI: the deployment name, e.g. "gpt-5.6-sol"
    upstream_url: string;
    proxy_port: number;
  };
  workspace: {
    /** Agent cwd. Prefer "~" / $HOME — do not point at a specific app repo;
     * finding the product is eval signal. "~" and $HOME are expanded at load. */
    dir: string;
  };
  opencode: {
    port: number;
    /** Agent name to use for prompts (opencode built-in "build" is full-access). */
    agent: string;
  };
  heartbeat: {
    /** No SSE events for this long → stalled. */
    stall_after_minutes: number;
    /** Stalled + nudged this many times → restart session. */
    max_nudges_before_restart: number;
    /** Dialog watchdog scan interval. */
    watchdog_interval_seconds: number;
    /** Periodic screenshot interval. */
    screenshot_interval_seconds: number;
    /** Checkpoint interval. */
    checkpoint_interval_seconds: number;
    /** Heartbeat loop tick (default 15). */
    tick_seconds?: number;
    /** Idle for this long after our last prompt → inject continue (default 30). */
    idle_reprompt_seconds?: number;
    /** Busy but bus silent for stall_after_minutes × this → wedged (default 2). */
    busy_stall_multiplier?: number;
  };
  budget: {
    max_token_spend_usd: number;
    /** $/1M tokens for input,output — used to convert usage into $ */
    input_cost_per_mtok: number;
    output_cost_per_mtok: number;
    max_business_spend_usd: number;
    /** Fraction of a cap that triggers a budget warning event (default 0.8). */
    warn_fraction?: number;
  };
  metrics: {
    interval_minutes: number;
    /** Shell commands run on each snapshot; stdout captured into the trace. */
    commands: Record<string, string>;
  };
  /** Git shadow: a harness-owned second git history of the workspace,
   * auto-committed after every agent tool action (debounced) plus a periodic
   * fallback. Separate GIT_DIR — the agent's own .git is never touched, and
   * `git log --follow` on the shadow repo replays every change of the run. */
  gitshadow?: {
    enabled: boolean;
    /** Shadow GIT_DIR; "~" expands. Must NOT live inside the work-tree's .git.
     * Default: <runs>/<run-id>/shadow.git (per-run history). */
    git_dir?: string;
    /** gitignore-syntax patterns to exclude from snapshots (build churn). */
    exclude?: string[];
    /** Periodic fallback snapshot interval (default 300). */
    interval_seconds?: number;
    /** Quiet window after a tool event before committing (default 5). */
    debounce_seconds?: number;
  };
  /** Filesystem watcher: records every path changed under `path` (recursive,
   * FSEvents) as env.fs trace events. Excludes are a declared, config-visible
   * filter (they appear in run.start) — not silent editorializing. */
  fswatch?: {
    enabled: boolean;
    /** Root to watch; "~" expands to the agent user's home. */
    path: string;
    /** Path substrings to ignore (churn dirs: caches, DerivedData, ...). */
    exclude: string[];
    /** Batch window: changes are aggregated and flushed on this interval. */
    flush_seconds?: number;
  };
  prompts: {
    kickoff: string;
    /** Injected whenever the agent goes idle. */
    continue: string;
    /** Sent at end-of-run for the final wrap-up. */
    wrapup: string;
    // The following have neutral, purely factual defaults (see index.ts). The
    // harness states what happened; it never advises what to do about it.
    /** Injected on stall; "{reason}" is replaced with the observed condition. */
    nudge?: string;
    /** Injected after a harness restart; "{reason}" is replaced. */
    restart?: string;
    /** Injected when the orchestrator resumes an existing session from checkpoint. */
    resume?: string;
  };
}

export function loadRunConfig(path: string): RunConfig {
  const raw = parseToml(readFileSync(path, "utf8"));
  const cfg = raw as unknown as RunConfig;
  // Neutral default: home. Never require a directed app-repo path.
  const home = process.env.HOME ?? "~";
  if (!cfg.workspace?.dir) {
    cfg.workspace = { ...(cfg.workspace ?? {}), dir: home };
  } else {
    cfg.workspace.dir = cfg.workspace.dir
      .replace(/^\$HOME(?=\/|$)/, home)
      .replace(/^~(?=\/|$)/, home);
  }
  return cfg;
}

/** Load credentials.env (simple KEY=VALUE / KEY="VALUE" lines) into process.env. */
export function loadCredentialsEnv(): void {
  const p = join(FB_ROOT, "credentials.env");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    // Expand $HOME / ~ minimally
    value = value.replace(/^\$HOME|^~(?=\/)/, process.env.HOME ?? "~");
    if (!(key in process.env)) process.env[key] = value;
  }
}
