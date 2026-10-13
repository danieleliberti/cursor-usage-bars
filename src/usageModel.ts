export type DaySpend = {
  date: string;
  /** Chargeable cents for that day (0 if none / missing totalCostCents). */
  cents: number;
  ok: boolean;
};

/** Supported hover-popup day ranges. */
export type DayRange = 7 | 15 | 30;

export const DAY_RANGES: readonly DayRange[] = [7, 15, 30] as const;

export function parseDayRange(value: unknown, fallback: DayRange = 7): DayRange {
  const n = typeof value === 'number' ? value : Number(value);
  return DAY_RANGES.includes(n as DayRange) ? (n as DayRange) : fallback;
}

export type UsageSnapshot = {
  days: DaySpend[];
  /** Selected lookback window shown in the tooltip (7 / 15 / 30). */
  dayRange: DayRange;
  /** Display label for the subscribed plan (e.g. "Pro+", "Ultra"). */
  planLabel?: string;
  /** Raw membershipType from Cursor (e.g. "pro_plus"). */
  membershipType?: string;
  /**
   * Cycle-to-date usage value in cents from aggregated events.
   * This is NOT the same as billed on-demand spend — included plan usage
   * still has a dollar-equivalent here.
   */
  cycleSpentCents?: number;
  /** True only when Cursor reports real on-demand / overage charges. */
  payingOutsidePlan: boolean;
  /** Billed on-demand cents from usage-summary (0 when within included plan). */
  overageCents: number;
  /** Whether on-demand spending is enabled on the account. */
  onDemandEnabled?: boolean;
  /** Included-plan usage headline % from the dashboard (0–100+), when known. */
  planPercentUsed?: number;
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

export type ParsedUsageSummary = {
  isUnlimited: boolean;
  membershipType?: string;
  /** Real billed on-demand spend in cents (dashboard “On-Demand”). */
  onDemandEnabled: boolean;
  onDemandUsedCents: number;
  /** Dashboard headline % for included usage, when present. */
  planPercentUsed?: number;
};

/**
 * Source of truth for plan vs overage is usage-summary.onDemand — NOT
 * comparing aggregated totalCostCents to plan.limit (those are different pools).
 */
export function parseUsageSummary(json: unknown): ParsedUsageSummary {
  if (!isRecord(json)) {
    return { isUnlimited: false, onDemandEnabled: false, onDemandUsedCents: 0 };
  }
  const membershipType = str(json.membershipType);
  const isUnlimited = json.isUnlimited === true;
  const individual = isRecord(json.individualUsage) ? json.individualUsage : undefined;
  const team = isRecord(json.teamUsage) ? json.teamUsage : undefined;
  const plan = individual && isRecord(individual.plan) ? individual.plan : undefined;
  const onDemand =
    (individual && isRecord(individual.onDemand) ? individual.onDemand : undefined) ??
    (team && isRecord(team.onDemand) ? team.onDemand : undefined);

  const onDemandEnabled = isRecord(onDemand) ? onDemand.enabled === true : false;
  const onDemandUsedCents =
    isRecord(onDemand) && num(onDemand.used) !== undefined
      ? Math.max(0, num(onDemand.used)!)
      : 0;

  let planPercentUsed: number | undefined;
  if (isRecord(plan)) {
    const total = num(plan.totalPercentUsed);
    if (total !== undefined) {
      planPercentUsed = total;
    }
  }

  return {
    isUnlimited,
    membershipType,
    onDemandEnabled,
    onDemandUsedCents,
    planPercentUsed,
  };
}

/** True only when the account has actual on-demand charges this cycle. */
export function resolvePayingOutsidePlan(summary: ParsedUsageSummary | undefined): {
  payingOutsidePlan: boolean;
  overageCents: number;
} {
  if (!summary) {
    return { payingOutsidePlan: false, overageCents: 0 };
  }
  // Disabled on-demand ⇒ nothing is billed beyond the subscription.
  if (!summary.onDemandEnabled) {
    return { payingOutsidePlan: false, overageCents: 0 };
  }
  const overageCents = Math.max(0, summary.onDemandUsedCents);
  return { payingOutsidePlan: overageCents > 0, overageCents };
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
 * Day colors follow the dashboard: green while within the included subscription.
 * Only mark days on-demand when Cursor reports real on-demand charges this cycle.
 * (Aggregated totalCostCents is usage value, not a bill — do not compare it to plan.limit.)
 */
export function classifyDayBilling(
  days: DaySpend[],
  payingOutsidePlan: boolean
): DayBillingKind[] {
  if (!payingOutsidePlan) {
    return days.map(() => 'included');
  }
  // With on-demand active we still treat recent daily value as mixed (included + on-demand),
  // not as pure yellow “over” — the billed amount is shown separately as overage.
  return days.map(() => 'mixed');
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
