/** Run configuration: TOML file + credentials.env overlay. */
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
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
  /** Always derived — credentials.env + harness defaults. Not in the run TOML. */
  model: {
    /** OpenCode provider id; matches configs/agent/opencode.json. */
    provider_id: string;
    proxy_port: number;
    model_id: string;
    upstream_url: string;
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
  metrics: {
    interval_minutes: number;
    /** Shell commands run on each snapshot; stdout captured into the trace. */
    commands: Record<string, string>;
  };
  keychain?: {
    /** Unlock the build keychain (and disable its auto-lock) at run start.
     * Default true; false leaves the locked keychain for the agent to deal
     * with (see docs/experiment-design.md). */
    auto_unlock?: boolean;
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
    cfg.workspace = { ...(cfg.workspace ?? { dir: home }), dir: home };
  } else {
    cfg.workspace.dir = cfg.workspace.dir
      .replace(/^\$HOME(?=\/|$)/, home)
      .replace(/^~(?=\/|$)/, home);
  }
  // Model is never TOML: credentials + fixed harness defaults (provider name /
  // proxy port match opencode.json). Optional MODEL_PROXY_PORT override.
  const proxyPort = Number(process.env.MODEL_PROXY_PORT ?? "41500");
  cfg.model = {
    provider_id: "founderbench",
    proxy_port: Number.isFinite(proxyPort) && proxyPort > 0 ? proxyPort : 41500,
    model_id: process.env.MODEL_ID ?? "",
    upstream_url: process.env.MODEL_UPSTREAM_URL ?? "",
  };
  if (!cfg.model.model_id) {
    throw new Error("MODEL_ID missing — set it in credentials.env");
  }
  if (!cfg.model.upstream_url) {
    throw new Error("MODEL_UPSTREAM_URL missing — set it in credentials.env");
  }
  return cfg;
}

/**
 * Load credentials.env (dotenv format) into process.env. Parsing is delegated
 * to Node's built-in `util.parseEnv` (quotes, inline comments, multi-line —
 * same parser as `node --env-file`). Real environment variables win over the
 * file, matching `--env-file` semantics.
 */
export function loadCredentialsEnv(path = join(FB_ROOT, "credentials.env")): void {
  if (!existsSync(path)) return;
  const parsed = parseEnv(readFileSync(path, "utf8")) as Record<string, string>;
  for (const [key, raw] of Object.entries(parsed)) {
    if (key in process.env) continue;
    // Expand $HOME / ~ minimally
    process.env[key] = raw.replace(/^\$HOME|^~(?=\/)/, process.env.HOME ?? "~");
  }
}
