import * as vscode from 'vscode';
import { probeCursorAuth, readCursorAccessToken, readCursorTeamId } from './cursorAuth';
import { fetchUsageBundle } from './usageClient';
import {
  DAY_RANGES,
  formatMembershipLabel,
  parseAggregatedDay,
  parseAggregatedSpendCents,
  parseAuthUsage,
  parseDayRange,
  parseUsageSummary,
  projectPlanUsageAtCycleEnd,
  resolvePayingOutsidePlan,
  type DayRange,
  type DaySpend,
  type UsageSnapshot,
} from './usageModel';
import { parseAllowedApiBase } from './urlAllowlist';
import { UsageBarsStatusBar } from './statusBar';
import { clearStoredToken, resolveToken, writeStoredToken } from './tokenStore';

const DASHBOARD_DEFAULT = 'https://cursor.com/dashboard/usage';
const DAY_RANGE_STATE_KEY = 'cursorUsageBars.dayRange';
const DEFAULT_DAY_RANGE: DayRange = 7;

function refreshBudgetMs(dayRange: DayRange): number {
  // Longer windows issue more parallel day requests.
  if (dayRange >= 30) {
    return 45_000;
  }
  if (dayRange >= 15) {
    return 35_000;
  }
  return 25_000;
}

let pollTimer: NodeJS.Timeout | undefined;
let statusBar: UsageBarsStatusBar | undefined;
let output: vscode.OutputChannel | undefined;
let extensionContext: vscode.ExtensionContext | undefined;
let refreshInFlight = false;

