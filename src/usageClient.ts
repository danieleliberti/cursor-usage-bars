import * as https from 'https';
import type { IncomingMessage } from 'http';
import type { AllowedOriginResult } from './urlAllowlist';
import { assertSameOrigin, parseAllowedApiBase, usageUrl } from './urlAllowlist';

export type FetchResult =
  | { ok: true; status: number; json: unknown }
  | { ok: false; status?: number; error: string };

const DASHBOARD = '/aiserver.v1.DashboardService';

function readResponse(res: IncomingMessage, resolve: (r: FetchResult) => void): void {
  const chunks: Buffer[] = [];
  res.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
  res.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    const status = res.statusCode ?? 0;
    if (status < 200 || status >= 300) {
      resolve({ ok: false, status, error: `HTTP ${status}` });
      return;
    }
    try {
      resolve({ ok: true, status, json: body.length ? JSON.parse(body) : {} });
    } catch {
      resolve({ ok: false, status, error: 'Response was not valid JSON.' });
    }
  });
}

function httpsGet(url: URL, token: string, allowed: AllowedOriginResult & { ok: true }): Promise<FetchResult> {
  assertSameOrigin(url, allowed);
  return new Promise((resolve) => {
    const req = https.request(
      url,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          'User-Agent': 'cursor-usage-bars',
        },
        timeout: 8_000,
      },
      (res) => readResponse(res, resolve)
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, error: 'Request timed out.' });
    });
    req.on('error', () => resolve({ ok: false, error: 'Network error.' }));
    req.end();
  });
}

function httpsPostJson(
  url: URL,
  token: string,
  body: unknown,
  allowed: AllowedOriginResult & { ok: true }
): Promise<FetchResult> {
  assertSameOrigin(url, allowed);
  const payload = JSON.stringify(body ?? {});
  return new Promise((resolve) => {
    const req = https.request(
      url,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'Connect-Protocol-Version': '1',
          'User-Agent': 'cursor-usage-bars',
        },
        timeout: 8_000,
      },
      (res) => readResponse(res, resolve)
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, error: 'Request timed out.' });
    });
    req.on('error', () => resolve({ ok: false, error: 'Network error.' }));
    req.write(payload);
    req.end();
  });
}

function isRetryable(result: FetchResult): boolean {
  if (result.ok) {
    return false;
  }
  const status = result.status;
  if (status === 429 || status === 502 || status === 503 || status === 504) {
    return true;
  }
  return result.error === 'Request timed out.' || result.error === 'Network error.';
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

/** Retry transient Cursor API failures (common 503 on per-day aggregates). */
async function withRetries(
  run: () => Promise<FetchResult>,
  attempts = 3,
  baseDelayMs = 450
): Promise<FetchResult> {
  let last: FetchResult = { ok: false, error: 'Unknown error.' };
  for (let i = 0; i < attempts; i++) {
    last = await run();
    if (last.ok || !isRetryable(last) || i === attempts - 1) {
      return last;
    }
    await sleep(baseDelayMs * (i + 1));
  }
  return last;
}

async function mapPool<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  }
  const n = Math.max(1, Math.min(concurrency, items.length || 1));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return out;
}

export type DayWindow = {
  /** Local calendar date YYYY-MM-DD */
  date: string;
  startMs: number;
  endMs: number;
};

/** Last `dayCount` local calendar days ending today (today is partial). */
export function buildDayWindows(dayCount: number, now: Date = new Date()): DayWindow[] {
  const count = Math.max(1, Math.min(31, Math.floor(dayCount)));
  const localMidnight = (d: Date): Date =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);

  const todayStart = localMidnight(now);
  const windows: DayWindow[] = [];
  for (let offset = count - 1; offset >= 0; offset--) {
    const start = new Date(todayStart);
    start.setDate(start.getDate() - offset);
    const end =
      offset === 0
        ? now
        : (() => {
            const e = new Date(start);
            e.setDate(e.getDate() + 1);
            return e;
          })();
    const y = start.getFullYear();
    const m = String(start.getMonth() + 1).padStart(2, '0');
    const day = String(start.getDate()).padStart(2, '0');
    windows.push({
      date: `${y}-${m}-${day}`,
      startMs: start.getTime(),
      endMs: end.getTime(),
    });
  }
  return windows;
}

/** @deprecated Use buildDayWindows(3). */
export function buildLastThreeDayWindows(now: Date = new Date()): DayWindow[] {
  return buildDayWindows(3, now);
}

export type UsageBundle = {
  auth: FetchResult;
  hardLimit: FetchResult;
  summary: FetchResult;
  days: Array<{ window: DayWindow; result: FetchResult }>;
  cycleSpend: FetchResult;
  allowed: AllowedOriginResult & { ok: true };
};

/**
 * Fetches cycle metadata + spend for each day in the lookback window.
 * Uses undocumented Cursor dashboard endpoints (same pattern as community status-bar extensions).
 */
export async function fetchUsageBundle(
  apiBaseUrl: string,
  token: string,
  teamId: number | null,
  now: Date = new Date(),
  dayCount = 7
): Promise<UsageBundle> {
  const allowed = parseAllowedApiBase(apiBaseUrl);
  if (!allowed.ok) {
    throw new Error(allowed.reason);
  }

  const windows = buildDayWindows(dayCount, now);

  const [auth, hardLimit, summary] = await Promise.all([
    withRetries(() => httpsGet(usageUrl(allowed.baseUrl, '/auth/usage'), token, allowed)),
    withRetries(() =>
      httpsPostJson(
        usageUrl(allowed.baseUrl, DASHBOARD + '/GetHardLimit'),
        token,
        teamId === null ? {} : { teamId },
        allowed
      )
    ),
    withRetries(() =>
      httpsGet(usageUrl(allowed.baseUrl, '/auth/usage-summary'), token, allowed)
    ),
  ]);

  // Limit concurrency — blasting 15–30 day calls at once often triggers HTTP 503.
  const dayResults = await mapPool(windows, 4, (w) =>
    withRetries(() =>
      httpsPostJson(
        usageUrl(allowed.baseUrl, DASHBOARD + '/GetAggregatedUsageEvents'),
        token,
        { startDate: String(w.startMs), endDate: String(w.endMs) },
        allowed
      )
    )
  );

  // Cycle-to-date spend for overage detection (period from /auth/usage when available).
  let cycleStartMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  if (auth.ok && auth.json && typeof auth.json === 'object' && auth.json !== null) {
    const startOfMonth = (auth.json as { startOfMonth?: unknown }).startOfMonth;
    if (typeof startOfMonth === 'string' && startOfMonth.trim()) {
      const parsed = Date.parse(startOfMonth);
      if (Number.isFinite(parsed)) {
        cycleStartMs = parsed;
      }
    }
  }

  const cycleSpend = await withRetries(() =>
    httpsPostJson(
      usageUrl(allowed.baseUrl, DASHBOARD + '/GetAggregatedUsageEvents'),
      token,
      { startDate: String(cycleStartMs), endDate: String(now.getTime()) },
      allowed
    )
  );

  return {
    auth,
    hardLimit,
    summary,
    days: windows.map((window, i) => ({ window, result: dayResults[i]! })),
    cycleSpend,
    allowed,
  };
}
