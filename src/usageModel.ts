/** One model slice inside a day's stacked bar (dashboard “Group by: Model”). */
export type ModelSlice = {
  model: string;
  tokens: number;
  cents: number;
  color: string;
};

export type DaySpend = {
  date: string;
  /** Dollar-equivalent cents for that day (API totalCostCents). */
  cents: number;
  /** Token total for that day (preferred for bar height, matches dashboard). */
  tokens: number;
  /** Per-model slices for stacked bars. */
  slices: ModelSlice[];
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

function tokenFieldsSum(rec: Record<string, unknown>): number {
  const parts = [
    num(rec.inputTokens) ?? num(rec.totalInputTokens),
    num(rec.outputTokens) ?? num(rec.totalOutputTokens),
    num(rec.cacheWriteTokens) ?? num(rec.totalCacheWriteTokens),
    num(rec.cacheReadTokens) ?? num(rec.totalCacheReadTokens),
    num(rec.totalTokens),
  ];
  const sum = parts.reduce<number>((acc, n) => acc + (n ?? 0), 0);
  return sum > 0 ? sum : 0;
}

/**
 * Colors sampled live from https://cursor.com/dashboard/usage legend swatches.
 * Order matches the dashboard chart palette.
 */
export const MODEL_COLOR_PALETTE = [
  '#009957', // default
  '#FFCB78', // grok-4.7-high
  '#1084FE', // cursor-grok-4.6-high
  '#78DBD0', // cursor-grok-4.6-high-fast
  '#9159FE', // composer-2.5-fast
  '#F59E0B',
  '#EC4899',
  '#14B8A6',
] as const;

const KNOWN_MODEL_COLORS: Array<{ match: RegExp; color: string }> = [
  { match: /^(default|auto)$/i, color: '#009957' },
  { match: /grok-4\.7/i, color: '#FFCB78' },
  { match: /cursor-grok-4\.6.*fast/i, color: '#78DBD0' },
  { match: /cursor-grok-4\.6/i, color: '#1084FE' },
  { match: /composer/i, color: '#9159FE' },
  { match: /grok/i, color: '#FFCB78' },
];

export function colorForModel(model: string, fallbackIndex = 0): string {
  const name = model.trim() || 'default';
  for (const rule of KNOWN_MODEL_COLORS) {
    if (rule.match.test(name)) {
      return rule.color;
    }
  }
  return MODEL_COLOR_PALETTE[Math.abs(fallbackIndex) % MODEL_COLOR_PALETTE.length]!;
}

export function parseAggregatedDay(
  date: string,
  json: unknown,
  ok: boolean
): DaySpend {
  if (!ok || !isRecord(json)) {
    return { date, cents: 0, tokens: 0, slices: [], ok: false };
  }

  const cents = num(json.totalCostCents) ?? 0;
  let tokens = tokenFieldsSum(json);

  const slices: ModelSlice[] = [];
  const aggregations = Array.isArray(json.aggregations) ? json.aggregations : [];
  aggregations.forEach((row, i) => {
    if (!isRecord(row)) {
      return;
    }
    const model =
      str(row.modelIntent) ??
      str(row.model) ??
      str(row.modelName) ??
      str(row.name) ??
      `model-${i + 1}`;
    const sliceCents = num(row.totalCents) ?? num(row.totalCostCents) ?? 0;
    let sliceTokens = tokenFieldsSum(row);
    if (sliceTokens <= 0 && sliceCents > 0) {
      sliceTokens = sliceCents;
    }
    if (sliceTokens <= 0 && sliceCents <= 0) {
      return;
    }
    slices.push({
      model,
      tokens: sliceTokens,
      cents: sliceCents,
      color: colorForModel(model, i),
    });
  });

  if (tokens <= 0 && slices.length) {
    tokens = slices.reduce((s, x) => s + x.tokens, 0);
  }
  if (tokens <= 0 && cents > 0) {
    tokens = cents;
  }

  // If API gave totals but no per-model rows, one solid bar in dashboard green.
  if (!slices.length && (tokens > 0 || cents > 0)) {
    slices.push({
      model: 'default',
      tokens: tokens || cents,
      cents,
      color: colorForModel('default'),
    });
  }

  return { date, cents, tokens, slices, ok: true };
}

export function formatCentsUsd(cents: number): string {
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(cents / 100);
}

export const DashboardColors = {
  included: '#009957',
  onDemand: '#FFCB78',
  usageAccent: '#81A1C1',
  cursorModel: '#1084FE',
  track: '#E8E8E8',
} as const;

/** Metric used for bar height — tokens when present (dashboard), else cents. */
export function dayBarValue(d: DaySpend): number {
  return d.tokens > 0 ? d.tokens : Math.max(0, d.cents);
}

/** Unicode block sparkline glyphs (shared typographic baseline). */
const BARS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'] as const;

/**
 * Build an SVG stacked bar chart (shared baseline + dashboard model colors).
 * Returned as a markdown image — VS Code tooltips strip HTML tables/styles,
 * but data-URI SVG images render reliably.
 */
export function buildUsageChartSvg(days: DaySpend[], chartHeight = 72): string {
  if (days.length === 0) {
    return '';
  }

  const padL = 4;
  const padR = 4;
  const padT = 6;
  const padB = 10;
  const gap = days.length > 20 ? 1 : days.length > 12 ? 2 : 3;
  const barW = days.length > 20 ? 6 : days.length > 12 ? 8 : 10;
  const plotH = chartHeight;
  const width = padL + padR + days.length * barW + Math.max(0, days.length - 1) * gap;
  const height = padT + plotH + padB;
  const baselineY = padT + plotH;
  const max = Math.max(...days.map(dayBarValue), 1);

  const rects: string[] = [];
  rects.push(
    `<rect x="0" y="0" width="${width}" height="${height}" fill="#FCFCFC" rx="6"/>`
  );
  for (const t of [0.25, 0.5, 0.75]) {
    const y = padT + plotH * (1 - t);
    rects.push(
      `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${width - padR}" y2="${y.toFixed(1)}" stroke="#E8E8E8" stroke-width="1"/>`
    );
  }
  rects.push(
    `<line x1="${padL}" y1="${baselineY}" x2="${width - padR}" y2="${baselineY}" stroke="#D0D0D0" stroke-width="1.5"/>`
  );

  days.forEach((d, i) => {
    const x = padL + i * (barW + gap);
    const value = dayBarValue(d);
    const barH = value <= 0 ? 0 : Math.max(3, (value / max) * plotH);
    const slices =
      d.slices.length > 0
        ? d.slices
        : value > 0
          ? [
              {
                model: 'default',
                tokens: value,
                cents: d.cents,
                color: colorForModel('default'),
              },
            ]
          : [];
    if (!slices.length || barH <= 0) {
      return;
    }
    const sliceTotal =
      slices.reduce((s, sl) => s + (d.tokens > 0 ? sl.tokens : sl.cents || sl.tokens), 0) || 1;

    let yBottom = baselineY;
    let remaining = barH;
    slices.forEach((sl, si) => {
      const portion = (d.tokens > 0 ? sl.tokens : sl.cents || sl.tokens) / sliceTotal;
      const raw = portion * barH;
      const segH =
        si === slices.length - 1
          ? Math.max(0, remaining)
          : Math.min(remaining, Math.max(portion > 0 ? 1 : 0, raw));
      remaining -= segH;
      const y = yBottom - segH;
      yBottom = y;
      if (segH <= 0) {
        return;
      }
      const rx = si === slices.length - 1 ? 2 : 0;
      rects.push(
        `<rect x="${x}" y="${y.toFixed(2)}" width="${barW}" height="${segH.toFixed(2)}" fill="${sl.color}" rx="${rx}"/>`
      );
    });
  });

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    rects.join('') +
    `</svg>`
  );
}

