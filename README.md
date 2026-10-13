# Cursor Usage Bars

Unofficial VS Code / Cursor extension by **Daniele Liberti**. Shows a **3-day spend sparkline** (D−2 · yesterday · today) and your **plan name** (Pro, Pro+, Ultra, …) in the status bar, alerts on plan overage, and opens the [usage dashboard](https://cursor.com/dashboard/usage) on click.

Within the included plan, the status bar never shows a dollar amount. The hover tooltip shows daily amounts (green when included) using dashboard colors.

## Install (local VSIX)

1. Download `cursor-usage-bars-0.4.0.vsix` from [Releases](https://github.com/danieleliberti/cursor-usage-bars/releases)
2. `Ctrl+Shift+P` / `Cmd+Shift+P` → **Extensions: Install from VSIX…**
3. **Developer: Reload Window**

See `INSTALL.md` for Local + Remote SSH setup.

## Local + Remote SSH

| Side | Role |
|---|---|
| **Local (UI)** | Reads the Cursor login session and syncs the token into the workspace |
| **SSH (workspace)** | Shows the extension on the remote host and uses the synced token |

## Auth

1. Sign in to Cursor on your desktop  
2. The UI host reads `state.vscdb`  
3. It writes `.cursor/usage-bars.accessToken` (gitignored)  
4. The SSH host reads that file and updates the status bar  

No cookie paste required for the normal path.

## Build

```bash
npm install
npm run compile
npx @vscode/vsce package
```

## Publish (make it visible to everyone)

To appear in the Extensions marketplace for **VS Code** and **Cursor**:

1. Create a publisher at [Visual Studio Marketplace](https://marketplace.visualstudio.com/manage) (publisher id must match `package.json` → `publisher`: `danieleliberti`)
2. Create a Personal Access Token (Azure DevOps) with Marketplace publish scope
3. `npx @vscode/vsce login danieleliberti` then `npx @vscode/vsce publish`
4. Optionally also publish to [Open VSX](https://open-vsx.org/) (`npx ovsx publish`) — Cursor often indexes Open VSX

Until published, users install from the GitHub Release VSIX only.

## License

MIT © Daniele Liberti. Not affiliated with Cursor. Uses undocumented usage endpoints that may change.
