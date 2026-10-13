import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const ACCESS_KEY = 'cursorAuth/accessToken';
const TEAM_KEY = 'cursorAuth/cachedTeam';

/**
 * Candidate paths for Cursor's local session DB.
 * The extension is UI-kind: it runs on the machine where the user is logged into Cursor,
 * so this finds the same token Cursor uses after login — no manual paste.
 */
export function listCursorStateDbCandidates(): string[] {
  const home = os.homedir();
  const out: string[] = [];

  if (process.platform === 'win32') {
    for (const root of [process.env.APPDATA, process.env.LOCALAPPDATA]) {
      if (root) {
        out.push(path.join(root, 'Cursor', 'User', 'globalStorage', 'state.vscdb'));
      }
    }
  } else if (process.platform === 'darwin') {
    out.push(
      path.join(home, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb')
    );
  } else {
    out.push(path.join(home, '.config', 'Cursor', 'User', 'globalStorage', 'state.vscdb'));
    // Some Linux installs / containers
    out.push(path.join(home, '.cursor-server', 'data', 'User', 'globalStorage', 'state.vscdb'));
  }

  return [...new Set(out)];
}

export function resolveCursorStateDbPath(): string | null {
  for (const p of listCursorStateDbCandidates()) {
    if (fs.existsSync(p)) {
      return p;
    }
  }
  return null;
}

async function openSqlJs() {
  const wasmPath = path.join(__dirname, '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');
  if (!fs.existsSync(wasmPath)) {
    throw new Error('sql.js WASM file is missing from the extension install.');
  }
  const wasmBinary = fs.readFileSync(wasmPath);
  const sqlJsMod = await import('sql.js');
  type InitSqlJs = (opts?: { wasmBinary?: Buffer | Uint8Array }) => Promise<import('sql.js').SqlJsStatic>;
  const initSqlJs: InitSqlJs =
    typeof (sqlJsMod as { default?: InitSqlJs }).default === 'function'
      ? (sqlJsMod as { default: InitSqlJs }).default
      : (sqlJsMod as unknown as InitSqlJs);
  return initSqlJs({ wasmBinary });
}

async function readStateValue(key: string): Promise<{ value: string | null; dbPath: string | null }> {
  const dbPath = resolveCursorStateDbPath();
  if (!dbPath) {
    return { value: null, dbPath: null };
  }
  const fileBuffer = fs.readFileSync(dbPath);
  const SQL = await openSqlJs();
  const db = new SQL.Database(new Uint8Array(fileBuffer));
  try {
    const stmt = db.prepare('SELECT value FROM ItemTable WHERE key = ? LIMIT 1');
    stmt.bind([key]);
    if (!stmt.step()) {
      stmt.free();
      return { value: null, dbPath };
    }
    const row = stmt.getAsObject() as { value?: string | Uint8Array };
    stmt.free();
    const raw = row.value;
    if (typeof raw === 'string' && raw.length > 0) {
      return { value: raw, dbPath };
    }
    if (raw instanceof Uint8Array) {
      return { value: Buffer.from(raw).toString('utf8') || null, dbPath };
    }
    return { value: null, dbPath };
  } finally {
    db.close();
  }
}

export type AuthProbe = {
  dbPath: string | null;
  hasToken: boolean;
  checkedPaths: string[];
};

export async function probeCursorAuth(): Promise<AuthProbe> {
  const checkedPaths = listCursorStateDbCandidates();
  const { value, dbPath } = await readStateValue(ACCESS_KEY);
  return {
    dbPath,
    hasToken: Boolean(value && value.length > 0),
    checkedPaths,
  };
}

/** Reads the access token from the local Cursor session after the user signed in. */
export async function readCursorAccessToken(): Promise<string | null> {
  const { value } = await readStateValue(ACCESS_KEY);
  return value;
}

export async function readCursorTeamId(): Promise<number | null> {
  const { value: raw } = await readStateValue(TEAM_KEY);
  if (!raw) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const id = (parsed as { teamId?: unknown }).teamId;
      if (typeof id === 'number' && Number.isFinite(id)) {
        return id;
      }
      if (typeof id === 'string' && id.trim() !== '' && Number.isFinite(Number(id))) {
        return Number(id);
      }
    }
  } catch {
    return null;
  }
  return null;
}
