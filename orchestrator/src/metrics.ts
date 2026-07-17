/** Metrics snapshots: run configured shell commands on an interval, capture output
 * into the trace. Commands come from the run config (asc sales, revenuecat overview,
 * bank balance via JMAP/API where available, etc.). */
import { exec } from "node:child_process";
import type { TraceStore } from "../../tracing/src/trace.ts";
import type { BudgetMonitor } from "./budget.ts";

export class MetricsCollector {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly commands: Record<string, string>,
    private readonly trace: TraceStore,
    private readonly budget: BudgetMonitor,
    private readonly intervalMs: number,
    private readonly cwd: string,
  ) {}

  start(): void {
    void this.snapshot(); // immediate baseline
    this.timer = setInterval(() => void this.snapshot(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async snapshot(): Promise<void> {
    const results: Record<string, { ok: boolean; output: unknown }> = {};
    for (const [name, cmd] of Object.entries(this.commands)) {
      results[name] = await this.run(cmd);
    }
    // Business-spend extraction: a metrics command named "business_spend_usd" whose
    // stdout is a bare number feeds the budget monitor.
    const spend = results["business_spend_usd"];
    if (spend?.ok && typeof spend.output === "string") {
      const n = Number.parseFloat(spend.output.trim());
      if (Number.isFinite(n)) this.budget.businessSpendUsd = n;
    }
    this.trace.emit("metrics.snapshot", "metrics", {
      results, // verbatim — no truncation
      businessSpendUsd: this.budget.businessSpendUsd,
    });
  }

  private run(cmd: string): Promise<{ ok: boolean; output: string }> {
    return new Promise((resolve) => {
      exec(
        cmd,
        { cwd: this.cwd, timeout: 120_000, env: process.env, maxBuffer: 256 * 1024 * 1024 },
        (err, stdout, stderr) => {
          resolve({ ok: !err, output: err ? `${stdout}\n${stderr}\n${String(err)}` : stdout });
        },
      );
    });
  }
}
