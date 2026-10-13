export type DaySpend = {
  date: string;
  /** Chargeable cents for that day (0 if none / missing totalCostCents). */
  cents: number;
  ok: boolean;
};

export type UsageSnapshot = {
  days: DaySpend[];
  /** Display label for the subscribed plan (e.g. "Pro+", "Ultra"). */
  planLabel?: string;
  /** Raw membershipType from Cursor (e.g. "pro_plus"). */
  membershipType?: string;
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

export function parseUsageSummary(json: unknown): {
  isUnlimited: boolean;
  limitCents?: number;
  membershipType?: string;
} {
  if (!isRecord(json)) {
    return { isUnlimited: false };
  }
  const membershipType = str(json.membershipType);
  const isUnlimited = json.isUnlimited === true;
  const individual = isRecord(json.individualUsage) ? json.individualUsage : undefined;
  const overall = individual && isRecord(individual.overall) ? individual.overall : undefined;
  const plan = individual && isRecord(individual.plan) ? individual.plan : undefined;

  let limitCents: number | undefined;
  if (isRecord(overall) && overall.enabled !== false) {
    const limit = num(overall.limit);
    if (limit !== undefined && limit > 0) {
      limitCents = limit;
    }
  }
  if (limitCents === undefined && isRecord(plan) && plan.enabled !== false) {
    const limit = num(plan.limit);
    if (limit !== undefined && limit > 0) {
      limitCents = limit;
    }
  }

  return limitCents !== undefined
    ? { isUnlimited, limitCents, membershipType }
    : { isUnlimited, membershipType };
}

/** Map Cursor membershipType → dashboard-style label ("Pro+", "Ultra", …). */
export function formatMembershipLabel(membershipType: string | undefined): string | undefined {
  if (!membershipType) {
    return undefined;
  }
  const key = membershipType.trim().toLowerCase().replace(/[\s-]+/g, '_');
  const known: Record<string, string> = {
    free: 'Free',
    free_trial: 'Free Trial',
    hobby: 'Hobby',
    pro: 'Pro',
    pro_plus: 'Pro+',
    proplus: 'Pro+',
    ultra: 'Ultra',
    business: 'Business',
    team: 'Team',
    enterprise: 'Enterprise',
  };
  if (known[key]) {
    return known[key];
  }
  // Fallback: title-case tokens (foo_bar → Foo Bar).
  return key
    .split('_')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
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

/**
 * Colors sampled from https://cursor.com/dashboard/usage (chart legend)
 * and Spending progress fill `--color-dashboard-usage-accent`.
 */
export const DashboardColors = {
  /** Usage chart "default" / included-leaning green */
  included: '#009957',
  /** Usage chart warm accent (grok-4.7-high) — used for on-demand / overage */
  onDemand: '#FFCB78',
  /** Spending progress fill: rgb(129, 161, 193) */
  usageAccent: '#81A1C1',
  /** Usage chart cursor-grok blue */
  cursorModel: '#1084FE',
} as const;

export type DayBillingKind = 'included' | 'mixed' | 'onDemand';

/**
 * Classify each day in the 3-day window relative to the included plan limit,
 * approximating cycle spend before the window as cycleSpent − sum(days).
 */
export function classifyDayBilling(
  days: DaySpend[],
  cycleSpentCents: number | undefined,
  limitCents: number | undefined
): DayBillingKind[] {
  if (
    limitCents === undefined ||
    cycleSpentCents === undefined ||
    cycleSpentCents <= limitCents
  ) {
    return days.map(() => 'included');
  }

  const windowSpend = days.reduce((sum, d) => sum + Math.max(0, d.cents), 0);
  let spentBefore = Math.max(0, cycleSpentCents - windowSpend);

  return days.map((d) => {
    const start = spentBefore;
    const end = spentBefore + Math.max(0, d.cents);
    spentBefore = end;
    if (end <= limitCents) {
      return 'included';
    }
    if (start >= limitCents) {
      return 'onDemand';
    }
    return 'mixed';
  });
}

export function colorForDayBilling(kind: DayBillingKind): string {
  switch (kind) {
    case 'included':
      return DashboardColors.included;
    case 'onDemand':
      return DashboardColors.onDemand;
    case 'mixed':
      return DashboardColors.usageAccent;
  }
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

/** Per-day colored sparkline segments (for HTML tooltips). */
export function sparklineSegments(
  values: number[],
  kinds: DayBillingKind[]
): Array<{ bar: string; color: string }> {
  if (values.length === 0) {
    return [];
  }
  const max = Math.max(...values, 0);
  return values.map((v, i) => {
    let bar: string;
    if (max <= 0) {
      bar = BARS[0];
    } else {
      const ratio = Math.max(0, v) / max;
      const idx = Math.min(BARS.length - 1, Math.round(ratio * (BARS.length - 1)));
      bar = BARS[idx];
    }
    return { bar, color: colorForDayBilling(kinds[i] ?? 'included') };
  });
}
