import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as vscode from 'vscode';

const SECRET_KEY = 'cursorUsageBars.accessToken';
const REL_TOKEN = ['.cursor', 'usage-bars.accessToken'];

export function tokenFilePath(): string {
  return path.join(os.homedir(), '.config', 'cursor-usage-bars', 'accessToken');
}

function workspaceTokenUri(): vscode.Uri | undefined {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    return undefined;
  }
  return vscode.Uri.joinPath(folder.uri, ...REL_TOKEN);
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
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

export async function readWorkspaceTokenFile(): Promise<string | null> {
  const uri = workspaceTokenUri();
  if (!uri) {
    return null;
  }
  try {
    const buf = await withTimeout(vscode.workspace.fs.readFile(uri), 3_000);
    const v = Buffer.from(buf).toString('utf8').trim();
    return v || null;
  } catch {
    return null;
  }
}

/** Non-blocking best-effort sync into remote workspace (must never hang refresh). */
export function syncTokenToWorkspaceFileFireAndForget(token: string): void {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder || !token.trim()) {
    return;
  }
  void (async () => {
    try {
      const dir = vscode.Uri.joinPath(folder.uri, '.cursor');
      await withTimeout(vscode.workspace.fs.createDirectory(dir), 3_000);
      const uri = vscode.Uri.joinPath(dir, 'usage-bars.accessToken');
      await withTimeout(
        vscode.workspace.fs.writeFile(uri, Buffer.from(token.trim(), 'utf8')),
        3_000
      );
    } catch {
      // ignore — status bar must not wait on remote FS
    }
  })();
}

export async function readStoredToken(context: vscode.ExtensionContext): Promise<string | null> {
  try {
    const fromSecret = await withTimeout(context.secrets.get(SECRET_KEY), 2_000);
    if (fromSecret?.trim()) {
      return fromSecret.trim();
    }
  } catch {
    // ignore
  }

  const fromWs = await readWorkspaceTokenFile();
  if (fromWs) {
    void context.secrets.store(SECRET_KEY, fromWs);
    return fromWs;
  }

  try {
    const p = tokenFilePath();
    if (fs.existsSync(p)) {
      const v = fs.readFileSync(p, 'utf8').trim();
      if (v) {
        void context.secrets.store(SECRET_KEY, v);
        return v;
      }
    }
  } catch {
    // ignore
  }
  return null;
}

export async function writeStoredToken(context: vscode.ExtensionContext, token: string): Promise<void> {
  const t = token.trim();
  if (!t) {
    return;
  }
  try {
    await withTimeout(context.secrets.store(SECRET_KEY, t), 2_000);
  } catch {
    // ignore
  }
  try {
    const p = tokenFilePath();
    fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
    fs.writeFileSync(p, t, { encoding: 'utf8', mode: 0o600 });
  } catch {
    // ignore
  }
  syncTokenToWorkspaceFileFireAndForget(t);
}

export async function clearStoredToken(context: vscode.ExtensionContext): Promise<void> {
  try {
    await context.secrets.delete(SECRET_KEY);
  } catch {
    // ignore
  }
  try {
    const p = tokenFilePath();
    if (fs.existsSync(p)) {
      fs.unlinkSync(p);
    }
  } catch {
    // ignore
  }
  const uri = workspaceTokenUri();
  if (uri) {
    try {
      await withTimeout(vscode.workspace.fs.delete(uri), 2_000);
    } catch {
      // ignore
    }
  }
}

/**
 * Prefer cached secret/file first (instant), then Cursor DB.
 * Never block the UI on remote workspace I/O.
 */
export async function resolveToken(
  context: vscode.ExtensionContext,
  readFromCursorDb: () => Promise<string | null>
): Promise<{ token: string | null; source: 'cursor-db' | 'secret' | 'workspace-file' | 'file' | 'none' }> {
  // Fast path first — avoids hanging on huge state.vscdb every poll
  const cached = await readStoredToken(context);
  if (cached) {
    // Refresh from DB in background; update cache if changed
    void (async () => {
      try {
        const fromDb = await readFromCursorDb();
        if (fromDb && fromDb !== cached) {
          await writeStoredToken(context, fromDb);
        } else if (fromDb) {
          syncTokenToWorkspaceFileFireAndForget(fromDb);
        }
      } catch {
        // ignore background refresh errors
      }
    })();
    // Distinguish workspace-file vs secret roughly
    const ws = await readWorkspaceTokenFile();
    if (ws && ws === cached) {
      return { token: cached, source: 'workspace-file' };
    }
    return { token: cached, source: 'secret' };
  }

  try {
    const fromDb = await readFromCursorDb();
    if (fromDb) {
      await writeStoredToken(context, fromDb);
      return { token: fromDb, source: 'cursor-db' };
    }
  } catch {
    // fall through
  }

  return { token: null, source: 'none' };
}
