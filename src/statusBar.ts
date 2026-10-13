import * as vscode from 'vscode';
import {
  DAY_RANGES,
  DashboardColors,
  classifyDayBilling,
  formatCentsUsd,
  sparkline,
  sparklineSegments,
  type DayBillingKind,
  type DayRange,
  type UsageSnapshot,
} from './usageModel';

const OPEN_CMD = 'cursorUsageBars.openDashboard';
const SET_RANGE_CMD = 'cursorUsageBars.setDayRange';

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function rangeCommandUri(days: DayRange): string {
  return `command:${SET_RANGE_CMD}?${encodeURIComponent(JSON.stringify([days]))}`;
}

export class UsageBarsStatusBar {
  private readonly item: vscode.StatusBarItem;
  private lastAlertKey: string | undefined;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.command = OPEN_CMD;
  }

  show(): void {
    this.item.show();
  }

  dispose(): void {
    this.item.dispose();
  }

  setLoading(): void {
    this.item.text = '$(sync~spin) Cursor …';
    this.item.tooltip = 'Loading Cursor usage…';
    this.item.backgroundColor = undefined;
    this.item.color = undefined;
  }

  setError(message: string): void {
    this.item.text = '$(warning) Cursor ?';
    this.item.tooltip = message;
    this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    this.item.color = undefined;
  }

  update(snapshot: UsageSnapshot): void {
    const cents = snapshot.days.map((d) => d.cents);
    const kinds = classifyDayBilling(snapshot.days, snapshot.payingOutsidePlan);
    // Keep the status bar compact: sparkline of the last up to 7 days.
    const statusCents = cents.slice(-Math.min(7, cents.length));
    const bars = sparkline(statusCents);
    const plan = snapshot.planLabel ? `${snapshot.planLabel} ` : '';
    const range = `${snapshot.dayRange}D `;

    if (snapshot.payingOutsidePlan) {
      this.item.text = `$(alert) ${plan}${range}${bars} ${formatCentsUsd(snapshot.overageCents)} over`;
      this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
      this.item.color = DashboardColors.onDemand;
    } else {
      this.item.text = `$(pulse) ${plan}${range}${bars}`;
      this.item.backgroundColor = undefined;
      this.item.color = DashboardColors.included;
    }

    this.item.tooltip = this.buildTooltip(snapshot, kinds);
  }

  async maybeAlertOverage(snapshot: UsageSnapshot): Promise<void> {
    if (!snapshot.payingOutsidePlan) {
      this.lastAlertKey = undefined;
      return;
    }
    const key = `${snapshot.periodStart ?? ''}:${Math.round(snapshot.overageCents)}`;
    if (key === this.lastAlertKey) {
      return;
    }
    this.lastAlertKey = key;
    const choice = await vscode.window.showWarningMessage(
      `Cursor: on-demand charges this cycle (${formatCentsUsd(snapshot.overageCents)}).`,
      'Open Usage Dashboard'
    );
    if (choice === 'Open Usage Dashboard') {
      await vscode.commands.executeCommand(OPEN_CMD);
    }
  }

  private buildTooltip(snapshot: UsageSnapshot, kinds: DayBillingKind[]): vscode.MarkdownString {
    const md = new vscode.MarkdownString(undefined, true);
    md.isTrusted = true;
    md.supportHtml = true;

    if (snapshot.planLabel) {
      md.appendMarkdown(
        `**Plan:** <span style="color:${DashboardColors.included};">${escapeHtml(snapshot.planLabel)}</span>\n\n`
      );
    }

    const rangeLinks = DAY_RANGES.map((d) => {
      const label = `${d}D`;
      if (d === snapshot.dayRange) {
        return `**${label}**`;
      }
      return `[${label}](${rangeCommandUri(d)})`;
    }).join(' · ');
    md.appendMarkdown(`**Range:** ${rangeLinks}\n\n`);
    md.appendMarkdown(`**Cursor usage (last ${snapshot.dayRange} days)**\n\n`);

    const segments = sparklineSegments(
      snapshot.days.map((d) => d.cents),
      kinds
    );
    if (segments.length) {
      const coloredBars = segments
        .map((s) => `<span style="color:${s.color};">${escapeHtml(s.bar)}</span>`)
        .join('');
      md.appendMarkdown(`${coloredBars}\n\n`);
    }

    snapshot.days.forEach((d, i) => {
      const kind = kinds[i] ?? 'included';
      const color = kind === 'included' ? DashboardColors.included : DashboardColors.usageAccent;
      const mark = d.ok ? '' : ' <i>(error)</i>';
      const price = escapeHtml(formatCentsUsd(d.cents));
      md.appendMarkdown(
        `- <code>${escapeHtml(d.date)}</code>: <span style="color:${color};"><b>${price}</b></span>${mark}\n`
      );
    });

    if (snapshot.planPercentUsed !== undefined) {
      md.appendMarkdown(
        `\nIncluded usage: <span style="color:${DashboardColors.included};"><b>${escapeHtml(String(Math.round(snapshot.planPercentUsed)))}%</b></span>\n`
      );
    }

    if (snapshot.payingOutsidePlan) {
      md.appendMarkdown(
        `\n⚠️ **On-demand:** <span style="color:${DashboardColors.onDemand};">${escapeHtml(formatCentsUsd(snapshot.overageCents))}</span> billed beyond included plan.\n`
      );
    } else {
      md.appendMarkdown('\n_Within included plan — no on-demand charges._\n');
    }

    if (snapshot.lastError) {
      md.appendMarkdown(`\n_Partial error:_ ${escapeHtml(snapshot.lastError)}\n`);
    }

    md.appendMarkdown(`\nUpdated: ${escapeHtml(snapshot.lastUpdated.toLocaleString())}\n`);
    md.appendMarkdown('\n[Open usage dashboard](command:cursorUsageBars.openDashboard)');
    return md;
  }
}
