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
    model_id: string; // e.g. "glm-5.2"
    upstream_url: string;
    proxy_port: number;
  };
  workspace: {
    /** App repo checkout — the agent's cwd. */
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
  };
  budget: {
    max_token_spend_usd: number;
    /** $/1M tokens for input,output — used to convert usage into $ */
    input_cost_per_mtok: number;
    output_cost_per_mtok: number;
    max_business_spend_usd: number;
  };
  metrics: {
    interval_minutes: number;
    /** Shell commands run on each snapshot; stdout captured into the trace. */
    commands: Record<string, string>;
  };
  prompts: {
    kickoff: string;
    /** Injected whenever the agent goes idle. */
    continue: string;
    /** Sent at end-of-run for the final wrap-up. */
    wrapup: string;
  };
}

export function loadRunConfig(path: string): RunConfig {
  const raw = parseToml(readFileSync(path, "utf8"));
  return raw as unknown as RunConfig;
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
