# Cursor Usage Bars

Unofficial VS Code / Cursor extension by **Daniele Liberti**.

Shows your **plan name** (Pro, Pro+, Ultra, …) and a **usage sparkline** in the status bar. Hover for a 7D / 15D / 30D breakdown with dashboard-colored columns. Opens the [usage dashboard](https://cursor.com/dashboard/usage) on click.

Within the included plan, the status bar never shows a dollar amount. On-demand charges are reported only when Cursor’s usage-summary says so.

## Features

- Plan label on the status bar
- Colored daily columns (Cursor Usage palette)
- Range picker in the tooltip: **7D · 15D · 30D**
- Local + Remote SSH (UI host syncs the login token)

## Install

### Marketplace

Search **Cursor Usage Bars** in the Extensions view (after publish).

### From VSIX

1. Download the latest `.vsix` from [Releases](https://github.com/danieleliberti/cursor-usage-bars/releases)
2. Command Palette → **Extensions: Install from VSIX…**
3. **Developer: Reload Window**

See `INSTALL.md` for Local + Remote SSH setup.

## Auth

1. Sign in to Cursor on your desktop  
2. The UI host reads `state.vscdb`  
3. It writes `.cursor/usage-bars.accessToken` (gitignored)  
4. The SSH host reads that file and updates the status bar  

## Build

```bash
npm install
npm run compile
npx @vscode/vsce package
```

## License

MIT © Daniele Liberti. Not affiliated with Cursor. Uses undocumented usage endpoints that may change.
