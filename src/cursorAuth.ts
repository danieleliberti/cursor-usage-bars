import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const ACCESS_KEY = 'cursorAuth/accessToken';
const TEAM_KEY = 'cursorAuth/cachedTeam';
const DB_READ_TIMEOUT_MS = 6_000;
const SQLJS_MAX_BYTES = 64 * 1024 * 1024;

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

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
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

async function readViaSqliteCli(dbPath: string, key: string): Promise<string | null> {
  const sql = `SELECT value FROM ItemTable WHERE key='${key.replace(/'/g, "''")}' LIMIT 1;`;
  const { stdout } = await execFileAsync('sqlite3', [dbPath, sql], {
    timeout: DB_READ_TIMEOUT_MS,
    maxBuffer: 2 * 1024 * 1024,
    windowsHide: true,
  });
  const v = stdout.replace(/\r?\n$/, '');
  return v.length > 0 ? v : null;
}

type SqlDb = {
  prepare(sql: string): {
    bind(v: unknown[]): boolean;
    step(): boolean;
    getAsObject(): Record<string, unknown>;
    free(): void;
  };
  close(): void;
};

async function readViaSqlJs(dbPath: string, key: string): Promise<string | null> {
  const size = fs.statSync(dbPath).size;
  if (size > SQLJS_MAX_BYTES) {
    throw new Error(
      `state.vscdb is ${(size / 1024 / 1024).toFixed(0)}MB; install sqlite3 CLI for fast reads`
    );
  }
  const wasmPath = path.join(__dirname, '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');
  if (!fs.existsSync(wasmPath)) {
    throw new Error('sql.js WASM missing from extension package');
  }
  const wasmBinary = fs.readFileSync(wasmPath);
  // CommonJS require is more reliable in the extension host than dynamic import.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const sqlJsMod = require('sql.js') as
    | ((opts?: { wasmBinary?: Buffer }) => Promise<{ Database: new (data?: Uint8Array) => SqlDb }>)
    | {
        default?: (opts?: { wasmBinary?: Buffer }) => Promise<{ Database: new (data?: Uint8Array) => SqlDb }>;
      };
  const initSqlJs = typeof sqlJsMod === 'function' ? sqlJsMod : sqlJsMod.default;
  if (typeof initSqlJs !== 'function') {
    throw new Error('sql.js init not found');
  }
  const SQL = await initSqlJs({ wasmBinary });
  const fileBuffer = fs.readFileSync(dbPath);
  const db = new SQL.Database(new Uint8Array(fileBuffer));
  try {
    const stmt = db.prepare('SELECT value FROM ItemTable WHERE key = ? LIMIT 1');
    stmt.bind([key]);
    if (!stmt.step()) {
      stmt.free();
      return null;
    }
    const row = stmt.getAsObject() as { value?: string | Uint8Array };
    stmt.free();
    const raw = row.value;
    if (typeof raw === 'string' && raw.length > 0) {
      return raw;
    }
    if (raw instanceof Uint8Array) {
      return Buffer.from(raw).toString('utf8') || null;
    }
    return null;
  } finally {
    db.close();
  }
}

async function readStateValue(key: string): Promise<{ value: string | null; dbPath: string | null }> {
  const dbPath = resolveCursorStateDbPath();
  if (!dbPath) {
    return { value: null, dbPath: null };
  }

  try {
    const value = await withTimeout(readViaSqliteCli(dbPath, key), DB_READ_TIMEOUT_MS + 500, 'sqlite3');
    return { value, dbPath };
  } catch {
    // fall through to sql.js
  }

  const value = await withTimeout(readViaSqlJs(dbPath, key), DB_READ_TIMEOUT_MS + 500, 'sql.js');
  return { value, dbPath };
}

export type AuthProbe = {
  dbPath: string | null;
  hasToken: boolean;
  checkedPaths: string[];
  error?: string;
};

export async function probeCursorAuth(): Promise<AuthProbe> {
  const checkedPaths = listCursorStateDbCandidates();
  try {
    const { value, dbPath } = await readStateValue(ACCESS_KEY);
    return { dbPath, hasToken: Boolean(value && value.length > 0), checkedPaths };
  } catch (e) {
    return {
      dbPath: resolveCursorStateDbPath(),
      hasToken: false,
      checkedPaths,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

let cachedAccessToken: { value: string; at: number } | undefined;
const TOKEN_CACHE_MS = 120_000;

export async function readCursorAccessToken(): Promise<string | null> {
  if (cachedAccessToken && Date.now() - cachedAccessToken.at < TOKEN_CACHE_MS) {
    return cachedAccessToken.value;
  }
  const { value } = await readStateValue(ACCESS_KEY);
  if (value) {
    cachedAccessToken = { value, at: Date.now() };
  }
  return value;
}

export async function readCursorTeamId(): Promise<number | null> {
  try {
    const { value: raw } = await readStateValue(TEAM_KEY);
    if (!raw) {
      return null;
    }
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
