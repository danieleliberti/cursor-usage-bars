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

function withTimeout<T>(p: PromiseLike<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    Promise.resolve(p).then(
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
    const buf = await withTimeout(vscode.workspace.fs.readFile(uri), 2_000);
    const v = Buffer.from(buf).toString('utf8').trim();
    return v || null;
  } catch {
    return null;
  }
}

/** Never await this from the refresh path — remote FS can hang. */
export function syncTokenToWorkspaceFileFireAndForget(token: string): void {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder || !token.trim()) {
    return;
  }
  void (async () => {
    try {
      const dir = vscode.Uri.joinPath(folder.uri, '.cursor');
      await withTimeout(vscode.workspace.fs.createDirectory(dir), 2_000);
      const uri = vscode.Uri.joinPath(dir, 'usage-bars.accessToken');
      await withTimeout(vscode.workspace.fs.writeFile(uri, Buffer.from(token.trim(), 'utf8')), 2_000);
    } catch {
      // ignore
    }
  })();
}

export async function readStoredToken(context: vscode.ExtensionContext): Promise<string | null> {
  try {
    const fromSecret = await withTimeout(context.secrets.get(SECRET_KEY), 1_500);
    if (fromSecret?.trim()) {
      return fromSecret.trim();
    }
  } catch {
    // ignore
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

  const fromWs = await readWorkspaceTokenFile();
  if (fromWs) {
    void context.secrets.store(SECRET_KEY, fromWs);
    return fromWs;
  }

  return null;
}

export async function writeStoredToken(context: vscode.ExtensionContext, token: string): Promise<void> {
  const t = token.trim();
  if (!t) {
    return;
  }
  try {
    await withTimeout(context.secrets.store(SECRET_KEY, t), 1_500);
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
 * Prefer cached secret/file (instant). Only hit Cursor DB when nothing is cached.
 * Background-refresh the DB so the status bar never waits on a huge state.vscdb.
 */
export async function resolveToken(
  context: vscode.ExtensionContext,
  readFromCursorDb: () => Promise<string | null>
): Promise<{ token: string | null; source: 'cursor-db' | 'secret' | 'workspace-file' | 'file' | 'none' }> {
  const cached = await readStoredToken(context);
  if (cached) {
    void (async () => {
      try {
        const fromDb = await withTimeout(readFromCursorDb(), 8_000);
        if (fromDb) {
          await writeStoredToken(context, fromDb);
        }
      } catch {
        // ignore background refresh
      }
    })();
    return { token: cached, source: 'secret' };
  }

  try {
    const fromDb = await withTimeout(readFromCursorDb(), 8_000);
    if (fromDb) {
      await writeStoredToken(context, fromDb);
      return { token: fromDb, source: 'cursor-db' };
    }
  } catch {
    // fall through
  }

  return { token: null, source: 'none' };
}
