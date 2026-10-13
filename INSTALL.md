# Install — Local + Remote SSH

This extension is both `ui` and `workspace`. Install it on **both** sides.

## 1) Local (required for automatic auth)

1. Download `cursor-usage-bars-0.3.1.vsix` to your PC  
2. `Ctrl+Shift+P` → **Extensions: Install from VSIX…** → select the file → **Local**  
3. **Developer: Reload Window**

After you sign in to Cursor on that machine, the token is read automatically and the status bar also appears in SSH windows.

## 2) Remote SSH (so it shows under “SSH: host”)

On the remote host:

```bash
cursor --install-extension /path/to/cursor-usage-bars-0.3.1.vsix --force
```

Or use **Install from VSIX…** and choose **SSH**.

## How auth works over SSH

1. **Local (UI)** reads the Cursor session from `state.vscdb`  
2. It writes `.cursor/usage-bars.accessToken` into the remote workspace  
3. **SSH (workspace)** reads that file and renders the sparkline  

No manual cookie paste. Prefer keeping the token file out of git (see `.gitignore`).

## Verify

- Extensions → **Local**: Cursor Usage Bars  
- Extensions → **SSH: …**: Cursor Usage Bars  
- Status bar: `▃▅█ $x.xx`  
- Command: **Cursor Usage Bars: Auth Status**
