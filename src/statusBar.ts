import * as vscode from 'vscode';
import {
  DashboardColors,
  classifyDayBilling,
  formatCentsUsd,
  sparkline,
  sparklineSegments,
  type DayBillingKind,
  type UsageSnapshot,
} from './usageModel';

const OPEN_CMD = 'cursorUsageBars.openDashboard';

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
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
    const kinds = classifyDayBilling(
      snapshot.days,
      snapshot.cycleSpentCents,
      snapshot.limitCents
    );
    const bars = sparkline(cents);
    const plan = snapshot.planLabel ? `${snapshot.planLabel} ` : '';

    if (snapshot.payingOutsidePlan) {
      // Price only when charging outside the included plan (on-demand / overage).
      this.item.text = `$(alert) ${plan}${bars} ${formatCentsUsd(snapshot.overageCents)} over`;
      this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
      this.item.color = DashboardColors.onDemand;
    } else {
      // Within subscription: plan + sparkline — never show a dollar amount on the bar.
      this.item.text = `$(pulse) ${plan}${bars}`;
      this.item.backgroundColor = undefined;
      this.item.color = this.statusBarColor(kinds);
    }

    this.item.tooltip = this.buildTooltip(snapshot, kinds);
  }

  /**
   * Fires a warning once per overage amount (until it changes) so the user notices
   * on-demand / out-of-plan charges without spam.
   */
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
      `Cursor: stai pagando fuori dal piano incluso (${formatCentsUsd(snapshot.overageCents)} overage).`,
      'Apri Usage Dashboard'
    );
    if (choice === 'Apri Usage Dashboard') {
      await vscode.commands.executeCommand(OPEN_CMD);
    }
  }

  private statusBarColor(kinds: DayBillingKind[]): string {
    if (kinds.some((k) => k === 'onDemand' || k === 'mixed')) {
      return DashboardColors.onDemand;
    }
    // Match Spending / Usage included accent when fully in-plan.
    return DashboardColors.included;
  }

  private buildTooltip(snapshot: UsageSnapshot, kinds: DayBillingKind[]): vscode.MarkdownString {
    const md = new vscode.MarkdownString(undefined, true);
    md.isTrusted = true;
    md.supportHtml = true;

    if (snapshot.planLabel) {
      md.appendMarkdown(
        `**Piano:** <span style="color:${DashboardColors.usageAccent};">${escapeHtml(snapshot.planLabel)}</span>\n\n`
      );
    }
    md.appendMarkdown('**Cursor usage (ultimi 3 giorni)**\n\n');

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
      const color =
        kind === 'included'
          ? DashboardColors.included
          : kind === 'onDemand'
            ? DashboardColors.onDemand
            : DashboardColors.usageAccent;
      const mark = d.ok ? '' : ' <i>(errore)</i>';
      const price = escapeHtml(formatCentsUsd(d.cents));
      // In-plan days: price in dashboard green (never treated as a charge label).
      md.appendMarkdown(
        `- <code>${escapeHtml(d.date)}</code>: <span style="color:${color};"><b>${price}</b></span>${mark}\n`
      );
    });

    if (snapshot.cycleSpentCents !== undefined) {
      const cycleColor = snapshot.payingOutsidePlan
        ? DashboardColors.onDemand
        : DashboardColors.included;
      md.appendMarkdown(
        `\nCiclo corrente: <span style="color:${cycleColor};"><b>${escapeHtml(formatCentsUsd(snapshot.cycleSpentCents))}</b></span>`
      );
      if (snapshot.limitCents !== undefined) {
        md.appendMarkdown(` / <b>${escapeHtml(formatCentsUsd(snapshot.limitCents))}</b>`);
      }
      md.appendMarkdown('\n');
    }

    if (snapshot.payingOutsidePlan) {
      md.appendMarkdown(
        `\n⚠️ **Overage:** <span style="color:${DashboardColors.onDemand};">${escapeHtml(formatCentsUsd(snapshot.overageCents))}</span> oltre il piano incluso.\n`
      );
    } else {
      md.appendMarkdown('\n_Entro il piano incluso — nessun addebito extra._\n');
    }

    if (snapshot.lastError) {
      md.appendMarkdown(`\n_Errore parziale:_ ${escapeHtml(snapshot.lastError)}\n`);
    }

    md.appendMarkdown(`\nAggiornato: ${escapeHtml(snapshot.lastUpdated.toLocaleString())}\n`);
    md.appendMarkdown('\n[Apri dashboard usage](command:cursorUsageBars.openDashboard)');
    return md;
  }
}
