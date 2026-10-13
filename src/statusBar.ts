import * as vscode from 'vscode';
import { formatCentsUsd, sparkline, type UsageSnapshot } from './usageModel';

const OPEN_CMD = 'cursorUsageBars.openDashboard';

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
  }

  setError(message: string): void {
    this.item.text = '$(warning) Cursor ?';
    this.item.tooltip = message;
    this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  }

  update(snapshot: UsageSnapshot): void {
    const cents = snapshot.days.map((d) => d.cents);
    const bars = sparkline(cents);
    const today = snapshot.days[snapshot.days.length - 1];
    const todayLabel = today ? formatCentsUsd(today.cents) : '—';

    if (snapshot.payingOutsidePlan) {
      this.item.text = `$(alert) ${bars} ${formatCentsUsd(snapshot.overageCents)} over`;
      this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    } else {
      this.item.text = `$(pulse) ${bars} ${todayLabel}`;
      this.item.backgroundColor = undefined;
    }

    this.item.tooltip = this.buildTooltip(snapshot);
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

  private buildTooltip(snapshot: UsageSnapshot): vscode.MarkdownString {
    const md = new vscode.MarkdownString(undefined, true);
    md.isTrusted = true;
    md.supportHtml = false;

    md.appendMarkdown('**Cursor usage (ultimi 3 giorni)**\n\n');
    for (const d of snapshot.days) {
      const mark = d.ok ? '' : ' _(errore)_';
      md.appendMarkdown(`- \`${d.date}\`: **${formatCentsUsd(d.cents)}**${mark}\n`);
    }

    if (snapshot.cycleSpentCents !== undefined) {
      md.appendMarkdown(`\nCiclo corrente: **${formatCentsUsd(snapshot.cycleSpentCents)}**`);
      if (snapshot.limitCents !== undefined) {
        md.appendMarkdown(` / **${formatCentsUsd(snapshot.limitCents)}**`);
      }
      md.appendMarkdown('\n');
    }

    if (snapshot.payingOutsidePlan) {
      md.appendMarkdown(
        `\n⚠️ **Overage:** ${formatCentsUsd(snapshot.overageCents)} oltre il piano incluso.\n`
      );
    }

    if (snapshot.lastError) {
      md.appendMarkdown(`\n_Errore parziale:_ ${snapshot.lastError}\n`);
    }

    md.appendMarkdown(`\nAggiornato: ${snapshot.lastUpdated.toLocaleString()}\n`);
    md.appendMarkdown('\n[Apri dashboard usage](command:cursorUsageBars.openDashboard)');
    return md;
  }
}
