import * as vscode from 'vscode';
import { probeCursorAuth, readCursorAccessToken, readCursorTeamId } from './cursorAuth';
import { fetchUsageBundle } from './usageClient';
import {
  parseAggregatedSpendCents,
  parseAuthUsage,
  parseHardLimit,
  parseUsageSummary,
  resolveLimitCents,
  type DaySpend,
  type UsageSnapshot,
} from './usageModel';
import { parseAllowedApiBase } from './urlAllowlist';
import { UsageBarsStatusBar } from './statusBar';
import { clearStoredToken, resolveToken, writeStoredToken } from './tokenStore';

const DASHBOARD_DEFAULT = 'https://cursor.com/dashboard/usage';
const REFRESH_BUDGET_MS = 25_000;

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
  };
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
  const bundle = await fetchUsageBundle(c.apiBaseUrl, resolved.token, teamId, now);

  const days: DaySpend[] = bundle.days.map(({ window, result }) => {
    if (!result.ok) {
      return { date: window.date, cents: 0, ok: false };
    }
    return {
      date: window.date,
      cents: parseAggregatedSpendCents(result.json) ?? 0,
      ok: true,
    };
  });

  const auth = bundle.auth.ok ? parseAuthUsage(bundle.auth.json) : {};
  const summary = bundle.summary.ok ? parseUsageSummary(bundle.summary.json) : undefined;
  const hardLimit = bundle.hardLimit.ok ? parseHardLimit(bundle.hardLimit.json) : {};
  const limitCents = resolveLimitCents({
    summary,
    hardLimit,
    manualLimitDollars: c.manualMonthlyLimitDollars,
  });

  const cycleSpentCents = bundle.cycleSpend.ok
    ? parseAggregatedSpendCents(bundle.cycleSpend.json)
    : undefined;

  const overageCents =
    limitCents !== undefined && cycleSpentCents !== undefined
      ? Math.max(0, cycleSpentCents - limitCents)
      : 0;

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

  const snapshot: UsageSnapshot = {
    days,
    cycleSpentCents,
    limitCents,
    payingOutsidePlan: overageCents > 0,
    overageCents,
    periodStart: auth.periodStart,
    lastError: errParts.length ? errParts.join('; ') : undefined,
    lastUpdated: now,
  };

  statusBar.update(snapshot);
  log(`OK days=${days.map((d) => `${d.date}:${d.cents}`).join(',')}`);
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
  try {
    await withTimeout(refreshUsageInner(), REFRESH_BUDGET_MS, 'refresh');
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    log(`refresh error: ${msg}`);
    statusBar.setError(msg);
  } finally {
    refreshInFlight = false;
  }
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
