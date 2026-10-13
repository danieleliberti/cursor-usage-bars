export type DaySpend = {
  date: string;
  /** Chargeable cents for that day (0 if none / missing totalCostCents). */
  cents: number;
  ok: boolean;
};

export type UsageSnapshot = {
  days: DaySpend[];
  /** Cycle-to-date chargeable spend in cents. */
  cycleSpentCents?: number;
  /** Per-user monthly cap in cents, when known. */
  limitCents?: number;
  /** True when cycle spend exceeds the included plan limit (on-demand / overage). */
  payingOutsidePlan: boolean;
  overageCents: number;
  periodStart?: string;
  lastError?: string;
  lastUpdated: Date;
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function num(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) {
    return v;
  }
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

export function parseAuthUsage(json: unknown): { periodStart?: string } {
  if (!isRecord(json)) {
    return {};
  }
  return {
    periodStart:
      str(json.startOfMonth) ?? str(json.periodStart) ?? str(json.cycleStart) ?? str(json.billingCycleStart),
  };
}

export function parseHardLimit(json: unknown): { limitCents?: number } {
  if (!isRecord(json)) {
    return {};
  }
  const dollars = num(json.perUserMonthlyLimitDollars);
  if (dollars === undefined || !(dollars > 0)) {
    return {};
  }
  return { limitCents: dollars * 100 };
}

export function parseUsageSummary(json: unknown): { isUnlimited: boolean; limitCents?: number } {
  if (!isRecord(json)) {
    return { isUnlimited: false };
  }
  const isUnlimited = json.isUnlimited === true;
  const overall = isRecord(json.individualUsage) ? json.individualUsage.overall : undefined;
  if (!isRecord(overall) || overall.enabled === false) {
    return { isUnlimited };
  }
  const limit = num(overall.limit);
  return limit !== undefined && limit > 0 ? { isUnlimited, limitCents: limit } : { isUnlimited };
}

/** Missing totalCostCents on a successful response means zero spend. */
export function parseAggregatedSpendCents(json: unknown): number | undefined {
  if (!isRecord(json)) {
    return undefined;
  }
  return num(json.totalCostCents) ?? 0;
}

export function resolveLimitCents(args: {
  summary?: { isUnlimited: boolean; limitCents?: number };
  hardLimit?: { limitCents?: number };
  manualLimitDollars?: number;
}): number | undefined {
  const { summary, hardLimit, manualLimitDollars } = args;
  if (manualLimitDollars !== undefined && manualLimitDollars > 0) {
    return manualLimitDollars * 100;
  }
  if (summary?.isUnlimited) {
    return undefined;
  }
  if (summary?.limitCents !== undefined) {
    return summary.limitCents;
  }
  return hardLimit?.limitCents;
}

export function formatCentsUsd(cents: number): string {
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(cents / 100);
}

/** Unicode block sparkline — 8 levels. */
const BARS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'] as const;

export function sparkline(values: number[]): string {
  if (values.length === 0) {
    return '';
  }
  const max = Math.max(...values, 0);
  if (max <= 0) {
    return values.map(() => BARS[0]).join('');
  }
  return values
    .map((v) => {
      const ratio = Math.max(0, v) / max;
      const idx = Math.min(BARS.length - 1, Math.round(ratio * (BARS.length - 1)));
      return BARS[idx];
    })
    .join('');
}
