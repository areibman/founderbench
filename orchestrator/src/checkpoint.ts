/** Checkpoints: enough state to restart-and-resume deterministically. */
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import type { TraceStore } from "../../tracing/src/trace.ts";

export interface Checkpoint {
  runId: string;
  sessionId: string | null;
  appRepoSha: string | null;
  startedAt: number;
  endAt: number;
  nudges: number;
  restarts: number;
  updatedAt: number;
}

export class CheckpointStore {
  private readonly path: string;

  constructor(private readonly trace: TraceStore) {
    this.path = join(trace.runDir, "checkpoint.json");
  }

  load(): Checkpoint | null {
    if (!existsSync(this.path)) return null;
    try {
      return JSON.parse(readFileSync(this.path, "utf8")) as Checkpoint;
    } catch {
      return null;
    }
  }

  save(cp: Checkpoint, appRepoDir: string): void {
    cp.appRepoSha = gitSha(appRepoDir);
    cp.updatedAt = Date.now();
    writeFileSync(this.path, JSON.stringify(cp, null, 2));
    this.trace.emit("run.checkpoint", "orchestrator", cp);
  }
}

function gitSha(dir: string): string | null {
  try {
    return execSync("git rev-parse HEAD", { cwd: dir, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}
