import * as vscode from 'vscode';
import {
  DAY_RANGES,
  DashboardColors,
  chartLegendHtml,
  dayBarValue,
  dayColumnHtml,
  formatCentsUsd,
  renderColoredColumnsHtml,
  sparkline,
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
    const values = snapshot.days.map(dayBarValue);
    const statusValues = values.slice(-Math.min(7, values.length));
    const bars = sparkline(statusValues);
    const plan = snapshot.planLabel ? `${snapshot.planLabel} ` : '';
    const range = `${snapshot.dayRange}D `;

    if (snapshot.payingOutsidePlan) {
      this.item.text = `$(alert) ${plan}${range}${bars} ${formatCentsUsd(snapshot.overageCents)} over`;
      this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
      this.item.color = DashboardColors.onDemand;
    } else {
      this.item.text = `$(pulse) ${plan}${range}${bars}`;
      this.item.backgroundColor = undefined;
      // Match dashboard “default” / included green.
      this.item.color = DashboardColors.included;
    }

    this.item.tooltip = this.buildTooltip(snapshot);
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

  private buildTooltip(snapshot: UsageSnapshot): vscode.MarkdownString {
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
    md.appendMarkdown(`**Your Usage (last ${snapshot.dayRange} days)**\n\n`);

    // Colored columns only (no images) — dashboard model palette.
    const columns = renderColoredColumnsHtml(snapshot.days);
    if (columns) {
      md.appendMarkdown(`${columns}\n\n`);
    }
    const legend = chartLegendHtml(snapshot.days);
    if (legend) {
      md.appendMarkdown(`${legend}\n\n`);
    }

    const maxValue = Math.max(...snapshot.days.map(dayBarValue), 0);
    snapshot.days.forEach((d) => {
      const mark = d.ok ? '' : ' <i>(error)</i>';
      const costLabel = snapshot.payingOutsidePlan
        ? escapeHtml(formatCentsUsd(d.cents))
        : '<span style="color:#009957;"><b>Included</b></span>';
      const col = dayColumnHtml(d, maxValue);
      const models =
        d.slices.length > 0
          ? d.slices
              .map(
                (s) =>
                  `<span style="color:${s.color};">■</span>&nbsp;${escapeHtml(s.model)}`
              )
              .join(' · ')
          : '';
      md.appendMarkdown(
        `- ${col} <code>${escapeHtml(d.date)}</code>: ${costLabel}${mark}${models ? `<br/>&nbsp;&nbsp;&nbsp;&nbsp;${models}` : ''}\n`
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
