/**
 * JSONL trace store — the single source of truth for a run.
 *
 * Mirrors the verifiers v1 Trace concept: an append-only, strictly-typed event log
 * with parent links so subagent sessions map to branches. One file per run:
 *   runs/<run-id>/trace.jsonl
 */
import { appendFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export type TraceEventType =
  // model
  | "model.request"
  | "model.response"
  | "model.usage"
  // harness (OpenCode bus events, relayed)
  | "harness.event"
  | "harness.message"
  | "harness.tool"
  | "harness.permission"
  // orchestrator lifecycle
  | "run.start"
  | "run.state"
  | "run.checkpoint"
  | "run.nudge"
  | "run.restart"
  | "run.end"
  // environment
  | "env.dialog"
  | "env.screenshot"
  | "env.error"
  // business side effects
  | "git.commit"
  | "metrics.snapshot"
  | "budget.update"
  | "budget.breach";

export interface TraceEvent {
  id: string;
  ts: number; // epoch ms
  type: TraceEventType | string;
  source: string; // "proxy" | "sse" | "orchestrator" | "watchdog" | "git-hook" | ...
  parentId?: string;
  sessionId?: string;
  data: unknown;
}

export class TraceStore {
  readonly runDir: string;
  readonly tracePath: string;

  constructor(runsRoot: string, readonly runId: string) {
    this.runDir = join(runsRoot, runId);
    this.tracePath = join(this.runDir, "trace.jsonl");
    mkdirSync(join(this.runDir, "screenshots"), { recursive: true });
    mkdirSync(join(this.runDir, "logs"), { recursive: true });
  }

  emit(
    type: TraceEvent["type"],
    source: string,
    data: unknown,
    opts: { parentId?: string; sessionId?: string } = {},
  ): TraceEvent {
    const event: TraceEvent = {
      id: randomUUID(),
      ts: Date.now(),
      type,
      source,
      ...(opts.parentId ? { parentId: opts.parentId } : {}),
      ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
      data,
    };
    appendFileSync(this.tracePath, JSON.stringify(event) + "\n");
    return event;
  }

  /** Read all events back (replay/analysis; not used on the hot path). */
  read(): TraceEvent[] {
    if (!existsSync(this.tracePath)) return [];
    return readFileSync(this.tracePath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as TraceEvent;
        } catch {
          return null;
        }
      })
      .filter((e): e is TraceEvent => e !== null);
  }
}

/** Truncate huge payloads before tracing (keeps the trace greppable, not gigabytes). */
export function clip(value: unknown, max = 200_000): unknown {
  const s = typeof value === "string" ? value : JSON.stringify(value);
  if (s == null) return value;
  if (s.length <= max) return value;
  return {
    __clipped: true,
    length: s.length,
    head: s.slice(0, max / 2),
    tail: s.slice(-1000),
  };
}
