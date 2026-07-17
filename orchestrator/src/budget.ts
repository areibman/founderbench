/**
 * Run clock + usage observer — observability only.
 *
 * No spend caps, no $/token rates. Token usage comes from the interception
 * proxy; optional business_spend_usd from metrics is recorded if present.
 * The only harness end condition is wall-clock duration.
 */
import type { InterceptionProxy } from "../../tracing/src/proxy.ts";
import type { TraceStore } from "../../tracing/src/trace.ts";

export type ClockStatus = "running" | "time_up";

export class BudgetMonitor {
  private lastEmit = 0;
  /** Optional observation from a metrics command named business_spend_usd. */
  businessSpendUsd = 0;

  constructor(
    private readonly proxy: InterceptionProxy,
    private readonly trace: TraceStore,
    private readonly endAt: number,
  ) {}

  timeRemainingMs(): number {
    return this.endAt - Date.now();
  }

  status(): { status: ClockStatus; reasons: string[] } {
    if (this.timeRemainingMs() <= 0) {
      return { status: "time_up", reasons: ["wall-clock duration elapsed"] };
    }
    return { status: "running", reasons: [] };
  }

  /** Emit usage/clock observation (rate-limited to once/minute). */
  maybeEmit(): void {
    if (Date.now() - this.lastEmit < 60_000) return;
    this.lastEmit = Date.now();
    const { status, reasons } = this.status();
    this.trace.emit("budget.update", "orchestrator", {
      usage: { ...this.proxy.usage },
      businessSpendUsd: this.businessSpendUsd,
      timeRemainingMs: this.timeRemainingMs(),
      status,
      reasons,
    });
  }
}
