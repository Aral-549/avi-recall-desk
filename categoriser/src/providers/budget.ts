export type BudgetLimits = { rpm: number; rpd: number };

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/**
 * In-process sliding-window request counter. `tryConsume` reserves a slot or returns false;
 * callers fail closed to rules rather than queueing, so a free-tier quota is never exceeded.
 */
export class BudgetGuard {
  private readonly stamps: number[] = [];

  constructor(
    readonly limits: BudgetLimits,
    private readonly now: () => number = Date.now,
  ) {}

  tryConsume(): boolean {
    const t = this.now();
    while (this.stamps.length && this.stamps[0]! <= t - DAY_MS) this.stamps.shift();
    const lastMinute = this.stamps.filter((s) => s > t - MINUTE_MS).length;
    if (lastMinute >= this.limits.rpm || this.stamps.length >= this.limits.rpd) return false;
    this.stamps.push(t);
    return true;
  }

  usage(): { minute: number; day: number } {
    const t = this.now();
    return {
      minute: this.stamps.filter((s) => s > t - MINUTE_MS).length,
      day: this.stamps.filter((s) => s > t - DAY_MS).length,
    };
  }
}