function log(msg: string): void {
  output?.appendLine(`[${new Date().toISOString()}] ${msg}`);
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

function clampPollSeconds(raw: number): number {
  if (!Number.isFinite(raw)) {
    return 300;
  }
  return Math.max(60, Math.floor(raw));
}

function readConfig() {
  const cfg = vscode.workspace.getConfiguration('cursorUsageBars');
  const manual = Number(cfg.get<number>('manualMonthlyLimitDollars') ?? 0);
  return {
    apiBaseUrl: String(cfg.get<string>('apiBaseUrl') ?? 'https://api2.cursor.sh'),
    pollIntervalSeconds: clampPollSeconds(Number(cfg.get<number>('pollIntervalSeconds') ?? 300)),
    manualMonthlyLimitDollars: Number.isFinite(manual) && manual > 0 ? manual : undefined,
    dashboardUrl: String(cfg.get<string>('dashboardUrl') ?? DASHBOARD_DEFAULT),
    dayRangeDefault: parseDayRange(cfg.get<number>('dayRange'), DEFAULT_DAY_RANGE),
  };
}

function getDayRange(context: vscode.ExtensionContext): DayRange {
  const stored = context.globalState.get<unknown>(DAY_RANGE_STATE_KEY);
  if (stored !== undefined && stored !== null) {
    return parseDayRange(stored, DEFAULT_DAY_RANGE);
  }
  return readConfig().dayRangeDefault;
}

async function setDayRange(context: vscode.ExtensionContext, days: unknown): Promise<void> {
  const next = parseDayRange(days, getDayRange(context));
  await context.globalState.update(DAY_RANGE_STATE_KEY, next);
  log(`dayRange set to ${next}D`);
  await refreshUsage();
}

function hostLabel(context: vscode.ExtensionContext): string {
  return context.extension.extensionKind === vscode.ExtensionKind.UI ? 'UI' : 'Workspace';
}

async function showAuthStatus(): Promise<void> {
  if (!extensionContext) {
    return;
  }
  try {
    const probe = await withTimeout(probeCursorAuth(), 10_000, 'auth probe');
    const resolved = await withTimeout(
      resolveToken(extensionContext, readCursorAccessToken),
      10_000,
      'resolve token'
    );
    const msg = [
      `Host: ${hostLabel(extensionContext)}`,
      `Remote: ${vscode.env.remoteName ?? '(none)'}`,
      `Token: ${resolved.token ? `ok (${resolved.source})` : 'missing'}`,
      `DB: ${probe.dbPath ?? 'n/a'}`,
      probe.error ? `DB error: ${probe.error}` : undefined,
    ]
      .filter(Boolean)
      .join(' — ');
    log(msg);
    output?.show(true);
    await vscode.window.showInformationMessage(msg);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(`authStatus error: ${msg}`);
    await vscode.window.showErrorMessage(`Cursor Usage Bars: ${msg}`);
  }
}

async function promptSetToken(): Promise<void> {
  if (!extensionContext) {
    return;
  }
  const token = await vscode.window.showInputBox({
    title: 'Cursor Usage Bars — Access Token (fallback)',
    prompt: 'Prefer Local install + Cursor sign-in (automatic). Paste a session token only as fallback.',
    password: true,
    ignoreFocusOut: true,
  });
  if (!token?.trim()) {
    return;
  }
  await writeStoredToken(extensionContext, token);
  await refreshUsage();
}

async function refreshUsageInner(): Promise<void> {
  if (!statusBar || !extensionContext) {
    return;
  }
  const c = readConfig();
  log(`${hostLabel(extensionContext)} refresh start remote=${vscode.env.remoteName ?? 'none'}`);

  const baseCheck = parseAllowedApiBase(c.apiBaseUrl);
  if (!baseCheck.ok) {
    statusBar.setError(baseCheck.reason);
    return;
  }

  // Team id is optional — never block refresh on it.
  const teamIdPromise = readCursorTeamId().catch(() => null);

  const resolved = await resolveToken(extensionContext, readCursorAccessToken);
  log(`token source=${resolved.source}`);

  if (!resolved.token) {
    const isUi = extensionContext.extension.extensionKind === vscode.ExtensionKind.UI;
    statusBar.setError(
      isUi
        ? 'Cursor login not found — sign in to Cursor, or run: Set Access Token'
        : 'Waiting for Local UI sync (.cursor/usage-bars.accessToken)'
    );
    return;
  }

  const teamId = await Promise.race([
    teamIdPromise,
    new Promise<null>((r) => setTimeout(() => r(null), 2_000)),
  ]);

  const now = new Date();
  const dayRange = getDayRange(extensionContext);
  const bundle = await fetchUsageBundle(c.apiBaseUrl, resolved.token, teamId, now, dayRange);

  const days: DaySpend[] = bundle.days.map(({ window, result }) =>
    parseAggregatedDay(window.date, result.ok ? result.json : undefined, result.ok)
  );

  const auth = bundle.auth.ok ? parseAuthUsage(bundle.auth.json) : {};
  const summary = bundle.summary.ok ? parseUsageSummary(bundle.summary.json) : undefined;
  const { payingOutsidePlan, overageCents } = resolvePayingOutsidePlan(summary);

  const cycleSpentCents = bundle.cycleSpend.ok
    ? parseAggregatedSpendCents(bundle.cycleSpend.json)
    : undefined;

  const errParts: string[] = [];
  const fmt = (r: { error: string; status?: number }) =>
    r.error + (r.status !== undefined ? ` (${r.status})` : '');
  if (!bundle.auth.ok) errParts.push(`auth: ${fmt(bundle.auth)}`);
  if (!bundle.summary.ok) errParts.push(`summary: ${fmt(bundle.summary)}`);
  if (!bundle.cycleSpend.ok) errParts.push(`cycle: ${fmt(bundle.cycleSpend)}`);
  for (const d of bundle.days) {
    if (!d.result.ok) errParts.push(`${d.window.date}: ${fmt(d.result)}`);
  }
  if (errParts.length) {
    log(`API partial errors: ${errParts.join('; ')}`);
  }

  // If every usage call failed, surface an error instead of a fake $0 sparkline.
  const anyDayOk = days.some((d) => d.ok);
  if (!anyDayOk && !bundle.cycleSpend.ok) {
    statusBar.setError(errParts.join('; ') || 'Usage API failed');
    return;
  }

  const membershipType = summary?.membershipType;
  const planLabel = formatMembershipLabel(membershipType);
  // Prefer usage-summary billing cycle; fall back to /auth/usage.
  const periodStart = summary?.billingCycleStart ?? auth.periodStart;
  const periodEnd = summary?.billingCycleEnd;
  const forecast = projectPlanUsageAtCycleEnd({
    planPercentUsed: summary?.planPercentUsed,
    periodStart,
    periodEnd,
    now,
  });

  const snapshot: UsageSnapshot = {
    days,
    dayRange,
    planLabel,
    membershipType,
    cycleSpentCents,
    payingOutsidePlan,
    overageCents,
    onDemandEnabled: summary?.onDemandEnabled,
    planPercentUsed: summary?.planPercentUsed,
    forecast,
    periodStart,
    periodEnd,
    lastError: errParts.length ? errParts.join('; ') : undefined,
    lastUpdated: now,
  };

  statusBar.update(snapshot);
  log(
    `OK plan=${planLabel ?? membershipType ?? '?'} range=${dayRange}D onDemand=${summary?.onDemandEnabled ? overageCents : 'off'} days=${days.length}`
  );
  void statusBar.maybeAlertOverage(snapshot);
}

async function refreshUsage(): Promise<void> {
  if (!statusBar || !extensionContext) {
    return;
  }
  if (refreshInFlight) {
    return;
  }
  refreshInFlight = true;
  statusBar.setLoading();
  const dayRange = getDayRange(extensionContext);
  try {
    await withTimeout(refreshUsageInner(), refreshBudgetMs(dayRange), 'refresh');
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    log(`refresh error: ${msg}`);
    statusBar.setError(msg);
  } finally {
    refreshInFlight = false;
  }
}

async function promptDayRange(): Promise<void> {
  if (!extensionContext) {
    return;
  }
  const current = getDayRange(extensionContext);
  const picked = await vscode.window.showQuickPick(
    DAY_RANGES.map((d) => ({
      label: `${d}D`,
      description: d === current ? 'current' : undefined,
      days: d,
    })),
    { title: 'Cursor Usage Bars — Day range', placeHolder: 'Show last N days in the popup' }
  );
  if (!picked) {
    return;
  }
  await setDayRange(extensionContext, picked.days);
}

function schedulePolling(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = undefined;
  }
  const c = readConfig();
  pollTimer = setInterval(() => {
    void refreshUsage();
  }, c.pollIntervalSeconds * 1000);
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  extensionContext = context;
  output = vscode.window.createOutputChannel('Cursor Usage Bars');
  context.subscriptions.push(output);
  log(`Activate ${hostLabel(context)} remote=${vscode.env.remoteName ?? 'none'}`);

  statusBar = new UsageBarsStatusBar();
  statusBar.show();

  context.subscriptions.push(
    new vscode.Disposable(() => {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = undefined;
      }
      statusBar?.dispose();
      statusBar = undefined;
    }),
    vscode.commands.registerCommand('cursorUsageBars.refresh', () => refreshUsage()),
    vscode.commands.registerCommand('cursorUsageBars.openDashboard', async () => {
      await vscode.env.openExternal(vscode.Uri.parse(readConfig().dashboardUrl || DASHBOARD_DEFAULT));
    }),
    vscode.commands.registerCommand('cursorUsageBars.authStatus', () => showAuthStatus()),
    vscode.commands.registerCommand('cursorUsageBars.setToken', () => promptSetToken()),
    vscode.commands.registerCommand('cursorUsageBars.clearToken', async () => {
      await clearStoredToken(context);
      await refreshUsage();
    }),
    vscode.commands.registerCommand('cursorUsageBars.setDayRange', (days?: unknown) => {
      if (days === undefined || days === null) {
        return promptDayRange();
      }
      return setDayRange(context, days);
    }),
    vscode.commands.registerCommand('cursorUsageBars.chooseDayRange', () => promptDayRange()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('cursorUsageBars')) {
        schedulePolling();
        void refreshUsage();
      }
    })
  );

  try {
    const watcher = vscode.workspace.createFileSystemWatcher('**/.cursor/usage-bars.accessToken');
    watcher.onDidCreate(() => void refreshUsage());
    watcher.onDidChange(() => void refreshUsage());
    context.subscriptions.push(watcher);
  } catch {
    // ignore
  }

  schedulePolling();
  // Do not block activation on refresh.
  void refreshUsage();
}

export function deactivate(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = undefined;
  }
  statusBar?.dispose();
  statusBar = undefined;
  extensionContext = undefined;
}
