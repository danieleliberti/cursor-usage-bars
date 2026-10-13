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

export type DayWindow = {
  /** Local calendar date YYYY-MM-DD */
  date: string;
  startMs: number;
  endMs: number;
};

/** Last 2 full local days + today so far. */
export function buildLastThreeDayWindows(now: Date = new Date()): DayWindow[] {
  const localMidnight = (d: Date): Date =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);

  const todayStart = localMidnight(now);
  const windows: DayWindow[] = [];
  for (let offset = 2; offset >= 0; offset--) {
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

export type UsageBundle = {
  auth: FetchResult;
  hardLimit: FetchResult;
  summary: FetchResult;
  days: Array<{ window: DayWindow; result: FetchResult }>;
  cycleSpend: FetchResult;
  allowed: AllowedOriginResult & { ok: true };
};

/**
 * Fetches cycle metadata + spend for each of the last 3 local days.
 * Uses undocumented Cursor dashboard endpoints (same pattern as community status-bar extensions).
 */
export async function fetchUsageBundle(
  apiBaseUrl: string,
  token: string,
  teamId: number | null,
  now: Date = new Date()
): Promise<UsageBundle> {
  const allowed = parseAllowedApiBase(apiBaseUrl);
  if (!allowed.ok) {
    throw new Error(allowed.reason);
  }

  const windows = buildLastThreeDayWindows(now);

  const [auth, hardLimit, summary, ...dayResults] = await Promise.all([
    httpsGet(usageUrl(allowed.baseUrl, '/auth/usage'), token, allowed),
    httpsPostJson(
      usageUrl(allowed.baseUrl, DASHBOARD + '/GetHardLimit'),
      token,
      teamId === null ? {} : { teamId },
      allowed
    ),
    httpsGet(usageUrl(allowed.baseUrl, '/auth/usage-summary'), token, allowed),
    ...windows.map((w) =>
      httpsPostJson(
        usageUrl(allowed.baseUrl, DASHBOARD + '/GetAggregatedUsageEvents'),
        token,
        { startDate: String(w.startMs), endDate: String(w.endMs) },
        allowed
      )
    ),
  ]);

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

  const cycleSpend = await httpsPostJson(
    usageUrl(allowed.baseUrl, DASHBOARD + '/GetAggregatedUsageEvents'),
    token,
    { startDate: String(cycleStartMs), endDate: String(now.getTime()) },
    allowed
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