/** Markdown image embedding the SVG chart (works in VS Code / Cursor tooltips). */
export function renderBaselineChartMarkdown(days: DaySpend[], chartHeight = 72): string {
  const svg = buildUsageChartSvg(days, chartHeight);
  if (!svg) {
    return '';
  }
  return `![usage](data:image/svg+xml,${encodeURIComponent(svg)})`;
}

/** Text fallback when images are blocked: one glyph per day, dominant model color. */
export function renderFallbackSparklineHtml(days: DaySpend[]): string {
  if (days.length === 0) {
    return '';
  }
  const values = days.map(dayBarValue);
  const max = Math.max(...values, 0);
  const glyphs = days.map((d, i) => {
    const v = values[i] ?? 0;
    let bar: string = BARS[0];
    if (max > 0 && v > 0) {
      const idx = Math.max(1, Math.min(BARS.length - 1, Math.round((v / max) * (BARS.length - 1))));
      bar = BARS[idx]!;
    }
    const top = d.slices.reduce<ModelSlice | undefined>(
      (best, s) => (!best || s.tokens + s.cents > best.tokens + best.cents ? s : best),
      undefined
    );
    const color = top?.color ?? colorForModel('default');
    return `<span style="color:${color};font-family:monospace;font-size:14px;line-height:1;vertical-align:bottom;">${bar}</span>`;
  });
  return `<span style="font-family:monospace;line-height:1;white-space:pre;">${glyphs.join('')}</span>`;
}

export function chartLegendHtml(days: DaySpend[]): string {
  const seen = new Map<string, string>();
  for (const d of days) {
    for (const s of d.slices) {
      if (!seen.has(s.model)) {
        seen.set(s.model, s.color);
      }
    }
  }
  if (seen.size === 0) {
    return '';
  }
  return [...seen.entries()]
    .slice(0, 8)
    .map(
      ([model, color]) =>
        `<span style="color:${color};">■</span>&nbsp;${escapeHtmlLite(model)}`
    )
    .join('&nbsp;&nbsp;');
}

function escapeHtmlLite(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function sparkline(values: number[]): string {
  if (values.length === 0) {
    return '';
  }
  const max = Math.max(...values, 0);
  if (max <= 0) {
    // Same glyph for every empty day so the baseline reads flat.
    return values.map(() => BARS[0]).join('');
  }
  return values
    .map((v) => {
      if (v <= 0) {
        return BARS[0];
      }
      const ratio = v / max;
      // Avoid rounding everything toward mid glyphs; keep a true shared floor.
      const idx = Math.max(1, Math.min(BARS.length - 1, Math.round(ratio * (BARS.length - 1))));
      return BARS[idx];
    })
    .join('');
}
