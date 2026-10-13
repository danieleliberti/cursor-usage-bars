# Cursor Usage Bars

Unofficial VS Code / Cursor extension. Shows a **3-day spend sparkline** (D−2 · yesterday · today) in the status bar, alerts on plan overage, and opens the [usage dashboard](https://cursor.com/dashboard/usage) on click.

## Local + Remote SSH

| Side | Role |
|---|---|
| **Local (UI)** | Reads the Cursor login session and syncs the token into the workspace |
| **SSH (workspace)** | Shows the extension on the remote host and uses the synced token |

See `INSTALL.md` for setup.

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
npx vsce package --allow-missing-repository
```

## License

MIT. Not affiliated with Cursor. Uses undocumented usage endpoints that may change.
