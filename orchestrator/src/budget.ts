/** Budget tracking: token spend (from the proxy) + wall clock. Business spend caps
 * are enforced primarily at the account level (meow/Meta); the orchestrator records
 * spend observations from metrics snapshots and flags breaches. */
import type { InterceptionProxy } from "../../tracing/src/proxy.ts";
import type { TraceStore } from "../../tracing/src/trace.ts";
import type { RunConfig } from "./config.ts";

export type BudgetStatus = "ok" | "warning" | "breach";

export class BudgetMonitor {
  private lastEmit = 0;
  businessSpendUsd = 0; // updated by metrics snapshots when available

  constructor(
    private readonly cfg: RunConfig["budget"],
    private readonly proxy: InterceptionProxy,
    private readonly trace: TraceStore,
    private readonly endAt: number,
  ) {}

  tokenSpendUsd(): number {
    const u = this.proxy.usage;
    return (
      (u.inputTokens / 1_000_000) * this.cfg.input_cost_per_mtok +
      (u.outputTokens / 1_000_000) * this.cfg.output_cost_per_mtok
    );
  }

  timeRemainingMs(): number {
    return this.endAt - Date.now();
  }

  status(): { status: BudgetStatus; reasons: string[] } {
    const reasons: string[] = [];
    let status: BudgetStatus = "ok";
    const tokenSpend = this.tokenSpendUsd();

    const warnFraction = this.cfg.warn_fraction ?? 0.8;
    const evaluate = (value: number, cap: number, label: string) => {
      if (cap <= 0) return;
      if (value >= cap) {
        status = "breach";
        reasons.push(`${label}: $${value.toFixed(2)} >= cap $${cap}`);
      } else if (value >= cap * warnFraction && status === "ok") {
        status = "warning";
        reasons.push(
          `${label}: $${value.toFixed(2)} at ${Math.round(warnFraction * 100)}% of cap $${cap}`,
        );
      }
    };
    evaluate(tokenSpend, this.cfg.max_token_spend_usd, "token spend");
    evaluate(this.businessSpendUsd, this.cfg.max_business_spend_usd, "business spend");

    if (this.timeRemainingMs() <= 0) {
      status = "breach";
      reasons.push("wall-clock limit reached");
    }
    return { status, reasons };
  }

  /** Emit a budget.update trace event (rate-limited to once/minute). */
  maybeEmit(): void {
    if (Date.now() - this.lastEmit < 60_000) return;
    this.lastEmit = Date.now();
    const { status, reasons } = this.status();
    this.trace.emit(status === "breach" ? "budget.breach" : "budget.update", "orchestrator", {
      tokenSpendUsd: this.tokenSpendUsd(),
      businessSpendUsd: this.businessSpendUsd,
      usage: { ...this.proxy.usage },
      timeRemainingMs: this.timeRemainingMs(),
      status,
      reasons,
    });
  }
}
