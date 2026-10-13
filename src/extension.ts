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

let pollTimer: NodeJS.Timeout | undefined;
let statusBar: UsageBarsStatusBar | undefined;
let output: vscode.OutputChannel | undefined;
let extensionContext: vscode.ExtensionContext | undefined;

function log(msg: string): void {
  output?.appendLine(`[${new Date().toISOString()}] ${msg}`);
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
  const probe = await probeCursorAuth();
  const resolved = await resolveToken(extensionContext, readCursorAccessToken);
  const msg = [
    `Host: ${hostLabel(extensionContext)}`,
    `Remote: ${vscode.env.remoteName ?? '(none)'}`,
    `Token: ${resolved.token ? `ok (${resolved.source})` : 'assente'}`,
    `DB: ${probe.dbPath ?? 'n/a'}`,
  ].join(' — ');
  log(msg);
  output?.show(true);
  await vscode.window.showInformationMessage(msg);
}

async function promptSetToken(): Promise<void> {
  if (!extensionContext) {
    return;
  }
  const token = await vscode.window.showInputBox({
    title: 'Cursor Usage Bars — Access Token (fallback)',
    prompt: 'Meglio installare l’estensione in Locale e fare login Cursor (sync automatico).',
    password: true,
    ignoreFocusOut: true,
  });
  if (!token?.trim()) {
    return;
  }
  await writeStoredToken(extensionContext, token);
  await refreshUsage();
}

async function refreshUsage(): Promise<void> {
  if (!statusBar || !extensionContext) {
    return;
  }
  const c = readConfig();
  statusBar.setLoading();

  const baseCheck = parseAllowedApiBase(c.apiBaseUrl);
  if (!baseCheck.ok) {
    statusBar.setError(baseCheck.reason);
    return;
  }

  let teamId: number | null = null;
  try {
    teamId = await readCursorTeamId();
  } catch {
    teamId = null;
  }

  const resolved = await resolveToken(extensionContext, readCursorAccessToken);
  log(`${hostLabel(extensionContext)} token source=${resolved.source}`);

  if (!resolved.token) {
    const isUi = extensionContext.extension.extensionKind === vscode.ExtensionKind.UI;
    statusBar.setError(
      isUi
        ? 'Login Cursor non trovato sul PC — accedi a Cursor'
        : 'In attesa sync da Locale (apri il workspace con estensione Local installata)'
    );
    return;
  }

  const now = new Date();
  try {
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
    await statusBar.maybeAlertOverage(snapshot);
  } catch (e) {
    statusBar.setError(e instanceof Error ? e.message : 'Errore sconosciuto.');
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

  // Watch token file written by the UI side into the remote workspace
  try {
    const watcher = vscode.workspace.createFileSystemWatcher('**/.cursor/usage-bars.accessToken');
    watcher.onDidCreate(() => void refreshUsage());
    watcher.onDidChange(() => void refreshUsage());
    context.subscriptions.push(watcher);
  } catch {
    // ignore
  }

  schedulePolling();
  await refreshUsage();
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
